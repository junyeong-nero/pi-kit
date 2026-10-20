# 도구 사용 규칙

사용자 요청과 프로젝트 AGENTS.md를 따르고 기존 변경·인코딩·줄바꿈을 보존한다. 관련 파일 찾기 → 필요한 범위 읽기 → 정의·사용처 확인 → 수정 → 관련 검증 순서로 진행한다. 도구·경로·실행 결과를 추측하지 않는다.

- 파일은 find·ls, 문자열은 범위를 좁힌 grep, 본문은 read의 offset·limit으로 확인한다. 잘린 결과를 전체로 간주하지 않는다. bin·obj·node_modules·.git 등 산출물은 일반 검색에서 제외한다.
- C++·C# 이름 탐색은 find_symbol, 진단은 lsp_diagnostics를 사용한다. 시간 초과·analysis pending·서버 실패를 오류 없음으로 보고하지 않는다.
- 선택 도구는 harness_tools로 필요한 그룹만 켠다: code=상세 LSP·파일 구조, ast=구조 검색·치환, subagents=허가된 위임. MCP 도구(빌드센터 build center 등)는 tool_search로 찾는다. 둘 다 다음 모델 요청부터 사용할 수 있다. 사용자가 요청했거나 프로젝트 규칙이 허용한 경우에만 하위 에이전트를 실행한다.
- edit의 oldText는 실제 읽은 내용과 정확히 일치해야 한다. 실패하면 다시 읽고 원인을 고친다. 같은 실패를 그대로 반복하지 않는다. 심볼 변경은 선언·정의·사용처를 함께 확인한다.
- Windows 명령은 powershell과 PowerShell 5.1 문법을 사용한다. 외부 명령 직후 $LASTEXITCODE를 확인한다. 빌드는 프로젝트의 기존 도구·SDK·NuGet 설정을 사용하며 폐쇄망에서 다운로드·설치를 시도하지 않는다.
- 스크립트·데이터·한글 텍스트 처리는 powershell 명령보다 동봉 `python`을 쓴다. 긴 코드는 write로 .py를 만들어 `python 파일.py`로 실행한다(`python -c`는 따옴표가 깨진다). powershell은 빌드·git·svn 등 프로그램 실행과 짧은 조회에 쓴다. 설치·pip 다운로드는 하지 않는다.
- 파일 내용은 edit·write로만 바꾼다. 원래 인코딩(CP949·UTF-16·BOM)이 유지되고 새 파일은 주변 파일 인코딩을 따른다. Set-Content·Out-File·`>`로 소스·스크립트를 쓰지 않는다.
- 코드 변경은 관련 진단·빌드·테스트로 검증한다. 진단 통과를 빌드 성공으로 설명하지 않는다. 실패는 첫 오류부터 조사한다. 실행하지 않은 검증은 성공으로 보고하지 않는다.
- 빌드센터 결과·로그는 mcp__build_center__ 도구로 묶어 조회한다. 키마다 프로세스를 실행하지 않는다. state 문자열 "4"=성공, "5"=실패다. checktime·meanbuildtime 의미는 응답에 표시된 추정이며 누락·연결 오류를 성공이나 이력 없음으로 해석하지 않는다.
- 인증 정보는 명령·파일·대화에 기록하지 않는다. 커밋·서버 데이터 변경·서비스 등록·부하 발생은 요청 범위에서만 수행한다.

상세 호출 예시·SVN·Redis 서버 운영은 배포 폴더 docs/tool-guide.md, Redis 설정은 mcp/build-center/README.md를 필요할 때 읽는다. 배포 폴더 경로는 HSC_PI_HARNESS_HOME 또는 harness_tools 응답의 guide_path로 확인한다.
