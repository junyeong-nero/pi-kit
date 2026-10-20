import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, LspPool, loadConfig, projectRoot, normalizeLocations, normalizeSymbols, serverLanguage } from "../extensions/cpp-csharp-lsp-lite/lsp-client.ts";

const fake = resolve("tests/fake-lsp.mjs");
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "harness lsp 한글 "));
  roots.push(root); // Remove after per-test server shutdown hooks (Windows cwd locks).
  return root;
}
function config(mode = "push") {
  return { command: process.execPath, args: [fake, mode], settings: { test: { enabled: true } }, diagnosticsTimeoutMs: 500, requestTimeoutMs: 5000 };
}

test("push diagnostics: framing, server requests, edit invalidation, obsolete versions", async t => {
  const root = fixture(t), file = join(root, "main.cpp"); writeFileSync(file, "broken");
  const client = new LspClient(root, config()); t.after(() => client.shutdown());
  const first = await client.diagnose(file);
  assert.equal(first.timedOut, false); assert.match(first.diagnostics[0].message, /오류/);
  const status = await client.request<{ checks: number }>("test/status", {});
  assert.equal(status.checks, 3);
  writeFileSync(file, "fixed");
  assert.deepEqual(await client.diagnose(file), { diagnostics: [], timedOut: false });
});
test("silence is reported as pending, including retry without editing", async t => {
  const root = fixture(t), file = join(root, "main.cpp"); writeFileSync(file, "fine");
  const client = new LspClient(root, config("silent")); t.after(() => client.shutdown());
  assert.equal((await client.diagnose(file)).timedOut, true);
  assert.equal((await client.diagnose(file)).timedOut, true);
  await assert.rejects(client.request("test/hang", {}, 30), /timed out/);
});
test("pull diagnostics refresh after changes", async t => {
  const root = fixture(t), file = join(root, "Program.cs"); writeFileSync(file, "broken");
  const client = new LspClient(root, config("pull")); t.after(() => client.shutdown());
  assert.equal((await client.diagnose(file)).diagnostics.length, 1);
  writeFileSync(file, "fixed");
  assert.deepEqual(await client.diagnose(file), { diagnostics: [], timedOut: false });
});
test("missing executable rejects initialization and shutdown terminates pending work", async t => {
  const root = fixture(t);
  const missing = new LspClient(root, { command: join(root, "missing") });
  await assert.rejects(missing.ready, /ENOENT/); await missing.shutdown();
  const client = new LspClient(root, config()); await client.ready;
  const pending = assert.rejects(client.request("test/hang", {}), /closed|exited/);
  await client.shutdown(); await pending;
});
test("language routing and project roots prefer solution/compilation database", async t => {
  const root = fixture(t), nested = join(root, "app/src"); mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, ".git"), ""); writeFileSync(join(root, "App.sln"), "");
  writeFileSync(join(root, "app/App.csproj"), ""); writeFileSync(join(root, "compile_commands.json"), "[]");
  assert.equal(projectRoot(nested, "csharp"), root); assert.equal(projectRoot(nested, "cpp"), root);
  assert.equal(serverLanguage("test.CXX"), "cpp"); assert.equal(serverLanguage("Test.cs"), "csharp");
  const pool = new LspPool({ servers: { cpp: config(), csharp: config() } }); t.after(() => pool.shutdown());
  const cpp = pool.forFile(root, join(nested, "a.cpp")), cs = pool.forFile(root, join(nested, "a.cs"));
  assert.notEqual(cpp, cs); assert.equal(pool.forFile(root, join(nested, "b.hpp")), cpp);
  await Promise.all([cpp.ready, cs.ready]);
});
test("bundle-relative config survives spaces and does not split command arguments", t => {
  const root = fixture(t); mkdirSync(join(root, "config"));
  const path = join(root, "config/lsp.json");
  writeFileSync(path, JSON.stringify({ servers: { csharp: { command: "${bundle}/dotnet.exe", args: ["${bundle}/a b.dll"], env: { TEST: "${bundle}" } } } }));
  const server = loadConfig(path).servers.csharp!;
  assert.equal(server.command, join(root, "dotnet.exe"));
  assert.equal(server.args?.length, 1); assert.equal(resolve(server.args![0]), join(root, "a b.dll"));
  assert.equal(server.env?.TEST, root);
});
test("hierarchical symbols and LocationLink responses are normalized", () => {
  const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, uri = pathToFileURL("/tmp/source.cpp").href;
  assert.deepEqual(normalizeLocations([{ targetUri: uri, targetRange: range, targetSelectionRange: range }]), [{ uri, range }]);
  const symbols = normalizeSymbols([{ name: "Class", kind: 5, range, selectionRange: range, children: [{ name: "Method", kind: 6, range, selectionRange: range }] }], uri);
  assert.equal(symbols.length, 2); assert.equal(symbols[1].containerName, "Class"); assert.equal(symbols[1].location.uri, uri);
});
