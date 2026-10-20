// 평가 러너의 순수 로직: 과제 로딩/검증, 작업 폴더 준비, 판정. 실제 모델 없이 테스트할 수 있다.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_BUDGET = { timeoutSec: 300, maxTurns: 30 };

/** 판정 명령의 {cxx} {exe} {sep} 자리표시자를 현재 OS/환경에 맞게 바꾼다. */
export function expandCommand(cmd, env = process.env) {
  const win = process.platform === "win32";
  return cmd
    .replaceAll("{cxx}", env.EVAL_CXX || (win ? "g++" : "c++"))
    .replaceAll("{exe}", win ? ".exe" : "")
    .replaceAll("{sep}", win ? "\\" : "/");
}

export function listTaskDirs(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "task.json")))
    .map((e) => join(root, e.name))
    .sort();
}

export function loadTask(dir) {
  const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
  return { ...task, dir, budget: { ...DEFAULT_BUDGET, ...(task.budget ?? {}) } };
}

/** task.json과 폴더 구조를 검사해 오류 메시지 배열을 반환한다. */
export function validateTask(task, folderName) {
  const errors = [];
  const bad = (m) => errors.push(`${folderName}: ${m}`);
  if (typeof task.id !== "string" || task.id !== folderName) bad(`id는 폴더 이름(${folderName})과 같아야 한다`);
  if (typeof task.title !== "string" || !task.title) bad("title이 필요하다");
  if (typeof task.prompt !== "string" || task.prompt.trim().length < 10) bad("prompt가 필요하다");
  if (!Array.isArray(task.judge) || task.judge.length === 0) bad("judge 단계가 1개 이상 필요하다");
  else task.judge.forEach((s, i) => {
    if (typeof s.name !== "string" || typeof s.cmd !== "string") bad(`judge[${i}]에 name/cmd가 필요하다`);
    if (s.overlay && task.dir && !existsSync(join(task.dir, s.overlay))) bad(`judge[${i}].overlay 폴더(${s.overlay})가 없다`);
  });
  for (const [i, e] of (task.expect ?? []).entries()) {
    if (typeof e.file !== "string") bad(`expect[${i}]에 file이 필요하다`);
    if (!("contains" in e || "notContains" in e || "regex" in e)) bad(`expect[${i}]에 contains/notContains/regex 중 하나가 필요하다`);
    if (e.regex) try { new RegExp(e.regex, "g"); } catch { bad(`expect[${i}].regex가 올바르지 않다`); }
  }
  const b = task.budget ?? {};
  for (const k of ["timeoutSec", "maxTurns"]) if (!(b[k] > 0)) bad(`budget.${k}가 양수여야 한다`);
  const dir = task.dir;
  if (dir) {
    if (!existsSync(join(dir, "project"))) bad("project/ 폴더가 필요하다");
    if (!existsSync(join(dir, "solution"))) bad("solution/ 폴더가 필요하다 (dry-run 검증용 정답)");
  }
  return errors;
}

export function prepareWorkdir(task, dest) {
  cpSync(join(task.dir, "project"), dest, { recursive: true });
}

/** 과제 폴더의 하위 폴더(judge/, solution/)를 작업 폴더 위에 덮어쓴다. */
export function applyOverlay(taskDir, sub, dest) {
  const src = join(taskDir, sub);
  if (existsSync(src) && statSync(src).isDirectory()) cpSync(src, dest, { recursive: true });
}

export function checkExpectations(expect, workdir) {
  const failures = [];
  for (const e of expect ?? []) {
    const path = join(workdir, e.file);
    if (!existsSync(path)) { failures.push(`${e.file}: 파일 없음`); continue; }
    const text = readFileSync(path, "utf8");
    if ("contains" in e && !text.includes(e.contains)) failures.push(`${e.file}: "${e.contains}" 없음`);
    if ("notContains" in e && text.includes(e.notContains)) failures.push(`${e.file}: "${e.notContains}" 남아 있음`);
    if (e.regex) {
      const n = (text.match(new RegExp(e.regex, "g")) ?? []).length;
      if (n < (e.minMatches ?? 1)) failures.push(`${e.file}: /${e.regex}/ ${n}회 (최소 ${e.minMatches ?? 1})`);
    }
  }
  return failures;
}

/** 작업 폴더에서 판정한다. 판정용 overlay(judge/)를 먼저 덮어쓴 뒤 명령과 기대 조건을 검사한다. */
export function runJudge(task, workdir, { env = process.env, stepTimeoutMs = 120000 } = {}) {
  applyOverlay(task.dir, "judge", workdir);
  const steps = [];
  let passed = true;
  for (const step of task.judge) {
    if (step.overlay) applyOverlay(task.dir, step.overlay, workdir);
    const r = spawnSync(expandCommand(step.cmd, env), { cwd: workdir, shell: true, encoding: "utf8", timeout: stepTimeoutMs, env });
    const ok = step.expectFail ? r.status !== 0 && !r.error : r.status === 0;
    steps.push({ name: step.name, ok, status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-1500) });
    if (!ok) { passed = false; break; }
  }
  const expectFailures = passed ? checkExpectations(task.expect, workdir) : [];
  if (expectFailures.length) passed = false;
  return { passed, steps, expectFailures };
}
