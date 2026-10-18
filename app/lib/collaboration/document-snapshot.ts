import 'server-only';

import type { JSONContent } from '@tiptap/core';
import type * as YTypes from 'yjs';
import * as decoding from 'lib0/decoding';
import type { WorkspaceContext } from '../workspaces/types';
import { BLOCK_TREE_KEY } from './block-tree';
import { CollaborationCheckpointQuarantinedError, CollaborationCheckpointValidationError } from './checkpoint-errors';
import { readCurrentCollaborationDocument } from './document-access';
import { isCollaborationStateQuarantined } from './failure';
import { validateRichMarkdownStructure } from './markdown-state';
import { readNativeXmlBody } from './native-document-schema';
import type { loadCollaborationState, PersistedCollaborationState } from './persistence';
import { richDocumentFormat } from './rich-document';
import { Y } from './server-runtime';
import { collaborationStateProof } from './state-proof';
import { COLLABORATION_SCHEMA_VERSION } from './types';
import { assertNativeDocumentWithinReadBudget, captureNativeDocumentReadBudget, type NativeDocumentReadBudget } from './native-search-budget';
import { DocumentReadError } from '../documents/contracts';

export type NativeCollaborationContent =
  | { kind: 'plain_text'; text: string }
  | { kind: 'rich_text'; document: JSONContent; frontmatter: string; bodyFinalLineEnding: string };

export type NativeCollaborationVersion = {
  stateVector: string;
  /** Includes deletions and refuses pending, unintegrated updates. */
  stateProof: string;
};

export type NativeCollaborationSnapshot = {
  snapshotVersion: 1;
  source: 'persisted_yjs';
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  lifecycleGeneration: number;
  representation: PersistedCollaborationState['representation'];
  schemaVersion: number;
  version: NativeCollaborationVersion & { documentSequence: number; persistedAt: number };
  projection: {
    checkpointSequence: number;
    checkpointedAt: number | null;
    error?: PersistedCollaborationState['projectionError'];
  };
  content: NativeCollaborationContent;
};

function sharedPlainText(doc: YTypes.Doc, name: string): string {
  try {
    // Hydrated root types start as AbstractType until their declared type is read.
    const text = doc.getText(name);
    if (Object.keys(text.getAttributes()).length
      || text.toDelta().some((part: { insert?: unknown; attributes?: Record<string, unknown> }) =>
        typeof part.insert !== 'string' || Object.keys(part.attributes ?? {}).length)) {
      throw new Error('Unexpected structured content in a plain shared text.');
    }
    return text.toString();
  } catch { throw new CollaborationCheckpointValidationError('schema_invalid'); }
}

/** Native content validation carries no durable clock or persistence assertion. */
export function inspectNativeDocument(doc: YTypes.Doc, representation: PersistedCollaborationState['representation']): {
  version: NativeCollaborationVersion;
  content: NativeCollaborationContent;
} {
  const stateProof = collaborationStateProof(doc, Y);
  if (!stateProof) throw new Error('The collaborative document contains incomplete updates.');
  const stateVector = Buffer.from(Y.encodeStateVector(doc)).toString('base64');
  if (representation === 'plain_text') {
    if ([BLOCK_TREE_KEY, 'body', 'frontmatter', 'bodyFinalLineEnding'].some((name) => doc.share.has(name))) {
      throw new CollaborationCheckpointValidationError('schema_invalid');
    }
    return { version: { stateVector, stateProof }, content: { kind: 'plain_text', text: sharedPlainText(doc, 'content') } };
  }
  // Yjs omits an empty XML fragment even when legal text metadata is persisted.
  // The representation supplies its empty body type; only known Plain metadata
  // roots may survive. Rootless client history has no remaining type evidence,
  // so it cannot be promoted from GC/deletions alone. No root or item is created.
  if (representation === 'tiptap_xml' && !doc.share.has('body')) {
    if ([...doc.share.keys()].some(name => name !== 'frontmatter' && name !== 'bodyFinalLineEnding')
      || doc.share.size === 0 && doc.store.clients.size !== 0) {
      throw new CollaborationCheckpointValidationError('schema_invalid');
    }
    return { version: { stateVector, stateProof }, content: {
      kind: 'rich_text', document: { type: 'doc' },
      frontmatter: doc.share.has('frontmatter') ? sharedPlainText(doc, 'frontmatter') : '',
      bodyFinalLineEnding: doc.share.has('bodyFinalLineEnding') ? sharedPlainText(doc, 'bodyFinalLineEnding') : '',
    } };
  }
  if (representation === 'tiptap_xml') {
    try { readNativeXmlBody(doc); }
    catch { throw new CollaborationCheckpointValidationError('schema_invalid'); }
  }
  if (representation !== richDocumentFormat(doc)
    || representation === 'tiptap_blocks' && !doc.share.has(BLOCK_TREE_KEY)
    || representation === 'tiptap_xml' && !doc.share.has('body')
    || doc.share.has('content') && sharedPlainText(doc, 'content').length > 0) {
    throw new CollaborationCheckpointValidationError('schema_invalid');
  }
  if (representation === 'tiptap_blocks' && doc.share.has('body') && doc.getXmlFragment('body').length) {
    throw new CollaborationCheckpointValidationError('schema_invalid');
  }
  const structure = validateRichMarkdownStructure(doc);
  if (!structure.valid) throw new CollaborationCheckpointValidationError(structure.code);
  return { version: { stateVector, stateProof }, content: {
    kind: 'rich_text', document: structure.document,
    frontmatter: sharedPlainText(doc, 'frontmatter'),
    bodyFinalLineEnding: sharedPlainText(doc, 'bodyFinalLineEnding'),
  } };
}

function assertNativeState(state: PersistedCollaborationState): void {
  if (state.status !== 'active'
    || [state.documentId, state.workspaceId, state.path].some((value) => typeof value !== 'string' || !value)
    || state.organizationId !== null && (typeof state.organizationId !== 'string' || !state.organizationId)
    || state.path.startsWith('/') || state.path.includes('\\') || state.path.includes('\0')
    || state.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || typeof state.degraded !== 'boolean'
    || !Number.isSafeInteger(state.lifecycleGeneration) || state.lifecycleGeneration < 1
    || state.schemaVersion !== COLLABORATION_SCHEMA_VERSION
    || !Number.isSafeInteger(state.documentSequence) || state.documentSequence < 0
    || !Number.isSafeInteger(state.checkpointSequence) || state.checkpointSequence < 0
    || state.checkpointSequence > state.documentSequence || !Number.isFinite(state.persistedAt) || state.persistedAt < 0) {
    throw new Error('The collaborative document identity or version is unavailable.');
  }
  if (isCollaborationStateQuarantined(state)) throw new CollaborationCheckpointQuarantinedError();
}

/** Internal inspection seam: anchors and structure are derived from the SAME proven binary.
 * The temporary document is destroyed after the synchronous callback. No raw Yjs is public. */
export function inspectPersistedNativeCollaborationSnapshot<T>(
  state: PersistedCollaborationState,
  inspect: (doc: YTypes.Doc, snapshot: NativeCollaborationSnapshot) => T,
  budget?: NativeDocumentReadBudget,
): T {
  assertNativeState(state);
  const selectedBudget = budget === undefined ? undefined : captureNativeDocumentReadBudget(budget);
  if (selectedBudget && (state.yjsState.byteLength > selectedBudget.maxStateBytes
    || state.stateVector.byteLength > selectedBudget.maxVectorBytes)) throw new DocumentReadError('DOCUMENT_TOO_LARGE');
  const doc = new Y.Doc({ gc: true });
  try {
    const decoder = decoding.createDecoder(state.yjsState);
    Y.readUpdate(decoder, doc);
    if (decoding.hasContent(decoder)) throw new Error('Persisted collaboration state contains trailing bytes.');
    if (selectedBudget) assertNativeDocumentWithinReadBudget(doc, selectedBudget);
    const native = inspectNativeDocument(doc, state.representation);
    if (native.version.stateVector !== Buffer.from(state.stateVector).toString('base64')) {
      throw new Error('Persisted collaboration state and state vector do not match.');
    }
    const result = inspect(doc, {
      snapshotVersion: 1, source: 'persisted_yjs', documentId: state.documentId,
      workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path,
      lifecycleGeneration: state.lifecycleGeneration, representation: state.representation, schemaVersion: state.schemaVersion,
      version: { ...native.version, documentSequence: state.documentSequence, persistedAt: state.persistedAt },
      projection: { checkpointSequence: state.checkpointSequence, checkpointedAt: state.checkpointedAt,
        ...(state.projectionError ? { error: { ...state.projectionError } } : {}) },
      content: native.content,
    });
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('Native snapshot inspection must be synchronous.');
    }
    if (collaborationStateProof(doc, Y) !== native.version.stateProof) {
      throw new Error('Native snapshot inspection must not change the document.');
    }
    return result;
  } finally { doc.destroy(); }
}

/** Native reads intentionally never invoke a Markdown serializer. */
export function authoritativeNativeCollaborationSnapshot(state: PersistedCollaborationState): NativeCollaborationSnapshot {
  return inspectPersistedNativeCollaborationSnapshot(state, (_doc, snapshot) => snapshot);
}

export type NativeCollaborationDocumentRead = Omit<NativeCollaborationSnapshot, 'source' | 'version' | 'content'> & {
  source: 'live_yjs' | 'persisted_yjs';
  observed: NativeCollaborationVersion & { content: NativeCollaborationContent; durable: boolean };
  durable: NativeCollaborationSnapshot['version'];
};

/** Uses the existing room ownership/read handoff and separately certifies durable content. */
export async function readNativeCollaborationDocument(input: {
  workspace: WorkspaceContext;
  documentId: string;
  path: string;
  lifecycleGeneration?: number;
  /** Internal read transaction may retain its connection through the room read. */
  loadState?: typeof loadCollaborationState;
}): Promise<NativeCollaborationDocumentRead> {
  if (!input.workspace.permissions.canRead
    || input.workspace.status !== undefined && input.workspace.status !== 'active') {
    throw Object.assign(new Error('The workspace document is unavailable.'), { status: 403 });
  }
  return readCurrentCollaborationDocument({
    documentId: input.documentId, workspaceId: input.workspace.workspaceId,
    loadState: input.loadState,
    read: (doc, state) => {
      if (!state || state.documentId !== input.documentId || state.workspaceId !== input.workspace.workspaceId
        || state.organizationId !== (input.workspace.organizationId ?? null) || state.path !== input.path
        || input.lifecycleGeneration !== undefined && state.lifecycleGeneration !== input.lifecycleGeneration) {
        throw Object.assign(new Error('The collaborative document changed or is unavailable.'), { status: 409 });
      }
      const { version, content: _content, source: _source, ...snapshot } = authoritativeNativeCollaborationSnapshot(state);
      const observed = inspectNativeDocument(doc, state.representation);
      const durable = observed.version.stateProof === version.stateProof;
      return { ...snapshot, source: durable ? 'persisted_yjs' : 'live_yjs',
        observed: { ...observed.version, content: observed.content, durable }, durable: version };
    },
  });
}
