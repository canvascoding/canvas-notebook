import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { WORKSPACE_OPERATION_JOURNAL_STATEMENTS } from '../app/lib/db/workspace-operation-journal-migration';
import type { SqlConnection } from '../app/lib/db';
import {
  WorkspaceOperationJournal,
  WorkspaceOperationJournalConflictError,
  WorkspaceOperationJournalUncertainCommitError,
} from '../app/lib/files/workspace-operation-journal';

type CommitFault = 'none' | 'before' | 'after';

async function harness() {
  const postgres = new PGlite();
  for (const statement of WORKSPACE_OPERATION_JOURNAL_STATEMENTS) await postgres.query(statement);
  for (const statement of WORKSPACE_OPERATION_JOURNAL_STATEMENTS) await postgres.query(statement);
  let nextFault: CommitFault = 'none';
  let discarded = 0;
  let opened = 0;
  const openConnection = async (): Promise<SqlConnection> => {
    opened += 1;
    return {
      get: async (sql, params) => (await postgres.query(sql, params)).rows[0],
      all: async (sql, params) => (await postgres.query(sql, params)).rows,
      run: async (sql, params) => {
        if (sql === 'COMMIT' && nextFault !== 'none') {
          const fault = nextFault;
          nextFault = 'none';
          if (fault === 'after') await postgres.query(sql);
          throw new Error(`synthetic ${fault} COMMIT failure`);
        }
        const result = await postgres.query(sql, params);
        return { changes: result.affectedRows ?? 0 };
      },
      close: async (error) => {
        if (error) {
          discarded += 1;
          // An unacknowledged COMMIT makes the backend unsafe. The test adapter
          // ends the still-open transaction before a new logical connection.
          if (nextFault === 'none') {
            try { await postgres.query('ROLLBACK'); } catch { /* already committed */ }
          }
        }
      },
    };
  };
  return {
    postgres,
    journal: new WorkspaceOperationJournal({ openConnection }),
    fault: (fault: CommitFault) => { nextFault = fault; },
    metrics: () => ({ discarded, opened }),
    close: () => postgres.close(),
  };
}

const prepareInput = {
  operationId: 'operation-1234567890',
  planId: 'a'.repeat(64),
  request: { kind: 'rename' as const, selections: [{ destinationPath: 'new.md', sourcePath: 'old.md' }] },
  actor: { type: 'user', id: 'owner' } as const,
  sourceWorkspaceId: 'workspace-a',
  destinationWorkspaceId: 'workspace-a',
  expectedStepCount: 2,
};

const pathStep = {
  operationId: prepareInput.operationId,
  stepKey: 'path:old.md',
  phase: 'path' as const,
  beforeFence: 'sha256:before',
  afterFence: 'sha256:after',
  backupRef: 'durable-backup:123',
};

const linkStep = {
  operationId: prepareInput.operationId,
  stepKey: 'link:notes.md',
  phase: 'link' as const,
  beforeFence: 'sha256:link-before',
  afterFence: 'sha256:link-after',
};

async function idempotencyAndRecovery() {
  const h = await harness();
  try {
    await assert.rejects(h.journal.prepare({ ...prepareInput, request: {
      ...prepareInput.request, previewContents: [{ path: 'old.md', content: 'must not persist' }],
    } as never }), /only kind and one or more path selections/u);
    const prepared = await h.journal.prepare(prepareInput);
    assert.equal(prepared.status, 'prepared');
    assert.equal((await h.journal.prepare({ ...prepareInput, request: {
      selections: [{ sourcePath: 'old.md', destinationPath: 'new.md' }], kind: 'rename',
    } })).operationId, prepared.operationId, 'canonical JSON gives an exact idempotency match');
    await assert.rejects(h.journal.prepare({ ...prepareInput, planId: 'b'.repeat(64) }), WorkspaceOperationJournalConflictError);

    const intent = await h.journal.beginStep(pathStep);
    assert.equal(intent.status, 'intent');
    assert.equal((await h.journal.beginStep(pathStep)).status, 'intent');
    await assert.rejects(h.journal.beginStep({ ...pathStep, afterFence: 'other' }), WorkspaceOperationJournalConflictError);
    await assert.rejects(h.journal.beginStep(linkStep), WorkspaceOperationJournalConflictError,
      'links cannot start before the path mutation is proven');

    h.fault('after');
    const appliedPath = await h.journal.finishStep({ ...pathStep, receipt: { status: 'applied', afterSha256: 'after' } });
    assert.equal(appliedPath.status, 'applied', 'lost COMMIT acknowledgement is recovered from exact step receipt');
    assert.equal(h.metrics().discarded, 1);
    assert.equal((await h.journal.finishStep({ ...pathStep, receipt: { afterSha256: 'after', status: 'applied' } })).status, 'applied');
    await assert.rejects(h.journal.finishStep({ ...pathStep, receipt: { status: 'different' } }), WorkspaceOperationJournalConflictError);
    await assert.rejects(h.journal.complete(prepareInput.operationId), WorkspaceOperationJournalConflictError);

    h.fault('after');
    assert.equal((await h.journal.beginStep(linkStep)).status, 'intent');
    h.fault('before');
    await assert.rejects(h.journal.finishStep({ ...linkStep, receipt: { status: 'applied' } }), WorkspaceOperationJournalUncertainCommitError,
      'rejected COMMIT cannot be reported as a completed external step');
    assert.equal((await h.journal.get(prepareInput.operationId))?.steps[1]?.status, 'intent');
    assert.equal((await h.journal.finishStep({ ...linkStep, receipt: { status: 'applied' } })).status, 'applied',
      'a later explicit retry may record a previously verified external effect');

    h.fault('after');
    const completed = await h.journal.complete(prepareInput.operationId);
    assert.equal(completed.status, 'completed');
    assert.equal((await h.journal.complete(prepareInput.operationId)).status, 'completed');
    assert.equal((await h.journal.get(prepareInput.operationId))?.steps.length, 2);
    await assert.rejects(h.journal.fail({ operationId: prepareInput.operationId, errorCode: 'too_late', recoveryRequired: true }), WorkspaceOperationJournalConflictError);
    assert.ok(h.metrics().opened > h.metrics().discarded, 'recovery uses a fresh logical connection');
  } finally {
    await h.close();
  }
}

async function prepareAndFailureCommitRecovery() {
  const h = await harness();
  try {
    h.fault('before');
    await assert.rejects(h.journal.prepare(prepareInput), WorkspaceOperationJournalUncertainCommitError);
    assert.equal(await h.journal.get(prepareInput.operationId), null,
      'rejected prepare COMMIT has no durable request receipt');

    h.fault('after');
    const prepared = await h.journal.prepare(prepareInput);
    assert.equal(prepared.status, 'prepared');
    h.fault('after');
    const failed = await h.journal.fail({ operationId: prepareInput.operationId, errorCode: 'stale_plan', recoveryRequired: false });
    assert.equal(failed.status, 'failed');
    assert.equal((await h.journal.fail({ operationId: prepareInput.operationId, errorCode: 'stale_plan', recoveryRequired: false })).status, 'failed');
    await assert.rejects(h.journal.beginStep(pathStep), WorkspaceOperationJournalConflictError);
  } finally {
    await h.close();
  }
}

async function restartFromIntent() {
  const h = await harness();
  try {
    await h.journal.prepare(prepareInput);
    await h.journal.beginStep(pathStep);
    // Simulate a process restart after the filesystem changed but before the
    // receipt was persisted. The new journal instance sees the durable intent.
    const restarted = new WorkspaceOperationJournal({
      openConnection: async () => ({
        get: async (sql, params) => (await h.postgres.query(sql, params)).rows[0],
        all: async (sql, params) => (await h.postgres.query(sql, params)).rows,
        run: async (sql, params) => { await h.postgres.query(sql, params); return { changes: 0 }; },
        close: async () => {},
      }),
    });
    const recovered = await restarted.get(prepareInput.operationId);
    assert.equal(recovered?.status, 'running');
    assert.equal(recovered?.steps[0]?.status, 'intent');
    assert.equal(recovered?.steps[0]?.afterFence, pathStep.afterFence);
    assert.equal((await restarted.beginStep(pathStep)).status, 'intent', 'same intent is never duplicated');
    assert.equal((await restarted.finishStep({ ...pathStep, receipt: { status: 'already-applied' } })).status, 'applied');
    const needsRecovery = await restarted.fail({ operationId: prepareInput.operationId, errorCode: 'link_write_failed', recoveryRequired: true });
    assert.equal(needsRecovery.status, 'recovery_required');
    assert.equal(needsRecovery.phase, 'path');
    assert.equal((await restarted.get(prepareInput.operationId))?.steps[0]?.backupRef, pathStep.backupRef);
    await assert.rejects(restarted.resume({ operationId: prepareInput.operationId, expectedRevision: needsRecovery.revision - 1 }),
      WorkspaceOperationJournalConflictError);
    const resumed = await restarted.resume({ operationId: prepareInput.operationId, expectedRevision: needsRecovery.revision });
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.errorCode, null);
    assert.equal((await restarted.beginStep(linkStep)).status, 'intent');
  } finally {
    await h.close();
  }
}

async function main(): Promise<void> {
  await idempotencyAndRecovery();
  await prepareAndFailureCommitRecovery();
  await restartFromIntent();
  console.log('workspace-operation-journal-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
