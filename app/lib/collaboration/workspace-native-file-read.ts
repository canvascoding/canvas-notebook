import 'server-only';

import { openDb, type SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { readCurrentCollaborationTextSnapshot } from './agent-file-edits';
import { CollaborationCheckpointQuarantinedError } from './checkpoint-errors';
import { authoritativeNativeCollaborationSnapshot, readNativeCollaborationDocument } from './document-snapshot';
import { loadCollaborationStateOnConnection, serializeCanonicalText, type PersistedCollaborationState } from './persistence';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from './room-admission-contract';
import { readWorkspaceDocumentCatalogue, type WorkspaceDocumentCatalogueEntry } from './workspace-document-catalogue';

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

/** Size of serializeCanonicalText's UTF-8 output without allocating its
 * normalized/newline-expanded strings or Buffer. Surrogates use Node's exact
 * UTF-8 replacement semantics; BOM and CRLF expansion remain explicit. */
function serializedUtf8Size(content: string, profile: Pick<PersistedCollaborationState, 'newlineStyle' | 'hasBom'>): number {
  let crlfPairs = 0, lineBreaks = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 13) {
      lineBreaks++;
      if (content.charCodeAt(i + 1) === 10) { crlfPairs++; i++; }
    } else if (content.charCodeAt(i) === 10) lineBreaks++;
  }
  return Buffer.byteLength(content, 'utf8') - crlfPairs + (profile.newlineStyle === 'crlf' ? lineBreaks : 0) + (profile.hasBom ? 3 : 0);
}

async function readNativeEntry(connection: SqlConnection, input: {
  workspace: WorkspaceContext; path: string; mode: 'metadata' | 'export'; maxBytes?: number;
}, document: WorkspaceDocumentCatalogueEntry | undefined, dependencies: Dependencies): Promise<NativeWorkspaceFileRead | null> {
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
      const byteLength = serializedUtf8Size(text.content, current);
      if (input.maxBytes !== undefined && byteLength > input.maxBytes) {
        throw Object.assign(new Error('The native file is too large to export.'), { status: 413 });
      }
      const content = Buffer.from(serializeCanonicalText(text.content, current), 'utf8');
      if (content.length !== byteLength) throw new Error('Native export byte measurement changed.');
      result = { documentId: document.id, lifecycleGeneration: current.lifecycleGeneration,
        documentSequence: current.documentSequence, content, source: text.currency.source,
        modifiedAt: text.currency.durable ? current.persistedAt : null, contentUnavailable: false };
    }
  }
  return result;
}

/** Null means an explicitly pristine/unregistered path, never a failed native read. */
export async function withNativeWorkspaceFileRead<T>(input: {
  workspace: WorkspaceContext; path: string; mode: 'metadata' | 'export'; maxBytes?: number;
}, consume: (native: NativeWorkspaceFileRead | null, connection: SqlConnection) => Promise<T>, dependencies: Dependencies = {}): Promise<T> {
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
    const result = await readNativeEntry(connection, input, document, dependencies);
    // Consumers that need SQL annotations reuse this read's checkout. Opening
    // another pooled connection here can exhaust the pool under parallel reads.
    const consumed = await consume(result, connection);
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

export type NativeWorkspaceFilesReadScope = {
  /** Immutable catalogue; missing-state entries never authorize projection bytes. */
  documents: readonly Readonly<WorkspaceDocumentCatalogueEntry>[];
  readFile(path: string, maxBytes: number): Promise<NativeWorkspaceFileRead | null>;
};

/** Materialize a bounded multi-file export before releasing this SAME read fence.
 * Do not call beneath an exclusive lifecycle lease on another SQL backend.
 * Each native export retains its own observed/durable contract; this is not a
 * cross-document collaborative snapshot or a Markdown initialization path. */
export async function withNativeWorkspaceFilesRead<T>(input: {
  workspace: WorkspaceContext; paths: readonly string[]; maxEntries: number;
}, consume: (scope: NativeWorkspaceFilesReadScope, connection: SqlConnection) => Promise<T>, dependencies: Dependencies = {}): Promise<T> {
  const workspace = structuredClone(input.workspace), paths = [...input.paths], maxEntries = input.maxEntries;
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active') {
    throw Object.assign(new Error('Current workspace read permission is required.'), { status: 403 });
  }
  if (!paths.length || paths.length > maxEntries || paths.some(p => p !== '.' && !isCanonicalAdmissionPath(p))
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
    throw Object.assign(new Error('Invalid native download scope.'), { status: 400 });
  }
  const connection = await (dependencies.openConnection ?? openDb)();
  let transaction = false, active = false; let discard: Error | undefined;
  let readFailed = false; let readFailure: unknown;
  const inFlight = new Set<Promise<NativeWorkspaceFileRead | null>>();
  try {
    await connection.run('BEGIN READ ONLY'); transaction = true;
    await connection.run("SET LOCAL statement_timeout='5s'");
    await connection.run("SET LOCAL lock_timeout='4s'");
    await connection.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
    const catalogue = await (dependencies.readCatalogue ?? readWorkspaceDocumentCatalogue)(connection, workspace, { paths, maxEntries });
    if (catalogue.length > maxEntries) throw Object.assign(new Error('Too many native documents in this download scope.'), { status: 413 });
    const ancestorConflict = await connection.get(`SELECT d.path FROM collaboration_documents d
      WHERE d.workspace_id=$1 AND d.provider='yjs' AND d.status='active'
        AND EXISTS(SELECT 1 FROM unnest($2::text[]) p(path) WHERE left(p.path,length(d.path)+1)=d.path||'/') LIMIT 1`,
    [workspace.workspaceId, [...new Set([...paths.filter(p => p !== '.'), ...catalogue.map(entry => entry.path)])]]);
    if (ancestorConflict) throw Object.assign(new Error('A native document conflicts with a download directory.'), { status: 409, code: 'ARCHIVE_NAME_CONFLICT' });
    const before = JSON.stringify(catalogue);
    const byPath = new Map(catalogue.map(entry => [entry.path, entry]));
    const documents = Object.freeze(catalogue.map(entry => Object.freeze({ ...entry })));
    active = true;
    const scope: NativeWorkspaceFilesReadScope = Object.freeze({ documents,
      readFile(filePath: string, maxBytes: number) {
        if (!active || !isCanonicalAdmissionPath(filePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 0
          || !paths.some(p => p === '.' || filePath === p || filePath.startsWith(`${p}/`))) {
          return Promise.reject(Object.assign(new Error('Native download read is outside its active scope.'), { status: 409 }));
        }
        const read = readNativeEntry(connection, { workspace, path: filePath, mode: 'export', maxBytes }, byPath.get(filePath), dependencies);
        inFlight.add(read);
        void read.then(() => inFlight.delete(read), error => {
          inFlight.delete(read); readFailed = true; readFailure = error;
        });
        return read;
      },
    });
    const consumed = await consume(scope, connection);
    active = false;
    if (inFlight.size) {
      await Promise.allSettled([...inFlight]);
      throw new Error('Native archive reads must complete before the scope callback returns.');
    }
    if (readFailed) throw readFailure;
    const current = await (dependencies.readCatalogue ?? readWorkspaceDocumentCatalogue)(connection, workspace, { paths, maxEntries });
    if (JSON.stringify(current) !== before) throw Object.assign(new Error('The native download namespace changed.'), {
      status: 409, code: 'ARCHIVE_SOURCE_CHANGED',
    });
    await connection.run('COMMIT'); transaction = false;
    return consumed;
  } catch (error) {
    if (error instanceof CollaborationCheckpointQuarantinedError) Object.assign(error, { status: 409 });
    throw error;
  } finally {
    active = false;
    if (inFlight.size) await Promise.allSettled([...inFlight]);
    if (transaction) try { await connection.run('ROLLBACK'); }
    catch { discard = new Error('Discarding unresolved native archive read transaction.'); }
    await connection.close(discard);
  }
}
