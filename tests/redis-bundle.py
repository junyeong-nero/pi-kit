"""Exercise the relocated Redis server and CLI using only files from the release ZIP."""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import zipfile


def run(bundle, archive):
    bundle = Path(bundle).resolve()
    artifact = json.loads((bundle / "config/offline-artifacts.lock.json").read_text())["artifacts"]["redis"]
    binaries = bundle / artifact["destination"]
    assert "files" not in artifact, "The complete upstream package must be extracted"
    assert hashlib.sha256(Path(archive).read_bytes()).hexdigest() == artifact["sha256"]
    with zipfile.ZipFile(archive) as source:
        expected = {i.filename.removeprefix(artifact["prefix"]): source.read(i)
                    for i in source.infolist() if not i.is_dir() and i.filename.startswith(artifact["prefix"])}
    assert {str(p.relative_to(binaries)).replace(os.sep, "/") for p in binaries.rglob("*") if p.is_file()} == set(expected)
    for name, content in expected.items():
        assert (binaries / name).read_bytes() == content, f"Upstream Redis file changed: {name}"
    assert {p.name for p in binaries.glob("*.exe")} == {
        "redis-cli.exe", "redis-server.exe", "redis-benchmark.exe", "redis-check-aof.exe",
        "redis-check-rdb.exe", "redis-sentinel.exe", "RedisService.exe",
    }
    config = bundle / "config/redis.local.conf"

    with tempfile.TemporaryDirectory(prefix="harness redis 한글 ") as temp:
        root = Path(temp)
        env = {key: value for key, value in os.environ.items()
               if key.upper() not in {"PATH", "REDISCLI_AUTH", "OPENSSL_CONF", "OPENSSL_MODULES"}}
        env["Path"] = str(binaries)
        # The service wrapper must use its embedded runtime, not an installed .NET framework.
        empty_dotnet = root / "no-installed-dotnet"
        empty_dotnet.mkdir()
        env["DOTNET_ROOT"] = env["DOTNET_ROOT_X64"] = str(empty_dotnet)
        env["DOTNET_MULTILEVEL_LOOKUP"] = "0"
        env["REDISCLI_AUTH"] = secrets.token_hex(16)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]

        def call(*args, authenticated=True):
            cli_env = env if authenticated else {k: v for k, v in env.items() if k != "REDISCLI_AUTH"}
            result = subprocess.run([str(binaries / "redis-cli.exe"), "-h", "127.0.0.1", "-p", str(port),
                                     "--user", "default", "--raw", "-e", *args], cwd=root, env=cli_env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=15)
            if not authenticated:
                assert result.returncode != 0 and "NOAUTH" in result.stdout + result.stderr
                return
            if result.returncode:
                raise AssertionError(f"redis-cli {args} failed ({result.returncode}): {result.stdout}\n{result.stderr}")
            return result.stdout.strip()

        assert call("--version") == f"redis-cli {artifact['version']}"
        assert "--tls" in call("--help"), "The bundled CLI must support TLS"
        version = subprocess.run([str(binaries / "redis-server.exe"), "--version"], cwd=root, env=env,
                                 capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=15).stdout
        assert f"Redis server v={artifact['version']}" in version
        wrapper = subprocess.run([str(binaries / "RedisService.exe"), "--version"], cwd=root, env=env,
                                 capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=20).stdout
        assert "RedisService version 2.0.0.0" in wrapper
        help_text = subprocess.run([str(binaries / "RedisService.exe"), "--help"], cwd=root, env=env,
                                  capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=15).stdout
        assert all(word in help_text for word in ["install", "uninstall", "--foreground", "--dir"])
        key, value = "harness:조회", "한글 value with spaces"
        powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        read_config = "$ErrorActionPreference = 'Stop'; Get-Content -Raw -LiteralPath '" + str(config).replace("'", "''") + "'"
        # Only this temporary authenticated fixture adds a password; no credentials enter the bundle.
        wrapped_config = root / "설정 with spaces.conf"
        wrapped_config.write_text(config.read_text(encoding="utf-8") + "\nrequirepass " + env["REDISCLI_AUTH"] + "\n", encoding="utf-8")
        def cygwin_path(path):
            return "/cygdrive/" + path.drive[0].lower() + str(path)[2:].replace("\\", "/")

        for mode, restart in (("direct", False), ("direct", True), ("converted", False), ("wrapper", False), ("wrapper", True)):
            data = root / (mode + " data 한글")
            data.mkdir(exist_ok=True)
            with ExitStack() as stack:
                log = stack.enter_context((root / "server.log").open("w", encoding="utf-8"))
                if mode == "direct":
                    reader = stack.enter_context(subprocess.Popen(
                        [str(powershell), "-NoProfile", "-NonInteractive", "-Command", read_config],
                        cwd=data, env=env, stdout=subprocess.PIPE, stderr=log,
                    ))
                    server = subprocess.Popen([str(binaries / "redis-server.exe"), "-", "--port", str(port),
                                               "--requirepass", env["REDISCLI_AUTH"]], cwd=data, env=env,
                                              stdin=reader.stdout, stdout=log, stderr=subprocess.STDOUT)
                    reader.stdout.close()
                elif mode == "converted":
                    # Match the wrapper's converted arguments, while retaining the raw server log.
                    server = subprocess.Popen([str(binaries / "redis-server.exe"), cygwin_path(wrapped_config),
                                               "--dir", cygwin_path(data), "--port", str(port)],
                                              cwd=binaries, env=env, stdin=subprocess.DEVNULL,
                                              stdout=log, stderr=subprocess.STDOUT)
                else:
                    # Native Windows paths on a different drive from the relocated binaries.
                    # cwd deliberately differs from --dir to catch silently misplaced snapshots.
                    server = subprocess.Popen([str(binaries / "RedisService.exe"), "run", "--foreground",
                                               "-c", str(wrapped_config), "--dir", str(data), "--port", str(port)],
                                              cwd=root, env=env, stdin=subprocess.DEVNULL,
                                              stdout=log, stderr=subprocess.STDOUT)
                try:
                    if mode == "direct":
                        assert reader.wait(timeout=15) == 0, "PowerShell failed to read the local Redis config"
                    deadline = time.monotonic() + 15
                    while True:
                        if server.poll() is not None or time.monotonic() >= deadline:
                            raise AssertionError(f"Redis {mode} failed to start: " + (root / "server.log").read_text(encoding="utf-8", errors="replace"))
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                                break
                        except OSError:
                            time.sleep(0.1)
                    assert call("PING") == "PONG"
                    call("PING", authenticated=False)
                    assert call("CONFIG", "GET", "bind").splitlines() == ["bind", "127.0.0.1"]
                    assert call("CONFIG", "GET", "protected-mode").splitlines() == ["protected-mode", "yes"]
                    if not restart:
                        # Write only to this disposable, authenticated loopback server.
                        assert call("SET", key, value) == "OK"
                        assert call("BGSAVE") == "Background saving started"
                        deadline = time.monotonic() + 15
                        while "rdb_bgsave_in_progress:1" in call("INFO", "persistence"):
                            assert time.monotonic() < deadline, "RDB background save timed out"
                            time.sleep(0.1)
                        assert "rdb_last_bgsave_status:ok" in call("INFO", "persistence")
                        assert (data / "dump.rdb").stat().st_size > 0
                        benchmark = subprocess.run([str(binaries / "redis-benchmark.exe"), "-h", "127.0.0.1", "-p", str(port),
                                                    "--user", "default", "-a", env["REDISCLI_AUTH"], "-n", "20", "-c", "1", "-t", "ping", "-q"],
                                                   cwd=data, env=env, capture_output=True, timeout=15)
                        assert benchmark.returncode == 0 and b"PING" in benchmark.stdout, "Bundled benchmark failed"
                    assert call("GET", key) == value, "RDB data must survive a server restart"
                    assert json.loads(call("--json", "GET", key)) == value
                    assert call("--scan", "--pattern", "harness:*").splitlines() == [key]
                    assert call("EVAL", "return redis.call('GET', KEYS[1])", "1", key) == value
                    assert call("SHUTDOWN", "SAVE") == ""
                    assert server.wait(timeout=10) == 0
                    assert (data / "dump.rdb").stat().st_size > 0
                    checked = subprocess.run([str(binaries / "redis-check-rdb.exe"), "dump.rdb"], cwd=data, env=env,
                                             capture_output=True, text=True, timeout=15)
                    assert checked.returncode == 0 and "RDB looks OK" in checked.stdout, checked.stdout + checked.stderr
                finally:
                    if server.poll() is None:
                        try:
                            call("SHUTDOWN", "NOSAVE")
                            server.wait(timeout=10)
                        except (AssertionError, subprocess.TimeoutExpired):
                            taskkill = Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"
                            subprocess.run([str(taskkill), "/PID", str(server.pid), "/T", "/F"], capture_output=True, timeout=15)
                            server.wait(timeout=10)
        aof = root / "valid.aof"
        aof.write_bytes(b"*3\r\n$3\r\nSET\r\n$11\r\nharness:aof\r\n$5\r\nvalue\r\n")
        checked = subprocess.run([str(binaries / "redis-check-aof.exe"), aof.name], cwd=root, env=env,
                                 capture_output=True, text=True, timeout=15)
        assert checked.returncode == 0, checked.stdout + checked.stderr
        sentinel_config = root / "sentinel-smoke.conf"
        sentinel_config.write_text(f"bind 127.0.0.1\nport {port}\nrequirepass {env['REDISCLI_AUTH']}\n", encoding="utf-8")
        with (root / "sentinel.log").open("w", encoding="utf-8") as log:
            sentinel = subprocess.Popen([str(binaries / "redis-sentinel.exe"), sentinel_config.name], cwd=root, env=env,
                                        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 15
                while True:
                    if sentinel.poll() is not None or time.monotonic() >= deadline:
                        raise AssertionError("Sentinel failed to start: " + (root / "sentinel.log").read_text(errors="replace"))
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.1)
                assert call("PING") == "PONG"
                assert "sentinel_masters:0" in call("INFO", "sentinel")
                call("SHUTDOWN")
                assert sentinel.wait(timeout=10) == 0
            finally:
                if sentinel.poll() is None:
                    sentinel.terminate()
                    sentinel.wait(timeout=10)
        print("Complete Redis package: original files, all seven EXEs, clean PATH, native Windows config/data paths, authentication, benchmark, Sentinel, RDB/AOF checks and persisted restart passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    run(args.bundle, args.archive)
