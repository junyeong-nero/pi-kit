/** MacBook HUD layout, without pi-usage-bar or other extension status lines. */
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const BAR_WIDTH = 10;

function modelLabel(model: { id: string; name?: string } | undefined): string {
	if (!model) return "no-model";
	return (model.name || model.id).replace(/^Claude\s+/i, "");
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	let context: ExtensionContext;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		context = ctx;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsub();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const head = theme.fg("accent", `[${modelLabel(context.model)} ◔ ${pi.getThinkingLevel()}]`);
					const usage = context.getContextUsage()?.percent ?? 0;
					const pct = Number.isFinite(usage) ? Math.max(0, Math.min(100, Math.round(usage))) : 0;
					const filled = Math.round((pct / 100) * BAR_WIDTH);
					const color = pct > 85 ? "error" : pct >= 50 ? "warning" : "success";
					const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
					const branch = footerData.getGitBranch();
					const where = theme.fg("dim", "| ") + basename(context.cwd) +
						(branch ? " " + theme.fg("dim", "git:(") + theme.fg("accent", branch) + theme.fg("dim", ")") : "");
					return [truncateToWidth(` ${head} ${bar} ${pct}% ${where}`, width)];
				},
			};
		});
	});

	const rerender = async (_event: unknown, ctx: ExtensionContext) => {
		context = ctx;
		requestRender?.();
	};
	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);
	pi.on("turn_end", rerender);
	pi.on("agent_end", rerender);
	pi.on("session_compact", rerender);
}
