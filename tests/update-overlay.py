"""Check the overlay update: build it from a crafted older base and apply it with setup.ps1.

prepare <bundle> <new_zip> <out_dir>: turn the extracted bundle into a "base" (stale file, extra file, matching manifest),
  build the overlay against it and extract the overlay over the bundle.
verify <bundle> <new_zip>: after setup.ps1, the bundle must equal the complete ZIP again.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

TOP = "pi-kit"
STALE, EXTRA = "docs/tool-guide.md", "extensions/removed-by-update/index.ts"


def load_generator():
    spec = importlib.util.spec_from_file_location("make_update", Path(__file__).parent.parent / ".github/tools/make-update.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prepare(bundle, new_zip, out_dir):
    bundle = Path(bundle)
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    (bundle / STALE).write_bytes((bundle / STALE).read_bytes() + b"\nOLD BASE\n")
    (bundle / EXTRA).parent.mkdir(parents=True)
    (bundle / EXTRA).write_bytes(b"old")
    manifest["files"][STALE] = sha((bundle / STALE).read_bytes())
    manifest["files"][EXTRA] = sha(b"old")
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    base = Path(out_dir) / "base-manifest.json"
    base.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (bundle / "manifest.json").write_bytes(base.read_bytes())
    overlay = load_generator().make_update(new_zip, base, "v0.0.0-test", out_dir)
    with zipfile.ZipFile(overlay) as archive:
        info = json.loads(archive.read(f"{TOP}/update/update.json"))
        assert STALE in info["files"] and EXTRA in info["remove"], info
        assert len(info["files"]) < 20, f"overlay should hold only changed files: {len(info['files'])}"
        archive.extractall(bundle.parent)


def verify(bundle, new_zip):
    bundle = Path(bundle)
    with zipfile.ZipFile(new_zip) as archive:
        assert (bundle / STALE).read_bytes() == archive.read(f"{TOP}/{STALE}"), "stale file was not updated"
        assert (bundle / "manifest.json").read_bytes() == archive.read(f"{TOP}/manifest.json"), "manifest was not replaced"
    assert not (bundle / EXTRA).exists(), "removed file is still present"
    assert not (bundle / "update").exists(), "update folder was not cleaned up"
    print("OVERLAY_UPDATE_OK")


if __name__ == "__main__":
    {"prepare": prepare, "verify": verify}[sys.argv[1]](*sys.argv[2:])
