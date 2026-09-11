import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import type * as Persistence from '../app/lib/collaboration/persistence';
import type * as Checkpoint from '../app/lib/collaboration/checkpoint';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const require = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exports = {};
  new Function('require', 'module', 'exports', compiled.outputText)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), { exports }, exports,
  );
  return exports as T;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function seedRow(doc: Y.Doc) {
  return {
    document_id: 'doc', workspace_id: 'workspace', organization_id: null, path: 'doc.txt',
    representation: 'plain_text', lifecycle_generation: 1, schema_version: 1,
    yjs_state: Y.encodeStateAsUpdate(doc), state_vector: Y.encodeStateVector(doc),
    document_sequence: 2, persisted_at: 1, checkpointed_at: 1, checkpoint_sequence: 1,
    canonical_hash: 'old', serialized_hash: 'old', newline_style: 'lf', has_bom: false,
    degraded: false, status: 'active',
  };
}
type Row = ReturnType<typeof seedRow>;
type Receipt = 'missing' | 'attempt' | 'confirmed' | 'finalized';

/** SQL fixture checks the actual production predicates; it does not replace the fence itself. */
async function harness() {
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'ABC');
  let row: Row | undefined = seedRow(doc);
  let file = 'Original file';
  let receipt: Receipt = 'missing';
  let commitFault: 'none' | 'committed' | 'rolledback' | 'replaced' | 'missing' | 'open' = 'none';
  let rollbackFault = false;
  let beginFault = false;
  let activeTransactions = 0;
  const events: string[] = [];
  const owned = new AsyncLocalStorage<boolean>();
  let tail = Promise.resolve();
  const lock = async <T>(_workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    if (owned.getStore()) return operation();
    const before = tail;
    const released = gate(); tail = before.then(() => released.promise);
    await before;
    try { return await owned.run(true, operation); } finally { released.resolve(); }
  };
  const assertWorkspace = () => assert.equal(owned.getStore(), true, 'file lifecycle work must own the workspace fence');
  const openDb = async (): Promise<SqlConnection> => {
    let transaction: { row: Row | undefined; receipt: Receipt } | null = null;
    let closed = false;
    return {
      get: async (sql, parameters = []) => {
        assert(!closed);
        const query = sql.replace(/\s+/gu, ' ').trim();
        if (query.includes('FOR UPDATE')) {
          assert(!transaction, 'recovery row lock must release in autocommit before file I/O');
          assert.equal(parameters.length, 1, 'only the fresh recovery read needs a short row fence');
          events.push('recovery read');
        }
        const current = transaction ? transaction.row : row;
        if (query.startsWith('SELECT')) {
          if (!current || current.document_id !== parameters[0]) return undefined;
          if (query.includes("status = 'active'") && current.status !== 'active') return undefined;
          if (query.includes('document_sequence = $7')) {
            const [id, workspace, filePath, representation, generation, schema, sequence, checkpoint] = parameters;
            if (current.document_id !== id || current.workspace_id !== workspace || current.path !== filePath
              || current.representation !== representation || current.lifecycle_generation !== generation
              || current.schema_version !== schema || current.document_sequence !== sequence
              || current.checkpoint_sequence > Number(checkpoint)) return undefined;
          }
          return { ...current };
        }
        if (query.includes('SET yjs_state = $1')) {
          assert.equal(activeTransactions, 0, 'binary persistence runs while the projection is awaiting file I/O');
          assert(current);
          assert.equal(current.document_id, parameters[3]); assert.equal(current.lifecycle_generation, parameters[4]);
          row = { ...current, yjs_state: parameters[0] as Uint8Array, state_vector: parameters[1] as Uint8Array,
            persisted_at: Number(parameters[2]), document_sequence: current.document_sequence + 1, degraded: false };
          events.push('persist'); return { ...row };
        }
        if (query.startsWith('UPDATE collaboration_yjs_states SET checkpointed_at')) {
          assert(transaction, 'checkpoint confirmation must have a short transaction');
          assert(query.includes('document_sequence >= $6'), 'a newer persisted Yjs snapshot must not invalidate the projected snapshot');
          assert(query.includes('checkpoint_sequence <= $7'));
          assert(query.includes('degraded = CASE WHEN document_sequence = $6 THEN 0 ELSE degraded END'));
          assert(query.includes('workspace_id = $8 AND path = $9 AND representation = $10'));
          assert(query.includes("status = 'active' AND lifecycle_generation = $11 AND schema_version = $12"));
          const [time, sequence, canonical, serialized, id, minimumSequence, maximumCheckpoint, workspace, filePath, representation, generation, schema] = parameters;
          if (!current || current.document_id !== id || current.document_sequence < Number(minimumSequence)
            || current.checkpoint_sequence > Number(maximumCheckpoint) || current.workspace_id !== workspace
            || current.path !== filePath || current.representation !== representation || current.status !== 'active'
            || current.lifecycle_generation !== generation || current.schema_version !== schema) return undefined;
          transaction.row = { ...current, checkpointed_at: Number(time), checkpoint_sequence: Number(sequence),
            canonical_hash: String(canonical), serialized_hash: String(serialized),
            degraded: current.document_sequence === Number(minimumSequence) ? false : current.degraded };
          events.push('cas'); return { ...transaction.row };
        }
        throw new Error(`Unhandled test SQL: ${query}`);
      },
      run: async (sql) => {
        assert(!closed);
        events.push(sql);
        if (sql === 'BEGIN') {
          assert(!transaction); activeTransactions++;
          transaction = { row: row && { ...row }, receipt };
          if (beginFault) { beginFault = false; throw new Error('BEGIN reply lost'); }
          return;
        }
        if (sql === 'INSERT receipt') { assert(transaction); transaction.receipt = 'confirmed'; return; }
        if (sql === 'ROLLBACK') {
          if (rollbackFault) { rollbackFault = false; throw new Error('ROLLBACK reply lost'); }
          if (transaction) activeTransactions--; transaction = null; return;
        }
        if (sql === 'COMMIT') {
          assert(transaction);
          const fault = commitFault; commitFault = 'none';
          if (fault === 'open') throw new Error('Commit reply lost');
          if (fault !== 'rolledback') { row = transaction.row; receipt = transaction.receipt; }
          if (fault === 'replaced' && row) row = { ...row, lifecycle_generation: row.lifecycle_generation + 1 };
          if (fault === 'missing') row = undefined;
          activeTransactions--; transaction = null;
          if (fault !== 'none') throw new Error('Commit reply lost');
          return;
        }
        throw new Error(`Unhandled test command: ${sql}`);
      },
      all: async () => [],
      close: (error?: Error) => {
        assert(!closed, 'a discarded connection must not be released twice'); closed = true;
        if (error) {
          events.push('discard');
          if (transaction) activeTransactions--; transaction = null;
        } else assert(!transaction, 'connection must not return to pool with an open transaction');
      },
    };
  };
  const persistence = await compile<typeof Persistence>('app/lib/collaboration/persistence.ts', {
    'server-only': {}, '@/app/lib/db': { openDb },
    '@/app/lib/files/workspace-mutation-lock': { withWorkspaceMutationLock: lock },
    '@/app/lib/files/collaboration-repository': {
      withFileCollaborationTransaction: async (operation: (connection: object) => Promise<void>) => {
        assertWorkspace(); events.push('lifecycle transaction'); await operation({});
      },
      lockFileCollaborationPaths: async () => {},
      movePersistedCollaborationStatePathScope: async () => { events.push('move'); },
      archivePersistedCollaborationStatePathScopes: async () => { events.push('archive'); },
      reactivatePersistedCollaborationStatePathScope: async () => { events.push('reactivate'); },
    },
    '@/app/lib/markdown/obsidian-metadata': {}, '@/app/lib/markdown/rich-markdown-codec': {},
    './markdown-state': {}, './runtime-state': {}, './types': {}, './server-runtime': { Y },
  });
  const revision = async () => ({ sha256: persistence.sha256Text(file), stats: { size: Buffer.byteLength(file) } });
  let beforeWrite: (() => Promise<void>) | undefined;
  let beforeShares: (() => Promise<void>) | undefined;
  const checkpoint = await compile<typeof Checkpoint>('app/lib/collaboration/checkpoint.ts', {
    'server-only': {}, './persistence': persistence, './server-runtime': { Y }, './markdown-state': {},
    './projection-repository': {
      beginCollaborationProjectionAttempt: async (state: Persistence.PersistedCollaborationState) => {
        assertWorkspace(); assert.equal(activeTransactions, 0, 'attempt marker must commit before file I/O');
        assert.equal(state.documentId, row!.document_id); assert.equal(state.lifecycleGeneration, row!.lifecycle_generation);
        assert(state.documentSequence <= row!.document_sequence);
        receipt = 'attempt'; events.push('attempt');
      },
      recordCollaborationProjectionPending: async (transaction: SqlConnection, state: Persistence.PersistedCollaborationState) => {
        assert.equal(activeTransactions, 1); assert.equal(state.checkpointSequence, 2);
        await transaction.run('INSERT receipt');
      },
      finalizeCollaborationProjectionReceipt: async () => {
        assertWorkspace(); assert.equal(activeTransactions, 0);
        if (receipt !== 'confirmed' && receipt !== 'finalized') throw new Error('Projection receipt changed before finalization');
        assert.equal(events.at(-1), 'share done', 'receipt finalization follows awaited share synchronization');
        receipt = 'finalized'; events.push('receipt finalized');
      },
    },
    '@/app/lib/files/workspace-mutation-lock': { withWorkspaceMutationLock: lock },
    '@/app/lib/filesystem/workspace-files': {
      readFile: async () => { assertWorkspace(); return file; },
      writeFile: async (_path: string, content: string, _options: object, beforeReplace?: () => Promise<void>) => {
        assertWorkspace(); assert.equal(activeTransactions, 0, 'file I/O must not run under the Yjs transaction');
        await beforeWrite?.(); await beforeReplace?.(); file = content; events.push(`file:${content}`);
      },
    },
    '@/app/lib/files/revision-guard': { getWorkspaceFileRevision: revision },
    '@/app/lib/files/collaboration-policy': {
      ensureFileRevisionForCurrentContent: async () => { assertWorkspace(); return { id: 'revision' }; },
      markCollaborationDocumentCheckpoint: async (input: { documentId: string; stateVersion: number; snapshotRevisionId: string }) => {
        assertWorkspace(); events.push('finalize');
        return { id: input.documentId, stateVersion: input.stateVersion, snapshotRevisionId: input.snapshotRevisionId };
      },
    },
    '@/app/lib/api/route-helpers': { invalidateWorkspaceFileViews: () => { assertWorkspace(); } },
    '@/app/lib/files/path-utils': { getParentDirectory: () => '' },
    '@/app/lib/public-sharing/public-file-shares': { syncPublicSharesAfterWrite: async () => {
      assertWorkspace(); events.push('share start'); await beforeShares?.(); events.push('share done');
    } },
    '@/app/lib/workspaces/request': { workspaceFileOptions: () => ({}) },
  });
  const state = async () => { const value = await persistence.loadCollaborationState('doc'); assert(value); return value; };
  const workspace = { workspaceId: 'workspace' } as WorkspaceContext;
  return {
    doc, persistence, checkpoint, state, workspace, events, lock,
    get row() { return row; }, set row(value: Row | undefined) { row = value; },
    get file() { return file; }, set file(value: string) { file = value; },
    get receipt() { return receipt; },
    set commitFault(value: typeof commitFault) { commitFault = value; },
    set rollbackFault(value: boolean) { rollbackFault = value; },
    set beginFault(value: boolean) { beginFault = value; },
    set beforeWrite(value: typeof beforeWrite) { beforeWrite = value; },
    set beforeShares(value: typeof beforeShares) { beforeShares = value; },
    get activeTransactions() { return activeTransactions; },
  };
}

async function main() {
  {
    const releases: Array<Error | undefined> = [];
    const database = await compile<typeof import('../app/lib/db')>('app/lib/db/index.ts', {
      './postgres': {
        createPostgresPool: () => ({ connect: async () => ({
          query: async () => ({ rows: [{ value: 1 }], rowCount: 1 }),
          release: (error?: Error) => releases.push(error),
        }) }),
        createPostgresDrizzle: () => ({}),
      },
      './provider': { assertRuntimeDatabaseProviderSupported() {}, getDatabaseProvider: () => 'postgres' },
      './errors': { coerceDatabaseUnavailableError: () => null },
    });
    const healthy = await database.openDb();
    assert.deepEqual(await healthy.get('SELECT 1'), { value: 1 });
    assert.deepEqual(await healthy.all('SELECT 1'), [{ value: 1 }]);
    assert.deepEqual(await healthy.run('UPDATE example'), { changes: 1 });
    await healthy.close();
    const unhealthy = await database.openDb(); const cause = new Error('Unresolved transaction');
    await unhealthy.close(cause);
    assert.deepEqual(releases, [undefined, cause], 'the real SQL wrapper forwards the discard error to pg release(error)');
  }
  {
    const h = await harness();
    const entered = gate(); const release = gate(); const shareEntered = gate(); const shareRelease = gate();
    h.beforeWrite = async () => { entered.resolve(); await release.promise; };
    h.beforeShares = async () => { shareEntered.resolve(); await shareRelease.promise; };
    const initial = await h.state();
    const writing = h.checkpoint.materializeCollaborationCheckpoint({ state: initial, workspace: h.workspace,
      confirmProjection: async (transaction, projected, result) => {
        assert.equal(h.activeTransactions, 1);
        assert.equal(projected.checkpointSequence, 2); assert.equal(projected.documentSequence, 3);
        assert.equal(result.content, 'ABC');
        await transaction.run('INSERT receipt');
      },
    });
    await entered.promise;
    h.doc.getText('content').delete(0, 1);
    const persisted = await h.persistence.persistCollaborationYDoc('doc', 1, h.doc);
    assert.equal(persisted.documentSequence, 3);
    assert.deepEqual(persisted.stateVector, initial.stateVector, 'pure deletion keeps the vector clock but changes authoritative content');
    h.row = { ...h.row!, degraded: true };
    let lifecycleFinished = false;
    const lifecycle = h.persistence.movePersistedCollaborationPath({ workspaceId: 'workspace', oldPath: 'doc.txt', newPath: 'moved.txt' })
      .then(() => { lifecycleFinished = true; });
    assert.equal(lifecycleFinished, false);
    release.resolve(); await shareEntered.promise;
    assert.equal(lifecycleFinished, false, 'rename cannot run between file/CAS and public-share finalization');
    assert.equal(h.receipt, 'confirmed'); assert.equal(h.file, 'ABC');
    shareRelease.resolve(); const written = await writing; await lifecycle;
    assert.equal(written.state.documentSequence, 3); assert.equal(written.state.checkpointSequence, 2);
    assert.equal(h.receipt, 'finalized');
    assert.equal(written.state.degraded, true, 'projecting N cannot clear a durability failure for the newer snapshot');
    const authoritative = h.checkpoint.authoritativeCollaborationSnapshot(await h.state());
    assert.equal(authoritative.canonicalContent, 'BC', 'projecting N must not replace the durable Yjs deletion at N+1');
    assert(h.events.indexOf('share done') < h.events.indexOf('move'));
    h.doc.destroy();
  }
  for (const patch of [
    { path: 'renamed.txt' }, { lifecycleGeneration: 2 }, { schemaVersion: 2 },
    { representation: 'tiptap_xml' }, { documentSequence: 1 }, { stateVector: new Uint8Array([0]) },
  ]) {
    const h = await harness(); const state = { ...await h.state(), ...patch } as Persistence.PersistedCollaborationState;
    await assert.rejects(() => h.checkpoint.materializeCollaborationCheckpoint({ state, workspace: h.workspace }), h.checkpoint.CollaborationCheckpointSupersededError);
    assert.equal(h.file, 'Original file'); assert.equal(h.events.length, 0); h.doc.destroy();
  }
  for (const newer of ['none', 'file', 'lifecycle'] as const) {
    const h = await harness(); const state = await h.state();
    await assert.rejects(() => h.checkpoint.materializeCollaborationCheckpoint({ state, workspace: h.workspace,
      confirmProjection: async (transaction) => {
        await transaction.run('INSERT receipt');
        if (newer === 'file') h.file = 'Newer external file';
        if (newer === 'lifecycle') h.row = { ...h.row!, lifecycle_generation: 2 };
        throw new Error('Receipt insert failed');
      },
    }), newer === 'none' ? /Receipt insert failed/ : /confirmation and file rollback both failed/);
    assert.equal(h.receipt, 'attempt', 'failed confirmation keeps a restart-discoverable attempt'); assert.equal(h.row!.checkpoint_sequence, 1);
    assert.equal(h.file, newer === 'none' ? 'Original file' : newer === 'file' ? 'Newer external file' : 'ABC');
    if (newer === 'none') assert(h.events.indexOf('ROLLBACK') < h.events.indexOf('file:Original file'));
    h.doc.destroy();
  }
  for (const fault of ['committed', 'rolledback', 'replaced', 'missing'] as const) {
    const h = await harness(); h.commitFault = fault;
    const promise = h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace,
      confirmProjection: async (transaction) => { await transaction.run('INSERT receipt'); },
    });
    if (fault === 'committed') {
      assert.equal((await promise).state.checkpointSequence, 2); assert.equal(h.receipt, 'finalized'); assert.equal(h.file, 'ABC');
    } else {
      await assert.rejects(promise, fault === 'rolledback' ? /Commit reply lost/ : h.checkpoint.CollaborationCheckpointSupersededError);
      assert.equal(h.file, fault === 'rolledback' ? 'Original file' : 'ABC', 'ambiguous commits must not compensate through a different lifecycle');
    }
    assert.equal(h.activeTransactions, 0); h.doc.destroy();
  }
  for (const failure of ['begin', 'confirmation'] as const) {
    const h = await harness(); h.rollbackFault = true;
    if (failure === 'begin') h.beginFault = true;
    await assert.rejects(h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace,
      confirmProjection: async () => { throw new Error('Receipt callback failed'); },
    }), /transaction rollback failed/);
    assert.equal(h.receipt, 'attempt'); assert.equal(h.file, 'ABC');
    assert.equal(h.row!.checkpoint_sequence, 1); assert.equal(h.activeTransactions, 0);
    assert.equal(h.events.filter((event) => event === 'discard').length, 1);
    assert(!h.events.includes('file:Original file'), 'unconfirmed transaction rollback must skip direct file compensation');
    await h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace });
    assert.equal(h.receipt, 'finalized', 'discarded transaction leaves a recoverable attempt for the next worker');
    h.doc.destroy();
  }
  for (const fault of ['committed', 'open'] as const) {
    const h = await harness(); h.commitFault = fault; h.rollbackFault = true;
    const operation = h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace });
    if (fault === 'committed') {
      await operation; assert.equal(h.receipt, 'finalized'); assert.equal(h.file, 'ABC');
    } else {
      await assert.rejects(operation, /Commit reply lost/);
      assert.equal(h.receipt, 'attempt'); assert.equal(h.file, 'Original file');
      assert(h.events.indexOf('recovery read') < h.events.indexOf('file:Original file'));
    }
    assert(h.events.indexOf('discard') < h.events.indexOf('recovery read'), 'indeterminate COMMIT recovery starts after discarding the unresolved connection');
    assert.equal(h.activeTransactions, 0); h.doc.destroy();
  }
  {
    const h = await harness();
    await h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace });
    assert.equal(h.receipt, 'finalized');
    h.commitFault = 'rolledback';
    h.beforeWrite = async () => assert.equal(h.receipt, 'attempt', 'a repeat of N invalidates its old receipt before replacing the file');
    const repeat = h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace });
    await assert.rejects(repeat, /receipt changed before finalization/);
    assert.equal(h.row!.checkpoint_sequence, 2);
    assert.equal(h.file, 'ABC');
    assert.equal(h.receipt, 'attempt', 'same N/hash from an earlier commit cannot erase a rolled-back new attempt');
    h.beforeWrite = undefined;
    await h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace });
    assert.equal(h.receipt, 'finalized', 'a new projection recovers the incomplete repeated attempt');
    h.doc.destroy();
  }
  {
    const h = await harness();
    h.beforeShares = async () => { throw new Error('Share storage unavailable'); };
    await assert.rejects(h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace }), /Share storage unavailable/);
    assert.equal(h.receipt, 'confirmed', 'a file/metadata commit remains pending when final share synchronization fails');
    assert.equal(h.file, 'ABC'); assert.equal(h.row!.checkpoint_sequence, 2);
    h.beforeShares = undefined;
    await h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace });
    assert.equal(h.receipt, 'finalized'); h.doc.destroy();
  }
  {
    const h = await harness();
    h.row = { ...h.row!, degraded: true };
    const written = await h.checkpoint.materializeCollaborationCheckpoint({ state: await h.state(), workspace: h.workspace });
    assert.equal(written.state.degraded, false, 'validating and projecting the exact current snapshot heals its prior degraded status');
    h.row = { ...h.row!, path: 'renamed.txt' };
    await assert.rejects(() => h.checkpoint.finalizeCollaborationCheckpointProjection({ ...written, workspace: h.workspace }),
      h.checkpoint.CollaborationCheckpointSupersededError);
    h.row = { ...h.row!, path: 'doc.txt' }; h.file = 'Newer external file';
    await assert.rejects(() => h.checkpoint.finalizeCollaborationCheckpointProjection({ ...written, workspace: h.workspace }), /file changed/);
    h.doc.destroy();
  }
  console.log('Projection fence: concurrent pure deletion, lifecycle ordering through share finalization, stale identities, atomic receipts, compensation and ambiguous commits passed.');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
