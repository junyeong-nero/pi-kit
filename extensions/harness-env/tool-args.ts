// pi-tool-repair는 bash 인자 이름만 고친다. 이 배포본의 셸 도구인 powershell에도 같은 보정을 적용한다.
// harness-env가 먼저 로드되므로 pi-tool-repair보다 먼저 실행되고, 이후 타입 보정(timeout "30" → 30 등)은 pi-tool-repair가 한다.

export const POWERSHELL_COMMAND_ALIASES = ["cmd", "shell", "cmdline", "script", "commandLine", "command_line"];

type ToolCall = { type: "toolCall"; name: string; arguments: unknown };

/** powershell 호출의 command 인자를 고쳤으면 true. 이미 command가 있으면 건드리지 않는다. */
export function repairPowerShellCall(call: ToolCall): boolean {
	if (call.name !== "powershell") return false;
	if (typeof call.arguments === "string" && call.arguments.trim()) {
		call.arguments = { command: call.arguments };
		return true;
	}
	const args = call.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const record = args as Record<string, unknown>;
	if (typeof record.command === "string") return false;
	const alias = POWERSHELL_COMMAND_ALIASES.find((name) => typeof record[name] === "string");
	if (!alias) return false;
	record.command = record[alias];
	delete record[alias];
	return true;
}

/** 어시스턴트 메시지 안의 powershell 호출을 고친다. 바꾼 것이 있으면 새 메시지를 돌려준다. */
export function repairPowerShellArgs<T extends { role: string; content?: unknown }>(message: T): T | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	let changed = false;
	const content = message.content.map((part) => {
		if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") return part;
		const call = { ...(part as ToolCall) };
		if (call.arguments && typeof call.arguments === "object") call.arguments = { ...(call.arguments as object) };
		if (!repairPowerShellCall(call)) return part;
		changed = true;
		return call;
	});
	return changed ? { ...message, content } : undefined;
}
