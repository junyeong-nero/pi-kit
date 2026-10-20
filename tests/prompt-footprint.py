"""Measure the actual initial model request through a local API, without real credentials."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading


def measure(bundle, output, node_cli=False, probe_redis=False):
    bundle = Path(bundle).resolve()
    captured = []
    errors = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            captured.append(request)
            turn = len(captured) - 1
            # config/mcp.json: the build center tools are deferred, so tool_search loads them first.
            expected = [("tool_search", {"query": "빌드센터 build center list projects"}), ("mcp__build_center__list_projects", {})]
            if probe_redis and turn < 2:
                name, arguments = expected[turn]
                if name not in [t["function"]["name"] for t in request.get("tools", [])]:
                    errors.append(f"Tool not advertised: {name}")
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"probe_{turn}", "type": "function",
                         "function": {"name": name, "arguments": json.dumps(arguments)}}]}
                reason = "tool_calls"
            else:
                delta, reason = {"role": "assistant", "content": "PREFIX_OK"}, "stop"
            if probe_redis and turn == 2:
                messages = [m for m in request.get("messages", []) if m["role"] == "tool"]
                if not messages or "mapping_file" not in json.dumps(messages[-1], ensure_ascii=False):
                    errors.append("Compiled pi Redis MCP probe failed: " + json.dumps(messages[-1:] , ensure_ascii=False))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, reason in ((delta, None), ({}, reason)):
                chunk = {"id": "prefix", "object": "chat.completion.chunk", "created": 1, "model": "smoke",
                         "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")

    with tempfile.TemporaryDirectory(prefix="harness prefix ") as tmp:
        root = Path(tmp)
        agent, project = root / "agent", root / "project"
        agent.mkdir()
        project.mkdir()
        (agent / "settings.json").write_text(json.dumps({"packages": [str(bundle)]}), encoding="utf-8")
        # Same allowlist and MCP servers as <bundle>\config: the build center tools run without a screen to ask.
        (agent / "extensions").mkdir()
        shutil.copy2(bundle / "config/extensions/allowlist-gate.json", agent / "extensions/allowlist-gate.json")
        shutil.copy2(bundle / "config/mcp.json", agent / "mcp.json")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            (agent / "models.json").write_text(json.dumps({"providers": {"offline": {
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions", "apiKey": "local-test",
                "models": [{"id": "smoke", "name": "smoke", "reasoning": False, "input": ["text"],
                            "contextWindow": 32768, "maxTokens": 128,
                            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}), encoding="utf-8")
            env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", PI_TELEMETRY="0", PI_SKIP_VERSION_CHECK="1")
            # setup.ps1 puts the bundled Python first on PATH; config/mcp.json starts the server as `python`.
            path_key = next((key for key in env if key.upper() == "PATH"), "PATH")
            env[path_key] = os.pathsep.join([os.environ.get("TEST_PYTHON_DIR", str(bundle / "runtime/python")), env.get(path_key, "")])
            command = (["node", str(bundle / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")] if node_cli
                       else [str(bundle / "bin/pi/pi.exe")])
            result = subprocess.run([*command, "--no-session", "--provider", "offline", "--model", "smoke", "-p", "Reply PREFIX_OK."],
                                    env=env, cwd=project, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
            if result.returncode or not captured or "PREFIX_OK" not in result.stdout or errors or (probe_redis and len(captured) != 3):
                raise AssertionError(f"Prefix/MCP measurement failed: {errors}\n{result.stdout}\n{result.stderr}")
            request = captured[0]
            tools = request.get("tools", [])
            system = [m for m in request.get("messages", []) if m["role"] == "system"]
            system_text = json.dumps(system, ensure_ascii=False, separators=(",", ":"))
            tools_text = json.dumps(tools, ensure_ascii=False, separators=(",", ":"))
            metrics = {"tool_count": len(tools), "tools": [t["function"]["name"] for t in tools],
                       "system_characters": len(system_text), "tool_schema_characters": len(tools_text),
                       "prefix_characters": len(system_text) + len(tools_text),
                       "skill_names": re.findall(r"<name>(.*?)</name>", system_text),
                       "per_tool_characters": {t["function"]["name"]: len(json.dumps(t, ensure_ascii=False, separators=(",", ":"))) for t in tools}}
            Path(output).write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(metrics, ensure_ascii=False))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--output", required=True)
    parser.add_argument("--node-cli", action="store_true")
    parser.add_argument("--probe-redis", action="store_true")
    args = parser.parse_args()
    measure(args.bundle, args.output, args.node_cli, args.probe_redis)
