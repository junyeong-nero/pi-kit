# Word VBA MCP

Word에서 열어 둔 문서에 에이전트가 쓴 VBA를 실행하는 동봉 MCP 서버입니다. `config/mcp.json`의 서버 이름은 `word_vba`입니다.

- **도구:** `list_documents`(열린 문서 목록)와 `run_vba`(VBA 실행). 도구가 두 개뿐이라 모델에 보내는 도구 설명이 짧습니다.
- **실행:** pi 내장 MCP 기능이 동봉 Python으로 `python -I -X utf8 -B -m word_vba`를 실행합니다. `python313._pth`가 이 폴더를 모듈 경로에 넣습니다. Word 연결에는 동봉 `pywin32`를 씁니다.
- **필요 설정:** Word의 파일 → 옵션 → 보안 센터 → 보안 센터 설정 → 매크로 설정에서 "VBA 프로젝트 개체 모델에 안전하게 액세스"를 켜고 Word를 다시 시작합니다. 꺼져 있으면 `run_vba`가 이 안내를 오류로 돌려줍니다. 이 설정은 PC의 다른 프로그램에도 적용되므로 회사 보안 정책을 먼저 확인하세요.

## `run_vba` 동작

1. 코드에 인자 없는 `Function PiMain() As String`이 있는지 확인합니다. 보조 `Sub`·`Function`은 함께 써도 됩니다.
2. 임시 문서를 만들어 코드와 실행용 함수를 넣습니다. 작업할 문서나 `Normal.dotm`에는 코드를 넣지 않습니다. Word의 `Application.Run`은 활성 문서의 매크로만 찾으므로 임시 문서를 활성화한 채 실행합니다. 화면 갱신은 꺼서 창이 깜빡이지 않게 합니다.
3. 실행용 함수가 대상 문서(`document`, 생략하면 현재 문서)를 활성화하고 `PiMain`을 부릅니다. 그래서 `PiMain` 안의 `ActiveDocument`는 대상 문서입니다. 실행 중 경고 창은 끄고, 변경은 `undo_name` 하나의 실행 취소 항목으로 묶습니다.
4. `PiMain`이 돌려준 문자열을 결과로 반환합니다. 실행 중 오류는 `VBA 실행 오류 <번호>: <설명>`으로 돌려줍니다. 30000자를 넘는 결과는 앞부분만 반환합니다.
5. 임시 문서를 저장하지 않고 닫습니다.

VBA 문법 오류는 실행 전에 Word가 컴파일 오류 창을 띄울 수 있습니다. 그러면 `timeout_seconds`(기본 120초, 최대 580초) 뒤에 안내를 돌려줍니다. 창이 닫힐 때까지 다음 호출은 바로 거절합니다. Word 화면에서 창을 닫으면 다시 쓸 수 있습니다. `MsgBox`·`InputBox`도 Word를 멈추게 하므로 쓰지 않습니다.

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
