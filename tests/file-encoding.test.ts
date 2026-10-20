import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import iconv from "iconv-lite";
import { chooseNewFileEncoding, decodeCp949, detectEncoding, encodeCp949, scanEncodings } from "../extensions/harness-env/encoding.ts";
import { createEncodingAwareTools } from "../extensions/harness-env/file-tools.ts";

const cp949 = (text: string) => iconv.encode(text, "cp949");
const bom = (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);

function project(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "인코딩 test "));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const tools = createEncodingAwareTools(root);
	const ctx = { cwd: root } as any;
	const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((block) => block.text ?? "").join("");
	return {
		root,
		read: async (path: string) => text(await tools.read.execute("t", { path }, undefined, undefined, ctx)),
		edit: async (path: string, oldText: string, newText: string) => text(await tools.edit.execute("t", { path, edits: [{ oldText, newText }] }, undefined, undefined, ctx)),
		write: async (path: string, content: string) => text(await tools.write.execute("t", { path, content }, undefined, undefined, ctx)),
	};
}

test("CP949 table decoding and encoding match iconv-lite for every one- and two-byte code", () => {
	let mapped = 0;
	for (let code = 0; code <= 0xffff; code++) {
		if (code > 0xff && code < 0x8100) continue;
		const bytes = code > 0xff ? Buffer.from([code >> 8, code & 0xff]) : Buffer.from([code]);
		const reference = iconv.decode(bytes, "cp949");
		const valid = !reference.includes("\uFFFD") && iconv.encode(reference, "cp949").equals(bytes);
		const ours = decodeCp949(bytes);
		if (code > 0xff && ours !== undefined && ours.length === 2 && !valid) continue; // two single-byte characters
		assert.equal(ours, valid ? reference : undefined, `0x${code.toString(16)}`);
		if (ours === undefined) continue;
		mapped++;
		assert.deepEqual(encodeCp949(ours), iconv.encode(ours, "cp949"), `encode 0x${code.toString(16)}`);
	}
	assert.ok(mapped > 17000, `${mapped} CP949 codes`);
	assert.equal(encodeCp949("한글 😀"), "😀");
});

test("detects UTF-8, BOMs, UTF-16, CP949, binary and undecidable bytes", () => {
	assert.equal(detectEncoding(Buffer.from("int main() {}\n")), "utf8");
	assert.equal(detectEncoding(Buffer.from("// 한글\n")), "utf8");
	assert.equal(detectEncoding(bom("// 한글\n")), "utf8-bom");
	assert.equal(detectEncoding(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("한글", "utf16le")])), "utf16le");
	assert.equal(detectEncoding(cp949("// 한글 주석, 똠방각하\r\n")), "cp949");
	assert.equal(detectEncoding(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), "binary");
	assert.equal(detectEncoding(Buffer.from([0x61, 0x80, 0x62])), "unknown");
	assert.equal(detectEncoding(Buffer.alloc(0)), "empty");
});

test("edit keeps CP949 bytes, CRLF and every untouched Korean line", async (t) => {
	const p = project(t);
	const file = join(p.root, "main.cpp");
	writeFileSync(file, cp949("// 한글 주석\r\nint a = 1;\r\n// 끝\r\n"));
	assert.match(await p.read(file), /한글 주석/);
	assert.match(await p.edit(file, "int a = 1;", "int a = 2; // 수정"), /CP949 유지/);
	assert.deepEqual(readFileSync(file), cp949("// 한글 주석\r\nint a = 2; // 수정\r\n// 끝\r\n"));
});

test("edit keeps UTF-8 BOM and UTF-16 LE; plain UTF-8 results carry no extra note", async (t) => {
	const p = project(t);
	const withBom = join(p.root, "a.cs");
	writeFileSync(withBom, bom("// 한글\nclass A {}\n"));
	await p.edit(withBom, "class A {}", "class B {}");
	assert.deepEqual(readFileSync(withBom), bom("// 한글\nclass B {}\n"));
	const utf16 = join(p.root, "app.rc");
	writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("CAPTION \"한글\"\r\n", "utf16le")]));
	assert.match(await p.read(utf16), /CAPTION "한글"/);
	await p.edit(utf16, "한글", "제목");
	assert.deepEqual(readFileSync(utf16), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("CAPTION \"제목\"\r\n", "utf16le")]));
	const plain = join(p.root, "notes.md");
	writeFileSync(plain, "# 제목\n");
	assert.doesNotMatch(await p.edit(plain, "제목", "목차"), /\[/);
});

test("characters CP949 cannot store are rejected and the file stays unchanged", async (t) => {
	const p = project(t);
	const file = join(p.root, "main.cpp");
	const original = cp949("// 한글\r\n");
	writeFileSync(file, original);
	await assert.rejects(p.edit(file, "한글", "한글 😀"), /U\+1F600/);
	assert.deepEqual(readFileSync(file), original);
});

test("undecidable files are read as-is but never rewritten", async (t) => {
	const p = project(t);
	const file = join(p.root, "legacy.txt");
	const original = Buffer.from([0x61, 0x80, 0x62, 0x0a]);
	writeFileSync(file, original);
	await p.read(file);
	await assert.rejects(p.edit(file, "a", "b"), /인코딩을 판별할 수 없어/);
	await assert.rejects(p.write(file, "b\n"), /인코딩을 판별할 수 없어/);
	assert.deepEqual(readFileSync(file), original);
});

test("write overwriting a CP949 CRLF file keeps its encoding and line endings", async (t) => {
	const p = project(t);
	const file = join(p.root, "main.cpp");
	writeFileSync(file, cp949("// 이전\r\n"));
	await p.write(file, "// 새 내용\nint b;\n");
	assert.deepEqual(readFileSync(file), cp949("// 새 내용\r\nint b;\r\n"));
});

test("new files follow neighbours with the same extension, then .editorconfig, then defaults", async (t) => {
	const p = project(t);
	writeFileSync(join(p.root, "old.cpp"), cp949("// 기존 한글\r\n"));
	writeFileSync(join(p.root, "ascii.cpp"), "int x;\n");
	assert.match(await p.write(join(p.root, "new.cpp"), "// 새 한글\n"), /CP949로 저장 \(같은 폴더의 \.cpp 파일 1개 중 1개\)/);
	assert.deepEqual(readFileSync(join(p.root, "new.cpp")), cp949("// 새 한글\n"));
	// A deeper folder without .cpp evidence uses the project folder's files.
	assert.equal(chooseNewFileEncoding(join(p.root, "src", "deep", "x.cpp"), "// 한글", p.root).encoding, "cp949");

	await p.write(join(p.root, "run.ps1"), "Write-Output '한글'\n");
	assert.deepEqual(readFileSync(join(p.root, "run.ps1")), bom("Write-Output '한글'\n"));
	assert.doesNotMatch(await p.write(join(p.root, "tool.py"), "print('한글')\n"), /\[/);
	assert.deepEqual(readFileSync(join(p.root, "tool.py")), Buffer.from("print('한글')\n"));
	assert.deepEqual(readFileSync(join(p.root, "tool.py")).subarray(0, 3), Buffer.from("pri"));

	writeFileSync(join(p.root, ".editorconfig"), "root = true\n[*.{txt,md}]\ncharset = utf-8-bom\n");
	await p.write(join(p.root, "readme.txt"), "한글\n");
	assert.deepEqual(readFileSync(join(p.root, "readme.txt")), bom("한글\n"));
});

test("scan reports encodings per extension and lists undecidable files", (t) => {
	const p = project(t);
	writeFileSync(join(p.root, "a.cpp"), cp949("// 한글\r\n"));
	writeFileSync(join(p.root, "b.cpp"), "int b;\n");
	writeFileSync(join(p.root, "c.txt"), Buffer.from([0x61, 0x80]));
	const scan = scanEncodings(p.root);
	assert.deepEqual(Object.fromEntries(scan.byExt.get(".cpp")!), { CP949: 1, ASCII: 1 });
	assert.deepEqual(scan.unknown, ["c.txt"]);
});
