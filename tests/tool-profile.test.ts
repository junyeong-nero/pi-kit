import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeBuildSystemPromptOptions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { GROUPS, selectTools, trimBundledPrompt } from "../extensions/tool-profile/index.ts";

test("default keeps core and user tools; groups can enable and disable without duplication", () => {
	const registered = ["read", "find_symbol", "lsp_diagnostics", "custom_tool", "harness_tools", ...Object.values(GROUPS).flat()];
	const base = ["read", "find_symbol", "lsp_diagnostics", "custom_tool", "harness_tools"];
	assert.deepEqual(selectTools(registered, registered, new Set()), base);
	const enabled = selectTools(base, registered, new Set(["code"]));
	for (const name of GROUPS.code) assert.ok(enabled.includes(name));
	assert.ok(!enabled.includes("subagent"));
	assert.deepEqual(selectTools(enabled, registered, new Set()), base);
	assert.deepEqual(selectTools(enabled, registered, new Set(["code"])), enabled);
	assert.deepEqual(selectTools(["read"], ["read"], new Set(["subagents"])), ["read"]);
	// pi's MCP support activates tool_search and the MCP tools it loads; the profile leaves them alone.
	const mcp = ["tool_search", "mcp__build_center__get_results"];
	assert.deepEqual(selectTools([...base, ...mcp], [...registered, ...mcp], new Set()), [...base, ...mcp]);
});

test("trim only bundled optional skills/catalog; user/project context survives", () => {
	const options = normalizeBuildSystemPromptOptions({ cwd: "/project", sections: { advertised_subagents: "large catalog", custom: "keep" },
		skills: [
            { name: "pi-lens-ast-grep", description: "AST", filePath: "/bundle/vendor/extensions/node_modules/pi-lens/skills/ast/SKILL.md", baseDir: "/bundle", sourceInfo: { path: "/bundle", source: "package", scope: "user", origin: "package" }, disableModelInvocation: false },
            { name: "custom", description: "Custom", filePath: "/project/skills/custom/SKILL.md", baseDir: "/project", sourceInfo: { path: "/project", source: "project", scope: "project", origin: "top-level" }, disableModelInvocation: false },
		] });
	trimBundledPrompt(options, "/bundle", new Set());
	assert.deepEqual(options.skills.map(skill => skill.name), ["custom"]);
	assert.deepEqual(options.sections, { custom: "keep" });
});
