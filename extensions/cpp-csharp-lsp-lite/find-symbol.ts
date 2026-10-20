// find_symbol helpers: bundled-rg text search and the fixed output format.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MAX_REFS = 30;
export interface TextHit { path: string; line: number; character: number; text: string }

// Bundled rg lives at <bundle>/bin/rg.exe (Windows) next to config/lsp.json; otherwise fall back to PATH.
export function rgCommand(configPath?: string): string {
	if (configPath) {
		const bundled = resolve(dirname(configPath), "..", "bin", process.platform === "win32" ? "rg.exe" : "rg");
		if (existsSync(bundled)) return bundled;
	}
	return "rg";
}

// `rg --vimgrep` line: path:line:col:text (a Windows drive letter contains a colon).
export function parseRgLine(raw: string): TextHit | undefined {
	const m = /^((?:[A-Za-z]:)?[^:]*):(\d+):(\d+):(.*)$/.exec(raw.replace(/\r$/, ""));
	return m ? { path: m[1], line: Number(m[2]) - 1, character: Number(m[3]) - 1, text: m[4].trim() } : undefined;
}

/** Whole-word text search for name. Resolves to undefined when rg is unavailable. */
export function rgSearch(command: string, cwd: string, name: string, target: string, signal?: AbortSignal): Promise<TextHit[] | undefined> {
	const globs = ["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "cs"].flatMap((e) => ["-g", `*.${e}`]);
	return new Promise((done) => {
		execFile(command, ["--vimgrep", "-w", "-F", "--no-messages", ...globs, "-e", name, target], { cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024, signal, windowsHide: true }, (err, stdout) => {
			const code = (err as NodeJS.ErrnoException | null)?.code;
			if (code === "ENOENT" || code === "EACCES") return done(undefined);
			done(String(stdout ?? "").split("\n").map(parseRgLine).filter((h): h is TextHit => !!h));
		});
	});
}

export function formatFallback(name: string, reason: string, hits: TextHit[] | undefined, show: (h: TextHit) => string): string {
	const head = `find_symbol ${name}: LSP 결과 없음 (${reason}). 아래는 텍스트 검색(rg) 결과이며 정의와 사용처를 구분하지 않았다.`;
	if (!hits) return `${head}\nrg를 실행할 수 없어 텍스트 검색도 하지 못했다. lsp_symbols로 직접 찾아라.`;
	if (hits.length === 0) return `${head}\n일치하는 위치가 없다.`;
	const lines = hits.slice(0, MAX_REFS).map(show);
	if (hits.length > lines.length) lines.push(`외 ${hits.length - lines.length}개`);
	return [head, ...lines].join("\n");
}

export function formatFound(name: string, definition: string, references: string[]): string {
	const shown = references.slice(0, MAX_REFS);
	const lines = [`find_symbol ${name}: LSP 결과`, `정의: ${definition}`, `참조 ${references.length}개:`, ...shown];
	if (references.length > shown.length) lines.push(`외 ${references.length - shown.length}개`);
	return lines.join("\n");
}
