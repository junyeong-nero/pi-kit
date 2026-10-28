# third_party

배포 ZIP에 들어가는 외부 구성요소의 버전·출처·라이선스입니다.

- **버전 고정:** 다운로드 URL·버전·원본 해시는 [`config/offline-artifacts.lock.json`](../config/offline-artifacts.lock.json)(실행 파일·런타임)과 `config/extensions/package-lock.json`(npm 의존성)에 고정합니다.
- **준비 위치:** GitHub Actions가 원본 해시를 확인한 뒤 파일과 라이선스를 ZIP에 넣습니다. 실행 파일은 소스 저장소에 넣지 않습니다.
- **배포하지 않는 것:** 프로젝트별 MSVC·Windows SDK·외부 라이브러리와 NuGet 의존성은 기존 개발 환경의 것을 씁니다.

## 언어 서버와 런타임

공식 배포 파일의 디렉터리 구조를 그대로 둡니다.

| 배포 경로 | 버전 | 공식 출처 | 라이선스/고지 |
|---|---|---|---|
| `bin/pi/` | 1.4.0 Windows x64 | [pi release](https://github.com/earendil-works/pi/releases/tag/v1.4.0) | MIT (`pi/LICENSE`); 빌드 시 공식 ZIP 다운로드 |
| `bin/clangd/` | 22.1.6 Windows x64 | [clangd release](https://github.com/clangd/clangd/releases/tag/22.1.6) | Apache-2.0 with LLVM exception; 배포본 `LICENSE.TXT` 보존 |
| `bin/csharp-ls/` | 0.28.0 | [NuGet](https://www.nuget.org/packages/csharp-ls/0.28.0), [source](https://github.com/razzmatazz/csharp-language-server/tree/0.28.0) | MIT (`csharp-ls/LICENSE`); 원본 NuGet 메타데이터 및 포함 DLL 보존 |
| `runtime/dotnet/` | SDK 10.0.401 Windows x64 | [Microsoft release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json) | 배포본 LICENSE 및 ThirdPartyNotices 보존 |
| `runtime/node/` | Node.js 26.12.1 Windows x64 | [Node.js 공식 배포](https://nodejs.org/dist/v26.12.1/) | MIT 및 포함 third-party 고지, 원본 LICENSE와 배포 디렉터리 전체 보존. MCP 전용이며 시스템 PATH에 넣지 않음 |

## 명령줄 도구

fd·rg는 exe만 넣고, SVN·Redis는 원본 패키지 전체를 넣습니다.

| 파일 | 버전 | 출처 | 원본 zip SHA256 | 라이선스 |
|---|---|---|---|---|
| `bin/fd.exe` | 10.5.0 | https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-pc-windows-msvc.zip | `a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7` | MIT / Apache-2.0 (`fd/`) |
| `bin/rg.exe` | 15.2.0 | https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip | `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5` | MIT / Unlicense (`ripgrep/`) |
| `bin/svn/` | 1.15.0 Windows x64 | [VisualSVN Subversion command-line tools](https://www.visualsvn.com/files/Apache-Subversion-1.15.0-x64.zip) | `98bb798dd6c70cc875b9bdacd600594351cf88f0a39a831a5055df061c871bb5` | Apache-2.0 및 의존 라이브러리 라이선스; 원본 `Licenses/`와 DLL 보존 |
| `bin/redis/` | Redis 7.2.16 MSYS2 with-Service Windows x64 전체 패키지 | [redis-windows community build](https://github.com/redis-windows/redis-windows/releases/download/7.2.16/Redis-7.2.16-Windows-x64-msys2-with-Service.zip) | `91e663e401a3945831c3674fd63aa979ff7a5498b34939044ddd258896891381` | Redis 및 Lua/fpconv/MSYS2/OpenSSL/GCC/.NET 고지: [`redis/NOTICE.md`](redis/NOTICE.md) |

- **Redis:** 원본 ZIP의 EXE 7개·DLL 5개·설정·README·시작 파일을 모두 넣고, 바이너리는 고치지 않습니다. 원본 ZIP에 빠진 라이선스는 버전별 소스에서 가져와 `redis/`에 두었고, RedisService에 내장된 .NET 런타임 고지도 포함합니다. 하네스의 로컬 서버 설정 예시는 `config/redis.local.conf`입니다.
- **SVN:** 한글 경로를 지원하려고 `bin/*.exe`에 UTF-8 `activeCodePage` 매니페스트를 병합합니다. 기존 매니페스트 항목과 DLL·라이선스는 그대로 두고, 바꾼 내용은 `bin/svn/HARNESS-MODIFICATIONS.txt`와 `bin/svn/utf8.manifest`에 기록합니다. 원본 ZIP 해시는 위 표에, 바꾼 뒤의 파일 해시는 배포본 `manifest.json`에 있습니다. 이 작업은 GitHub Actions에서만 하고, 대상 PC의 시스템 언어 설정은 바꾸지 않습니다.

## pi 확장과 npm 의존성

| 배포 경로 | 버전 | 출처 | 라이선스 |
|---|---|---|---|
| `vendor/extensions/node_modules/@playwright/mcp/` | 0.0.83 | https://github.com/microsoft/playwright-mcp | Apache-2.0, LICENSE 보존. 정확한 Playwright/Core 버전과 전이 의존성은 npm 잠금 파일에 고정 |
| `vendor/extensions/node_modules/pi-lens/` | 4.4.3 | https://github.com/apmantza/pi-lens | MIT, 패키지의 LICENSE 보존 |
| `vendor/extensions/node_modules/pi-subagents/` | 0.79.1 | https://github.com/nicobailon/pi-subagents | MIT, 패키지의 LICENSE 보존 |
| `vendor/extensions/node_modules/@tian.zuo/pi-usage/` | 0.5.0 | https://github.com/TianZuo555/pi-extensions/tree/main/packages/pi-usage | MIT, 패키지의 LICENSE 보존. `effect`·`playwriter` 등 전이 의존성도 잠금 파일대로 동봉 |
| `vendor/extensions/node_modules/pi-allowlist-plugin/` | 1.3.2 | https://github.com/goldfix/pi-allowlist-plugin | MIT, 패키지의 LICENSE 보존 |
| `vendor/extensions/node_modules/@juicesharp/rpiv-ask-user-question/` | 2.13.9 | https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question | MIT, 패키지의 LICENSE 보존 |
| `vendor/extensions/node_modules/@juicesharp/rpiv-todo/` | 2.13.9 | https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo | MIT, 패키지의 LICENSE 보존 |
| `vendor/extensions/node_modules/pi-tool-repair/` | 0.3.9 | https://github.com/monotykamary/pi-tool-repair | MIT(`package.json`의 `license` 표기). 패키지와 원본 저장소에 LICENSE 파일이 없어 별도 고지 파일은 없음 |
| `vendor/extensions/node_modules/iconv-lite/` | 0.7.3 | https://github.com/pillarjs/iconv-lite | MIT, 패키지의 LICENSE 보존. CP949 변환표(`encodings/tables/cp949.json`)만 읽어 씀 |
| `vendor/extensions/node_modules/@juicesharp/rpiv-config/` | 2.13.9 | https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-config | MIT, 패키지의 LICENSE 보존 |

- 전이 의존성까지 버전·npm 원본 URL·SHA512·라이선스 식별자를 `config/extensions/package-lock.json`에 고정합니다. 배포본의 `vendor/extensions/manifest.json`에는 실제로 들어간 Windows x64 파일 목록이 있습니다.
- 각 npm 패키지의 LICENSE·NOTICE와 pi-lens의 grammar 리소스·고지는 원본 그대로 둡니다.
- pi SDK peer dependency는 standalone pi가 제공하므로 따로 넣지 않습니다.
- 패키지 설치 스크립트는 실행하지 않습니다. ast-grep 실행 파일은 해시를 확인한 Windows 패키지에서 직접 복사합니다.
- Windows 배포본에서는 pi-subagents 기본 역할 문서의 Bash 도구와 안내를 PowerShell로 바꿉니다.
