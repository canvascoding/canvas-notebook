import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { createAgentTextTarget } from '../app/lib/collaboration/agent-operations';
import type { FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import { ProposalGraphContractError, PROPOSAL_GRAPH_ERROR_CODES as Codes } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalDocumentScopeV1, ProposalRelationshipsV1, ProposalSourceProofV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { createProposalGraphStorage } from '../app/lib/file-version-center/proposal-storage';
import { createProposalProvenanceService, loadProposalNodeArtifacts, type ProposalProvenanceAuthorization } from '../app/lib/file-version-center/proposal-provenance-service';
import { createProposalToolRelationshipPolicy } from '../app/lib/file-version-center/proposal-tool-relationships';
import { seedProposalGraphStorageTestScope, type ProposalGraphStorageTestDatabase } from './proposal-graph-storage-test';

const scope: ProposalDocumentScopeV1 = {
  workspaceId: 'proposal-workspace', lineageId: 'proposal-lineage', documentId: 'proposal-document',
  lifecycleGeneration: 1, schemaVersion: 1,
};
const otherScope: ProposalDocumentScopeV1 = {
  workspaceId: 'proposal-other-workspace', lineageId: 'proposal-other-lineage', documentId: 'proposal-other-document',
  lifecycleGeneration: 1, schemaVersion: 1,
};

type Fixture = ReturnType<typeof createFixture>;
function createFixture() {
  const pg = new PGlite();
  const db: ProposalGraphStorageTestDatabase = {
    kind: 'pglite', query: (sql, params) => pg.query(sql, params), exec: async (sql) => { await pg.exec(sql); },
    transaction: (action) => pg.transaction((sql) => action({ query: (statement, params) => sql.query(statement, params) })),
    close: () => pg.close(),
  };
  const live = createPlainTextYDoc('Insurance 50. Tail.');
  const otherLive = createPlainTextYDoc('Insurance 50. Tail.');
  let activeSql: FileVersionCenterTransaction | null = null;
  let nextId = 0;
  let failRelationshipApply = false;
  let failAfterRelationshipBeforeInsert = false;
  let revokeRelationshipTarget: { proposalId: string; successfulChecksRemaining: number } | null = null;
  const deniedManageIds = new Set<string>();
  const authorizationCalls: ProposalProvenanceAuthorization[] = [];
  const authorize: Parameters<typeof createProposalProvenanceService>[0]['authorize'] = async (input) => {
    authorizationCalls.push(structuredClone(input));
    if (input.action === 'manage_relationship' && input.proposalIds.some((id) => deniedManageIds.has(id))) {
      throw new ProposalGraphContractError(Codes.accessDenied, 'Injected relationship management denial.');
    }
    if (input.action === 'manage_relationship' && revokeRelationshipTarget
      && input.proposalIds.includes(revokeRelationshipTarget.proposalId)) {
      revokeRelationshipTarget.successfulChecksRemaining--;
      if (revokeRelationshipTarget.successfulChecksRemaining === 0) {
        deniedManageIds.add(revokeRelationshipTarget.proposalId);
        revokeRelationshipTarget = null;
      }
    }
  };
  const storage = createProposalGraphStorage({ now: () => 1_000, createId: () => `relationship-artifact-${++nextId}`,
    database: { transaction: (action) => db.transaction(async (tx) => {
      activeSql = tx;
      try { return await action(tx); } finally { activeSql = null; }
    }) } });
  const basePolicy = createProposalToolRelationshipPolicy({ authorize, createId: () => `relationship-group-${++nextId}` });
  const relationshipPolicy: Parameters<typeof createProposalProvenanceService>[0]['relationshipPolicy'] = async (input) => {
    const plan = await basePolicy(input);
    return { ...plan,
      beforeInsert: async () => {
        await plan.beforeInsert?.();
        if (failAfterRelationshipBeforeInsert) throw new Error('injected-after-relationship-before-insert');
      },
      apply: async (node) => {
        await plan.apply(node);
        if (failRelationshipApply) throw new Error('injected-after-relationship-mutation');
      } };
  };
  const service = createProposalProvenanceService({ now: () => 1_000, createId: () => `relationship-${++nextId}`,
    authorize, relationshipPolicy,
    withTransaction: (selectedScope, action) => storage.withLockedGraph(selectedScope, {}, (graph) => action({
      graph,
      loadCurrent: async () => ({ scope: selectedScope, representation: 'plain_text',
        revisionId: selectedScope.documentId === scope.documentId ? 'proposal-v0' : 'proposal-other-v0',
        update: Y.encodeStateAsUpdate(selectedScope.documentId === scope.documentId ? live : otherLive) }),
      lookupOperation: async ({ idempotencyKey, requestDigest }) => {
        const found = (await activeSql!.query<{
          operation_id: string; proposal_id: string | null; payload_hash: string; authored_relationships: ProposalRelationshipsV1 | null;
        }>(`
          SELECT operation.operation_id, operation.payload_hash, proposal.proposal_id,
            proposal.node_json->'relationships' AS authored_relationships
          FROM collaboration_agent_operations operation
          LEFT JOIN file_change_proposals proposal ON proposal.operation_id=operation.operation_id
          WHERE operation.document_id=$1 AND operation.idempotency_key=$2
        `, [selectedScope.documentId, idempotencyKey])).rows[0];
        if (!found) return null;
        assert.equal(found.payload_hash, requestDigest, 'durable retry key must bind the canonical request');
        assert.ok(found.proposal_id, 'legacy operations cannot be adopted');
        assert.ok(found.authored_relationships);
        return { operationId: found.operation_id, proposalId: found.proposal_id,
          authoredRelationships: found.authored_relationships };
      },
      insertPreparedOperation: async (prepared) => {
        assert.equal(prepared.reviewRequired, true, 'proposal operations are always review-only');
        assert.match(prepared.beforeSha256, /^[a-f0-9]{64}$/u);
        assert.match(prepared.proposedSha256, /^[a-f0-9]{64}$/u);
        await activeSql!.query(`INSERT INTO collaboration_agent_operations
          (operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at)
          VALUES ($1,$2,$3,'proposal-owner','main',$4,$5,'needs_review',$6,1000,1000)`,
        [prepared.operationId, selectedScope.documentId, selectedScope.workspaceId, prepared.idempotencyKey,
          prepared.requestDigest, Buffer.from(prepared.sourceStateVector, 'base64')]);
      },
    })),
  });
  const create = (source: ProposalSourceProofV1, key: string, oldText: string, replacement: string,
    relationship: Pick<ProposalToolEditV1, 'creationKind' | 'replaces' | 'choice'> = {
      creationKind: source.kind === 'proposal' ? 'extends' : 'independent', replaces: null, choice: null,
    }, selectedScope: ProposalDocumentScopeV1 = scope) => service.create({
      scope: selectedScope, actorId: 'main', idempotencyKey: key,
      proposal: { contractVersion: 1, ...relationship, source,
        expectedParentCasVersion: source.kind === 'proposal' ? source.proposalCasVersion : null,
        expectedParentCandidateHash: source.kind === 'proposal' ? source.candidateHash : null },
      mutation: { oldText, replacement },
      buildTargets: ({ update }) => {
        const scratch = new Y.Doc();
        try {
          Y.applyUpdate(scratch, update);
          const text = scratch.getText('content');
          const at = text.toString().indexOf(oldText);
          assert.ok(at >= 0, `source candidate must contain ${JSON.stringify(oldText)}`);
          return [createAgentTextTarget({ text, from: at, to: at + oldText.length, replacement })];
        } finally { scratch.destroy(); }
      },
    });
  const countState = async (): Promise<unknown> => {
    const rows = async (sql: string) => (await db.query(sql)).rows;
    return {
      nodes: await rows(`SELECT proposal_id,operation_id,cas_version,lifecycle,node_json,choice_group_id FROM file_change_proposals ORDER BY proposal_id`),
      operations: await rows(`SELECT operation_id,document_id,idempotency_key,payload_hash,status,base_state_vector FROM collaboration_agent_operations ORDER BY operation_id`),
      graphs: await rows(`SELECT graph_id,graph_revision,active_action_id FROM file_proposal_graphs ORDER BY graph_id`),
      groups: await rows(`SELECT graph_id,group_id,group_revision,dependency_proposal_id,chosen_proposal_id,created_at,updated_at FROM file_proposal_choice_groups ORDER BY group_id`),
      memberships: await rows(`SELECT graph_id,group_id,proposal_id FROM file_proposal_choice_memberships ORDER BY group_id,proposal_id`),
      artifacts: await rows(`SELECT graph_id,artifact_ref,sha256,encoding,size_bytes,payload FROM file_proposal_artifacts ORDER BY artifact_ref`),
      pins: await rows(`SELECT graph_id,artifact_ref,proposal_id,evaluation_id,action_id FROM file_proposal_artifact_pins ORDER BY artifact_ref,proposal_id,evaluation_id,action_id`),
    };
  };
  return { db, live, otherLive, storage, service, create, countState, deniedManageIds, authorizationCalls,
    setFailRelationshipApply(value: boolean) { failRelationshipApply = value; },
    setFailAfterRelationshipBeforeInsert(value: boolean) { failAfterRelationshipBeforeInsert = value; },
    revokeRelationshipAfterChecks(proposalId: string, successfulChecks: number) {
      deniedManageIds.delete(proposalId);
      revokeRelationshipTarget = { proposalId, successfulChecksRemaining: successfulChecks };
    },
    clearRelationshipRevocation(proposalId: string) {
      deniedManageIds.delete(proposalId);
      revokeRelationshipTarget = null;
    },
    async close() { live.destroy(); otherLive.destroy(); await db.close(); } };
}

const authoritativeSource = async (fixture: Fixture, selectedScope: ProposalDocumentScopeV1 = scope) =>
  (await fixture.service.readExact({ scope: selectedScope, proposalId: null })).metadata.source;
const errorCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ProposalGraphContractError, `expected ProposalGraphContractError ${code}`);
  assert.equal(error.code, code, error.message);
  return true;
};
let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run(); passed++; console.log(`ok ${passed} - ${name}`);
}

async function main(): Promise<void> {
  const fixture = createFixture();
  try {
    // Always in-memory and sequential. No local stack, browser, or live Yjs apply is involved.
    await runPostgresMigrations(fixture.db as unknown as Parameters<typeof runPostgresMigrations>[0]);
    await seedProposalGraphStorageTestScope(fixture.db);

    const initialSource = await authoritativeSource(fixture);
    const original = await fixture.create(initialSource, 'relationship-root-a-0001', '50', '100');
    const originalRead = await fixture.service.readExact({ scope, proposalId: original.node.proposalId });
    const secondAlternative = await fixture.create(initialSource, 'relationship-root-b-0001', '50', '75', {
      creationKind: 'independent', replaces: null,
      choice: { kind: 'alternative_to', proposalId: original.node.proposalId,
        expectedCasVersion: original.node.casVersion, expectedCandidateHash: original.node.authoredCandidate.cumulativeCandidate.sha256 },
    });

    await test('alternative_to creates a shared-prerequisite group and increments the target CAS', async () => {
      assert.equal(original.node.relationships.dependency, null);
      assert.ok(secondAlternative.node.relationships.choiceGroupId);
      const graph = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph());
      const group = graph.choiceGroups.find((entry) => entry.groupId === secondAlternative.node.relationships.choiceGroupId);
      assert.ok(group);
      assert.equal(group.dependencyProposalId, null);
      assert.deepEqual(new Set(group.memberProposalIds), new Set([original.node.proposalId, secondAlternative.node.proposalId]));
      const updatedTarget = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(original.node.proposalId));
      assert.equal(updatedTarget?.relationships.choiceGroupId, secondAlternative.node.relationships.choiceGroupId);
      assert.equal(updatedTarget?.casVersion, original.node.casVersion + 1,
        'adding a target to the choice group advances its current CAS');
      assert.equal(originalRead.metadata.source.kind, 'proposal');
    });

    const group = (await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph())).choiceGroups[0]!;
    // A terminal member is absent from the active projection but remains in durable membership history.
    await fixture.storage.withLockedGraph(scope, {}, async (transaction) => {
      const second = await transaction.getProposal(secondAlternative.node.proposalId);
      assert.ok(second);
      await transaction.transitionProposal(second.proposalId, second.casVersion, 'rejected');
    });
    const joinSource = await authoritativeSource(fixture);
    const joined = await fixture.create(joinSource, 'relationship-existing-join-0001', '50', '125', {
      creationKind: 'independent', replaces: null,
      choice: { kind: 'existing', groupId: group.groupId, expectedGroupRevision: group.groupRevision },
    });
    await test('existing joins require the exact group revision and retain archived membership', async () => {
      assert.equal(joined.node.relationships.choiceGroupId, group.groupId);
      const updated = (await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph())).choiceGroups
        .find((entry) => entry.groupId === group.groupId);
      assert.ok(updated);
      assert.equal(updated.groupRevision, group.groupRevision + 1);
      assert.equal(updated.archivedMemberCount, 1);
      assert.ok(updated.memberProposalIds.includes(joined.node.proposalId));
      assert.ok(!updated.memberProposalIds.includes(secondAlternative.node.proposalId));
      const durableMembers = (await fixture.db.query<{ proposal_id: string }>(
        `SELECT proposal_id FROM file_proposal_choice_memberships WHERE group_id=$1 ORDER BY proposal_id`, [group.groupId])).rows;
      assert.ok(durableMembers.some((member) => member.proposal_id === secondAlternative.node.proposalId),
        'terminal membership is retained when an active member is appended');
    });

    const archivedGroup = (await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph())).choiceGroups
      .find((entry) => entry.groupId === group.groupId)!;
    const beforeBadArchiveCounts = await fixture.countState();
    await test('incorrect archive counts cannot hide open or terminal choice memberships', async () => {
      await assert.rejects(fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.putChoiceGroup({
        ...archivedGroup,
        groupRevision: archivedGroup.groupRevision + 1,
        memberProposalIds: archivedGroup.memberProposalIds.filter((id) => id !== original.node.proposalId),
        archivedMemberCount: (archivedGroup.archivedMemberCount ?? 0) + 1,
      }, archivedGroup.groupRevision)), errorCode(Codes.choiceConflict));
      await assert.rejects(fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.putChoiceGroup({
        ...archivedGroup,
        groupRevision: archivedGroup.groupRevision + 1,
        archivedMemberCount: (archivedGroup.archivedMemberCount ?? 0) + 1,
      }, archivedGroup.groupRevision)), errorCode(Codes.choiceConflict));
      assert.deepEqual(await fixture.countState(), beforeBadArchiveCounts,
        'both invalid membership projections leave the complete SQL state unchanged');
    });

    const currentGroup = (await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph())).choiceGroups
      .find((entry) => entry.groupId === group.groupId)!;
    const currentOriginal = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(original.node.proposalId));
    assert.ok(currentOriginal);
    const beforeBadJoin = await fixture.countState();
    await test('stale group revision and stale target CAS/hash reject without writes', async () => {
      await assert.rejects(fixture.create(await authoritativeSource(fixture), 'relationship-stale-group-0001', '50', '130', {
        creationKind: 'independent', replaces: null,
        choice: { kind: 'existing', groupId: group.groupId, expectedGroupRevision: currentGroup.groupRevision - 1 },
      }), errorCode(Codes.choiceConflict));
      await assert.rejects(fixture.create(await authoritativeSource(fixture), 'relationship-stale-cas-0001', '50', '140', {
        creationKind: 'independent', replaces: null,
        choice: { kind: 'alternative_to', proposalId: original.node.proposalId,
          expectedCasVersion: original.node.casVersion, expectedCandidateHash: original.node.authoredCandidate.cumulativeCandidate.sha256 },
      }), errorCode(Codes.parentChanged));
      await assert.rejects(fixture.create(await authoritativeSource(fixture), 'relationship-stale-hash-0001', '50', '145', {
        creationKind: 'independent', replaces: null,
        choice: { kind: 'alternative_to', proposalId: original.node.proposalId,
          expectedCasVersion: currentOriginal.casVersion, expectedCandidateHash: 'f'.repeat(64) },
      }), errorCode(Codes.parentChanged));
      assert.deepEqual(await fixture.countState(), beforeBadJoin);
    });

    const descendantSource = await fixture.service.readExact({ scope, proposalId: original.node.proposalId });
    const descendant = await fixture.create(descendantSource.metadata.source, 'relationship-descendant-0001', '100', '150');
    const replacementSource = await authoritativeSource(fixture);
    const targetBeforeReplacement = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(original.node.proposalId));
    assert.ok(targetBeforeReplacement);
    const replaced = await fixture.create(replacementSource, 'relationship-replacement-0001', '50', '120', {
      creationKind: 'replacement',
      replaces: { proposalId: original.node.proposalId, expectedCasVersion: targetBeforeReplacement.casVersion,
        expectedCandidateHash: targetBeforeReplacement.authoredCandidate.cumulativeCandidate.sha256 },
      choice: null,
    });
    await test('replacement inherits parent and choice, supersedes only its target, and leaves blocked descendants open', async () => {
      assert.equal(replaced.node.relationships.dependency, targetBeforeReplacement.relationships.dependency);
      assert.equal(replaced.node.relationships.choiceGroupId, targetBeforeReplacement.relationships.choiceGroupId);
      assert.equal(replaced.node.relationships.replacesProposalId, original.node.proposalId);
      const graph = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph());
      const transitionedTarget = graph.nodes.find((node) => node.proposalId === original.node.proposalId);
      const stillOpenDescendant = graph.nodes.find((node) => node.proposalId === descendant.node.proposalId);
      assert.equal(transitionedTarget?.lifecycle, 'superseded');
      assert.equal(stillOpenDescendant?.lifecycle, 'open', 'replacement does not cascade a lifecycle transition');
      await assert.rejects(fixture.service.readExact({ scope, proposalId: descendant.node.proposalId }), errorCode(Codes.dependencyBlocked));
    });

    const beforeRejectedReplacement = await fixture.countState();
    await test('a rejected replacement never reopens or otherwise changes the original', async () => {
      await fixture.storage.withLockedGraph(scope, {}, async (transaction) => {
        const target = await transaction.getProposal(replaced.node.proposalId);
        assert.ok(target);
        await transaction.transitionProposal(target.proposalId, target.casVersion, 'rejected');
      });
      const old = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(original.node.proposalId));
      assert.equal(old?.lifecycle, 'superseded');
      assert.notDeepEqual(await fixture.countState(), beforeRejectedReplacement,
        'rejecting the newly created replacement is itself a graph mutation');
      assert.equal((await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(original.node.proposalId)))?.lifecycle,
        'superseded');
    });

    const beforeUnauthorized = await fixture.countState();
    await test('unauthorized relationship management denial leaves every proposal row and artifact unchanged', async () => {
      fixture.deniedManageIds.add(original.node.proposalId);
      await assert.rejects(fixture.create(await authoritativeSource(fixture), 'relationship-foreign-denied-0001', '50', '160', {
        creationKind: 'independent', replaces: null,
        choice: { kind: 'alternative_to', proposalId: original.node.proposalId,
          expectedCasVersion: original.node.casVersion, expectedCandidateHash: original.node.authoredCandidate.cumulativeCandidate.sha256 },
      }), errorCode(Codes.accessDenied));
      fixture.deniedManageIds.clear();
      assert.deepEqual(await fixture.countState(), beforeUnauthorized);
      assert.ok(fixture.authorizationCalls.some((call) => call.action === 'manage_relationship'
        && call.proposalIds.includes(original.node.proposalId)));
    });

    const foreignSource = await authoritativeSource(fixture, otherScope);
    const beforeWrongSource = await fixture.countState();
    await test('a source proof from another document is rejected without graph or operation writes', async () => {
      await assert.rejects(fixture.create(foreignSource, 'relationship-wrong-source-0001', '50', '170', {
        creationKind: 'independent', replaces: null, choice: null,
      }), errorCode(Codes.scopeMismatch));
      assert.deepEqual(await fixture.countState(), beforeWrongSource);
    });

    const rollbackSource = await authoritativeSource(fixture);
    const ungroupedTarget = await fixture.create(rollbackSource, 'relationship-rollback-target-0001', '50', '190');
    const beforeGroupReservationFailure = await fixture.countState();
    await test('failure immediately after beforeInsert rolls back its new group, target CAS, artifacts, and operation', async () => {
      fixture.setFailAfterRelationshipBeforeInsert(true);
      await assert.rejects(fixture.create(rollbackSource, 'relationship-before-insert-rollback-0001', '50', '195', {
        creationKind: 'independent', replaces: null,
        choice: { kind: 'alternative_to', proposalId: ungroupedTarget.node.proposalId,
          expectedCasVersion: ungroupedTarget.node.casVersion,
          expectedCandidateHash: ungroupedTarget.node.authoredCandidate.cumulativeCandidate.sha256 },
      }), /injected-after-relationship-before-insert/u);
      fixture.setFailAfterRelationshipBeforeInsert(false);
      assert.deepEqual(await fixture.countState(), beforeGroupReservationFailure);
      const persistedTarget = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(ungroupedTarget.node.proposalId));
      assert.equal(persistedTarget?.casVersion, ungroupedTarget.node.casVersion);
      assert.equal(persistedTarget?.relationships.choiceGroupId, null);
    });

    const beforeRevokedBeforeInsert = await fixture.countState();
    await test('relationship authorization revoked at beforeInsert rolls back all preparation writes', async () => {
      fixture.revokeRelationshipAfterChecks(ungroupedTarget.node.proposalId, 2);
      await assert.rejects(fixture.create(rollbackSource, 'relationship-revoked-before-insert-0001', '50', '196', {
        creationKind: 'independent', replaces: null,
        choice: { kind: 'alternative_to', proposalId: ungroupedTarget.node.proposalId,
          expectedCasVersion: ungroupedTarget.node.casVersion,
          expectedCandidateHash: ungroupedTarget.node.authoredCandidate.cumulativeCandidate.sha256 },
      }), errorCode(Codes.accessDenied));
      fixture.clearRelationshipRevocation(ungroupedTarget.node.proposalId);
      assert.deepEqual(await fixture.countState(), beforeRevokedBeforeInsert);
    });

    const beforeRevokedReauthorization = await fixture.countState();
    await test('relationship authorization revoked before apply rolls back the prepared operation and node', async () => {
      fixture.revokeRelationshipAfterChecks(joined.node.proposalId, 2);
      await assert.rejects(fixture.create(rollbackSource, 'relationship-revoked-auth-0001', '50', '197', {
        creationKind: 'replacement',
        replaces: { proposalId: joined.node.proposalId, expectedCasVersion: joined.node.casVersion,
          expectedCandidateHash: joined.node.authoredCandidate.cumulativeCandidate.sha256 },
        choice: null,
      }), errorCode(Codes.accessDenied));
      fixture.clearRelationshipRevocation(joined.node.proposalId);
      assert.deepEqual(await fixture.countState(), beforeRevokedReauthorization,
        'the immediate pre-apply authorization check protects the node, operation, artifacts and graph');
    });

    const beforeInjectedFailure = await fixture.countState();
    await test('failure after relationship membership and target transition rolls the transaction back', async () => {
      fixture.setFailRelationshipApply(true);
      await assert.rejects(fixture.create(rollbackSource, 'relationship-rollback-0001', '50', '180', {
        creationKind: 'replacement',
        replaces: { proposalId: joined.node.proposalId, expectedCasVersion: joined.node.casVersion,
          expectedCandidateHash: joined.node.authoredCandidate.cumulativeCandidate.sha256 },
        choice: null,
      }), /injected-after-relationship-mutation/u);
      fixture.setFailRelationshipApply(false);
      assert.deepEqual(await fixture.countState(), beforeInjectedFailure,
        'operation, node, artifact pins, group membership, group revision and lifecycle transition all roll back');
      assert.equal(fixture.live.getText('content').toString(), 'Insurance 50. Tail.');
    });

    const retrySource = await authoritativeSource(fixture);
    const retryTarget = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(joined.node.proposalId));
    assert.ok(retryTarget);
    const retryArgs = {
      creationKind: 'replacement' as const,
      replaces: { proposalId: retryTarget.proposalId, expectedCasVersion: retryTarget.casVersion,
        expectedCandidateHash: retryTarget.authoredCandidate.cumulativeCandidate.sha256 },
      choice: null,
    };
    const retryCreate = await fixture.create(retrySource, 'relationship-retry-after-change-0001', '50', '200', retryArgs);
    await fixture.storage.withLockedGraph(scope, {}, async (transaction) => {
      const node = await transaction.getProposal(retryCreate.node.proposalId);
      assert.ok(node);
      await transaction.transitionProposal(node.proposalId, node.casVersion, 'rejected');
    });
    await test('same idempotency key returns its immutable creation receipt after the graph and node lifecycle change', async () => {
      const retried = await fixture.create(retrySource, 'relationship-retry-after-change-0001', '50', '200', retryArgs);
      assert.equal(retried.reused, true);
      assert.equal(retried.node.proposalId, retryCreate.node.proposalId);
      assert.deepEqual(retried.proposal, retryCreate.proposal,
        'creation relationships are read from the original operation receipt, not current lifecycle state');
      const persisted = await fixture.storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal(retryCreate.node.proposalId));
      assert.equal(persisted?.lifecycle, 'rejected');
      const alternativeRetry = await fixture.create(initialSource, 'relationship-root-b-0001', '50', '75', {
        creationKind: 'independent', replaces: null,
        choice: { kind: 'alternative_to', proposalId: original.node.proposalId,
          expectedCasVersion: original.node.casVersion, expectedCandidateHash: original.node.authoredCandidate.cumulativeCandidate.sha256 },
      });
      assert.equal(alternativeRetry.reused, true);
      assert.equal(alternativeRetry.proposal.proposalId, secondAlternative.proposal.proposalId);
      assert.deepEqual(alternativeRetry.proposal, secondAlternative.proposal,
        'an alternative retry preserves its original group receipt after the target CAS and lifecycle have changed');
    });

    await test('all prepared operations remain review-only and no proposal candidate is applied to live Yjs', async () => {
      const statuses = (await fixture.db.query<{ status: string }>(
        `SELECT status FROM collaboration_agent_operations WHERE operation_id IN
          (SELECT operation_id FROM file_change_proposals) ORDER BY operation_id`)).rows;
      assert.ok(statuses.length > 0);
      assert.ok(statuses.every((row) => row.status === 'needs_review'));
      assert.equal(fixture.live.getText('content').toString(), 'Insurance 50. Tail.');
      await fixture.storage.withLockedGraph(scope, {}, async (graph) => {
        for (const node of (await graph.loadGraph()).nodes) {
          const stored = await loadProposalNodeArtifacts(graph, node);
          assert.ok(stored.artifacts.cumulativeCandidate.byteLength > 0);
        }
      });
    });

    console.log(`Proposal tool relationships: ${passed} groups passed.`);
  } finally { await fixture.close(); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
