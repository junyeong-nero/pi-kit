# pi-offline-kit

폐쇄망 Windows PC에서 사내 AI 모델로 C++·C# 코드를 읽고 고치기 위한 pi 배포본입니다. 언어 서버로 정의·참조·타입을 조회하고, 작은 로컬 모델이 흔히 저지르는 실수(검증 없이 끝내기, 같은 실패 반복, 긴 출력에 묻히기)를 확장이 잡아 줍니다.

## 설치

완성 ZIP은 아래 Releases에서 배포합니다. 아직 Release가 없다면 첫 Windows 빌드·검증과 게시가 끝나지 않은 상태입니다. 소스 ZIP으로 대신 설치하지 마세요.

1. [GitHub Releases](https://github.com/junyeong-nero/pi-offline-kit/releases)에서 최신 `v*` 릴리스의 **pi-offline-kit-win-x64.zip**을 받습니다. GitHub의 소스 코드 **Download ZIP**은 실행할 수 없습니다.
2. 폐쇄망 PC에 풀고 `config\models.json`에 사내 API 주소·모델을 적은 뒤 API 키를 시스템 변수로 등록합니다.
3. 배포 폴더에서 `.\setup.ps1`을 한 번 실행하고, 새 터미널의 아무 폴더에서 `pi`를 실행합니다.

ZIP에 pi, 언어 서버, SDK, 확장과 동봉 도구가 모두 들어 있어 추가로 설치할 것이 없습니다. 단계별 명령, 문제 해결, 업데이트, SVN·Redis 사용법은 [설치와 설정](docs/installation.md)에 있습니다.

## 스킬 (명령으로만 실행)

| 명령 | 하는 일 |
| --- | --- |
| `/skill:plan <작업>` | 구현하지 않고 현재 코드를 조사해 어떻게 구현할지(변경 계획·위험·검증)만 설명합니다. 승인 전에는 파일을 고치지 않습니다. |
| `/skill:align <요청>` | 요청을 어떻게 이해했는지 말하고, 한 번에 하나씩 질문하며 목표·범위·성공 기준을 합의합니다. 합의 요약을 확인받으면 멈춥니다. |

두 스킬은 프롬프트에 광고되지 않아 토큰을 쓰지 않습니다. 내용은 `skills\<이름>\SKILL.md`에 있습니다.

## 도구 사용 가이드

[config/AGENTS.md](config/AGENTS.md)는 pi 설정 폴더의 전역 AGENTS.md라서 모든 프로젝트에서 모델 컨텍스트에 들어갑니다. 모든 프로젝트에 공통으로 줄 규칙이 있으면 이 파일에 더하세요. 가이드에는 이런 내용이 있습니다.

- 작업 순서: 찾기 → 검색 → 읽기 → LSP 확인 → 수정 → 검증
- 도구별 호출 예시: LSP, `find_symbol`, `module_report`, `edit`, fd, rg
- 여러 파일을 바꿀 때 계획을 먼저 쓰는 규칙
- 작업 시나리오: 시그니처 변경, 사용처 찾기, 빌드 에러 수정, 새 파일 추가

가이드는 모델의 선택을 돕는 지침일 뿐, 정확한 도구 사용을 보장하지는 않습니다.

## 확장

배포 폴더 자체가 pi 패키지입니다. `package.json`의 `pi` 항목에 아래 확장과 스킬이 등록되어 있고, `config/settings.json`의 `"packages": [".."]`가 이 패키지를 불러옵니다.

| 확장 | 하는 일 |
|---|---|
| harness-env | 다른 확장보다 먼저 로드되어 언어 서버 설정·pi-lens 설정·동봉 도구 경로를 채움. 기본 도구를 Bash 대신 PowerShell로 맞추고, 도구 가이드가 컨텍스트에 없으면 한 번 추가. `read`·`edit`·`write`가 CP949·UTF-16·BOM 등 원래 인코딩을 유지하고 새 파일은 주변 파일 인코딩을 따름 ([파일 인코딩](docs/tool-guide.md#파일-인코딩), `/encodings`로 분포 확인) |
| [cpp-csharp-lsp-lite](extensions/cpp-csharp-lsp-lite/README.md) | clangd·csharp-ls 연결. 정의·참조·타입 조회, 이름만으로 정의와 참조를 찾는 `find_symbol`. 편집 직후 진단을 결과에 붙이고 첫 줄에 오류 증감을 표시 |
| verify-guard | C/C++/C# 소스·프로젝트 파일(`.cpp`·`.h`·`.cs`·`.csproj`·`.sln`·`CMakeLists.txt` 등)을 고친 뒤 빌드·진단 없이 끝내려 하면 한 턴 더 진행해 검증하게 함. 빌드가 실패한 채 끝내려 하면 첫 오류를 보여 주고 수정·재빌드로 이어감 (프롬프트당 최대 5회) |
| [allowlist-gate](https://github.com/goldfix/pi-allowlist-plugin) | 허용 목록에 없는 도구 호출을 실행 전에 사용자에게 승인받음. `edit`·`write`·`powershell`·`subagent` 등이 대상이고 읽기 전용 명령·도구는 묻지 않음 ([승인 방법](docs/installation.md#도구-실행-승인)) |
| minimal-footer | 맥북과 같은 한 줄 HUD: `[모델 ◔ 사고 수준] 컨텍스트 막대 사용률% \| 폴더 git:(브랜치)`. `pi-usage-bar`와 다른 확장 상태 줄은 표시하지 않으며 `/tokens` 조회는 유지 |
| tool-profile | 모델에 보이는 도구를 기본 묶음으로 줄이고, `harness_tools`로 `code`·`ast`·`subagents` 그룹을 필요할 때 켬 |
| pi-lens | 코드 구조 분석(`module_report`, `read_symbol` 등). 역할이 겹치는 도구 일부는 [기본으로 숨김](docs/tool-exposure.md) |
| pi-subagents | 별도 에이전트에 조사·검토를 맡김. Windows에서는 `async: false`로 사용 |
| [pi-usage](https://github.com/TianZuo555/pi-extensions/tree/main/packages/pi-usage) | `/tokens`에서 오늘·최근 7일·최근 30일·이번 달 토큰과 모델별 사용량을 조회. 사내 모델도 pi 세션에 기록된 사용량으로 집계 ([사용량 안내](docs/usage-tracking.md)) |
| [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | 요구가 모호하거나 방향을 정해야 할 때 모델이 `ask_user_question`으로 선택지 대화 상자를 띄워 사용자에게 물음. 화면이 없는 `pi -p`에서는 도구를 숨김 |
| [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | 여러 단계 작업을 `todo` 도구의 작업 목록으로 관리하고 화면 위젯에 진행 상황을 표시. `/todos`로 목록을 봄. 목록은 세션 기록에 저장 |

MCP 서버는 pi 내장 MCP 기능으로 [config/mcp.json](config/mcp.json)에서 연결합니다. 동봉 [빌드센터 MCP](mcp/build-center/README.md)는 빌드센터 Redis의 프로젝트·모듈·담당자별 빌드·시험 결과와 로그를 묶어서 조회합니다 ([설정](docs/installation.md#redis-조회와-로컬-서버)). [Edge MCP](mcp/edge/README.md)는 기존에 로그인한 Edge에 연결해 웹 화면 조회·버튼 클릭·폼 입력을 합니다. 사내 MCP 서버도 같은 설정 파일에 추가하면 됩니다.

기본 도구는 파일 작업 7개와 `find_symbol`, `lsp_diagnostics`, `ask_user_question`(대화형 화면에서만), `todo`, `harness_tools`, `tool_search`입니다. MCP 도구는 `tool_search`로 찾으면 다음 모델 요청부터 쓸 수 있습니다. 상세 코드 탐색·AST·서브에이전트는 `harness_tools`에서 `code`, `ast`, `subagents` 그룹을 켜면 다음 모델 요청부터 사용할 수 있습니다. `action: "disable"`로 다시 숨길 수 있습니다. 기능 파일은 모두 동봉하며 기본 스킬·프롬프트 템플릿 자동 로딩은 비워 둡니다. 사용자·프로젝트가 추가한 도구와 스킬은 보존합니다. 상세 동작과 측정값은 [도구 노출 안내](docs/tool-exposure.md)에 있습니다.

## Edge 웹 업무

Edge에서 `edge://inspect/#remote-debugging`을 열고 해당 브라우저 인스턴스의 원격 디버깅을 허용한 뒤, pi에 “Edge에서 열어 둔 사내 페이지를 확인해 줘”처럼 요청합니다. 브라우저의 연결 확인 창이 뜨면 사용자가 허용해야 합니다. 사내 정책이나 Edge 버전에 따라 이 기능이 없거나 차단될 수 있습니다.

Playwright MCP와 전용 Node 런타임은 ZIP에 동봉하며, 브라우저를 다운로드하거나 기존 Edge 프로필을 복사하지 않습니다. 페이지 열람·클릭·입력도 기본 승인 정책을 따릅니다. 연결 방법·보안 주의사항은 [Edge MCP 안내](mcp/edge/README.md)를 참고하세요.

## 토큰 사용량

pi에서 `/tokens`를 입력하면 그래프가 열립니다. `←`·`→` 또는 `1`~`4`로 오늘·최근 7일·최근 30일·이번 달을 전환하고, `Tab`으로 토큰/비용을 바꿉니다.

사내·로컬 모델도 사용할 수 있지만, **모델 API가 응답에 토큰 `usage`를 반환해야** 합니다. `/tokens`는 `config/sessions`를 읽으며 외부 사용량 API를 호출하지 않습니다. 단가가 0인 사내 모델의 `$0`는 무료 사용을 의미하지 않습니다. 외부 서비스 잔여량을 조회하는 `/usage`는 사내 모델 사용량 조회 명령이 아닙니다. 검증 범위와 서버 응답 조건은 [사용량 안내](docs/usage-tracking.md)에 있습니다.

## 개발자용

- [배포와 차등 업데이트](docs/deployment.md): 변경분 ZIP 생성·적용과 수동 Release 게시 방법입니다.
- [개발·배포 안내](docs/development.md): GitHub Actions가 실행 파일과 의존성을 모아 배포 ZIP을 만들고 Windows에서 검증합니다.
- [평가 세트](tests/eval/README.md): 로컬 모델로 샘플 과제를 풀게 하고 확장을 켜고 끄며 성공률을 비교합니다.
- 직접 만든 확장은 `extensions/<이름>/index.ts`에, 외부 확장은 `vendor/extensions/`에 둡니다.
- [서버 설정](config/lsp.json) · [구성요소 버전과 라이선스](third_party/README.md)
