// /plan으로 켜고 끄는 읽기 전용 계획 모드. 켜져 있으면 파일 수정·상태 변경 도구 호출을 막고 계획만 세우게 한다.
// pi 예제(plan-mode)를 바탕으로 이 배포본의 PowerShell 도구와 동봉 도구 이름에 맞췄다.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "plan-mode";
const CONTEXT_MESSAGE = "plan-mode-context";

// 계획 모드에서도 그대로 쓰는 읽기 전용 도구. 여기에 없고 powershell·빌드센터 조회도 아닌 도구(edit, write, ast_grep_replace, subagent, Edge MCP 등)는 막는다.
export const READ_ONLY_TOOLS = new Set([
	"read", "grep", "find", "ls",
	"lsp_diagnostics", "lsp_symbols", "lsp_definition", "lsp_references", "lsp_hover", "find_symbol",
	"module_report", "read_symbol", "ast_grep_search", "pi_lens_activate_tools", "harness_tools",
	"ask_user_question", "todo", "tool_search",
]);
// 동봉 빌드센터 MCP는 결과·로그 조회만 한다.
const READ_ONLY_TOOL_PREFIX = "mcp__build_center__";

// 첫 단어만 보고 허용하는 PowerShell 명령(별칭 포함, 소문자). git·svn은 하위 명령을 따로 검사한다.
const SAFE_COMMANDS = new Set([
	"get-childitem", "gci", "ls", "dir", "get-content", "gc", "cat", "type", "get-item", "gi", "get-itemproperty", "gp",
	"test-path", "resolve-path", "rvpa", "split-path", "join-path", "get-location", "gl", "pwd", "get-filehash", "get-acl",
	"select-string", "sls", "findstr", "rg", "fd", "where", "get-command", "gcm", "get-help", "get-date",
	"measure-object", "measure", "select-object", "select", "sort-object", "sort", "group-object", "group", "where-object", "?",
	"compare-object", "get-unique", "format-table", "ft", "format-list", "fl", "format-wide", "fw", "out-string",
	"convertfrom-json", "convertto-json", "write-output", "echo", "write-host",
]);
const GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "grep", "describe", "shortlog", "cat-file", "branch"]);
const GIT_BRANCH_FLAGS = new Set(["--show-current", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv"]);
const SVN_SUBCOMMANDS = new Set(["status", "st", "diff", "di", "log", "info", "cat", "list", "ls", "blame", "annotate", "praise", "propget", "pg", "proplist", "pl"]);
// 읽기 명령이라도 파일을 쓰거나 다른 프로그램을 실행하는 옵션.
const UNSAFE_OPTIONS = /^(?:--pre|--output|--diff-cmd|--diff3-cmd|--editor-cmd)(?:=|$)/;
const FD_EXEC_OPTIONS = /^(?:-x|-X|--exec|--exec-batch)(?:=|$)/;
const GIT_PAGER_OPTIONS = /^(?:-O|--open-files-in-pager)/;

const unquote = (word: string) => word.replace(/^['"]|['"]$/g, "");

function safeSegment(segment: string): boolean {
	const words = segment.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const first = words[0];
	// 변수·속성·연산자·문자열·숫자로 시작하는 조각은 명령 실행이 아니라 식이다. (호출 연산자 &는 분리 단계에서 막는다.)
	if (/^(?:\$|-|'|"|\[|\d|\.[A-Za-z_])/.test(first)) return true;
	const name = first.toLowerCase().replace(/\.exe$/, "");
	const args = words.slice(1).map(unquote);
	if (args.some((arg) => UNSAFE_OPTIONS.test(arg))) return false;
	if (name === "fd" && args.some((arg) => FD_EXEC_OPTIONS.test(arg))) return false;
	if (name === "foreach-object" || name === "%") return args.length === 0; // `% Delete`처럼 메서드를 부르는 형태는 막고 스크립트 블록만 허용
	if (name === "git") {
		let i = 0;
		for (; i < args.length && args[i].startsWith("-"); i++) {
			if (args[i] === "-C") i++;
			else if (args[i] !== "--no-pager") return false; // -c 등으로 설정을 바꿔 다른 프로그램을 실행할 수 있다
		}
		const sub = args[i]?.toLowerCase();
		if (!sub || !GIT_SUBCOMMANDS.has(sub)) return false;
		if (sub === "grep" && args.some((arg) => GIT_PAGER_OPTIONS.test(arg))) return false;
		return sub !== "branch" || args.slice(i + 1).every((arg) => GIT_BRANCH_FLAGS.has(arg));
	}
	if (name === "svn") return SVN_SUBCOMMANDS.has(args[0]?.toLowerCase() ?? "");
	return SAFE_COMMANDS.has(name);
}

/** 파일을 바꾸지 않는 PowerShell 명령인지 보수적으로 판단한다. 판단이 어려우면 false다. */
export function isReadOnlyCommand(command: unknown): boolean {
	if (typeof command !== "string" || !command.trim()) return false;
	// 출력을 버리거나 합치는 리다이렉션만 허용하고, 그 밖의 > < 는 파일 쓰기로 본다.
	const text = command.replace(/\s*(?:[1-6*]?>\s*\$null\b|[1-6*]>&[12])/gi, " ");
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			current += ch;
			continue;
		}
		if (ch === "`") {
			current += ch + (next ?? "");
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === "$" && next === "(") return false; // 문자열 안의 하위 식도 명령을 실행한다
			if (ch === '"') quote = undefined;
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
		} else if (ch === ">" || ch === "<") {
			return false;
		} else if (ch === "&") {
			if (next !== "&") return false; // 호출 연산자·백그라운드 실행
			i++;
			segments.push(current);
			current = "";
		} else if (ch === ":" && next === ":") {
			return false; // [IO.File]::WriteAllText 같은 .NET 정적 메서드
		} else if (ch === "." && /^\.\s*[A-Za-z_]\w*\s*\(/.test(text.slice(i))) {
			return false; // $file.Delete() 같은 메서드 호출
		} else if ("|;(){}\r\n".includes(ch)) {
			segments.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (quote) return false;
	segments.push(current);
	return segments.every(safeSegment);
}

export type PlanDecision = { block: true; reason: string } | undefined;

/** 계획 모드에서 도구 호출을 막아야 하면 이유를 돌려준다. */
export function checkToolCall(toolName: string, input: unknown): PlanDecision {
	if (READ_ONLY_TOOLS.has(toolName) || toolName.startsWith(READ_ONLY_TOOL_PREFIX)) return undefined;
	if (toolName === "powershell") {
		const command = (input as { command?: unknown } | undefined)?.command;
		if (isReadOnlyCommand(command)) return undefined;
		return {
			block: true,
			reason: `계획 모드라서 읽기 전용으로 확인되지 않은 명령은 실행하지 않습니다: ${String(command)}\n` +
				"Get-ChildItem, Get-Content, rg, fd, git status/diff/log 같은 조회 명령만 쓰고, 실행이 꼭 필요하면 계획에 적으세요. 사용자가 /plan으로 계획 모드를 끄면 실행할 수 있습니다.",
		};
	}
	return {
		block: true,
		reason: `계획 모드에서는 ${toolName} 도구를 쓰지 않습니다. 파일을 고치지 말고 변경 계획만 설명하세요. 사용자가 /plan으로 계획 모드를 끄면 구현할 수 있습니다.`,
	};
}

export const PLAN_PROMPT = `[계획 모드]
지금은 계획 모드다. 구현하지 말고 어떻게 구현할지 계획만 세운다.
- edit, write, 파일을 바꾸는 PowerShell 명령, 하위 에이전트, Edge MCP 도구는 막혀 있다. read, grep, find, ls, find_symbol, lsp_*, 빌드센터 조회(mcp__build_center__*)와 조회용 PowerShell 명령(Get-Content, rg, fd, git status/diff/log 등)으로 조사한다.
- 추측하지 말고 실제로 읽은 파일·함수와 경로:줄을 근거로 쓴다. 요구가 모호하면 ask_user_question으로 묻는다.
- 결과는 목표, 바꿀 파일과 이유, 단계별 변경 내용, 위험과 대안, 검증 방법(빌드·테스트 명령) 순서로 정리한다. 코드는 답변 안의 짧은 조각으로만 보여 준다.`;

export default function (pi: ExtensionAPI) {
	let enabled = false;

	function show(ctx: ExtensionContext) {
		// minimal-footer는 확장 상태 줄을 그리지 않으므로 입력창 위 위젯으로 표시한다.
		ctx.ui.setWidget(STATE_ENTRY, enabled ? [ctx.ui.theme.fg("warning", "⏸ 계획 모드: 파일 수정 없음 (/plan으로 끄기)")] : undefined);
	}

	function setEnabled(value: boolean, ctx: ExtensionContext) {
		enabled = value;
		pi.appendEntry(STATE_ENTRY, { enabled });
		show(ctx);
	}

	pi.registerCommand("plan", {
		description: "계획 모드 켜기/끄기 (/plan <작업>은 계획 모드를 켜고 바로 계획을 요청)",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (task) {
				if (!enabled) setEnabled(true, ctx);
				pi.sendUserMessage(task);
				return;
			}
			setEnabled(!enabled, ctx);
			ctx.ui.notify(enabled ? "계획 모드 ON: 파일 수정과 상태 변경 명령을 막습니다." : "계획 모드 OFF: 파일 수정과 명령 실행을 다시 허용합니다.", "info");
		},
	});

	pi.on("tool_call", (event) => (enabled ? checkToolCall(event.toolName, event.input) : undefined));

	pi.on("before_agent_start", () => {
		if (!enabled) return;
		return { message: { customType: CONTEXT_MESSAGE, content: PLAN_PROMPT, display: false } };
	});

	// 계획 모드를 끈 뒤에는 이전 턴의 계획 모드 지시를 모델에 보내지 않는다.
	pi.on("context", (event) => {
		if (enabled) return;
		return { messages: event.messages.filter((m) => (m as { customType?: string }).customType !== CONTEXT_MESSAGE) };
	});

	// 계획을 받은 뒤 바로 구현할지 묻는다. 고르지 않으면 계획 모드를 유지한다.
	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled || !ctx.hasUI) return;
		const choice = await ctx.ui.select("계획 모드: 다음 작업", ["계획 모드 유지", "계획 모드를 끄고 이 계획대로 구현"]);
		if (choice !== "계획 모드를 끄고 이 계획대로 구현") return;
		setEnabled(false, ctx);
		pi.sendMessage({ customType: "plan-mode-execute", content: "계획 모드를 껐다. 방금 세운 계획대로 구현하라.", display: true }, { triggerTurn: true });
	});

	// 세션을 이어서 열면 마지막 상태를 복원한다.
	pi.on("session_start", (_event, ctx) => {
		const last = ctx.sessionManager.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
			.pop() as { data?: { enabled?: boolean } } | undefined;
		enabled = last?.data?.enabled === true;
		show(ctx);
	});
}
