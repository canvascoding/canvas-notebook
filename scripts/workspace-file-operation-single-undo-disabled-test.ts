import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_JOURNAL_STATEMENTS } from '../app/lib/db/workspace-operation-journal-migration';
import { WorkspaceOperationJournal, serializeWorkspaceOperationRequest, type WorkspaceOperationWithSteps } from '../app/lib/files/workspace-operation-journal';
import { createWorkspaceFileOperationExecutor } from '../app/lib/files/workspace-file-operation-executor';
import { operationUndoId } from '../app/lib/files/workspace-operation-undo';
import { WorkspaceFileUndoDisabledError } from '../app/lib/files/workspace-file-undo-policy';
import type { WorkspaceOperationStage } from '../app/lib/files/workspace-operation-staging';
import type { WorkspaceFileOperationPreview } from '../app/lib/markdown/workspace-file-operation-planner';

const planId = 'a'.repeat(64);
const request = { kind: 'rename' as const, selections: [{ sourcePath: 'before.txt', destinationPath: 'after.txt' }] };
const input = (operationId: string) => ({ operationId, planId, request, actor: { type: 'user' as const, id: 'owner' },
  sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace', expectedStepCount: 1 });
const disabled = (error: unknown) => error instanceof WorkspaceFileUndoDisabledError
  && error.status === 409 && error.code === 'FILE_OPERATION_UNDO_DISABLED';

async function embedded<T>(operation: (value: { postgres: PGlite; journal: WorkspaceOperationJournal }) => Promise<T>) {
  const postgres = new PGlite();
  try {
    for (const statement of WORKSPACE_OPERATION_JOURNAL_STATEMENTS) await postgres.query(statement);
    const journal = new WorkspaceOperationJournal({ openConnection: async (): Promise<SqlConnection> => ({
      get: async (sql, values) => (await postgres.query(sql, values)).rows[0],
      all: async (sql, values) => (await postgres.query(sql, values)).rows,
      run: async (sql, values) => ({ changes: (await postgres.query(sql, values)).affectedRows ?? 0 }),
      close: async () => undefined,
    }) });
    return await operation({ postgres, journal });
  } finally { await postgres.close(); }
}

function executorFixture(operationId: string, journal: Parameters<typeof createWorkspaceFileOperationExecutor>[0]['journal']) {
  const events: string[] = [];
  let pathState: 'before' | 'after' = 'before';
  const preview: WorkspaceFileOperationPreview = { contractVersion: 1, planId, kind: 'rename', status: 'planned',
    readiness: 'ready', issues: [], recoveryReady: true, collisions: [], pathMappings: [], linkEdits: [], previewContents: [],
    expectedPathState: [], coverage: { complete: true, omittedSources: [], unresolvedLinks: [] } };
  const identity = { operationId, planId, sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace' };
  const stage: WorkspaceOperationStage = { identity, preview, originalDocuments: [], payloadSha256: 'b'.repeat(64), linkPreflight: null };
  const executor = createWorkspaceFileOperationExecutor({ journal,
    staging: { stage: async () => { events.push('stage'); return stage; },
      load: async () => { events.push('load'); return stage; }, removeCompleted: async () => { events.push('remove'); } },
    adapters: { rebuildPlan: async () => { events.push('rebuild'); return preview; },
      path: { probe: async () => { events.push('probe'); return pathState; },
        apply: async () => { events.push('apply'); pathState = 'after'; return { kind: 'rename' }; } },
      links: { preflight: async () => { events.push('preflight'); return null; },
        probe: async () => { events.push('link-probe'); return 'before'; }, apply: async () => { events.push('link-apply'); } } },
  });
  return { executor, identity, events, executeInput: { ...input(operationId), preview, originalDocuments: [] } };
}

function stored(operationId: string, status: WorkspaceOperationWithSteps['status']): WorkspaceOperationWithSteps {
  return { ...input(operationId), ...serializeWorkspaceOperationRequest(request), status,
    phase: status === 'completed' ? 'completed' : 'prepared', revision: 1, errorCode: null, createdAt: 1, updatedAt: 1, steps: [] };
}
function guardedPort(record: WorkspaceOperationWithSteps, lookup?: (operationId: string) => Promise<boolean>) {
  const events: string[] = [];
  const forbidden = async (): Promise<never> => { events.push('mutation'); throw new Error('Unexpected journal mutation.'); };
  const journal = { get: async () => { events.push('get'); return record; }, prepare: forbidden, beginStep: forbidden,
    finishStep: forbidden, complete: forbidden, fail: forbidden, resume: forbidden,
    ...(lookup ? { isSingleUndoOperation: async (operationId: string) => { events.push('lookup'); return lookup(operationId); } } : {}) };
  return { journal, events };
}

test('actual SQL digest equals operationUndoId/JSON.stringify for ASCII, Unicode, line separators and escaping', async () => {
  await embedded(async ({ postgres, journal }) => {
    const originals = ['original-operation_1234', '01234567-89ab-cdef-0123-456789abcdef',
      'interne-Original-ID-ä界', 'interne-Original-ID-🦊', 'interne-Original-ID-\u2028\u2029',
      'interne-Original-ID-"quoted"', 'interne-Original-ID-\\backslash',
      'interne-Original-ID-\b\f\n\r\t\u001f', 'x'.repeat(128)];
    for (const originalId of originals) {
      await journal.prepare(input(originalId));
      const row = (await postgres.query<{ compact: string }>(`SELECT '["workspace-operation-undo-v1",' || pg_catalog.to_json(operation_id)::text || ']' AS compact
        FROM workspace_file_operations WHERE operation_id=$1`, [originalId])).rows[0];
      assert.equal(row.compact, JSON.stringify(['workspace-operation-undo-v1', originalId]));
      assert.equal(await journal.isSingleUndoOperation(operationUndoId(originalId)), true, originalId);
      assert.equal(await journal.isSingleUndoOperation(createHash('sha256').update(JSON.stringify(['other-namespace', originalId])).digest('hex')), false);
    }
    assert.equal(await journal.isSingleUndoOperation('f'.repeat(64)), false);
  });
});

test('exact SQL lookup is independent of original status, actor, workspace and inverse request shape', async () => {
  await embedded(async ({ postgres, journal }) => {
    const originalId = 'original-operation-for-status'; await journal.prepare(input(originalId));
    for (const [index, status] of ['prepared', 'running', 'completed', 'failed', 'recovery_required'].entries()) {
      await postgres.query(`UPDATE workspace_file_operations SET status=$2,actor_type='system',actor_id=$3,
        source_workspace_id=$4,destination_workspace_id=$5,request_json=$6 WHERE operation_id=$1`,
      [originalId, status, `changed-${index}`, `source-${index}`, `target-${index}`, JSON.stringify({ kind: 'copy', selections: [] })]);
      assert.equal(await journal.isSingleUndoOperation(operationUndoId(originalId)), true, status);
    }
  });
});

test('mathematically impossible non-lowercase-SHA IDs need no checkout', async () => {
  let opened = 0;
  const journal = new WorkspaceOperationJournal({ openConnection: async () => { opened++; throw new Error('Unexpected checkout.'); } });
  for (const id of ['ordinary-operation-123456', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    assert.equal(await journal.isSingleUndoOperation(id), false);
  }
  assert.equal(opened, 0);
});

test('lookup errors and malformed SQL booleans propagate, with each opened connection closed', async () => {
  const primary = new Error('Original lookup unavailable.');
  for (const outcome of [primary, undefined, {}, { is_undo: null }, { is_undo: 'false' }]) {
    let closed = 0;
    const journal = new WorkspaceOperationJournal({ openConnection: async () => ({
      get: async () => { if (outcome === primary) throw primary; return outcome; },
      all: async () => [], run: async () => ({ changes: 0 }), close: async () => { closed++; },
    }) });
    await assert.rejects(journal.isSingleUndoOperation('a'.repeat(64)), error => outcome === primary ? error === primary : error instanceof Error);
    assert.equal(closed, 1);
  }
});

test('stored inverse recover is disabled before header, stage, cleanup, probes or mutations for every journal status', async () => {
  const operationId = operationUndoId('original-operation-123456');
  for (const status of ['prepared', 'running', 'completed', 'failed', 'recovery_required'] as const) {
    const port = guardedPort(stored(operationId, status), async actual => { assert.equal(actual, operationId); return true; });
    const fixture = executorFixture(operationId, port.journal);
    await assert.rejects(fixture.executor.recover(fixture.identity), disabled);
    assert.deepEqual(port.events, ['lookup']); assert.deepEqual(fixture.events, []);
  }
});

test('execute(existing) reaches the same disabled boundary without retiring a completed inverse stage', async () => {
  const operationId = operationUndoId('original-operation-123456');
  for (const status of ['prepared', 'completed', 'recovery_required'] as const) {
    const port = guardedPort(stored(operationId, status), async () => true), fixture = executorFixture(operationId, port.journal);
    await assert.rejects(fixture.executor.execute(fixture.executeInput), disabled);
    assert.deepEqual(port.events, ['get', 'lookup']); assert.deepEqual(fixture.events, []);
  }
});

test('digest ports without the lookup and lookup failures fail closed before all recovery side effects', async () => {
  const operationId = 'a'.repeat(64), primary = new Error('Original lookup unavailable.');
  for (const lookup of [undefined, async (): Promise<boolean> => { throw primary; }]) {
    const port = guardedPort(stored(operationId, 'prepared'), lookup), fixture = executorFixture(operationId, port.journal);
    await assert.rejects(fixture.executor.recover(fixture.identity), error => lookup ? error === primary
      : error instanceof Error && Reflect.get(error, 'code') === 'OPERATION_ID_CONFLICT');
    assert.deepEqual(port.events, lookup ? ['lookup'] : []); assert.deepEqual(fixture.events, []);
  }
});

test('ordinary lowercase-SHA operation still completes a real embedded journal recovery', async () => {
  await embedded(async ({ journal }) => {
    await journal.prepare(input('unrelated-original-operation'));
    const operationId = 'c'.repeat(64); assert.equal(await journal.isSingleUndoOperation(operationId), false);
    await journal.prepare(input(operationId)); const fixture = executorFixture(operationId, journal);
    const result = await fixture.executor.recover(fixture.identity);
    assert.equal(result.status, 'complete'); assert.equal(result.errorCode, null);
    assert.equal(fixture.events.filter(event => event === 'apply').length, 1);
    const record = await journal.get(operationId); assert.equal(record?.status, 'completed');
    assert.equal(record?.steps.length, 1); assert.equal(record?.steps[0].status, 'applied');
  });
});
