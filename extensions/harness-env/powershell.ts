import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { PowerShellOperations } from "@earendil-works/pi-coding-agent";

/** Avoid pi's where.exe subprocess: standalone runtimes can retain the startup PATH. */
export function resolvePowerShell(env: NodeJS.ProcessEnv): string {
	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const dirs = (env[pathKey] ?? "").split(delimiter).filter(Boolean).map((dir) => dir.replace(/^"(.*)"$/, "$1"));
	for (const name of ["pwsh.exe", "powershell.exe"]) {
		for (const dir of dirs) {
			const file = resolve(dir, name);
			if (existsSync(file)) return file;
		}
	}
	const fallback = join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	if (existsSync(fallback)) return fallback;
	throw new Error(`Windows PowerShell executable not found: ${fallback}`);
}

type ExecOptions = Parameters<PowerShellOperations["exec"]>[2];

const TERMINATION_GRACE_MS = 1500;

/** A successful taskkill confirms tree termination; failures must not be hidden. */
export function terminateWindowsTree(pid: number, env: NodeJS.ProcessEnv, timeoutMs = 1000): Promise<string | undefined> {
	return new Promise((resolveResult) => {
		const executable = join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "taskkill.exe");
		const killer = spawn(executable, ["/F", "/T", "/PID", String(pid)], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let settled = false;
		let detail = "";
		const collect = (data: Buffer) => { detail = (detail + data.toString()).slice(-8192); };
		const finish = (error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			killer.stdout.destroy();
			killer.stderr.destroy();
			resolveResult(error);
		};
		const timer = setTimeout(() => {
			killer.kill("SIGKILL");
			finish("taskkill exceeded its termination deadline; process tree termination could not be confirmed");
		}, timeoutMs);
		killer.stdout.on("data", collect);
		killer.stderr.on("data", collect);
		killer.once("error", (error) => finish(`taskkill failed: ${error.message}; process tree termination could not be confirmed`));
		// Do not wait for inherited output handles after the termination command exits.
		killer.once("exit", (code, signal) => finish(code === 0 ? undefined : `taskkill failed (exit ${code}, signal ${signal}): ${detail.trim()}; process tree termination could not be confirmed`));
	});
}

/** Stream output; timeout/cancellation allows at most 1.5 seconds for cleanup. */
export async function runShellProcess(shell: string, args: string[], cwd: string, options: ExecOptions): Promise<{ exitCode: number }> {
	if (options.signal?.aborted) throw new Error("aborted");
	if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647)) {
		throw new Error("Invalid timeout: must be a positive number of seconds within the timer limit");
	}
	const env = options.env ?? process.env;
	return new Promise((resolveResult, reject) => {
		const child = spawn(shell, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped: string | undefined;
		let settled = false;
		let closed = false;
		let terminationDone = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const diagnostic = (message: string) => {
			if (!settled) options.onData(Buffer.from(`\n[PowerShell cleanup] ${message}\n`));
		};
		const finish = (error?: Error, code = 1) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", abort);
			child.stdout.removeListener("data", options.onData);
			child.stderr.removeListener("data", options.onData);
			child.stdout.destroy();
			child.stderr.destroy();
			if (error) reject(error);
			else resolveResult({ exitCode: code });
		};
		const stop = (reason: string) => {
			if (stopped || settled) return;
			stopped = reason;
			if (timer) clearTimeout(timer);
			graceTimer = setTimeout(() => {
				diagnostic("Cleanup deadline reached; remaining processes or inherited output handles may still exist.");
				child.kill("SIGKILL");
				finish(new Error(reason));
			}, TERMINATION_GRACE_MS);
			void (async () => {
				if (child.pid) {
					if (process.platform === "win32") {
						const error = await terminateWindowsTree(child.pid, env);
						if (error) diagnostic(error);
					} else {
						try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ESRCH") diagnostic(`Process group termination failed: ${String(error)}`);
						}
					}
					// Fallback only after taskkill: killing the parent first loses its tree.
					if (!settled && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}
				terminationDone = true;
				if (closed) finish(new Error(reason));
			})().catch((error) => {
				diagnostic(`Process termination failed: ${String(error)}`);
				terminationDone = true;
				if (closed) finish(new Error(reason));
			});
		};
		const abort = () => stop("aborted");
		child.stdout.on("data", options.onData);
		child.stderr.on("data", options.onData);
		child.once("error", (error) => {
			if (!stopped) finish(error);
			else diagnostic(`Shell termination error: ${error.message}`);
		});
		child.once("close", (code) => {
			closed = true;
			if (!stopped) finish(undefined, code ?? 1);
			else if (terminationDone) finish(new Error(stopped));
		});
		if (options.timeout !== undefined) timer = setTimeout(() => stop(`timeout:${options.timeout}`), options.timeout * 1000);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}

export function createWindowsPowerShellOperations(): PowerShellOperations {
	return {
		exec(command, cwd, options) {
			// Python은 기본으로 CP949로 출력해 UTF-8로 읽는 PowerShell에서 한글이 깨진다. 이미 정한 값은 존중한다.
			const env = { ...(options.env ?? process.env) };
			env.PYTHONUTF8 ??= "1";
			env.PYTHONIOENCODING ??= "utf-8";
			// $OutputEncoding: 파이프로 외부 프로그램에 넘기는 문자열(기본 ASCII라 한글이 ?가 됨). BOM 없는 UTF-8.
			const script = `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=New-Object System.Text.UTF8Encoding $false } catch {}\n${command}`;
			return runShellProcess(resolvePowerShell(env), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], cwd, { ...options, env });
		},
	};
}
