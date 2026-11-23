import asyncio
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mcp/word-vba"))

from mcp.server.mcpserver.exceptions import ToolError

from word_vba import ERROR_MARK, MAX_OUTPUT, _call, build_module, parse_result


class WordVbaTest(unittest.TestCase):
    def test_module_keeps_option_lines_first_and_wraps_errors(self):
        code = "Option Explicit\nFunction PiMain() As String\n  PiMain = ActiveDocument.Name\nEnd Function"
        module = build_module(code, "PiRun_ab12")
        self.assertTrue(module.startswith("Option Explicit\r\n"))
        self.assertIn("Public Function PiRun_ab12(targetName As String, undoName As String) As String\r\n"
                      "    On Error GoTo Failed\r\n    Documents(targetName).Activate\r\n", module)
        # PiMain runs inside one undo entry, which is closed on success and on error
        self.assertIn("StartCustomRecord undoName\r\n    PiRun_ab12 = CStr(PiMain())\r\n    Application.UndoRecord.EndCustomRecord", module)
        self.assertIn("If Application.UndoRecord.IsRecordingCustomRecord Then Application.UndoRecord.EndCustomRecord", module)
        self.assertNotIn("\n\n\n", module.replace("\r", ""))
        self.assertNotRegex(module.replace("\r\n", ""), "\n")  # CRLF only

    def test_entry_point_is_required(self):
        for code in ("Sub Main()\nEnd Sub", "Function PiMain(x)\nEnd Function", "' Function PiMain()"):
            with self.assertRaisesRegex(ValueError, "PiMain"):
                build_module(code, "PiRun_1")
        build_module("private function pimain() as string\nend function", "PiRun_1")

    def test_result_parsing(self):
        self.assertEqual(parse_result("한글 결과"), {"output": "한글 결과", "truncated": False})
        self.assertEqual(parse_result(None)["output"], "")
        with self.assertRaisesRegex(ValueError, "VBA 실행 오류 91: 개체 변수"):
            parse_result(ERROR_MARK + "91: 개체 변수가 설정되지 않았습니다")
        long = parse_result("x" * (MAX_OUTPUT + 5))
        self.assertEqual((len(long["output"]), long["truncated"], long["total_chars"]), (MAX_OUTPUT, True, MAX_OUTPUT + 5))

    def test_stuck_word_call_times_out_and_blocks_until_it_returns(self):
        # Stands in for Word stuck on a VBA compile error dialog until the user closes it.
        dialog_closed = threading.Event()

        async def scenario():
            with self.assertRaisesRegex(ToolError, "창을 닫으면"):
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
