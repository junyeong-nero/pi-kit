# 확장

직접 만든 pi 확장입니다. 확장마다 폴더 하나를 쓰고, 진입점은 `index.ts`입니다. 지원 코드와 문서도 같은 폴더에 둡니다.

| 확장 | 하는 일 |
|---|---|
| harness-env | PATH 같은 환경 기본값을 채우고 `powershell` 도구를 제공합니다. `read`·`edit`·`write`의 파일 입출력을 바꿔 원래 인코딩을 유지하고, `/encodings` 명령을 제공합니다. 모델이 `powershell`에 `cmd` 같은 다른 인자 이름을 쓰면 `command`로 고칩니다. 가장 먼저 로드합니다. |
| read-budget | 모델의 컨텍스트 창과 남은 여유에 맞춰 `read`의 `limit`을 자동으로 줄입니다. 호출을 막지 않고, 이어 읽을 `offset`은 pi가 안내합니다. |
| tool-profile | 선택 도구를 `code`·`subagents` 그룹으로 묶어 필요할 때만 켜고 기본 프롬프트를 줄입니다. 마지막에 로드합니다. |

배포본이 로드할 확장은 루트 `package.json`의 `pi` 항목에 적습니다. 외부에서 받은 확장은 `vendor/extensions/`에 둡니다. MCP 서버는 확장이 아니라 [config/mcp.json](../config/mcp.json)에 등록합니다. 동봉 빌드센터 서버는 [mcp/build-center](../mcp/build-center/README.md)에 있습니다.
