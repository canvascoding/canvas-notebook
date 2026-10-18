"""Small asynchronous wrappers over the existing authenticated Canvas MCP tools."""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, cast

from .errors import CanvasMutationOutcomeUnknown, CanvasProtocolError
from .models import (
    CanvasToolResult,
    CompleteDocument,
    DocumentCreateResult,
    DocumentEditResult,
    DocumentReadPage,
    DocumentSearchPage,
    FileReference,
    ReadFormat,
    ToolTransport,
)

_VERSION = re.compile(r"canvas-document-v1:[a-f0-9]{64}\Z")
_METADATA_VERSION = re.compile(r"canvas-document-metadata-v1:[a-f0-9]{64}\Z")
_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\Z")
_OPERATION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_CURSOR = re.compile(r"[A-Za-z0-9_-]+\Z")
_MEDIA = {
    "native": "application/vnd.canvas.native-document+json",
    "text": "text/plain",
    "markdown": "text/markdown",
}


def _safe_int(value: Any, minimum: int = 0) -> bool:
    return type(value) is int and minimum <= value <= 9007199254740991


def _well_formed_text(value: Any, maximum: int, *, empty: bool = False) -> bool:
    if not isinstance(value, str) or len(value) > maximum or not empty and not value:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _read_identity_valid(document: Mapping[str, Any]) -> bool:
    """Validate comparison-data shape, never derive a version from content."""
    ids = ("workspaceId", "documentId", "lineageId")
    if (
        not all(_well_formed_text(document.get(key), 256) for key in ids)
        or document.get("organizationId") is not None
        and not _well_formed_text(document.get("organizationId"), 256)
        or "organizationId" not in document
        or not _safe_int(document.get("lifecycleGeneration"), 1)
        or not _safe_int(document.get("schemaVersion"), 1)
        or document.get("representation") not in ("plain_text", "tiptap_xml", "tiptap_blocks")
        or not _well_formed_text(document.get("path"), 4096)
        or not _well_formed_text(document.get("title"), 4096, empty=True)
        or not isinstance(document.get("metadataVersion"), str)
        or not _METADATA_VERSION.fullmatch(document["metadataVersion"])
    ):
        return False
    return True


def _currency_valid(currency: Any, version: str) -> bool:
    return (
        isinstance(currency, dict)
        and currency.get("source") in ("persisted_yjs", "live_yjs")
        and currency.get("observedVersion") == version
        and type(currency.get("observedDurable")) is bool
        and isinstance(currency.get("durableVersion"), str)
        and bool(_VERSION.fullmatch(currency["durableVersion"]))
        and _safe_int(currency.get("durableSequence"))
        and _safe_int(currency.get("persistedAt"))
    )


def _projection_valid(projection: Any) -> bool:
    return (
        isinstance(projection, dict)
        and projection.get("status") in ("current", "pending", "unavailable")
        and _safe_int(projection.get("checkpointSequence"))
        and "checkpointedAt" in projection
        and (projection["checkpointedAt"] is None or _safe_int(projection["checkpointedAt"]))
    )


def _string(value: str, label: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"{label} must be a nonempty bounded string.")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError(f"{label} must be valid UTF-8.") from None
    return value


def _integer(value: int, label: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{label} is outside its supported integer range.")
    return value


def _version(value: str) -> str:
    if not isinstance(value, str) or not _VERSION.fullmatch(value):
        raise ValueError("expected_version must be a full Canvas document version.")
    return value


def _key(value: str) -> str:
    if not isinstance(value, str) or not _KEY.fullmatch(value):
        raise ValueError("idempotency_key must contain 8–128 safe identifier characters.")
    return value


def _json_object(value: Mapping[str, Any], label: str) -> dict[str, Any]:
    """Detach JSON data without renaming keys, adding defaults or normalizing text."""
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be a JSON object.")
    def check_keys(item: Any) -> None:
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise ValueError
            for child in item.values():
                check_keys(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                check_keys(child)
    try:
        detached = dict(value)
        check_keys(detached)
        encoded = json.dumps(detached, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > 512 * 1024:
            raise ValueError
        decoded = json.loads(encoded)
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
        raise ValueError(f"{label} must be a bounded JSON object.") from None
    return cast(dict[str, Any], decoded)


class CanvasNotebook:
    """Document methods on an already entered structural ``ToolTransport``.

    The structural transport owns connection lifetime. The server owns
    permission checks, ID/version validation, Yjs edits, link orchestration and
    audit. This class never reads or writes workspace files directly.

    These methods use Canvas's public MCP tool names and snake_case selectors;
    returned DTOs and nested patches keep their actual Canvas camelCase keys.
    A future controlled PI bridge must deliberately adapt PI tool names and
    selectors. This module neither imports OAuth nor hands tokens to a sandbox.
    """

    def __init__(self, transport: ToolTransport) -> None:
        self._transport = transport

    async def _call(
        self, name: str, arguments: Mapping[str, Any]
    ) -> CanvasToolResult[Any]:
        raw = await self._transport.call_tool(name, arguments)
        return CanvasToolResult(name, raw)

    async def _mutate(
        self, name: str, arguments: Mapping[str, Any], idempotency_key: str
    ) -> CanvasToolResult[Any]:
        try:
            return await self._call(name, arguments)
        except Exception as error:
            # No result means no durable-outcome proof. Keep the exact cause,
            # caller key and a safe message; never generate a key or replay.
            # Task cancellation propagates normally and can also leave an
            # unknown outcome; retain the caller key before awaiting any write.
            raise CanvasMutationOutcomeUnknown(name, idempotency_key) from error

    async def list_workspaces(self) -> CanvasToolResult[dict[str, Any]]:
        return await self._call("list_workspaces", {})

    async def get_workspace_overview(
        self, workspace_id: str
    ) -> CanvasToolResult[dict[str, Any]]:
        return await self._call(
            "get_workspace_overview", {"workspace_id": _string(workspace_id, "workspace_id")}
        )

    async def list_tree(
        self,
        workspace_id: str,
        *,
        path: str | None = None,
        max_depth: int = 0,
        max_entries: int = 200,
        cursor: str | None = None,
    ) -> CanvasToolResult[dict[str, Any]]:
        """One bounded tree page; expand folders or follow next_cursor explicitly."""
        arguments: dict[str, Any] = {
            "workspace_id": _string(workspace_id, "workspace_id"),
            "max_depth": _integer(max_depth, "max_depth", 0, 6),
            "max_entries": _integer(max_entries, "max_entries", 1, 500),
        }
        if path is not None:
            arguments["path"] = _string(path, "path", 4096)
        if cursor is not None:
            arguments["cursor"] = _string(cursor, "cursor", 20000)
        return await self._call("list_knowledge_tree", arguments)

    async def search_documents(
        self,
        workspace_id: str,
        query: str,
        *,
        path: str | None = None,
        max_results: int = 8,
        cursor: str | None = None,
    ) -> CanvasToolResult[DocumentSearchPage]:
        """Native search V1, preserving coverage and scan-window ranking.

        Search returns bounded hits, not full documents or globally certified
        live coverage. Use a hit's documentId and full version for a later read;
        each read independently needs current knowledge:read authority.
        """
        arguments: dict[str, Any] = {
            "api_version": 1,
            "workspace_id": _string(workspace_id, "workspace_id"),
            "query": _string(query, "query", 200),
            "max_results": _integer(max_results, "max_results", 1, 25),
        }
        if path is not None:
            arguments["path"] = _string(path, "path", 4096)
        if cursor is not None:
            arguments["cursor"] = _string(cursor, "cursor", 4096)
        return await self._call("search_knowledge", arguments)

    async def read_page(
        self,
        workspace_id: str,
        document_id: str,
        *,
        format: ReadFormat = "native",
        expected_version: str | None = None,
        max_bytes: int = 65536,
        cursor: str | None = None,
        include_edit_targets: bool = False,
    ) -> CanvasToolResult[DocumentReadPage]:
        """One UTF-8 page by stable ID. Native JSON may be split across pages."""
        if format not in _MEDIA:
            raise ValueError("format must be native, text or markdown.")
        if type(include_edit_targets) is not bool or include_edit_targets and format != "native":
            raise ValueError("include_edit_targets is a boolean available only for native reads.")
        arguments: dict[str, Any] = {
            "workspace_id": _string(workspace_id, "workspace_id"),
            "document_id": _string(document_id, "document_id"),
            "format": format,
            "max_bytes": _integer(max_bytes, "max_bytes", 4, 262144),
        }
        if format == "native":
            arguments["include_edit_targets"] = include_edit_targets
        if expected_version is not None:
            arguments["expected_version"] = _version(expected_version)
        if cursor is not None:
            arguments["cursor"] = _string(cursor, "cursor", 4096)
        return await self._call("read_knowledge_source", arguments)

    async def read_all(
        self,
        workspace_id: str,
        document_id: str,
        *,
        format: ReadFormat = "native",
        expected_version: str | None = None,
        max_bytes: int = 65536,
        include_edit_targets: bool = False,
        max_total_bytes: int = 16 * 1024 * 1024,
        max_pages: int = 4096,
    ) -> CompleteDocument:
        """Explicit complete read, pinned to the first observed full version.

        A conflict, error, repeated cursor, inconsistent byte range or local
        budget stops the read. It never restarts at a newer version and never
        returns partial text as a complete document. All real pages are retained.
        Currency/projection remain in those actual pages, not synthesized here.
        """
        _integer(max_total_bytes, "max_total_bytes", 1, 128 * 1024 * 1024)
        _integer(max_pages, "max_pages", 1, 65536)
        pages: list[CanvasToolResult[DocumentReadPage]] = []
        fragments: list[bytes] = []
        cursor: str | None = None
        seen: set[str] = set()
        selected_version = expected_version
        first: DocumentReadPage | None = None
        offset = 0
        while len(pages) < max_pages:
            result = await self.read_page(
                workspace_id,
                document_id,
                format=format,
                expected_version=selected_version,
                max_bytes=max_bytes,
                cursor=cursor,
                include_edit_targets=include_edit_targets,
            )
            page = result.require_success()
            document = page.get("document")
            version = document.get("version") if isinstance(document, dict) else None
            if (
                type(page.get("apiVersion")) is not int or page["apiVersion"] != 1
                or not isinstance(document, dict)
                or document.get("kind") != "native_document"
                or document.get("workspaceId") != workspace_id
                or document.get("documentId") != document_id
                or not _read_identity_valid(document)
                or not isinstance(version, str) or not _VERSION.fullmatch(version)
                or selected_version is not None and version != selected_version
                or page.get("format") != format or page.get("encoding") != "utf-8"
                or page.get("mediaType") != _MEDIA[format]
                or not _currency_valid(page.get("currency"), version)
                or not _projection_valid(page.get("projection"))
                or not isinstance(page.get("fragment"), str)
                or "nextCursor" not in page
            ):
                raise CanvasProtocolError("READ_ENVELOPE_MISMATCH", result=result.raw)
            try:
                fragment = page["fragment"].encode("utf-8")
            except UnicodeEncodeError:
                raise CanvasProtocolError("READ_FRAGMENT_UTF8_INVALID", result=result.raw) from None
            length, total = page.get("byteLength"), page.get("totalBytes")
            end = offset + len(fragment)
            if (
                type(page.get("byteOffset")) is not int or page["byteOffset"] != offset
                or type(length) is not int or length != len(fragment) or length > max_bytes
                or type(total) is not int or total < 0 or end > total
                or total > max_total_bytes
                or type(page.get("complete")) is not bool
                or page["complete"] != (end == total)
            ):
                raise CanvasProtocolError("READ_RANGE_OR_BUDGET_MISMATCH", result=result.raw)
            if first is None:
                first = page
                selected_version = version
            elif document != first["document"] or total != first["totalBytes"]:
                raise CanvasProtocolError("READ_PAGE_IDENTITY_CHANGED", result=result.raw)
            following = page.get("nextCursor")
            if page["complete"]:
                if following is not None:
                    raise CanvasProtocolError("READ_COMPLETE_WITH_CURSOR", result=result.raw)
            elif (
                not fragment or not isinstance(following, str) or len(following) > 4096
                or not _CURSOR.fullmatch(following) or following in seen
            ):
                raise CanvasProtocolError("READ_CURSOR_OR_PROGRESS_INVALID", result=result.raw)
            pages.append(result)
            fragments.append(fragment)
            offset = end
            if page["complete"]:
                return CompleteDocument(
                    body=b"".join(fragments).decode("utf-8"),
                    document=first["document"],
                    format=format,
                    pages=tuple(pages),
                )
            cursor = cast(str, following)
            seen.add(cursor)
        raise CanvasProtocolError("READ_PAGE_BUDGET_EXCEEDED", result=pages[-1].raw)

    async def create_markdown(
        self, workspace_id: str, path: str, content: str, *, idempotency_key: str
    ) -> CanvasToolResult[DocumentCreateResult]:
        """Create new native Markdown through Canvas, never overwrite a path."""
        arguments = self._creation_arguments(workspace_id, path, idempotency_key)
        if not isinstance(content, str):
            raise ValueError("content must be the complete Markdown text.")
        try:
            if len(content.encode("utf-8")) > 512 * 1024:
                raise ValueError
        except (ValueError, UnicodeEncodeError):
            raise ValueError("content must be complete UTF-8 Markdown of at most 512 KiB.") from None
        arguments["content"] = content
        return await self._mutate("create_knowledge_source", arguments, idempotency_key)

    async def import_markdown(
        self, workspace_id: str, path: str, file: FileReference, *, idempotency_key: str
    ) -> CanvasToolResult[DocumentCreateResult]:
        """Import a host-issued HTTPS file reference as a new native Markdown doc.

        This does not upload local paths, parse PDF or manufacture a download
        URL. The caller supplies the real host file reference; Canvas imports it.
        """
        arguments = self._creation_arguments(workspace_id, path, idempotency_key)
        arguments["file"] = _json_object(file, "file")
        return await self._mutate("import_knowledge_file", arguments, idempotency_key)

    @staticmethod
    def _creation_arguments(workspace_id: str, path: str, idempotency_key: str) -> dict[str, Any]:
        _string(path, "path", 1024)
        if not path.lower().endswith((".md", ".markdown")):
            raise ValueError("Native creation V1 requires a .md or .markdown destination.")
        return {
            "api_version": 1,
            "workspace_id": _string(workspace_id, "workspace_id", 200),
            "path": path,
            "idempotency_key": _key(idempotency_key),
        }

    async def edit_document(
        self,
        workspace_id: str,
        document_id: str,
        *,
        expected_version: str,
        idempotency_key: str,
        patch: Mapping[str, Any],
    ) -> CanvasToolResult[DocumentEditResult]:
        """One native Edit call. Nested Canvas patch keys stay camelCase.

        For native_blocks, use exact IDs/guards from an explicit native read
        with include_edit_targets=True. Only state=confirmed with confirmed
        persistence is a successful durable edit. Poll edit_status explicitly
        for an issued operationId; never infer success from a transport ACK.
        """
        arguments = {
            "api_version": 1,
            "action": "edit",
            "workspace_id": _string(workspace_id, "workspace_id"),
            "document_id": _string(document_id, "document_id"),
            "expected_version": _version(expected_version),
            "idempotency_key": _key(idempotency_key),
            "patch": _json_object(patch, "patch"),
        }
        return await self._mutate("edit_knowledge_source", arguments, idempotency_key)

    async def edit_status(
        self, workspace_id: str, operation_id: str
    ) -> CanvasToolResult[DocumentEditResult]:
        """Observe historical status under the same current Write/owner policy.

        Historical After is not the current document version. This call does
        not reconcile, apply, accept a review or automatically repeat a write.
        """
        if not isinstance(operation_id, str) or not _OPERATION.fullmatch(operation_id):
            raise ValueError("operation_id must be a bounded Canvas operation identifier.")
        return await self._call("edit_knowledge_source", {
            "api_version": 1,
            "action": "status",
            "workspace_id": _string(workspace_id, "workspace_id"),
            "operation_id": operation_id,
        })
