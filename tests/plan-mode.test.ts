import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planMode, { checkToolCall, isReadOnlyCommand, PLAN_PROMPT } from "../extensions/plan-mode/index.ts";

test("read-only PowerShell commands are allowed", () => {
	for (const command of [
		"Get-ChildItem -Recurse -Filter *.cs",
		"Get-Content src\\main.cpp -TotalCount 40",
		"rg -n \"Foo.Bar(\" src",
		"rg -x 'exact line' src",
		"fd -e cpp",
		"git status --short && git diff -- src/a.cpp",
		"git -C ..\\other --no-pager log --oneline -5",
		"git branch --show-current",
		"svn status; svn diff src",
		"Get-ChildItem src | Where-Object { $_.Length -gt 1000 } | Select-Object -First 5 Name",
		"Get-ChildItem | ForEach-Object { $_.Name }",
		"(Get-Content a.txt).Length",
		"Select-String -Path *.cs -Pattern 'a > b'",
		"git log -1 2>$null",
		"rg foo 2>&1 | Measure-Object",
		"where.exe clangd",
	]) assert.equal(isReadOnlyCommand(command), true, command);
});

test("mutating or unclear PowerShell commands are blocked", () => {
	for (const command of [
		"Remove-Item a.txt",
		"Get-Content a | Set-Content b",
		"Get-Content a > b.txt",
		"echo hi >> log.txt",
		"git commit -am x",
		"git checkout main",
		"git branch -D old",
		"git -c core.pager=evil log",
		"git diff --output=out.patch",
		"git grep -O foo",
		"svn update",
		"svn diff --diff-cmd evil",
		"rg --pre evil foo",
		"fd -e tmp -x Remove-Item",
		"fd -e tmp --exec rm",
		"Get-ChildItem | ForEach-Object { Remove-Item $_ }",
		"Get-ChildItem | % Delete",
		"(Get-Item a.txt).Delete()",
		"[IO.File]::WriteAllText('a', 'b')",
		"& 'Remove-Item' a",
		"Write-Output \"$(Remove-Item a)\"",
		"Get-Content a; dotnet build",
		"msbuild app.sln",
		"Invoke-Expression 'rm a'",
		"Write-Output 'unterminated",
		"",
		undefined,
	]) assert.equal(isReadOnlyCommand(command), false, String(command));
});

test("tool policy keeps exploration tools and blocks edits", () => {
	for (const tool of ["read", "grep", "find", "ls", "find_symbol", "lsp_diagnostics", "ask_user_question", "todo", "tool_search", "mcp__build_center__get_log"]) {
		assert.equal(checkToolCall(tool, {}), undefined, tool);
	}
	for (const tool of ["edit", "write", "ast_grep_replace", "subagent", "mcp__edge__browser_click", "mcp__edge__browser_snapshot", "bash"]) {
		assert.equal(checkToolCall(tool, {})?.block, true, tool);
	}
	assert.equal(checkToolCall("powershell", { command: "git status" }), undefined);
	assert.match(checkToolCall("powershell", { command: "Remove-Item a" })!.reason, /\/plan/);
});

function fixture(branch: unknown[] = [], choice?: string) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let command!: (args: string, ctx: any) => Promise<void>;
	const entries: unknown[] = [];
	const sent: unknown[] = [];
	const widgets: (string[] | undefined)[] = [];
	const notices: string[] = [];
	planMode({
		registerCommand(name: string, options: { handler: typeof command }) {
			assert.equal(name, "plan");
			command = options.handler;
		},
		on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
		appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
		sendUserMessage(content: string) { sent.push({ user: content }); },
		sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI);
	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
			notify: (message: string) => notices.push(message),
			select: async () => choice,
		},
	};
	const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
	return { run: (args: string) => command(args, ctx), emit, entries, sent, widgets, notices };
}

test("/plan toggles blocking, prompt injection and stale-context filtering", async () => {
	const f = fixture();
	await f.emit("session_start");
	assert.equal(f.emit("tool_call", { toolName: "edit", input: {} }), undefined, "off by default");
	assert.equal(f.emit("before_agent_start"), undefined);

	await f.run("");
	assert.deepEqual(f.entries.at(-1), { customType: "plan-mode", data: { enabled: true } });
	assert.match(String(f.widgets.at(-1)), /계획 모드/);
	assert.equal(f.emit("tool_call", { toolName: "edit", input: {} }).block, true);
	assert.equal(f.emit("tool_call", { toolName: "powershell", input: { command: "git log" } }), undefined);
	assert.equal(f.emit("before_agent_start").message.content, PLAN_PROMPT);
	const messages = [{ role: "custom", customType: "plan-mode-context" }, { role: "user", content: "hi" }];
	assert.equal(f.emit("context", { messages }), undefined, "keep the plan instruction while active");

	await f.run("");
	assert.deepEqual(f.entries.at(-1), { customType: "plan-mode", data: { enabled: false } });
	assert.equal(f.widgets.at(-1), undefined);
	assert.equal(f.emit("tool_call", { toolName: "edit", input: {} }), undefined);
	assert.deepEqual(f.emit("context", { messages }).messages, [messages[1]]);
});

test("/plan <task> turns plan mode on and sends the task", async () => {
	const f = fixture();
	await f.run("  로그인 버그 고치는 방법  ");
	assert.deepEqual(f.sent, [{ user: "로그인 버그 고치는 방법" }]);
	assert.equal(f.emit("tool_call", { toolName: "write", input: {} }).block, true);
	await f.run("다른 작업");
	assert.equal(f.entries.length, 1, "already on: stays on");
});

test("session resume restores the last state on the current branch", async () => {
	const on = fixture([{ type: "custom", customType: "plan-mode", data: { enabled: false } }, { type: "custom", customType: "plan-mode", data: { enabled: true } }]);
	await on.emit("session_start");
	assert.equal(on.emit("tool_call", { toolName: "edit", input: {} }).block, true);
	const off = fixture([{ type: "custom", customType: "plan-mode", data: { enabled: true } }, { type: "custom", customType: "other", data: { enabled: true } }, { type: "custom", customType: "plan-mode", data: { enabled: false } }]);
	await off.emit("session_start");
	assert.equal(off.emit("tool_call", { toolName: "edit", input: {} }), undefined);
});

test("after a plan, choosing implement turns plan mode off and continues", async () => {
	const stay = fixture([], "계획 모드 유지");
	await stay.run("");
	await stay.emit("agent_end");
	assert.equal(stay.emit("tool_call", { toolName: "edit", input: {} }).block, true);
	assert.deepEqual(stay.sent, []);

	const go = fixture([], "계획 모드를 끄고 이 계획대로 구현");
	await go.run("");
	await go.emit("agent_end");
	assert.equal(go.emit("tool_call", { toolName: "edit", input: {} }), undefined);
	assert.equal((go.sent[0] as { options: { triggerTurn: boolean } }).options.triggerTurn, true);
});
