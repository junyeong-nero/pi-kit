# 설치와 설정

폐쇄망 Windows PC에 pi-offline-kit를 처음 설치하고 설정·업데이트하는 방법입니다. 기능 소개는 [README](../README.md)에 있습니다.

## 처음 설치하기

처음 한 번만 하면 됩니다. 아래 순서대로 따라 하세요.

### 준비할 것

- Windows 10 1903 이상 또는 Windows 11 (x64)
- 사내 모델 API 정보: **API 주소**, **모델 ID**, **API 키** (담당 부서에 요청)
- 이 PC의 **관리자 권한** (시스템 환경 변수를 등록할 때 한 번 필요)
- C++·C# 빌드를 하려면 기존에 쓰던 Visual Studio 또는 Build Tools

Node.js·Python·Git 등 다른 프로그램은 설치하지 않아도 됩니다. 필요한 것은 모두 배포 ZIP에 들어 있습니다.

### 1단계. 배포 ZIP 받기 (인터넷 PC)

[GitHub Releases](https://github.com/junyeong-nero/pi-offline-kit/releases)에서 가장 최신 `v*` 릴리스의 **pi-offline-kit-win-x64.zip**을 받습니다. 같은 릴리스의 `.sha256` 파일과 해시를 비교하면 파일이 온전한지 확인할 수 있습니다.

```powershell
Get-FileHash .\pi-offline-kit-win-x64.zip -Algorithm SHA256
```

> GitHub 화면의 초록색 **Code → Download ZIP**(소스 코드)은 실행 파일이 없어 동작하지 않습니다. 반드시 Releases의 **pi-offline-kit-win-x64.zip**을 받으세요.

배포 ZIP에는 pi, 언어 서버(clangd·csharp-ls), 서버용 .NET SDK, 확장, fd·rg·SVN·Redis 서버와 CLI, Python·redis-py·빌드센터 MCP, Playwright MCP와 전용 Node 런타임이 모두 들어 있습니다. Edge는 PC에 설치된 브라우저를 사용하며, 연결 허용 방법은 [Edge MCP 안내](../mcp/edge/README.md)에 있습니다. 전용 Node는 시스템 PATH에 추가하지 않습니다.

### 2단계. 폐쇄망 PC에 풀기

ZIP을 폐쇄망 PC로 옮겨 원하는 위치에 풉니다. ZIP 안에 `pi-offline-kit` 폴더가 들어 있어서, 예를 들어 `D:\`에 풀면 `D:\pi-offline-kit`가 생깁니다. 이 문서는 이 경로를 예로 듭니다. `D:\pi-offline-kit\setup.ps1`이 보이면 맞게 푼 것입니다(압축 풀기 도구가 폴더를 하나 더 만들어 `...\pi-offline-kit\pi-offline-kit\`가 됐다면 안쪽 폴더를 쓰세요).

`setup.ps1`이 이 경로를 시스템에 등록하므로, 풀고 난 뒤 폴더를 옮기면 `setup.ps1`을 다시 실행해야 합니다.

### 3단계. 사내 모델 API 설정

1. `config\models.example.json`을 같은 폴더에 `models.json`이라는 이름으로 복사합니다.
   ```powershell
   cd D:\pi-offline-kit
   Copy-Item config\models.example.json config\models.json
   ```
2. `config\models.json`을 메모장 등으로 열어 두 곳을 고칩니다.
   - `"baseUrl"`: `http://<사내API주소>/v1` → 실제 사내 API 주소
   - `"id"`: `<v1/models 에 나온 id>` → 사용할 모델 ID

   `"apiKey": "$CORP_LLM_API_KEY"`는 **그대로 둡니다.** 키는 파일에 적지 않고 다음 단계의 환경 변수에서 읽습니다. 모델의 컨텍스트 크기(`contextWindow`)·최대 출력(`maxTokens`)을 안내받았다면 함께 맞춥니다.
3. **관리자 권한으로 연** PowerShell에서 API 키를 시스템 변수로 등록합니다. 사용자 변수는 로그인할 때 초기화되는 PC가 있어서 시스템 변수를 씁니다.
   ```powershell
   setx /M CORP_LLM_API_KEY "<발급받은 API KEY>"
   ```
   `성공: 지정한 값을 저장했습니다.`가 나오면 됩니다.

모델 ID를 모르면 사내 API의 모델 목록에서 확인할 수 있습니다(새 PowerShell에서 실행).

```powershell
Invoke-RestMethod http://<사내API주소>/v1/models -Headers @{ Authorization = "Bearer $env:CORP_LLM_API_KEY" } | Select-Object -ExpandProperty data | Select-Object id
```

### 4단계. setup.ps1 실행 (한 번)

배포 폴더에서 PowerShell을 열고 아래 두 명령을 순서대로 실행합니다. 관리자 권한 확인 창이 뜨면 **예**를 누릅니다.

```powershell
cd D:\pi-offline-kit
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup.ps1
```

첫 명령은 현재 PowerShell 창에서만 스크립트 실행을 허용합니다. 창을 닫으면 사라지고, PC의 보안 설정은 바뀌지 않습니다. 회사 그룹 정책으로 강제된 제한은 해제할 수 없습니다.

마지막에 아래 메시지가 나오면 성공입니다.

```text
Setup complete. Fully close your terminal application, reopen it, and run 'pi' in any folder.
```

`setup.ps1`은 필수 파일과 `config\models.json`을 확인하고, `pi`·도구 경로와 pi 설정 폴더(`config\`)를 시스템 환경 변수에 등록합니다. 인터넷 연결은 필요 없습니다. 무엇을 등록하는지는 [setup.ps1이 설정하는 것](#setupps1이-설정하는-것)에 있습니다.

### 5단계. 첫 실행과 확인

1. 터미널 프로그램(Windows Terminal, VS Code 등)을 **완전히 닫았다가 다시 엽니다.** 이미 열려 있던 창에는 새 환경 변수가 반영되지 않습니다.
2. 제대로 등록됐는지 확인합니다.
   ```powershell
   Get-Command pi | Select-Object Source   # D:\pi-offline-kit\bin\pi\pi.exe 여야 함
   $env:PI_CODING_AGENT_DIR                # D:\pi-offline-kit\config 여야 함
   ```
3. 작업할 프로젝트 폴더에서 pi를 실행합니다.
   ```powershell
   cd D:\work\MyProject
   pi
   ```
4. "이 폴더의 구조를 간단히 설명해 줘"처럼 질문해 답이 오면 설치가 끝난 것입니다.

확장, 스킬, 도구 가이드, 언어 서버가 함께 로드됩니다. 모델 응답을 받으려면 사내 API에 연결되어 있어야 합니다. 화면은 터미널 스크롤백을 그대로 쓰는 regular 모드로 시작합니다(`config\settings.json`의 `"tuiMode"`).

### 6단계. 프로젝트에 AGENTS.md 두기 (권장)

작은 모델은 프로젝트 구조와 빌드 명령을 모르면 탐색에 시간을 쓰고 엉뚱한 명령을 실행합니다. 효과 대비 가장 손이 덜 가는 개선이므로 먼저 해 두기를 권합니다.

```powershell
Copy-Item D:\pi-offline-kit\config\project-AGENTS.template.md D:\work\MyProject\AGENTS.md
```

[템플릿](../config/project-AGENTS.template.md)의 `<...>` 부분을 채우고 쓰지 않는 섹션은 지웁니다. 디렉터리 지도, 빌드·테스트 명령, 코딩 규칙, 수정 금지 경로, 작업 완료 조건을 적는 칸이 있습니다. 도구 사용법은 공통 가이드가 다루므로 여기에 다시 적지 않습니다.

## 사용할 때 알아 둘 것

- **파일 수정·명령 실행은 승인을 묻습니다.** 모델이 `edit`·`write`나 허용 목록에 없는 PowerShell 명령을 실행하려 하면 승인 창이 뜹니다. **Allow once**(이번만) / **Allow for session**(이 세션 동안 같은 명령) / **Allow & save rule**(프로젝트 규칙으로 저장) / **Deny**(거부) 중에서 고릅니다. 파일 읽기·검색은 묻지 않습니다. 자세한 내용은 [도구 실행 승인](#도구-실행-승인)에 있습니다.
- **먼저 계획만 받고 싶을 때:** `/skill:plan <작업>`은 코드를 고치지 않고 변경 계획만 설명합니다. 요청이 모호하면 `/skill:align <요청>`으로 목표와 범위부터 맞춥니다.
- **명령은 대화로 요청합니다.** 입력창의 `!`·`!!`는 Bash 기능이라 이 PC에서는 동작하지 않습니다. "빌드해 줘", "`svn status` 보여 줘"처럼 요청하세요.
- **멈추기·종료:** 모델 작업을 멈추려면 `Esc`, pi를 끝내려면 `/quit`를 입력하거나 `Ctrl+C`를 두 번 누릅니다.
- 모델이 빌드·진단 없이 C++·C# 수정을 끝내려 하면 확장이 검증을 한 번 더 진행시킵니다. 모델이 스스로 이어서 작업하는 것이니 기다리면 됩니다.

## 문제가 생길 때

| 증상 | 해결 |
|---|---|
| `.\setup.ps1`에서 "스크립트를 실행할 수 없습니다" | 같은 창에서 `Set-ExecutionPolicy -Scope Process Bypass -Force`를 먼저 실행했는지 확인합니다. 그래도 막히면 그룹 정책으로 제한된 PC이므로 IT 담당자에게 문의합니다. |
| `Copy config\models.example.json to config\models.json ...` | 3단계의 `config\models.json`이 없습니다. 파일 이름(`models.json.txt`가 아닌지)과 위치를 확인합니다. |
| `Missing bundle file: ...` / `Invalid executable: ...` | 소스 코드 ZIP을 받았거나 압축이 덜 풀렸습니다. Releases의 **pi-offline-kit-win-x64.zip**을 다시 풉니다. `.\setup.ps1 -Check`는 아무것도 바꾸지 않고 파일만 확인합니다. |
| `Administrator rights are required ...` | 관리자 권한 확인 창에서 **예**를 누르지 않았습니다. 다시 실행하거나 관리자 PowerShell에서 실행합니다. |
| `pi`를 찾을 수 없다고 나옴 | 터미널 프로그램을 완전히 닫고 다시 엽니다. VS Code 등 IDE 안의 터미널이면 IDE도 다시 시작합니다. |
| 옵션이 "unknown option"이거나 설명과 동작이 다름 | 다른 pi가 먼저 실행되는 경우입니다. `Get-Command pi -All`로 경로를 보고, 배포 폴더의 `bin\pi\pi.exe`가 아닌 것(npm으로 따로 설치한 pi 등)은 지우거나 `setup.ps1`을 다시 실행합니다. |
| `config` 대신 `agent` 폴더 설정을 읽음 | 예전 배포본의 설정이 남은 경우입니다. 최신 ZIP의 `setup.ps1`을 다시 실행하고 터미널·IDE를 모두 다시 시작한 뒤 `$env:PI_CODING_AGENT_DIR`을 확인합니다. |
| 모델 응답이 없거나 인증·연결 오류 | `config\models.json`의 `baseUrl`·`id`와 새 터미널의 `$env:CORP_LLM_API_KEY` 값을 확인합니다. 3단계의 `Invoke-RestMethod`로 모델 목록이 나오는지 먼저 봅니다. |
| 터미널 스크롤이 안 됨 | 배포본은 regular 모드가 기본입니다. pi 안의 `/settings`에서 TUI mode가 `fullscreen`으로 바뀌었으면 `regular`로 돌리거나 `pi --tui-mode regular`로 실행합니다. pi가 비정상 종료한 뒤 스크롤이 안 되면 그 탭을 닫고 새 탭을 엽니다. |
| `msbuild`를 찾을 수 없음 | `setup.ps1`이 Visual Studio를 찾지 못한 경우입니다. Visual Studio·Build Tools를 설치·업데이트한 뒤 `setup.ps1`을 다시 실행합니다. |

## 참고

### setup.ps1이 설정하는 것

아래 **시스템** 환경 변수를 설정합니다. 재부팅해도 유지됩니다.

구버전이 같은 이름으로 등록한 사용자 변수도 정리합니다. 사용자 변수에 예전 `agent` 경로가 남아 시스템의 `config` 경로를 덮어쓰던 문제를 방지합니다. MSBuild를 찾은 경우 사용자 변수의 `HSC_MSBUILD_EXE`도 정리해 시스템 설정을 사용합니다. API 키와 SDK·NuGet 설정은 그대로 유지합니다.

| 변수 | 값 | 이유 |
|---|---|---|
| `Path` | `bin`(fd·rg), `bin\pi`(pi), `bin\svn\bin`(SVN), `bin\redis`(Redis 서버·CLI), `runtime\python`, ast-grep 폴더와 발견한 Visual Studio MSBuild 폴더 추가 | 어느 폴더에서나 `pi`·`python`·`msbuild` 실행, 동봉 도구 인식 |
| `HSC_MSBUILD_EXE` | 발견한 Visual Studio / Build Tools의 `MSBuild.exe` 전체 경로 | 설치된 MSBuild를 명시적인 경로로 사용 |
| `PI_CODING_AGENT_DIR` | `<배포 폴더>\config` | pi가 모든 설정을 `config\`에서 읽음 |
| `PI_OFFLINE`, `PI_TELEMETRY`, `PI_SKIP_VERSION_CHECK` | `1`, `0`, `1` | 시작할 때 외부 통신 안 함 |
| `HSC_PI_HARNESS_HOME` | `<배포 폴더>` | 폴더를 옮긴 뒤 다시 실행할 때 예전 경로 정리 |

MSBuild는 기존 Visual Studio 설치 관리자의 `vswhere`로 최신 설치를 찾습니다. Build Tools와 사용자 지정 설치 경로도 지원하며, `vswhere`가 없거나 검색 결과가 없으면 Program Files의 표준 Visual Studio 폴더를 확인합니다. 찾지 못한 PC에서는 MSBuild 등록만 건너뛰고 pi 설정은 계속합니다. Visual Studio를 설치·업데이트한 뒤에는 `setup.ps1`을 다시 실행하면 됩니다.

설정 후 새 터미널에서 `msbuild -version`으로 확인할 수 있습니다. 프로젝트에 필요한 C++ 도구·Windows SDK·타기팅 팩은 기존 개발 환경의 것을 사용합니다.

### 새 버전으로 바꾸기

- **전체 ZIP으로 바꿀 때:** pi를 종료하고 같은 경로에 덮어씁니다. `models.json`과 대화 기록은 ZIP에 없어서 유지되고, `settings.json` 등 ZIP에 들어 있는 설정 파일은 새 버전으로 바뀝니다. `setup.ps1`을 다시 실행하면 추가된 도구의 시스템 PATH도 반영됩니다. 다른 경로에 풀었다면 `config\models.json`을 옮겨 놓고 새 폴더에서 `setup.ps1`을 실행합니다. 예전 경로의 항목은 새 경로로 바뀝니다.
- **변경분만 받을 때:** 아래 업데이트 ZIP을 씁니다.

### 변경분만 업데이트하기

이미 설치한 배포본이 있다면 매번 전체 ZIP을 옮기지 않아도 됩니다. 릴리스에는 이전 릴리스에서 바뀐 파일만 담은 **pi-offline-kit-update-from-<이전 버전>-win-x64.zip**이 함께 올라갑니다. 확장·설정·문서처럼 작은 파일의 변경은 보통 수 MB 이내입니다.

1. 설치된 배포본이 정확히 `<이전 버전>` 전체 ZIP이어야 합니다. 건너뛴 버전이 있으면 최신 전체 ZIP을 쓰세요.
2. 업데이트 ZIP을 배포 폴더의 **상위 폴더**에 풉니다(전체 ZIP을 풀었던 위치). 폴더가 합쳐지고 `update\` 폴더만 생깁니다. 이 시점에는 동작이 바뀌지 않습니다. 배포 폴더 이름을 바꿨다면 압축 안의 `update` 폴더를 배포 폴더 안으로 옮기세요.
3. pi를 모두 종료하고 `.\setup.ps1`을 실행합니다. `setup.ps1`이 이전 버전이 맞는지 확인하고 파일 해시를 검증한 뒤 변경분을 적용하고, 삭제된 파일을 지우고, `update\`를 정리합니다. 이전 버전이 아니거나 파일이 손상됐으면 아무것도 바꾸지 않고 멈춥니다.

이 저장소의 첫 Release에는 비교할 이전 버전이 없어 업데이트 ZIP이 없습니다. 다른 이름의 기존 배포본에서 옮겨올 때도 새 완성 ZIP을 별도 폴더에 설치하세요. 기존 API 설정과 세션은 백업한 뒤 필요한 것만 옮기고, 새 폴더에서 `setup.ps1`을 실행합니다.

업데이트가 덮어쓰는 것은 그 릴리스에서 바뀐 배포 파일뿐입니다. `config\models.json`, API 키, 세션, `config\redis\server_IP_mappings.json`·`owners.json`은 건드리지 않습니다. 다만 배포에 포함된 파일(예: `config\settings.json`)을 직접 고쳤고 그 파일이 이번에 바뀌었다면 덮어써지니 미리 백업하세요. 실행 파일·런타임(`bin`, `runtime`, `vendor`)이 바뀐 릴리스는 업데이트 ZIP도 커집니다.

## 설정 파일은 모두 `config\`에

pi는 `PI_CODING_AGENT_DIR`이 가리키는 `<배포 폴더>\config` 한 곳만 봅니다. `%USERPROFILE%\.pi\agent`나 배포 폴더의 `agent\`는 쓰지 않습니다.

| 파일 | 내용 | 고칠 일 |
|---|---|---|
| `models.json` | 사내 API 주소·모델 (`models.example.json`을 복사해 만듦) | 처음 한 번, API가 바뀔 때 |
| `settings.json` | 기본 도구, 배포본 패키지 등록(`".."`), 터미널 스크롤백을 쓰는 regular 화면 모드(`"tuiMode"`) 등 pi 설정 | 필요할 때 |
| `AGENTS.md` | 모든 프로젝트에 들어가는 도구 사용 가이드 | 공통 규칙을 더할 때 |
| `lsp.json` | clangd·csharp-ls 실행 설정 | 서버 옵션을 바꿀 때 |
| `pi-lens.json` | pi-lens 설정(숨길 도구 등) | 거의 없음 |
| `extensions\subagent\config.json` | pi-subagents 설정 | 거의 없음 |
| `project-AGENTS.template.md` | 프로젝트별 AGENTS.md 템플릿 | 복사해서 사용 |
| `offline-artifacts.lock.json`, `extensions\package*.json` | 배포 ZIP을 만들 때 쓰는 버전 고정 파일 | 고치지 않음 |

pi가 실행 중에 만드는 대화 기록(`sessions\`)과 캐시(`pi-lens\` 등)도 `config\` 아래에 쌓입니다.

### 설정을 바꾸거나 배포본을 옮길 때

- **`config\` 파일을 고쳤을 때:** 다시 실행할 것이 없습니다. 다음 `pi` 실행부터 적용됩니다.
- **배포 폴더를 옮겼을 때:** 새 위치에서 `setup.ps1`을 다시 실행합니다. 예전 경로의 항목은 새 경로로 바뀝니다.
- **등록을 풀 때:** **시스템 환경 변수 편집**에서 Path의 다섯 항목과 `PI_CODING_AGENT_DIR`·`HSC_PI_HARNESS_HOME`·`PI_OFFLINE`·`PI_TELEMETRY`·`PI_SKIP_VERSION_CHECK` 변수를 지웁니다.
- **예전 버전을 쓰던 경우:** 배포 폴더 루트에 `models.json`이 있으면 `setup.ps1`이 `config\models.json`으로 복사합니다. `agent\`에만 모델 설정이 있다면 `config\models.json`으로 복사한 뒤 실행하세요. 기존 설정과 대화 기록은 보존합니다.

## SVN 사용

Subversion 1.15.0 명령줄 도구와 DLL·라이선스가 `bin\svn\`에 들어 있습니다. 별도 설치 없이 pi의 `powershell` 도구에서 `svn status`, `svn diff`, `svn log --limit 10` 등을 사용할 수 있습니다. `setup.ps1` 실행 후 새 터미널에서도 `svn` 명령을 사용할 수 있습니다.

한글 배포 경로와 작업 사본 경로도 지원하도록 SVN 실행 파일에 UTF-8 설정을 포함합니다. Windows 10 1903 이상 또는 Windows 11의 x64 환경을 사용하세요. PC 전체 언어 설정을 바꿀 필요는 없습니다.

`status`·`diff`는 로컬 작업 사본을 확인하며, 사내 저장소를 조회하는 `log`·`checkout` 등에는 해당 SVN 서버 연결과 인증이 필요합니다. 기존 SVN 인증·서버 설정은 그대로 사용합니다. 패키지는 압축 약 5.35MB, 압축 해제 후 약 12.93MB입니다.

## Redis 조회와 로컬 서버

`bin\redis\`에는 [redis-windows 7.2.16의 MSYS2 with-Service 패키지](https://github.com/redis-windows/redis-windows/releases/tag/7.2.16) 전체가 들어 있습니다. EXE 7개, DLL 5개, 원본 설정·README·시작 파일을 포함하며 별도 MSYS2·WSL·.NET 설치는 필요 없습니다. 원본 ZIP은 약 **17.4MB**입니다. `setup.ps1` 실행 후 새 터미널이나 pi의 `powershell` 도구에서 사용할 수 있습니다.

| 명령 | 용도 |
|---|---|
| `redis-cli` | 데이터 조회·관리 |
| `redis-server` | Redis 서버 직접 실행 |
| `RedisService` | Windows 경로를 사용하는 서버 실행·서비스 등록 |
| `redis-benchmark` | 성능 측정 |
| `redis-check-rdb`, `redis-check-aof` | 저장 파일 검사·복구 |
| `redis-sentinel` | 서버 감시·장애 조치 |

로컬 서버를 실행하려면 새 PowerShell에서 데이터 폴더를 만들고 다음 명령을 실행합니다. 데이터 폴더를 배포 폴더 밖에 두면 새 ZIP을 적용해도 데이터를 보관할 수 있습니다.

```powershell
New-Item -ItemType Directory -Force D:\redis-data | Out-Null
RedisService run --foreground -c "$env:PI_CODING_AGENT_DIR\redis.local.conf" --dir D:\redis-data
```

`RedisService`는 Windows 경로를 자동 변환합니다. 설정 예시는 `127.0.0.1:6379`에서만 접속을 받습니다. 변경된 데이터는 60초 간격으로 RDB 저장을 시도하며, `--dir`로 지정한 데이터 폴더의 `dump.rdb`를 다음 실행 때 읽습니다. 서버를 실행한 터미널은 열어 두고, 다른 터미널에서 연결하거나 저장 후 종료합니다.

```powershell
redis-cli -h 127.0.0.1 -p 6379 PING
redis-cli -h 127.0.0.1 -p 6379 SET demo:hello world
redis-cli -h 127.0.0.1 -p 6379 GET demo:hello
# 로컬 서버를 종료할 때 실행
redis-cli -h 127.0.0.1 -p 6379 SHUTDOWN SAVE
```

6379 포트를 이미 사용 중이면 서버 실행 명령에 `--port 6380`을 추가하고 CLI에서도 `-p 6380`을 사용합니다. `setup.ps1`은 실행 경로를 등록하며 서버는 필요할 때 직접 실행합니다. Windows 서비스가 필요하면 관리자 PowerShell에서 아래 명령을 사용합니다. `--start-mode manual`로 등록한 뒤 명시적으로 시작합니다.

```powershell
RedisService install --service-name HscRedis --start-mode manual -c "$env:PI_CODING_AGENT_DIR\redis.local.conf" --dir D:\redis-data
Start-Service HscRedis
# 데이터를 저장하고 서비스를 종료할 때
redis-cli -h 127.0.0.1 -p 6379 SHUTDOWN SAVE
Stop-Service HscRedis
# 서비스 등록을 제거할 때
RedisService uninstall --service-name HscRedis
```

서비스는 등록 당시의 배포 경로를 사용하므로 ZIP 폴더를 옮기면 기존 서비스를 종료·제거하고 새 경로에서 등록합니다. `redis-server`로 직접 실행할 때는 데이터 폴더에서 `Get-Content -Raw "$env:PI_CODING_AGENT_DIR\redis.local.conf" | redis-server -`를 사용할 수 있습니다.

사내 Redis 주소·포트·DB 번호에 맞춰 조회합니다. 다음 예시는 인증이 이미 설정된 터미널에서 실행합니다.

```powershell
redis-cli -h <사내Redis주소> -p 6379 -n 0 PING
redis-cli -h <사내Redis주소> -p 6379 -n 0 GET <키>
redis-cli -h <사내Redis주소> -p 6379 -n 0 SCAN 0 MATCH '업무:*' COUNT 100
```

인증은 `REDISCLI_AUTH` 환경 변수를 사용하고, ACL 계정이 있으면 `--user <계정>`을 추가합니다. 사람이 터미널에서 직접 실행할 때는 `--askpass`로 비밀번호를 입력할 수도 있습니다. 비밀번호를 명령 인자나 대화에 넣지 않습니다. TLS 연결에는 `--tls --cacert 'C:/회사인증서/redis-ca.pem'`처럼 사내 CA 파일을 지정합니다. `SCAN`은 반환된 커서로 이어서 조회하며 `COUNT`는 개수의 힌트입니다.

프로젝트의 모듈·빌드·시험 결과는 동봉된 **빌드센터 MCP 도구**(Redis 조회)로 조회합니다. `config/redis/server_IP_mappings.json`에 `"ProjectName": "IP"`, `owners.json`에 `"example.user": "홍길동"` 형식으로 입력하세요. setup은 두 파일이 없을 때 빈 객체로 만들며 기존 파일을 보존합니다. 매핑 예시는 같은 폴더의 `.example.json`에 있습니다. 실제 사내 매핑과 인증 정보는 배포 ZIP에 포함하지 않습니다.

“ProjectA에서 홍길동 담당 모듈의 정적시험 결과와 로그 보여줘”처럼 요청할 수 있습니다. `mcp__build_center__list_projects`, `find_modules`, `resolve_owner`, `get_results`, `get_log` 도구가 연결을 재사용하고 묶음으로 조회하므로 키마다 CLI를 실행하지 않습니다. 설정·인증·시간 필드의 가정·로그 페이지 조회는 [빌드센터 MCP 안내](../mcp/build-center/README.md)를 참고하세요. 서버는 [config/mcp.json](../config/mcp.json)에 등록되어 pi가 세션을 시작할 때 백그라운드로 실행하고, 도구는 모델이 `tool_search`로 찾은 뒤 노출됩니다.

## 도구 실행 승인

동봉한 [pi-allowlist-plugin](https://github.com/goldfix/pi-allowlist-plugin)의 `allowlist-gate`가 허용 목록에 없는 도구 호출을 실행 전에 멈추고 묻습니다. 승인 창에는 도구 이름과 명령·경로만 보입니다. 수정 내용 같은 자세한 입력은 pi 화면의 도구 호출 표시에서 `Ctrl+O`로 펼쳐 확인합니다. **Allow once / Allow for session / Allow & save rule (project)... / Deny** 중에서 고릅니다.

- 승인 대상: `edit`·`write`, 허용 목록에 없는 `powershell` 명령, `subagent`, `ast_grep_replace` 등 상태를 바꿀 수 있는 도구
- 묻지 않음: `read`·`grep`·`find`·`ls`, LSP·`find_symbol`·`module_report` 등 조회 도구, 빌드센터 조회 도구, `Get-ChildItem`·`Get-Content`·`Select-String`·`git status/diff/log`·`svn status/diff/log` 같은 읽기 명령
- `;`·`|`·`&&`로 이어진 명령은 하나씩 검사하므로 모든 부분이 허용 목록에 있어야 바로 실행됩니다. `>` 리다이렉션이 들어간 명령은 항상 묻습니다.
- `Allow for session`은 같은 명령에만 적용되고 세션이 끝나면 사라집니다. `Allow & save rule`은 신뢰한 프로젝트의 `.pi/allowlist-gate.json`에 규칙을 저장합니다.

허용·차단 목록은 `config\extensions\allowlist-gate.json`에서 고칩니다. 규칙은 `shell:<명령 패턴>`, `edit:<경로 패턴>`, `mcp:<서버>[:<도구>]`, 도구 이름 형식이며 `deny`가 `allow`보다 우선합니다. `/allowlist`로 현재 적용 중인 규칙을 볼 수 있습니다. 새 배포본을 적용하면 이 파일이 배포본 기본값으로 바뀔 수 있으니, 프로젝트별 규칙은 `.pi/allowlist-gate.json`에 두세요.

승인 화면이 없는 비대화형 실행(`pi -p`)에서는 승인이 필요한 호출을 차단합니다. 이런 실행에서 모두 허용하려면 `config\extensions\allowlist-gate.json`의 `"enabled"`를 `false`로 바꾸세요.

## 그 밖에 알아 둘 점

- 명령 실행은 Windows 기본 PowerShell 5.1을 지원하며, PATH에 PowerShell 7(`pwsh.exe`)이 있으면 우선 사용합니다. `harness-env`가 실행 파일을 직접 찾아 절대 경로로 호출하므로 기본 PowerShell 경로가 PATH에 없어도 실행됩니다. `config/settings.json`의 기본 도구에 Bash 대신 PowerShell이 들어 있습니다.
- 배포 ZIP에는 API 키, `config/models.json`, 세션·캐시가 들어가지 않습니다.
- 시스템 변수에 넣은 API 키는 이 PC의 다른 사용자도 읽을 수 있습니다.
