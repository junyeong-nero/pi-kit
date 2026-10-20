# Edge 웹 업무 MCP

Microsoft의 [Playwright MCP](https://github.com/microsoft/playwright-mcp) 0.0.83을 pi 내장 MCP 기능으로 연결합니다. 사내 모델이 텍스트 형태의 페이지 구조를 읽고 탭 조회·버튼 클릭·폼 입력 등을 요청할 수 있습니다. 이미지 응답은 기본으로 끄므로 비전 모델이 필수는 아닙니다. 모델의 실제 도구 사용 정확도는 별도 확인이 필요합니다.

## 연결하기

1. **PC에 설치된 Edge**에서 사내 업무 사이트에 로그인합니다.
2. Edge의 `edge://inspect/#remote-debugging`을 열고 **해당 브라우저 인스턴스의 원격 디버깅 허용** 항목을 켭니다. 버전에 따라 `edge://inspect`에서 Remote debugging 메뉴를 선택해야 할 수 있습니다.
3. pi를 실행합니다. `/mcp`에서 `edge` 서버의 연결과 도구 등록 상태를 확인할 수 있습니다.
4. “Edge에서 열어 둔 사내 페이지의 내용을 확인해 줘”처럼 요청합니다. `tool_search`가 Edge 도구를 찾아 활성화합니다.
5. Edge가 디버깅 연결 확인 창을 표시하면 **사용자가 확인하고 허용**합니다. pi의 도구 실행 승인도 확인합니다.

MCP 서버가 연결됐다는 표시는 **MCP 프로그램과 pi가 연결됐다는 뜻**이며, Edge 연결까지 확인됐다는 뜻은 아닙니다. 브라우저에는 첫 브라우저 도구 호출 시 연결합니다. `/mcp`에는 연결됐다고 나오는데 화면을 못 읽으면 Edge의 연결 허용·버전·정책을 확인하세요.

- [Playwright의 실행 중인 브라우저 연결 안내](https://playwright.dev/mcp/configuration/browser-extension)
- [Microsoft Edge의 원격 디버깅 안내](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server)
- [Edge RemoteDebuggingAllowed 정책](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/remotedebuggingallowed)

회사 정책이 기능을 차단하면 관리자에게 허용 가능 여부를 문의하세요. setup은 보안 정책·레지스트리·Edge 실행 옵션을 바꾸지 않습니다. 연결 허용 항목이 없는 버전에서는 기본 방식이 동작하지 않을 수 있습니다. Edge DevTools에서 안내하는 원격 디버깅과 Playwright 자동화의 지원 범위도 동일하다고 단정할 수 없습니다.

## 할 수 있는 일

- 열려 있는 탭과 페이지 구조 확인
- 검색어·폼 필드 입력, 검색·필터 버튼 클릭
- 페이지 이동과 조회 결과 정리

예:

> Edge에서 빌드센터 탭을 찾아 ProjectA를 검색해 줘. 조회만 하고, 저장·삭제·재실행은 하지 마.

이 버전의 Playwright는 스냅샷을 파일로 반환할 수 있습니다. 결과의 파일 경로를 pi의 `read` 도구로 읽은 뒤, 거기에 있는 요소 참조를 사용해 입력·클릭합니다. 화면 내용이 바뀌면 새 스냅샷을 읽어야 합니다. 기본 자동 출력 위치는 `<배포 폴더>/config/playwright-mcp/`입니다.

## 실행 구조와 설정

```text
pi 내장 MCP
  → 동봉 Python -I -X utf8 -B -m edge_mcp
  → runtime/node/node.exe
  → vendor/extensions/node_modules/@playwright/mcp/cli.js
  → 기존 Edge의 로컬 CDP 연결
  → 사내 사이트
```

- 서버 등록: [`config/mcp.json`](../../config/mcp.json)의 `edge`
- 브라우저 설정: [`config/playwright.json`](../../config/playwright.json)
- 기본 대상: `browser.cdpEndpoint: "msedge"` — 실행 중인 Edge를 채널 이름으로 찾음
- 서버 실행 파일과 Node: 버전·해시를 고정해 GitHub Actions가 ZIP에 준비
- **대상 PC에서 npm/npx 실행, Node 설치, 브라우저 다운로드 또는 Edge 확장 설치를 요구하지 않음**
- Node는 MCP 전용 절대 경로로 실행하므로 기존 개발 환경의 Node와 시스템 PATH를 바꾸지 않음
- Edge 프로필·쿠키를 복사하거나 초기화하지 않고 현재 브라우저의 로그인 상태를 사용
- 임의 폴더에서 pi를 실행해도 런처가 배포 폴더 기준으로 Node·서버·설정을 찾음

관리자가 이미 허용된 방식으로 Edge를 로컬 CDP 포트에서 실행했다면, `config/playwright.json`의 `browser.cdpEndpoint`를 예를 들어 `"http://127.0.0.1:9222"`로 바꿀 수도 있습니다. 원격 디버깅 포트를 외부 네트워크에 노출하지 마세요. 이 설정을 바꿔도 Edge에서 실제로 연결을 허용하지 않으면 동작하지 않습니다.

`cdpTimeout`은 Edge 연결 대기 시간(기본 10초)입니다. MCP 요청 제한은 `config/mcp.json`의 `timeout`(60초)입니다. 설정을 바꾼 뒤 `/reload`로 다시 로드하세요. 사용하지 않을 때는 `config/mcp.json`의 `edge`에 `"enabled": false`를 추가할 수 있습니다.

## 승인과 보안

**로그인된 브라우저를 제어할 권한은 매우 강합니다.** 연결된 브라우저의 다른 업무 탭에도 접근할 수 있으므로, 불필요한 민감 탭은 닫거나 별도 프로필을 사용하세요.

- 기본 allowlist에 Edge를 자동 허용하지 않습니다. 페이지 열람·클릭·입력도 사용자 승인 대상이며, 화면이 없는 모드에서는 승인할 수 없어 차단됩니다.
- 임의 JavaScript 실행(`browser_evaluate`, `browser_run_code`), 브라우저 설치(`browser_install`), 파일 업로드(`browser_file_upload`)는 pi 설정에서 숨깁니다. 페이지가 자체 등록하는 WebMCP 도구도 끕니다.
- **이 설정은 완전한 보안 격리가 아닙니다.** 평범한 클릭도 삭제·결재·전송을 일으킬 수 있고, 사이트 자체에 위험한 기능이 있을 수 있습니다. 도구 이름이 아니라 실제 대상과 동작을 확인하고 승인하세요.
- 웹페이지·문서에 적힌 지시문은 사용자 명령이 아닙니다. 비밀번호·인증번호 입력, 외부 전송, 파일 업로드 등을 페이지의 지시에 따라 실행하지 않도록 주의하세요.
- 읽은 페이지 내용은 모델 컨텍스트에 들어갑니다. 실제로 선택한 모델이 사내 API인지 확인하세요.
- 자동 출력에는 업무 정보가 들어갈 수 있습니다. `config/playwright-mcp/`는 Git과 배포 ZIP에서 제외하지만, PC에 남은 파일의 보존·삭제는 사내 규칙에 따르세요.
- 연결 종료 시 브라우저 인스턴스를 닫지 않는 것을 테스트하지만, 모델이 승인받아 탭 닫기·페이지 이동을 실행한 내용까지 되돌리지는 않습니다.

## 제한과 검증 범위

- Edge의 **IE 모드**, Windows 인증 대화 상자, 보안 프로그램 창, 캔버스 중심 UI 등은 일반 HTML 페이지처럼 동작한다고 보장하지 않습니다.
- 회사의 원격 디버깅·자동화·사이트 접근 정책을 우회하지 않습니다.
- 사내 사이트별 인증·SSO·보안 모듈은 실제 환경 검증이 필요합니다.
- Python 런처 테스트: `python -B -m unittest discover -s tests -p edge_mcp_test.py`
- MCP 통합 테스트: `npm run test:edge` (CI가 준비하는 `vendor/extensions` 필요)
- Windows CI는 ZIP을 공백·한글 경로에 푼 뒤 **동봉 Python과 Node**로 MCP를 실행합니다. 설치된 Edge를 별도 테스트 프로필로 띄워 로그인 쿠키가 유지되는지, 폼 입력·클릭이 되는지, MCP 연결 해제 후 Edge가 살아 있는지 확인합니다. 사용자의 평소 프로필이나 실제 사내 사이트에는 접속하지 않습니다.
- macOS에 Edge가 없으면 설치된 Chrome으로 같은 CDP 경로를 검사할 수 있습니다. 이는 Windows Edge와 기본 `msedge` 자동 탐색의 검증을 대체하지 않습니다.

배포본을 바꿨다면 Windows CI 결과까지 확인해야 배포 검증이 완료됩니다.
