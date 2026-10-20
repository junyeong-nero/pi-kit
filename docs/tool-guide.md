# 상세 도구 가이드

사용자 요청과 프로젝트의 `AGENTS.md`를 확인하고, 요청한 범위를 수정·검증까지 완료한다. 사용 가능한 도구의 설명과 입력 스키마를 따른다. 도구·경로·실행 결과를 추측해 만들지 않는다.

## 작업 흐름

1. 프로젝트 규칙에서 소스 위치, 빌드·테스트 명령, 수정 금지 경로를 확인한다. 기존 사용자 변경을 보존한다.
2. 관련 파일을 찾고 필요한 본문을 읽는다. C++·C# 심볼 변경은 정의와 사용처도 확인한다.
3. 기존 형식·인코딩·줄바꿈을 유지해 필요한 부분만 수정한다.
4. 변경에 맞는 진단·빌드·테스트를 실행하고 결과를 확인한다. 실패하면 첫 오류부터 원인을 수정한다.
5. 바뀐 동작, 실행한 검증과 결과, 남은 문제를 간결하게 보고한다.

여러 파일을 바꾸거나 영향 범위가 넓으면 수정할 파일과 작업 순서 3~5개를 먼저 적는다. 질문 답변이나 작은 수정에는 별도 계획이 필요 없다. 앞선 결과가 필요한 호출은 결과를 확인한 뒤 진행한다. 사용자가 이미 요청한 작업의 허가를 반복해서 묻지 않는다.

상세 코드 도구는 `harness_tools({"group":"code"})`, 구조 검색은 `ast`, 허가된 위임은 `subagents` 그룹을 먼저 켠다. 빌드센터(build center) 같은 MCP 도구는 `tool_search({"query":"빌드센터 모듈 결과"})`로 찾는다. 기본 도구 설명에는 필요한 입력 스키마가 있으며 이 문서는 필요할 때 읽는다.

## 탐색과 도구 선택

| 목적 | 도구와 기준 |
|---|---|
| 파일·폴더 찾기 | `find`, `ls` |
| 문자열 검색 | `grep`; 경로·파일 형식·출력량을 제한 |
| 본문 확인 | `read`의 `offset`·`limit`으로 필요한 범위만 읽기 |
| 파일 구조 파악 | `module_report`; 결과가 없으면 `lsp_symbols` |
| 이름만 아는 C++·C# 심볼 | `find_symbol`로 정의·참조를 함께 조회 |
| 위치를 아는 C++·C# 심볼 | `lsp_definition`, `lsp_references`, `lsp_hover` |
| 파일 진단 | `lsp_diagnostics` |
| 기존 파일 수정 / 새 파일 작성 | `edit` / `write` |
| 명령 실행 | `powershell` |

`node_modules`, `bin`, `obj`, `.git`, `dist`, `build`, `out` 등은 일반 소스 검색에서 제외한다. 의존성·빌드 문제 조사에 필요하면 해당 파일만 좁혀 읽는다. 결과가 잘렸다면 경로·패턴·파일 형식을 좁혀 다시 검색한다. 잘린 결과만 보고 사용처를 모두 찾았다고 결론 내리지 않는다.

아래 경로·심볼·줄 번호는 호출 형식 예시다. 실제 값은 검색과 읽기로 확인한다. `line`은 1부터 시작하고, `symbol`은 그 줄에 있는 식별자다.

```
find({"pattern":"*.cs","path":"src"})
grep({"pattern":"CreateSession","path":"src","glob":"*.cpp","limit":50})
read({"path":"src/main.cpp","offset":100,"limit":80})
module_report({"path":"src/Session.cs","view":"compact"})
find_symbol({"name":"CreateSession","path":"src","language":"cpp"})
lsp_definition({"path":"src/main.cpp","line":12,"symbol":"CreateSession"})
lsp_references({"path":"src/main.cpp","line":12,"symbol":"CreateSession"})
lsp_hover({"path":"src/main.cpp","line":12,"symbol":"CreateSession"})
lsp_symbols({"path":"src/main.cpp"})
lsp_symbols({"query":"Session","language":"cpp"})
lsp_diagnostics({"path":"src/main.cpp"})
```

`module_report`는 구조 확인용이므로 수정 전에는 본문도 읽는다. `lsp_symbols`의 `path`는 파일 내 목록, `query`는 워크스페이스 이름 검색이다. `find_symbol`의 `path`·`language`는 검색 범위를 좁힌다.

## 수정과 실패 처리

- `edit`의 `oldText`는 읽은 내용을 공백·들여쓰기까지 그대로 쓰고, 파일에서 정확히 한 번만 일치하게 만든다.
- 한 파일의 겹치지 않는 변경은 `edits` 배열로 묶는다. 작은 수정에 `write`로 파일 전체를 덮어쓰지 않는다.
- 편집이 실패하면 해당 부분을 다시 읽고 인자를 고친다. 같은 실패 호출을 원인 확인 없이 반복하지 않는다.
- 함수 이름·인자를 바꿀 때는 선언·정의·호출부·관련 테스트를 함께 확인한다. 동명이인 심볼을 일괄 치환하지 않는다.
- 새 파일은 비슷한 기존 파일의 형식을 따르고, 프로젝트 파일에 등록이 필요한지 확인한다.

```
edit({"path":"src/main.cpp","edits":[{"oldText":"int retry = 3;","newText":"int retry = 5;"}]})
```

## Windows 명령과 빌드

셸은 `powershell`을 사용하고 PowerShell 5.1 문법을 지킨다. `&&`, `export`, `source`, Bash heredoc을 쓰거나 Bash·WSL이 있다고 가정하지 않는다. 공백이 있는 실행 경로는 `& 'D:\Tools\tool.exe'`처럼 호출한다. 외부 프로그램의 종료 코드는 실행 직후 `$LASTEXITCODE`로 확인한다.

빌드 명령은 프로젝트 `AGENTS.md`와 기존 빌드 설정을 따른다. `setup.ps1`은 설치된 Visual Studio / Build Tools의 MSBuild를 찾으면 시스템 PATH와 `HSC_MSBUILD_EXE`에 등록한다. 새 터미널에서 `msbuild` 또는 `& $env:HSC_MSBUILD_EXE`로 실행할 수 있다. 솔루션·Configuration·Platform은 프로젝트에 맞는 값을 확인한다.

```powershell
# 실제 솔루션과 구성으로 바꿔 실행한다.
msbuild .\MyApp.sln /m /p:Configuration=Debug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

도구를 찾지 못하면 `Get-Command msbuild -ErrorAction SilentlyContinue` 등으로 확인하고 누락된 항목을 알린다. 폐쇄망에서 인터넷 다운로드·도구 설치를 시도하지 않는다. 프로젝트의 기존 SDK·타기팅 팩·NuGet 소스·캐시·복원 절차를 사용하고, 언어 서버용 SDK로 프로젝트 빌드 환경을 바꾸지 않는다.

`find`·`grep`보다 제외 조건이나 출력 형식 지정이 필요하면 동봉된 `fd`·`rg`를 사용한다.

```powershell
fd -e cpp -e h -E bin -E obj . src
rg -n -w -g '*.cpp' -g '!bin' -g '!obj' 'CreateSession' src
rg -l -F 'CreateSession' src
```

`rg -n`은 줄 번호, `-w`는 단어 일치, `-F`는 문자열 그대로, `-l`은 파일 이름만 출력한다. 종료 코드 1은 검색 결과가 없다는 뜻이다.

## Python

별도 `python` 도구는 없다. 동봉 Python(`runtime\python`)이 시스템 PATH에 있으므로 `powershell` 도구에서 실행한다. 검색·집계·변환처럼 한글이 섞일 수 있는 처리는 PowerShell cmdlet보다 Python을 쓴다. 폐쇄망이므로 `pip install`·다운로드는 시도하지 않고, 동봉 패키지(redis-py 등)만 쓴다.

여러 줄 코드는 `write`로 `.py` 파일을 만든 뒤 실행한다. PowerShell 5.1은 외부 프로그램 인자 안의 큰따옴표를 제대로 넘기지 못하므로 `python -c`에는 짧은 한 줄만 쓴다. `powershell` 도구가 `PYTHONUTF8=1`을 설정하므로 한글 출력은 그대로 읽힌다.

```powershell
python .\script.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

다른 인코딩 파일을 Python으로 직접 읽고 쓸 때는 `open(path, encoding="cp949")`처럼 원래 인코딩을 지정한다. 파이썬 명령이 없으면 `Get-Command python`으로 확인하고 `setup.ps1` 실행 여부를 알린다.

## 파일 인코딩

`read`·`edit`·`write`는 UTF-8, UTF-8 BOM, UTF-16(BOM), CP949 파일을 판별해 모델에는 UTF-8 텍스트로 보여 주고, 저장할 때 원래 인코딩·BOM·줄바꿈을 유지한다. 결과 끝의 `[원래 인코딩 CP949 유지]` 같은 표시로 확인한다. CP949에 없는 문자(이모지 등)는 저장하지 않고 오류를 낸다. 판별할 수 없는 파일은 고치지 않는다.

새 파일은 `.editorconfig`의 `charset` → 같은 확장자의 주변 파일(가까운 폴더부터 작업 폴더까지, 한글이 든 파일만 근거) → 기본값(C/C++/C#/PowerShell은 UTF-8 BOM, 그 밖은 UTF-8) 순서로 인코딩을 정한다. 한글이 든 `.ps1`은 Windows PowerShell 5.1이 읽도록 항상 BOM을 붙인다.

PowerShell의 `Set-Content`·`Out-File`·`>`는 인코딩을 바꾸므로 소스·스크립트 수정에 쓰지 않는다. `grep`은 한글 검색어로 CP949 파일을 찾지 못하므로 `rg -E euc-kr '한글' 경로`를 쓴다. 사용자는 `/encodings`로 프로젝트의 확장자별 인코딩 분포를 볼 수 있다.

## 검증 기준

- 편집 결과에 붙은 진단을 먼저 읽고, 필요하면 `lsp_diagnostics`로 최신 상태를 확인한다.
- `analysis pending`·시간 초과·서버 실패는 오류 없음이 아니다. 같은 요청만 반복하지 말고 설정·출력을 확인한다. LSP를 사용할 수 없으면 범위를 좁힌 `grep`·`rg`로 조사하고 분석 한계를 보고한다.
- 진단이 깨끗해도 빌드 성공을 뜻하지 않는다. 동작에 영향을 주는 코드 변경은 관련 빌드·테스트로 확인한다. 문구·주석 수정에 무관한 전체 빌드를 반복하지 않는다.
- 빌드 실패 시 첫 오류의 파일·줄·주변 코드를 읽고 원인을 수정한 뒤 다시 빌드한다. 관련 없는 기존 오류는 구분해 보고한다.
- 실행하지 않은 테스트·CI·실제 서버 접속을 성공으로 보고하지 않는다. 실행할 수 없으면 이유와 미확인 범위를 적는다.

## SVN 작업 사본

먼저 프로젝트가 SVN 작업 사본인지 Git 저장소인지 확인한다. SVN은 동봉된 명령으로 `svn status`, `svn diff`, `svn info`를 사용한다. 서버 조회는 `svn log --limit 10 --non-interactive`처럼 입력 대기를 막는다. 인증 실패 시 기존 사내 인증 설정을 확인하게 하며 비밀번호를 명령·파일·대화에 기록하지 않는다. 커밋·업데이트·되돌리기는 사용자가 요청한 범위에서 수행한다.

## Redis 조회와 로컬 서버

프로젝트 모듈·빌드·동적시험·정적시험 조회(사용자가 "빌드센터"·"build center"라고 부르는 경우 포함)에는 동봉 빌드센터 MCP 도구(`mcp__build_center__*`)를 우선 사용한다. 보이지 않으면 `tool_search`로 먼저 찾는다. `list_projects`로 ProjectName을 확인하고 `find_modules`로 이름·경로·담당자 ID/한글 이름을 검색한다. 동명 모듈은 경로·ID로 구분하며 결과의 module ID 목록으로 `get_results`를 호출한다. task는 build(빌드), dynamic(동적시험), static(정적시험)이며 생략하면 세 종류를 모두 조회한다. 로그는 `get_log`로 필요한 범위만 가져온다. 키마다 redis-cli 또는 python 프로세스를 반복 실행하지 않는다.

MCP는 `config/redis/server_IP_mappings.json`의 ProjectName→IP와 `owners.json`의 owner→owner_kr 매핑을 사용한다. 각 Redis 값은 Hash가 아닌 String 안의 JSON이다. 문자열 state `"4"`만 성공, `"5"`만 실패이며 다른 값은 미확인이다. checktime=마지막 성공 시각, meanbuildtime=소요 시간(초)은 미확정 가정이므로 확정 사실로 설명하지 않는다. 키 누락·잘못된 JSON·연결 실패를 성공이나 실행 이력 없음으로 단정하지 않는다. 최신 키 값만 조회하며 과거 실행 이력을 추론하지 않는다. 담당자 검색은 itemid.owner 기준이다. 검색의 next_offset과 로그의 이전/다음 페이지 위치를 따라가며 잘린 결과를 전체 결과로 설명하지 않는다.

`powershell`에서 동봉된 `redis-cli`를 사용한다. 주소·포트·DB 번호·키 범위는 사용자가 지정한 값을 따른다. `PING`, `TYPE`, `GET`, `HGET` 등으로 필요한 값만 조회한다. 키 탐색은 `SCAN <커서> MATCH '업무:*' COUNT 100`처럼 좁히고, 반환된 커서로 이어간다. `COUNT`는 힌트이므로 큰 결과를 제한 없이 출력하지 않는다.

인증은 기존 `REDISCLI_AUTH`와 필요시 `--user`를 사용한다. MCP의 ACL 사용자 이름은 `HSC_REDIS_USERNAME`을 사용하며 다른 환경 변수명과 TLS CA는 `config/redis/settings.json`에서 지정할 수 있다. 비밀번호를 명령·파일·대화에 기록하지 않고, 자동 호출에서는 입력을 기다리는 `--askpass`를 쓰지 않는다. TLS 서버에는 `--tls`와 사내 CA의 `--cacert`를 지정한다. 데이터 변경·삭제는 사용자 요청 범위에서 수행한다. MCP 연결 실패 시 사내 매핑·인증 설정을 확인한다.

MSYS2 with-Service 패키지 전체가 동봉돼 있다. 로컬 서버를 요청받으면 배포 폴더 밖에 데이터 폴더를 만들고 `RedisService run --foreground -c "$env:PI_CODING_AGENT_DIR\redis.local.conf" --dir '<데이터 폴더>'`로 실행한다. Windows 경로 변환은 래퍼가 처리한다. 설정 예시는 `127.0.0.1:6379`에서만 연결을 받으며 `--dir`로 지정한 폴더에 `dump.rdb`를 저장한다. 서버는 실행한 터미널을 점유하므로 별도 터미널에서 조회하고, 종료는 해당 로컬 주소·포트를 명시한 `redis-cli -h 127.0.0.1 -p 6379 SHUTDOWN SAVE`를 사용한다. Windows 서비스 등록은 사용자가 요청할 때 수행한다. 사내 서버와 로컬 서버의 주소·데이터를 구분하고, 사용 중인 포트를 임의로 종료하지 않는다.

`redis-benchmark`는 지정한 대상에서 부하를 발생시키므로 성능 측정을 요청받았을 때 실행한다. 저장 파일 검사는 `redis-check-rdb`·`redis-check-aof`를 사용하며 복구 옵션을 적용하기 전에 원본을 보관한다. `redis-sentinel`의 감시 대상·구성은 사용자가 지정한 범위에서 설정한다. 원본 `redis.conf`·`sentinel.conf`는 `bin\redis\`에 보존돼 있다.

## 확장과 서브에이전트

단순 검색·수정은 직접 처리한다. pi-lens는 구조 분석이 필요할 때 사용하고, 숨겨진 도구의 이름·인자를 추측하지 않는다.

조사·검토를 나눌 필요가 있으면 `harness_tools({"group":"subagents"})`로 도구를 켜고 `subagents_enable`로 활성화한 뒤 읽기 전용 `scout`·`reviewer`를 사용한다. Windows에서는 `async: false`를 명시한다. 하위 에이전트에 작업 범위·사용할 도구·금지할 변경·완료 조건을 전달하고 결과를 직접 확인한다. 같은 파일을 동시에 수정하게 하지 않는다.

```
subagent({"agent":"scout","async":false,"task":"src/Session/에서 CreateSession 사용처를 조사한다. find, grep, read만 사용하고 파일을 수정하지 않는다. 파일:줄 목록과 3줄 요약을 반환한다."})
```
