#!/usr/bin/env python3

import argparse
import base64
import csv
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def copy_from_image(image, architecture, destination):
    container = run("docker", "create", "--platform", f"linux/{architecture}", "--entrypoint", "/bin/true", image)
    try:
        image_id = run("docker", "inspect", "--format", "{{.Image}}", container)
        for version in ("3.11", "3.12", "3.13", "3.14"):
            for kind in ("dist-packages", "site-packages"):
                site = f"/usr/local/lib/python{version}/{kind}"
                extension = destination / "hf_xet.abi3.so"
                record = destination / "RECORD"
                first = subprocess.run(
                    ["docker", "cp", f"{container}:{site}/hf_xet/hf_xet.abi3.so", str(extension)],
                    capture_output=True,
                    check=False,
                )
                second = subprocess.run(
                    ["docker", "cp", f"{container}:{site}/hf_xet-1.6.0.dist-info/RECORD", str(record)],
                    capture_output=True,
                    check=False,
                )
                if first.returncode == 0 and second.returncode == 0:
                    return extension, record, image_id
                extension.unlink(missing_ok=True)
                record.unlink(missing_ok=True)
        raise RuntimeError(f"hf-xet 1.6.0 extension and RECORD not found in {image}")
    finally:
        subprocess.run(["docker", "rm", "-f", container], check=True, capture_output=True)


def inspect(image, architecture, readelf, destination):
    extension, record, image_id = copy_from_image(image, architecture, destination)
    matching = [row for row in csv.reader(record.open()) if row[0] == "hf_xet/hf_xet.abi3.so"]
    if len(matching) != 1:
        raise RuntimeError(f"expected one hf-xet extension RECORD entry in {image}")
    recorded_hash = matching[0][1]
    if not recorded_hash.startswith("sha256="):
        raise RuntimeError(f"unsupported hf-xet RECORD digest in {image}")
    encoded = recorded_hash.removeprefix("sha256=")
    recorded_digest = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    digest = hashlib.sha256(extension.read_bytes()).digest()
    if digest != recorded_digest or extension.stat().st_size != int(matching[0][2]):
        raise RuntimeError(f"hf-xet extension does not match RECORD in {image}")
    header = run(readelf, "-h", str(extension))
    notes = run(readelf, "-n", str(extension))
    dynamic = run(readelf, "-d", str(extension))
    machine = re.search(r"^\s*Machine:\s*(.+)$", header, re.MULTILINE)
    if not machine:
        raise RuntimeError(f"ELF machine missing in {image}")
    if architecture == "amd64" and "X86-64" not in machine.group(1):
        raise RuntimeError(f"unexpected amd64 ELF machine in {image}")
    if architecture == "arm64" and "AArch64" not in machine.group(1):
        raise RuntimeError(f"unexpected arm64 ELF machine in {image}")
    build_ids = re.findall(r"Build ID:\s*([0-9a-fA-F]+)", notes)
    needed = re.findall(r"\(NEEDED\).*?Shared library: \[([^]]+)\]", dynamic)
    if not needed:
        raise RuntimeError(f"ELF dependency list missing in {image}")
    return {
        "architecture": architecture,
        "image": image,
        "imageId": image_id,
        "distribution": "hf-xet@1.6.0",
        "file": "hf_xet/hf_xet.abi3.so",
        "size": extension.stat().st_size,
        "sha256": digest.hex(),
        "recordMatches": True,
        "elfMachine": machine.group(1),
        "buildId": build_ids[0] if len(build_ids) == 1 else None,
        "needed": needed,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image")
    parser.add_argument("--architecture", choices=("amd64", "arm64"))
    parser.add_argument("--amd64-image")
    parser.add_argument("--arm64-image")
    parser.add_argument("--readelf", default=shutil.which("llvm-readelf") or shutil.which("readelf"))
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    if not options.readelf:
        parser.error("llvm-readelf or readelf is required")
    single = options.image is not None or options.architecture is not None
    dual = options.amd64_image is not None or options.arm64_image is not None
    if single == dual:
        parser.error("provide either --image and --architecture or both architecture images")
    if single and (not options.image or not options.architecture):
        parser.error("--image and --architecture are required together")
    if dual and (not options.amd64_image or not options.arm64_image):
        parser.error("--amd64-image and --arm64-image are required together")
    sources = (
        ((options.architecture, options.image),)
        if single
        else (("amd64", options.amd64_image), ("arm64", options.arm64_image))
    )
    with tempfile.TemporaryDirectory(prefix="canvas-hf-xet-evidence-") as temporary:
        root = Path(temporary)
        entries = []
        for architecture, image in sources:
            destination = root / architecture
            destination.mkdir()
            entries.append(inspect(image, architecture, options.readelf, destination))
    options.output.write_text(json.dumps({"schemaVersion": 1, "images": entries}, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
