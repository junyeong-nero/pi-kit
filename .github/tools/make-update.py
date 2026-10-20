#!/usr/bin/env python3
"""Build the overlay update ZIP: only the files that changed since a base release.

The complete ZIP's manifest.json lists every shipped file with its SHA-256. Comparing the new manifest with the
base release's manifest gives the changed, added and removed files. The overlay stages them under update/ so that
setup.ps1 can verify the base and apply them in one step; extracting it alone changes nothing that runs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

TOP = "pi-offline-kit"
MANIFEST_ASSET = "manifest-win-x64.json"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def manifest_member(archive):
    """The manifest sits directly under the single top folder, which was named differently in older releases."""
    names = [n for n in archive.namelist() if n.count("/") == 1 and n.endswith("/manifest.json")]
    if len(names) != 1:
        raise SystemExit(f"Expected one <folder>/manifest.json in the ZIP, found {names}")
    return names[0]


def read_manifest(path):
    """Return the manifest bytes from a manifest file or from a complete ZIP."""
    path = Path(path)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            return archive.read(manifest_member(archive))
    return path.read_bytes()


def make_update(new_zip, base, base_version, output_dir):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    new_raw = read_manifest(new_zip)
    new = json.loads(new_raw)
    (output_dir / MANIFEST_ASSET).write_bytes(new_raw)
    if base is None:
        print("No base release: overlay not built; manifest published for future updates")
        return None
    base_raw = read_manifest(base)
    old_files, new_files = json.loads(base_raw)["files"], new["files"]
    changed = sorted(path for path, digest in new_files.items() if old_files.get(path) != digest)
    removed = sorted(path for path in old_files if path not in new_files)
    version = new.get("version", "dev")
    info = {"format": 1, "version": version, "base_version": base_version, "base_manifest_sha256": sha256(base_raw),
            "files": {path: new_files[path] for path in changed}, "remove": removed}
    output = output_dir / f"pi-offline-kit-update-from-{base_version}-win-x64.zip"
    partial = output.with_suffix(".zip.partial")
    try:
        with zipfile.ZipFile(new_zip) as source, zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as target:
            for path in changed:
                data = source.read(f"{TOP}/{path}")
                if sha256(data) != new_files[path]:
                    raise SystemExit(f"Complete ZIP does not match its manifest: {path}")
                target.writestr(f"{TOP}/update/files/{path}", data)
            target.writestr(f"{TOP}/update/manifest.json", new_raw)
            target.writestr(f"{TOP}/update/update.json", json.dumps(info, indent=2, ensure_ascii=False) + "\n")
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)
    output.with_suffix(output.suffix + ".sha256").write_text(f"{sha256(output.read_bytes())}  {output.name}\n")
    print(f"Built {output.name}: {len(changed)} changed/added, {len(removed)} removed, "
          f"{output.stat().st_size / 1024 / 1024:.2f} MiB (base {base_version}, new {version})")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--new-zip", required=True)
    parser.add_argument("--base", help="Base release manifest file or complete ZIP; omit when no earlier release exists")
    parser.add_argument("--base-version", default="")
    parser.add_argument("--output-dir", default="dist")
    args = parser.parse_args()
    if args.base and not args.base_version:
        sys.exit("--base-version is required with --base")
    make_update(args.new_zip, args.base, args.base_version, args.output_dir)
