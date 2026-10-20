# 확장

직접 만든 pi 확장입니다. 확장마다 폴더 하나를 쓰고, 진입점은 `index.ts`입니다. 지원 코드와 문서도 같은 폴더에 둡니다.

| 확장 | 하는 일 |
|---|---|
| harness-env | PATH 같은 환경 기본값을 채우고 `powershell` 도구를 제공합니다. `read`·`edit`·`write`의 파일 입출력을 바꿔 원래 인코딩을 유지하고, `/encodings` 명령을 제공합니다. 가장 먼저 로드합니다. |
| [cpp-csharp-lsp-lite](cpp-csharp-lsp-lite/README.md) | C++·C# 언어 서버를 연결하고 편집 직후 진단을 붙입니다. |
| verify-guard | C/C++/C# 파일을 고친 뒤 빌드·진단 없이, 또는 빌드가 실패한 채로 끝내지 못하게 합니다. |
| minimal-footer | 맥북과 같은 한 줄 HUD: 모델·사고 수준·컨텍스트 사용률 막대·현재 폴더·Git 브랜치. `pi-usage-bar`와 다른 확장의 상태 줄은 표시하지 않습니다. `/tokens` 조회 기능은 유지합니다. |
| tool-profile | 선택 도구를 `code`·`ast`·`subagents` 그룹으로 묶어 필요할 때만 켜고 기본 프롬프트를 줄입니다. 마지막에 로드합니다. |

배포본이 로드할 확장은 루트 `package.json`의 `pi` 항목에 적습니다. 외부에서 받은 확장은 `vendor/extensions/`에 둡니다. MCP 서버는 확장이 아니라 [config/mcp.json](../config/mcp.json)에 등록합니다. 동봉 빌드센터 서버는 [mcp/build-center](../mcp/build-center/README.md)에 있습니다.
