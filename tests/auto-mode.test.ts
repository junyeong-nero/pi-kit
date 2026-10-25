import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import autoMode from "../extensions/auto-mode/index.ts";

test("automode registers a slash command and accepts string arguments", async (t) => {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  autoMode({
    registerCommand(name, command) {
      assert.equal(name, "automode");
      handler = command.handler;
    },
  } as ExtensionAPI);
  const notifications: string[] = [];
  const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
  let config = { enabled: true, allow: ["todo"], deny: [] };
  t.mock.method(fs, "readFileSync", () => JSON.stringify(config));
  const writes = t.mock.method(fs, "writeFileSync", (_path: unknown, data: string) => { config = JSON.parse(data); });
  for (const input of ["on", "auto", " ON "]) {
    await handler(input, ctx);
    assert.equal(config.enabled, false);
    assert.match(notifications.at(-1)!, /ON/);
  }
  await handler("off", ctx);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.allow, ["todo"]);
  assert.match(notifications.at(-1)!, /OFF/);
  const count = writes.mock.callCount();
  for (const input of ["", "unknown", "on off"]) {
    await handler(input, ctx);
    assert.match(notifications.at(-1)!, /Usage:/);
  }
  assert.equal(writes.mock.callCount(), count);
});
