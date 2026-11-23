"""Bundled stdio MCP that runs agent-written VBA against documents already open in Word.

The code goes into a hidden scratch document that is closed without saving, never into the user's
document or Normal.dotm, so DRM documents stay untouched. stdout is reserved for the MCP protocol.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import re
import secrets
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

ERROR_MARK = "\x01PI_VBA_ERROR\x01"
MAX_OUTPUT = 30000
WD_ALERTS_NONE = 0
SCRATCH_VISIBLE = True  # Run finds macros of the active document only; a hidden document may never become active
VBOM_HELP = ("Word가 VBA 코드 추가를 막았습니다. Word의 파일 → 옵션 → 보안 센터 → 보안 센터 설정 → 매크로 설정에서 "
             "'VBA 프로젝트 개체 모델에 안전하게 액세스'를 켜고 Word를 다시 시작하세요(회사 보안 정책 확인 후)")

# COM objects belong to the thread that made them: every Word call runs on one initialized thread, one at a time.
_executor = ThreadPoolExecutor(max_workers=1, initializer=lambda: __import__("pythoncom").CoInitialize())
_busy = False


def build_module(code, entry):
    """User code first (Option lines must lead the module), then the entry Word runs.

    Application.Run only finds macros of the active document, so Word runs the entry while the scratch document is
    active; the entry then activates the target, groups the changes into one undo entry and turns errors into text.
    """
    if not re.search(r"^\s*(Public\s+|Private\s+)?Function\s+PiMain\s*\(\s*\)", code, re.IGNORECASE | re.MULTILINE):
        raise ValueError("code에 인자 없는 Function PiMain() As String이 있어야 합니다")
    return (code.replace("\r\n", "\n").rstrip() + "\n\n"
            f"Public Function {entry}(targetName As String, undoName As String) As String\n"
            "    On Error GoTo Failed\n"
            "    Documents(targetName).Activate\n"
            "    Application.UndoRecord.StartCustomRecord undoName\n"
            f"    {entry} = CStr(PiMain())\n"
            "    Application.UndoRecord.EndCustomRecord\n"
            "    Exit Function\n"
            "Failed:\n"
            f"    {entry} = Chr$(1) & \"PI_VBA_ERROR\" & Chr$(1) & Err.Number & \": \" & Err.Description\n"
            "    If Application.UndoRecord.IsRecordingCustomRecord Then Application.UndoRecord.EndCustomRecord\n"
            "End Function\n").replace("\n", "\r\n")


def parse_result(result):
    text = "" if result is None else str(result)
    if text.startswith(ERROR_MARK):
        raise ValueError(f"VBA 실행 오류 {text[len(ERROR_MARK):]}")
    if len(text) > MAX_OUTPUT:
        return {"output": text[:MAX_OUTPUT], "truncated": True, "total_chars": len(text),
                "note": f"앞 {MAX_OUTPUT}자만 반환했습니다. 범위를 나눠 다시 실행하세요"}
    return {"output": text, "truncated": False}


def _word():
    import pywintypes
    import win32com.client
    try:
        return win32com.client.GetActiveObject("Word.Application")
    except pywintypes.com_error:
        raise ValueError("Word가 실행 중이 아닙니다. 문서를 Word로 먼저 여세요") from None


def _documents(app):
    return [app.Documents(i) for i in range(1, app.Documents.Count + 1)]


def _target(app, document):
    if app.Documents.Count == 0:
        raise ValueError("Word에 열린 문서가 없습니다")
    if not document:
        return app.ActiveDocument
    wanted = document.casefold()
    found = [d for d in _documents(app) if wanted in (d.Name.casefold(), d.FullName.casefold())]
    if len(found) != 1:
        raise ValueError(f"문서를 하나로 정할 수 없습니다: {document}. list_documents로 이름을 확인하세요")
    return found[0]


def _list_documents():
    app = _word()
    active = app.ActiveDocument.FullName if app.Documents.Count else None
    return {"documents": [{"name": d.Name, "full_name": d.FullName, "active": d.FullName == active,
                           "saved": bool(d.Saved), "read_only": bool(d.ReadOnly)} for d in _documents(app)]}


def _run_vba(code, document, undo_name):
    import pywintypes
    entry = "PiRun_" + secrets.token_hex(4)
    module_code = build_module(code, entry)
    app = _word()
    target = _target(app, document)
    target_name = target.FullName
    alerts, screen = app.DisplayAlerts, app.ScreenUpdating
    app.ScreenUpdating = False  # the scratch window must be active for Run; keep it from flashing
    scratch = app.Documents.Add("", False, 0, SCRATCH_VISIBLE)  # Template, NewTemplate, DocumentType, Visible
    try:
        try:
            module = scratch.VBProject.VBComponents.Add(1)  # vbext_ct_StdModule
        except (pywintypes.com_error, AttributeError):
            raise ValueError(VBOM_HELP) from None
        module.Name = "PiMcp_" + entry[6:]
        module.CodeModule.AddFromString(module_code)
        scratch.Activate()
        app.DisplayAlerts = WD_ALERTS_NONE
        result = app.Run(f"{module.Name}.{entry}", target_name, undo_name)
    finally:
        app.DisplayAlerts = alerts
        scratch.Close(0)  # wdDoNotSaveChanges
        target.Activate()
        app.ScreenUpdating = screen
    return {"document": target.Name, **parse_result(result)}


async def _call(function, *args, timeout=None):
    global _busy
    import pywintypes
    if _busy:
        raise ToolError("이전 VBA 실행이 아직 끝나지 않았습니다. Word에 오류·확인 창이 떠 있으면 닫은 뒤 다시 시도하세요")
    _busy = True
    future = asyncio.get_running_loop().run_in_executor(_executor, function, *args)

    def done(_future):
        global _busy
        _busy = False
    future.add_done_callback(done)
    # MCP SDK 2 shows the model the text of a ToolError only
    try:
        return await asyncio.wait_for(asyncio.shield(future), timeout)
    except asyncio.TimeoutError:
        raise ToolError(f"VBA가 {timeout}초 안에 끝나지 않았습니다. Word에 VBA 컴파일 오류나 확인 창이 떠 있으면 닫으세요. "
                        "창을 닫으면 실행이 끝나고 다음 호출을 받을 수 있습니다") from None
    except ValueError as error:
        raise ToolError(str(error)) from None
    except pywintypes.com_error as error:
        detail = error.excepinfo[2] if error.excepinfo and error.excepinfo[2] else error.strerror
        raise ToolError(f"Word COM 오류: {detail}") from None


def create_server():
    server = MCPServer("Word VBA", version="1.0.0")

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    async def list_documents() -> dict[str, Any]:
        """List documents open in Word: name, full path, which one is active."""
        return await _call(_list_documents, timeout=30)

    @server.tool(annotations={"readOnlyHint": False, "destructiveHint": True})
    async def run_vba(code: str, document: str | None = None, undo_name: str = "MCP: VBA",
                      timeout_seconds: int = 120) -> dict[str, Any]:
        """Run a VBA module against a document open in Word and return what PiMain returns.

        code must define `Function PiMain() As String`; helper Subs/Functions may follow. The target document
        (document name/path, or the active one) is ActiveDocument while it runs. Build output with vbLf and return it;
        MsgBox/InputBox block Word, never use them. Errors come back as 'VBA 실행 오류 <number>: <description>'.
        All changes are one Ctrl+Z entry named undo_name. Output beyond 30000 chars is cut: read in parts.
        Word facts: Range.Information(1) = printed page number (what a TOC shows), Information(3) = page counted
        from the first page; TOC entries are Hyperlinks whose SubAddress is a hidden _Toc bookmark
        (Bookmarks.ShowHidden = True) on the heading; Paragraph.OutlineLevel 1-9 = heading level, 10 = body text;
        Fields(i).Code / .Result / .Update, Fields.Update = F9, TablesOfContents(1).Update refreshes TOC pages.
        Loop with For Each over collections; Paragraphs(i) by index is slow on long documents.
        """
        return await _call(_run_vba, code, document, undo_name, timeout=max(5, min(timeout_seconds, 580)))

    return server


if __name__ == "__main__":
    create_server().run(transport="stdio")
