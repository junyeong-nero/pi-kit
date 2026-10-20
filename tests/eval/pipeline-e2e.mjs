// 러너 파이프라인 확인용 e2e: 가짜 모델이 solution/을 write로 적용한다. 모델 품질 측정이 아니다.
// 실행: node tests/eval/pipeline-e2e.mjs [과제 id]   (node_modules의 pi가 필요하다)
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeModelsJson, startFakeModel } from "./fake-model.mjs";
import { loadTask } from "./lib.mjs";
import { discoverExtensions, repoRoot, runOne } from "./run.mjs";

const id = process.argv[2] ?? "cpp-bugfix-off-by-one";
const task = loadTask(join(repoRoot, "tests/eval/tasks", id));
const files = readdirSync(join(task.dir, "solution")).filter((f) => statSync(join(task.dir, "solution", f)).isFile());
const steps = files.map((f) => ({ tool: "write", args: { path: f, content: readFileSync(join(task.dir, "solution", f), "utf8") } }));
steps.push({ tool: "bash", args: { command: "c++ -std=c++17 -fsyntax-only *.cpp" } });
const tmp = mkdtempSync(join(tmpdir(), "eval-e2e-"));
let fake;
try {
  for (const cfg of [{ label: "all", disabled: [] }, { label: "no-verify-guard", disabled: ["verify-guard"] }]) {
    fake = await startFakeModel(steps);
    const modelsJson = join(tmp, "models.json");
    writeFileSync(modelsJson, JSON.stringify(fakeModelsJson(fake.port)));
    const pi = join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const opts = { modelsJson, provider: "fake", model: "fake", pi, extensions: discoverExtensions(), extraExtensions: [], clangd: "clangd", guide: true, keep: false, logDir: join(tmp, "logs"), runIndex: 1 };
    const rec = await runOne(task, cfg, opts);
    fake.close();
    console.log(JSON.stringify(rec));
    assert.equal(rec.pass, true, "가짜 모델이 정답을 적용했으므로 통과해야 한다");
    assert.ok(rec.toolCalls >= steps.length && rec.turns >= steps.length, "도구 호출/턴이 집계되어야 한다");
  }
  console.log("pipeline e2e OK");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
