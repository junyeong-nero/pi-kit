import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import minimalFooter from "../extensions/minimal-footer/index.ts";

type Footer = { render(width: number): string[]; invalidate(): void; dispose(): void };

function fixture(mode = "tui") {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	let footer: Footer | undefined;
	let renders = 0;
	let unsubscribed = false;
	let branch: string | undefined = "main";
	let branchChanged = () => {};
	let percent: number | undefined = 0;
	let thinking = "medium";
	const colors: string[] = [];
	const ctx = {
		mode, hasUI: mode !== "print", cwd: join("bundle", "프로젝트"),
		model: { id: "opus", name: "Claude Opus 5.5" },
		getContextUsage: () => percent === undefined ? undefined : { percent },
		ui: { setFooter(factory: Function) {
			footer = factory(
				{ requestRender: () => { renders++; } },
				{ fg: (color: string, text: string) => { colors.push(color); return text; } },
				{
					getGitBranch: () => branch,
					onBranchChange: (callback: () => void) => { branchChanged = callback; return () => { unsubscribed = true; }; },
					getExtensionStatuses: () => { throw new Error("HUD must not read usage-bar or other statuses"); },
				},
			);
		} },
	} as unknown as ExtensionContext;
	minimalFooter({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler), getThinkingLevel: () => thinking } as unknown as ExtensionAPI);
	return {
		ctx, colors, handlers,
		start: () => handlers.get("session_start")!({}, ctx),
		footer: () => footer!, renders: () => renders, unsubscribed: () => unsubscribed,
		setPercent: (value: number | undefined) => { percent = value; },
		setThinking: (value: string) => { thinking = value; },
		setBranch: (value: string | undefined) => { branch = value; branchChanged(); },
	};
}

test("MacBook HUD renders one line, without extension statuses", async () => {
	const f = fixture();
	await f.start();
	assert.deepEqual(f.footer().render(120), [" [Opus 5.5 ◔ medium] ░░░░░░░░░░ 0% | 프로젝트 git:(main)"]);
	f.setPercent(50);
	assert.match(f.footer().render(120)[0], /█████░░░░░ 50%/);
	assert.ok(f.colors.includes("warning"));
	f.setPercent(86);
	f.footer().render(120);
	assert.ok(f.colors.includes("error"));
	f.setBranch(undefined);
	assert.ok(!f.footer().render(120)[0].includes("git:"));
});

test("context values are bounded, missing model is safe, and narrow widths fit", async () => {
	const f = fixture();
	await f.start();
	for (const [value, expected] of [[undefined, 0], [NaN, 0], [Infinity, 0], [-5, 0], [120, 100], [49.6, 50]] as const) {
		f.setPercent(value);
		assert.ok(f.footer().render(120)[0].includes(` ${expected}%`));
	}
	for (const width of [1, 5, 20, 48, 80]) assert.ok(visibleWidth(f.footer().render(width)[0]) <= width);
	f.ctx.model = undefined;
	assert.match(f.footer().render(120)[0], /no-model/);
	f.ctx.model = { id: "internal-model" } as ExtensionContext["model"];
	assert.match(f.footer().render(120)[0], /internal-model/);
});

test("model, thinking, branch and session events refresh; disposal unsubscribes", async () => {
	const f = fixture();
	await f.start();
	f.setBranch("feature/hud");
	assert.equal(f.renders(), 1);
	f.setThinking("high");
	const freshCtx = { ...f.ctx, model: { id: "new-model" } } as ExtensionContext;
	for (const event of ["model_select", "thinking_level_select", "turn_end", "agent_end", "session_compact"]) {
		await f.handlers.get(event)!({}, freshCtx);
	}
	assert.equal(f.renders(), 6);
	assert.match(f.footer().render(120)[0], /new-model ◔ high/);
	f.footer().invalidate();
	f.footer().dispose();
	assert.ok(f.unsubscribed());
	await f.handlers.get("agent_end")!({}, freshCtx);
	assert.equal(f.renders(), 6);
});

test("RPC and print modes do not install terminal UI", async () => {
	for (const mode of ["rpc", "print", "json"]) {
		const f = fixture(mode);
		await f.start();
		assert.equal(f.footer(), undefined);
	}
});
