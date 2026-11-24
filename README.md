# pi-kit

폐쇄망 Windows PC에서 사내 AI 모델로 C++·C# 코드를 다루기 위한 pi 배포본입니다. CP949·UTF-16 소스도 인코딩을 깨뜨리지 않고 고치며, 빌드센터 조회와 Edge·Windows 화면·Word 문서 작업을 함께 쓸 수 있습니다.

## 설치

[Releases](https://github.com/junyeong-nero/pi-kit/releases)에서 최신 릴리스의 `pi-kit-win-x64.zip`을 받으세요. 실행에 필요한 것이 모두 들어 있어서 폐쇄망 PC에 따로 설치할 것은 없습니다. GitHub의 소스 코드 Download ZIP으로는 실행할 수 없습니다.

1. ZIP을 `D:\2_dev`에 풉니다. `D:\2_dev\pi-kit`가 생깁니다.
2. `config\models.json`에 사내 API 주소와 모델을 적고, API 키는 시스템 환경 변수로 등록합니다.
3. `D:\2_dev\pi-kit`에서 `.\setup.ps1`을 한 번 실행합니다.
4. 새 터미널을 열고 작업할 폴더에서 `pi`를 실행합니다.

다른 위치에 풀어도 됩니다. `setup.ps1`이 자기가 있는 폴더를 기준으로 경로를 잡습니다. 단계별 명령, 업데이트, 문제 해결, SVN·Redis 사용법은 [설치와 설정](docs/installation.md)에 있습니다.

## 모델에게 주는 가이드

[config/AGENTS.md](config/AGENTS.md)는 모든 프로젝트에서 모델에게 전달됩니다. 찾기 → 읽기 → 수정 → 빌드로 확인하는 작업 순서, 도구 사용 예시, 여러 파일을 바꿀 때 계획부터 쓰는 규칙 등이 들어 있습니다. 모든 프로젝트에 공통으로 줄 규칙이 있으면 이 파일에 추가하세요.

## 확장

배포 폴더 자체가 pi 패키지이고, `package.json`의 `pi` 항목에 아래 확장이 등록되어 있습니다.

| 확장 | 하는 일 |
|---|---|
| harness-env | 셸을 PowerShell로 맞추고, `read`·`edit`·`write`가 파일의 원래 인코딩(CP949, UTF-16, BOM)을 유지하게 합니다. 새 파일은 주변 파일의 인코딩을 따릅니다. 분포는 `/encodings`로 봅니다 ([파일 인코딩](docs/tool-guide.md#파일-인코딩)) |
| [allowlist-gate](https://github.com/goldfix/pi-allowlist-plugin) | 파일 수정, 명령 실행처럼 허용 목록에 없는 도구는 실행 전에 승인을 받습니다 ([승인 방법](docs/installation.md#도구-실행-승인)) |
| auto-mode | `/automode on`이면 승인 없이 실행하고, `/automode off`로 되돌립니다 |
| read-budget | 큰 파일은 컨텍스트 여유에 맞춰 앞부분만 읽히고, 이어 읽을 위치를 알려줍니다 |
| [pi-plan-mode](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode) | `/plan`으로 읽기 전용 계획 모드에 들어갑니다. 계획 중에는 수정이 막히고, 계획이 끝나면 바로 구현하거나 파일로 저장합니다 |
| [pi-tool-repair](https://github.com/monotykamary/pi-tool-repair) | 모델이 도구 인자 이름이나 형식을 틀리게 보내면 실행 전에 고칩니다 |
| [pi-polish](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-polish) | 연속된 명령·읽기·검색을 한 줄로 접고, 수정 결과를 diff로 보여 줍니다. `ctrl+o`로 펼칩니다 |
| context-bar | 하단에 모델, git 브랜치, 컨텍스트 사용량, 계획 모드 상태를 표시합니다 |
| tool-profile | 모델에게 보이는 도구를 기본 묶음으로 줄이고, 서브에이전트는 필요할 때 켭니다 |
| pi-subagents | 조사나 검토를 별도 에이전트에게 맡깁니다 |
| [pi-usage](https://github.com/TianZuo555/pi-extensions/tree/main/packages/pi-usage) | `/tokens`로 기간별·모델별 토큰 사용량을 봅니다 |
| [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | 방향을 정해야 할 때 모델이 선택지를 띄워 묻습니다 |
| [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | 여러 단계 작업의 진행 상황을 목록으로 보여 줍니다. `/todos`로 봅니다 |

처음에 모델이 보는 도구는 파일 작업, `ask_user_question`, `todo`, `harness_tools`, `tool_search`뿐입니다. MCP 도구는 모델이 `tool_search`로 찾은 다음부터 쓰고, 서브에이전트는 `harness_tools`로 켭니다. 자세한 내용은 [도구 노출 안내](docs/tool-exposure.md)에 있습니다.

## MCP 서버

[config/mcp.json](config/mcp.json)에 등록된 서버를 pi가 실행합니다. 사내 MCP 서버도 이 파일에 추가하면 됩니다.

| 서버 | 하는 일 |
|---|---|
| [빌드센터](mcp/build-center/README.md) | 빌드센터 Redis에서 프로젝트·모듈·담당자별 빌드와 시험 결과, 로그를 조회합니다 ([설정](docs/installation.md#redis-조회와-로컬-서버)) |
| [Edge](mcp/edge/README.md) | 로그인해 둔 Edge에 연결해 사내 웹 화면을 보고, 버튼을 누르고, 폼을 채웁니다 |
| Windows | 데스크톱 앱 화면을 읽고 클릭·입력합니다 |
| [Word VBA](mcp/word-vba/README.md) | Word에서 열어 둔 문서에 모델이 쓴 VBA를 실행합니다 |

### Edge

Edge에서 `edge://inspect/#remote-debugging`을 열어 원격 디버깅을 허용한 뒤 "Edge에 열어 둔 사내 페이지 확인해 줘"처럼 요청합니다. 연결 확인 창이 뜨면 허용하세요. 사내 정책에 따라 이 기능이 막혀 있을 수 있습니다. 브라우저를 새로 받거나 기존 프로필을 복사하지 않습니다.

### Windows 화면 조작

[Windows-MCP](https://github.com/CursorTouch/Windows-MCP) 0.8.5를 씁니다. "메모장 열고 이 내용 입력해 줘", "설정 창에서 확인 버튼 눌러 줘"처럼 요청합니다. 화면을 텍스트(UI Automation 트리)로 읽기 때문에 이미지를 못 보는 모델로도 됩니다.

실제 마우스와 키보드를 움직이니 작업 중에는 화면을 건드리지 마세요. 모든 동작은 실행 전에 승인을 받습니다. 파일·명령 도구는 pi의 도구와 겹쳐서 숨겨 두었고, 사용 통계 전송은 꺼 두었습니다. 0.8.6부터는 Python 3.14가 필요해서 동봉 Python 3.13에 맞는 0.8.5에 머물러 있습니다.

### Word 문서

Word로 문서를 먼저 연 다음 "목차 보여 주고 4.2절 요약해 줘", "필드 전부 갱신해 줘"처럼 요청합니다. 모델이 VBA를 써서 실행합니다. 코드는 임시 문서에서만 실행하므로 작업 중인 문서에는 매크로가 들어가지 않고, DRM 문서도 Word에서 열리기만 하면 다룰 수 있습니다. 한 번 실행한 변경은 Ctrl+Z 한 번으로 되돌아갑니다.

처음 한 번은 Word의 파일 → 옵션 → 보안 센터 → 보안 센터 설정 → 매크로 설정에서 "VBA 프로젝트 개체 모델에 안전하게 액세스"를 켜고 Word를 다시 시작해야 합니다. 다른 프로그램도 매크로를 넣을 수 있게 되는 설정이니 회사 보안 정책부터 확인하세요. VBA는 무엇이든 할 수 있으므로 실행할 때마다 코드를 보고 승인하세요.

Word에 오류 창이 떠서 멈추면 2분 뒤 안내가 나옵니다. 창을 닫으면 다시 쓸 수 있습니다. 실행이 아예 안 되면 [VBA 실행 진단](mcp/word-vba/README.md#문제-해결-vba-실행-진단)을 따라 해 보세요.
