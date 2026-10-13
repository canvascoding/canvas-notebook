import 'server-only';

import { openDb, type SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { readCurrentCollaborationTextSnapshot } from './agent-file-edits';
import { CollaborationCheckpointQuarantinedError } from './checkpoint-errors';
import { authoritativeNativeCollaborationSnapshot, readNativeCollaborationDocument } from './document-snapshot';
import { loadCollaborationStateOnConnection, serializeCanonicalText, type PersistedCollaborationState } from './persistence';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from './room-admission-contract';
import { readWorkspaceDocumentCatalogue } from './workspace-document-catalogue';

type Dependencies = {
  openConnection?: () => Promise<SqlConnection>;
  readCatalogue?: typeof readWorkspaceDocumentCatalogue;
  loadState?: typeof loadCollaborationStateOnConnection;
};
export type NativeWorkspaceFileRead = {
  documentId: string;
  lifecycleGeneration: number;
  documentSequence: number;
  content: Buffer | null;
  source: 'live_yjs' | 'persisted_yjs';
  modifiedAt: number | null;
  /** Metadata-only bootstrap intentionally makes no text/export claim. */
  contentUnavailable: boolean;
};

/** Null means an explicitly pristine/unregistered path, never a failed native read. */
export async function withNativeWorkspaceFileRead<T>(input: {
  workspace: WorkspaceContext; path: string; mode: 'metadata' | 'export'; maxBytes?: number;
}, consume: (native: NativeWorkspaceFileRead | null) => Promise<T>, dependencies: Dependencies = {}): Promise<T> {
  if (!input.workspace.permissions.canRead || input.workspace.status !== undefined && input.workspace.status !== 'active') {
    throw Object.assign(new Error('Current workspace read permission is required.'), { status: 403 });
  }
  if (!isCanonicalAdmissionPath(input.path) || input.maxBytes !== undefined
    && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)) throw Object.assign(new Error('Invalid native file read.'), { status: 400 });
  input = { ...input, workspace: structuredClone(input.workspace) };
  const connection = await (dependencies.openConnection ?? openDb)();
  let transaction = false;
  let discard: Error | undefined;
  try {
    await connection.run('BEGIN READ ONLY'); transaction = true;
    await connection.run("SET LOCAL statement_timeout='5s'");
    await connection.run("SET LOCAL lock_timeout='4s'");
    await connection.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(input.workspace.workspaceId)]);
    const catalogue = await (dependencies.readCatalogue ?? readWorkspaceDocumentCatalogue)(connection, input.workspace, { paths: [input.path] });
    const document = catalogue.find(entry => entry.path === input.path);
    if (document?.authority === 'missing-state') throw Object.assign(new Error('The native document state is unavailable.'), { status: 409 });
    let result: NativeWorkspaceFileRead | null = null;
    if (document?.authority === 'initialized') {
      let metadata: PersistedCollaborationState | null = null;
      const loadState = async (documentId: string) => {
        const current = await (dependencies.loadState ?? loadCollaborationStateOnConnection)(connection, documentId);
        if (!current || current.documentId !== document.id || current.workspaceId !== input.workspace.workspaceId
          || current.organizationId !== (input.workspace.organizationId ?? null) || current.path !== input.path
          || current.lifecycleGeneration !== document.lifecycle_generation || current.status !== 'active') {
          throw Object.assign(new Error('The native document identity changed.'), { status: 409 });
        }
        metadata = current; return current;
      };
      if (input.mode === 'metadata') {
        let source: NativeWorkspaceFileRead['source'] = 'persisted_yjs'; let modifiedAt: number | null;
        try {
          const native = await readNativeCollaborationDocument({ workspace: input.workspace, path: input.path,
            documentId: document.id, lifecycleGeneration: document.lifecycle_generation!, loadState });
          source = native.source; modifiedAt = native.observed.durable ? native.durable.persistedAt : null;
        } catch (error) {
          // Recovery must remain reachable without fabricating an export or granting a write.
          if (!(error instanceof CollaborationCheckpointQuarantinedError) || !metadata) throw error;
          modifiedAt = (metadata as PersistedCollaborationState).persistedAt;
        }
        if (!metadata) throw new Error('Native metadata must belong to this exact read.');
        const current = metadata as PersistedCollaborationState;
        result = { documentId: document.id, lifecycleGeneration: current.lifecycleGeneration,
          documentSequence: current.documentSequence, content: null, source, modifiedAt, contentUnavailable: true };
      } else {
        const text = await readCurrentCollaborationTextSnapshot({ workspace: input.workspace, path: input.path,
          documentId: document.id, lifecycleGeneration: document.lifecycle_generation!, loadState });
        if (!metadata || !text.currency) throw new Error('Native text must belong to this exact metadata read.');
        const current = metadata as PersistedCollaborationState;
        if (text.currency.persistedStateProof !== authoritativeNativeCollaborationSnapshot(current).version.stateProof
          || text.documentSequence !== current.documentSequence || !['lf', 'crlf'].includes(current.newlineStyle)
          || typeof current.hasBom !== 'boolean') throw new Error('Native export metadata changed.');
        const content = Buffer.from(serializeCanonicalText(text.content, current), 'utf8');
        if (input.maxBytes !== undefined && content.length > input.maxBytes) {
          throw Object.assign(new Error('The native file is too large to export.'), { status: 413 });
        }
        result = { documentId: document.id, lifecycleGeneration: current.lifecycleGeneration,
          documentSequence: current.documentSequence, content, source: text.currency.source,
          modifiedAt: text.currency.durable ? current.persistedAt : null, contentUnavailable: false };
      }
    }
    const consumed = await consume(result);
    await connection.run('COMMIT'); transaction = false;
    return consumed;
  } catch (error) {
    if (error instanceof CollaborationCheckpointQuarantinedError) Object.assign(error, { status: 409 });
    throw error;
  } finally {
    if (transaction) try { await connection.run('ROLLBACK'); }
    catch { discard = new Error('Discarding unresolved native file read transaction.'); }
    await connection.close(discard);
  }
}

/** Callers that read pristine bytes use withNativeWorkspaceFileRead to retain the same authority fence. */
export function readNativeWorkspaceFile(input: Parameters<typeof withNativeWorkspaceFileRead>[0], dependencies: Dependencies = {}) {
  return withNativeWorkspaceFileRead(input, async native => native, dependencies);
}
