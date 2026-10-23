import type { WorkspaceLinkCoverageV1 } from './workspace-link-contract-v1';
import type { WorkspaceLinkDocument, WorkspaceLinkEdge } from './workspace-link-index-core';
import type { WorkspaceLinkUnevaluated } from './workspace-local-link-parser';

/** Semantic read data cannot be passed to an offset-based Markdown writer. */
export type WorkspaceLinkReadEdge = Readonly<Pick<WorkspaceLinkEdge,
  'id' | 'kind' | 'syntax' | 'sourcePath' | 'targetLiteral' | 'targetText'
  | 'alias' | 'embed' | 'heading' | 'blockId' | 'candidates' | 'status' | 'targetPath'>> & {
  /** Real physical source context only; never a position in a native projection. */
  sourcePreview?: { kind: 'physical-markdown'; focusOffset: number };
};

/** The structural reader contract also accepts the legacy physical index.
 * Mutation ranges are deliberately absent from the fields readers can use. */
export type WorkspaceLinkReadIndex = {
  backlinks: Record<string, WorkspaceLinkReadEdge[]>;
  brokenLinks: WorkspaceLinkReadEdge[];
  documents: WorkspaceDocumentLinkDocument[];
  edges: WorkspaceLinkReadEdge[];
  generatedAt: string;
  targetPaths: string[];
  coverage: WorkspaceLinkCoverageV1;
  omittedDocuments: Array<{ path: string; reason: 'too-large' | 'unreadable' }>;
  unevaluatedLinks?: Array<Pick<WorkspaceLinkUnevaluated, 'sourcePath' | 'reason'>>;
};

export type WorkspaceDocumentLinkDocument = WorkspaceLinkDocument & {
  nativeIdentity?: { documentId: string; lifecycleGeneration: number };
};

export type WorkspaceDocumentLinkIndex = WorkspaceLinkReadIndex & {
  indexVersion: 2;
  workspaceId: string;
  documents: WorkspaceDocumentLinkDocument[];
  /** Includes global observation failures whose path is the empty string. */
  gaps: Array<{ code: string; path: string }>;
};
