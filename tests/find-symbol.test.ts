import test from "node:test";
import assert from "node:assert/strict";
import { formatFallback, formatFound, parseRgLine, rgSearch, MAX_REFS } from "../extensions/cpp-csharp-lsp-lite/find-symbol.ts";

test("parseRgLine handles posix and Windows paths", () => {
	assert.deepEqual(parseRgLine("src/a.cpp:2:5:  int add(1)"), { path: "src/a.cpp", line: 1, character: 4, text: "int add(1)" });
	assert.deepEqual(parseRgLine("C:\\p\\a.cs:10:3:x: y"), { path: "C:\\p\\a.cs", line: 9, character: 2, text: "x: y" });
	assert.equal(parseRgLine("garbage"), undefined);
});

test("formatFound caps references with 외 N개", () => {
	const refs = Array.from({ length: MAX_REFS + 5 }, (_, i) => `a.cpp:${i + 1}:1`);
	const out = formatFound("add", "a.cpp:1:5", refs).split("\n");
	assert.equal(out[1], "정의: a.cpp:1:5");
	assert.equal(out.at(-1), "외 5개");
	assert.equal(out.length, 3 + MAX_REFS + 1);
	assert.ok(!formatFound("add", "a.cpp:1:5", ["x"]).includes("외 "));
});

test("formatFallback states the fallback and handles missing rg", () => {
	const hit = { path: "a.cpp", line: 0, character: 0, text: "add" };
	assert.match(formatFallback("add", "LSP 오류", [hit], (h) => h.path), /텍스트 검색\(rg\)/);
	assert.match(formatFallback("add", "x", undefined, () => ""), /rg를 실행할 수 없어/);
	assert.match(formatFallback("add", "x", [], () => ""), /일치하는 위치가 없다/);
});

test("rgSearch resolves undefined when rg is missing", async () => {
	assert.equal(await rgSearch("definitely-not-rg-binary", process.cwd(), "x", "."), undefined);
});
