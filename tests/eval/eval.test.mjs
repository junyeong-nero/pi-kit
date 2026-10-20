// 모델 없이 과제 정의와 판정 로직을 검증한다: node --test tests/eval/eval.test.mjs
// 각 과제는 원본에서 판정 실패, solution/ 적용 후 판정 통과여야 한다. C++ 컴파일러(c++ 또는 EVAL_CXX)가 필요하다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyOverlay, checkExpectations, expandCommand, listTaskDirs, loadTask, prepareWorkdir, runJudge, validateTask } from "./lib.mjs";

const tasksRoot = join(dirname(fileURLToPath(import.meta.url)), "tasks");
const dirs = listTaskDirs(tasksRoot);
const hasCompiler = spawnSync(expandCommand("{cxx} --version"), { shell: true }).status === 0;

test("샘플 과제는 5개 이상이며 task.json이 유효하다", () => {
  assert.ok(dirs.length >= 5);
  const errors = dirs.flatMap((dir) => validateTask(loadTask(dir), dir.split(/[\\/]/).pop()));
  assert.deepEqual(errors, []);
});

test("validateTask가 잘못된 정의를 거부한다", () => {
  const errors = validateTask({ id: "x", title: "", prompt: "짧음", judge: [], expect: [{ file: "a" }], budget: { timeoutSec: 0, maxTurns: 1 } }, "y");
  assert.ok(errors.length >= 5, errors.join("\n"));
});

test("checkExpectations", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-expect-"));
  try {
    prepareWorkdir({ dir: join(tasksRoot, "cpp-bugfix-off-by-one") }, dir);
    assert.deepEqual(checkExpectations([{ file: "range.cpp", contains: "sum_range" }, { file: "range.cpp", regex: "int", minMatches: 2 }], dir), []);
    assert.equal(checkExpectations([{ file: "range.cpp", notContains: "sum_range" }, { file: "none.cpp", contains: "x" }], dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const dir of dirs) {
  const id = dir.split(/[\\/]/).pop();
  test(`판정: ${id} - 원본은 실패, 정답 적용 후 통과`, { skip: !hasCompiler && "C++ 컴파일러 없음" }, () => {
    const task = loadTask(dir);
    const work = mkdtempSync(join(tmpdir(), "eval-judge-"));
    try {
      prepareWorkdir(task, work);
      const before = runJudge(task, work);
      assert.equal(before.passed, false, "원본 상태에서 판정이 통과하면 안 된다");
      applyOverlay(dir, "solution", work);
      const after = runJudge(task, work);
      assert.equal(after.passed, true, JSON.stringify(after, null, 2));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
