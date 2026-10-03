#!/usr/bin/env python3
"""Inspect the real Linux executable, source archive, notices and dynamic linkage."""

import json
import platform
import re
import subprocess
import sys
from pathlib import Path

from dictation_cpp import configuration, sha256


policy_path = Path(__file__).resolve().parent.parent / 'docs/compliance/dictation-cpp-policy.json'
policy, native = configuration(policy_path)
assert platform.machine() in ['x86_64', 'aarch64'], 'Unsupported container architecture'
assert sha256(native / 'whisper.cpp-source.tar.gz') == policy['sourceSha256']
linkage = subprocess.check_output(['ldd', str(native / 'whisper-cli')], text=True)
assert 'not found' not in linkage, linkage
for line in linkage.splitlines():
    assert re.match(r'^\s*(linux-vdso|libstdc\+\+\.so|libm\.so|libgcc_s\.so|libc\.so|libpthread\.so|/.*ld-linux)', line), line
subprocess.run([str(native / 'whisper-cli'), '--help'], check=True, capture_output=True, timeout=10)
evidence = {'schemaVersion': 1, 'architecture': platform.machine(),
            'engine': 'whisper-cpp', 'version': policy['version'],
            'sourceUrl': policy['sourceUrl'], 'sourceSha256': policy['sourceSha256'],
            'policySha256': sha256(policy_path), 'binarySha256': sha256(native / 'whisper-cli'),
            'noticeSha256': sha256(native / 'LICENSE.txt'),
            'modelNoticeSha256': sha256(native / 'MODEL-LICENSE.txt'),
            'license': policy['license'], 'buildOptions': policy['buildOptions'],
            'linkedLibraries': linkage.splitlines()}
Path(sys.argv[1]).write_text(json.dumps(evidence, indent=2) + '\n')
