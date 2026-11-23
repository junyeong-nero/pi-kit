"""Bundled stdio MCP that runs agent-written VBA against documents already open in Word.

The code goes into a scratch document that is closed without saving, never into the user's
document or Normal.dotm, so DRM documents stay untouched. stdout is reserved for the MCP protocol.
"""
import asyncio
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import re
import secrets
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

ERROR_MARK = "\x01PI_VBA_ERROR\x01"
MESSAGE_MARK = "\x03PI_VBA_MESSAGES\x03"
DEFAULT_OUTPUT = 8000
MAX_OUTPUT = 30000
MAX_MESSAGES = 2000
KEPT_OUTPUTS = 5
DEADLINE_MARGIN = 10  # seconds PiTimeLeft keeps for returning before the tool times out
WD_ALERTS_NONE = 0
SCRATCH_VISIBLE = True  # Run finds macros of the active document only; a hidden document never becomes active
VBOM_HELP = ("Word가 VBA 코드 추가를 막았습니다. Word의 파일 → 옵션 → 보안 센터 → 보안 센터 설정 → 매크로 설정에서 "
             "'VBA 프로젝트 개체 모델에 안전하게 액세스'를 켜고 Word를 다시 시작하세요(회사 보안 정책 확인 후)")

# MsgBox/InputBox wait for a click and freeze Word: same-named module functions shadow them and only collect the text.
SHIM_DECLARATIONS = """Private piMessages As String
Private piDeadline As Date
"""
SHIMS = """Public Function PiTimeLeft() As Boolean
    PiTimeLeft = Now < piDeadline
End Function

Private Function MsgBox(Prompt As Variant, Optional Buttons As Variant, Optional Title As Variant, _
                        Optional HelpFile As Variant, Optional Context As Variant) As Long
    piMessages = piMessages & CStr(Prompt) & vbLf
    MsgBox = 1
End Function

Private Function InputBox(Prompt As Variant, Optional Title As Variant, Optional Default As Variant, _
                          Optional XPos As Variant, Optional YPos As Variant, Optional HelpFile As Variant, _
                          Optional Context As Variant) As String
    piMessages = piMessages & "[InputBox] " & CStr(Prompt) & vbLf
    If Not IsMissing(Default) Then InputBox = CStr(Default)
End Function
"""

# COM objects belong to the thread that made them: every Word call runs on one initialized thread, one at a time.
_executor = ThreadPoolExecutor(max_workers=1, initializer=lambda: __import__("pythoncom").CoInitialize())
_busy = False
_late_error = None  # why a run that outlived its timeout failed, told on the next call

OPENERS = {"if": "If", "for": "For", "do": "Do", "while": "While", "with": "With", "select": "Select Case",
           "sub": "Sub", "function": "Function", "property": "Property", "type": "Type", "enum": "Enum"}
CLOSERS = {"if": "End If", "for": "Next", "do": "Loop", "while": "Wend", "with": "End With", "select": "End Select",
           "sub": "End Sub", "function": "End Function", "property": "End Property", "type": "End Type",
           "enum": "End Enum"}
PROCEDURE = re.compile(r"^((public|private|friend|static)\s+)*(sub|function|property\s+(get|let|set))\s+\w+")
PROCEDURE_KIND = re.compile(r"(sub|function|property)\b")


def _strip_comment(line):
    """Code part of one physical line, and whether a string is left open."""
    in_string = False
    for i, char in enumerate(line):
        if char == '"':
            in_string = not in_string
        elif char == "'" and not in_string:
            return line[:i], False
    code = line.strip()
    if code.lower() == "rem" or code.lower().startswith("rem "):
        return "", False
    return line, in_string


def _statements(text):
    """Split a logical line at ':' outside strings; ':=' is a named argument, not a separator."""
    parts, start, in_string = [], 0, False
    for i, char in enumerate(text):
        if char == '"':
            in_string = not in_string
        elif char == ":" and not in_string and text[i + 1:i + 2] != "=":
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    return [p.strip().lower() for p in parts if p.strip()]


def check_syntax(code):
    """Catch the usual compile errors (unclosed blocks, stray closers, open strings) before Word sees the code.

    Conservative on purpose: valid VBA must never be rejected, so only block keywords that start a statement count.
    """
    issues, stack = [], []
    physical = code.replace("\r\n", "\n").split("\n")
    logical, pending, first = [], "", None
    for number, line in enumerate(physical, 1):
        part, open_string = _strip_comment(line)
        if open_string:
            issues.append(f"{number}행: 따옴표(\")가 닫히지 않았습니다")
            part = part[:part.rfind('"')]
        first = first or number
        if re.search(r"(^|\s)_\s*$", part):
            pending += re.sub(r"_\s*$", " ", part)
            continue
        logical.append((first, pending + part))
        pending, first = "", None
    if pending:
        logical.append((first, pending))

    def close(kind, number):
        if not stack:
            issues.append(f"{number}행: {CLOSERS[kind]}에 맞는 {OPENERS[kind]}이(가) 없습니다")
            return
        if stack[-1][0] == kind:
            stack.pop()
            return
        top, line = stack[-1]
        issues.append(f"{number}행: {CLOSERS[kind]} 전에 {line}행의 {OPENERS[top]}을(를) {CLOSERS[top]}(으)로 닫아야 합니다")
        if any(k == kind for k, _ in stack):
            while stack.pop()[0] != kind:
                pass

    for number, text in logical:
        statements = _statements(text)
        for index, s in enumerate(statements):
            if s.startswith("#"):
                continue
            procedure = PROCEDURE.match(s)
            end = re.match(r"end\s+(if|sub|function|property|with|select|type|enum)\b", s)
            if procedure and "declare " not in s:
                kind = PROCEDURE_KIND.match(procedure.group(3)).group(1)
                for open_kind, line in stack:
                    issues.append(f"{line}행의 {OPENERS[open_kind]}이(가) 닫히지 않았습니다({CLOSERS[open_kind]} 필요)")
                stack[:] = [(kind, number)]
            elif end:
                close(end.group(1), number)
            elif re.match(r"if\b", s):
                # Block If only when Then ends the line: "If x Then: y" is a one-line If
                if re.search(r"\bthen$", s) and index == len(statements) - 1 and not text.rstrip().endswith(":"):
                    stack.append(("if", number))
            elif re.match(r"(elseif|else)\b", s):
                if not stack or stack[-1][0] != "if":
                    issues.append(f"{number}행: Else/ElseIf가 여러 줄 If 블록 밖에 있습니다")
            elif re.match(r"for\b", s):
                stack.append(("for", number))
            elif re.match(r"next\b", s):
                for _ in range(s.count(",") + 1):
                    close("for", number)
            elif re.match(r"do\b", s):
                stack.append(("do", number))
            elif re.match(r"loop\b", s):
                close("do", number)
            elif re.match(r"while\b", s):
                stack.append(("while", number))
            elif re.match(r"wend\b", s):
                close("while", number)
            elif re.match(r"with\b", s):
                stack.append(("with", number))
            elif re.match(r"select\s+case\b", s):
                stack.append(("select", number))
            elif re.match(r"((public|private)\s+)?(type|enum)\s+\w+$", s):
                stack.append((re.search(r"(type|enum)", s).group(1), number))
    for kind, line in stack:
        issues.append(f"{line}행의 {OPENERS[kind]}이(가) 닫히지 않았습니다({CLOSERS[kind]} 필요)")
    return issues[:8]


def _head(lines):
    """Number of leading Option, comment and blank lines."""
    head = 0
    while head < len(lines) and (not lines[head].strip() or lines[head].lstrip().startswith("'")
                                 or lines[head].lstrip().lower().startswith("option ")):
        head += 1
    return head


def user_line(module_line, code):
    """Line of the user's code for a line of the built module, or None inside the MCP's own code."""
    lines = code.replace("\r\n", "\n").rstrip().split("\n")
    head, inserted = _head(lines), SHIM_DECLARATIONS.count("\n") + 1
    if module_line <= head:
        return module_line
    line = module_line - inserted
    return line if head < line <= len(lines) else None
_outputs = OrderedDict()  # Long outputs stay in memory only: DRM document text must not land in files


def build_module(code, entry):
    """Option lines, the shim variables, the user code, the shim functions, then the entry Word runs.

    Module declarations must come before any procedure: the shim variables go right after the user's leading
    Option, comment and blank lines, so the user's own Dim lines still precede every procedure. Application.Run only finds macros of the active document, so Word runs the entry while
    the scratch document is active; the entry then activates the target, groups the changes into one undo entry
    and turns errors into text.
    """
    if not re.search(r"^\s*(Public\s+|Private\s+)?Function\s+PiMain\s*\(\s*\)", code, re.IGNORECASE | re.MULTILINE):
        raise ValueError("code에 인자 없는 Function PiMain() As String이 있어야 합니다")
    if re.search(r"^\s*(Public\s+|Private\s+)?(Function|Sub)\s+(MsgBox|InputBox|PiTimeLeft)\b", code,
                 re.IGNORECASE | re.MULTILINE):
        raise ValueError("MsgBox·InputBox·PiTimeLeft는 MCP가 제공하므로 직접 정의하지 마세요")
    issues = check_syntax(code)
    if issues:
        raise ValueError("VBA 구문 오류(실행 전 검사, Word에는 넣지 않음). 행 번호는 code 기준:\n- "
                         + "\n- ".join(issues))
    lines = code.replace("\r\n", "\n").rstrip().split("\n")
    head = _head(lines)
    return ("\n".join(lines[:head] + [SHIM_DECLARATIONS] + lines[head:] + ["", SHIMS]) + "\n"
            f"Public Function {entry}(targetName As String, undoName As String, seconds As Long) As String\n"
            "    Dim result As String\n"
            "    piDeadline = Now + seconds / 86400#\n"
            "    On Error GoTo Failed\n"
            "    Documents(targetName).Activate\n"
            "    Application.UndoRecord.StartCustomRecord undoName\n"
            "    result = CStr(PiMain())\n"
            "    Application.UndoRecord.EndCustomRecord\n"
            f"    {entry} = result & Chr$(3) & \"PI_VBA_MESSAGES\" & Chr$(3) & piMessages\n"
            "    Exit Function\n"
            "Failed:\n"
            f"    {entry} = Chr$(1) & \"PI_VBA_ERROR\" & Chr$(1) & Err.Number & \": \" & Err.Description _\n"
            "        & Chr$(3) & \"PI_VBA_MESSAGES\" & Chr$(3) & piMessages\n"
            "    If Application.UndoRecord.IsRecordingCustomRecord Then Application.UndoRecord.EndCustomRecord\n"
            "End Function\n").replace("\n", "\r\n")


def page_output(text, max_chars):
    """Return at most max_chars; keep the full text of a longer output for read_output."""
    if len(text) <= max_chars:
        return {"output": text, "total_chars": len(text)}
    output_id = secrets.token_hex(4)
    _outputs[output_id] = text
    while len(_outputs) > KEPT_OUTPUTS:
        _outputs.popitem(last=False)
    return {"output": text[:max_chars], "total_chars": len(text), "output_id": output_id, "next_offset": max_chars,
            "note": f"결과가 {len(text)}자라 앞 {max_chars}자만 보냈습니다. 나머지가 필요할 때만 read_output으로 읽고, "
                    "다음 실행에서는 필요한 부분만 돌려주도록 코드를 줄이세요"}


def parse_result(result, max_chars=DEFAULT_OUTPUT):
    text = "" if result is None else str(result)
    text, _, messages = text.partition(MESSAGE_MARK)
    messages = messages.rstrip("\n")
    if len(messages) > MAX_MESSAGES:
        messages = messages[:MAX_MESSAGES] + "…"
    if text.startswith(ERROR_MARK):
        detail = f"VBA 실행 오류 {text[len(ERROR_MARK):]}"
        raise ValueError(detail + (f"\nMsgBox 내용:\n{messages}" if messages else ""))
    parsed = page_output(text, max_chars)
    if messages:
        parsed["messages"] = messages
    return parsed


def read_stored_output(output_id, offset, max_chars):
    if output_id not in _outputs:
        raise ValueError(f"output_id가 없습니다: {output_id}. 최근 {KEPT_OUTPUTS}개만 보관하며 서버를 다시 시작하면 지워집니다")
    text = _outputs[output_id]
    chunk = text[offset:offset + max_chars]
    following = offset + len(chunk)
    return {"output": chunk, "total_chars": len(text), "offset": offset,
            "next_offset": following if following < len(text) else None}


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


def _run_vba(code, document, undo_name, seconds, max_chars):
    import pywintypes
    entry = "PiRun_" + secrets.token_hex(4)
    module_code = build_module(code, entry)
    app = _word()
    target = _target(app, document)
    original = app.ActiveDocument  # the document the user is looking at gets the focus back afterwards
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
        try:
            result = app.Run(f"{module.Name}.{entry}", target.FullName, undo_name, max(1, seconds - DEADLINE_MARGIN))
        except pywintypes.com_error as error:
            # Runtime errors come back as text from the entry, so a failing Run means the module did not compile
            line = _compile_error_line(app, module.Name)
            where = user_line(line, code) if line else None
            raise ValueError("VBA를 컴파일하지 못해 실행하지 않았습니다(구문·컴파일 오류). "
                             f"Word 메시지: {com_detail(error)}. "
                             + (f"오류 위치: code {where}행. " if where else "")
                             + "확인할 것: 선언하지 않은 변수(Option Explicit), 괄호·따옴표, 함수 호출 괄호 사용, "
                             "Word에 없는 속성·메서드 이름, As String을 돌려주는 PiMain") from None
    finally:
        app.DisplayAlerts = alerts
        scratch.Close(0)  # wdDoNotSaveChanges
        try:
            original.Activate()
        except pywintypes.com_error:  # closed by the VBA code
            target.Activate()
        app.ScreenUpdating = screen
    return {"document": target.Name, **parse_result(result, max_chars)}


def _compile_error_line(app, module_name):
    """Word selects the offending line in the VBA editor after a compile error; read it when it can be read."""
    try:
        pane = app.VBE.ActiveCodePane
        if pane is None or pane.CodeModule.Parent.Name != module_name:
            return None
        selection = pane.GetSelection(0, 0, 0, 0)
        return int(selection[0]) if selection and selection[0] else None
    except Exception:  # VBE access varies by Word version; the line is a bonus
        return None


def com_detail(error):
    """Word's own message when there is one, else the COM message, with the HRESULT for anything unexplained."""
    excepinfo = getattr(error, "excepinfo", None)
    if excepinfo and excepinfo[2]:
        return str(excepinfo[2]).strip()
    message = str(getattr(error, "strerror", "") or error).strip()
    return f"{message} (HRESULT {getattr(error, 'hresult', '?')})"


def describe(error):
    import pywintypes
    if isinstance(error, ValueError):
        return str(error)
    if isinstance(error, pywintypes.com_error):
        return f"Word COM 오류: {com_detail(error)}"
    return f"예상하지 못한 오류 {type(error).__name__}: {error}"


async def _call(function, *args, timeout=None):
    global _busy, _late_error
    if _busy:
        raise ToolError("이전 VBA 실행이 아직 끝나지 않았습니다. Word에 오류·확인 창이 떠 있으면 닫은 뒤 다시 시도하세요")
    previous, _late_error = _late_error, None
    _busy = True
    timed_out = False
    future = asyncio.get_running_loop().run_in_executor(_executor, function, *args)

    def done(finished):
        global _busy, _late_error
        _busy = False
        if timed_out and not finished.cancelled() and finished.exception() is not None:
            _late_error = describe(finished.exception())
    future.add_done_callback(done)
    # MCP SDK 2 shows the model the text of a ToolError only
    try:
        result = await asyncio.wait_for(asyncio.shield(future), timeout)
    except asyncio.TimeoutError:
        timed_out = True
        raise ToolError(f"VBA가 {timeout}초 안에 끝나지 않았습니다. Word에 VBA 컴파일 오류나 확인 창이 떠 있으면 닫으세요. "
                        "창이 없다면 코드가 아직 도는 중이며 끝나야 다음 호출을 받습니다. 다음 코드는 긴 반복에서 "
                        "PiTimeLeft()를 확인해 중간 결과와 이어서 할 위치를 돌려주게 하세요. 이 실행이 실패로 끝나면 "
                        "그 이유는 다음 호출 결과의 previous_run에 나옵니다") from None
    except Exception as error:
        prefix = f"[직전 시간 초과 실행의 결과] {previous}\n" if previous else ""
        raise ToolError(prefix + describe(error)) from None
    if previous and isinstance(result, dict):
        result = {"previous_run": previous, **result}
    return result


def create_server():
    server = MCPServer("Word VBA", version="1.1.0")

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    async def list_documents() -> dict[str, Any]:
        """List documents open in Word: name, full path, which one is active."""
        return await _call(_list_documents, timeout=30)

    @server.tool(annotations={"readOnlyHint": False, "destructiveHint": True})
    async def run_vba(code: str, document: str | None = None, undo_name: str = "MCP: VBA",
                      timeout_seconds: int = 120, max_chars: int = DEFAULT_OUTPUT) -> dict[str, Any]:
        """Run a VBA module against a document open in Word and return what PiMain returns.

        code must define `Function PiMain() As String`; helper Subs/Functions may follow. The target document
        (document name/path, or the active one) is ActiveDocument while it runs. Build output with vbLf.
        Return only what the task needs (counts, matching lines, one section), not whole documents.
        Output over max_chars (default 8000) is cut; the rest is kept for read_output.
        Long loops: `If Not PiTimeLeft() Then` stop and return the partial result plus where to resume.
        MsgBox/InputBox show nothing; their text comes back in messages. Unclosed blocks and open strings are
        reported with line numbers before Word sees the code; a compile error comes back with Word's message;
        runtime errors come back as 'VBA 실행 오류 <number>: <description>'. All changes are one Ctrl+Z entry named undo_name.
        Word facts: Range.Information(1) = printed page number (what a TOC shows), Information(3) = page counted
        from the first page; Information forces page layout, so call it for headings, not every paragraph.
        TOC entries are Hyperlinks whose SubAddress is a hidden _Toc bookmark (Bookmarks.ShowHidden = True) on the
        heading; Paragraph.OutlineLevel 1-9 = heading level, 10 = body text; Fields(i).Code / .Result / .Update,
        Fields.Update = F9, TablesOfContents(1).Update refreshes TOC pages. Loop with For Each over collections;
        Paragraphs(i) by index is slow on long documents.
        """
        timeout = max(5, min(timeout_seconds, 580))
        return await _call(_run_vba, code, document, undo_name, timeout, max(500, min(max_chars, MAX_OUTPUT)),
                           timeout=timeout)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    async def read_output(output_id: str, offset: int, max_chars: int = DEFAULT_OUTPUT) -> dict[str, Any]:
        """Read more of a long run_vba output (output_id and next_offset from run_vba). Kept in memory, last 5 only."""
        try:
            return read_stored_output(output_id, max(0, offset), max(500, min(max_chars, MAX_OUTPUT)))
        except ValueError as error:
            raise ToolError(str(error)) from None

    return server


if __name__ == "__main__":
    create_server().run(transport="stdio")
