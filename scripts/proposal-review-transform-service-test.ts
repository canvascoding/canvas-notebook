import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { createAgentTextTarget, prepareProposalAgentOperation } from '../app/lib/collaboration/agent-operations';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import type { ProposalDocumentScopeV1, ProposalSourceProofV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { createProposalProvenanceService } from '../app/lib/file-version-center/proposal-provenance-service';
import { createProposalGraphStorage } from '../app/lib/file-version-center/proposal-storage';
import { createRuntimeProposalReviewActionService } from '../app/lib/file-version-center/proposal-review-action-runtime';
import { prepareProposalReviewTransformation } from '../app/lib/file-version-center/proposal-review-transform-service';
import { proposalYjsCurrentProof } from '../app/lib/file-version-center/proposal-yjs-candidate';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { seedProposalGraphStorageTestScope, type ProposalGraphStorageTestDatabase } from './proposal-graph-storage-test';

const scope: ProposalDocumentScopeV1 = { workspaceId: 'proposal-workspace', lineageId: 'proposal-lineage',
  documentId: 'proposal-document', lifecycleGeneration: 1, schemaVersion: 1 };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const declaration = (source: ProposalSourceProofV1): ProposalToolEditV1 => ({ contractVersion: 1,
  creationKind: source.kind === 'proposal' ? 'extends' : 'independent', source,
  expectedParentCasVersion: source.kind === 'proposal' ? source.proposalCasVersion : null,
  expectedParentCandidateHash: source.kind === 'proposal' ? source.candidateHash : null,
  replaces: null, choice: null });

async function main() {
  const pg = new PGlite();
  const db: ProposalGraphStorageTestDatabase = { kind: 'pglite', query: (sql, params) => pg.query(sql, params),
    exec: async (sql) => { await pg.exec(sql); }, transaction: (action) => pg.transaction((sql) =>
      action({ query: (statement, params) => sql.query(statement, params) })), close: () => pg.close() };
  const live = createPlainTextYDoc('Insurance 50. Tail.');
  let nextId = 0;
  let activeSql: FileVersionCenterTransaction | null = null;
  const createId = () => `transform-id-${++nextId}`;
  try {
    await runPostgresMigrations(db as unknown as Parameters<typeof runPostgresMigrations>[0]);
    await seedProposalGraphStorageTestScope(db);
    const storage = createProposalGraphStorage({ database: { transaction: (action) => db.transaction(async (sql) => {
      activeSql = sql;
      try { return await action(sql); } finally { activeSql = null; }
    }) },
      now: () => 1_000, createId });
    const current = () => Y.encodeStateAsUpdate(live);
    const sourceService = (graph: Parameters<Parameters<typeof storage.withLockedGraph>[2]>[0]) =>
      createProposalProvenanceService({ now: () => 1_000, createId, authorize: async () => {},
        withTransaction: (_selected, action) => action({ graph,
          loadCurrent: async () => ({ scope, representation: 'plain_text', revisionId: null, update: current() }),
          lookupOperation: async () => null,
          insertPreparedOperation: async (prepared) => {
            await activeSql!.query(`INSERT INTO collaboration_agent_operations
              (operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at)
              VALUES ($1,$2,$3,'proposal-owner','proposal-owner',$4,$5,'needs_review',$6,1000,1000)`,
            [prepared.operationId, scope.documentId, scope.workspaceId, prepared.idempotencyKey, prepared.requestDigest,
              Buffer.from(prepared.sourceStateVector, 'base64')]);
          },
        }) });
    const source = await storage.withLockedGraph(scope, {}, (graph) => sourceService(graph).readExact({ scope, proposalId: null }));
    const create = async (basis: ProposalSourceProofV1, key: string, oldText: string, replacement: string) =>
      storage.withLockedGraph(scope, {}, (graph) => sourceService(graph).create({ scope, actorId: 'proposal-owner',
        idempotencyKey: key, proposal: declaration(basis), mutation: { oldText, replacement },
        buildTargets: ({ update }) => {
          const doc = new Y.Doc({ gc: false });
          try {
            Y.applyUpdate(doc, update);
            const text = doc.getText('content');
            const from = text.toString().indexOf(oldText);
            assert.ok(from >= 0);
            return [createAgentTextTarget({ text, from, to: from + oldText.length, replacement })];
          } finally { doc.destroy(); }
        },
      }));
    const parent = await create(source.metadata.source, 'transform-parent-key-0001', '50', '100');
    const parentRead = await storage.withLockedGraph(scope, {}, (graph) => sourceService(graph).readExact({ scope, proposalId: parent.node.proposalId }));
    const child = await create(parentRead.metadata.source, 'transform-child-key-0001', 'Tail', 'Tail!');
    live.getText('content').insert(live.getText('content').length, ' Extra.');
    const transform = (kind: 'detach' | 'replace') => storage.withLockedGraph(scope, {}, async (graph) => {
      const snapshot = await graph.loadGraph({ includeProposalIds: [child.node.proposalId] });
      return prepareProposalReviewTransformation({ scope, graph: snapshot, transaction: graph, kind,
        sourceProposalId: child.node.proposalId, expectedGraphRevision: snapshot.graphRevision,
        current: proposalYjsCurrentProof({ update: current(), representation: 'plain_text', revisionId: null }),
        representation: 'plain_text', actorId: 'proposal-owner', authorize: async () => {}, createId,
        readSource: async (proposalId) => {
          const read = await sourceService(graph).readExact({ scope, proposalId });
          return { source: read.metadata.source, content: read.content };
        },
      });
    });
    const replaced = await transform('replace');
    assert.equal(replaced.creation.relationships.replacesProposalId, child.node.proposalId);
    assert.equal(replaced.creation.relationships.dependency?.proposalId, parent.node.proposalId);
    assert.equal(replaced.creation.creationKind, 'replacement');
    assert.equal(replaced.beforeContent, 'Insurance 100. Tail. Extra.');
    assert.equal(replaced.proposedContent, 'Insurance 100. Tail!. Extra.');
    assert.notEqual(replaced.creation.authoredCandidate.cumulativeCandidate.sha256, child.node.authoredCandidate.cumulativeCandidate.sha256);
    await storage.withLockedGraph(scope, {}, (graph) => graph.transitionProposal(parent.node.proposalId, 1, 'rejected'));
    const detached = await transform('detach');
    assert.equal(detached.creation.detachedFromProposalId, child.node.proposalId);
    assert.equal(detached.creation.relationships.dependency, null);
    assert.equal(detached.creation.relationships.choiceGroupId, null);
    assert.equal(detached.beforeContent, 'Insurance 50. Tail. Extra.');
    assert.equal(detached.proposedContent, 'Insurance 50. Tail!. Extra.');
    assert.equal(detached.proposedSha256, digest(detached.proposedContent));
    const count = (await db.query<{ count: string }>('SELECT count(*)::text AS count FROM file_change_proposals')).rows[0]!.count;
    assert.equal(count, '2', 'preview never creates or applies a proposal');
    assert.equal(live.getText('content').toString(), 'Insurance 50. Tail. Extra.');
    await db.query(`INSERT INTO collaboration_yjs_states
      (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
       yjs_state,state_vector,document_sequence,persisted_at,status)
      VALUES ($1,$2,'proposal-org','shipping.md','plain_text',1,1,$3,$4,0,1000,'active')`,
    [scope.documentId, scope.workspaceId, Buffer.from(current()), Buffer.from(Y.encodeStateVector(live))]);
    const target: ResolvedFileVersionTarget = { workspaceId: scope.workspaceId, lineageId: scope.lineageId,
      documentId: scope.documentId, path: 'shipping.md', latestRevisionId: null, latestRevisionHash: null, latestRevisionSize: 0 };
    const workspace: WorkspaceContext = { workspaceId: scope.workspaceId, workspaceType: 'personal', rootPath: '/unused',
      organizationId: 'proposal-org', actor: { userId: 'proposal-owner', role: 'owner', email: 'proposal-owner@test.invalid' },
      legacy: false, permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
        canManageWorkspace: true, canRunAgent: false } };
    const access: FileVersionCenterAccess = { userId: 'proposal-owner', authenticatedWorkspaceId: scope.workspaceId,
      requestedWorkspaceId: scope.workspaceId, membership: 'active', permissionsResolved: true,
      canRead: true, canWrite: true, canManageWorkspace: true };
    const loadState = async (): Promise<PersistedCollaborationState> => ({ documentId: scope.documentId,
      workspaceId: scope.workspaceId, organizationId: 'proposal-org', path: 'shipping.md', representation: 'plain_text',
      lifecycleGeneration: 1, schemaVersion: 1, yjsState: current(), stateVector: Y.encodeStateVector(live),
      documentSequence: 0, persistedAt: 1000, checkpointedAt: null, checkpointSequence: 0,
      canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' });
    const runtime = await createRuntimeProposalReviewActionService({ target, workspace, access,
      reviewerSessionId: 'reviewer-session-0001', dependencies: { storage,
        database: { transaction: (action) => db.transaction(action) }, loadState, readCurrent: async () => current(),
        readWorkspace: async () => workspace, writesEnabled: () => true, rolloutWritable: () => true,
        signingSecret: 'review-transformation-test-signing-secret-32-bytes', now: () => 1_000, createId,
        prepareCreatedOperation: async (prepared) => {
          assert.equal(prepared.actorSessionId, 'reviewer-session-0001');
          await prepared.transaction.query(`INSERT INTO collaboration_agent_operations
            (operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,actor_session_id,
             idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'needs_review',$9,1000,1000)`,
          [prepared.operationId, scope.documentId, scope.workspaceId, prepared.initiatedByUserId, prepared.actorId,
            prepared.actorSessionId, prepared.idempotencyKey, prepared.fileEditRequest.fingerprint,
            Buffer.from(prepared.baseStateVector, 'base64')]);
          return {} as Awaited<ReturnType<typeof prepareProposalAgentOperation>>;
        },
      } });
    const revision = await storage.withLockedGraph(scope, {}, async (graph) => (await graph.loadGraph()).graphRevision);
    const signed = await runtime.prepareTransform({ sourceProposalId: child.node.proposalId,
      kind: 'detach', expectedGraphRevision: revision });
    const receipt = await runtime.execute({ contractVersion: 1, ...signed.prepared,
      idempotencyKey: 'review-transform-action-0001' });
    assert.equal(receipt.phase, 'succeeded', receipt.errorCode ?? 'unknown metadata failure');
    assert.equal(receipt.result?.kind, 'metadata_only');
    assert.deepEqual(receipt.result?.createdProposalIds, [signed.prepared.creation.proposalId]);
    assert.equal(live.getText('content').toString(), 'Insurance 50. Tail. Extra.');
    const retry = await runtime.execute({ contractVersion: 1, ...signed.prepared,
      idempotencyKey: 'review-transform-action-0001' });
    assert.deepEqual(retry, receipt);
    console.log('proposal-review-transform-service-test: verified replay, replacement, detached source and no live write passed');
  } finally { live.destroy(); await db.close(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
