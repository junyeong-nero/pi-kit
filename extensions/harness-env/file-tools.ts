// pi의 read·edit·write에서 파일 입출력만 바꾼다. 스키마·설명·렌더링·변경 큐는 pi 것을 그대로 쓴다.
// 모델은 항상 UTF-8 텍스트를 보고, 디스크에는 원래 인코딩·BOM으로 저장한다. 새 파일은 주변 파일의 인코딩을 따른다.
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
	createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, detectSupportedImageMimeTypeFromFile,
	type EditOperations, type ReadOperations, type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
	chooseNewFileEncoding, decodeText, detectEncoding, ENCODING_LABELS, encodeText, EncodingError,
	matchLineEndings, undecidableMessage, type FileEncoding,
} from "./encoding.ts";

async function readIfExists(path: string): Promise<Buffer | undefined> {
	try { return await readFile(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** UTF-8이 아닌 텍스트 파일을 UTF-8로 바꿔 돌려준다. 바이너리·판별 불가 파일은 원본 그대로 둔다. */
export async function readAsUtf8(path: string): Promise<Buffer> {
	const bytes = await readFile(path);
	const detected = detectEncoding(bytes);
	if (detected === "utf16le" || detected === "utf16be" || detected === "cp949") return Buffer.from(decodeText(bytes, detected), "utf-8");
	return bytes;
}

type Note = (note: string) => void;

/** 저장할 인코딩을 정해 쓴다. 기존 파일은 원래 인코딩, 비었거나 없는 파일은 새 파일 규칙을 따른다. */
export async function writeKeepingEncoding(path: string, content: string, root: string, note: Note, overwrite: boolean): Promise<void> {
	const existing = await readIfExists(path);
	const detected = existing ? detectEncoding(existing) : "empty";
	let encoding: FileEncoding;
	let text = content;
	if (detected === "empty") {
		const choice = chooseNewFileEncoding(path, content, root);
		encoding = choice.encoding;
		if (encoding !== "utf8") note(`${ENCODING_LABELS[encoding]}로 저장 (${choice.reason})`);
	} else if (detected === "binary" || detected === "unknown") {
		throw new EncodingError(undecidableMessage(path, detected));
	} else {
		encoding = detected;
		// write는 파일 전체를 바꾸므로 원래 줄바꿈도 맞춘다. edit는 pi가 이미 맞춰서 넘긴다.
		if (overwrite) text = matchLineEndings(decodeText(existing!, detected), content);
		if (encoding !== "utf8") note(`원래 인코딩 ${ENCODING_LABELS[encoding]} 유지`);
	}
	await writeFile(path, encodeText(text, encoding));
}

type Definition = { execute: (...args: any[]) => Promise<{ content: { type: string; text?: string }[] }> };
/** 호출마다 따로: 동시에 실행된 다른 도구 호출의 메모가 섞이지 않고, 새 파일 판단은 그 세션의 작업 폴더를 기준으로 한다. */
type Call = { root: string; notes: string[] };
const calls = new AsyncLocalStorage<Call>();

/** UTF-8이면 아무것도 붙이지 않아 컨텍스트를 늘리지 않는다. */
function withNotes<T extends Definition>(definition: T, cwd: string): T {
	return {
		...definition,
		async execute(...args: any[]) {
			const call: Call = { root: args[4]?.cwd || cwd, notes: [] };
			const result = await calls.run(call, () => definition.execute(...args));
			const first = result.content.find((block) => block.type === "text");
			if (call.notes.length && first) first.text = `${first.text} [${call.notes.join("; ")}]`;
			return result;
		},
	};
}

function writeOp(cwd: string, overwrite: boolean) {
	return (path: string, content: string) => {
		const call = calls.getStore();
		return writeKeepingEncoding(path, content, call?.root ?? cwd, (note) => call?.notes.push(note), overwrite);
	};
}

export function createEncodingAwareTools(cwd: string) {
	const readOps: ReadOperations = {
		readFile: readAsUtf8,
		access: (path) => access(path, constants.R_OK),
		detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	};
	const editOps: EditOperations = {
		async readFile(path) {
			const bytes = await readFile(path);
			const detected = detectEncoding(bytes);
			if (detected === "binary" || detected === "unknown") throw new EncodingError(undecidableMessage(path, detected));
			if (detected === "utf16le" || detected === "utf16be") return Buffer.from(`\uFEFF${decodeText(bytes, detected)}`, "utf-8");
			if (detected === "cp949") return Buffer.from(decodeText(bytes, detected), "utf-8");
			return bytes;
		},
		writeFile: writeOp(cwd, false),
		access: (path) => access(path, constants.R_OK | constants.W_OK),
	};
	const writeOps: WriteOperations = {
		writeFile: writeOp(cwd, true),
		mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
	};
	return {
		read: createReadToolDefinition(cwd, { operations: readOps }),
		edit: withNotes(createEditToolDefinition(cwd, { operations: editOps }), cwd),
		write: withNotes(createWriteToolDefinition(cwd, { operations: writeOps }), cwd),
	};
}
