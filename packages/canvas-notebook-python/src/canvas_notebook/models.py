"""Wire DTOs retain Canvas field spelling; no naming or content conversion."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Literal, Mapping, Protocol, Sequence, TypeVar, TypedDict, cast

from .errors import CanvasProtocolError, CanvasToolError

ReadFormat = Literal["native", "text", "markdown"]
PayloadT = TypeVar("PayloadT", bound=Mapping[str, Any])


class ToolResultLike(Protocol):
    """Structural result boundary, without importing OAuth or an MCP runtime."""

    @property
    def structured_content(self) -> dict[str, Any] | None: ...

    @property
    def content(self) -> Sequence[Any]: ...

    @property
    def is_error(self) -> bool: ...


class ToolTransport(Protocol):
    async def call_tool(
        self, name: str, arguments: Mapping[str, Any]
    ) -> ToolResultLike: ...


class DocumentIdentity(TypedDict):
    kind: Literal["native_document"]
    workspaceId: str
    organizationId: str | None
    documentId: str
    lineageId: str
    lifecycleGeneration: int
    representation: Literal["plain_text", "tiptap_xml", "tiptap_blocks"]
    schemaVersion: int


class DocumentRef(DocumentIdentity):
    path: str
    title: str
    version: str
    metadataVersion: str


class DocumentCurrency(TypedDict):
    source: Literal["persisted_yjs", "live_yjs"]
    observedVersion: str
    observedDurable: bool
    durableVersion: str
    durableSequence: int
    persistedAt: int


class DocumentProjectionRequired(TypedDict):
    checkpointSequence: int
    checkpointedAt: int | None
    status: Literal["current", "pending", "unavailable"]


class DocumentProjection(DocumentProjectionRequired, total=False):
    errorCode: str


class DocumentReadPage(TypedDict):
    apiVersion: Literal[1]
    document: DocumentRef
    currency: DocumentCurrency
    projection: DocumentProjection
    format: ReadFormat
    mediaType: str
    encoding: Literal["utf-8"]
    fragment: str
    byteOffset: int
    byteLength: int
    totalBytes: int
    nextCursor: str | None
    complete: bool


class SearchHit(TypedDict):
    document: DocumentRef
    currency: DocumentCurrency
    matchedIn: list[Literal["title", "path", "content"]]
    snippet: str


class SearchCoverage(TypedDict):
    corpus: Literal["visible_initialized_native_yjs"]
    candidateOrder: Literal["metadata_priority_path_id_v1"]
    ranking: Literal["within_scan_window"]
    membershipCheckedBeforeAndAfter: Literal[True]
    candidateCount: int
    windowStart: int
    windowEnd: int
    inspected: int
    matched: int
    returned: int
    excludedInWindow: dict[str, int]
    pristineExcluded: int
    localLive: Literal["verified", "unknown"]
    remoteLive: Literal["unknown"]
    globalCurrentContent: Literal["not_certified"]
    moreWindowHits: bool
    moreCandidates: bool


class DocumentSearchPage(TypedDict):
    apiVersion: Literal[1]
    workspaceId: str
    query: str
    scopePath: str
    hits: list[SearchHit]
    nextCursor: str | None
    coverage: SearchCoverage


class DocumentCreateResult(TypedDict):
    apiVersion: Literal[1]
    operationId: str
    outcome: Literal["created", "already_created"]
    document: DocumentRef
    currency: DocumentCurrency
    projection: DocumentProjection


class EditEffect(TypedDict):
    outcome: Literal["applied", "no_change"]
    beforeVersion: str
    afterVersion: str
    appliedAt: int


class EditPersistence(TypedDict):
    status: Literal["confirmed", "unconfirmed"]
    confirmedInSequence: int | None
    confirmedAt: int | None


class EditProjection(TypedDict):
    status: Literal["checkpointed", "unconfirmed"]
    checkpointedAt: int | None
    revisionId: str | None


class EditHistory(TypedDict):
    status: Literal["captured", "unconfirmed", "over_limit"]
    revisionId: str | None


class DocumentEditResult(TypedDict):
    apiVersion: Literal[1]
    operationId: str
    state: Literal["pending", "confirmed", "conflict", "failed"]
    document: DocumentIdentity
    effect: EditEffect | None
    persistence: EditPersistence
    projection: EditProjection
    history: EditHistory


class FileReferenceRequired(TypedDict):
    download_url: str
    file_id: str


class FileReference(FileReferenceRequired, total=False):
    mime_type: str
    file_name: str


@dataclass(frozen=True, repr=False)
class CanvasToolResult(Generic[PayloadT]):
    """Retains the complete official MCP result, including tool failures.

    TypedDict annotations are documentation, not a substitute for server
    validation. ``require_success`` checks the error envelope only; an Edit
    result can still have state pending/conflict/failed and unconfirmed storage.
    Inspect state/persistence explicitly before claiming a durable edit.
    """

    tool_name: str
    raw: ToolResultLike

    @property
    def structured_content(self) -> dict[str, Any] | None:
        return self.raw.structured_content

    @property
    def content(self) -> Any:
        return self.raw.content

    @property
    def is_error(self) -> bool:
        return self.raw.is_error

    def require_success(self) -> PayloadT:
        payload = self.structured_content
        if self.is_error or isinstance(payload, dict) and payload.get("success") is False:
            raise CanvasToolError(self.tool_name, self.raw)
        if not isinstance(payload, dict):
            raise CanvasProtocolError("STRUCTURED_CONTENT_REQUIRED", result=self.raw)
        return cast(PayloadT, payload)


@dataclass(frozen=True, repr=False)
class CompleteDocument:
    """Local complete body plus every original version-bound page.

    This is not a fabricated server page or a claim of current durable state.
    Native JSON is parseable only after all UTF-8 fragments are assembled.
    """

    body: str
    document: DocumentRef
    format: ReadFormat
    pages: tuple[CanvasToolResult[DocumentReadPage], ...]
