/**
 * Workspace file link and operation contract, version 1.
 *
 * Paths are slash-separated, workspace-relative file paths. Source offsets use
 * UTF-16 code units (JavaScript string offsets) and UTF-8 bytes, with an
 * exclusive end. A target range excludes Markdown delimiters, an optional
 * angle-bracket wrapper, a reference label, and a Wiki display alias.
 *
 * This module describes the intended result; execution is introduced by the
 * subsequent workspace-link implementation stages.
 */
export const WORKSPACE_LINK_CONTRACT_VERSION_V1 = 1 as const;

export type WorkspaceLinkSyntaxV1 =
  | 'inline-link'
  | 'inline-image'
  | 'reference-link'
  | 'reference-image'
  | 'reference-definition'
  | 'wiki-link'
  | 'wiki-embed';

export type WorkspaceLinkParseStatusV1 =
  | 'parsed'
  | 'ignored'
  | 'not-evaluated'
  | 'omitted';

export type WorkspaceLinkResolveStatusV1 =
  | 'resolved'
  | 'missing'
  | 'ambiguous'
  | 'outside-workspace'
  | 'external'
  | 'anchor-only'
  | 'not-evaluated'
  | 'omitted';

export type WorkspaceLinkRewriteStatusV1 =
  | 'rewrite'
  | 'unchanged'
  | 'blocked'
  | 'not-applicable';

export type WorkspaceLinkOmissionReasonV1 =
  | 'source-too-large'
  | 'source-unreadable'
  | 'target-unreadable'
  | 'permission-denied';

export type WorkspaceLinkTargetRangeV1 = {
  startUtf16: number;
  endUtf16: number;
  startUtf8Byte: number;
  endUtf8Byte: number;
};

export type WorkspaceLocalLinkV1 = {
  contractVersion: typeof WORKSPACE_LINK_CONTRACT_VERSION_V1;
  syntax: WorkspaceLinkSyntaxV1;
  sourcePath: string;
  /** Original, unmodified target spelling, including any fragment. */
  targetLiteral: string;
  /** Decoded file path; empty for a same-document fragment. */
  targetPathText: string;
  /** Original fragment spelling without '#'; null when absent. */
  fragment: string | null;
  targetRange: WorkspaceLinkTargetRangeV1;
  /** Reference usages point to the single definition that owns the target. */
  definitionId: string | null;
  resolution: {
    status: WorkspaceLinkResolveStatusV1;
    targetPath: string | null;
    candidatePaths: string[];
  };
};

export type WorkspaceLinkCoverageV1 = {
  complete: boolean;
  /** Every path that was not inspected must be reported, including >4 MiB Markdown. */
  omittedSources: Array<{ path: string; reason: WorkspaceLinkOmissionReasonV1 }>;
  unresolvedLinks: Array<{
    sourcePath: string;
    targetLiteral: string;
    status: Exclude<WorkspaceLinkResolveStatusV1, 'resolved'>;
  }>;
};

export type WorkspaceFileOperationKindV1 =
  | 'rename'
  | 'move'
  | 'copy'
  | 'overwrite'
  | 'delete';

export type WorkspaceFileOperationStatusV1 =
  | 'planned'
  | 'applying'
  | 'complete'
  | 'needs_recovery'
  | 'failed';

export type WorkspaceFilePathMappingV1 = {
  sourceWorkspaceId: string;
  sourcePath: string;
  destinationWorkspaceId: string;
  destinationPath: string;
  /** Stable identity established before mutation; path text alone is insufficient. */
  sourceIdentity: string;
};

export type WorkspaceFileLinkEditV1 = {
  /** Workspace of the original bytes/hash used as the version precondition. */
  sourceWorkspaceId: string;
  /** Workspace that receives the rewritten bytes (differs for cross-workspace copy). */
  destinationWorkspaceId: string;
  sourcePathBefore: string;
  sourcePathAfter: string;
  expectedContentHash: string;
  targetRange: WorkspaceLinkTargetRangeV1;
  previousTargetLiteral: string;
  nextTargetLiteral: string;
};

export type WorkspaceFileOperationPlanV1 = {
  contractVersion: typeof WORKSPACE_LINK_CONTRACT_VERSION_V1;
  planId: string;
  kind: WorkspaceFileOperationKindV1;
  status: 'planned';
  pathMappings: WorkspaceFilePathMappingV1[];
  linkEdits: WorkspaceFileLinkEditV1[];
  coverage: WorkspaceLinkCoverageV1;
  /** Apply must verify every source and destination again under ordered locks. */
  expectedPathState: Array<{
    workspaceId: string;
    path: string;
    identity: string | null;
    contentHash: string | null;
  }>;
  collisions: Array<{ workspaceId: string; path: string }>;
  recoveryReady: boolean;
};

/**
 * Exact relative resolution applies to Markdown links and images. Workspace
 * root paths start with '/'. Only Wiki syntax may use the Obsidian
 * path/title/alias lookup, and only a unique hit may be rewritten. External
 * schemes, pure anchors, code, and unevaluated HTML never become local edits.
 */
export const WORKSPACE_LINK_RESOLUTION_RULES_V1 = Object.freeze({
  markdown: 'exact-relative-or-workspace-root',
  wiki: 'unique-obsidian-candidate',
  outsideWorkspace: 'block',
  unresolved: 'block',
  incompleteIndex: 'report-and-never-claim-complete',
} as const);

/**
 * A move maps both source and target identities; a copy preserves originals
 * and maps links inside the copied group to copied identities. Cross-workspace
 * references to uncopied targets remain unresolved. No operation may claim
 * recovery support unless its prior contents have a restorable copy.
 */
export const WORKSPACE_FILE_OPERATION_RULES_V1 = Object.freeze({
  move: 'map-source-and-target-identities',
  copy: 'preserve-originals-and-map-copied-identities',
  crossWorkspaceCopy: 'never-bind-uncopied-target-by-name',
  stalePlan: 'reject-before-write',
  recovery: 'secure-prior-content-before-destructive-write',
} as const);
