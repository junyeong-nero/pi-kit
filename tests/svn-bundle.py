"""Exercise the bundled SVN executables against a disposable local repository."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile


def run(bundle):
    binaries = Path(bundle).resolve() / "bin/svn/bin"
    with tempfile.TemporaryDirectory(prefix="harness svn 한글 ") as temp:
        root = Path(temp)
        env = {key: value for key, value in os.environ.items() if key.upper() != "PATH"}
        env["Path"] = str(binaries)

        def call(tool, *args):
            result = subprocess.run([str(binaries / (tool + ".exe")), *map(str, args)], cwd=root,
                                    env=env, stdin=subprocess.DEVNULL, capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=30)
            if result.returncode:
                raise AssertionError(f"{tool} {args} failed ({result.returncode}): {result.stdout}\n{result.stderr}")
            return result.stdout

        def svn(*args):
            return call("svn", *args, "--non-interactive", "--config-dir", root / "config")

        assert call("svn", "--version", "--quiet").strip() == "1.15.0"
        repo, working = root / "repository", root / "working copy"
        call("svnadmin", "create", repo)
        svn("checkout", repo.as_uri(), working)
        file = working / "sample.txt"
        file.write_text("before\n", encoding="utf-8")
        svn("add", file)
        svn("commit", working, "-m", "local smoke fixture")
        assert not svn("status", working).strip()
        file.write_text("after\n", encoding="utf-8")
        assert "sample.txt" in svn("status", working)
        diff = svn("diff", working)
        assert "-before" in diff and "+after" in diff, diff
        assert "local smoke fixture" in svn("log", repo.as_uri(), "--limit", "1")
        print("Bundled SVN: version, local checkout, status, diff and log passed without system SVN on PATH")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    run(parser.parse_args().bundle)
