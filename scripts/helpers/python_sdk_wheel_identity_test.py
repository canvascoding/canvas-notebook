"""Exercise the probe's identity guard against a real installed wheel.

Only optional pip metadata is substituted. Wheel bytes and installed runtime
files always come from the actual artifact and the current SDK source tree.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
from unittest.mock import patch


def main():
    root = Path(__file__).resolve().parents[2]
    wheel = Path(os.environ["CANVAS_SDK_TEST_WHEEL"]).resolve(strict=True)
    source = root / "packages/canvas-notebook-python/src/canvas_notebook"
    config = {"wheelUri": wheel.as_uri(), "wheelSha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
              "runtimeSourceHashes": {item.name: hashlib.sha256(item.read_bytes()).hexdigest()
                                      for item in source.iterdir() if item.is_file()
                                      and (item.suffix == ".py" or item.name == "py.typed")}}
    spec = importlib.util.spec_from_file_location("wheel_identity_guard", root / "scripts/helpers/python_sdk_issued_oauth_keychain_probe.py")
    assert spec and spec.loader
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    original = importlib.metadata.distribution
    installed = original("canvas-notebook-python")
    direct = json.loads(installed.read_text("direct_url.json"))
    assert direct["url"] == config["wheelUri"]
    cases = []

    class MetadataOnly:
        def __init__(self, archive):
            self.archive = archive

        def __getattr__(self, name):
            return getattr(installed, name)

        def read_text(self, name):
            if name == "direct_url.json":
                return json.dumps({**direct, "archive_info": self.archive})
            return installed.read_text(name)

    def check(name, candidate, archive, rejected=False):
        def distribution(package):
            return MetadataOnly(archive) if package == "canvas-notebook-python" else original(package)
        with patch.object(importlib.metadata, "distribution", distribution):
            try:
                helper.verify_installed_wheel(candidate)
            except AssertionError:
                assert rejected, name
            else:
                assert not rejected, name
        cases.append({"case": name, "passed": True, "expectedRejection": rejected})

    helper.verify_installed_wheel(config)
    check("older pip omits optional archive digest", config, {})
    check("current pip records archive digest", config, {"hashes": {"sha256": config["wheelSha256"]}})
    check("legacy archive digest", config, {"hash": "sha256=" + config["wheelSha256"]})
    check("contradictory recorded digest", config, {"hashes": {"sha256": "0" * 64}}, True)
    for name in ["wheelSha256", "runtimeSourceHashes", "runtimeFileSet", "wheelUri"]:
        candidate = copy.deepcopy(config)
        if name == "wheelSha256":
            candidate[name] = "0" * 64
        elif name == "runtimeSourceHashes":
            candidate[name]["__init__.py"] = "0" * 64
        elif name == "runtimeFileSet":
            candidate["runtimeSourceHashes"]["unexpected.py"] = "0" * 64
        else:
            candidate[name] += ".different"
        check("reject changed " + name, candidate, {}, True)
    print(json.dumps({"suite": "installed-sdk-wheel-identity", "passed": True, "cases": cases,
                      "actualInstalledWheel": True, "actualHttpAcceptance": False}))


if __name__ == "__main__":
    main()
