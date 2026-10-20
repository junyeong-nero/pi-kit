// 파일 인코딩 판별·변환. read·edit·write가 원래 인코딩·BOM을 유지하고, 새 파일은 주변 파일을 따르게 한다.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type FileEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "cp949";
/** empty: 0바이트, binary: BOM 없는 NUL 포함, unknown: 위 인코딩 어느 것으로도 손실 없이 해석되지 않음. */
export type Detected = FileEncoding | "empty" | "binary" | "unknown";

export const ENCODING_LABELS: Record<FileEncoding, string> = {
	"utf8": "UTF-8", "utf8-bom": "UTF-8 BOM", "utf16le": "UTF-16 LE", "utf16be": "UTF-16 BE", "cp949": "CP949",
};

/** CP949 변환표. Node에는 CP949 인코더가 없고 standalone pi(Bun)는 vendor의 패키지를 이름으로 불러오지 못하므로,
 *  iconv-lite(MIT)가 싣고 있는 변환표 JSON만 파일로 읽어 직접 변환한다. 배포본은 vendor/extensions, 개발 환경은 node_modules. */
type Cp949 = { decode: Map<number, number>; encode: Map<number, number> };
let cp949Table: Cp949 | undefined;
function cp949(): Cp949 {
	if (cp949Table) return cp949Table;
	const bundle = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const table = [join(bundle, "vendor", "extensions", "node_modules"), join(bundle, "node_modules")]
		.map((dir) => join(dir, "iconv-lite", "encodings", "tables", "cp949.json")).find((path) => existsSync(path));
	if (!table) throw new Error("CP949 변환표(iconv-lite)를 찾지 못했습니다. 완성된 배포 ZIP을 사용하세요.");
	const decode = new Map<number, number>();
	// 각 묶음: [시작 코드(16진수), 문자열(연속 코드에 차례로 대응) 또는 숫자(직전 문자부터 1씩 증가하는 개수)...]
	for (const [start, ...parts] of JSON.parse(readFileSync(table, "utf-8")) as [string, ...(string | number)[]][]) {
		let code = parseInt(start, 16);
		for (const part of parts) {
			if (typeof part === "string") for (const char of part) decode.set(code++, char.codePointAt(0)!);
			else for (let next = decode.get(code - 1)! + 1, end = code + part; code < end;) decode.set(code++, next++);
		}
	}
	const encode = new Map<number, number>();
	for (const [code, char] of decode) if (!encode.has(char)) encode.set(char, code);
	return cp949Table = { decode, encode };
}

/** 변환표에 없는 바이트가 있으면 undefined. */
export function decodeCp949(bytes: Buffer): string | undefined {
	const { decode } = cp949();
	const chars: number[] = [];
	for (let i = 0; i < bytes.length; i++) {
		const single = decode.get(bytes[i]);
		if (single !== undefined) { chars.push(single); continue; }
		const double = i + 1 < bytes.length ? decode.get((bytes[i] << 8) | bytes[i + 1]) : undefined;
		if (double === undefined) return undefined;
		chars.push(double);
		i++;
	}
	let text = "";
	for (let i = 0; i < chars.length; i += 8192) text += String.fromCodePoint(...chars.slice(i, i + 8192));
	return text;
}

/** 표현할 수 없는 첫 문자를 돌려준다. */
export function encodeCp949(text: string): Buffer | string {
	const { encode } = cp949();
	const bytes: number[] = [];
	for (const char of text) {
		const code = encode.get(char.codePointAt(0)!);
		if (code === undefined) return char;
		if (code > 0xff) bytes.push(code >> 8);
		bytes.push(code & 0xff);
	}
	return Buffer.from(bytes);
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function isUtf8(bytes: Uint8Array): boolean {
	try { utf8Decoder.decode(bytes); return true; } catch { return false; }
}

function isCp949(bytes: Buffer): boolean {
	return decodeCp949(bytes) !== undefined;
}

export function detectEncoding(bytes: Buffer): Detected {
	if (bytes.length === 0) return "empty";
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return isUtf8(bytes.subarray(3)) ? "utf8-bom" : "unknown";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.length % 2 === 0 ? "utf16le" : "unknown";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.length % 2 === 0 ? "utf16be" : "unknown";
	if (bytes.includes(0)) return "binary";
	if (isUtf8(bytes)) return "utf8";
	return isCp949(bytes) ? "cp949" : "unknown";
}

export function isAscii(text: string): boolean {
	return /^[\x00-\x7f]*$/.test(text);
}

/** BOM을 뺀 텍스트. */
export function decodeText(bytes: Buffer, encoding: FileEncoding): string {
	switch (encoding) {
		case "utf8": return bytes.toString("utf-8");
		case "utf8-bom": return bytes.subarray(3).toString("utf-8");
		case "utf16le": return bytes.subarray(2).toString("utf16le");
		case "utf16be": return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
		case "cp949": {
			const text = decodeCp949(bytes);
			if (text === undefined) throw new EncodingError("CP949로 해석할 수 없는 바이트가 있습니다.");
			return text;
		}
	}
}

export class EncodingError extends Error {}

/** 텍스트 앞의 BOM 문자는 무시하고, 인코딩이 정한 BOM을 붙인다. 표현할 수 없는 문자가 있으면 저장하지 않는다. */
export function encodeText(text: string, encoding: FileEncoding): Buffer {
	const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
	switch (encoding) {
		case "utf8": return Buffer.from(body, "utf-8");
		case "utf8-bom": return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf-8")]);
		case "utf16le": return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
		case "utf16be": return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body, "utf16le").swap16()]);
		case "cp949": {
			const bytes = encodeCp949(body);
			if (typeof bytes === "string") {
				const code = bytes.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
				const bad = bytes;
				throw new EncodingError(`CP949 파일에 넣을 수 없는 문자가 있어 저장하지 않았습니다: '${bad}' (U+${code}). 이모지·특수 기호를 CP949에 있는 문자로 바꾸세요.`);
			}
			return bytes;
		}
	}
}

export function undecidableMessage(path: string, detected: Detected): string {
	return detected === "binary"
		? `${path}: 바이너리 파일이라 텍스트로 수정하지 않았습니다.`
		: `${path}: 인코딩을 판별할 수 없어(UTF-8·UTF-16·CP949가 아님) 파일을 바꾸지 않았습니다. 원래 인코딩을 알면 powershell에서 python으로 encoding을 지정해 수정하세요.`;
}

// 새 파일 인코딩 ---------------------------------------------------------------

/** 근거가 없을 때 BOM을 붙이는 형식. MSVC·PowerShell 5.1은 BOM 없는 UTF-8을 CP949로 읽는다. */
const BOM_DEFAULT = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".inl", ".ipp", ".cs", ".ps1", ".psm1", ".psd1"]);
const POWERSHELL = new Set([".ps1", ".psm1", ".psd1"]);
const MAX_NEIGHBORS = 200;
const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;

export type Choice = { encoding: FileEncoding; reason: string };

function editorconfigPattern(section: string): RegExp | undefined {
	// 파일 이름만 보는 단순한 패턴(*, *.ext, *.{a,b})만 지원한다. 경로가 들어간 패턴은 무시한다.
	if (section.includes("/") || section.includes("[")) return undefined;
	// 와일드카드를 먼저 바꿔야 중괄호가 만든 "(?:"의 ?가 다시 바뀌지 않는다.
	const source = section.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*\*?/g, ".*").replace(/\?/g, ".")
		.replace(/\{([^}]*)\}/g, (_m, list: string) => `(?:${list.split(",").join("|")})`);
	return new RegExp(`^${source}$`, "i");
}

const EDITORCONFIG_CHARSET: Record<string, FileEncoding> = { "utf-8": "utf8", "utf-8-bom": "utf8-bom", "utf-16le": "utf16le", "utf-16be": "utf16be" };

/** 가까운 .editorconfig가 우선한다. root = true에서 멈춘다. */
export function editorconfigCharset(file: string): FileEncoding | undefined {
	const files: string[] = [];
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		const config = join(dir, ".editorconfig");
		if (existsSync(config)) {
			files.unshift(config);
			if (/^\s*root\s*=\s*true\s*$/im.test(readFileSync(config, "utf-8"))) break;
		}
		if (dirname(dir) === dir) break;
	}
	let charset: FileEncoding | undefined;
	for (const config of files) {
		let matches = false;
		for (const line of readFileSync(config, "utf-8").split(/\r?\n/)) {
			const section = /^\s*\[(.*)\]\s*$/.exec(line);
			if (section) { matches = editorconfigPattern(section[1])?.test(basename(file)) ?? false; continue; }
			const value = /^\s*charset\s*=\s*(\S+)\s*$/i.exec(line);
			if (matches && value && EDITORCONFIG_CHARSET[value[1].toLowerCase()]) charset = EDITORCONFIG_CHARSET[value[1].toLowerCase()];
		}
	}
	return charset;
}

/** 확장자가 같은 파일 중 인코딩을 알 수 있는 것만 센다(영문만 있는 BOM 없는 파일은 근거가 아님). */
export function neighborEncodings(dir: string, ext: string, exclude?: string): Map<FileEncoding, number> {
	const counts = new Map<FileEncoding, number>();
	let entries: string[] = [];
	try { entries = readdirSync(dir); } catch { return counts; }
	let seen = 0;
	for (const name of entries) {
		if (extname(name).toLowerCase() !== ext || join(dir, name) === exclude) continue;
		if (++seen > MAX_NEIGHBORS) break;
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			if (!stat.isFile() || stat.size > MAX_SAMPLE_BYTES) continue;
			const bytes = readFileSync(path);
			const detected = detectEncoding(bytes);
			if (detected === "empty" || detected === "binary" || detected === "unknown") continue;
			if (detected === "utf8" && isAscii(bytes.toString("latin1"))) continue;
			counts.set(detected, (counts.get(detected) ?? 0) + 1);
		} catch { /* 읽을 수 없는 파일은 근거에서 뺀다 */ }
	}
	return counts;
}

/** 새 파일: .editorconfig → 같은 확장자의 주변 파일(가까운 폴더부터 root까지) → 형식별 기본값. */
export function chooseNewFileEncoding(file: string, text: string, root: string): Choice {
	const ext = extname(file).toLowerCase();
	const finish = (choice: Choice): Choice => {
		// PowerShell 5.1은 BOM 없는 스크립트를 CP949로 읽어 한글이 깨진다.
		if (POWERSHELL.has(ext) && choice.encoding === "utf8" && !isAscii(text)) return { encoding: "utf8-bom", reason: `${choice.reason}, PowerShell 5.1용 BOM 추가` };
		return choice;
	};
	const configured = editorconfigCharset(file);
	if (configured) return finish({ encoding: configured, reason: ".editorconfig" });
	if (ext) {
		const inside = relative(root, file);
		const top = inside && !inside.startsWith("..") && !isAbsolute(inside) ? resolve(root) : dirname(file);
		for (let dir = dirname(file); ; dir = dirname(dir)) {
			const counts = neighborEncodings(dir, ext, file);
			if (counts.size) {
				const [encoding, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
				const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
				const where = dir === dirname(file) ? "같은 폴더" : `${relative(root, dir) || "."}${sep}`;
				return finish({ encoding, reason: `${where}의 ${ext} 파일 ${total}개 중 ${count}개` });
			}
			if (dir === top || dirname(dir) === dir) break;
		}
	}
	return finish(BOM_DEFAULT.has(ext) ? { encoding: "utf8-bom", reason: "기본값" } : { encoding: "utf8", reason: "기본값" });
}

/** 원본이 CRLF 위주인데 새 내용이 LF뿐이면 CRLF로 맞춘다(write로 덮어쓸 때 줄바꿈 전체가 바뀌지 않게). */
export function matchLineEndings(original: string, text: string): string {
	const crlf = (original.match(/\r\n/g) ?? []).length;
	const lf = (original.match(/\n/g) ?? []).length - crlf;
	if (crlf > lf && !text.includes("\r\n")) return text.replace(/\n/g, "\r\n");
	return text;
}

// /encodings ------------------------------------------------------------------

const SKIP_DIRS = new Set([".git", ".svn", ".hg", ".vs", ".vscode", ".idea", ".pi", "node_modules", "bin", "obj", "out", "build", "Debug", "Release", "x64", "x86", "packages", "__pycache__"]);
const MAX_SCAN_FILES = 20000;

export type ScanResult = { files: number; truncated: boolean; byExt: Map<string, Map<string, number>>; unknown: string[] };

/** 프로젝트의 확장자별 인코딩 분포. 영문만 있는 BOM 없는 파일은 "ASCII"로 따로 센다. */
export function scanEncodings(root: string): ScanResult {
	const result: ScanResult = { files: 0, truncated: false, byExt: new Map(), unknown: [] };
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: import("node:fs").Dirent[] = [];
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) stack.push(path); continue; }
			if (!entry.isFile()) continue;
			if (result.files >= MAX_SCAN_FILES) { result.truncated = true; return result; }
			let bytes: Buffer;
			try {
				if (statSync(path).size > MAX_SAMPLE_BYTES) continue;
				bytes = readFileSync(path);
			} catch { continue; }
			const detected = detectEncoding(bytes);
			if (detected === "binary" || detected === "empty") continue;
			result.files++;
			const label = detected === "unknown" ? "판별 불가" : detected === "utf8" && isAscii(bytes.toString("latin1")) ? "ASCII" : ENCODING_LABELS[detected];
			if (detected === "unknown") result.unknown.push(relative(root, path));
			const ext = extname(entry.name).toLowerCase() || "(확장자 없음)";
			const counts = result.byExt.get(ext) ?? new Map<string, number>();
			counts.set(label, (counts.get(label) ?? 0) + 1);
			result.byExt.set(ext, counts);
		}
	}
	return result;
}

export function formatScan(root: string, scan: ScanResult): string {
	const rows = [...scan.byExt].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))
		.map(([ext, counts]) => `${ext.padEnd(10)} ${[...counts].sort((a, b) => b[1] - a[1]).map(([label, count]) => `${label} ${count}`).join(" · ")}`);
	const lines = [`인코딩 현황: ${root} (텍스트 파일 ${scan.files}개${scan.truncated ? `, ${MAX_SCAN_FILES}개에서 멈춤` : ""})`, ...rows];
	if (scan.unknown.length) lines.push(`판별 불가 ${scan.unknown.length}개 (edit·write가 수정하지 않음): ${scan.unknown.slice(0, 10).join(", ")}${scan.unknown.length > 10 ? " …" : ""}`);
	lines.push("ASCII = 영문만 있어 UTF-8·CP949 구분이 필요 없는 파일. 새 파일은 같은 확장자의 주변 파일 인코딩을 따릅니다.");
	return lines.join("\n");
}
