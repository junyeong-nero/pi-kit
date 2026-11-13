import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { createPowerShellTool, getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import harnessEnv, { applyDefaults, windowsToolSet } from "../extensions/harness-env/index.ts";
import { createWindowsPowerShellOperations, resolvePowerShell, runShellProcess, terminateWindowsTree } from "../extensions/harness-env/powershell.ts";
import { EXCLUDE_GLOB, excludeNoisyDirs } from "../extensions/harness-env/search-excludes.ts";

test("adds the bundled AGENTS.md guide only when no context file has it", () => {
	const handlers = new Map<string, (event: any) => unknown>();
	harnessEnv({ registerTool() {}, registerCommand() {}, on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const guidePath = join(process.cwd(), "config", "AGENTS.md");
	const guide = readFileSync(guidePath, "utf-8");
	const run = (contextFiles: { path: string; content: string }[]) => {
		handlers.get("before_agent_start")!({ systemPromptOptions: { contextFiles } });
		return contextFiles.filter((file) => file.content === guide).length;
	};
	assert.equal(run([]), 1, "standalone: the guide is added");
	assert.equal(run([{ path: guidePath, content: guide }]), 1, "PI_CODING_AGENT_DIR=config: pi already loaded it");
	assert.equal(run([{ path: "/elsewhere/AGENTS.md", content: `# mine\n${guide}` }]), 0, "a user AGENTS.md that copies the guide is enough");
});

test("grep without a glob skips .vs, .svn and .git; explicit globs and paths are kept", () => {
	const plain: { pattern: string; glob?: unknown; path?: unknown } = { pattern: "Foo" };
	assert.equal(excludeNoisyDirs(plain), true);
	assert.equal(plain.glob, EXCLUDE_GLOB);
	const typed = { pattern: "Foo", glob: "*.cpp" };
	assert.equal(excludeNoisyDirs(typed), false);
	assert.equal(typed.glob, "*.cpp");
	for (const path of [".vs", "src\\.vs\\App", "proj/.svn/entries"]) {
		const inside: { pattern: string; glob?: unknown; path: string } = { pattern: "Foo", path };
		assert.equal(excludeNoisyDirs(inside), false, path);
		assert.equal(inside.glob, undefined);
	}
	const vscode: { pattern: string; glob?: unknown; path: string } = { pattern: "Foo", path: "src/.vscode" };
	assert.equal(excludeNoisyDirs(vscode), true, ".vscode is not .vs");
});

test("points rg at the bundled ripgrep.conf when it exists", () => {
	const bundle = mkdtempSync(join(tmpdir(), "harness-rg-"));
	try {
		const missing: NodeJS.ProcessEnv = {};
		applyDefaults(missing, bundle, "linux");
		assert.equal(missing.RIPGREP_CONFIG_PATH, undefined);
		mkdirSync(join(bundle, "config"));
		writeFileSync(join(bundle, "config", "ripgrep.conf"), "--glob=!.vs\n");
		const env: NodeJS.ProcessEnv = {};
		applyDefaults(env, bundle, "linux");
		assert.equal(env.RIPGREP_CONFIG_PATH, join(bundle, "config", "ripgrep.conf"));
		const custom: NodeJS.ProcessEnv = { RIPGREP_CONFIG_PATH: "mine.conf" };
		applyDefaults(custom, bundle, "linux");
		assert.equal(custom.RIPGREP_CONFIG_PATH, "mine.conf");
	} finally {
		rmSync(bundle, { recursive: true, force: true });
	}
});

test("fills bundle defaults only where unset", () => {
	const env: NodeJS.ProcessEnv = { DOTNET_NOLOGO: "0" };
	applyDefaults(env, "/b", "linux");
	assert.equal(env.HARNESS_BUNDLE_ROOT, "/b");
	assert.equal(env.DOTNET_NOLOGO, "0");
	assert.equal(env.DOTNET_CLI_TELEMETRY_OPTOUT, "1");
	assert.equal(env.PI_SUBAGENT_PI_BINARY, undefined, "pi.exe is only used on Windows when it exists");
});

test("prepends existing bundle tool folders to PATH once, keeping the variable's casing", () => {
	const bundle = mkdtempSync(join(tmpdir(), "harness-env-"));
	try {
		const redis = join(bundle, "bin", "redis");
		const python = join(bundle, "runtime", "python");
		mkdirSync(redis, { recursive: true });
		mkdirSync(python, { recursive: true });
		const env: NodeJS.ProcessEnv = { Path: ["C:\\Windows", join(bundle, "bin"), redis, redis].join(delimiter) };
		applyDefaults(env, bundle, "linux");
		applyDefaults(env, bundle, "linux");
		assert.equal(env.Path, [join(bundle, "bin"), redis, python, "C:\\Windows"].join(delimiter));
		assert.equal(env.PATH, undefined);
	} finally {
		rmSync(bundle, { recursive: true, force: true });
	}
});

test("replaces Bash with the bundle's PowerShell tools on Windows", () => {
	const registered = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "todo"];
	assert.deepEqual(windowsToolSet(["read", "bash", "edit", "write", "todo"], registered, "win32"),
		["read", "powershell", "edit", "write", "grep", "find", "ls", "todo"]);
	assert.deepEqual(windowsToolSet(["read", "bash", "edit", "write", "powershell"], registered, "win32"),
		["read", "powershell", "edit", "write", "grep", "find", "ls"], "an extension shell override must still disable default Bash");
	assert.equal(windowsToolSet(["read", "powershell", "edit"], registered, "win32"), undefined, "configured sets are kept");
	assert.equal(windowsToolSet(["read", "bash", "edit", "write"], registered, "darwin"), undefined);
});

test("restores Windows shell discovery paths without replacing existing tools or duplicating paths", () => {
	const root = mkdtempSync(join(tmpdir(), "harness-shell-"));
	try {
		const system32 = join(root, "System32");
		const powershell = join(system32, "WindowsPowerShell", "v1.0");
		mkdirSync(powershell, { recursive: true });
		writeFileSync(join(system32, "where.exe"), "fixture");
		writeFileSync(join(powershell, "powershell.exe"), "fixture");
		const bundle = join(root, "bundle");
		const env: NodeJS.ProcessEnv = { SystemRoot: root, Path: "custom-tools" };
		applyDefaults(env, bundle, "win32");
		applyDefaults(env, bundle, "win32");
		assert.equal(env.Path, ["custom-tools", system32, powershell].join(delimiter));
		assert.equal(env.PATH, undefined, "preserves PATH variable casing");

		const existing = [system32, powershell].map((dir) => dir.toUpperCase() + "\\").join(delimiter);
		const configured: NodeJS.ProcessEnv = { SystemRoot: root, PATH: existing };
		applyDefaults(configured, bundle, "win32");
		assert.equal(configured.PATH, existing, "Windows paths compare without case or trailing separator differences");

		const unix: NodeJS.ProcessEnv = { SystemRoot: root, PATH: "custom-tools" };
		applyDefaults(unix, bundle, "darwin");
		assert.equal(unix.PATH, "custom-tools");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not add missing Windows executables to PATH", () => {
	const root = mkdtempSync(join(tmpdir(), "harness-no-shell-"));
	try {
		mkdirSync(join(root, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
		const env: NodeJS.ProcessEnv = { SystemRoot: root, PATH: "custom-tools" };
		applyDefaults(env, join(root, "bundle"), "win32");
		assert.equal(env.PATH, "custom-tools");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi executes Windows PowerShell when the inherited PATH has no system tools", { skip: process.platform !== "win32" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "harness-shell-exec-"));
	const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const previousPath = process.env[pathKey];
	try {
		process.env[pathKey] = root;
		const env = { ...process.env };
		applyDefaults(env, join(root, "bundle"));
		process.env[pathKey] = env[pathKey];
		// pi 1.4.0 also falls back to ProgramFiles\PowerShell\7 and SystemRoot, so either shell is acceptable here.
		assert.match(getPowerShellConfig().shell, /(?:pwsh|powershell)\.exe$/i);
		const result = await createPowerShellTool(root, { operations: createWindowsPowerShellOperations() }).execute("shell-smoke", { command: "Write-Output 'WINDOWS_SHELL_OK'", timeout: 15 });
		assert.ok(result.content.some((item) => item.type === "text" && item.text.includes("WINDOWS_SHELL_OK")));
	} finally {
		if (previousPath === undefined) delete process.env[pathKey];
		else process.env[pathKey] = previousPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("PowerShell discovery uses live PATH and falls back to SystemRoot without where.exe", () => {
	const root = mkdtempSync(join(tmpdir(), "harness-shell-path-"));
	try {
		const systemShell = join(root, "System32", "WindowsPowerShell", "v1.0");
		const custom = join(root, "custom shell");
		mkdirSync(systemShell, { recursive: true });
		mkdirSync(custom);
		writeFileSync(join(systemShell, "powershell.exe"), "fixture");
		assert.equal(resolvePowerShell({ SystemRoot: root, PATH: "" }), join(systemShell, "powershell.exe"));
		writeFileSync(join(custom, "pwsh.exe"), "fixture");
		assert.equal(resolvePowerShell({ SystemRoot: root, Path: `"${custom}"` }), join(custom, "pwsh.exe"));
		assert.throws(() => resolvePowerShell({ SystemRoot: join(root, "missing"), PATH: "" }), /Windows PowerShell executable not found/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("shell process streams both outputs, inherits explicit environment and preserves failures", async () => {
	let output = "";
	const result = await runShellProcess(process.execPath, ["-e", "console.log(process.env.HARNESS_SHELL_TEST); console.error('stderr-ok'); process.exitCode = 7"], process.cwd(), {
		env: { ...process.env, HARNESS_SHELL_TEST: "stdout-ok" }, onData: (data) => { output += data.toString(); },
	});
	assert.equal(result.exitCode, 7);
	assert.match(output, /stdout-ok/);
	assert.match(output, /stderr-ok/);
});

test("shell process rejects invalid executables, timeouts and cancellation", async () => {
	const options = { onData: (_data: Buffer) => {} };
	await assert.rejects(runShellProcess("harness-missing-shell", [], process.cwd(), options), /ENOENT/);
	await assert.rejects(runShellProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), { ...options, timeout: 0.1 }), /timeout:0.1/);
	const controller = new AbortController();
	const child = runShellProcess(process.execPath, ["-e", "console.log('started'); setInterval(() => {}, 1000)"], process.cwd(), {
		signal: controller.signal, onData: () => controller.abort(),
	});
	await assert.rejects(child, /aborted/);
	await assert.rejects(runShellProcess(process.execPath, [], process.cwd(), { ...options, timeout: -1 }), /Invalid timeout/);
});

for (const mode of ["timeout", "abort"] as const) {
	test(`shell ${mode} returns despite a detached descendant retaining output handles`, { skip: process.platform === "win32", timeout: 8000 }, async () => {
		let descendantPid: number | undefined;
		let output = "";
		let updates = 0;
		const controller = new AbortController();
		const script = `const {spawn}=require('node:child_process');
const p=spawn(process.execPath,['-e',"console.log('DESCENDANT='+process.pid);setInterval(()=>console.log('frame'),20)"],{detached:true,stdio:['ignore',1,2]});
p.unref();setInterval(()=>{},1000);`;
		const start = performance.now();
		try {
			await assert.rejects(runShellProcess(process.execPath, ["-e", script], process.cwd(), {
				timeout: mode === "timeout" ? 0.5 : 5,
				signal: controller.signal,
				onData: (data) => {
					updates++;
					output += data.toString();
					const match = output.match(/DESCENDANT=(\d+)/);
					if (match) {
						descendantPid = Number(match[1]);
						if (mode === "abort") controller.abort();
					}
				},
			}), mode === "timeout" ? /^Error: timeout:0\.5$/ : /^Error: aborted$/);
			assert.ok(descendantPid, "descendant must start before termination");
			assert.ok(performance.now() - start < 3500, "cleanup must have a finite deadline");
			assert.match(output, /Cleanup deadline reached/);
			const previousUpdates = updates;
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(updates, previousUpdates, "no output callbacks after settlement");
		} finally {
			if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch { /* already exited */ } }
		}
	});
}

test("Windows tree termination reports missing taskkill", async () => {
	const root = mkdtempSync(join(tmpdir(), "harness-no-taskkill-"));
	try {
		assert.match((await terminateWindowsTree(process.pid, { ...process.env, SystemRoot: root })) ?? "", /taskkill failed:.*ENOENT.*could not be confirmed/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("taskkill runner is asynchronous, checks failure and bounds a hung command", { skip: process.platform === "win32", timeout: 8000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "harness-taskkill-"));
	const executable = join(root, "System32", "taskkill.exe");
	mkdirSync(join(root, "System32"));
	const env = { ...process.env, SystemRoot: root };
	const fixture = (script: string) => {
		writeFileSync(executable, `#!${process.execPath}\n${script}\n`);
		chmodSync(executable, 0o755);
	};
	try {
		fixture("console.error('permission denied');process.exitCode=5;");
		assert.match((await terminateWindowsTree(123, env)) ?? "", /exit 5.*permission denied/);
		fixture("process.exitCode=0;");
		assert.equal(await terminateWindowsTree(123, env), undefined);
		fixture("setInterval(()=>{},1000);");
		let ticks = 0;
		const ticker = setInterval(() => ticks++, 10);
		try {
			const start = performance.now();
			assert.match((await terminateWindowsTree(123, env, 150)) ?? "", /exceeded.*could not be confirmed/);
			assert.ok(performance.now() - start < 1500);
			assert.ok(ticks > 0, "termination must not block the event loop");
		} finally { clearInterval(ticker); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows timeout exposes taskkill failure even when the shell fallback exits", { skip: process.platform !== "win32", timeout: 8000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "harness-taskkill-failure-"));
	let output = "";
	try {
		await assert.rejects(runShellProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), {
			env: { ...process.env, SystemRoot: root }, timeout: 0.2,
			onData: (data) => { output += data.toString(); },
		}), /^Error: timeout:0\.2$/);
		assert.match(output, /taskkill failed:.*could not be confirmed/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows PowerShell timeout stops a continuously printing Python process", { skip: process.platform !== "win32", timeout: 12000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "harness-python-timeout-"));
	let pid: number | undefined;
	let output = "";
	const start = performance.now();
	try {
		writeFileSync(join(root, "rotate_cube_ascii.py"), "import os, time\nprint('PYTHON_PID=' + str(os.getpid()), flush=True)\nwhile True:\n print('rotating cube frame', flush=True)\n time.sleep(0.02)\n");
		const tool = createPowerShellTool(root, { operations: createWindowsPowerShellOperations() });
		await assert.rejects(tool.execute("python-timeout", { command: "python -u rotate_cube_ascii.py", timeout: 3 }, undefined, (update) => {
			output = update.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			const match = output.match(/PYTHON_PID=(\d+)/);
			if (match) pid = Number(match[1]);
		}), /Command timed out after 3 seconds/);
		assert.ok(pid, "Python must actually start");
		assert.match(output, /rotating cube frame/);
		assert.doesNotMatch(output, /could not be confirmed|Cleanup deadline reached/);
		assert.ok(performance.now() - start < 6500);
		assert.throws(() => process.kill(pid!, 0), /ESRCH/, "Python must no longer exist");
	} finally {
		if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
		rmSync(root, { recursive: true, force: true });
	}
});
