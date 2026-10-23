import 'server-only';

import { getSchema } from '@tiptap/core';
import * as decoding from 'lib0/decoding';
import { CollaborationCheckpointQuarantinedError } from './checkpoint-errors';
import { inspectNativeDocument, type NativeCollaborationSnapshot } from './document-snapshot';
import { isCollaborationStateQuarantined } from './failure';
import { richMarkdownSchemaExtensions } from './markdown-state';
import { assertNativeDocumentSchema } from './native-document-schema';
import type { PersistedCollaborationState } from './persistence';
import { Y } from './server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from './types';

export type ArchivedNativeSnapshot = NativeCollaborationSnapshot & { status: 'archived' };
export const ARCHIVED_NATIVE_BINARY_LIMIT = 16 * 1024 * 1024;

/** Private lifecycle inspection, never active read/mutation authority. The real
 * archived status is retained; neither SQL nor an in-memory active copy is used.
 * Structural validation is shared with native reads, with no Markdown export. */
export function inspectArchivedNativeSnapshot(state: PersistedCollaborationState): ArchivedNativeSnapshot {
  if (state.status !== 'archived'
    || [state.documentId, state.workspaceId, state.path].some(value => typeof value !== 'string' || !value)
    || state.organizationId !== null && (typeof state.organizationId !== 'string' || !state.organizationId)
    || state.path.startsWith('/') || state.path.includes('\\') || state.path.includes('\0')
    || state.path.split('/').some(segment => !segment || segment === '.' || segment === '..')
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(state.representation)
    || typeof state.degraded !== 'boolean' || state.schemaVersion !== COLLABORATION_SCHEMA_VERSION
    || !Number.isSafeInteger(state.lifecycleGeneration) || state.lifecycleGeneration < 1
    || !Number.isSafeInteger(state.documentSequence) || state.documentSequence < 0
    || !Number.isSafeInteger(state.checkpointSequence) || state.checkpointSequence < 0
    || state.checkpointSequence > state.documentSequence || !Number.isFinite(state.persistedAt) || state.persistedAt < 0
    || !(state.yjsState instanceof Uint8Array) || !state.yjsState.length || state.yjsState.length > ARCHIVED_NATIVE_BINARY_LIMIT
    || !(state.stateVector instanceof Uint8Array) || !state.stateVector.length || state.stateVector.length > ARCHIVED_NATIVE_BINARY_LIMIT) {
    throw new Error('The archived native identity or version is unavailable.');
  }
  if (isCollaborationStateQuarantined(state)) throw new CollaborationCheckpointQuarantinedError();
  const doc = new Y.Doc({ gc: true });
  try {
    const decoder = decoding.createDecoder(state.yjsState);
    Y.readUpdate(decoder, doc);
    if (decoding.hasContent(decoder)) throw new Error('Archived native state contains trailing bytes.');
    // Inspect the actual raw roots/nodes/marks before schema normalization can
    // discard unsupported fields. The archived bytes and status stay intact.
    assertNativeDocumentSchema(doc, state.representation, getSchema(richMarkdownSchemaExtensions()));
    const native = inspectNativeDocument(doc, state.representation);
    if (native.version.stateVector !== Buffer.from(state.stateVector).toString('base64')) {
      throw new Error('Archived native state and vector do not match.');
    }
    return { snapshotVersion: 1, source: 'persisted_yjs', status: 'archived', documentId: state.documentId,
      workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path,
      representation: state.representation, schemaVersion: state.schemaVersion, lifecycleGeneration: state.lifecycleGeneration,
      version: { ...native.version, documentSequence: state.documentSequence, persistedAt: state.persistedAt },
      projection: { checkpointSequence: state.checkpointSequence, checkpointedAt: state.checkpointedAt,
        ...(state.projectionError ? { error: { ...state.projectionError } } : {}) }, content: native.content };
  } finally { doc.destroy(); }
}
