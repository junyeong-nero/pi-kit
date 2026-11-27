import asyncio
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mcp/word-vba"))

from mcp.server.mcpserver.exceptions import ToolError

import word_vba
from word_vba import (ERROR_MARK, KEPT_OUTPUTS, MESSAGE_MARK, _call, build_module, check_syntax, com_detail,
                      parse_result, read_stored_output, user_line)

VALID = '''Option Explicit
' 주석: If 없이 End If라고 적어도 됨
Private Type Item
    Name As String
End Type
Private Declare PtrSafe Function GetTickCount Lib "kernel32" () As Long
Dim total As Long

Function PiMain() As String
    Dim p As Paragraph, i As Long, s As String, f As Field
    If ActiveDocument Is Nothing Then Exit Function
    If total > 0 Then s = "a" Else s = "b"
    For Each p In ActiveDocument.Paragraphs
        If p.OutlineLevel < 10 Then
            s = s & p.Range.Information(1) & vbTab & _
                p.Range.Text & "If "" Then" ' 문자열 안의 키워드
        ElseIf p.OutlineLevel = 10 Then
            total = total + 1
        Else
            Rem 아무것도 안 함
        End If
        If Not PiTimeLeft() Then Exit For
    Next p
    For i = 1 To 3: total = total + i: Next
    Do While i > 0
        i = i - 1
        If i = 1 Then: Exit Do
    Loop
    With ActiveDocument.Range
        .Find.Execute FindText:="x", Forward:=True
    End With
    Select Case total
        Case Is > 1: s = s & "many"
        Case Else
    End Select
    While False
    Wend
    #If VBA7 Then
    #End If
    PiMain = s & Format(Now, "yyyy") & Helper()
Done:
End Function

Private Function Helper() As String
    On Error GoTo Failed
    Helper = "ok"
    Exit Function
Failed:
    Helper = Err.Description
End Function
'''


class WordVbaTest(unittest.TestCase):
    def setUp(self):
        word_vba._outputs.clear()

    def test_module_order_options_shims_code_entry(self):
        code = "Option Explicit\n' 설명\nDim total As Long\nFunction PiMain() As String\n  PiMain = ActiveDocument.Name\nEnd Function"
        module = build_module(code, "PiRun_ab12")
        self.assertNotRegex(module.replace("\r\n", ""), "\n")  # CRLF only
        text = module.replace("\r\n", "\n")
        # Declarations must precede every procedure: Option, the shims' variables, the user's Dim, then procedures
        order = [text.index(s) for s in ("Option Explicit", "' 설명", "Private piMessages", "Dim total",
                                         "Function PiMain", "Private Function MsgBox", "Public Function PiRun_ab12")]
        self.assertEqual(order, sorted(order))
        self.assertIn("Public Function PiRun_ab12(targetName As String, undoName As String, seconds As Long) As String\n"
                      "    Dim result As String\n    piDeadline = Now + seconds / 86400#\n"
                      "    On Error GoTo Failed\n    Documents(targetName).Activate\n", text)
        # PiMain runs inside one undo entry, which is closed on success and on error
        self.assertIn("StartCustomRecord undoName\n    result = CStr(PiMain())\n    Application.UndoRecord.EndCustomRecord", text)
        self.assertIn("If Application.UndoRecord.IsRecordingCustomRecord Then Application.UndoRecord.EndCustomRecord", text)

    def test_entry_point_is_required_and_shims_are_not_redefined(self):
        for code in ("Sub Main()\nEnd Sub", "Function PiMain(x)\nEnd Function", "' Function PiMain()"):
            with self.assertRaisesRegex(ValueError, "PiMain"):
                build_module(code, "PiRun_1")
        build_module("private function pimain() as string\nend function", "PiRun_1")
        with self.assertRaisesRegex(ValueError, "MsgBox"):
            build_module("Function PiMain() As String\nEnd Function\nSub MsgBox(x)\nEnd Sub", "PiRun_1")

    def test_syntax_check_accepts_valid_vba_including_the_mcp_module(self):
        self.assertEqual(check_syntax(VALID), [])
        self.assertEqual(check_syntax(build_module(VALID, "PiRun_ab12")), [])

    def test_syntax_check_reports_line_numbers(self):
        cases = {
            "Function PiMain() As String\n  If x Then\n    PiMain = 1\nEnd Function":
                ["4행: End Function 전에 2행의 If"],
            "Function PiMain() As String\n  For i = 1 To 2\n  End If\n  Next\nEnd Function": ["3행: End If 전에 2행의 For"],
            "End If\nFunction PiMain() As String\nEnd Function": ["1행: End If에 맞는 If"],
            "Function PiMain() As String\n  PiMain = \"abc\nEnd Function": ["2행: 따옴표"],
            "Function PiMain() As String\n  With x\nEnd Function": ["End Function 전에 2행의 With"],
            "Function PiMain() As String\n  Do\nEnd Function\nSub Other()\nEnd Sub": ["2행의 Do"],
            "Function PiMain() As String\n  Else\nEnd Function": ["2행: Else"],
            "Function PiMain() As String\n  PiMain = \"\"\n": ["1행의 Function", "End Function 필요"],
        }
        for code, expected in cases.items():
            issues = "\n".join(check_syntax(code))
            for text in expected:
                self.assertIn(text, issues, code)
        with self.assertRaisesRegex(ValueError, "구문 오류(.|\n)*2행의 If"):
            build_module("Function PiMain() As String\n  If x Then\nEnd Function", "PiRun_1")

    def test_module_lines_map_back_to_the_users_code(self):
        code = "Option Explicit\nFunction PiMain() As String\n  PiMain = Foo\nEnd Function"
        module = build_module(code, "PiRun_1").split("\r\n")
        for number, line in enumerate(code.split("\n"), 1):
            self.assertEqual(module[number - 1 if number == 1 else number + 2], line)
            self.assertEqual(user_line(1 if number == 1 else number + 3, code), number)
        self.assertIsNone(user_line(2, code))  # the MCP's own declarations
        self.assertIsNone(user_line(len(module), code))  # the MCP's entry function

    def test_com_error_detail(self):
        class Fake(Exception):
            pass
        with_info = Fake(); with_info.excepinfo = (0, "Word", "컴파일 오류", None, 0, 0); with_info.hresult = -1
        without = Fake(); without.excepinfo = None; without.strerror = "예외가 발생했습니다."; without.hresult = -2147352567
        self.assertEqual(com_detail(with_info), "컴파일 오류")
        self.assertEqual(com_detail(without), "예외가 발생했습니다. (HRESULT -2147352567)")

    def test_result_messages_and_errors(self):
        self.assertEqual(parse_result("한글 결과" + MESSAGE_MARK), {"output": "한글 결과", "total_chars": 5})
        self.assertEqual(parse_result(None)["output"], "")
        self.assertEqual(parse_result("x" + MESSAGE_MARK + "완료\n")["messages"], "완료")
        with self.assertRaisesRegex(ValueError, "VBA 실행 오류 91: 개체 변수(.|\n)*MsgBox 내용:\n시작"):
            parse_result(ERROR_MARK + "91: 개체 변수가 설정되지 않았습니다" + MESSAGE_MARK + "시작\n")

    def test_long_output_is_paged_from_memory(self):
        text = "".join(f"{i:05d}\n" for i in range(3000))  # 18000 chars
        first = parse_result(text + MESSAGE_MARK, 8000)
        self.assertEqual((len(first["output"]), first["total_chars"], first["next_offset"]), (8000, 18000, 8000))
        second = read_stored_output(first["output_id"], first["next_offset"], 8000)
        last = read_stored_output(first["output_id"], second["next_offset"], 8000)
        self.assertEqual(first["output"] + second["output"] + last["output"], text)
        self.assertIsNone(last["next_offset"])
        for _ in range(KEPT_OUTPUTS):
            parse_result("y" * 9000, 8000)
        with self.assertRaisesRegex(ValueError, "output_id"):
            read_stored_output(first["output_id"], 0, 8000)  # only the newest outputs are kept

    def test_stuck_word_call_times_out_and_blocks_until_it_returns(self):
        # Stands in for Word stuck on a VBA compile error dialog until the user closes it.
        dialog_closed = threading.Event()

        async def scenario():
            with self.assertRaisesRegex(ToolError, "PiTimeLeft"):
                await _call(dialog_closed.wait, timeout=0.2)
            with self.assertRaisesRegex(ToolError, "아직 끝나지"):
                await _call(lambda: "next", timeout=1)
            dialog_closed.set()
            await asyncio.sleep(0.2)
            self.assertEqual(await _call(lambda: "next", timeout=1), "next")
            with self.assertRaisesRegex(ToolError, "^PiMain 없음$"):
                await _call(lambda: (_ for _ in ()).throw(ValueError("PiMain 없음")), timeout=1)
            # Any other exception keeps its text instead of SDK 2's bare "Error executing tool"
            with self.assertRaisesRegex(ToolError, "KeyError"):
                await _call(lambda: {}["x"], timeout=1)

        asyncio.run(scenario())

    def test_failure_after_a_timeout_is_told_on_the_next_call(self):
        dialog_closed = threading.Event()

        def compile_error():
            dialog_closed.wait()
            raise ValueError("VBA를 컴파일하지 못해 실행하지 않았습니다")

        async def scenario():
            with self.assertRaises(ToolError):
                await _call(compile_error, timeout=0.2)
            dialog_closed.set()
            await asyncio.sleep(0.2)
            result = await _call(lambda: {"output": "ok"}, timeout=1)
            self.assertIn("컴파일하지 못해", result["previous_run"])
            self.assertNotIn("previous_run", await _call(lambda: {"output": "ok"}, timeout=1))

        asyncio.run(scenario())


class FakeWindow:
    def __init__(self, visible):
        self.Visible = visible


class FakeDocument:
    def __init__(self, app, path, read_only, visible):
        self.app, self.FullName, self.Path = app, path, str(Path(path).parent)
        self.Name, self.ReadOnly, self.Saved, self.saves = Path(path).name, read_only, True, 0
        self.window = FakeWindow(visible)
        self.Windows = FakeCollection([self.window])

    def Save(self):
        self.saves += 1
        self.Saved = True

    def Close(self, option):
        self.app.docs.remove(self)


class FakeCollection:
    def __init__(self, items):
        self.items = items

    @property
    def Count(self):
        return len(self.items)

    def __call__(self, index):
        return self.items[index - 1]


class FakeWord:
    def __init__(self):
        self.docs, self.opened, self.quit = [], [], False
        self.DisplayAlerts, self.AutomationSecurity, self.Visible = -1, 1, True
        self.Documents = FakeCollection(self.docs)
        self.Documents.Open = self.open

    def open(self, *args):
        self.opened.append((args, self.DisplayAlerts, self.AutomationSecurity))
        doc = FakeDocument(self, args[0], args[2], args[11])
        self.docs.append(doc)
        return doc

    @property
    def ActiveDocument(self):
        import pywintypes
        visible = [d for d in self.docs if d.window.Visible]
        if not visible:
            raise pywintypes.com_error(-2147352567, "no document", None, None)
        return visible[-1]

    def Quit(self, option):
        self.quit = True


class SilentOpenTest(unittest.TestCase):
    def setUp(self):
        import pywintypes
        import win32com.client
        self.word = FakeWord()
        self.addCleanup(setattr, word_vba, "_own_word", None)
        self.addCleanup(word_vba._opened.clear)
        not_running = pywintypes.com_error(-2147221021, "Operation unavailable", None, None)
        self.enterContext(mock.patch.object(win32com.client, "GetActiveObject", side_effect=not_running))
        self.dispatch = self.enterContext(mock.patch.object(win32com.client, "DispatchEx", return_value=self.word))
        folder = self.enterContext(tempfile.TemporaryDirectory())
        self.path = str(Path(folder) / "보고서.docx")
        Path(self.path).write_bytes(b"")

    def test_opens_hidden_without_prompts_in_a_hidden_word_and_quits_it_after_the_last_close(self):
        opened = word_vba._open_document(self.path, True)
        self.assertEqual(opened, {"document": "보고서.docx", "full_name": self.path, "read_only": True,
                                  "word_started": True})
        self.assertFalse(self.word.Visible)
        args, alerts, security = self.word.opened[0]
        # ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument ... Visible ... NoEncodingDialog
        self.assertEqual((args[1], args[2], args[3], args[4], args[11], args[14]), (False, True, False, "", False, True))
        self.assertEqual((alerts, security), (0, 3))
        self.assertEqual((self.word.DisplayAlerts, self.word.AutomationSecurity), (-1, 1))  # restored
        self.assertEqual(word_vba._open_document(self.path, True)["note"], "이미 열려 있는 문서입니다")
        self.assertEqual(len(self.word.opened), 1)
        listed = word_vba._list_documents()["documents"]
        self.assertEqual([(d["name"], d["active"], d["hidden"]) for d in listed], [("보고서.docx", False, True)])
        with self.assertRaisesRegex(ValueError, "숨겨 연 문서만"):
            word_vba._target(self.word, None)
        self.assertEqual(word_vba._close_document("보고서.docx", None), {"closed": "보고서.docx", "word_quit": True})
        self.assertTrue(self.word.quit)
        self.assertIsNone(word_vba._own_word)

    def test_close_never_drops_unsaved_changes_silently(self):
        word_vba._open_document(self.path, False)
        doc = self.word.docs[0]
        doc.Saved = False
        with self.assertRaisesRegex(ValueError, "save=true"):
            word_vba._close_document(self.path, None)
        doc.ReadOnly = True
        with self.assertRaisesRegex(ValueError, "읽기 전용"):
            word_vba._close_document(self.path, True)
        doc.ReadOnly = False
        word_vba._close_document(self.path, True)
        self.assertEqual(doc.saves, 1)

    def test_disconnect_closes_only_silently_opened_documents_without_saving(self):
        word_vba._open_document(self.path, False)
        self.word.docs[0].Saved = False  # changed by run_vba: discarded
        users = FakeDocument(self.word, str(Path(self.path).with_name("사용자.docx")), False, True)
        self.word.docs.append(users)
        word_vba._close_opened()
        self.assertEqual(self.word.docs, [users])
        self.assertFalse(self.word.quit)  # still holds a document the user opened
        self.assertEqual(word_vba._opened, set())

        word_vba._own_word = self.word
        self.word.docs.remove(users)
        word_vba._open_document(self.path, True)
        word_vba.close_opened_on_exit()
        self.assertEqual((self.word.docs, self.word.quit, word_vba._own_word), ([], True, None))

    def test_missing_file_and_missing_word(self):
        with self.assertRaisesRegex(ValueError, "파일이 없습니다"):
            word_vba._open_document(self.path + ".none", True)
        with self.assertRaisesRegex(ValueError, "open_document"):
            word_vba._list_documents()
        self.dispatch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
