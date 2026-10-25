import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "fs";

const GATE_PATH = "config/extensions/allowlist-gate.json";

function setEnabled(enabled: boolean) {
  const raw = fs.readFileSync(GATE_PATH, "utf8");
  const cfg = JSON.parse(raw);
  cfg.enabled = enabled;
  fs.writeFileSync(GATE_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("automode", {
    description: "allowlist-gate on/off (auto/on=disable gate, off=enable gate)",
    handler: async (args, ctx) => {
      const m = args.trim().toLowerCase();
      if (m === "on" || m === "auto") {
        setEnabled(false);
        ctx.ui.notify("automode: ON (allowlist-gate disabled)", "info");
        return;
      }
      if (m === "off") {
        setEnabled(true);
        ctx.ui.notify("automode: OFF (allowlist-gate enabled)", "info");
        return;
      }
      ctx.ui.notify("Usage: /automode on | off", "info");
    },
  });
}
