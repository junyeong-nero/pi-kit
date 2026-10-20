import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const GROUPS = {
	code: ["lsp_symbols", "lsp_definition", "lsp_references", "lsp_hover", "module_report", "read_symbol"],
	ast: ["ast_grep_search", "ast_grep_replace", "pi_lens_activate_tools"],
	subagents: ["subagents_enable", "subagent", "bg_wait", "subagent_supervisor"],
} as const;
export type Group = keyof typeof GROUPS;
const OPTIONAL = new Set<string>(Object.values(GROUPS).flat());

export function selectTools(active: string[], registered: string[], enabled: Set<Group>) {
	const allowed = new Set<string>([...enabled].flatMap(group => [...GROUPS[group]]));
	return [...new Set([...active.filter(name => !OPTIONAL.has(name) || allowed.has(name)),
		...registered.filter(name => allowed.has(name))])];
}

export function trimBundledPrompt(options: NormalizedBuildSystemPromptOptions, bundle: string, enabled: Set<Group>) {
	const vendor = normalize(join(bundle, "vendor", "extensions", "node_modules"));
	options.skills = options.skills.filter(skill => {
		const path = normalize(skill.filePath);
		if (!path.startsWith(vendor + "/") && !path.startsWith(vendor + "\\")) return true;
		if (path.includes("pi-lens")) return enabled.has("ast");
		if (path.includes("pi-subagents")) return enabled.has("subagents");
		return true;
	});
	if (!enabled.has("subagents")) delete options.sections.advertised_subagents;
}

export default function (pi: ExtensionAPI) {
	const bundle = resolve(fileURLToPath(new URL("../..", import.meta.url)));
	const enabled = new Set<Group>();
	function apply() {
		const tools = selectTools(pi.getActiveTools(), pi.getAllTools().map(tool => tool.name), enabled);
		pi.setActiveTools(tools);
		return tools;
	}
	pi.registerTool({
		name: "harness_tools", label: "Optional tools",
		description: "Enable optional tools for this session: code (detailed symbols), ast (structural search/edit), subagents (authorized delegation). action=list reports groups; disable hides a group. Enable before calling its tools.",
		parameters: Type.Object({ action: Type.Optional(Type.Union([Type.Literal("enable"), Type.Literal("disable"), Type.Literal("list")])),
			group: Type.Optional(Type.Union([Type.Literal("code"), Type.Literal("ast"), Type.Literal("subagents")])) }),
		async execute(_id, params) {
			const action = params.action ?? "enable";
			if (action !== "list" && !params.group) throw new Error("group이 필요합니다: code, ast, subagents");
			if (action === "enable") enabled.add(params.group!);
			if (action === "disable") enabled.delete(params.group!);
			const active = apply();
			return { content: [{ type: "text" as const, text: JSON.stringify({
				groups: Object.fromEntries(Object.entries(GROUPS).map(([group, tools]) => [group, {
					enabled: enabled.has(group as Group), tools: tools.filter(name => pi.getAllTools().some(tool => tool.name === name)),
				}])), active_tools: active, guide_path: join(bundle, "docs", "tool-guide.md"),
				note: "활성화한 도구는 다음 모델 요청부터 사용할 수 있습니다. 하위 에이전트 실행은 사용자/프로젝트의 허가 범위에서만 수행하세요.",
			}) }], details: undefined };
		},
	});
	// Run last, after upstream extensions restore their own tool selection.
	pi.on("session_start", () => { enabled.clear(); apply(); });
	pi.on("before_agent_start", event => {
		event.systemPromptOptions.selectedTools = apply();
		trimBundledPrompt(event.systemPromptOptions, bundle, enabled);
	});
}
