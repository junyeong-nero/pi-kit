import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { join } from "node:path";

function setEnabled(gatePath: string, enabled: boolean) {
  const raw = fs.readFileSync(gatePath, "utf8");
  const cfg = JSON.parse(raw);
  cfg.enabled = enabled;
  fs.writeFileSync(gatePath, JSON.stringify(cfg, null, 2) + "\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("automode", {
    description: "allowlist-gate on/off (auto/on=disable gate, off=enable gate)",
    handler: async (args, ctx) => {
      const m = args.trim().toLowerCase();
      if (!["on", "auto", "off"].includes(m)) {
        ctx.ui.notify("Usage: /automode on | off", "info");
        return;
      }
      const gatePath = join(getAgentDir(), "extensions", "allowlist-gate.json");
      try {
        setEnabled(gatePath, m === "off");
      } catch (error) {
        ctx.ui.notify(`automode: failed to update ${gatePath}: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      // allowlist-gate reads its configuration on every tool_call; no session reload is needed.
      ctx.ui.notify(`automode: ${m === "off" ? "OFF" : "ON"} (global allowlist-gate ${m === "off" ? "enabled" : "disabled"}; effective on the next tool call unless overridden by project settings)`, "info");
    },
  });
}
