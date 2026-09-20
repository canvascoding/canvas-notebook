/**
 * FVRC-1004 storage gate. The orchestrator keeps durable apply injected, while
 * this PGlite run exercises the real migrated graph store it relies on: reserve
 * receipts, exact retry identity, stale-proof rejection, atomic lifecycle
 * finalization and ordered revision bindings. Live Yjs room application remains
 * intentionally outside this controlled storage boundary until runtime wiring.
 */
import assert from 'node:assert/strict';

import { buildProposalActionFence, signProposalActionFence, type ProposalFenceState } from '../app/lib/file-version-center/proposal-action-fence';
import { createProposalActionOrchestrator } from '../app/lib/file-version-center/proposal-action-orchestrator';
import { createProposalGraphStorage } from '../app/lib/file-version-center/proposal-storage';
import { createProposalGraphStorageTestDatabase, prepareStoredChain, runProposalGraphStorageSuite } from './proposal-graph-storage-test';

const secret = 'pglite-orchestrator-signing-secret-32-bytes';
const now = 50_000;

async function main() {
  const database = await createProposalGraphStorageTestDatabase();
  try {
    await runProposalGraphStorageSuite(database);
    const storage = createProposalGraphStorage({ database, now: () => now, createId: (() => { let id = 0; return () => `pglite-ref-${++id}`; })() });
    const chain = await storage.withLockedGraph({ workspaceId: 'proposal-workspace', lineageId: 'proposal-lineage', documentId: 'proposal-document', lifecycleGeneration: 1, schemaVersion: 1 }, {}, async (transaction) => {
      const prepared = await prepareStoredChain(transaction);
      await transaction.insertProposal(prepared.parent); await transaction.insertProposal(prepared.child);
      return prepared;
    });
    const scope = chain.parent.scope;
    const current = chain.parent.source.current;
    const graph = await storage.withLockedGraph(scope, {}, async (transaction) => {
      const loaded = await transaction.loadGraph();
      await transaction.putEvaluation({ contractVersion: 1, evaluationId: 'pglite-evaluation', proposalId: chain.child.proposalId, scope, current,
        graphRevision: loaded.graphRevision, status: 'clean', reasonCode: null, effectiveCandidate: chain.child.authoredCandidate.cumulativeCandidate,
        anchorMap: chain.child.source.anchorMap, effectPreconditions: chain.child.authoredCandidate.effectPreconditions, evaluatedAt: now, expiresAt: now + 5_000 });
      return loaded;
    });
    const state: ProposalFenceState = { scope, actor: { userId: 'proposal-owner', actorId: 'reviewer', authorizationRevision: 'access-1' }, actionType: 'accept',
      current, graphRevision: graph.graphRevision, evaluationId: 'pglite-evaluation', effectiveCandidateHash: chain.child.authoredCandidate.cumulativeCandidate.sha256,
      closure: [chain.parent, chain.child].map((node) => ({ proposalId: node.proposalId, casVersion: node.casVersion, candidateHash: node.authoredCandidate.cumulativeCandidate.sha256 })),
      selectedProposalIds: [chain.child.proposalId], applyProposalIds: [chain.parent.proposalId, chain.child.proposalId], choiceResolutions: [] };
    const fence = buildProposalActionFence({ state, fenceId: 'pglite-fence', now, expiresAt: now + 1_000 });
    const request = { contractVersion: 1 as const, fence, fenceToken: signProposalActionFence(fence, secret), idempotencyKey: 'pglite-orchestrator-key-0001', creation: null };
    let applied = 0;
    let loseFirstDurableResponse = true;
    let actionNumber = 0;
    const orchestrator = createProposalActionOrchestrator({
      withLockedGraph: (actionScope, options, action) => storage.withLockedGraph(actionScope, options, action),
      authorize: async () => state.actor, readCurrent: async () => current, signingSecret: secret, now: () => now, createId: () => actionNumber++ === 0 ? 'pglite-action' : `pglite-action-retry-${actionNumber}`, materializeCreation: async () => { throw new Error('not used'); },
      prepareDurably: async ({ transaction, actionId }) => {
        await transaction.query(`INSERT INTO collaboration_agent_operations (operation_id,document_id,workspace_id,document_lifecycle_generation,schema_version,initiated_by_user_id,actor_id,idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at)
          VALUES ($1,'proposal-document','proposal-workspace',1,1,'proposal-owner','reviewer','pglite-durable-key',$2,'applying',$3,$4,$4)`,
        [actionId, 'd'.repeat(64), Buffer.from([1]), now]);
      },
      applyDurably: async ({ actionId, candidate }) => {
        assert.deepEqual(candidate.update, await storage.withLockedGraph(scope, {},
          (transaction) => transaction.readArtifact(chain.child.authoredCandidate.cumulativeCandidate)));
        applied++;
        await database.query(`INSERT INTO file_revisions (id,workspace_id,workspace_type,path,content_hash,size_bytes,created_by_actor_type,lineage_id,revision_number,created_at)
          VALUES ('pglite-revision','proposal-workspace','personal','shipping.md',$1,1,'agent','proposal-lineage',99,$2)`, [chain.child.authoredCandidate.cumulativeCandidate.sha256, now]);
        await database.query(`UPDATE collaboration_agent_operations SET status='persisted_yjs',version_revision_id='pglite-revision',resulting_state_snapshot=$2,persisted_at=$3,updated_at=$3 WHERE operation_id=$1`, [actionId, Buffer.from([1]), now]);
        if (loseFirstDurableResponse) {
          loseFirstDurableResponse = false;
          throw new Error('simulated process loss after durable operation');
        }
        return { operationId: actionId, revisionId: 'pglite-revision', current: { ...current, revisionId: 'pglite-revision' } };
      },
      recoverDurably: async ({ actionId }) => ({ operationId: actionId, revisionId: 'pglite-revision',
        current: { ...current, revisionId: 'pglite-revision' } }),
    });
    await assert.rejects(orchestrator.execute(request), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
    const pending = await storage.withLockedGraph(scope, { actionId: 'pglite-action' },
      (transaction) => transaction.getAction('pglite-action'));
    assert.equal(pending?.phase, 'recovery_required');
    const succeeded = await orchestrator.recover(scope, 'pglite-action');
    assert.equal(succeeded.phase, 'succeeded'); assert.equal(applied, 1);
    assert.equal((await orchestrator.execute(request)).actionId, succeeded.actionId); assert.equal(applied, 1);
    const bindings = await database.query<{ proposal_id: string }>(`SELECT proposal_id FROM file_revision_proposal_bindings WHERE revision_id='pglite-revision' ORDER BY application_order`);
    assert.deepEqual(bindings.rows.map((row) => row.proposal_id), ['stored-p1', 'stored-p2']);
    console.log(`proposal action orchestrator storage gate: ok (${database.kind})`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
