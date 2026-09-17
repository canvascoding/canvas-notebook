import assert from 'node:assert/strict';
import { Pool } from 'pg';
import * as Y from 'yjs';

import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import {
  parseProposalActionFenceV1,
  parseProposalActionReceiptV1,
  parseProposalNodeV1,
  type ProposalArtifactReferenceV1,
  type ProposalDocumentScopeV1,
  type ProposalNodeV1,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { createProposalGraphStorage } from '../app/lib/file-version-center/proposal-storage';
import {
  createProposalGraphStorageTestDatabase,
  runProposalGraphStorageSuite,
} from './proposal-graph-storage-test';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function errorCode(expected: string) {
  return (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'code' in error);
    assert.equal(error.code, expected);
    return true;
  };
}

/** Each adapter owns its own Pool/connection; lock_timeout bounds actual server contention. */
function transactionDatabase(pool: Pool, lockTimeout?: string): FileVersionCenterDatabase {
  return {
    async transaction(action) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        if (lockTimeout) await connection.query("SELECT set_config('lock_timeout', $1, true)", [lockTimeout]);
        const result = await action({
          query: async <Row>(sql: string, params?: unknown[]) => {
            const response = await connection.query(sql, params);
            return { rows: response.rows as Row[], rowCount: response.rowCount };
          },
        });
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

const scope: ProposalDocumentScopeV1 = {
  workspaceId: 'proposal-workspace', lineageId: 'proposal-lineage', documentId: 'proposal-document',
  lifecycleGeneration: 1, schemaVersion: 1,
};

function reference(value: ProposalArtifactReferenceV1): ProposalArtifactReferenceV1 {
  return { ref: value.ref, sha256: value.sha256, sizeBytes: value.sizeBytes };
}

async function runConcurrencyScenarios(databaseUrl: string): Promise<void> {
  const firstPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const secondPool = new Pool({ connectionString: databaseUrl, max: 1 });
  let firstPoolClosed = false;
  let restartedPool: Pool | undefined;
  const first = createProposalGraphStorage({ database: transactionDatabase(firstPool), now: () => 1_000 });
  const second = createProposalGraphStorage({ database: transactionDatabase(secondPool, '100ms'), now: () => 1_000 });
  try {
    const firstPid = (await firstPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const secondPid = (await secondPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    assert.notEqual(firstPid, secondPid, 'contenders must use different PostgreSQL backend connections');

    const node = await first.withLockedGraph(scope, {}, async (transaction): Promise<ProposalNodeV1> => {
      const document = new Y.Doc();
      document.clientID = 1_337;
      document.getText('test').insert(0, 'Original');
      const source = await transaction.putArtifact('yjs_full_update_v1', Y.encodeStateAsUpdate(document));
      document.getText('test').insert(8, ' with proposed edit');
      const candidate = await transaction.putArtifact('yjs_full_update_v1', Y.encodeStateAsUpdate(document));
      document.destroy();
      const anchors = reference(await transaction.putArtifact('json_v1', Buffer.from('{"target":"test"}')));
      const payload = reference(await transaction.putArtifact('json_v1', Buffer.from('{"insert":" with proposed edit"}')));
      const preconditions = reference(await transaction.putArtifact('json_v1', Buffer.from('{"original":"Original"}')));
      const proposal = parseProposalNodeV1({
        contractVersion: 1, proposalId: 'race-cas-proposal', operationId: 'proposal-operation-p1',
        scope, casVersion: 1, lifecycle: 'open', createdAt: 1_000, createdByActorId: 'main',
        source: {
          kind: 'authoritative', scope, snapshot: source, anchorMap: anchors,
          current: {
            revisionId: 'proposal-v0', contentHash: 'a'.repeat(64), structureHash: 'b'.repeat(64),
            stateVectorHash: 'c'.repeat(64), deleteSetHash: 'd'.repeat(64), fullStateHash: 'e'.repeat(64),
          },
        },
        relationships: { dependency: null, replacesProposalId: null, choiceGroupId: null },
        authoredCandidate: {
          incrementalPayload: payload, cumulativeCandidate: candidate, effectPreconditions: preconditions,
          sourceProofHash: 'f'.repeat(64),
        },
      });
      await transaction.insertProposal(proposal);
      return proposal;
    });

    const entered = deferred();
    const release = deferred();
    const heldTransaction = first.withLockedGraph(scope, {}, async (transaction) => {
      entered.resolve(); // withLockedGraph has completed its SELECT ... FOR UPDATE.
      await release.promise;
      return transaction.transitionProposal(node.proposalId, 1, 'rejected');
    });
    await Promise.race([
      entered.promise,
      heldTransaction.then(() => { throw new Error('Holding transaction ended before the barrier.'); }),
    ]);
    try {
      await assert.rejects(
        second.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph()),
        errorCode('55P03'),
        'second backend must hit PostgreSQL lock_timeout while the first owns the graph row',
      );
    } finally {
      release.resolve();
      await heldTransaction;
    }
    await assert.rejects(
      second.withLockedGraph(scope, {}, (transaction) => transaction.transitionProposal(node.proposalId, 1, 'expired')),
      errorCode('PROPOSAL_GRAPH_CHANGED'),
      'after the lock releases, stale CAS must not overwrite the winner',
    );
    const winner = await second.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(node.proposalId));
    assert.equal(winner?.lifecycle, 'rejected');
    assert.equal(winner.casVersion, 2);

    const pending = parseProposalNodeV1({ ...node, proposalId: 'race-reserved-proposal', operationId: 'proposal-operation-p2' });
    await first.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal(pending));
    const graph = await first.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph());
    const fence = parseProposalActionFenceV1({
      contractVersion: 1, fenceId: 'race-reject-fence', scope,
      actor: { userId: 'proposal-owner', actorId: 'main', authorizationRevision: 'scope-access-1' },
      actionType: 'reject', current: null, graphRevision: graph.graphRevision,
      evaluationId: null, effectiveCandidateHash: null,
      closure: [{ proposalId: pending.proposalId, casVersion: 1, candidateHash: pending.authoredCandidate.cumulativeCandidate.sha256 }],
      closureHash: '1'.repeat(64), selectedProposalIds: [pending.proposalId], applyProposalIds: [],
      batchHash: '2'.repeat(64), choiceResolutions: [], requestDigest: '3'.repeat(64),
      issuedAt: 1_000, expiresAt: 61_000,
    });
    const receipt = parseProposalActionReceiptV1({
      contractVersion: 1, actionId: 'race-pending-action', scope, actorId: 'proposal-owner', actionType: 'reject',
      requestDigest: fence.requestDigest, idempotencyKeyHash: '4'.repeat(64),
      affectedProposalIds: [pending.proposalId], operationId: null,
      createdAt: 1_000, updatedAt: 1_000, phase: 'prepared', result: null, errorCode: null,
    });
    const request = { fence, creation: null };
    await first.withLockedGraph(scope, { actionId: receipt.actionId }, (transaction) => transaction.reserveAction(receipt, request));
    const competing = { ...receipt, actionId: 'race-other-action', idempotencyKeyHash: '5'.repeat(64) };
    await assert.rejects(
      second.withLockedGraph(scope, { actionId: competing.actionId }, (transaction) => transaction.reserveAction(competing, request)),
      errorCode('PROPOSAL_RECOVERY_REQUIRED'),
      'a committed reservation blocks a different action even after its transaction ended',
    );

    await firstPool.end();
    firstPoolClosed = true;
    restartedPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const restarted = createProposalGraphStorage({ database: transactionDatabase(restartedPool), now: () => 100_000 });
    assert.deepEqual(await restarted.withLockedGraph(scope, { actionId: receipt.actionId },
      (transaction) => transaction.getAction(receipt.actionId)), receipt,
    'prepared receipt survives connection shutdown and a new service instance');
    assert.deepEqual(await restarted.withLockedGraph(scope, { actionId: receipt.actionId },
      (transaction) => transaction.getActionRequest(receipt.actionId)), request);
    await assert.rejects(
      restarted.withLockedGraph(scope, {}, (transaction) => transaction.transitionProposal(pending.proposalId, 1, 'rejected')),
      errorCode('PROPOSAL_RECOVERY_REQUIRED'),
      'service restart and approval expiry cannot release the persisted document reservation',
    );
    assert.deepEqual(await restarted.withLockedGraph(scope, { actionId: receipt.actionId },
      (transaction) => transaction.reserveAction(receipt, request)), receipt,
    'identical retry returns the same durable receipt');
    await assert.rejects(
      restarted.withLockedGraph(scope, { actionId: receipt.actionId }, (transaction) => transaction.reserveAction({
        ...receipt, requestDigest: '6'.repeat(64),
      }, { ...request, fence: { ...fence, requestDigest: '6'.repeat(64) } })),
      errorCode('PROPOSAL_IDEMPOTENCY_MISMATCH'),
      'the same idempotency scope cannot authorize a changed digest',
    );
    assert.equal((await restartedPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM file_proposal_action_receipts',
    )).rows[0]!.count, '1');
    assert.equal((await restarted.withLockedGraph(scope, { actionId: receipt.actionId },
      (transaction) => transaction.getProposal(pending.proposalId)))?.lifecycle, 'open',
    'storage reservation does not itself resolve or apply a proposal');
  } finally {
    await Promise.allSettled([firstPoolClosed ? undefined : firstPool.end(), secondPool.end(), restartedPool?.end()]);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.PROPOSAL_GRAPH_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Concurrency evidence requires PROPOSAL_GRAPH_TEST_DATABASE_URL pointing to isolated PostgreSQL.');
  const parsed = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^proposal_graph_test_[a-z0-9_]+$/u,
    'Concurrency tests refuse a database outside the proposal_graph_test_* namespace.');
  const database = await createProposalGraphStorageTestDatabase();
  try {
    assert.equal(database.kind, 'postgres');
    await runProposalGraphStorageSuite(database); // Refuses pre-existing schemas; preserves old fixture rows on migration rollback.
  } finally {
    await database.close();
  }
  await runConcurrencyScenarios(databaseUrl);
  console.log('proposal-graph-storage-concurrency-test: ok (distinct PostgreSQL backends, lock timeout, CAS, restart reservation, idempotency)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
