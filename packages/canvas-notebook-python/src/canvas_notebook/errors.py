"""Safe SDK errors; original MCP results remain available for inspection."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import ToolResultLike

_CODE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,79}\Z")
_OPERATION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")


class CanvasClientError(Exception):
    """Base for local SDK policy/shape failures, never a server authority."""


class CanvasToolError(CanvasClientError):
    """A returned tool error, with its complete original result retained.

    Error strings deliberately omit server messages, document contents, OAuth
    challenges and credentials. Inspect ``result`` explicitly when needed.
    """

    def __init__(self, tool_name: str, result: ToolResultLike) -> None:
        self.tool_name = tool_name
        self.result = result
        payload = result.structured_content
        code = payload.get("code") if isinstance(payload, dict) else None
        operation_id = payload.get("operationId") if isinstance(payload, dict) else None
        self.code = code if isinstance(code, str) and _CODE.fullmatch(code) else None
        self.operation_id = (
            operation_id
            if isinstance(operation_id, str) and _OPERATION_ID.fullmatch(operation_id)
            else None
        )
        super().__init__(f"Canvas tool failed ({self.code or 'TOOL_ERROR'}).")


class CanvasProtocolError(CanvasClientError):
    """A result cannot safely be treated as the requested complete document."""

    def __init__(self, reason: str, *, result: ToolResultLike | None = None) -> None:
        self.reason = reason
        self.result = result
        super().__init__(f"Canvas response could not be used ({reason}).")


class CanvasMutationOutcomeUnknown(CanvasClientError):
    """No tool result was received; a mutation may already have happened.

    The document facade invokes its transport once. The unchanged caller key
    is recovery data, not proof of a mutation. No new key, status polling or
    application-level replay is attempted by the facade.
    The original transport exception is retained as ``__cause__``.
    """

    def __init__(self, tool_name: str, idempotency_key: str) -> None:
        self.tool_name = tool_name
        self.idempotency_key = idempotency_key
        self.safe_to_auto_retry = False
        super().__init__(
            "Canvas mutation outcome is unknown. Retain the original caller "
            "idempotency key; inspect an issued operation ID before deciding a retry."
        )
