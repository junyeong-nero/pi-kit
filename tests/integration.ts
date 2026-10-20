// Developer smoke test against actual local language servers.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { LspClient, normalizeLocations, normalizeSymbols } from "../extensions/cpp-csharp-lsp-lite/lsp-client.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "harness integration 한글 ")));
try {
  for (const language of ["cpp", "csharp"] as const) {
    if (language === "csharp" && !process.env.TEST_DOTNET) continue;
    const root = join(scratch, language);
    mkdirSync(root, { recursive: true });
    const fixture = resolve(`tests/fixtures/${language}`);
    for (const entry of readdirSync(fixture, { withFileTypes: true })) {
      if (entry.isFile()) copyFileSync(join(fixture, entry.name), join(root, entry.name));
    }
    const dotnet = process.env.TEST_DOTNET!;
    const env = { ...process.env, DOTNET_CLI_HOME: join(scratch, "dotnet-home"), DOTNET_GENERATE_ASPNET_CERTIFICATE: "false", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "true", NuGetAudit: "false" };
    if (language === "csharp") execFileSync(dotnet, ["restore", join(root, "OfflineSmoke.csproj"), "--configfile", join(root, "NuGet.Config"), "--packages", join(scratch, "packages"), "-p:NuGetAudit=false"], { env, stdio: "inherit" });
    const command = language === "cpp" ? (process.env.TEST_CLANGD ?? "clangd") : dotnet;
    assert.ok(existsSync(root), `Missing fixture directory: ${root}`);
    if (command !== "clangd") assert.ok(existsSync(command), `Missing server executable: ${command}`);
    execFileSync(command, [language === "cpp" ? "--version" : "--list-sdks"], { env, cwd: root, stdio: "inherit" });
    const client = new LspClient(root, {
      command,
      args: language === "cpp" ? ["--log=error"] : [resolve(process.env.TEST_BUNDLE ?? ".", "bin/csharp-ls/CSharpLanguageServer.dll")],
      settings: language === "csharp" ? { csharp: { useMetadataUris: false } } : undefined,
      env, initializeTimeoutMs: 120000, requestTimeoutMs: 120000, diagnosticsTimeoutMs: 120000,
    });
    try {
      await client.ready;
      const file = join(root, language === "cpp" ? "main.cpp" : "Program.cs"), uri = pathToFileURL(file).href;
      const source = readFileSync(file, "utf8"), line = language === "cpp" ? 1 : 3, symbol = language === "cpp" ? "add" : "Add";
      client.sync(file);
      const params = { textDocument: { uri }, position: { line, character: source.split("\n")[line].indexOf(symbol) } };
      // Initialization may finish before the C# workspace has loaded its project.
      let hover;
      const deadline = Date.now() + 60000;
      do {
        hover = await client.request<any>("textDocument/hover", params);
        if (hover?.contents) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      assert.ok(hover?.contents, `${language} hover: ${(client as any).stderr}`);
      assert.ok(normalizeLocations(await client.request<any>("textDocument/definition", params)).length, `${language} definition`);
      const references = await client.request<any[]>("textDocument/references", { ...params, context: { includeDeclaration: true } });
      assert.ok(references.length >= 2, `${language} references`);
      assert.ok(normalizeSymbols(await client.request<any[]>("textDocument/documentSymbol", { textDocument: { uri } }), uri).length, `${language} symbols`);
      writeFileSync(file, source.replace(`${symbol}(1, 2)`, "missing_name(1, 2)"));
      const broken = await client.diagnose(file); assert.equal(broken.timedOut, false);
      assert.ok(broken.diagnostics.some(d => d.message.includes("missing_name")), `${language} undefined identifier diagnostic`);
      writeFileSync(file, source);
      const fixed = await client.diagnose(file); assert.equal(fixed.timedOut, false);
      assert.ok(!fixed.diagnostics.some(d => d.message.includes("missing_name")), `${language} clears stale errors`);
      console.log(`${language}: hover, definition, references, symbols, diagnostics and edit recovery passed`);
    } finally { await client.shutdown(); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
