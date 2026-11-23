import asyncio
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mcp/word-vba"))

from mcp.server.mcpserver.exceptions import ToolError

import word_vba
from word_vba import ERROR_MARK, KEPT_OUTPUTS, MESSAGE_MARK, _call, build_module, parse_result, read_stored_output


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

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
