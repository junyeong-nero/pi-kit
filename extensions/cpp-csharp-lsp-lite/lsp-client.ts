// Local stdio LSP transport. No npm dependencies; also exercised directly by tests.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Location { uri: string; range: Range }
export interface LocationLink { targetUri: string; targetRange: Range; targetSelectionRange: Range }
export interface Diagnostic { range: Range; severity?: number; source?: string; message: string }
export interface SymbolInformation { name: string; kind: number; location: Location; containerName?: string }
export interface DocumentSymbol { name: string; kind: number; range: Range; selectionRange: Range; children?: DocumentSymbol[] }
export type Language = "cpp" | "csharp";
export interface ServerConfig {
	command: string;
	args?: string[];
	root?: string;
	env?: Record<string, string>;
	settings?: Record<string, unknown>;
	initializationOptions?: unknown;
	initializeTimeoutMs?: number;
	requestTimeoutMs?: number;
	diagnosticsTimeoutMs?: number;
}
export interface LspConfig { servers: Partial<Record<Language, ServerConfig>> }
const LANGUAGES: Record<string, string> = {
	".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
	".h": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".cs": "csharp",
};
export function languageOf(path: string): string | undefined { return LANGUAGES[extname(path).toLowerCase()]; }
export function serverLanguage(path: string): Language {
	const language = languageOf(path);
	if (!language) throw new Error(`Unsupported LSP file: ${path}`);
	return language === "csharp" ? "csharp" : "cpp";
}
export function uriKey(uri: string): string {
	const decoded = decodeURIComponent(uri);
	return process.platform === "win32" ? decoded.toLowerCase() : decoded;
}

// Config paths are bundle-relative, never relative to the project being analyzed.
export function loadConfig(path: string): LspConfig {
	const bundle = resolve(dirname(path), "..");
	const expand = (value: string) => value.replaceAll("${bundle}", bundle);
	const config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as LspConfig;
	if (!config.servers || typeof config.servers !== "object") throw new Error("LSP config requires servers");
	for (const [language, server] of Object.entries(config.servers)) {
		if (language !== "cpp" && language !== "csharp") throw new Error(`Unknown LSP language: ${language}`);
		if (!server || typeof server.command !== "string" || !server.command) throw new Error(`Missing ${language} command`);
		server.command = expand(server.command);
		if (/[\\/]/.test(server.command)) server.command = resolve(bundle, server.command);
		if (server.args && (!Array.isArray(server.args) || server.args.some(a => typeof a !== "string"))) throw new Error(`Invalid ${language} args`);
		server.args = (server.args ?? []).map(expand);
		if (server.root) server.root = resolve(bundle, expand(server.root));
		if (server.env) server.env = Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expand(v)]));
		for (const key of ["initializeTimeoutMs", "requestTimeoutMs", "diagnosticsTimeoutMs"] as const) {
			if (server[key] !== undefined && (!Number.isFinite(server[key]) || server[key]! <= 0)) throw new Error(`Invalid ${language} ${key}`);
		}
	}
	return config;
}

export function projectRoot(start: string, language: Language): string {
	let dir = resolve(start);
	let nearestProject: string | undefined;
	for (;;) {
		let names: string[] = [];
		try { names = readdirSync(dir); } catch { /* inaccessible ancestor */ }
		if (language === "csharp") {
			if (names.some(n => /\.slnx?$/i.test(n))) return dir;
			if (!nearestProject && names.some(n => /\.csproj$/i.test(n))) nearestProject = dir;
		} else {
			if (names.includes("compile_commands.json") || existsSync(resolve(dir, "build/compile_commands.json"))) return dir;
			if (!nearestProject && (names.includes("CMakeLists.txt") || names.includes("compile_flags.txt") || names.some(n => /\.vcxproj$/i.test(n)))) nearestProject = dir;
		}
		if (names.includes(".git") || dirname(dir) === dir) break;
		dir = dirname(dir);
	}
	return nearestProject ?? resolve(start);
}

export function normalizeLocations(value: Location | LocationLink | (Location | LocationLink)[] | null): Location[] {
	return (value == null ? [] : Array.isArray(value) ? value : [value]).map(l =>
		"targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l);
}
export function normalizeSymbols(symbols: (SymbolInformation | DocumentSymbol)[], uri?: string, container?: string): SymbolInformation[] {
	return symbols.flatMap(s => {
		if ("location" in s) return [s];
		if (!uri) throw new Error("DocumentSymbol requires a document URI");
		return [{ name: s.name, kind: s.kind, location: { uri, range: s.selectionRange ?? s.range }, containerName: container },
			...normalizeSymbols(s.children ?? [], uri, s.name)];
	});
}

type JsonMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message: string } };
type DiagnosticReport = { kind: "full"; items: Diagnostic[] } | { kind: "unchanged" };
export class LspClient {
	private proc: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private versions = new Map<string, { version: number; text: string }>();
	private diagnostics = new Map<string, { items: Diagnostic[]; version: number }>();
	private waiters = new Set<() => void>();
	private dead?: Error;
	private stderr = "";
	private capabilities: any = {};
	private shutdownPromise?: Promise<void>;
	private exited: Promise<void>;
	readonly root: string;
	readonly config: ServerConfig;
	readonly ready: Promise<void>;

	constructor(root: string, config: ServerConfig) {
		this.root = root;
		this.config = config;
		this.proc = spawn(config.command, config.args ?? [], {
			cwd: root, env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
		});
		this.exited = new Promise(done => this.proc.once("close", () => done()));
		this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.proc.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
		this.proc.stdin.on("error", err => this.fail(err));
		this.proc.on("error", err => this.fail(new Error(`${config.command}: ${err.message}`)));
		this.proc.on("exit", code => this.fail(new Error(`${config.command} exited (${code})\n${this.stderr}`)));
		this.ready = this.initialize().catch(err => { this.fail(err); this.proc.kill(); throw err; });
		// A process may fail before the caller starts awaiting ready.
		void this.ready.catch(() => {});
	}
	get error(): Error | undefined { return this.dead; }
	private async initialize() {
		const uri = pathToFileURL(this.root).href;
		const result = await this.request<any>("initialize", {
			processId: process.pid, rootUri: uri, rootPath: this.root,
			workspaceFolders: [{ uri, name: basename(this.root) }],
			capabilities: {
				general: { positionEncodings: ["utf-16"] },
				workspace: { configuration: true, workspaceFolders: true, diagnostic: { refreshSupport: true } },
				window: { workDoneProgress: true },
				textDocument: {
					publishDiagnostics: { versionSupport: true }, diagnostic: { dynamicRegistration: false },
					documentSymbol: { hierarchicalDocumentSymbolSupport: true }, definition: { linkSupport: true },
					hover: { contentFormat: ["markdown", "plaintext"] },
				},
			}, initializationOptions: this.config.initializationOptions,
		}, this.config.initializeTimeoutMs ?? 120000);
		this.capabilities = result?.capabilities ?? {};
		if (this.capabilities.positionEncoding && this.capabilities.positionEncoding !== "utf-16") throw new Error("Server did not select UTF-16 positions");
		this.notify("initialized", {});
		this.notify("workspace/didChangeConfiguration", { settings: this.config.settings ?? {} });
	}
	private fail(err: Error) {
		if (this.dead) return;
		this.dead = err;
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
		this.wake();
	}
	private write(msg: object) {
		if (this.dead) throw this.dead;
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
		this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	}
	request<T>(method: string, params: unknown, timeoutMs = this.config.requestTimeoutMs ?? 30000): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				try { this.notify("$/cancelRequest", { id }); } catch { /* already exited */ }
				reject(new Error(`${method} timed out (${timeoutMs}ms)\n${this.stderr}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: v => { clearTimeout(timer); resolvePromise(v); },
				reject: e => { clearTimeout(timer); reject(e); },
			});
			try { this.write({ id, method, params }); }
			catch (e) { this.pending.get(id)?.reject(e as Error); this.pending.delete(id); }
		});
	}
	notify(method: string, params: unknown) { this.write({ method, params }); }
	private onData(chunk: Buffer) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const match = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("ascii"));
			if (!match) { this.fail(new Error("Invalid LSP Content-Length header")); this.proc.kill(); return; }
			const start = headerEnd + 4, end = start + Number(match[1]);
			if (this.buffer.length < end) return;
			const body = this.buffer.subarray(start, end).toString("utf8");
			this.buffer = this.buffer.subarray(end);
			try { this.onMessage(JSON.parse(body)); }
			catch (e) { this.fail(e as Error); this.proc.kill(); return; }
		}
	}
	private onMessage(msg: JsonMessage) {
		if (msg.method === "textDocument/publishDiagnostics") {
			const key = uriKey(msg.params.uri), open = this.versions.get(key);
			if (!open || (msg.params.version !== undefined && msg.params.version !== open.version)) return;
			this.diagnostics.set(key, { items: msg.params.diagnostics ?? [], version: open.version });
			this.wake(); return;
		}
		if (msg.method !== undefined) {
			if (msg.id === undefined) return;
			let result: unknown = null;
			switch (msg.method) {
				case "workspace/configuration":
					result = (msg.params?.items ?? []).map((item: { section?: string }) => {
						let value: any = this.config.settings ?? {};
						for (const part of item.section?.split(".") ?? []) value = value?.[part];
						return value ?? null;
					}); break;
				case "workspace/workspaceFolders": result = [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }]; break;
				case "window/workDoneProgress/create": break;
				case "workspace/diagnostic/refresh": this.diagnostics.clear(); this.wake(); break;
				case "window/showMessageRequest": break;
				case "workspace/applyEdit": result = { applied: false, failureReason: "Use pi edit/write tools to change files" }; break;
				default:
					this.write({ id: msg.id, error: { code: -32601, message: `Unsupported client method: ${msg.method}` } }); return;
			}
			this.write({ id: msg.id, result }); return;
		}
		if (msg.id === undefined) return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
	}
	private wake() { for (const wake of [...this.waiters]) wake(); }
	sync(path: string): number {
		const uri = pathToFileURL(path).href, key = uriKey(uri), text = readFileSync(path, "utf8");
		const open = this.versions.get(key);
		if (!open) {
			this.versions.set(key, { version: 1, text });
			this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageOf(path), version: 1, text } });
			return 1;
		}
		if (open.text === text) return open.version;
		open.version++; open.text = text;
		this.diagnostics.delete(key);
		// A full-document content change (no range) is valid for incremental sync too.
		this.notify("textDocument/didChange", { textDocument: { uri, version: open.version }, contentChanges: [{ text }] });
		const sync = this.capabilities.textDocumentSync;
		if (sync && typeof sync === "object" && sync.save) {
			this.notify("textDocument/didSave", { textDocument: { uri }, ...(sync.save.includeText ? { text } : {}) });
		}
		return open.version;
	}
	async diagnose(path: string): Promise<{ diagnostics: Diagnostic[]; timedOut: boolean }> {
		await this.ready;
		const version = this.sync(path), uri = pathToFileURL(path).href, key = uriKey(uri);
		const timeout = this.config.diagnosticsTimeoutMs ?? 60000;
		if (this.capabilities.diagnosticProvider) {
			const provider = this.capabilities.diagnosticProvider;
			const report = await this.request<DiagnosticReport>("textDocument/diagnostic", {
				textDocument: { uri }, ...(provider.identifier ? { identifier: provider.identifier } : {}),
			}, timeout);
			if (this.versions.get(key)?.version !== version) return { diagnostics: [], timedOut: true };
			if (report.kind !== "full") throw new Error("Expected full diagnostic report without previousResultId");
			this.diagnostics.set(key, { items: report.items, version });
		} else {
			await new Promise<void>(done => {
				let timer: ReturnType<typeof setTimeout>;
				const finish = () => { clearTimeout(timer); this.waiters.delete(check); done(); };
				const check = () => { if (this.dead || this.diagnostics.get(key)?.version === version) finish(); };
				timer = setTimeout(finish, timeout); this.waiters.add(check); check();
			});
		}
		if (this.dead) throw this.dead;
		const report = this.diagnostics.get(key);
		const current = report?.version === version && this.versions.get(key)?.version === version;
		return { diagnostics: current ? report.items : [], timedOut: !current };
	}
	shutdown(): Promise<void> {
		this.shutdownPromise ??= this.close();
		return this.shutdownPromise;
	}
	private async close() {
		if (!this.dead) {
			try { await this.request("shutdown", null, 1000); this.notify("exit", null); } catch { /* kill below */ }
		}
		this.fail(new Error("LSP client closed"));
		this.proc.kill();
		// Windows keeps project directories/DLLs locked until the process is gone.
		await this.exited;
	}
}

export class LspPool {
	private clients = new Map<string, { language: Language; client: LspClient }>();
	readonly config: LspConfig;
	constructor(config: LspConfig) { this.config = config; }
	get(language: Language, cwd: string, path?: string): LspClient {
		const config = this.config.servers[language];
		if (!config) throw new Error(`No ${language} server configured`);
		const root = config.root ?? projectRoot(path ? dirname(path) : cwd, language);
		const key = `${language}:${uriKey(pathToFileURL(root).href)}`;
		let entry = this.clients.get(key);
		if (entry?.client.error) { void entry.client.shutdown(); this.clients.delete(key); entry = undefined; }
		if (!entry) { entry = { language, client: new LspClient(root, config) }; this.clients.set(key, entry); }
		return entry.client;
	}
	forFile(cwd: string, path: string) { return this.get(serverLanguage(path), cwd, path); }
	workspace(cwd: string, language?: Language): LspClient[] {
		const languages = language ? [language] : Object.keys(this.config.servers) as Language[];
		const result = new Set<LspClient>();
		for (const lang of languages) result.add(this.get(lang, cwd));
		for (const entry of this.clients.values()) if ((!language || entry.language === language) && !entry.client.error) result.add(entry.client);
		return [...result];
	}
	async shutdown() { await Promise.all([...this.clients.values()].map(e => e.client.shutdown())); this.clients.clear(); }
}
