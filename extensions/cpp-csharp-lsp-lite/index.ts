// pi tools backed by bundled clangd and csharp-ls. Loaded from the bundle's pi package (setup.cmd registers it).
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computeDelta, deltaHeadline, errorsOf } from "./diagnostics-delta.ts";
import { LspPool, loadConfig, languageOf, normalizeLocations, normalizeSymbols,
  type Diagnostic, type Location, type LocationLink, type SymbolInformation, type DocumentSymbol, type Language } from "./lsp-client.ts";

import { formatFallback, formatFound, rgCommand, rgSearch, type TextHit } from "./find-symbol.ts";

const SEVERITY = ["", "error", "warning", "info", "hint"];
const SYMBOL_KIND: Record<number, string> = { 5: "class", 6: "method", 10: "enum", 11: "interface", 12: "function", 14: "constant" };
const MAX_LINES = 50;

// ---------- 출력 포맷 ----------

function displayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function diagnosticLine(shown: string, d: Diagnostic): string {
	const where = `${shown}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
	const source = d.source ? ` [${d.source}]` : "";
	return `${where} ${SEVERITY[d.severity ?? 3] ?? "info"}${source} ${d.message}`;
}

// 수정 직후에만 쓴다: 첫 줄에 오류 증감을, 이어서 새로 생긴 오류를 먼저 보여준다.
function formatDeltaPrefix(cwd: string, path: string, baseline: Diagnostic[] | undefined, diagnostics: Diagnostic[], timedOut: boolean): string[] {
	if (timedOut) return ["이번 수정 후 진단이 도착하지 않아 오류 증감을 알 수 없음"];
	if (!baseline) return [deltaHeadline(undefined)];
	const delta = computeDelta(baseline, diagnostics);
	const shown = displayPath(cwd, path);
	const introduced = delta.introduced.slice(0, MAX_LINES).map((d) => diagnosticLine(shown, d));
	return [deltaHeadline(delta), ...(introduced.length ? ["새로 생긴 오류:", ...introduced] : [])];
}

function formatDiagnostics(cwd: string, path: string, diagnostics: Diagnostic[], timedOut: boolean, prefix: string[] = []): string {
	const shown = displayPath(cwd, path);
	const lines = diagnostics
		.slice()
		.sort((a, b) => (a.severity ?? 9) - (b.severity ?? 9) || a.range.start.line - b.range.start.line)
		.map((d) => diagnosticLine(shown, d));
	const head = `cpp-csharp-lsp-lite diagnostics for ${shown}: ${timedOut ? "analysis pending (timed out)" : diagnostics.length === 0 ? "no issues" : `${diagnostics.length} issue(s)`}`;
	const body = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `... ${lines.length - MAX_LINES} more`] : lines;
	const note = timedOut ? ["Diagnostics for the current file did not arrive. Retry lsp_diagnostics; this does not mean the file is error-free."] : [];
	return [...prefix, head, ...body, ...note].join("\n");
}

function lineText(path: string, line: number): string {
	try {
		return readFileSync(path, "utf8").split(/\r?\n/)[line]?.trim() ?? "";
	} catch {
		return "";
	}
}

function formatLocation(cwd: string, loc: Location): string {
	if (!loc.uri.startsWith("file:")) return `${loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
	const path = fileURLToPath(loc.uri);
	const { line, character } = loc.range.start;
	return `${displayPath(cwd, path)}:${line + 1}:${character + 1}  ${lineText(path, line)}`;
}

function formatSymbols(cwd: string, symbols: SymbolInformation[]): string {
	if (symbols.length === 0) return "No symbols found.";
	return symbols
		.slice(0, MAX_LINES * 2)
		.map((s) => {
			const kind = SYMBOL_KIND[s.kind] ?? `kind ${s.kind}`;
			const container = s.containerName ? ` in ${s.containerName}` : "";
			const { line } = s.location.range.start;
			return `${s.name} (${kind}${container})  ${(s.location.uri.startsWith("file:") ? displayPath(cwd, fileURLToPath(s.location.uri)) : s.location.uri)}:${line + 1}`;
		})
		.join("\n");
}

function hoverText(contents: unknown): string {
	if (contents == null) return "";
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
	if (typeof contents === "object" && "value" in contents) return String((contents as { value: unknown }).value);
	return JSON.stringify(contents);
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

// ---------- extension ----------

const PositionParams = Type.Object({
	path: Type.String({ description: "File path (relative to cwd or absolute)" }),
	line: Type.Integer({ minimum: 1, description: "1-based line number" }),
	symbol: Type.Optional(Type.String({ description: "Identifier on that line to look up (preferred over column)" })),
	column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based column, used when symbol is not given" })),
});

export default function (pi: ExtensionAPI) {
	let pool: LspPool | undefined;
	function getPool(): LspPool {
		if (!pool) {
			const configPath = process.env.HARNESS_LSP_CONFIG;
			if (!configPath) throw new Error("HARNESS_LSP_CONFIG is missing. Run setup.cmd in the bundle folder to register the harness package.");
			pool = new LspPool(loadConfig(configPath));
		}
		return pool;
	}
	// 파일별 마지막 진단(오류만). 수정 후 오류 증감의 기준선이며, 타임아웃된 결과는 저장하지 않는다.
	const baselines = new Map<string, Diagnostic[]>();
	async function runDiagnostics(ctx: ExtensionContext, path: string, afterEdit = false): Promise<string> {
		const { diagnostics, timedOut } = await getPool().forFile(ctx.cwd, path).diagnose(path);
		const prefix = afterEdit ? formatDeltaPrefix(ctx.cwd, path, baselines.get(path), diagnostics, timedOut) : [];
		if (!timedOut) baselines.set(path, errorsOf(diagnostics));
		return formatDiagnostics(ctx.cwd, path, diagnostics, timedOut, prefix);
	}

	function resolvePath(ctx: ExtensionContext, path: string): string {
		const abs = resolve(ctx.cwd, path.replace(/^@/, ""));
		if (!languageOf(abs)) throw new Error(`Unsupported C/C++/C# file: ${path}`);
		return abs;
	}

	async function positionOf(ctx: ExtensionContext, params: { path: string; line: number; symbol?: string; column?: number }) {
		const path = resolvePath(ctx, params.path);
		const c = getPool().forFile(ctx.cwd, path);
		await c.ready;
		c.sync(path);
		const line = params.line - 1;
		let character: number;
		if (params.symbol) {
			const source = readFileSync(path, "utf8").split(/\r?\n/)[line] ?? "";
			const escaped = params.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const match = new RegExp(`\\b${escaped}\\b`).exec(source);
			if (!match) throw new Error(`"${params.symbol}" not found on line ${params.line}: ${source.trim()}`);
			character = match.index;
		} else if (params.column) {
			character = params.column - 1;
		} else {
			throw new Error("Provide symbol or column.");
		}
		return {
			c,
			params: { textDocument: { uri: pathToFileURL(path).href }, position: { line, character } },
		};
	}

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const input = event.input.path;
		if (typeof input !== "string") return;
		const path = resolve(ctx.cwd, input.replace(/^@/, ""));
		if (!languageOf(path)) return;
		let report: string;
		try {
			report = await runDiagnostics(ctx, path, true);
		} catch (e) {
			report = `cpp-csharp-lsp-lite unavailable: ${(e as Error).message}`;
		}
		return { content: [...event.content, { type: "text", text: `\n${report}` }] };
	});

	pi.on("session_shutdown", async () => {
		await pool?.shutdown();
		pool = undefined;
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP diagnostics",
		description: "Report cpp-csharp-lsp-lite diagnostics (errors/warnings) for a C, C++ or C# file as it is on disk.",
		promptSnippet: "Check a C/C++/C# file for errors via cpp-csharp-lsp-lite",
		parameters: Type.Object({ path: Type.String({ description: "File path (relative to cwd or absolute)" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(await runDiagnostics(ctx, resolvePath(ctx, params.path)));
		},
	});

	pi.registerTool({
		name: "lsp_symbols",
		label: "LSP symbols",
		description:
			"List C/C++/C# symbols (classes, functions, methods, enums). With path: symbols in that file. Without path: workspace symbols whose name contains query.",
		promptSnippet: "Find C/C++/C# classes and functions by name via cpp-csharp-lsp-lite",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Substring of the symbol name (workspace search)" })),
			path: Type.Optional(Type.String({ description: "List symbols of this file instead" })),
			language: Type.Optional(Type.Union([Type.Literal("cpp"), Type.Literal("csharp")], { description: "Limit workspace search to a language" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.path) {
				const path = resolvePath(ctx, params.path);
				const c = getPool().forFile(ctx.cwd, path);
				await c.ready;
				c.sync(path);
				const uri = pathToFileURL(path).href;
				const symbols = await c.request<(SymbolInformation | DocumentSymbol)[]>("textDocument/documentSymbol", { textDocument: { uri } });
				return text(formatSymbols(ctx.cwd, normalizeSymbols(symbols ?? [], uri)));
			}
			const clients = getPool().workspace(ctx.cwd, params.language as Language | undefined);
			const results = await Promise.allSettled(clients.map(async c => {
				await c.ready;
				return (await c.request<SymbolInformation[]>("workspace/symbol", { query: params.query ?? "" })) ?? [];
			}));
			const symbols: SymbolInformation[] = [];
			const errors: string[] = [];
			const seen = new Set<string>();
			for (const result of results) {
				if (result.status === "rejected") { errors.push(String(result.reason)); continue; }
				for (const symbol of result.value) {
					const key = JSON.stringify([symbol.name, symbol.location]);
					if (!seen.has(key)) { seen.add(key); symbols.push(symbol); }
				}
			}
			return text([formatSymbols(ctx.cwd, symbols), ...errors.map(e => `Partial search: ${e}`)].join("\n"));
		},
	});

	pi.registerTool({
		name: "lsp_definition",
		label: "LSP definition",
		description: "Go to the definition of a C/C++/C# identifier. Give the file, 1-based line, and the identifier text on that line.",
		promptSnippet: "Jump to where a C/C++/C# identifier is defined via cpp-csharp-lsp-lite",
		parameters: PositionParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { c, params: req } = await positionOf(ctx, params);
			const result = await c.request<Location | LocationLink | (Location | LocationLink)[] | null>("textDocument/definition", req);
			const locations = normalizeLocations(result);
			return text(locations.length === 0 ? "No definition found." : locations.map((l) => formatLocation(ctx.cwd, l)).join("\n"));
		},
	});

	pi.registerTool({
		name: "lsp_references",
		label: "LSP references",
		description: "Find references to a C/C++/C# identifier across the workspace. Give the file, 1-based line, and the identifier text on that line.",
		promptSnippet: "Find all uses of a C/C++/C# identifier via cpp-csharp-lsp-lite",
		parameters: PositionParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { c, params: req } = await positionOf(ctx, params);
			const locations = (await c.request<Location[] | null>("textDocument/references", { ...req, context: { includeDeclaration: true } })) ?? [];
			const lines = locations.slice(0, MAX_LINES * 2).map((l) => formatLocation(ctx.cwd, l));
			if (locations.length > lines.length) lines.push(`... ${locations.length - lines.length} more`);
			return text(lines.length === 0 ? "No references found." : lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "lsp_hover",
		label: "LSP hover",
		description: "Show the declaration/signature of a C/C++/C# identifier. Give the file, 1-based line, and the identifier text on that line.",
		promptSnippet: "Show the signature of a C/C++/C# identifier via cpp-csharp-lsp-lite",
		parameters: PositionParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { c, params: req } = await positionOf(ctx, params);
			const result = await c.request<{ contents: unknown } | null>("textDocument/hover", req);
			return text(hoverText(result?.contents) || "No hover information.");
		},
	});

	pi.registerTool({
		name: "find_symbol",
		label: "Find symbol",
		description:
			"Find a C/C++/C# symbol by name and return its definition (1 line) and its references in one call. Falls back to text search (rg) and says so when LSP is not ready.",
		promptSnippet: "Get a C/C++/C# symbol's definition and references by name in one call",
		parameters: Type.Object({
			name: Type.String({ description: "Exact symbol name (function, class, method, variable)" }),
			path: Type.Optional(Type.String({ description: "File or folder to search in (default: cwd)" })),
			language: Type.Optional(Type.Union([Type.Literal("cpp"), Type.Literal("csharp")], { description: "Limit to a language" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const name = params.name.trim();
			if (!name) throw new Error("name is required.");
			const target = params.path ? resolve(ctx.cwd, params.path.replace(/^@/, "")) : ctx.cwd;
			const wanted = params.language as Language | undefined;
			const inLanguage = (p: string) => { const l = languageOf(p); return !!l && (!wanted || (l === "csharp" ? "csharp" : "cpp") === wanted); };
			const hits = await rgSearch(rgCommand(process.env.HARNESS_LSP_CONFIG), ctx.cwd, name, target, signal);
			const textHits = hits?.map((h) => ({ ...h, path: resolve(ctx.cwd, h.path) })).filter((h) => inLanguage(h.path));
			const showHit = (h: TextHit) => `${displayPath(ctx.cwd, h.path)}:${h.line + 1}:${h.character + 1}  ${h.text}`;
			const fallback = (reason: string) => text(formatFallback(name, reason, textHits, showHit));
			try {
				// Candidate positions: exact workspace-symbol matches first, then text hits.
				const candidates: { path: string; line: number; character: number }[] = [];
				if (!params.path) {
					const found = await Promise.allSettled(getPool().workspace(ctx.cwd, wanted).map(async (c) => {
						await c.ready;
						return (await c.request<SymbolInformation[]>("workspace/symbol", { query: name })) ?? [];
					}));
					for (const r of found) if (r.status === "fulfilled") for (const s of r.value) {
						if (s.name.split(/::|\./).pop() === name && s.location.uri.startsWith("file:")) candidates.push({ path: fileURLToPath(s.location.uri), line: s.location.range.start.line, character: s.location.range.start.character });
					}
				}
				candidates.push(...(textHits ?? []).slice(0, 5));
				for (const cand of candidates.filter((c) => inLanguage(c.path)).slice(0, 8)) {
					const c = getPool().forFile(ctx.cwd, cand.path);
					await c.ready;
					c.sync(cand.path);
					const at = { textDocument: { uri: pathToFileURL(cand.path).href }, position: { line: cand.line, character: cand.character } };
					const defs = normalizeLocations(await c.request<Location | LocationLink | (Location | LocationLink)[] | null>("textDocument/definition", at));
					if (defs.length === 0) continue;
					const refs = (await c.request<Location[] | null>("textDocument/references", { ...at, context: { includeDeclaration: true } })) ?? [];
					return text(formatFound(name, formatLocation(ctx.cwd, defs[0]), refs.map((l) => formatLocation(ctx.cwd, l))));
				}
				return fallback("LSP가 정의를 찾지 못함");
			} catch (e) {
				return fallback(`LSP 오류: ${(e as Error).message.split("\n")[0]}`);
			}
		},
	});
}
