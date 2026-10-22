"""Wire DTOs retain Canvas field spelling; no naming or content conversion."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Literal, Mapping, NoReturn, Protocol, Sequence, TypeVar, TypedDict, cast

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


PublicCopyCode = Literal[
    "INVALID_REQUEST", "AUTHENTICATION_REQUIRED", "ACCESS_DENIED",
    "COPY_OPERATION_NOT_FOUND", "COPY_STATUS_NOT_FOUND", "COPY_PLAN_CHANGED",
    "COPY_SCOPE_CHANGED", "COPY_BUSY", "COPY_CONFLICT", "COPY_TOO_LARGE",
    "COPY_OUTPUT_TOO_LARGE", "COPY_NATIVE_REQUIRED", "COPY_OUTCOME_UNCONFIRMED",
    "COPY_UNAVAILABLE",
]
WorkspaceCopyLinkStatus = Literal[
    "missing", "ambiguous", "outside-workspace", "external", "anchor-only",
    "not-evaluated", "omitted",
]


class WorkspaceCopySelection(TypedDict):
    source_path: str
    destination_path: str


class WorkspaceCopyPathMapping(TypedDict):
    """Preview paths and UI deduplication value, never a native ID or grant."""

    sourceWorkspaceId: str
    sourcePath: str
    destinationWorkspaceId: str
    destinationPath: str
    sourceKind: Literal["file", "directory"]
    sourceIdentity: str


class WorkspaceCopyLinkEdit(TypedDict):
    sourcePathBefore: str
    sourcePathAfter: str
    previousTargetLiteral: str
    nextTargetLiteral: str


class WorkspaceCopyUnresolvedLink(TypedDict):
    sourcePath: str
    targetLiteral: str
    status: WorkspaceCopyLinkStatus


class WorkspaceCopyCoverage(TypedDict):
    complete: bool
    omittedSources: list[NoReturn]
    unresolvedLinks: list[WorkspaceCopyUnresolvedLink]


class WorkspaceCopyLinkWarning(WorkspaceCopyUnresolvedLink):
    workspaceId: str
    reason: Literal["unaffected-existing-link"]


class WorkspaceCopyLinkAssessment(TypedDict):
    version: Literal[1]
    complete: bool
    warnings: list[WorkspaceCopyLinkWarning]
    blockers: list[NoReturn]


class WorkspaceCopyPreview(TypedDict):
    version: Literal[4]
    kind: Literal["native-copy"]
    sourceWorkspaceId: str
    destinationWorkspaceId: str
    planId: str
    readiness: Literal["ready"]
    pathMappings: list[WorkspaceCopyPathMapping]
    linkEdits: list[WorkspaceCopyLinkEdit]
    coverage: WorkspaceCopyCoverage
    linkAssessment: WorkspaceCopyLinkAssessment
    issues: list[NoReturn]


class WorkspaceCopyHtmlLinkWarning(TypedDict):
    workspaceId: str
    sourcePath: str
    targetLiteral: str
    status: Literal["not-evaluated"]
    reason: Literal["unaffected-explicit-html-link"]
    htmlTargets: list[str]


class WorkspaceCopyHtmlLinkAssessment(TypedDict):
    version: Literal[1]
    complete: Literal[True]
    warnings: list[WorkspaceCopyLinkWarning | WorkspaceCopyHtmlLinkWarning]
    blockers: list[NoReturn]


class WorkspaceCopySourceCoverageGap(TypedDict):
    code: str
    path: str


class WorkspaceCopyOriginalSourceCoverage(TypedDict):
    complete: bool
    gaps: list[WorkspaceCopySourceCoverageGap]


class WorkspaceCopySourceCoverage(TypedDict):
    workspaceId: str
    coverage: WorkspaceCopyOriginalSourceCoverage


class WorkspaceCopyHtmlPreviewV5(TypedDict):
    version: Literal[5]
    kind: Literal["native-copy"]
    sourceWorkspaceId: str
    destinationWorkspaceId: str
    planId: str
    readiness: Literal["ready"]
    pathMappings: list[WorkspaceCopyPathMapping]
    linkEdits: list[WorkspaceCopyLinkEdit]
    coverage: WorkspaceCopyCoverage
    linkAssessment: WorkspaceCopyHtmlLinkAssessment
    sourceCoverage: list[WorkspaceCopySourceCoverage]
    issues: list[NoReturn]


class WorkspaceCopyRawImportLinkTarget(TypedDict):
    sourcePathBefore: str
    sourcePathAfter: str
    previousTargetLiteral: str
    targetPathAfter: str
    fragment: str | None
    alias: str | None
    embed: bool


class WorkspaceCopyRawImportLinkBindings(TypedDict):
    status: Literal["requires-native-import-rebinding"]
    targets: list[WorkspaceCopyRawImportLinkTarget]


class WorkspaceCopyRawHtmlPreviewV6(TypedDict):
    """C1 display facts, including truthful gaps and future native rebinding.

    These fields are neither an import receipt nor permission to execute.
    """

    version: Literal[6]
    kind: Literal["native-copy"]
    sourceWorkspaceId: str
    destinationWorkspaceId: str
    planId: str
    readiness: Literal["ready"]
    pathMappings: list[WorkspaceCopyPathMapping]
    linkEdits: list[WorkspaceCopyLinkEdit]
    coverage: WorkspaceCopyCoverage
    linkAssessment: WorkspaceCopyHtmlLinkAssessment
    sourceCoverage: list[WorkspaceCopySourceCoverage]
    importLinkBindings: WorkspaceCopyRawImportLinkBindings
    issues: list[NoReturn]


class WorkspaceCopyPreviewResult(TypedDict):
    apiVersion: Literal[1]
    action: Literal["preview"]
    preview: WorkspaceCopyPreview | WorkspaceCopyHtmlPreviewV5 | WorkspaceCopyRawHtmlPreviewV6


class WorkspaceCopyExecution(TypedDict):
    operationId: str
    planId: str
    status: Literal["complete", "needs_recovery", "failed"]
    completedSteps: list[str]
    pendingSteps: list[str]
    errorCode: PublicCopyCode | None


class WorkspaceCopyExecutionResult(TypedDict):
    apiVersion: Literal[1]
    action: Literal["apply", "recover"]
    execution: WorkspaceCopyExecution
    copied: list[str]
    alreadyKnown: bool


class WorkspaceCopyJournal(TypedDict):
    status: Literal["prepared", "running", "completed", "failed", "recovery_required"]
    phase: Literal["prepared", "path", "link", "completed"]
    expectedStepCount: int
    recordedStepCount: int
    appliedStepCount: int
    intentStepCount: int
    createdAt: int
    updatedAt: int
    errorCode: PublicCopyCode | None


class WorkspaceCopyConfirmedCompletion(TypedDict):
    status: Literal["confirmed"]
    historical: Literal[True]
    copiedPaths: list[str]


class WorkspaceCopyUnconfirmedCompletion(TypedDict):
    status: Literal["not_confirmed"]


class WorkspaceCopyOperation(TypedDict):
    operationId: str
    planId: str
    revision: int
    journal: WorkspaceCopyJournal
    completion: WorkspaceCopyConfirmedCompletion | WorkspaceCopyUnconfirmedCompletion


class WorkspaceCopyStatusResult(TypedDict):
    apiVersion: Literal[1]
    action: Literal["status"]
    operation: WorkspaceCopyOperation


class WorkspaceCopyFailureRequired(TypedDict):
    apiVersion: Literal[1]
    success: Literal[False]
    code: PublicCopyCode


class WorkspaceCopyFailure(WorkspaceCopyFailureRequired, total=False):
    operationId: str


PublicWorkspacePathCode = Literal[
    "INVALID_REQUEST", "AUTHENTICATION_REQUIRED", "ACCESS_DENIED",
    "PATH_OPERATION_NOT_FOUND", "PATH_STATUS_NOT_FOUND", "PATH_PLAN_CHANGED",
    "PATH_SCOPE_CHANGED", "PATH_BUSY", "PATH_CONFLICT", "PATH_TOO_LARGE",
    "PATH_OUTPUT_TOO_LARGE", "PATH_NATIVE_REQUIRED", "PATH_OUTCOME_UNCONFIRMED",
    "PATH_UNAVAILABLE",
]


class WorkspaceMoveSelection(TypedDict):
    source_path: str
    destination_path: str


class WorkspaceMovePreviewPath(TypedDict):
    sourcePath: str
    destinationPath: str


class WorkspaceDeletePreviewPath(TypedDict):
    sourcePath: str


class WorkspacePathLinkChanges(TypedDict):
    rewrites: int
    unlinks: int
    affectedDocuments: int


class WorkspacePathCoverage(TypedDict):
    complete: Literal[True]


class WorkspaceMovePreview(TypedDict):
    kind: Literal["move"]
    workspaceId: str
    planId: str
    readiness: Literal["ready"]
    paths: list[WorkspaceMovePreviewPath]
    linkChanges: WorkspacePathLinkChanges
    coverage: WorkspacePathCoverage


class WorkspaceDeletePreview(TypedDict):
    kind: Literal["delete"]
    workspaceId: str
    planId: str
    readiness: Literal["ready"]
    paths: list[WorkspaceDeletePreviewPath]
    linkChanges: WorkspacePathLinkChanges
    coverage: WorkspacePathCoverage


class WorkspacePathImportRequirement(TypedDict):
    path: str
    reasons: list[Literal["selected", "link-change"]]


class WorkspacePathImportIssue(TypedDict):
    code: str
    path: str


class WorkspacePathImportPreviewRequired(TypedDict):
    """Read-only preparation facts, never a ready native plan or import receipt."""

    version: Literal[1]
    kind: Literal["native-path-import-preparation"]
    workspaceId: str
    planId: str
    executionReady: Literal[False]
    readiness: Literal["requires-import-rebinding", "blocked"]
    imports: list[WorkspacePathImportRequirement]
    issues: list[WorkspacePathImportIssue]
    coverage: WorkspacePathCoverage


class WorkspaceMoveImportPreview(WorkspacePathImportPreviewRequired):
    operationKind: Literal["move"]
    paths: list[WorkspaceMovePreviewPath]


class WorkspaceDeleteImportPreview(WorkspacePathImportPreviewRequired):
    operationKind: Literal["delete"]
    paths: list[WorkspaceDeletePreviewPath]


class WorkspacePathHtmlCoverage(TypedDict):
    """Original source coverage; separate from operation-specific HTML safety."""

    complete: bool


class WorkspacePathHtmlDiagnosticOptional(TypedDict, total=False):
    line: int


class WorkspacePathHtmlWarning(WorkspacePathHtmlDiagnosticOptional):
    code: Literal["unaffected-explicit-html-link"]
    path: str
    targets: list[str]


class WorkspacePathHtmlBlocker(WorkspacePathHtmlDiagnosticOptional):
    code: Literal["affected-html-link", "unevaluated-link"]
    path: str
    targets: list[str]


class WorkspacePathHtmlLinkAssessment(TypedDict):
    complete: bool
    warnings: list[WorkspacePathHtmlWarning]
    blockers: list[WorkspacePathHtmlBlocker]


class WorkspaceDeleteHtmlLinkChanges(TypedDict):
    rewrites: Literal[0]
    unlinks: int
    affectedDocuments: int


class WorkspaceDeleteHtmlPreviewV3(TypedDict):
    """Public Delete3 comparison facts, without source bytes or execution rights.

    The server enforces one source path, finite counts and readiness consistency.
    executionReady stays false even when the HTML assessment is ready.
    """

    version: Literal[3]
    kind: Literal["native-path-html-assessment"]
    operationKind: Literal["delete"]
    executionReady: Literal[False]
    readiness: Literal["ready", "blocked"]
    workspaceId: str
    planId: str
    paths: list[WorkspaceDeletePreviewPath]
    linkChanges: WorkspaceDeleteHtmlLinkChanges
    coverage: WorkspacePathHtmlCoverage
    linkAssessment: WorkspacePathHtmlLinkAssessment
    issues: list[WorkspacePathImportIssue]
    imports: list[WorkspacePathImportRequirement]


class WorkspacePathHtmlImportWarningV4(WorkspacePathHtmlDiagnosticOptional):
    code: Literal["unaffected-existing-link", "unaffected-explicit-html-link"]
    path: str
    targets: list[str]


class WorkspacePathHtmlImportBlockerV4(WorkspacePathHtmlDiagnosticOptional):
    code: Literal["affected-unresolved-link", "uninspected-source", "unevaluated-link", "affected-html-link", "resolution-changed"]
    path: str
    targets: list[str]


class WorkspacePathHtmlImportLinkAssessmentV4(TypedDict):
    complete: bool
    warnings: list[WorkspacePathHtmlImportWarningV4]
    blockers: list[WorkspacePathHtmlImportBlockerV4]


class WorkspacePathHtmlImportPreviewRequiredV4(TypedDict):
    """MCP C1 preparation, distinct from both Import1 and the Web Path4 DTO."""

    version: Literal[4]
    kind: Literal["native-path-import-preparation"]
    workspaceId: str
    planId: str
    executionReady: Literal[False]
    readiness: Literal["requires-import-rebinding", "blocked"]
    imports: list[WorkspacePathImportRequirement]
    issues: list[WorkspacePathImportIssue]
    coverage: WorkspacePathHtmlCoverage
    linkAssessment: WorkspacePathHtmlImportLinkAssessmentV4


class WorkspaceMoveHtmlImportPreviewV4(WorkspacePathHtmlImportPreviewRequiredV4):
    operationKind: Literal["move"]
    paths: list[WorkspaceMovePreviewPath]


class WorkspaceDeleteHtmlImportPreviewV4(WorkspacePathHtmlImportPreviewRequiredV4):
    operationKind: Literal["delete"]
    paths: list[WorkspaceDeletePreviewPath]


class WorkspaceMovePreviewResult(TypedDict):
    apiVersion: Literal[1]
    action: Literal["preview"]
    preview: WorkspaceMovePreview | WorkspaceMoveImportPreview | WorkspaceMoveHtmlImportPreviewV4


class WorkspaceDeletePreviewResult(TypedDict):
    apiVersion: Literal[1]
    action: Literal["preview"]
    preview: WorkspaceDeletePreview | WorkspaceDeleteImportPreview | WorkspaceDeleteHtmlPreviewV3 | WorkspaceDeleteHtmlImportPreviewV4


class WorkspacePathJournal(TypedDict):
    status: Literal["applying", "applied", "failed", "needs_recovery"]
    phase: Literal["preparing", "paths", "links", "complete", "recovery"]
    completedActions: int
    totalActions: int
    createdAt: int
    updatedAt: int
    errorCode: PublicWorkspacePathCode | None


class WorkspacePathStepRequired(TypedDict):
    key: str
    phase: Literal["path", "link"]
    kind: Literal["move", "rename", "delete", "link_update"]
    path: str
    state: Literal["pending", "applied", "needs_check"]


class WorkspacePathStep(WorkspacePathStepRequired, total=False):
    destinationPath: str
    openPath: str


class WorkspacePathExecution(TypedDict):
    receiptStatus: Literal["available", "not_started", "unavailable"]
    finalization: Literal["pending", "complete"]
    steps: list[WorkspacePathStep]


class WorkspacePathConfirmedCompletion(TypedDict):
    status: Literal["confirmed"]
    historical: Literal[True]


class WorkspacePathUnconfirmedCompletion(TypedDict):
    status: Literal["not_confirmed"]


class WorkspacePathPreparation(TypedDict):
    """Original preview mapping already checked by the server, not SDK authority."""

    version: Literal[1]
    previewPlanId: str


class WorkspacePathOperationOptional(TypedDict, total=False):
    preparation: WorkspacePathPreparation


class WorkspacePathOperation(WorkspacePathOperationOptional):
    operationId: str
    batchId: str
    planId: str
    workspaceId: str
    journal: WorkspacePathJournal
    execution: WorkspacePathExecution
    completion: WorkspacePathConfirmedCompletion | WorkspacePathUnconfirmedCompletion


class WorkspacePathExecutionResult(TypedDict):
    apiVersion: Literal[1]
    action: Literal["apply", "recover"]
    operation: WorkspacePathOperation
    alreadyKnown: bool


class WorkspacePathStatusResult(TypedDict):
    apiVersion: Literal[1]
    action: Literal["status"]
    operation: WorkspacePathOperation


class WorkspacePathFailureRequired(TypedDict):
    apiVersion: Literal[1]
    success: Literal[False]
    code: PublicWorkspacePathCode


class WorkspacePathFailure(WorkspacePathFailureRequired, total=False):
    operationId: str


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
