import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import autoMode from "../extensions/auto-mode/index.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "automode 한글 "));
  const previousDir = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    process.chdir(previousDir);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "이동한 배포 폴더", "config");
  const project = join(root, "별도 프로젝트");
  const gatePath = join(agentDir, "extensions", "allowlist-gate.json");
  fs.mkdirSync(join(agentDir, "extensions"), { recursive: true });
  fs.mkdirSync(project);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.chdir(project);
  const initial = { enabled: true, allow: ["todo"], deny: ["shell:dangerous"], custom: "preserve" };
  fs.writeFileSync(gatePath, JSON.stringify(initial));
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  autoMode({
    registerCommand(name, command) {
      assert.equal(name, "automode");
      handler = command.handler;
    },
  } as ExtensionAPI);
  const notifications: { message: string; type: string }[] = [];
  const ctx = { cwd: project, ui: { notify: (message: string, type: string) => notifications.push({ message, type }) } } as unknown as ExtensionCommandContext;
  return { root, project, gatePath, initial, notifications, run: (args: string) => handler(args, ctx), config: () => JSON.parse(fs.readFileSync(gatePath, "utf8")) };
}

test("automode uses the agent config from an unrelated cwd and preserves other settings", async (t) => {
  const f = fixture(t);
  // A similarly named project file must not be read or overwritten.
  const decoy = join(f.project, "config", "extensions", "allowlist-gate.json");
  fs.mkdirSync(join(f.project, "config", "extensions"), { recursive: true });
  fs.writeFileSync(decoy, "project file must stay unchanged");
  for (const input of ["on", "auto", " ON "]) {
    await f.run(input);
    assert.deepEqual(f.config(), { ...f.initial, enabled: false });
    assert.match(f.notifications.at(-1)!.message, /ON/);
    assert.equal(f.notifications.at(-1)!.type, "info");
  }
  await f.run("off");
  assert.deepEqual(f.config(), f.initial);
  assert.match(f.notifications.at(-1)!.message, /OFF/);
  assert.equal(fs.readFileSync(decoy, "utf8"), "project file must stay unchanged");
  const before = fs.readFileSync(f.gatePath, "utf8");
  for (const input of ["", "unknown", "on off"]) {
    await f.run(input);
    assert.match(f.notifications.at(-1)!.message, /Usage:/);
  }
  assert.equal(fs.readFileSync(f.gatePath, "utf8"), before);
});

test("automode works with no config directory in the working project", async (t) => {
  const f = fixture(t);
  await f.run("on");
  assert.equal(f.config().enabled, false);
  await f.run("off");
  assert.equal(f.config().enabled, true);
  assert.equal(fs.existsSync(join(f.project, "config")), false);
});

test("missing or malformed gate config reports the actual path without claiming success", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.gatePath);
  await f.run("on");
  assert.equal(f.notifications.at(-1)!.type, "error");
  assert.ok(f.notifications.at(-1)!.message.includes(f.gatePath));
  assert.equal(fs.existsSync(f.gatePath), false);
  fs.writeFileSync(f.gatePath, "not JSON");
  await f.run("off");
  assert.equal(f.notifications.at(-1)!.type, "error");
  assert.equal(fs.readFileSync(f.gatePath, "utf8"), "not JSON");
});
