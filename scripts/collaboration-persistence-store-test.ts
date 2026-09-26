import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as Y from 'yjs';

import { createPiTestDatabase } from './helpers/pi-test-database';
import type { SqlConnection } from '../app/lib/db';
import type {
  CollaborationPersistenceIdentity,
  CollaborationPersistenceResult,
} from '../app/lib/collaboration/persistence';

type PersistenceModule = {
  persistCollaborationYDoc: (
    documentId: string,
    expectedLifecycleGeneration: number,
    doc: Y.Doc,
    expectedIdentity?: CollaborationPersistenceIdentity,
  ) => Promise<CollaborationPersistenceResult>;
  CollaborationStateInactiveError: typeof Error;
  CollaborationStateStaleError: typeof Error;
};

type ConnectionPlan = {
  beforeReturn?: Promise<void>;
  get?: (
    sql: string,
    params: unknown[],
    next: () => Promise<unknown>,
  ) => Promise<unknown>;
  run?: (
    sql: string,
    params: unknown[],
    next: () => Promise<unknown>,
  ) => Promise<unknown>;
  closeArguments?: Array<Error | undefined>;
};

type StoredRow = {
  yjs_state: Uint8Array;
  state_vector: Uint8Array;
  document_sequence: number | string;
  degraded: number | string | boolean;
  status: 'active' | 'archived';
};

async function loadTranspiledModule<T>(filename: string, mocks: Record<string, unknown>): Promise<T> {
  const runtimeRequire = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };
  const localRequire = (name: string) => Object.prototype.hasOwnProperty.call(mocks, name)
    ? mocks[name]
    : runtimeRequire(name);
  new Function('require', 'module', 'exports', source)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports as T;
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toUpperCase();
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}

function textFromUpdate(update: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}

function mapFromUpdate(update: Uint8Array): Record<string, unknown> {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return doc.getMap('content').toJSON();
  } finally {
    doc.destroy();
  }
}

async function main() {
  const database = await createPiTestDatabase();
  const setup = await database.openDb();
  const plans: ConnectionPlan[] = [];
  const ownedDocs: Y.Doc[] = [];
  const own = <T extends Y.Doc>(doc: T): T => {
    ownedDocs.push(doc);
    return doc;
  };
  const openDb = async (): Promise<SqlConnection> => {
    const plan = plans.shift();
    if (plan?.beforeReturn) await plan.beforeReturn;
    const connection = await database.openDb();
    return {
      get: async (sql, params = []) => {
        const next = async () => connection.get(sql, params);
        return plan?.get ? plan.get(sql, params, next) : next();
      },
      all: (sql, params = []) => connection.all(sql, params),
      run: async (sql, params = []) => {
        const next = async () => connection.run(sql, params);
        return plan?.run ? plan.run(sql, params, next) : next();
      },
      close: async (error) => {
        plan?.closeArguments?.push(error);
        await connection.close();
      },
    };
  };

  const helperFilename = path.resolve('app/lib/collaboration/persistence-merge.ts');
  const helper = await loadTranspiledModule<Record<string, unknown>>(helperFilename, {
    yjs: Y,
    './server-runtime': { Y },
  });
  const persistenceFilename = path.resolve('app/lib/collaboration/persistence.ts');
  const persistence = await loadTranspiledModule<PersistenceModule>(persistenceFilename, {
    'server-only': {},
    '@/app/lib/db': { openDb },
    '@/app/lib/files/workspace-mutation-lock': {},
    '@/app/lib/files/collaboration-repository': {},
    '@/app/lib/markdown/obsidian-metadata': {},
    '@/app/lib/markdown/rich-markdown-codec': {},
    './types': {},
    './markdown-state': {},
    './runtime-state': {},
    './server-runtime': { Y },
    './persistence-merge': helper,
  });

  const identity: CollaborationPersistenceIdentity = {
    workspaceId: 'workspace',
    organizationId: 'organization',
    path: 'note.md',
    representation: 'plain_text',
    schemaVersion: 1,
  };
  const insertState = async (
    documentId: string,
    doc: Y.Doc,
    overrides: Partial<{
      lifecycleGeneration: number;
      documentSequence: number;
      degraded: number;
      status: 'active' | 'archived';
    }> = {},
  ) => {
    const update = Y.encodeStateAsUpdate(doc);
    await setup.run(
      `INSERT INTO collaboration_yjs_states (
        document_id, workspace_id, organization_id, path, representation,
        lifecycle_generation, schema_version, yjs_state, state_vector,
        document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
        canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
      ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$10,0,NULL,NULL,'lf',0,$11,$12)`,
      [
        documentId,
        identity.workspaceId,
        identity.organizationId,
        identity.path,
        identity.representation,
        overrides.lifecycleGeneration ?? 1,
        Buffer.from(update),
        Buffer.from(Y.encodeStateVector(doc)),
        overrides.documentSequence ?? 0,
        Date.now(),
        overrides.degraded ?? 0,
        overrides.status ?? 'active',
      ],
    );
  };
  const row = async (documentId: string) => setup.get(
    `SELECT yjs_state, state_vector, document_sequence, degraded, status
     FROM collaboration_yjs_states WHERE document_id=$1`,
    [documentId],
  ) as Promise<StoredRow>;

  try {
    const base = own(new Y.Doc());
    base.getMap('content').set('base', true);
    await insertState('ordinary', base, { degraded: 1 });
    const equal = await persistence.persistCollaborationYDoc('ordinary', 1, own(cloneDoc(base)));
    assert.equal(equal.persistenceDisposition, 'unchanged');
    assert.equal(equal.incomingNeedsReconcile, false);
    assert.equal(equal.documentSequence, 0);
    assert.equal(equal.degraded, true,
      'a structural no-op preserves degradation because it may describe an invalid document structure');

    const advancedDoc = own(cloneDoc(base));
    advancedDoc.getMap('content').set('advanced', true);
    const advanced = await persistence.persistCollaborationYDoc('ordinary', 1, advancedDoc, identity);
    assert.equal(advanced.persistenceDisposition, 'advanced');
    assert.equal(advanced.incomingNeedsReconcile, false);
    assert.equal(advanced.documentSequence, 1);
    assert.deepEqual(mapFromUpdate(advanced.yjsState), { base: true, advanced: true });

    const ancestor = await persistence.persistCollaborationYDoc('ordinary', 1, base, identity);
    assert.equal(ancestor.persistenceDisposition, 'unchanged');
    assert.equal(ancestor.incomingNeedsReconcile, true);
    assert.equal(ancestor.documentSequence, 1, 'an older contained state cannot bump or replace the durable row');
    assert.deepEqual(mapFromUpdate((await row('ordinary')).yjs_state), { base: true, advanced: true });

    const divergentBase = own(new Y.Doc());
    divergentBase.getMap('content').set('base', true);
    await insertState('divergent', divergentBase);
    const left = own(cloneDoc(divergentBase));
    const right = own(cloneDoc(divergentBase));
    left.getMap('content').set('left', true);
    right.getMap('content').set('right', true);
    const firstBranch = await persistence.persistCollaborationYDoc('divergent', 1, left, identity);
    assert.equal(firstBranch.persistenceDisposition, 'advanced');
    const union = await persistence.persistCollaborationYDoc('divergent', 1, right, identity);
    assert.equal(union.persistenceDisposition, 'merged');
    assert.equal(union.incomingNeedsReconcile, true);
    assert.equal(union.documentSequence, 2);
    assert.deepEqual(mapFromUpdate(union.yjsState), { base: true, left: true, right: true });

    const deletionBase = own(new Y.Doc());
    deletionBase.getText('content').insert(0, 'ABC');
    await insertState('deletions', deletionBase);
    const deleteA = own(cloneDoc(deletionBase));
    const deleteB = own(cloneDoc(deletionBase));
    deleteA.getText('content').delete(0, 1);
    deleteB.getText('content').delete(1, 1);
    assert.deepEqual(Y.encodeStateVector(deleteA), Y.encodeStateVector(deleteB),
      'the regression fixture must use identical vectors with different delete sets');
    const firstDelete = await persistence.persistCollaborationYDoc('deletions', 1, deleteA, identity);
    assert.equal(firstDelete.persistenceDisposition, 'advanced');
    const mergedDeletes = await persistence.persistCollaborationYDoc('deletions', 1, deleteB, identity);
    assert.equal(mergedDeletes.persistenceDisposition, 'merged');
    assert.equal(mergedDeletes.incomingNeedsReconcile, true);
    assert.equal(textFromUpdate(mergedDeletes.yjsState), 'C', 'both deletion sets survive the union');

    await insertState('fences', base);
    await assert.rejects(
      persistence.persistCollaborationYDoc('fences', 2, advancedDoc, identity),
      persistence.CollaborationStateStaleError,
    );
    for (const mismatch of [
      { workspaceId: 'another-workspace' },
      { organizationId: 'another-organization' },
      { path: 'another.md' },
      { representation: 'tiptap_xml' as const },
      { schemaVersion: 2 },
    ]) {
      await assert.rejects(
        persistence.persistCollaborationYDoc('fences', 1, advancedDoc, { ...identity, ...mismatch }),
        persistence.CollaborationStateStaleError,
      );
    }
    assert.equal(Number((await row('fences')).document_sequence), 0, 'failed scope/generation fences leave SQL unchanged');
    await setup.run("UPDATE collaboration_yjs_states SET status='archived' WHERE document_id='fences'");
    await assert.rejects(
      persistence.persistCollaborationYDoc('fences', 1, advancedDoc, identity),
      persistence.CollaborationStateInactiveError,
    );

    const captureBase = own(new Y.Doc());
    captureBase.getText('content').insert(0, 'A');
    await insertState('capture', captureBase);
    const delayed = own(cloneDoc(captureBase));
    delayed.getText('content').insert(1, 'B');
    const newer = own(cloneDoc(delayed));
    newer.getText('content').insert(2, 'C');
    let releaseDelayed!: () => void;
    const delayedGate = new Promise<void>((resolve) => { releaseDelayed = resolve; });
    plans.push({ beforeReturn: delayedGate });
    const delayedPersist = persistence.persistCollaborationYDoc('capture', 1, delayed, identity);
    delayed.getText('content').insert(2, 'X');
    const newerPersisted = await persistence.persistCollaborationYDoc('capture', 1, newer, identity);
    assert.equal(newerPersisted.persistenceDisposition, 'advanced');
    releaseDelayed();
    const delayedResult = await delayedPersist;
    assert.equal(delayedResult.persistenceDisposition, 'unchanged');
    assert.equal(delayedResult.incomingNeedsReconcile, true);
    assert.equal(delayedResult.documentSequence, 1);
    assert.equal(textFromUpdate((await row('capture')).yjs_state), 'ABC',
      'the delayed call uses its pre-await AB snapshot and cannot merge the later X mutation or overwrite ABC');

    const beginBase = own(new Y.Doc());
    beginBase.getText('content').insert(0, 'begin-base');
    await insertState('begin-reply', beginBase);
    const beginAdvance = own(cloneDoc(beginBase));
    beginAdvance.getText('content').insert(10, '-advance');
    plans.push({
      run: async (sql, _params, next) => {
        if (normalizedSql(sql) === 'BEGIN') {
          await next();
          throw new Error('injected lost begin reply');
        }
        return next();
      },
    });
    await assert.rejects(
      persistence.persistCollaborationYDoc('begin-reply', 1, beginAdvance, identity),
      /injected lost begin reply/u,
    );
    assert.equal(Number((await row('begin-reply')).document_sequence), 0,
      'a lost BEGIN reply is rolled back because the transaction is treated as open before awaiting BEGIN');

    const rollbackBase = own(new Y.Doc());
    rollbackBase.getText('content').insert(0, 'base');
    await insertState('rollback', rollbackBase);
    const rollbackAdvance = own(cloneDoc(rollbackBase));
    rollbackAdvance.getText('content').insert(4, '-advance');
    plans.push({
      get: async (sql, _params, next) => {
        if (normalizedSql(sql).startsWith('UPDATE COLLABORATION_YJS_STATES SET YJS_STATE')) {
          throw new Error('injected persistence update failure');
        }
        return next();
      },
    });
    await assert.rejects(
      persistence.persistCollaborationYDoc('rollback', 1, rollbackAdvance, identity),
      /injected persistence update failure/u,
    );
    assert.equal(Number((await row('rollback')).document_sequence), 0);
    assert.equal(textFromUpdate((await row('rollback')).yjs_state), 'base', 'the failed SQL mutation is rolled back');

    const commitFailureClose: Array<Error | undefined> = [];
    plans.push({
      closeArguments: commitFailureClose,
      run: async (sql, _params, next) => {
        if (normalizedSql(sql) === 'COMMIT') throw new Error('injected commit failure');
        return next();
      },
    });
    await assert.rejects(
      persistence.persistCollaborationYDoc('rollback', 1, rollbackAdvance, identity),
      /injected commit failure/u,
    );
    assert.equal(Number((await row('rollback')).document_sequence), 0, 'a definite pre-commit failure rolls back');
    assert.equal(commitFailureClose.length, 1);
    assert.ok(commitFailureClose[0] instanceof Error,
      'any failed COMMIT reply discards the connection even when the following rollback succeeds');

    const lostCommitRollbackSucceededClose: Array<Error | undefined> = [];
    plans.push({
      closeArguments: lostCommitRollbackSucceededClose,
      run: async (sql, _params, next) => {
        if (normalizedSql(sql) === 'COMMIT') {
          await next();
          throw new Error('injected lost commit reply with successful rollback response');
        }
        return next();
      },
    });
    await assert.rejects(
      persistence.persistCollaborationYDoc('rollback', 1, rollbackAdvance, identity),
      /injected lost commit reply with successful rollback response/u,
    );
    assert.equal(lostCommitRollbackSucceededClose.length, 1);
    assert.ok(lostCommitRollbackSucceededClose[0] instanceof Error,
      'a successful rollback response cannot make an earlier failed COMMIT reply safe to pool');
    assert.equal(Number((await row('rollback')).document_sequence), 1,
      'the lost reply fixture committed, even though the caller correctly received no acknowledgement');
    const retryAfterSuccessfulRollbackReply = await persistence.persistCollaborationYDoc(
      'rollback', 1, rollbackAdvance, identity,
    );
    assert.equal(retryAfterSuccessfulRollbackReply.persistenceDisposition, 'unchanged');
    assert.equal(retryAfterSuccessfulRollbackReply.documentSequence, 1,
      'retry after an indeterminate commit remains idempotent');

    const rollbackAdvanceTwo = own(cloneDoc(rollbackAdvance));
    rollbackAdvanceTwo.getText('content').insert(12, '-second');
    const lostCommitClose: Array<Error | undefined> = [];
    plans.push({
      closeArguments: lostCommitClose,
      run: async (sql, _params, next) => {
        if (normalizedSql(sql) === 'COMMIT') {
          await next();
          throw new Error('injected lost commit reply');
        }
        if (normalizedSql(sql) === 'ROLLBACK') throw new Error('injected rollback failure after commit');
        return next();
      },
    });
    await assert.rejects(
      persistence.persistCollaborationYDoc('rollback', 1, rollbackAdvanceTwo, identity),
      AggregateError,
    );
    assert.equal(lostCommitClose.length, 1);
    assert.ok(lostCommitClose[0] instanceof Error, 'an unresolved rollback discards rather than releases the connection');
    assert.equal(Number((await row('rollback')).document_sequence), 2,
      'the lost reply fixture committed, even though the caller correctly received no acknowledgement');
    const retry = await persistence.persistCollaborationYDoc('rollback', 1, rollbackAdvanceTwo, identity);
    assert.equal(retry.persistenceDisposition, 'unchanged');
    assert.equal(retry.incomingNeedsReconcile, false);
    assert.equal(retry.documentSequence, 2, 'retry after an indeterminate commit is idempotent');

    assert.equal(plans.length, 0, 'every injected connection plan was consumed');
    console.log(
      'PGlite persistence store: advance/equal/ancestor, divergent unions, pure deletions, identity fences, '
      + 'pre-await capture, rollback, connection discard and indeterminate-commit retry passed. '
      + 'PGlite serializes access, so row-lock concurrency is intentionally not claimed here.',
    );
  } finally {
    for (const doc of ownedDocs) doc.destroy();
    await database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
