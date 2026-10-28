# 모델에 보이는 도구·스킬

도구가 많으면 작은 모델은 고르는 데 헷갈리고 프롬프트도 길어집니다. 그래서 기본으로는 꼭 필요한 도구만 보여 주고, 나머지는 모델이 필요할 때 켜게 합니다.

## 기본 도구

처음 모델 요청에 보이는 도구는 대화형 화면에서 13개입니다.

- 파일 작업 7개: `read`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`
- `find_symbol`, `lsp_diagnostics`
- `ask_user_question`: 방향을 정해야 할 때 선택지로 사용자에게 묻는 대화 상자 (rpiv-ask-user-question). 화면이 없는 `pi -p` 실행에서는 확장이 스스로 숨깁니다.
- `todo`: 여러 단계 작업의 진행 목록 (rpiv-todo). 상태는 세션 기록에 남고 `/todos`로 봅니다.
- `harness_tools`: 아래 그룹을 켜고 끄는 도구
- `tool_search`: MCP 도구를 찾아 다음 요청부터 노출하는 pi 내장 도구 (아래 [MCP 도구](#mcp-도구))

도구를 숨겨도 안전장치 확장과 편집 후 진단은 그대로 동작합니다.

## 필요할 때 켜는 그룹

| 그룹 | 추가되는 도구 |
| --- | --- |
| `code` | `lsp_symbols`, `lsp_definition`, `lsp_references`, `lsp_hover`, `module_report`, `read_symbol` |
| `ast` | `ast_grep_search`, `ast_grep_replace`, `pi_lens_activate_tools` |
| `subagents` | `subagents_enable`, `subagent`, `bg_wait`, `subagent_supervisor` |

```text
harness_tools({"group":"code"})
harness_tools({"action":"list"})
harness_tools({"action":"disable","group":"code"})
```

- 켠 도구는 **다음 모델 요청부터** 쓸 수 있습니다. 켜는 것만으로 작업이 실행되지는 않습니다.
- 선택은 현재 세션에만 적용됩니다. 새 세션은 기본 목록으로 시작합니다.
- 서브에이전트 위임은 사용자·프로젝트 지시가 허락한 범위에서만 실행합니다.
- Python은 따로 도구가 없습니다. `powershell` 도구에서 동봉 `python`을 실행합니다.

## MCP 도구

MCP 서버는 pi 내장 MCP 기능이 [config/mcp.json](../config/mcp.json)에서 읽습니다. `harness_tools` 그룹이 아니라 서버의 `exposure`로 노출을 정합니다.

- 동봉 빌드센터 서버(`build_center`)는 `"exposure": "deferred"`입니다. 도구 스키마는 처음에 보내지 않고, 시스템 프롬프트의 `mcp_servers` 섹션에 서버 이름과 한 줄 설명만 넣습니다.
- 모델이 `tool_search({"query":"빌드센터 모듈 결과"})`를 호출하면 찾은 `mcp__build_center__*` 도구가 다음 요청부터 노출됩니다. 노출된 도구는 그 세션 분기에 남습니다.
- pi는 세션을 시작할 때 서버를 백그라운드로 띄우고 세션 동안 재사용합니다. 첫 요청은 `deferred` 서버를 기다리지 않습니다.
- 사내 MCP 서버를 추가할 때도 같은 파일에 적습니다. 도구가 적고 자주 쓰면 `direct`, 많으면 `deferred`를 권합니다. 형식은 [pi MCP 문서](../node_modules/@earendil-works/pi-coding-agent/docs/mcp.md)와 같습니다. 비밀값은 파일에 적지 말고 `${환경 변수}`로 참조하세요. 새 배포본을 적용하면 이 파일이 배포본 기본값으로 바뀔 수 있으니, 프로젝트 전용 서버는 신뢰한 프로젝트의 `.pi/mcp.json`에 두세요.
- allowlist-gate는 `mcp:build_center` 규칙으로 빌드센터 도구를 묻지 않고 실행합니다. 다른 MCP 서버의 도구는 승인을 받습니다.

## 어떻게 동작하나

- `extensions/tool-profile/index.ts`가 이 일을 합니다. 확장 목록의 마지막에 로드되어 `session_start`와 `before_agent_start`에서, 다른 확장이 다시 켠 선택 도구까지 걸러 냅니다.
- 이 배포본의 선택 도구 이름만 관리합니다. 사용자·프로젝트가 추가한 도구는 그대로 둡니다.
- pi-lens와 겹치는 도구(`lens_diagnostics`, `symbol_search`, `project_report`, `read_enclosing`, `effective_config`, `ast_grep_outline`, `lens_diagnostic_mark`, `lsp_navigation`)는 [config/pi-lens.json](../config/pi-lens.json) 설정 때문에 아예 등록되지 않습니다. 이 파일을 바꾸면 기본 노출도 달라질 수 있습니다.

## 스킬과 프롬프트

- 루트 `package.json`의 스킬·프롬프트 목록은 비어 있습니다.
- pi-lens가 자동으로 추가하는 스킬은 `ast` 그룹을, 서브에이전트 카탈로그는 `subagents` 그룹을 켰을 때만 광고합니다. 사용자·프로젝트가 추가한 스킬과 다른 시스템 섹션은 그대로 둡니다.
- 외부 확장의 파일은 `vendor/extensions`에 모두 동봉하므로 필요하면 `read`로 읽거나 직접 등록할 수 있습니다.
- 공통 필수 규칙은 [config/AGENTS.md](../config/AGENTS.md)에, 긴 호출 예시와 운영 설명은 [tool-guide.md](tool-guide.md)에 둡니다.

## 얼마나 줄었나

`tests/prompt-footprint.py`는 임시 프로젝트와 로컬 OpenAI 호환 API로 실제 pi의 첫 요청을 캡처합니다. macOS Node CLI에서, Redis 도구가 들어간 변경 전 상태와 비교한 결과입니다.

| 항목 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| 광고 도구 | 21 | 7 |
| 시스템 메시지 직렬화 문자 수 | 14,299 | 5,898 |
| 도구 스키마 직렬화 문자 수 | 18,126 | 4,412 |
| 합계 | 32,425 | 10,310 |

합계가 약 68.2% 줄었습니다. 측정할 때 로컬에 등록된 사용자 스킬은 그대로 두었습니다. 원본 측정값과 도구별 크기는 [prompt-footprint.json](prompt-footprint.json)에 있습니다.

- **Windows 토큰 수가 아닙니다.** Windows는 내장 도구 구성과 토크나이저가 달라서, 이 수치를 Windows의 토큰 수로 읽으면 안 됩니다. 광고 도구 수가 위의 기본 10개와 다른 것도 이 때문입니다.
- **Windows CI의 검사:** 옮긴 ZIP으로 첫 요청 크기를 측정하고, 선택 도구가 처음에 숨겨지는지·켜지는지·Redis 도구가 꺼지는지 확인합니다.
- **정답률과는 별개입니다.** 프롬프트가 줄었다는 것만으로 모델 정답률이 올랐다고 말할 수는 없습니다.
