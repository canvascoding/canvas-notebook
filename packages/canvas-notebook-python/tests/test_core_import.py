"""Core import isolation; no OAuth/MCP/HTTP/keyring dependency may be imported."""

from __future__ import annotations

import subprocess
import sys
import unittest


class CoreImportTests(unittest.TestCase):
    def test_core_facade_loads_with_external_adapters_explicitly_unavailable(self) -> None:
        script = r'''
import importlib.abc
import sys

class BlockExternalImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".", 1)[0] in {"mcp", "mcp_types", "httpx2", "keyring"}:
            raise ModuleNotFoundError("External adapter dependency deliberately unavailable")
        return None

sys.meta_path.insert(0, BlockExternalImports())
from canvas_notebook import CanvasNotebook, CanvasToolResult, CompleteDocument, ToolTransport
from canvas_notebook import CanvasMutationOutcomeUnknown, CanvasToolError
assert CanvasNotebook and CanvasToolResult and CompleteDocument and ToolTransport
assert CanvasMutationOutcomeUnknown and CanvasToolError
assert "canvas_notebook.transport" not in sys.modules
assert "canvas_notebook.auth" not in sys.modules
assert "canvas_notebook.credentials" not in sys.modules
print("CORE_IMPORT_WITHOUT_EXTERNAL_ADAPTERS_OK")
'''
        completed = subprocess.run(
            [sys.executable, "-I", "-c", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, "Isolated core import must succeed.")
        self.assertEqual(completed.stdout.strip(), "CORE_IMPORT_WITHOUT_EXTERNAL_ADAPTERS_OK")
