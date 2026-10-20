// 소스 파일을 수정한 뒤 빌드/진단 없이 실행을 끝내지 못하게 하고, 빌드·테스트 실패가 남은 채 끝내지 못하게 하는 확장.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EDIT_TOOLS = new Set(["edit", "write"]);
export const MAX_FORCED = 2; // 검증 미실행 알림으로 이어가는 최대 횟수
export const MAX_TOTAL_FORCED = 5; // 사용자 프롬프트당 강제 이어가기 총 상한(빌드 실패 재시도 포함)
const MAX_ERROR_LINES = 5;
const MAX_LINE_LENGTH = 300;

export const REMINDER =
	"파일을 수정한 뒤 검증하지 않았다. 완료라고 보고하기 전에 빌드/테스트(powershell) 또는 lsp_diagnostics를 실행하고 결과를 확인하라.";

// 휴리스틱: 명령에 빌드·테스트 도구 이름이 단어로 들어 있으면 빌드로 본다. ls, git 같은 일반 명령의 실패는 빌드 실패로 세지 않는다.
const BUILD_COMMAND =
	/(?:^|[\s;&|(`'"\\/])(?:msbuild|dotnet(?:\.exe)?\s+(?:build|test|publish|msbuild|pack|run)|nmake|ninja|make|mingw32-make|cmake|ctest|cl|clang|clang\+\+|clang-cl|gcc|g\+\+|devenv|vstest\.console|nuget\s+restore|cargo\s+(?:build|test)|go\s+(?:build|test)|npm\s+(?:run\s+)?(?:build|test)|tsc)(?:\.exe)?(?=$|[\s;&|)`'"])/i;

// 컴파일러·테스트 오류 줄: error CS1234 / error C2065 / ': error:' / fatal error / CMake Error / FAILED / LNK1234 등.
const ERROR_LINE =
	/\berror\s+[A-Za-z]{1,4}\d{2,5}\b|:\s*(?:fatal\s+)?error\b|\bfatal error\b|^\s*CMake Error\b|\bFAILED\b|^\s*Failed\s+\S|\bAssertion\b.*\bfailed\b|\bundefined reference\b|\bLNK\d{4}\b/i;

// 빌드·진단으로 확인할 수 있는 파일만 검증 대상으로 본다. 문서·설정·데이터 수정은 강제 검증하지 않는다.
// C/C++/C# 소스와 이를 빌드하는 프로젝트 파일이다. 경로를 알 수 없으면 안전하게 검증 대상으로 본다.
const VERIFIABLE_PATH =
	/\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|inl|ipp|tpp|cs|csx|csproj|vcxproj|sln|slnx|props|targets|cmake|mk)$|(?:^|[\\/])(?:CMakeLists\.txt|Makefile|GNUmakefile)$/i;

export function needsVerification(path: unknown): boolean {
	if (typeof path !== "string" || !path.trim()) return true;
	return VERIFIABLE_PATH.test(path.trim().replace(/^@/, ""));
}

export function isBuildCommand(command: unknown): boolean {
	return typeof command === "string" && BUILD_COMMAND.test(command);
}

/** 출력에서 첫 오류 줄 몇 개를 뽑는다. 패턴이 없으면 마지막 비어 있지 않은 줄 몇 개로 대체한다. */
export function extractErrors(output: string): string[] {
	const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const seen = new Set<string>();
	const found: string[] = [];
	for (const line of lines) {
		if (!ERROR_LINE.test(line) || seen.has(line)) continue;
		seen.add(line);
		found.push(line);
		if (found.length >= MAX_ERROR_LINES) break;
	}
	const picked = found.length ? found : lines.slice(-3);
	return picked.map((l) => (l.length > MAX_LINE_LENGTH ? `${l.slice(0, MAX_LINE_LENGTH)}...` : l));
}

function textOf(content: readonly { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

export function buildRetryReminder(errors: string[]): string {
	return `빌드/테스트가 실패한 상태다. 완료라고 보고하지 말고 아래 첫 오류를 수정한 뒤 다시 빌드/테스트하라.\n${errors.map((e) => `- ${e}`).join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	let unverified = false;
	let edited = false;
	let buildErrors: string[] | undefined; // 수정 후 마지막 빌드가 실패했으면 그 오류 요약
	let forced = 0;

	// agent_start는 강제로 이어가는 턴에서도 다시 발생하므로, 사용자 프롬프트마다 한 번 오는 이벤트에서 초기화한다.
	// 확장이 시작한 실행(하위 에이전트 결과 알림 등)도 before_agent_start를 거치므로 사용자 프롬프트만 센다.
	pi.on("before_agent_start", (event) => {
		if (event.messageType !== "user") return;
		unverified = false;
		edited = false;
		buildErrors = undefined;
		forced = 0;
	});

	pi.on("tool_result", (event) => {
		if (EDIT_TOOLS.has(event.toolName) && !event.isError) {
			if (!needsVerification((event.input as { path?: unknown } | undefined)?.path)) return;
			unverified = true;
			edited = true;
		} else if (event.toolName === "lsp_diagnostics") {
			unverified = false;
		} else if (event.toolName === "powershell") {
			unverified = false;
			if (!isBuildCommand((event.input as { command?: unknown } | undefined)?.command)) return;
			if (!event.isError) {
				buildErrors = undefined;
				return;
			}
			const errors = extractErrors(textOf(event.content));
			if (edited) buildErrors = errors;
			return { content: [{ type: "text", text: `[빌드/테스트 실패 요약]\n${errors.join("\n")}\n\n` }, ...event.content] };
		}
	});

	pi.on("agent_before_settle", (event) => {
		// 사용자가 중단했거나 오류로 끝난 실행은 이어가지 않는다.
		if (event.outcome !== "completed" || forced >= MAX_TOTAL_FORCED) return;
		let reminder: string;
		if (buildErrors) reminder = buildRetryReminder(buildErrors);
		else if (unverified && forced < MAX_FORCED) reminder = REMINDER;
		else return;
		forced++;
		return {
			entries: [...event.entries, { type: "custom_message", customType: "verify-guard", content: reminder, display: true }],
			continue: true,
		};
	});
}
