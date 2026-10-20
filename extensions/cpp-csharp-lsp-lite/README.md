# cpp-csharp-lsp-lite

pi에서 C++·C# 언어 서버(clangd, csharp-ls)를 쓰게 해 주는 확장입니다. 정의·참조·타입을 조회하고, 파일을 고친 직후 진단 결과를 붙여 줍니다.

- `index.ts`: pi 도구와 편집 후 진단을 연결합니다.
- `lsp-client.ts`: stdio JSON-RPC로 언어 서버를 실행하고 통신합니다.

pi standalone 실행 파일의 TypeScript 로더와 내장 모듈만 쓰므로 대상 PC에서 npm 설치가 필요 없습니다. 같은 폴더의 `.ts` 파일을 함께 불러오니 폴더째 두세요.

## 로드 방식

배포 폴더가 pi 패키지이고 이 확장도 그 안에 있습니다. `setup.ps1`이 pi 설정 폴더를 `config/`로 지정하고, `config/settings.json`의 `"packages": [".."]`가 배포 폴더를 불러오므로 어느 폴더에서 pi를 실행해도 로드됩니다. `HARNESS_LSP_CONFIG`가 없으면 `harness-env`가 배포본의 `config/lsp.json`으로 채웁니다.

## 도구

| 하고 싶은 일 | 도구 |
|---|---|
| 저장된 파일의 진단 보기 | `lsp_diagnostics(path)` |
| 파일의 심볼 구조 보기 | `lsp_symbols(path)` |
| 워크스페이스에서 심볼 찾기 | `lsp_symbols(query, language?)` |
| 정의·참조·타입/서명 보기 | `lsp_definition`, `lsp_references`, `lsp_hover` |
| 이름만으로 정의 1줄과 참조(최대 30개) 찾기 | `find_symbol(name, path?, language?)` |
| 편집 직후 진단 | pi `edit`·`write` 결과에 자동으로 붙음 |

- **위치 지정:** 위치 도구에는 `path`, 1부터 세는 `line`, 그 줄의 `symbol` 또는 1부터 세는 `column`을 줍니다.
- **`language`:** `cpp` 또는 `csharp`입니다. 생략하면 설정된 서버와 열린 프로젝트 전체에서 찾습니다. 한 서버가 실패하면 나머지 결과와 실패 원인을 함께 보여 줍니다.
- **`find_symbol`:** 워크스페이스 심볼과 동봉 `rg`(`bin\rg.exe`, 없으면 PATH의 `rg`)로 후보 위치를 찾은 뒤 LSP로 정의·참조를 확인합니다. LSP가 아직 준비되지 않았거나 실패하면 rg 텍스트 검색 결과로 대신하고, 출력에 그렇다고 적습니다.
- **지원 확장자:** `.c .cc .cpp .cxx .h .hh .hpp .hxx .cs`

## 서버 설정

`config/lsp.json`의 `servers.cpp`, `servers.csharp`에서 설정합니다.

| 필드 | 용도 |
|---|---|
| `command`, `args` | 실행 파일과 인자 배열. 셸 명령 문자열은 쓰지 않습니다. |
| `root` | 프로젝트 루트를 고정합니다. 생략하면 파일 위치에서 위로 올라가며 빌드·솔루션 루트를 찾습니다. |
| `env` | 서버 프로세스의 환경 변수 |
| `settings` | `workspace/configuration`과 설정 변경 알림으로 전달할 값 |
| `initializationOptions` | 서버 초기화 옵션 |
| `initializeTimeoutMs` | 초기화 제한 시간 (기본 120초) |
| `requestTimeoutMs` | 조회 제한 시간 (기본 30초) |
| `diagnosticsTimeoutMs` | 진단 대기 시간 (기본 60초) |

`${bundle}`은 설정 파일이 든 폴더(`config/`)의 상위, 즉 배포 폴더를 가리킵니다.

자주 쓰는 예:

- **C++ 컴파일 정보 위치 지정:** `args`에 `--compile-commands-dir=D:/work/project/build`를 추가합니다.
- **C# 솔루션 고정:** DLL 경로 뒤에 `--solution`, `D:/work/project/App.sln`을 추가하고 `root`도 솔루션 폴더로 맞춥니다.

## 루트 찾기와 진단

- **C++:** compilation database가 있는 곳을 먼저 루트로 쓰고, CMake·vcxproj 위치를 보조로 씁니다.
- **C#:** 상위 solution을 csproj보다 먼저 씁니다.
- **탐색 범위:** Git 저장소 경계 밖으로는 올라가지 않습니다.
- **서버 수명:** 언어·루트마다 서버를 하나씩 재사용하고, 세션이 끝나면 모두 종료합니다.
- **진단 대기:** 진단이 제때 오지 않으면 `analysis pending (timed out)`으로 표시합니다. 이를 `no issues`로 취급하지 않습니다.
- **서버의 파일 수정 요청:** 적용하지 않고, pi의 편집 도구를 쓰라고 응답합니다.

클라이언트는 push/pull 진단, 문서 버전, 계층형 심볼, LocationLink, UTF-16 위치, 서버의 설정·진행률 요청을 처리합니다.

예전의 `HARNESS_LSP_COMMAND`, `HARNESS_LSP_CL`, `HARNESS_LSP_DOTNET` 환경 변수는 더 이상 서버 선택에 쓰지 않습니다.
