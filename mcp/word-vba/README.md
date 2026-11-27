# Word VBA MCP

Word에서 열어 둔 문서에 에이전트가 쓴 VBA를 실행하는 동봉 MCP 서버입니다. `config/mcp.json`의 서버 이름은 `word_vba`입니다.

- **도구:** `list_documents`(열린 문서 목록), `open_document`(파일을 숨겨서 열기), `close_document`(문서 닫기), `run_vba`(VBA 실행), `read_output`(긴 결과 이어 읽기). 도구가 적어 모델에 보내는 도구 설명이 짧습니다.
- **실행:** pi 내장 MCP 기능이 동봉 Python으로 `python -I -X utf8 -B -m word_vba`를 실행합니다. `python313._pth`가 이 폴더를 모듈 경로에 넣습니다. Word 연결에는 동봉 `pywin32`를 씁니다.
- **필요 설정:** Word의 파일 → 옵션 → 보안 센터 → 보안 센터 설정 → 매크로 설정에서 "VBA 프로젝트 개체 모델에 안전하게 액세스"를 켜고 Word를 다시 시작합니다. 꺼져 있으면 `run_vba`가 이 안내를 오류로 돌려줍니다. 이 설정은 PC의 다른 프로그램에도 적용되므로 회사 보안 정책을 먼저 확인하세요.

## `open_document`·`close_document` 동작

- `open_document(path, read_only=true)`는 `pywin32`(`win32com`)로 파일을 숨긴 창으로 엽니다. 열 때만 경고 창을 끄고(`DisplayAlerts`), 자동 매크로(`AutoOpen`, `Document_Open`)를 막고(`AutomationSecurity` = 강제 사용 안 함), 변환 확인·인코딩 창을 띄우지 않으며 최근 파일 목록에 넣지 않습니다. 끝나면 두 설정을 원래대로 돌립니다. 암호가 걸린 파일은 암호 창 대신 오류로 끝납니다.
- Word가 실행 중이면 그 Word에서 숨겨 엽니다. 실행 중이 아니면 `DispatchEx`로 보이지 않는 Word를 새로 띄우고, 다른 도구도 그 Word를 씁니다.
- 숨긴 문서는 활성 문서가 될 수 없으므로 `run_vba`가 실행하는 동안만 창을 보이게 했다가 다시 숨깁니다. 화면 갱신은 꺼 둡니다. `list_documents`의 `hidden`으로 숨긴 문서를 구분합니다.
- 숨긴 문서는 화면에서 닫을 수 없으니 `close_document(document, save)`로 닫습니다. 저장하지 않은 변경이 있으면 `save`를 정해야 닫습니다(`true` 저장, `false` 버림). MCP가 띄운 Word는 마지막 문서를 닫을 때 함께 종료합니다.
- MCP 연결이 끊기면(pi 종료·재연결) `open_document`로 연 문서를 **저장하지 않고** 모두 닫고, MCP가 띄운 Word도 종료합니다. 사용자가 직접 연 문서는 닫지 않습니다. VBA가 실행 중이면 끝날 때까지 최대 30초 기다리고, 그래도 끝나지 않으면 닫지 않고 종료합니다. MCP 프로세스가 강제 종료되면 정리할 기회가 없어 숨은 `WINWORD.EXE`가 남을 수 있습니다.

## `run_vba` 동작

1. 코드에 인자 없는 `Function PiMain() As String`이 있는지 확인합니다. 보조 `Sub`·`Function`은 함께 써도 됩니다. Word에 넣기 전에 블록 짝(If/End If, For/Next, Do/Loop, With, Select Case, Sub/Function 등)과 따옴표를 검사해, 문제가 있으면 `code` 기준 행 번호와 함께 바로 돌려줍니다. 올바른 코드를 거부하지 않도록 문장 맨 앞의 블록 키워드만 봅니다.
2. 임시 문서를 만들어 코드와 실행용 함수, 보조 함수(`PiTimeLeft`, `MsgBox`·`InputBox` 대체)를 넣습니다. 작업할 문서나 `Normal.dotm`에는 코드를 넣지 않습니다. Word의 `Application.Run`은 활성 문서의 매크로만 찾으므로 임시 문서를 활성화한 채 실행합니다. 화면 갱신은 꺼서 창이 깜빡이지 않게 합니다.
3. 실행용 함수가 대상 문서(`document`, 생략하면 현재 문서)를 활성화하고 `PiMain`을 부릅니다. 그래서 `PiMain` 안의 `ActiveDocument`는 대상 문서입니다. 실행 중 경고 창은 끄고, 변경은 `undo_name` 하나의 실행 취소 항목으로 묶습니다.
4. `PiMain`이 돌려준 문자열을 결과로 반환합니다. 실행 중 오류는 `VBA 실행 오류 <번호>: <설명>`으로 돌려줍니다.
5. 임시 문서를 저장하지 않고 닫고, 실행 전에 보던 문서를 다시 활성화합니다.

### 오류 안내

- **실행 전 검사:** `VBA 구문 오류(실행 전 검사, Word에는 넣지 않음)`와 항목별 행 번호
- **컴파일 실패:** 검사를 통과해도 선언하지 않은 변수, 없는 속성 이름 등으로 컴파일이 안 되면 `VBA를 컴파일하지 못해 실행하지 않았습니다`와 Word 메시지, 확인할 항목을 돌려줍니다. VBA 편집기가 오류 줄을 선택했으면 그 줄도 알려줍니다.
- **실행 중 오류:** `VBA 실행 오류 <번호>: <설명>`
- **시간 초과 뒤 실패:** 컴파일 오류 창 때문에 시간 초과가 난 뒤 창을 닫아 실패로 끝나면, 그 이유를 다음 호출 결과의 `previous_run`에 담습니다.
- **그 밖의 오류:** 예외 종류와 내용을 그대로 돌려줍니다.

### 긴 결과

결과는 기본 8000자(`max_chars`, 최대 30000자)까지만 보냅니다. 더 길면 나머지는 `output_id`와 함께 MCP 서버 메모리에 최근 5개까지 보관하고, `read_output`으로 이어서 읽습니다. DRM 문서 내용이 평문 파일로 남지 않도록 디스크에는 저장하지 않습니다.

### 시간 초과

실행 중인 VBA는 밖에서 멈출 수 없습니다. 그래서 VBA 안에서 `PiTimeLeft()`로 남은 시간을 확인해, 제한 시간(`timeout_seconds`, 기본 120초, 최대 580초)보다 10초 먼저 중간 결과와 이어서 할 위치를 돌려주게 합니다. 도구 설명에는 느린 호출도 안내합니다. 예를 들어 `Information`은 쪽 나눔을 다시 계산하므로 모든 문단이 아니라 제목에만 씁니다.

VBA 문법 오류는 실행 전에 Word가 컴파일 오류 창을 띄울 수 있습니다. 그러면 제한 시간 뒤에 안내를 돌려주고, 창이 닫힐 때까지 다음 호출은 바로 거절합니다. Word 화면에서 창을 닫으면 다시 쓸 수 있습니다.

### MsgBox·InputBox

두 함수는 클릭을 기다리며 Word를 멈추게 합니다. 모듈에 같은 이름의 함수를 넣어 가로채므로 창은 뜨지 않고, 내용은 결과의 `messages`에 담깁니다. `MsgBox`는 확인(1)을, `InputBox`는 기본값을 돌려줍니다. `VBA.MsgBox`처럼 라이브러리 이름을 붙여 부르면 가로채지 못합니다.

## 문제 해결: VBA 실행 진단

`run_vba`가 “Word COM 오류”로 실패하면, 작업할 문서를 Word에서 활성 상태로 둔 채 **Windows PowerShell 5.1**에서 아래를 실행합니다. 임시 문서에 매크로를 넣어 세 가지 방식으로 실행해 보고, 임시 문서는 모두 저장하지 않고 닫습니다. 작업할 문서는 바꾸지 않습니다.

```powershell
$w = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
$target = $w.ActiveDocument
'VBA 프로젝트 접근: ' + $(if ($null -eq $w.Documents.Add().VBProject) { '막힘 (옵션 확인 후 Word 재시작)' } else { 'OK' }); $w.ActiveDocument.Close(0); $target.Activate()
$code = "Function PiMain() As String`r`n PiMain = ActiveDocument.Name`r`nEnd Function`r`n" +
        "Public Function PiRun(n As String) As String`r`n Documents(n).Activate`r`n PiRun = PiMain()`r`nEnd Function"

function Try-Case($label, $visible, $activateTarget) {
    $t = $w.Documents.Add('', $false, 0, $visible)
    try {
        $m = $t.VBProject.VBComponents.Add(1); $m.Name = 'PiTestMod'
        $m.CodeModule.AddFromString($code)
        if ($activateTarget) { $target.Activate() }
        "$label 성공: " + $w.Run('PiTestMod.PiRun', $target.FullName)
    } catch { "$label 실패: " + $_.Exception.Message }
    finally { $t.Close(0); $target.Activate() }
}
Try-Case 'A (숨김 임시 문서, 대상 문서를 먼저 활성화)' $false $true
Try-Case 'B (보이는 임시 문서에서 실행, VBA가 대상 활성화)' $true $false
Try-Case 'C (숨김 임시 문서에서 실행, VBA가 대상 활성화)' $false $false
```

- **B 성공:** `run_vba`가 쓰는 방식입니다. 결과에 작업할 문서 이름이 나오면 정상입니다. A는 실패하는 게 정상입니다(Word가 활성 문서가 아닌 곳의 매크로를 찾지 않음).
- **VBA 프로젝트 접근이 막힘:** 위 “필요 설정”을 켜고 Word를 완전히 종료했다가 다시 실행합니다. 작업 관리자에 `WINWORD.EXE`가 남아 있으면 적용되지 않습니다.
- **B도 실패:** 매크로 설정이나 DRM이 매크로 실행 자체를 막는 경우입니다. 출력된 메시지를 관리자에게 전달하세요.
