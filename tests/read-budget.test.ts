import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import readBudget, { budgetedLimit, linesWithinBudget, MIN_LINES, NOTE, readBudgetBytes } from "../extensions/read-budget/index.ts";

function project(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "read-budget 한글 "));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
const lines = (count: number, width = 79) => Array.from({ length: count }, (_, i) => `${i}`.padEnd(width, "x")).join("\n") + "\n";

test("budget follows the context window and the remaining room", () => {
	assert.equal(readBudgetBytes(undefined, 0), undefined);
	assert.equal(readBudgetBytes(0, 0), undefined);
	assert.equal(readBudgetBytes(32768, 0), Math.floor(32768 * 0.15 * 3));
	assert.equal(readBudgetBytes(32768, null), Math.floor(32768 * 0.15 * 3), "unknown usage right after compaction");
	assert.equal(readBudgetBytes(131072, 131072 * 0.8), Math.floor(131072 * 0.2 * 0.25 * 3));
	assert.equal(readBudgetBytes(32768, 40000), 0, "over-full context still yields a number");
	assert.ok(readBudgetBytes(131072, 0)! > readBudgetBytes(32768, 0)!);
});

test("lines that fit the budget, with a floor and no trim when the rest fits", () => {
	const text = lines(1000); // 80 bytes per line
	assert.equal(linesWithinBudget(text, undefined, 8000), 100);
	assert.equal(linesWithinBudget(text, 951, 8000), undefined, "the remaining 50 lines fit");
	assert.equal(linesWithinBudget(text, undefined, 10), MIN_LINES);
	assert.equal(linesWithinBudget(lines(30), undefined, 10), undefined, "floor covers the whole file");
	assert.equal(linesWithinBudget(text, 5000, 8000), undefined, "out-of-range offset is left to read");
});

test("limit is set for large files and kept when the caller already budgets", async (t) => {
	const dir = project(t);
	writeFileSync(join(dir, "big.cpp"), lines(1000));
	writeFileSync(join(dir, "small.cpp"), lines(10));
	assert.equal(await budgetedLimit({ path: "big.cpp" }, dir, 8000), 100);
	assert.equal(await budgetedLimit({ path: "@big.cpp", offset: 500 }, dir, 8000), 100);
	assert.equal(await budgetedLimit({ path: join(dir, "big.cpp"), limit: 5000 }, dir, 8000), 100, "oversized explicit limit is reduced");
	assert.equal(await budgetedLimit({ path: "big.cpp", limit: 50 }, dir, 8000), undefined, "smaller explicit limit is kept");
	assert.equal(await budgetedLimit({ path: "small.cpp" }, dir, 8000), undefined);
	assert.equal(await budgetedLimit({ path: "missing.cpp" }, dir, 8000), undefined);
	assert.equal(await budgetedLimit({ path: "." }, dir, 8000), undefined);
	assert.equal(await budgetedLimit({}, dir, 8000), undefined);
});

test("legacy encodings are measured as the UTF-8 text the model receives; binaries are skipped", async (t) => {
	const dir = project(t);
	const text = Array.from({ length: 400 }, (_, i) => `// 줄 ${String(i).padStart(3, "0")} 한글 주석입니다`).join("\r\n");
	writeFileSync(join(dir, "utf16.cs"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
	const utf8Bytes = Buffer.byteLength(text.split("\n")[0], "utf-8") + 1;
	assert.equal(await budgetedLimit({ path: "utf16.cs" }, dir, utf8Bytes * 100), 100);
	writeFileSync(join(dir, "data.bin"), Buffer.alloc(100000, 0));
	writeFileSync(join(dir, "shot.png"), Buffer.alloc(100000, 65));
	assert.equal(await budgetedLimit({ path: "data.bin" }, dir, 1000), undefined);
	assert.equal(await budgetedLimit({ path: "shot.png" }, dir, 1000), undefined);
});

test("extension rewrites read input in place and notes the trim on the result", async (t) => {
	const dir = project(t);
	writeFileSync(join(dir, "big.cpp"), lines(5000));
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	readBudget({ on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	const ctx = (contextWindow: number | undefined, tokens: number | null) => ({ cwd: dir, model: contextWindow ? { contextWindow } : undefined, getContextUsage: () => ({ tokens }) });

	const input: Record<string, unknown> = { path: "big.cpp" };
	assert.equal(await handlers.get("tool_call")!({ toolName: "read", toolCallId: "1", input }, ctx(32768, 0)), undefined, "never blocks");
	const expected = Math.floor(32768 * 0.15 * 3 / 80);
	assert.equal(input.limit, expected);
	const result = handlers.get("tool_result")!({ toolCallId: "1", isError: false, content: [{ type: "text", text: "body" }] }, ctx(32768, 0));
	assert.equal(result.content.at(-1).text, `\n${NOTE(expected)}`);
	assert.equal(handlers.get("tool_result")!({ toolCallId: "1", isError: false, content: [] }, ctx(32768, 0)), undefined, "noted once");

	const late: Record<string, unknown> = { path: "big.cpp" };
	await handlers.get("tool_call")!({ toolName: "read", toolCallId: "2", input: late }, ctx(32768, 30000));
	assert.ok((late.limit as number) < expected, "less room later in the session reads fewer lines");

	const unknownModel: Record<string, unknown> = { path: "big.cpp" };
	await handlers.get("tool_call")!({ toolName: "read", toolCallId: "3", input: unknownModel }, ctx(undefined, 0));
	assert.equal(unknownModel.limit, undefined);
	const other: Record<string, unknown> = { path: "big.cpp" };
	await handlers.get("tool_call")!({ toolName: "grep", toolCallId: "4", input: other }, ctx(32768, 0));
	assert.equal(other.limit, undefined);
	assert.equal(handlers.get("tool_result")!({ toolCallId: "4", isError: false, content: [] }, ctx(32768, 0)), undefined);
});
