import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDelta, deltaHeadline } from "../extensions/cpp-csharp-lsp-lite/diagnostics-delta.ts";

const err = (message: string, line = 0) => ({ range: { start: { line, character: 0 }, end: { line, character: 1 } }, severity: 1, source: "clangd", message });
const warn = (message: string) => ({ ...err(message), severity: 2 });

test("오류 증가: 새 오류만 introduced", () => {
	const d = computeDelta([err("a", 1)], [err("a", 5), err("b", 6)]);
	assert.equal(d.change, 1);
	assert.deepEqual(d.introduced.map((x) => x.message), ["b"]);
	assert.match(deltaHeadline(d), /^이번 수정으로 오류 1개 증가/);
});

test("오류 감소와 변화 없음", () => {
	assert.match(deltaHeadline(computeDelta([err("a"), err("b")], [err("a")])), /^이번 수정으로 오류 1개 감소/);
	assert.match(deltaHeadline(computeDelta([err("a")], [err("a", 9)])), /^오류 수 변화 없음/);
});

test("경고는 세지 않고 같은 메시지 중복은 개수로 비교", () => {
	assert.equal(computeDelta([], [warn("w")]).change, 0);
	const d = computeDelta([err("a")], [err("a"), err("a", 3)]);
	assert.equal(d.change, 1);
	assert.equal(d.introduced.length, 1);
});

test("기준선이 없으면 추측하지 않는다", () => {
	assert.match(deltaHeadline(undefined), /알 수 없음/);
});
