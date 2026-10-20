"""Exercise pi and the bundle's tools using a local deterministic OpenAI API fixture.

Windows installed: python tests/pi-standalone.py <extracted-bundle>
  (run as administrator: setup.ps1, then `pi` found through the machine PATH it registered)
Windows direct:    python tests/pi-standalone.py <extracted-bundle> --direct
  (bin\\pi\\pi.exe run from another directory with only the bundle registered as a pi package)
Windows upgrade:   python tests/pi-standalone.py <extracted-bundle> --upgrade
  (legacy user variables point at agent/; setup must remove them and pi must load config/)
macOS developer check: python tests/pi-standalone.py . --node-cli
No model credentials or external model endpoint are used.
"""
import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading


def windows_user_environment():
    """Ask Windows for a fresh machine + current-user environment, without inheriting stale values."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    userenv.CreateEnvironmentBlock.argtypes = [ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.BOOL]
    userenv.DestroyEnvironmentBlock.argtypes = [ctypes.c_void_p]
    token = wintypes.HANDLE()
    block = ctypes.c_void_p()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008 | 0x0002, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not userenv.CreateEnvironmentBlock(ctypes.byref(block), token, False):
            raise ctypes.WinError(ctypes.get_last_error())
        env = {}
        address = block.value
        while True:
            entry = ctypes.wstring_at(address)
            if not entry:
                break
            name, value = entry.split("=", 1)
            if name:
                env[name] = value
            address += (len(entry.encode("utf-16-le")) + 2)
        return env
    finally:
        if block.value:
            userenv.DestroyEnvironmentBlock(block)
        kernel.CloseHandle(token)


@contextmanager
def legacy_user_environment(bundle, enabled):
    if not enabled:
        yield
        return
    import winreg
    values = {"PI_CODING_AGENT_DIR": str(bundle / "agent"), "HSC_PI_HARNESS_HOME": str(bundle),
              "PI_OFFLINE": "0", "PI_TELEMETRY": "1", "PI_SKIP_VERSION_CHECK": "0",
              "HSC_UPGRADE_TEST_SENTINEL": "preserve-unrelated-user-setting"}
    previous = {}
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            for name, value in values.items():
                try:
                    previous[name] = winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    previous[name] = None
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
        before = windows_user_environment()
        assert before["PI_CODING_AGENT_DIR"] == str(bundle / "agent"), "Legacy user override was not reproduced"
        yield
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            for name in values:
                if name == "HSC_UPGRADE_TEST_SENTINEL":
                    assert winreg.QueryValueEx(key, name)[0] == values[name]
                    continue
                try:
                    winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    continue
                raise AssertionError(f"Setup left a conflicting user variable: {name}")
    finally:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            for name, original in previous.items():
                if original is not None:
                    winreg.SetValueEx(key, name, 0, original[1], original[0])
                else:
                    try:
                        winreg.DeleteValue(key, name)
                    except FileNotFoundError:
                        pass


def run(bundle, mode="installed"):
    node_cli = mode == "node-cli"
    bundle = Path(bundle).resolve()
    with tempfile.TemporaryDirectory(prefix="pi-standalone-") as temp, legacy_user_environment(bundle, mode == "upgrade"):
        root = Path(temp)
        project = root / "project space"
        project.mkdir()
        file = project / "main.cpp"
        shutil.copy2(bundle / "tests/fixtures/cpp/main.cpp", file)
        legacy = project / "legacy.cpp"
        legacy.write_bytes("// 한글 주석\r\nint legacy = 1;\r\n".encode("cp949"))
        position = {"path": str(file), "line": 2, "symbol": "add"}
        stages = [
            ("harness_tools", {"group": "code"}, "module_report"),
            ("module_report", {"path": str(file)}, "add"),
            ("harness_tools", {"group": "subagents"}, "subagent"),
            ("subagents_enable", {}, "subagent"),
            ("subagent", {"agent": "harness-smoke", "task": "HARNESS_CHILD_SMOKE: reply CHILD_OK", "async": False}, "CHILD_OK"),
            ("lsp_hover", position, "add"),
            ("lsp_definition", position, "main.cpp:1:"),
            ("lsp_references", position, "main.cpp:2:"),
            ("lsp_symbols", {"path": str(file)}, "add"),
            ("find_symbol", {"name": "add", "path": str(file)}, "정의: "),
            ("lsp_diagnostics", {"path": str(file)}, "no issues"),
            ("write", {"path": str(file), "content": "int main() { return missing_name; }\n"}, "missing_name"),
        ]
        if not node_cli:
            stages[0:0] = [
                ("powershell", {"command": "python -X utf8 -c \"import redis, mcp; print('BUNDLED_PYTHON_REDIS_OK')\""}, "BUNDLED_PYTHON_REDIS_OK"),
                ("powershell", {"command": "Write-Output 'WINDOWS_SHELL_OK'"}, "WINDOWS_SHELL_OK"),
                # Korean text through write -> Windows PowerShell 5.1 and Python, and a CP949 edit (bytes checked below).
                ("write", {"path": str(project / "hangul.ps1"), "content": "Write-Output '한글 스크립트 OK'\n"}, "UTF-8 BOM"),
                ("powershell", {"command": "powershell -NoProfile -ExecutionPolicy Bypass -File .\\hangul.ps1"}, "한글 스크립트 OK"),
                ("write", {"path": str(project / "hangul.py"), "content": "print('파이썬 한글 OK')\n"}, "Successfully"),
                ("powershell", {"command": "python hangul.py"}, "파이썬 한글 OK"),
                # pi-lens only lets the model edit files it has read; read must show the CP949 Korean decoded.
                ("read", {"path": str(project / "legacy.cpp")}, "한글 주석"),
                ("edit", {"path": str(project / "legacy.cpp"), "edits": [{"oldText": "int legacy = 1;", "newText": "int legacy = 2; // 수정"}]}, "CP949"),
                ("powershell", {"command": "fd --version"}, "fd 10.5.0"),
                ("powershell", {"command": "rg --version"}, "ripgrep 15.2.0"),
                ("powershell", {"command": "svn --version --quiet"}, "1.15.0"),
                ("powershell", {"command": "redis-cli --version"}, "redis-cli 7.2.16"),
                ("powershell", {"command": "redis-server --version"}, "Redis server v=7.2.16"),
                ("powershell", {"command": "RedisService --version"}, "RedisService version 2.0.0.0"),
                # allowlist-gate has no screen to ask in -p mode, so an unlisted command is blocked.
                ("powershell", {"command": "Remove-Item -LiteralPath 'gate-probe.txt'"}, "requires approval"),
            ]
        if mode in ("installed", "upgrade"):
            # config/mcp.json (read through PI_CODING_AGENT_DIR) starts the bundled Python found on the machine PATH.
            # Its deferred tools stay undeclared until tool_search loads them.
            stages[0:0] = [
                ("tool_search", {"query": "빌드센터 build center list projects"}, "mcp__build_center__list_projects"),
                ("mcp__build_center__list_projects", {}, "mapping_file"),
            ]
        # verify-guard sends this reminder when the run ends after write without a build or diagnostics call.
        reminder = "검증하지 않았다"
        forced_turns = 2
        state = {"turn": 0, "children": 0, "reminders": 0, "errors": []}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                child = any(m.get("role") == "user" and "HARNESS_CHILD_SMOKE" in json.dumps(m.get("content", "")) for m in request.get("messages", []))
                if not child:
                    system = json.dumps([m for m in request.get("messages", []) if m.get("role") == "system"], ensure_ascii=False)
                    # harness-env adds the guide when no context file has it; it must appear exactly once.
                    if system.count("# 도구 사용 규칙") != 1:
                        state["errors"].append(f"Tool guide appears {system.count('# 도구 사용 규칙')} times in the system prompt")
                    for skill in ("pi-lens-ast-grep", "pi-subagents"):
                        if f"<name>{skill}</name>" in system:
                            state["errors"].append(f"Unused bundled skill advertised: {skill}")
                turn = state["turn"]
                if turn > len(stages) and not child and reminder in json.dumps(request.get("messages", []), ensure_ascii=False):
                    state["reminders"] += 1
                if turn and turn <= len(stages) and not child:
                    messages = [m for m in request.get("messages", []) if m.get("role") == "tool"]
                    expected = stages[turn - 1][2]
                    if not messages or expected not in json.dumps(messages[-1], ensure_ascii=False):
                        actual = json.dumps(messages[-1], ensure_ascii=False) if messages else "no tool result"
                        state["errors"].append(f"Missing {expected!r} in {stages[turn - 1][0]} result: {actual}")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                if child:
                    state["children"] += 1
                    delta = {"role": "assistant", "content": "CHILD_OK"}
                    reason = "stop"
                elif turn < len(stages):
                    name, arguments, _ = stages[turn]
                    names = [tool.get("function", {}).get("name") for tool in request.get("tools", [])]
                    if turn == 0:
                        for optional in ("mcp__build_center__get_results", "mcp__build_center__list_projects", "module_report", "subagent", "subagents_enable", "bg_wait", "subagent_supervisor", "pi_lens_activate_tools"):
                            if optional in names:
                                state["errors"].append(f"Optional tool advertised before activation: {optional}")
                        # rpiv-todo is a default tool; rpiv-ask-user-question hides itself without a screen (-p).
                        if "todo" not in names:
                            state["errors"].append("todo is not a default tool")
                        if "ask_user_question" in names:
                            state["errors"].append("ask_user_question advertised without a UI")
                    if name not in names:
                        state["errors"].append(f"Tool not advertised: {name}")
                    if not node_cli and "bash" in names:
                        state["errors"].append("Bash tool advertised on Windows")
                    # config/pi-lens.json hides these; seeing one means the bundled pi-lens config was not applied.
                    for hidden in ("lens_diagnostics", "symbol_search", "project_report", "read_enclosing", "effective_config"):
                        if hidden in names:
                            state["errors"].append(f"Hidden tool advertised: {hidden}")
                    delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_{turn}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]}
                    reason = "tool_calls"
                else:
                    delta = {"role": "assistant", "content": "OFFLINE_STANDALONE_OK"}
                    reason = "stop"
                for part, finish in [(delta, None), ({}, reason)]:
                    chunk = {"id": f"chatcmpl-{turn}", "object": "chat.completion.chunk", "created": 1, "model": "smoke", "choices": [{"index": 0, "delta": part, "finish_reason": finish}]}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                if not child:
                    state["turn"] += 1
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        models = {"providers": {"offline": {
            "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions", "apiKey": "offline-test",
            "models": [{"id": "smoke", "name": "smoke", "reasoning": False, "input": ["text"], "contextWindow": 32768, "maxTokens": 1024,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}],
        }}}
        arguments = ["--no-session", "--provider", "offline", "--model", "smoke", "-p", "Run the smoke test."]
        env = dict(os.environ, PI_OFFLINE="1", PI_TELEMETRY="0", PI_SKIP_VERSION_CHECK="1")
        models_path = bundle / "config/models.json"
        previous_models = models_path.read_bytes() if models_path.exists() else None
        # The bundled allowlist plus what the smoke run needs; everything else stays gated.
        bundle_gate = bundle / "config/extensions/allowlist-gate.json"
        previous_gate = bundle_gate.read_bytes()
        gate = json.loads(previous_gate)
        gate["allow"] += [f"shell:{name} *" for name in ("python", "powershell", "fd", "rg", "svn", "redis-cli", "redis-server", "RedisService")]
        gate["allow"] += ["subagents_enable", "subagent", "edit:*"]
        created_smoke_agent = False
        try:
            if node_cli:
                agent = root / "agent"
                agent.mkdir()
                (agent / "models.json").write_text(json.dumps(models), encoding="utf-8")
                (agent / "settings.json").write_text(json.dumps({"packages": [str(bundle)]}), encoding="utf-8")
                config = root / "lsp.json"
                config.write_text(json.dumps({"servers": {"cpp": {"command": "clangd", "args": ["--log=error"]}}}))
                env.update(PI_CODING_AGENT_DIR=str(agent), HARNESS_LSP_CONFIG=str(config))
                for name in [key for key in env if key.startswith("PI_LENS_")]:
                    env.pop(name)
                command = ["node", str(bundle / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), *arguments]
            elif mode == "direct":
                # What a user gets by running pi.exe from any folder after `pi install <bundle>`:
                # no setup.ps1, no HARNESS_* or PI_LENS_* variables, bundle bin not on PATH.
                agent = root / "agent"
                agent.mkdir()
                (agent / "models.json").write_text(json.dumps(models), encoding="utf-8")
                # No defaultTools: harness-env must replace pi's bash default with PowerShell tools.
                (agent / "settings.json").write_text(json.dumps({"packages": [str(bundle)]}), encoding="utf-8")
                for name in [key for key in env if key.startswith(("PI_LENS_", "HARNESS_", "PI_SUBAGENT_"))]:
                    env.pop(name)
                # Reproduce a PC whose PATH omits both PowerShell and where.exe.
                # harness-env must recover the system tools from SystemRoot.
                for name in [key for key in env if key.upper() == "PATH"]:
                    env.pop(name)
                env["Path"] = str(project)
                env["PI_CODING_AGENT_DIR"] = str(agent)
                command = [str(bundle / "bin/pi/pi.exe"), *arguments]
            else:
                # What a user gets after setup.ps1 and a new terminal: machine PATH and variables, settings in <bundle>/config.
                agent = bundle / "config"
                models_path.write_text(json.dumps(models), encoding="utf-8")
                if mode == "upgrade":
                    env = windows_user_environment()
                else:
                    env.pop("PI_CODING_AGENT_DIR", None)
                powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
                if mode == "upgrade":
                    # The UAC child may run as a different administrator. It must leave that account's
                    # user settings alone; cleanup belongs to the original caller after elevation returns.
                    elevated = subprocess.run([str(powershell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(bundle / "setup.ps1"), "-SystemOnly"],
                                              env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
                    if elevated.returncode:
                        raise AssertionError(f"System-only setup failed ({elevated.returncode})\n{elevated.stdout}\n{elevated.stderr}")
                    assert windows_user_environment()["PI_CODING_AGENT_DIR"] == str(bundle / "agent"), "Elevated setup changed user settings"
                setup = subprocess.run([str(powershell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(bundle / "setup.ps1")],
                                       env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
                if setup.returncode:
                    raise AssertionError(f"setup.ps1 failed ({setup.returncode})\n{setup.stdout}\n{setup.stderr}")
                import winreg
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment") as key:
                    machine = {name: os.path.expandvars(winreg.QueryValueEx(key, name)[0]) for name in ("Path", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "PI_SKIP_VERSION_CHECK")}
                if os.path.normcase(machine["PI_CODING_AGENT_DIR"]) != os.path.normcase(str(agent)):
                    raise AssertionError(f"PI_CODING_AGENT_DIR is not the bundle config folder: {machine['PI_CODING_AGENT_DIR']}")
                # Windows merges user variables over machine variables. Do not manufacture a machine-only
                # environment: that masked stale PI_CODING_AGENT_DIR user overrides in earlier tests.
                env = windows_user_environment()
                for name in ("PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "PI_SKIP_VERSION_CHECK"):
                    if env.get(name) != machine[name]:
                        raise AssertionError(f"Fresh user environment overrides system {name}")
                path = next(value for name, value in env.items() if name.upper() == "PATH")
                pi = shutil.which("pi", path=path)
                if not pi or not os.path.normcase(pi).startswith(os.path.normcase(str(bundle))):
                    raise AssertionError(f"pi on the machine PATH is not the bundle's pi.exe: {pi}")
                command = [pi, *arguments]
            agents = agent / "agents"
            created_agents_dir = not agents.exists()
            agents.mkdir(parents=True, exist_ok=True)
            smoke_agent = agents / "harness-smoke.md"
            if smoke_agent.exists():
                raise FileExistsError(smoke_agent)
            smoke_agent.write_text("---\nname: harness-smoke\ndescription: Local API smoke fixture\nmodel: offline/smoke\ntools: read\n---\nReply CHILD_OK only.\n", encoding="utf-8")
            created_smoke_agent = True
            gate_path = agent / "extensions/allowlist-gate.json"
            gate_path.parent.mkdir(parents=True, exist_ok=True)
            gate_path.write_text(json.dumps(gate), encoding="utf-8")
            result = subprocess.run(command, cwd=project, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
            if result.returncode or "OFFLINE_STANDALONE_OK" not in result.stdout or state["errors"] or state["turn"] != len(stages) + 1 + forced_turns or state["reminders"] != forced_turns or state["children"] != 1:
                raise AssertionError(f"pi smoke failed ({result.returncode}), turns={state['turn']}, reminders={state['reminders']}, errors={state['errors']}\n{result.stdout}\n{result.stderr}")
            if not node_cli and legacy.read_bytes() != "// 한글 주석\r\nint legacy = 2; // 수정\r\n".encode("cp949"):
                raise AssertionError(f"CP949 edit changed the file encoding: {legacy.read_bytes()!r}")
            print(f"pi {mode} passed: package extensions and skills, tool guide once, foreground child, allowlist gate, all 5 LSP tools, find_symbol, write -> diagnostics, verify-guard reminders")
        finally:
            if created_smoke_agent:
                smoke_agent.unlink()
                if created_agents_dir:
                    agents.rmdir()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            if mode in ("installed", "upgrade"):
                bundle_gate.write_bytes(previous_gate)
                if previous_models is None:
                    models_path.unlink(missing_ok=True)
                else:
                    models_path.write_bytes(previous_models)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--node-cli", action="store_true")
    group.add_argument("--direct", action="store_true")
    group.add_argument("--upgrade", action="store_true")
    args = parser.parse_args()
    run(args.bundle, "node-cli" if args.node_cli else "direct" if args.direct else "upgrade" if args.upgrade else "installed")
