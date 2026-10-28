# 개발·배포 안내

이 문서는 하네스를 고치고 배포 ZIP을 만드는 사람을 위한 안내입니다. 설치·실행 방법은 [설치와 설정](installation.md)에 있습니다.

## 프로젝트 준비

언어 서버가 제대로 동작하려면 작업할 프로젝트 쪽에서도 준비가 필요합니다.

### C/C++

clangd는 `compile_commands.json`에서 헤더 경로·매크로·컴파일 옵션을 읽습니다. 간단한 프로젝트는 `compile_flags.txt`로도 충분합니다.

CMake와 Ninja를 쓰면 이렇게 만들 수 있습니다.

```powershell
cmake -S . -B build -G Ninja -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

Visual Studio generator는 이 옵션을 써도 `compile_commands.json`을 만들지 않습니다. `.vcxproj` 프로젝트는 실제 빌드 설정에 맞는 컴파일 정보나 `.clangd` 설정을 따로 준비해야 합니다. MSVC STL, Windows SDK, MFC, 외부 헤더도 개발 PC에 있어야 합니다.

서버 경로나 컴파일 정보 위치를 바꾸려면 [config/lsp.json](../config/lsp.json)과 [LSP 서버 설정](../extensions/cpp-csharp-lsp-lite/README.md#서버-설정)을 보세요.

### C#

`.sln`·`.slnx`·`.csproj`와 프로젝트 의존성은 기존 개발 환경에서 준비합니다. 사내 NuGet 소스·캐시·복원 절차는 프로젝트가 관리하고, 배포본은 이를 덮어쓰거나 복원 스크립트를 제공하지 않습니다.

언어 서버를 실행하는 SDK와 프로젝트가 요구하는 SDK는 다를 수 있습니다. 프로젝트에 맞게 다음을 확인하세요.

- `global.json`이 지정한 SDK와 대상 프레임워크의 참조 팩
- .NET Framework targeting pack
- Windows 전용 workload와 기존 MSBuild 프로젝트의 빌드 도구

## 배포

차등 업데이트 ZIP 생성·적용과 로컬 생성 파일의 수동 Release 게시는 [배포와 차등 업데이트](deployment.md)를 참고하세요.

배포 ZIP은 GitHub Actions가 만듭니다. 자동화는 [.github/workflows/offline.yml](../.github/workflows/offline.yml)에 있고, 배포 원칙은 [AGENTS.md](../AGENTS.md)를 따릅니다.

- **새 배포본 게시:** `v*` 태그를 push하면 Windows 검증을 통과한 ZIP과 `.sha256`이 GitHub Release에 올라갑니다. 사용자 배포는 Release로만 합니다.
  ```sh
  git tag v0.1.0 && git push origin v0.1.0
  ```
- **그 밖의 실행:** 테스트용 Artifact를 7일 동안 남깁니다. Public 저장소의 표준 runner 실행 시간은 무료지만, Artifact 업로드 제한은 별개로 확인하세요. 업로드 실패가 빌드 검증 실패로 처리되지는 않습니다.
- **버전 고정:** 실행 파일은 [config/offline-artifacts.lock.json](../config/offline-artifacts.lock.json), 확장 의존성은 `config/extensions/package-lock.json`, Python 패키지는 `config/redis/requirements.lock`에 버전과 해시를 고정합니다.
- **ZIP에서 빼는 것:** 실행 파일은 Git에 넣지 않습니다. 실제 `models.json`, `agent/`, `config/` 아래 세션·캐시, 실제 Redis 매핑(`server_IP_mappings.json`·`owners.json`)은 ZIP에도 넣지 않습니다.

ZIP에는 pi, fd·rg, SVN, Redis 서버와 CLI, clangd, csharp-ls, 서버용 .NET SDK, 동봉 Python과 MCP용 Node, 직접 만든 확장, pi-lens·pi-subagents·pi-usage·pi-allowlist-plugin·pi-tool-repair·rpiv-ask-user-question·rpiv-todo, Playwright MCP, Windows용 네이티브 파일과 WASM 리소스가 들어갑니다.

### Actions를 쓸 수 없을 때: Windows 로컬 패키징

이 절차는 **배포 ZIP을 만드는 개발자용 우회 경로**입니다. GitHub Actions 자동 배포는 그대로 유지합니다. 폐쇄망 대상 PC에서 빌드하거나 의존성을 설치하는 절차가 아닙니다. 로컬 ZIP은 GitHub에서 자동 검증·게시된 Release와 구분하며, 아래 검증을 통과해도 전체 CI를 실행한 것으로 보고하지 않습니다.

빌드용 PC에 필요한 것:

- 인터넷 연결, Windows x64, Git, Node.js **22.19 이상**, Python **3.13 x64**와 pip. Python 버전은 `config/redis/requirements.lock`의 Windows wheel과 맞춰야 합니다.
- **Windows SDK의 x64 `mt.exe`**: 동봉 SVN의 UTF-8 매니페스트를 병합하는 데 필요합니다. Visual Studio Installer에서 Windows SDK 설치 여부를 확인하세요. 기존 SDK·NuGet 소스·캐시는 덮어쓰지 않습니다.
- Edge 연결 테스트에는 설치된 Microsoft Edge가 필요합니다. 실제 C++·C# 프로젝트의 SDK·패키지는 기존 개발 환경을 사용합니다.

일반 PowerShell에서 다음을 실행합니다. 기존 설치 폴더가 아닌 **별도의 새 작업 폴더**를 사용하세요. 패키징은 작업 폴더의 `bin/`, `runtime/`, `vendor/extensions/`를 다시 준비합니다. 아래 경로는 예시이며, 이미 clone한 개발용 저장소가 있다면 그 폴더에서 시작할 수 있습니다.

```powershell
git clone https://github.com/junyeong-nero/pi-kit.git C:\pi-kit-build
if ($LASTEXITCODE) { throw 'git clone failed' }
Set-Location C:\pi-kit-build

node --version
py -3.13 -c "import struct, sys; assert sys.version_info[:2] == (3, 13) and struct.calcsize('P') == 8; print(sys.version)"
if ($LASTEXITCODE) { throw 'Python 3.13 x64 is required' }
$mt = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\mt.exe" -ErrorAction SilentlyContinue
if (-not $mt) { throw 'Windows SDK x64 mt.exe is required' }

npm ci --ignore-scripts
if ($LASTEXITCODE) { throw 'npm ci failed' }
npm test
if ($LASTEXITCODE) { throw 'tests failed' }
npm run typecheck
if ($LASTEXITCODE) { throw 'typecheck failed' }
```

다음은 기존 Actions 안의 `Assemble complete ZIP` 코드를 그대로 추출해 실행합니다. 새 빌드 스크립트나 YAML 패키지는 필요 없습니다. 다운로드는 잠금 파일의 해시로 검증하며, 실패하면 ZIP을 사용하지 마세요.

```powershell
$env:RELEASE_VERSION = 'local-' + (git rev-parse --short HEAD)
if ($LASTEXITCODE) { throw 'git revision lookup failed' }
@'
from pathlib import Path
import textwrap

workflow = Path('.github/workflows/offline.yml').read_text(encoding='utf-8')
start = workflow.index('      - name: Assemble complete ZIP\n')
end = workflow.index('\n      - name:', start + 1)
step = workflow[start:end]
code = textwrap.dedent(step.split('        run: |\n', 1)[1])
exec(compile(code, '.github/workflows/offline.yml:Assemble complete ZIP', 'exec'), {'__name__': '__main__'})
'@ | py -3.13 -
if ($LASTEXITCODE) { throw 'bundle packaging failed' }
```

생성 파일은 `dist/pi-kit-win-x64.zip`과 `.zip.sha256`입니다. HUD·토큰 사용량 조회·Edge MCP뿐 아니라 동봉 실행 파일·의존성을 모두 포함합니다. 다운로드·압축 시간과 디스크 공간이 필요합니다. 사내 TLS 검사나 다운로드 차단으로 실패하면 인증서 검증을 끄지 말고 네트워크 설정을 확인하세요.

#### 다른 경로에 풀어 검증하기

아래 검증은 시스템 PATH·설치 설정을 바꾸지 않습니다. 임시 폴더는 검사 후에도 남으므로 확인이 끝난 뒤 정리하세요. 테스트는 로컬 모의 API·별도 브라우저 프로필을 사용하며, 실제 사내 API나 로그인된 업무 탭을 검사하지 않습니다.

```powershell
node tests/extensions-loader.mjs
if ($LASTEXITCODE) { throw 'extension loading failed' }
$checkRoot = Join-Path $env:TEMP ('pi 로컬 검증 ' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath .\dist\pi-kit-win-x64.zip -DestinationPath $checkRoot -ErrorAction Stop
$bundle = Join-Path $checkRoot 'pi-kit'

powershell -NoProfile -ExecutionPolicy Bypass -File "$bundle\setup.ps1" -Check
if ($LASTEXITCODE) { throw 'required bundle files are missing' }
$manifest = Get-Content -LiteralPath "$bundle\manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($file in $manifest.files.PSObject.Properties) {
    $actual = (Get-FileHash -LiteralPath (Join-Path $bundle $file.Name) -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($actual -ne $file.Value) { throw "Checksum mismatch: $($file.Name)" }
}

$env:USAGE_TEST_BUNDLE = $bundle
$env:EDGE_TEST_BUNDLE = $bundle
$env:TEST_BUNDLE = $bundle
$env:TEST_CLANGD = "$bundle\bin\clangd\bin\clangd.exe"
$env:TEST_DOTNET = "$bundle\runtime\dotnet\dotnet.exe"
try {
    npm run test:usage
    if ($LASTEXITCODE) { throw 'token usage test failed' }
    npm run test:edge
    if ($LASTEXITCODE) { throw 'Edge MCP test failed' }
    node --experimental-strip-types tests/integration.ts
    if ($LASTEXITCODE) { throw 'language server integration failed' }
    py -3.13 tests/pi-standalone.py "$bundle" --direct
    if ($LASTEXITCODE) { throw 'standalone pi test failed' }
} finally {
    Remove-Item Env:USAGE_TEST_BUNDLE, Env:EDGE_TEST_BUNDLE, Env:TEST_BUNDLE, Env:TEST_CLANGD, Env:TEST_DOTNET -ErrorAction SilentlyContinue
}
```

검증 성공 후 `dist/pi-kit-win-x64.zip`을 폐쇄망으로 옮깁니다. 대상 PC에서는 새 폴더에 풀고 사내 API를 설정한 뒤 `setup.ps1`을 실행합니다. 기존 `config/models.json`과 세션은 별도로 보존하고 소스 ZIP이나 테스트 폴더를 배포본 대신 사용하지 마세요.

이 절차는 전체 CI의 방화벽 차단·Redis/SVN·시스템 설치 및 업데이트 검증을 모두 재현하지 않습니다. 시스템 PATH·설정 적용까지 검사하려면 아래 개발 테스트의 `tests/pi-standalone.py <배포 폴더>`를 관리자 PowerShell에서 실행할 수 있지만, **빌드 PC의 시스템 변수가 해당 임시 배포 폴더를 가리키도록 바뀝니다.** 일상 개발 PC에서는 이 부작용을 확인한 뒤 선택하세요. Windows 로컬 검증 결과와 CI 미실행 사실은 구분해 기록합니다.

### 구성요소별 메모


- **SVN:** 원본 명령줄 패키지의 DLL·라이선스를 그대로 두고, CI의 Windows SDK `mt.exe`로 UTF-8 매니페스트만 병합합니다. 한글·공백 경로로 옮긴 ZIP에서 로컬 저장소의 checkout·status·diff·log를 검사합니다.
- **Redis:** 고정한 MSYS2 with-Service ZIP 전체(EXE 7개, DLL 5개, 원본 설정·README·시작 파일)를 `bin/redis/`에 풉니다. 라이선스는 RedisService에 내장된 .NET 고지까지 `third_party/redis/`에 둡니다. `tests/redis-bundle.py`가 배포본의 Redis 파일을 원본 ZIP과 바이트 단위로 비교합니다.
- **Redis 로컬 설정:** Redis는 설정 파일의 `dir`을 읽는 즉시 폴더를 바꾸고, 명령줄 `--dir`은 그 뒤에 적용합니다. 래퍼가 동봉 바이너리 폴더에서 서버를 실행하므로 한글·공백 경로에서는 `dir .`가 먼저 실패할 수 있습니다. 그래서 `config/redis.local.conf`에는 `dir`을 넣지 않고, 실행할 때 `RedisService run --foreground -c <설정> --dir <데이터 폴더>`로 데이터 폴더를 지정합니다.
- **빌드센터 MCP:** Python stdio 서버는 `mcp/build-center/`에 있고, pi 내장 MCP 기능이 [config/mcp.json](../config/mcp.json)을 보고 실행합니다. 별도 MCP 클라이언트는 동봉하지 않습니다. CI가 wheel을 받아 `runtime/python/Lib/site-packages`에 설치하고 `.dist-info`의 라이선스·메타데이터를 보존합니다. 서버·패키지 경로는 `python313._pth`에 상대 경로로 등록합니다. 그래서 `config/mcp.json`은 절대 경로 없이 PATH의 동봉 `python`으로 `-m main`을 실행합니다.

- **Edge MCP:** `mcp/edge/edge_mcp.py`가 동봉 Python의 `-m edge_mcp` 진입점입니다. `python313._pth`에 서버 경로를 넣고, 런처가 `runtime/node/node.exe`와 잠금 파일의 Playwright MCP를 절대 경로로 실행합니다. Node는 시스템 PATH에 추가하지 않고 기존 프로젝트의 Node 설치도 바꾸지 않습니다. `config/playwright.json`은 실행 중인 Edge의 CDP 연결만 지정하므로 브라우저 다운로드·자동 실행은 하지 않습니다. 자동 출력은 `config/playwright-mcp/`에 두고 ZIP에서 제외합니다.

### CI가 검사하는 것

ZIP을 한글·공백이 들어간 다른 경로로 옮긴 뒤 아래를 검사합니다. Windows CI가 실행되지 않았다면 배포 검증이 끝난 것이 아닙니다.

- 파일 해시와 실제 언어 서버 동작, 확장 로딩, pi 모델 API 스모크 테스트
- Redis: 별도 Redis·.NET 설치 없이 직접 실행과 래퍼 실행, 인증·조회·Lua·벤치마크·RDB 저장과 재시작 후 복원, 저장 파일 검사 도구, Sentinel
- 빌드센터 MCP: Python 회귀 테스트(`tests/build_center_mcp_test.py`), `config/mcp.json`의 명령 그대로 동봉 Python 서버를 띄워 인증된 Redis의 모듈 100개를 조회하는 통합 테스트(`tests/build-center-mcp-bundle.py`), 실제 pi에서 `tool_search` → `mcp__build_center__list_projects`를 호출하는 스모크 테스트(`tests/pi-standalone.py`, `tests/prompt-footprint.py`). 사내 Redis에는 접속하지 않습니다.
- Edge MCP: `tests/edge_mcp_test.py`로 런처의 동봉 Node 선택·누락 오류·stdio 전달을 검사합니다. ZIP 재배치 후 `npm run test:edge`가 실제 동봉 Python→Node→MCP를 실행하고 별도 테스트 프로필의 Edge에 CDP로 연결해 로그인 쿠키 재사용·폼 입력·클릭·연결 해제 후 브라우저 유지 여부를 검사합니다. 실제 사내 페이지나 사용자의 평소 Edge 프로필은 사용하지 않습니다. macOS에서는 Edge가 없으면 설치된 Chrome으로 CDP 경로만 검증할 수 있으며, Windows 검증을 대체하지 않습니다.
- MSBuild: PowerShell 5.1에서 설치 유무와 표준 경로 탐색, 실제 Visual Studio MSBuild로 시스템 변수·PATH·반복 설정과 샘플 프로젝트 빌드, 그 뒤 C++·C# 언어 서버 통합 테스트

배포 폴더에서 필수 파일만 빠르게 확인하려면 아래 명령을 씁니다. 아무것도 바꾸지 않습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Check
```

## 확장과 설정 구조

배포 폴더는 그 자체로 pi 패키지입니다.

- 불러올 확장·스킬·프롬프트는 루트 [package.json](../package.json)의 `pi` 항목 한 곳에서 관리합니다. 새 확장은 이 목록에 넣으세요. 빠진 확장은 `tests/extensions-loader.mjs`가 잡아냅니다.
- `harness-env`는 목록의 첫 번째여야 합니다. 뒤따르는 확장이 쓰는 환경 변수 기본값을 먼저 채우기 때문입니다. `tool-profile`은 마지막에 둡니다.
- `setup.ps1`이 `PI_CODING_AGENT_DIR`을 `<배포 폴더>\config`로 설정하므로, pi는 `config/`를 설정 폴더로 씁니다. [config/settings.json](../config/settings.json)의 `"packages": [".."]`가 배포 폴더를 패키지로 불러오고, [config/AGENTS.md](../config/AGENTS.md)는 전역 AGENTS.md로 들어갑니다.
- `config/`는 pi가 세션·캐시를 쓰는 폴더이기도 합니다. 패키징할 때 `models.json`, `auth.json`, `sessions/`, `pi-lens/` 등을 빼고, `.gitignore`도 같은 파일을 무시합니다.

외부 확장의 설정 위치는 다음과 같습니다.

- **pi-lens:** [config/pi-lens.json](../config/pi-lens.json). 자체 LSP와 `lsp_navigation`은 끄고 하네스의 C++·C# LSP 도구를 씁니다. 상태와 로그는 `config/pi-lens/`에 쌓입니다.
- **pi-subagents:** [config/extensions/subagent/config.json](../config/extensions/subagent/config.json). Windows에서는 `async: false`를 쓰고 WorkflowScript에도 명시하세요. [백그라운드 실행의 지원 범위](https://github.com/nicobailon/pi-subagents/blob/main/docs/standalone-background.md)를 참고하세요.
- **MCP 서버:** [config/mcp.json](../config/mcp.json). pi 내장 MCP 기능이 읽습니다. 빌드센터 설정과 매핑은 `config/redis/`에 있습니다. [빌드센터 MCP 안내](../mcp/build-center/README.md)와 [Edge MCP 안내](../mcp/edge/README.md)를 보세요.

### setup.ps1이 시스템 변수를 쓰는 이유

- `PI_CODING_AGENT_DIR`·`PI_OFFLINE`·`PI_TELEMETRY`·`PI_SKIP_VERSION_CHECK`는 확장이 로드되기 전에 pi가 읽습니다. 그래서 확장이 채울 수 없고 `setup.ps1`이 시스템 변수로 설정합니다.
- `PI_OFFLINE`은 시작할 때의 외부 통신을 줄일 뿐입니다. 실제 네트워크 차단은 따로 적용해야 하고, 사내 모델 API 연결은 필요합니다.
- 구버전이 같은 이름으로 만든 사용자 변수가 시스템 값을 덮어쓰지 않도록, 시스템 설정에 성공한 뒤 원래 계정의 사용자 변수만 지웁니다. UAC로 다시 실행되는 내부 `-SystemOnly` 단계는 시스템 설정만 맡습니다.
- 이미 열린 터미널의 환경은 바꿀 수 없어서 터미널 프로그램을 다시 시작해야 합니다.

MSBuild는 [vswhere 방식](https://github.com/microsoft/vswhere/wiki/Find-MSBuild)으로 찾고, 결과가 없으면 Program Files의 표준 설치 경로를 파일 버전순으로 확인합니다.

- **찾았을 때:** 경로를 시스템 `HSC_MSBUILD_EXE`에 기록하고, 그 폴더를 시스템 PATH의 동봉 도구 다음에 넣습니다.
- **못 찾았을 때:** 기존 MSBuild 설정을 그대로 둡니다.
- **`MSBUILD_EXE_PATH`를 쓰지 않는 이유:** MSBuild 자체의 이 변수를 시스템에 지정하면 `dotnet`이 Visual Studio의 SDK resolver를 잘못 불러올 수 있습니다.
- **서버용 .NET SDK는 PATH에 넣지 않습니다.**

## 개발 테스트

Node.js 22.19 이상이 필요합니다.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
pwsh -NoProfile -File tests/environment.ps1
```

실제 서버와 외부 확장이 로컬에 준비돼 있다면 통합 테스트도 돌릴 수 있습니다.

```sh
node --experimental-strip-types tests/integration.ts
node tests/pi-loader.mjs
node tests/extensions-loader.mjs
python3 tests/pi-standalone.py . --node-cli
```

C# 통합 테스트의 dotnet 경로는 `TEST_DOTNET`, clangd 경로는 `TEST_CLANGD`로 바꿉니다. `--node-cli`는 로컬 clangd와 Node.js용 pi를 씁니다.

Windows 배포 폴더는 `tests/pi-standalone.py`를 관리자 권한으로 실행해 검증합니다.

| 명령 | 검사 내용 |
|---|---|
| `python tests/pi-standalone.py <배포 폴더>` | `setup.ps1`을 실행한 뒤 시스템 PATH의 `pi`로 확인합니다. **실행한 PC의 시스템 PATH와 변수를 바꿉니다.** |
| `... --direct` | 환경 변수 없이 `pi.exe`를 바로 실행합니다. PATH에서 Windows 시스템 도구와 PowerShell을 빼고 시작해, `harness-env`가 `SystemRoot` 아래 실행 파일을 찾아 PowerShell 도구를 복구하는지 봅니다. |
| `... --upgrade` | 사용자 변수 `PI_CODING_AGENT_DIR`에 예전 `agent/` 경로를 넣은 뒤, setup이 이를 정리하고 pi가 `config/models.json`을 읽는지 봅니다. 바꾼 사용자 변수는 끝날 때 되돌립니다. |

installed·upgrade 모드는 Windows `CreateEnvironmentBlock`으로 시스템·사용자 변수를 함께 읽습니다. 시스템 변수만 넣고 테스트하면 사용자 변수와의 충돌을 놓칠 수 있어서입니다.
