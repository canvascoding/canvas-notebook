import type { NativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { WorkspaceLinkDocument } from './workspace-link-index-core';
import type { WorkspaceLinkResolveStatusV1, WorkspaceLinkSyntaxV1 } from './workspace-link-contract-v1';

/** Native recipes are distinct from v1's Markdown offsets and whole-file hashes. */
export const WORKSPACE_NATIVE_LINK_CONTRACT_VERSION = 2 as const;

export type NativeLinkDocumentIdentity = Pick<NativeCollaborationSnapshot,
  'documentId' | 'workspaceId' | 'organizationId' | 'path' | 'lifecycleGeneration' | 'representation' | 'schemaVersion'>;

export type NativeLinkTextReference = {
  blockId: string | null;
  startAnchor: string;
  endAnchor: string;
};

export type NativeLinkReference =
  | { kind: 'plain-target'; text: NativeLinkTextReference; expected: string;
      syntaxText: NativeLinkTextReference; syntaxStart: number; syntaxEnd: number;
      targetStart: number; targetEnd: number; raw: string }
  | { kind: 'link-mark'; text: NativeLinkTextReference; expected: Record<string, unknown> }
  | { kind: 'node-attribute'; ownerBlockId: string | null; nodeId: string;
      attribute: 'target' | 'src'; expected: string; membershipAnchor: string | null };

export type NativeLinkCoverageGap = {
  code: 'unknown-node' | 'unknown-mark' | 'unknown-attribute' | 'invalid-target' | 'unsupported-target'
    | 'invalid-frontmatter' | 'limit-exceeded' | 'unreadable-source' | 'uninitialized-source'
    | 'identity-conflict' | 'uninspected-html' | 'unsupported-source';
  path: string;
  nodeId?: string;
  attribute?: string;
  raw?: string;
  htmlTargets?: string[];
};

export type NativeDocumentLink = {
  id: string;
  kind: 'wiki' | 'markdown';
  syntax: WorkspaceLinkSyntaxV1;
  literal: string;
  targetPathText: string;
  fragment: string | null;
  alias: string | null;
  embed: boolean;
  classification: 'local' | 'external' | 'anchor-only';
  ref: NativeLinkReference;
  /** Only for a fresh clone: pick from its newly proven inventory after mapping
   * semantic node IDs. Source relative positions are never reused in the clone. */
  cloneLocator: { ownerBlockId: string | null; nodeId: string | null; ordinal: number };
};

export type NativeDocumentLinkInventory = {
  contractVersion: 2;
  document: NativeLinkDocumentIdentity;
  version: NativeCollaborationSnapshot['version'];
  parserVersion: 1;
  metadata: WorkspaceLinkDocument;
  links: NativeDocumentLink[];
  coverage: { complete: boolean; gaps: NativeLinkCoverageGap[] };
};

export type NativeNamespaceEntry = {
  workspaceId: string;
  path: string;
  kind: 'file' | 'directory';
  /** A document identity and an optional projection identity are independent. */
  identity: string;
  documentId: string | null;
  lifecycleGeneration: number | null;
  filesystemIdentity: string | null;
};

export type NativeWorkspaceLinkSnapshot = {
  contractVersion: 2;
  workspaceId: string;
  namespace: NativeNamespaceEntry[];
  documents: NativeDocumentLinkInventory[];
  coverage: { complete: boolean; gaps: NativeLinkCoverageGap[] };
  snapshotProof: string;
};

export type NativeResolvedLink = NativeDocumentLink & {
  source: NativeLinkDocumentIdentity;
  resolution: {
    status: WorkspaceLinkResolveStatusV1;
    target: NativeNamespaceEntry | null;
    candidates: NativeNamespaceEntry[];
  };
};

export type NativeWorkspaceLinkGraph = {
  contractVersion: 2;
  workspaceId: string;
  snapshotProof: string;
  namespace: NativeNamespaceEntry[];
  documents: NativeDocumentLinkInventory[];
  edges: NativeResolvedLink[];
  coverage: NativeWorkspaceLinkSnapshot['coverage'];
};

export type NativeLinkMutationRecipe = {
  linkId: string;
  source: NativeLinkDocumentIdentity;
  destinationWorkspaceId: string;
  sourcePathAfter: string;
  /** Copy requires the clone receipt to rebind source anchors to its new IDs. */
  cloneSelection: string | null;
  sourceVersion: NativeCollaborationSnapshot['version'];
  reference: NativeLinkReference;
  action: 'rewrite' | 'unlink';
  nextValue: string | null;
  expectedTargetIdentity: string;
};

export type NativeWorkspaceFileOperationPlan = {
  contractVersion: 2;
  planId: string;
  kind: 'rename' | 'move' | 'copy' | 'delete';
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  snapshotProofs: Array<{ workspaceId: string; proof: string }>;
  pathMappings: Array<{ source: NativeNamespaceEntry; destinationPath: string; destinationWorkspaceId: string }>;
  mutations: NativeLinkMutationRecipe[];
  readiness: 'ready' | 'blocked';
  issues: Array<{ code: string; workspaceId: string; path: string; linkId?: string }>;
};
