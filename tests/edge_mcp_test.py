"""Launcher tests need no Edge, Node installation, or MCP dependencies."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("edge_mcp", Path(__file__).resolve().parents[1] / "mcp/edge/edge_mcp.py")
edge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edge)


class EdgeLauncherTests(unittest.TestCase):
    def fixture(self, root):
        bundle = Path(root) / "offline space 한글"
        for name in ("runtime/node/node.exe", "vendor/extensions/node_modules/@playwright/mcp/cli.js", "config/playwright.json"):
            file = bundle / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture", encoding="utf-8")
        return bundle

    def test_windows_uses_only_bundled_node_and_absolute_paths(self):
        with tempfile.TemporaryDirectory() as root:
            bundle = self.fixture(root)
            with patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(bundle / "config")}), patch.object(edge.shutil, "which", side_effect=AssertionError("must not search PATH")):
                command = edge.server_command(bundle, "win32")
            self.assertEqual(command, [str(bundle / "runtime/node/node.exe"), str(bundle / "vendor/extensions/node_modules/@playwright/mcp/cli.js"), "--config", str(bundle / "config/playwright.json"), "--output-dir", str(bundle / "config/playwright-mcp")])
            self.assertTrue((bundle / "config/playwright-mcp").is_dir())

    def test_missing_bundled_node_fails_without_installing_or_falling_back(self):
        with tempfile.TemporaryDirectory() as root:
            bundle = self.fixture(root)
            (bundle / "runtime/node/node.exe").unlink()
            with patch.object(edge.shutil, "which", side_effect=AssertionError("no fallback")):
                with self.assertRaisesRegex(FileNotFoundError, "complete offline release ZIP"):
                    edge.server_command(bundle, "win32")

    def test_stdio_environment_and_exit_code_are_preserved(self):
        with patch.object(edge, "server_command", return_value=["bundled-node", "cli.js"]), patch.object(edge.subprocess, "call", return_value=7) as call:
            self.assertEqual(edge.main(), 7)
            args, kwargs = call.call_args
            self.assertEqual(args[0], ["bundled-node", "cli.js"])
            self.assertEqual(kwargs["env"]["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"], "1")
            self.assertNotIn("stdin", kwargs)
            self.assertNotIn("stdout", kwargs)


if __name__ == "__main__":
    unittest.main()
