"""Run the pinned Playwright MCP with the bundled Node, not npm/npx.

Embedded Python finds this module through python313._pth. It inherits MCP stdio;
the upstream server handles stdin EOF and disconnects from (not closes) Edge.
"""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile


BUNDLE = Path(__file__).resolve().parents[2]


def server_command(bundle=BUNDLE, platform=sys.platform):
    bundle = Path(bundle)
    node = bundle / "runtime/node/node.exe"
    if platform != "win32":
        # Development on Mac/Linux only. Windows never needs a separately installed Node.
        node = bundle / "runtime/node/bin/node"
        if not node.is_file():
            node = Path(shutil.which("node") or "")
    cli = bundle / "vendor/extensions/node_modules/@playwright/mcp/cli.js"
    config = bundle / "config/playwright.json"
    for file in (node, cli, config):
        if not file.is_file():
            raise FileNotFoundError(f"Missing Edge MCP file: {file}. Use the complete offline release ZIP.")
    agent = Path(os.environ.get("PI_CODING_AGENT_DIR") or bundle / "config")
    output = agent / "playwright-mcp"
    output.mkdir(parents=True, exist_ok=True)
    return [str(node), str(cli), "--config", str(config), "--output-dir", str(output)]


def main():
    try:
        env = dict(os.environ, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1")
        command = server_command()
        if sys.platform != "win32" and not env.get("PWTEST_SOCKETS_DIR"):
            # The default macOS temp path can exceed Playwright's Unix socket limit.
            # A private, short-lived IPC directory is not browser/profile storage.
            with tempfile.TemporaryDirectory(prefix="hsc-pw-", dir="/tmp") as sockets:
                env["PWTEST_SOCKETS_DIR"] = sockets
                return subprocess.call(command, env=env)
        return subprocess.call(command, env=env)
    except (OSError, ValueError) as error:
        print(f"Edge MCP: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
