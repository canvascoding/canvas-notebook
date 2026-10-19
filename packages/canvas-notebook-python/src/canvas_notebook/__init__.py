"""Canvas Notebook Python client over the official MCP transport and OAuth."""

from importlib import import_module
from typing import Any

from .documents import CanvasNotebook
from .errors import (
    CanvasClientError,
    CanvasMutationOutcomeUnknown,
    CanvasProtocolError,
    CanvasToolError,
)
from .models import (
    CanvasToolResult,
    CompleteDocument,
    DocumentCreateResult,
    DocumentEditResult,
    DocumentReadPage,
    DocumentRef,
    DocumentSearchPage,
    FileReference,
    PublicCopyCode,
    PublicWorkspacePathCode,
    ReadFormat,
    ToolResultLike,
    ToolTransport,
    WorkspaceCopyExecutionResult,
    WorkspaceCopyFailure,
    WorkspaceCopyPreviewResult,
    WorkspaceCopySelection,
    WorkspaceCopyStatusResult,
    WorkspaceDeletePreviewResult,
    WorkspaceMovePreviewResult,
    WorkspaceMoveSelection,
    WorkspacePathExecutionResult,
    WorkspacePathFailure,
    WorkspacePathOperation,
    WorkspacePathStatusResult,
)

_EXTERNAL_EXPORTS = {
    "CanvasMcpTransport": ".transport",
    "CanvasOAuth": ".auth",
    "MemoryTokenStorage": ".credentials",
    "KeyringTokenStorage": ".credentials",
}


def __getattr__(name: str) -> Any:
    """Load external OAuth/MCP dependencies only when explicitly requested."""
    module = _EXTERNAL_EXPORTS.get(name)
    if module is None:
        raise AttributeError(name)
    value = getattr(import_module(module, __name__), name)
    globals()[name] = value
    return value

__all__ = [
    "CanvasClientError",
    "CanvasMcpTransport",
    "CanvasMutationOutcomeUnknown",
    "CanvasNotebook",
    "CanvasOAuth",
    "CanvasProtocolError",
    "CanvasToolError",
    "CanvasToolResult",
    "CompleteDocument",
    "DocumentCreateResult",
    "DocumentEditResult",
    "DocumentReadPage",
    "DocumentRef",
    "DocumentSearchPage",
    "FileReference",
    "PublicCopyCode",
    "PublicWorkspacePathCode",
    "KeyringTokenStorage",
    "MemoryTokenStorage",
    "ReadFormat",
    "ToolTransport",
    "ToolResultLike",
    "WorkspaceCopyExecutionResult",
    "WorkspaceCopyFailure",
    "WorkspaceCopyPreviewResult",
    "WorkspaceCopySelection",
    "WorkspaceCopyStatusResult",
    "WorkspaceDeletePreviewResult",
    "WorkspaceMovePreviewResult",
    "WorkspaceMoveSelection",
    "WorkspacePathExecutionResult",
    "WorkspacePathFailure",
    "WorkspacePathOperation",
    "WorkspacePathStatusResult",
]
