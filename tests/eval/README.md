# 로컬 모델 평가 세트

가이드나 확장을 바꿨을 때 약한 로컬 모델의 결과가 정말 좋아졌는지 재는 개발자 도구입니다. 배포 ZIP에는 들어가지 않고, 사용자 설치와도 관계없습니다.

**필요한 것:** 저장소를 체크아웃하고 `npm ci`로 pi를 설치한 개발 PC, C++ 컴파일러(`c++`/`g++`), 그리고 원하면 `clangd`.

> 성공률·턴 수·도구 호출 수는 **모델과 설정에 따라 크게 달라집니다.** 같은 모델로 같은 과제를 여러 번(`--repeat`) 돌려 비교하고, 모델을 바꾸면 기준 점수를 다시 재세요. 이 저장소의 샘플 과제 점수는 사내 작업 성능을 대표하지 않습니다.

## 구성

```
tests/eval/
  run.mjs           러너 (Node ESM)
  lib.mjs           과제 검증·판정 로직
  eval.test.mjs     모델 없이 돌리는 검증 (npm test에 포함)
  fake-model.mjs    가짜 OpenAI 호환 서버 (파이프라인 확인용)
  pipeline-e2e.mjs  가짜 모델로 러너 전체를 확인 (수동 실행)
  tasks/<id>/       샘플 과제 6개 (C++)
```

## 실행

모델 설정은 `config/models.example.json`을 복사해 개발 PC에서 만듭니다. 키가 든 파일은 커밋하지 마세요(`/models.json`, `/config/models.json`은 gitignore 대상입니다).

```
node tests/eval/run.mjs --models-json ./models.json --provider <provider> --model <model id>
```

같은 값을 환경 변수로도 줄 수 있습니다: `EVAL_MODELS_JSON`, `EVAL_PROVIDER`, `EVAL_MODEL`, `EVAL_TASKS`, `EVAL_PI`, `EVAL_CLANGD`, `EVAL_CXX`.

| 옵션 | 설명 |
|---|---|
| `--tasks <dir>` | 과제 폴더. 기본은 `tests/eval/tasks` |
| `--filter a,b` | 일부 과제만 실행 |
| `--repeat N` | 과제마다 N번 반복 (약한 모델은 편차가 큽니다) |
| `--disable a,b` | 지정한 확장을 끄고 실행 |
| `--only a,b` | 지정한 확장만 켜고 실행 |
| `--ab a,b` | 모두 켠 설정(`all`)과 하나씩 끈 설정(`no-a`, `no-b`)을 한 번에 실행 |
| `--ext <path>` | 확장 파일을 추가로 로드 (여러 번 지정 가능, 예: 벤더 확장) |
| `--no-guide` | `config/AGENTS.md` 가이드 없이 실행 |
| `--pi <path>` | 다른 pi 실행 파일 (`.js`면 node로 실행). 기본은 `node_modules`의 pi |
| `--out <dir>` | 결과 폴더. 기본은 `tests/eval/results/<시각>/` (gitignore 대상) |
| `--keep` | 작업 폴더를 지우지 않고 `results.json`에 경로를 남김 |
| `--dry-run` | 모델을 부르지 않고 과제와 설정만 검증 |

확장 이름은 `extensions/` 아래 폴더 이름(`cpp-csharp-lsp-lite`, `verify-guard`)과 동봉 확장 `pi-lens`, `pi-subagents`입니다. `lsp`는 `cpp-csharp-lsp-lite`의 별칭입니다. 기본 실행은 배포본처럼 모두 켜고 `config/settings.json`·`config/pi-lens.json`·`config/extensions/subagent/config.json`을 그대로 씁니다.

### A/B 비교

```
node tests/eval/run.mjs --models-json ./models.json --provider corp --model my-model --repeat 3 --ab verify-guard
```

`all`과 `no-verify-guard`의 성공률, 평균 턴, 평균 도구 호출, 반복 실패 합계, 평균 시간이 `summary.md`에 나란히 나옵니다. 원본 데이터는 `results.json`, pi의 JSON 이벤트 로그는 `logs/`에 있습니다.

### 기록하는 값

| 값 | 뜻 |
|---|---|
| pass/fail | 판정 명령과 `expect`를 모두 통과하고 시간·턴 예산 안이면 pass |
| turns | 모델 응답 턴 수 |
| toolCalls | 도구 호출 수 |
| repeatedFailures | 이미 실패한 것과 같은 도구+인자 호출이 또 실패한 횟수 |
| wallSec | pi 실행 시간 (판정 시간 제외) |

## 과제 만들기

과제 하나가 폴더 하나입니다.

```
<id>/
  task.json     프롬프트, 판정, 예산
  project/      pi가 작업할 시작 상태 (임시 폴더로 복사됨)
  solution/     정답 파일 (dry-run 검증 전용, pi에는 보이지 않음)
  judge/        (선택) 판정 직전에 덮어쓸 파일
```

`judge/`는 모델이 테스트 파일을 고쳐도 원본으로 되돌리거나, 숨긴 테스트를 넣을 때 씁니다.

`task.json` 예:

```json
{
  "id": "cpp-bugfix-off-by-one",
  "title": "범위 합계 경계값 버그 수정",
  "language": "cpp",
  "prompt": "pi에 그대로 전달할 요청",
  "judge": [
    { "name": "build", "cmd": "{cxx} -std=c++17 -Wall -o check{exe} range.cpp test.cpp" },
    { "name": "test", "cmd": ".{sep}check{exe}" }
  ],
  "expect": [{ "file": "range.cpp", "contains": "sum_range" }],
  "budget": { "timeoutSec": 300, "maxTurns": 20 }
}
```

- **`id`:** 폴더 이름과 같아야 합니다.
- **`judge`:** 작업 폴더에서 차례로 실행하는 셸 명령입니다. 하나라도 실패하면 과제 실패입니다.
  - `expectFail: true`이면 명령이 실패해야 통과입니다(변이 검사용).
  - `overlay: "<폴더>"`를 주면 그 단계 직전에 과제 폴더 안의 해당 폴더를 덮어씁니다. 예를 들어 `cpp-add-test`는 버그 있는 `stack.h`를 덮어써 작성된 테스트가 실패하는지 봅니다.
- **명령 안의 치환:** `{cxx}`는 `EVAL_CXX`(없으면 `c++`, Windows는 `g++`), `{exe}`는 Windows에서 `.exe`, `{sep}`는 경로 구분자로 바뀝니다.
- **`expect`:** 결과물에 대한 조건입니다. `contains`, `notContains`, `regex`(+`minMatches`) 중 하나 이상을 씁니다. 판정 명령이 모두 통과한 뒤 검사합니다.
- **`budget`:** `timeoutSec`를 넘기면 프로세스를 끝내고 실패로 칩니다. `maxTurns`를 넘기면 판정을 통과해도 실패(`overBudget`)입니다.
- **판정 기준:** 최종 결과물만 봅니다. 어떤 도구를 썼는지는 보지 않습니다.
- **`solution/`:** 새 과제에는 꼭 함께 만드세요. `eval.test.mjs`가 "원본은 실패, 정답을 넣으면 통과"를 자동으로 확인합니다.

## 사내 과제는 저장소 밖에

사내 코드와 과제는 저장소에 넣지 않습니다. 저장소 밖 폴더에 같은 형식으로 만들고 `--tasks`로 지정합니다.

```
D:\eval-internal\
  bug-001\task.json, project\, solution\, judge\
  refactor-002\...
```

```
node tests/eval/run.mjs --tasks D:\eval-internal --models-json .\models.json --provider corp --model my-model
```

- **`project/` 만들기:** 사내 코드의 작은 발췌본이나 그것을 본뜬 축소 프로젝트로 만듭니다. 빌드는 개발 PC의 기존 환경을 씁니다.
- **C# 과제:** `judge`에 `dotnet build`·`dotnet test`를 씁니다. 기존 SDK와 NuGet 설정을 그대로 쓰고, 이 도구는 패키지 소스를 바꾸지 않습니다.
- **처음 돌리기 전에:** `--dry-run`으로 형식을 확인하고, 각 과제의 `solution/`이 실제로 통과하는지 봅니다. 확인 방식은 `tests/eval/eval.test.mjs`를 참고하세요.
- **기준 점수:** 사내 모델로 사내 과제를 `--repeat 3` 이상 돌려서 사내에서 기록합니다.
- **커밋 금지:** API 키나 사내 주소가 든 `models.json`, 외부 과제 폴더는 저장소에 넣지 않습니다.

## 러너 자체 검증 (모델 없이)

```
npm test                                  # eval.test.mjs 포함
node --test tests/eval/eval.test.mjs      # 단독 실행
node tests/eval/pipeline-e2e.mjs          # 가짜 모델로 pi 실행부터 판정·집계까지 확인
```

- `eval.test.mjs`는 `task.json`이 올바른지, 원본은 판정에 실패하고 `solution/`을 넣으면 통과하는지 확인합니다. C++ 컴파일러가 없으면 판정 테스트는 건너뜁니다.
- `pipeline-e2e.mjs`는 가짜 서버가 `write` 도구로 `solution/`을 적용하게 해 러너 전체 경로를 확인합니다. 모델 성능과는 관계없습니다.
