import assert from "node:assert/strict";
import { test } from "node:test";
import { repairPowerShellArgs } from "../extensions/harness-env/tool-args.ts";

const assistant = (name: string, args: unknown) => ({ role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id: "1", name, arguments: args }] });
const argsOf = (message: { content: unknown[] } | undefined) => (message?.content[1] as { arguments: unknown }).arguments;

test("powershell argument aliases become command", () => {
	for (const alias of ["cmd", "shell", "cmdline", "script", "commandLine", "command_line"]) {
		assert.deepEqual(argsOf(repairPowerShellArgs(assistant("powershell", { [alias]: "git status", timeout: 30 }))), { command: "git status", timeout: 30 }, alias);
	}
	assert.deepEqual(argsOf(repairPowerShellArgs(assistant("powershell", "git status"))), { command: "git status" });
});

test("valid calls, other tools and non-assistant messages are left untouched", () => {
	const original = assistant("powershell", { cmd: "git status" });
	repairPowerShellArgs(original);
	assert.deepEqual(argsOf(original), { cmd: "git status" }, "does not mutate the original message");
	assert.equal(repairPowerShellArgs(assistant("powershell", { command: "git log", cmd: "x" })), undefined);
	assert.equal(repairPowerShellArgs(assistant("bash", { cmd: "ls" })), undefined);
	assert.equal(repairPowerShellArgs(assistant("powershell", { cmd: 3 })), undefined);
	assert.equal(repairPowerShellArgs(assistant("powershell", "  ")), undefined);
	assert.equal(repairPowerShellArgs({ role: "user", content: [{ type: "toolCall", name: "powershell", arguments: { cmd: "x" } }] }), undefined);
});
