"""Trusted bootstrap runs under -I -B -S, after kernel confinement is active."""
import json
import os
import runpy
import sys

sdk_root, package_root, entry_path, dependencies = sys.argv[1:5]
# Never load sitecustomize/user packages or a module from the writable cwd.
sys.path[:0] = [sdk_root, package_root] + json.loads(dependencies)
sys.argv = [entry_path]
runpy.run_path(entry_path, run_name="__main__")
