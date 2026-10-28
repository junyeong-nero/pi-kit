// 큰 파일을 통째로 read하지 않도록, 모델의 컨텍스트 창과 남은 여유에 맞춰 read의 limit을 자동으로 줄이는 확장.
// 호출을 막지 않으므로 모델이 다시 호출할 필요가 없다. 이어 읽을 offset은 pi의 read가 결과 끝에 안내한다.
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeText, detectEncoding } from "../harness-env/encoding.ts";

export const WINDOW_SHARE = 0.15; // 한 번에 읽을 양: 전체 컨텍스트 창의 15%
export const REMAINING_SHARE = 0.25; // 그리고 남은 여유의 25% 중 작은 값
export const BYTES_PER_TOKEN = 3; // 코드 기준 보수적 추정
export const MIN_LINES = 40; // 컨텍스트가 거의 찼어도 이만큼은 읽게 한다

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".pdf"]);

/** 이번 read에 쓸 수 있는 UTF-8 바이트 수. 모델 정보가 없으면 undefined(제한 없음). */
export function readBudgetBytes(contextWindow: number | undefined, usedTokens: number | null | undefined): number | undefined {
	if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	const remaining = Math.max(0, contextWindow - (usedTokens ?? 0));
	return Math.floor(Math.min(contextWindow * WINDOW_SHARE, remaining * REMAINING_SHARE) * BYTES_PER_TOKEN);
}

/** offset(1부터)부터 budget 바이트 안에 들어가는 줄 수. 남은 줄이 모두 들어가면 undefined. */
export function linesWithinBudget(text: string, offset: number | undefined, budget: number): number | undefined {
	const lines = text.split("\n");
	const start = offset ? Math.max(0, offset - 1) : 0;
	if (start >= lines.length) return undefined; // 범위 밖 offset은 pi가 오류로 알려 준다
	let bytes = 0;
	for (let i = start; i < lines.length; i++) {
		bytes += Buffer.byteLength(lines[i], "utf-8") + 1;
		if (bytes <= budget) continue;
		const fit = Math.max(MIN_LINES, i - start);
		return start + fit < lines.length ? fit : undefined;
	}
	return undefined;
}

type ReadInput = { path?: unknown; offset?: unknown; limit?: unknown };

/** read 입력에 넣을 limit. 바꿀 필요가 없으면 undefined. */
export async function budgetedLimit(input: ReadInput, cwd: string, budget: number): Promise<number | undefined> {
	if (typeof input.path !== "string" || !input.path.trim()) return undefined;
	const raw = input.path.trim().replace(/^@/, "");
	if (IMAGE_EXTENSIONS.has(extname(raw).toLowerCase())) return undefined;
	const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch {
		return undefined; // 없는 파일·디렉터리 오류는 read가 그대로 알려 준다
	}
	if (bytes.length <= budget) return undefined;
	const encoding = detectEncoding(bytes);
	if (encoding === "binary" || encoding === "unknown" || encoding === "empty") return undefined;
	// harness-env의 read처럼 UTF-8로 바꾼 뒤 모델이 실제로 받을 크기로 계산한다.
	const text = encoding === "utf8" ? bytes.toString("utf-8") : decodeText(bytes, encoding);
	const offset = typeof input.offset === "number" ? input.offset : undefined;
	const fit = linesWithinBudget(text, offset, budget);
	if (fit === undefined) return undefined;
	const requested = typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;
	return requested !== undefined && requested <= fit ? undefined : fit;
}

export const NOTE = (lines: number) =>
	`[read-budget: 컨텍스트 여유에 맞춰 ${lines}줄만 읽었다. 필요한 부분은 rg·find_symbol로 위치를 찾은 뒤 offset·limit으로 읽어라.]`;

export default function (pi: ExtensionAPI) {
	const trimmed = new Map<string, number>();

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (event.toolName !== "read") return;
		try {
			const budget = readBudgetBytes(ctx.model?.contextWindow, ctx.getContextUsage()?.tokens);
			if (budget === undefined) return;
			const input = event.input as ReadInput;
			const limit = await budgetedLimit(input, ctx.cwd, budget);
			if (limit === undefined) return;
			input.limit = limit; // pi는 tool_call에서 바꾼 입력을 그대로 실행한다
			trimmed.set(event.toolCallId, limit);
		} catch {
			// 계산 실패로 정상적인 read를 막지 않는다.
		}
	});

	pi.on("tool_result", (event) => {
		const lines = trimmed.get(event.toolCallId);
		if (lines === undefined) return;
		trimmed.delete(event.toolCallId);
		if (event.isError) return;
		return { content: [...event.content, { type: "text" as const, text: `\n${NOTE(lines)}` }] };
	});
}
