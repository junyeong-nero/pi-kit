"""Check the public package name and overlay layout without Windows binaries."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import textwrap
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = "pi-offline-kit"


class BundleIdentity(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="pi bundle 한글 ")
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        spec = importlib.util.spec_from_file_location("make_update", ROOT / ".github/tools/make-update.py")
        self.generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.generator)

    def new_zip(self):
        files = {"package.json": b'{"name":"pi-offline-kit"}', "docs/example.md": b"new"}
        manifest = {"version": "v0.2.0", "files": {
            path: hashlib.sha256(data).hexdigest() for path, data in files.items()
        }}
        archive = self.folder / f"{NAME}-win-x64.zip"
        with zipfile.ZipFile(archive, "w") as target:
            for path, data in files.items():
                target.writestr(f"{NAME}/{path}", data)
            target.writestr(f"{NAME}/manifest.json", json.dumps(manifest))
        return archive, manifest

    def test_package_workflow_and_generator_share_the_name(self):
        self.assertEqual(json.loads((ROOT / "package.json").read_text())["name"], NAME)
        self.assertEqual(json.loads((ROOT / "package-lock.json").read_text())["name"], NAME)
        self.assertEqual(self.generator.TOP, NAME)
        workflow = (ROOT / ".github/workflows/offline.yml").read_text(encoding="utf-8")
        start = workflow.index("      - name: Assemble complete ZIP\n")
        end = workflow.index("\n      - name:", start + 1)
        code = textwrap.dedent(workflow[start:end].split("        run: |\n", 1)[1])
        compile(code, "offline-workflow", "exec")
        self.assertIn(f'stage = Path(tmp) / "{NAME}"', code)
        self.assertIn(f'dist/{NAME}-win-x64.zip', code)

    def test_overlay_contains_only_changed_files_under_the_new_folder(self):
        archive, manifest = self.new_zip()
        base = self.folder / "base.json"
        base.write_text(json.dumps({"files": {
            "package.json": manifest["files"]["package.json"],
            "docs/example.md": "old-hash", "docs/removed.md": "old-hash",
        }}))
        output = self.generator.make_update(archive, base, "v0.1.0", self.folder / "dist")
        self.assertEqual(output.name, f"{NAME}-update-from-v0.1.0-win-x64.zip")
        with zipfile.ZipFile(output) as update:
            self.assertTrue(all(path.startswith(f"{NAME}/update/") for path in update.namelist()))
            info = json.loads(update.read(f"{NAME}/update/update.json"))
            self.assertEqual(list(info["files"]), ["docs/example.md"])
            self.assertEqual(info["remove"], ["docs/removed.md"])
            self.assertEqual(info["base_manifest_sha256"], hashlib.sha256(base.read_bytes()).hexdigest())
        self.assertEqual(output.with_suffix(".zip.sha256").read_text().split()[0],
                         hashlib.sha256(output.read_bytes()).hexdigest())

    def test_first_release_exports_manifest_without_overlay(self):
        archive, _manifest = self.new_zip()
        out = self.folder / "dist"
        self.assertIsNone(self.generator.make_update(archive, None, "", out))
        self.assertTrue((out / "manifest-win-x64.json").is_file())
        self.assertEqual(list(out.glob("*.zip")), [])


if __name__ == "__main__":
    unittest.main()
