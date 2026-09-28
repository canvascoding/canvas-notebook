#!/usr/bin/env python3

import ctypes
import hashlib
import importlib.metadata
import json
import platform
import subprocess
from pathlib import Path


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def wheel_files(name, pattern):
    distribution = importlib.metadata.distribution(name)
    root = Path(distribution.locate_file("")).resolve()
    matches = sorted(root.glob(pattern))
    if not matches:
        raise RuntimeError(f"{name} wheel is missing {pattern}")
    return matches


def linked_libraries(path):
    output = subprocess.check_output(["ldd", str(path)], text=True)
    if "not found" in output:
        raise RuntimeError(f"unresolved library in {path}: {output}")
    return output


def digest_entry(path):
    return {"file": path.name, "sha256": sha256(path)}


def wheel_license_files(name):
    distribution = importlib.metadata.distribution(name)
    return [
        {"file": str(file), "sha256": sha256(Path(distribution.locate_file(file)))}
        for file in distribution.files
        if ".dist-info/licenses/" in str(file)
        and "__pycache__" not in str(file)
        and not str(file).endswith(".pyc")
    ]


avcodec = wheel_files("av", "av.libs/libavcodec*.so*")[0]
av_x264 = wheel_files("av", "av.libs/libx264*.so*")[0]
av_x265 = wheel_files("av", "av.libs/libx265*.so*")[0]
ctranslate2 = wheel_files("ctranslate2", "ctranslate2.libs/libctranslate2*.so*")[0]
bundled_gomp = wheel_files("ctranslate2", "ctranslate2.libs/libgomp*.so*")[0]
ctranslate2_extension = wheel_files("ctranslate2", "ctranslate2/_ext*.so")[0]

library = ctypes.CDLL(str(avcodec))
library.avcodec_license.restype = ctypes.c_char_p
library.avcodec_configuration.restype = ctypes.c_char_p
avcodec_linkage = linked_libraries(avcodec)
extension_linkage = linked_libraries(ctranslate2_extension)
cli_buildconf = subprocess.check_output(["ffmpeg", "-buildconf"], text=True, stderr=subprocess.STDOUT)

evidence = {
    "schemaVersion": 1,
    "architecture": platform.machine(),
    "av": {
        "version": importlib.metadata.version("av"),
        "avcodec": digest_entry(avcodec),
        "x264": digest_entry(av_x264),
        "x265": digest_entry(av_x265),
        "avcodecLicense": library.avcodec_license().decode(),
        "avcodecConfiguration": library.avcodec_configuration().decode(),
        "avcodecLinksBundledX264": av_x264.name in avcodec_linkage,
        "avcodecLinksBundledX265": av_x265.name in avcodec_linkage,
        "wheelLicenseFiles": wheel_license_files("av"),
    },
    "ctranslate2": {
        "version": importlib.metadata.version("ctranslate2"),
        "library": digest_entry(ctranslate2),
        "bundledGomp": digest_entry(bundled_gomp),
        "extension": digest_entry(ctranslate2_extension),
        "extensionLinksBundledLibrary": ctranslate2.name in extension_linkage,
        "extensionLinksBundledGomp": bundled_gomp.name in extension_linkage,
        "wheelLicenseFiles": wheel_license_files("ctranslate2"),
    },
    "ffmpegCli": {
        "versionLine": cli_buildconf.splitlines()[0],
        "configuration": cli_buildconf,
    },
}

output = Path(__import__("sys").argv[1])
output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
