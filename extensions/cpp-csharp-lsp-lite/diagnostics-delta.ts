// 수정 전후 LSP 오류 수를 비교해 "이번 수정으로 늘어난/줄어든 오류"를 계산한다.
import type { Diagnostic } from "./lsp-client.ts";

const ERROR = 1;

export function errorsOf(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics.filter((d) => (d.severity ?? 3) === ERROR);
}

// 수정으로 줄 번호가 밀리므로 위치를 빼고 source+message로 같은 오류인지 판단한다.
function keyOf(d: Diagnostic): string {
	return `${d.source ?? ""}\u0000${d.message}`;
}

export interface DiagnosticsDelta {
	before: number;
	after: number;
	change: number;
	introduced: Diagnostic[];
}

export function computeDelta(before: Diagnostic[], after: Diagnostic[]): DiagnosticsDelta {
	const b = errorsOf(before);
	const a = errorsOf(after);
	const remaining = new Map<string, number>();
	for (const d of b) remaining.set(keyOf(d), (remaining.get(keyOf(d)) ?? 0) + 1);
	const introduced: Diagnostic[] = [];
	for (const d of a) {
		const left = remaining.get(keyOf(d)) ?? 0;
		if (left > 0) remaining.set(keyOf(d), left - 1);
		else introduced.push(d);
	}
	return { before: b.length, after: a.length, change: a.length - b.length, introduced };
}

export function deltaHeadline(delta: DiagnosticsDelta | undefined): string {
	if (!delta) return "이번 수정 전 진단 기록이 없어 오류 증감을 알 수 없음";
	if (delta.change > 0) return `이번 수정으로 오류 ${delta.change}개 증가 (${delta.before} -> ${delta.after})`;
	if (delta.change < 0) return `이번 수정으로 오류 ${-delta.change}개 감소 (${delta.before} -> ${delta.after})`;
	return `오류 수 변화 없음 (${delta.after}개)`;
}
