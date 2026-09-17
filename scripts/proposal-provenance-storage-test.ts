import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { createAgentTextTarget } from '../app/lib/collaboration/agent-operations';
import type { FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import { createProposalGraphStorage } from '../app/lib/file-version-center/proposal-storage';
import { createProposalProvenanceService, loadProposalNodeArtifacts } from '../app/lib/file-version-center/proposal-provenance-service';
import type { ProposalSourceProofV1, ProposalDocumentScopeV1, ProposalRelationshipsV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { seedProposalGraphStorageTestScope, type ProposalGraphStorageTestDatabase } from './proposal-graph-storage-test';

const scope: ProposalDocumentScopeV1 = { workspaceId: 'proposal-workspace', lineageId: 'proposal-lineage', documentId: 'proposal-document', lifecycleGeneration: 1, schemaVersion: 1 };
function declaration(source: ProposalSourceProofV1): ProposalToolEditV1 {
  return { contractVersion: 1, creationKind: source.kind === 'proposal' ? 'extends' : 'independent', source,
    expectedParentCasVersion: source.kind === 'proposal' ? source.proposalCasVersion : null,
    expectedParentCandidateHash: source.kind === 'proposal' ? source.candidateHash : null, replaces: null, choice: null };
}

async function main() {
  // Always in-memory. This fixture neither needs nor touches a running local stack.
  const pg = new PGlite();
  const db: ProposalGraphStorageTestDatabase = {
    kind: 'pglite', query: (sql, params) => pg.query(sql, params), exec: async (sql) => { await pg.exec(sql); },
    transaction: (action) => pg.transaction((sql) => action({ query: (statement, params) => sql.query(statement, params) })),
    close: () => pg.close(),
  };
  const live = createPlainTextYDoc('Insurance 50. Tail.');
  let sql: FileVersionCenterTransaction | null = null; let nextId = 0; let failAfterOperation = false;
  try {
    await runPostgresMigrations(db as unknown as Parameters<typeof runPostgresMigrations>[0]);
    await seedProposalGraphStorageTestScope(db);
    const storage = createProposalGraphStorage({ now: () => 1_000, createId: () => `pv-artifact-${++nextId}`,
      database: { transaction: (action) => db.transaction(async (tx) => {
        sql = tx; try { return await action(tx); } finally { sql = null; }
      }) } });
    const service = createProposalProvenanceService({ now: () => 1_000, createId: () => `pv-${++nextId}`, authorize: async () => {},
      withTransaction: (selected, action) => storage.withLockedGraph(selected, {}, (graph) => action({ graph,
        loadCurrent: async () => ({ scope, representation: 'plain_text', revisionId: 'proposal-v0', update: Y.encodeStateAsUpdate(live) }),
        lookupOperation: async ({ idempotencyKey, requestDigest }) => {
          const found = (await sql!.query<{ operation_id: string; proposal_id: string | null; payload_hash: string; authored_relationships: ProposalRelationshipsV1 }>(`
            SELECT operation.operation_id, operation.payload_hash, proposal.proposal_id, proposal.node_json->'relationships' AS authored_relationships
            FROM collaboration_agent_operations operation LEFT JOIN file_change_proposals proposal ON proposal.operation_id=operation.operation_id
            WHERE operation.document_id=$1 AND operation.idempotency_key=$2`, [scope.documentId, idempotencyKey])).rows[0];
          if (!found) return null;
          assert.equal(found.payload_hash, requestDigest); assert.ok(found.proposal_id, 'legacy operations cannot be adopted');
          return { operationId: found.operation_id, proposalId: found.proposal_id, authoredRelationships: found.authored_relationships };
        },
        insertPreparedOperation: async (prepared) => {
          assert.equal(prepared.reviewRequired, true);
          assert.match(prepared.beforeSha256, /^[a-f0-9]{64}$/); assert.match(prepared.proposedSha256, /^[a-f0-9]{64}$/);
          await sql!.query(`INSERT INTO collaboration_agent_operations
            (operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at)
            VALUES ($1,$2,$3,'proposal-owner','main',$4,$5,'needs_review',$6,1000,1000)`,
          [prepared.operationId, scope.documentId, scope.workspaceId, prepared.idempotencyKey, prepared.requestDigest, Buffer.from(prepared.sourceStateVector, 'base64')]);
          if (failAfterOperation) throw new Error('injected-after-operation');
        },
      })) });
    const create = async (source: ProposalSourceProofV1, key: string, oldText: string, replacement: string) => service.create({
      scope, actorId: 'main', idempotencyKey: key, proposal: declaration(source), mutation: { oldText, replacement },
      buildTargets: ({ update }) => {
        const scratch = new Y.Doc();
        try {
          Y.applyUpdate(scratch, update); const text = scratch.getText('content'); const at = text.toString().indexOf(oldText); assert.ok(at >= 0);
          return [createAgentTextTarget({ text, from: at, to: at + oldText.length, replacement })];
        } finally { scratch.destroy(); }
      },
    });
    const original = await service.readExact({ scope, proposalId: null });
    const parent = await create(original.metadata.source, 'provenance-parent-0001', '50', '100');
    const parentRead = await service.readExact({ scope, proposalId: parent.node.proposalId });
    assert.equal(parentRead.content, 'Insurance 100. Tail.');
    assert.equal(parentRead.metadata.source.kind, 'proposal');
    const child = await create(parentRead.metadata.source, 'provenance-child-0001', '100', '150');
    assert.equal((await service.readExact({ scope, proposalId: child.node.proposalId })).content, 'Insurance 150. Tail.');
    const retry = await create(original.metadata.source, 'provenance-parent-0001', '50', '100');
    assert.equal(retry.reused, true); assert.equal(retry.node.proposalId, parent.node.proposalId);
    await storage.withLockedGraph(scope, {}, async (graph) => {
      const stored = await loadProposalNodeArtifacts(graph, child.node);
      assert.equal(JSON.parse(Buffer.from(stored.artifacts.anchorMap).toString()).version, 1);
      assert.notEqual(child.node.source.anchorMap.ref, child.node.authoredCandidate.effectPreconditions.ref);
    });
    const count = async () => (await db.query<{ nodes: string; operations: string; artifacts: string; pins: string }>(`SELECT
      (SELECT count(*)::text FROM file_change_proposals) nodes,
      (SELECT count(*)::text FROM collaboration_agent_operations) operations,
      (SELECT count(*)::text FROM file_proposal_artifacts) artifacts,
      (SELECT count(*)::text FROM file_proposal_artifact_pins) pins`)).rows[0];
    const before = await count();
    assert.equal(before.nodes, '2'); assert.ok(Number(before.pins) >= 10);
    failAfterOperation = true;
    await assert.rejects(create(original.metadata.source, 'provenance-failed-0001', 'Tail', 'Uncommitted'), /injected-after-operation/);
    assert.deepEqual(await count(), before, 'operation insertion failure rolls back all newly stored artifacts and the node');
    assert.equal(live.getText('content').toString(), 'Insurance 50. Tail.', 'preparation never applies the current document');
    console.log('proposal-provenance-storage-test: parent/child, exact read, witness pins, retry and SQL rollback passed');
  } finally { live.destroy(); await db.close(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
