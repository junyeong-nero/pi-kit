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
  pi.command({
    name: "automode",
    description: "allowlist-gate on/off (auto/on=disable gate, off=enable gate)",
    params: {
      mode: { type: "string", enum: ["on", "off", "auto"] },
    },
    handler: (args: { mode?: string }) => {
      const m = (args.mode ?? "").toLowerCase();
      if (m === "on" || m === "auto") {
        setEnabled(false);
        return { content: [{ type: "text", text: "automode: ON (allowlist-gate disabled)" }] };
      }
      if (m === "off") {
        setEnabled(true);
        return { content: [{ type: "text", text: "automode: OFF (allowlist-gate enabled)" }] };
      }
      return { content: [{ type: "text", text: "Usage: /automode on | off" }] };
    },
  });
}
