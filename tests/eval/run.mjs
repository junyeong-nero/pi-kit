// 로컬 모델 평가 러너 (개발자 도구, 배포 ZIP에 포함하지 않는다). 사용법은 tests/eval/README.md 참고.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { listTaskDirs, loadTask, prepareWorkdir, runJudge, validateTask } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../..");
const EXT_ALIASES = { lsp: "cpp-csharp-lsp-lite" };

// setup.ps1이 함께 불러오는 동봉 확장. 배포본과 같은 구성으로 평가하려고 있으면 포함한다.
const VENDOR_EXTENSIONS = {
  "pi-lens": "vendor/extensions/node_modules/pi-lens/dist/index.js",
  "pi-subagents": "vendor/extensions/node_modules/pi-subagents/index.js",
};

/** extensions/ 아래에서 index.ts를 가진 확장과 동봉 확장을 이름 -> 진입점으로 나열한다. */
export function discoverExtensions(root = repoRoot) {
  const dir = join(root, "extensions");
  const found = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(dir, e.name, "index.ts"))) found[e.name] = join(dir, e.name, "index.ts");
  }
  for (const [name, entry] of Object.entries(VENDOR_EXTENSIONS)) {
    if (existsSync(join(root, entry))) found[name] = join(root, entry);
  }
  return found;
}

export function parseList(value) {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => EXT_ALIASES[s] ?? s);
}

/** pi --mode json 출력(JSON Lines)에서 턴, 도구 호출, 반복 실패 횟수를 센다. */
export function collectMetrics(lines) {
  let turns = 0, assistantMessages = 0, toolCalls = 0, failedCalls = 0, repeatedFailures = 0;
  const failedKeys = new Set();
  const pending = new Map();
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "turn_start") turns++;
    else if (ev.type === "message_end" && ev.message?.role === "assistant") assistantMessages++;
    else if (ev.type === "tool_execution_start") pending.set(ev.toolCallId, ev.args);
    else if (ev.type === "tool_execution_end") {
      toolCalls++;
      if (ev.isError) {
        failedCalls++;
        const key = `${ev.toolName}\0${JSON.stringify(ev.args ?? pending.get(ev.toolCallId) ?? null)}`;
        if (failedKeys.has(key)) repeatedFailures++;
        failedKeys.add(key);
      }
    }
  }
  return { turns: turns || assistantMessages, toolCalls, failedCalls, repeatedFailures };
}

function piCommand(pi) {
  return pi.endsWith(".js") || pi.endsWith(".mjs") ? { cmd: process.execPath, pre: [pi] } : { cmd: pi, pre: [] };
}

/** 과제 1개를 한 번 실행하고 결과 레코드를 반환한다. */
export async function runOne(task, cfg, opts) {
  const tmp = mkdtempSync(join(tmpdir(), `eval-${task.id}-`));
  const work = join(tmp, "work"), agent = join(tmp, "agent");
  mkdirSync(agent);
  prepareWorkdir(task, work);
  copyFileSync(opts.modelsJson, join(agent, "models.json"));
  if (opts.guide && existsSync(join(repoRoot, "config/AGENTS.md"))) copyFileSync(join(repoRoot, "config/AGENTS.md"), join(agent, "AGENTS.md"));
  // 배포본 기본값(defaultTools)과 서브에이전트 설정을 배포본 config/와 같게 맞춘다.
  copyFileSync(join(repoRoot, "config/settings.json"), join(agent, "settings.json"));
  mkdirSync(join(agent, "extensions/subagent"), { recursive: true });
  copyFileSync(join(repoRoot, "config/extensions/subagent/config.json"), join(agent, "extensions/subagent/config.json"));
  const lspConfig = join(tmp, "lsp.json");
  writeFileSync(lspConfig, JSON.stringify({ servers: { cpp: { command: opts.clangd, args: ["--log=error"] } } }));
  const args = [];
  for (const [name, entry] of Object.entries(opts.extensions)) if (!cfg.disabled.includes(name)) args.push("-e", entry);
  for (const extra of opts.extraExtensions) args.push("-e", extra);
  args.push("--no-session", "--provider", opts.provider, "--model", opts.model, "--mode", "json", "-p", task.prompt);
  const { cmd, pre } = piCommand(opts.pi);
  const env = { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agent, HARNESS_LSP_CONFIG: lspConfig,
    PI_LENS_HOME: join(tmp, "lens"), PI_LENS_CONFIG_PATH: join(repoRoot, "config/pi-lens.json"), PI_LENS_DISABLE_LSP_INSTALL: "1", PI_LENS_DISABLE_TOOL_INSTALL: "1" };
  const started = Date.now();
  let stdout = "", stderr = "", timedOut = false;
  const child = spawn(cmd, [...pre, ...args], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, task.budget.timeoutSec * 1000);
  const exitCode = await new Promise((done) => { child.on("close", done); child.on("error", () => done(-1)); });
  clearTimeout(timer);
  const wallSec = Math.round((Date.now() - started) / 100) / 10;
  const metrics = collectMetrics(stdout.split("\n"));
  const judge = runJudge(task, work);
  const overBudget = metrics.turns > task.budget.maxTurns;
  const record = {
    task: task.id, config: cfg.label, disabled: cfg.disabled,
    // 예산(턴 수/시간)을 넘기면 판정을 통과해도 실패로 센다.
    pass: judge.passed && !timedOut && !overBudget,
    judgePassed: judge.passed, timedOut, overBudget, exitCode, wallSec, ...metrics,
    failedStep: judge.steps.find((s) => !s.ok)?.name ?? null, expectFailures: judge.expectFailures,
    judgeOutput: judge.steps.find((s) => !s.ok)?.output ?? "",
  };
  if (opts.logDir) {
    mkdirSync(opts.logDir, { recursive: true });
    const base = join(opts.logDir, `${cfg.label}__${task.id}__${opts.runIndex}`);
    writeFileSync(`${base}.jsonl`, stdout);
    if (stderr) writeFileSync(`${base}.stderr.txt`, stderr);
  }
  if (opts.keep) record.workdir = work; else rmSync(tmp, { recursive: true, force: true });
  return record;
}

export function summarize(records, meta) {
  const configs = [...new Set(records.map((r) => r.config))];
  const rows = configs.map((label) => {
    const rs = records.filter((r) => r.config === label);
    const sum = (k) => rs.reduce((a, r) => a + r[k], 0);
    return { label, runs: rs.length, passed: rs.filter((r) => r.pass).length, turns: sum("turns") / rs.length, toolCalls: sum("toolCalls") / rs.length, repeatedFailures: sum("repeatedFailures"), wallSec: sum("wallSec") / rs.length };
  });
  const f = (n) => (Math.round(n * 10) / 10).toString();
  let md = `# 평가 결과\n\n- 모델: ${meta.provider}/${meta.model}\n- 실행 시각: ${meta.startedAt}\n- 결과는 이 모델·이 설정에서만 유효하다. 모델이 바뀌면 다시 측정한다.\n\n`;
  md += "## 설정별 요약\n\n| 설정 | 성공 | 성공률 | 평균 턴 | 평균 도구 호출 | 반복 실패 합계 | 평균 시간(초) |\n|---|---|---|---|---|---|---|\n";
  for (const r of rows) md += `| ${r.label} | ${r.passed}/${r.runs} | ${Math.round((100 * r.passed) / r.runs)}% | ${f(r.turns)} | ${f(r.toolCalls)} | ${r.repeatedFailures} | ${f(r.wallSec)} |\n`;
  md += "\n## 과제별\n\n| 과제 | 설정 | 결과 | 턴 | 도구 호출 | 반복 실패 | 시간(초) | 비고 |\n|---|---|---|---|---|---|---|---|\n";
  for (const r of records) {
    const note = r.timedOut ? "시간 초과" : r.overBudget ? "턴 예산 초과" : r.failedStep ? `판정 실패: ${r.failedStep}` : r.expectFailures.length ? r.expectFailures[0] : "";
    md += `| ${r.task} | ${r.config} | ${r.pass ? "PASS" : "FAIL"} | ${r.turns} | ${r.toolCalls} | ${r.repeatedFailures} | ${r.wallSec} | ${note} |\n`;
  }
  return md;
}

export function buildConfigs({ disable, only, ab, allNames }) {
  if (ab) {
    const names = parseList(ab);
    return [{ label: "all", disabled: [] }, ...names.map((n) => ({ label: `no-${n}`, disabled: [n] }))];
  }
  const disabled = only ? allNames.filter((n) => !parseList(only).includes(n)) : parseList(disable);
  const label = only ? `only-${parseList(only).join("+")}` : disabled.length ? `no-${disabled.join("+")}` : "all";
  return [{ label, disabled }];
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      tasks: { type: "string" }, filter: { type: "string" }, "models-json": { type: "string" }, provider: { type: "string" }, model: { type: "string" },
      pi: { type: "string" }, disable: { type: "string" }, only: { type: "string" }, ab: { type: "string" }, repeat: { type: "string", default: "1" },
      out: { type: "string" }, label: { type: "string" }, clangd: { type: "string" }, "no-guide": { type: "boolean" }, keep: { type: "boolean" },
      "dry-run": { type: "boolean" }, ext: { type: "string", multiple: true }, help: { type: "boolean", short: "h" },
    },
  });
  if (v.help) { console.log("사용법: node tests/eval/run.mjs --provider <p> --model <m> --models-json <path> [--tasks <dir>] [--filter id1,id2] [--disable ext,..|--only ext,..|--ab ext,..] [--repeat N] [--out dir]\n자세한 내용: tests/eval/README.md"); return; }
  const tasksRoot = resolve(v.tasks ?? process.env.EVAL_TASKS ?? join(here, "tasks"));
  const wanted = v.filter ? v.filter.split(",").map((s) => s.trim()) : null;
  const tasks = listTaskDirs(tasksRoot).map(loadTask).filter((t) => !wanted || wanted.includes(t.id));
  const errors = tasks.flatMap((t) => validateTask(t, t.dir.split(/[\\/]/).pop()));
  if (errors.length) { console.error(errors.join("\n")); process.exit(2); }
  if (!tasks.length) { console.error(`실행할 과제가 없다: ${tasksRoot}`); process.exit(2); }
  const extensions = discoverExtensions();
  const configs = buildConfigs({ disable: v.disable, only: v.only, ab: v.ab, allNames: Object.keys(extensions) });
  for (const n of configs.flatMap((c) => c.disabled)) if (!extensions[n]) { console.error(`알 수 없는 확장: ${n} (사용 가능: ${Object.keys(extensions).join(", ")})`); process.exit(2); }
  if (v["dry-run"]) { console.log(`과제 ${tasks.length}개 검증 통과: ${tasks.map((t) => t.id).join(", ")}\n설정: ${configs.map((c) => c.label).join(", ")}`); return; }

  const modelsJson = resolve(v["models-json"] ?? process.env.EVAL_MODELS_JSON ?? "models.json");
  const provider = v.provider ?? process.env.EVAL_PROVIDER, model = v.model ?? process.env.EVAL_MODEL;
  if (!provider || !model) { console.error("--provider/--model (또는 EVAL_PROVIDER/EVAL_MODEL)이 필요하다."); process.exit(2); }
  if (!existsSync(modelsJson)) { console.error(`models.json을 찾을 수 없다: ${modelsJson}`); process.exit(2); }
  const pi = v.pi ?? process.env.EVAL_PI ?? join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  if (!existsSync(pi)) { console.error(`pi 실행 파일을 찾을 수 없다: ${pi} (--pi 또는 EVAL_PI)`); process.exit(2); }
  const startedAt = new Date().toISOString();
  const outDir = resolve(v.out ?? join(here, "results", startedAt.replace(/[:.]/g, "-")));
  mkdirSync(outDir, { recursive: true });
  const repeat = Math.max(1, Number(v.repeat));
  const records = [];
  for (const cfg of configs) for (const task of tasks) for (let i = 1; i <= repeat; i++) {
    const rec = await runOne(task, cfg, { modelsJson, provider, model, pi, extensions, extraExtensions: v.ext ?? [], clangd: v.clangd ?? process.env.EVAL_CLANGD ?? "clangd", guide: !v["no-guide"], keep: v.keep, logDir: join(outDir, "logs"), runIndex: i });
    records.push(rec);
    console.log(`[${cfg.label}] ${task.id} #${i}: ${rec.pass ? "PASS" : "FAIL"} turns=${rec.turns} tools=${rec.toolCalls} repeats=${rec.repeatedFailures} ${rec.wallSec}s`);
  }
  const meta = { provider, model, startedAt, label: v.label ?? null, repeat, tasksRoot };
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ meta, records }, null, 2));
  const md = summarize(records, meta);
  writeFileSync(join(outDir, "summary.md"), md);
  console.log(`\n${md}\n결과 저장: ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
