"""Windows CI: use only bundled Python/Redis on a relocated ZIP, starting the server as config/mcp.json does."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time


def run(bundle):
    bundle = Path(bundle).resolve()
    python = bundle / "runtime/python/python.exe"
    with tempfile.TemporaryDirectory(prefix="redis MCP 한글 ") as tmp:
        root = Path(tmp)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        # CI tests use only loopback and temporary credentials, never internal mappings.
        password = secrets.token_hex(16)
        env = {k: v for k, v in os.environ.items() if k.upper() not in {"PATH", "PYTHONPATH", "PYTHONHOME", "REDISCLI_AUTH"}}
        env.update(Path=str(bundle / "bin/redis"), REDISCLI_AUTH=password)
        config = root / "설정"
        config.mkdir()
        (config / "server_IP_mappings.json").write_text(json.dumps({"ProjectA": "127.0.0.1"}), encoding="utf-8")
        (config / "owners.json").write_text(json.dumps({"example.user": "홍길동"}, ensure_ascii=False), encoding="utf-8")
        (config / "settings.json").write_text(json.dumps({"port": port, "socket_timeout_seconds": 2}), encoding="utf-8")
        with (root / "redis.log").open("w") as log:
            server = subprocess.Popen([str(bundle / "bin/redis/redis-server.exe"), "--bind", "127.0.0.1", "--port", str(port),
                                       "--save", "", "--appendonly", "no", "--requirepass", password],
                                      cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=1):
                            break
                    except OSError:
                        if server.poll() is not None or time.monotonic() > deadline:
                            raise AssertionError("Bundled Redis fixture failed to start")
                        time.sleep(0.1)
                seed = '''
import json, os, redis, sys
r=redis.Redis(host="127.0.0.1", port=int(sys.argv[1]), password=os.environ["REDISCLI_AUTH"])
with r.pipeline(transaction=False) as p:
    for i in range(100):
        p.set(f"itemid:{i}", json.dumps({"name":f"TestModule{i}", "path":"src/한글", "owner":"example.user", "owner_kr":"홍길동"}))
        record={"state":"4", "starttime":"1775199106", "finishtime":"1775199158", "checktime":"1791963436", "meanbuildtime":"30", "buildcount":"83", "builder":"client (Linux build machine)", "log":"시작\\n완료"}
        p.set(f"buildid:{i}", json.dumps(record))
        p.set(f"analysisstaticid:{i}", json.dumps({**record,"state":"5","log":"첫 줄\\n한글 실패 로그\\n마지막 줄"}))
    p.set("itemid:broken", "not JSON")
    p.execute()
r.close()
'''
                subprocess.run([str(python), "-X", "utf8", "-s", "-c", seed, str(port)], env=env, cwd=root, check=True, timeout=30)
                # As after setup.ps1: config/mcp.json names `python`, which must resolve to the bundled one.
                # cwd is an unrelated folder so a stray main.py there cannot shadow the bundled server module.
                (root / "main.py").write_text("raise SystemExit('wrong main.py')\n", encoding="utf-8")
                driver_env = dict(env, Path=os.pathsep.join([str(python.parent), str(bundle / "bin/redis"), os.environ.get("SystemRoot", r"C:\Windows") + r"\System32"]),
                                  REDISCLI_AUTH=password, TEST_BUNDLE=str(bundle), TEST_REDIS_CONFIG=str(config), TEST_CWD=str(root))
                subprocess.run([str(python), "-X", "utf8", "-B", str(Path(__file__).with_name("build-center-mcp-integration.py"))],
                               env=driver_env, cwd=root, check=True, timeout=90)
                print("Bundled Redis MCP integration passed (authenticated loopback, 100 modules, relocated paths)")
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == "__main__":
    run(sys.argv[1])
