# 프로젝트 규칙

<!--
사용법: 이 파일을 작업 프로젝트 루트에 `AGENTS.md`로 복사하고 <...> 부분을 채운다.
쓰지 않는 섹션은 지운다. 짧고 구체적으로 적을수록 모델이 잘 따른다.
도구 선택 규칙(find, grep, LSP 등)은 하네스 공통 가이드에 있으므로 여기에 다시 적지 않는다.
-->

## 프로젝트 개요

<!-- 1~2줄. 무엇을 하는 프로젝트이고 주 언어·빌드 시스템은 무엇인지. -->
<프로젝트가 하는 일>. 언어: <C++17 / C# .NET 8 등>, 빌드: <MSBuild / dotnet / CMake>.

## 디렉터리 지도

<!-- 주요 폴더와 역할만. 모델이 탐색에 쓰는 시간을 줄이는 것이 목적이다. -->
| 경로 | 역할 |
|---|---|
| `<src\Core>` | <핵심 로직> |
| `<src\App>` | <실행 진입점> |
| `<tests>` | <테스트 프로젝트> |

## 빌드·테스트 명령

<!-- PowerShell 5.1에서 그대로 실행되는 한 줄 명령. `&&`는 쓰지 않는다. 아래는 예시이므로 실제 명령으로 바꾼다. -->
- 빌드: `<msbuild .\MyApp.sln /m /p:Configuration=Debug>`
- 빌드(.NET): `<dotnet build .\MyApp.sln -c Debug>`
- 빌드(CMake): `<cmake --build .\build --config Debug>`
- 전체 테스트: `<dotnet test .\tests\MyApp.Tests.csproj>`
- 단일 테스트: `<dotnet test .\tests\MyApp.Tests.csproj --filter "FullyQualifiedName~테스트이름">`

## 코딩 규칙

<!-- 모델이 틀리기 쉬운 규칙만 적는다. -->
- <명명 규칙, 예: 클래스는 PascalCase, 멤버 변수는 m_ 접두사>
- <파일 인코딩·줄바꿈, 예: UTF-8 BOM, CRLF>
- <사용하지 말 것, 예: raw new/delete, 새 외부 라이브러리 추가>

## 수정 금지 경로

<!-- 생성 파일, 외부 코드, 빌드 산출물. 필요하면 수정 대신 사용자에게 알리도록 적는다. -->
- `<third_party\>`: 외부 코드
- `<Generated\>`, `*.g.cs`, `*.designer.cs`: 자동 생성 파일
- `<bin\>`, `<obj\>`, `<build\>`: 빌드 산출물

## 작업 완료 조건

<!-- 아래를 프로젝트에 맞게 고친다. -->
- 수정한 파일에 `lsp_diagnostics` 오류가 없다.
- 위 빌드 명령이 성공한다.
- 관련 테스트를 실행해 결과를 확인했다. 실행하지 못했다면 이유를 보고한다.
