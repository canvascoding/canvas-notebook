import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import * as Y from 'yjs';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import {
  rollbackProposalGraphStorageMigration,
  runProposalGraphStorageMigration,
} from '../app/lib/db/proposal-graph-migration';
import type {
  FileVersionCenterDatabase,
  FileVersionCenterTransaction,
} from '../app/lib/file-version-center/database';
import {
  parseProposalActionFenceV1,
  parseProposalActionReceiptV1,
  parseProposalCreateRequestV1,
  parseProposalEvaluationV1,
  parseProposalNodeV1,
  ProposalGraphContractError,
  type ProposalArtifactReferenceV1,
  type ProposalDocumentScopeV1,
  type ProposalNodeV1,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { createProposalGraphStorage } from '../app/lib/file-version-center/proposal-storage';

type ProposalStorage = ReturnType<typeof createProposalGraphStorage>;
type ProposalStorageTransaction = Parameters<Parameters<ProposalStorage['withLockedGraph']>[2]>[0];

const scope: ProposalDocumentScopeV1 = {
  workspaceId: 'proposal-workspace',
  lineageId: 'proposal-lineage',
  documentId: 'proposal-document',
  lifecycleGeneration: 1,
  schemaVersion: 1,
};

const current = {
  revisionId: 'proposal-v0',
  contentHash: 'a'.repeat(64),
  structureHash: 'b'.repeat(64),
  stateVectorHash: 'c'.repeat(64),
  deleteSetHash: 'd'.repeat(64),
  fullStateHash: 'e'.repeat(64),
};

function reference(value: ProposalArtifactReferenceV1): ProposalArtifactReferenceV1 {
  return { ref: value.ref, sha256: value.sha256, sizeBytes: value.sizeBytes };
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function code(expected: string): (error: unknown) => boolean {
  return (error: unknown) => {
    if (expected.startsWith('PROPOSAL_')) assert.ok(error instanceof ProposalGraphContractError);
    assert.ok(error && typeof error === 'object' && 'code' in error);
    assert.equal(error.code, expected);
    return true;
  };
}

async function prepareStoredChain(transaction: ProposalStorageTransaction): Promise<{
  parent: ProposalNodeV1;
  child: ProposalNodeV1;
  independent: ProposalNodeV1;
  sourceBytes: Uint8Array;
  childBytes: Uint8Array;
}> {
  const document = new Y.Doc();
  document.clientID = 123;
  const blocks = document.getMap<string>('blocks');
  blocks.set('price', '10 EUR');
  blocks.set('delivery', '5 days');
  const sourceBytes = Y.encodeStateAsUpdate(document);
  blocks.set('price', '12 EUR');
  blocks.set('insurance', '100 EUR');
  const parentBytes = Y.encodeStateAsUpdate(document);
  blocks.set('insurance', '150 EUR');
  const childBytes = Y.encodeStateAsUpdate(document);
  document.destroy();

  const sourceSnapshot = await transaction.putArtifact('yjs_full_update_v1', sourceBytes);
  const parentSnapshot = await transaction.putArtifact('yjs_full_update_v1', parentBytes);
  const childSnapshot = await transaction.putArtifact('yjs_full_update_v1', childBytes);
  const anchorMap = reference(await transaction.putArtifact('json_v1', Buffer.from('{"price":"price","insurance":"insurance"}')));
  const preconditions = reference(await transaction.putArtifact('json_v1', Buffer.from('{"price":"10 EUR"}')));
  const parentPayload = reference(await transaction.putArtifact('json_v1', Buffer.from('{"price":"12 EUR","insurance":"100 EUR"}')));
  const childPayload = reference(await transaction.putArtifact('json_v1', Buffer.from('{"insurance":"150 EUR"}')));

  const parent = parseProposalNodeV1({
    contractVersion: 1,
    proposalId: 'stored-p1',
    operationId: 'proposal-operation-p1',
    scope,
    casVersion: 1,
    source: { kind: 'authoritative', scope, current, snapshot: sourceSnapshot, anchorMap },
    relationships: { dependency: null, replacesProposalId: null, choiceGroupId: null },
    authoredCandidate: {
      incrementalPayload: parentPayload,
      cumulativeCandidate: parentSnapshot,
      effectPreconditions: preconditions,
      sourceProofHash: 'f'.repeat(64),
    },
    lifecycle: 'open',
    createdAt: 10,
    createdByActorId: 'main',
  });
  const child = parseProposalNodeV1({
    ...parent,
    proposalId: 'stored-p2',
    operationId: 'proposal-operation-p2',
    source: {
      ...parent.source,
      kind: 'proposal', proposalId: 'stored-p1', proposalCasVersion: 1,
      candidateHash: parentSnapshot.sha256, authoredCandidateHash: parentSnapshot.sha256,
      evaluationId: null, snapshot: parentSnapshot,
    },
    relationships: {
      dependency: { proposalId: 'stored-p1', candidateHash: parentSnapshot.sha256 },
      replacesProposalId: null, choiceGroupId: null,
    },
    authoredCandidate: {
      ...parent.authoredCandidate, incrementalPayload: childPayload, cumulativeCandidate: childSnapshot,
    },
  });
  const independent = parseProposalNodeV1({
    ...parent, proposalId: 'stored-q', operationId: 'proposal-operation-q',
  });
  return { parent, child, independent, sourceBytes, childBytes };
}

/** The same behavioral suite runs against PGlite and an isolated PostgreSQL database. */
export type ProposalGraphStorageTestDatabase = FileVersionCenterDatabase & FileVersionCenterTransaction & {
  exec: (sql: string) => Promise<void>;
  close: () => Promise<void>;
  kind: 'pglite' | 'postgres';
};

export async function createProposalGraphStorageTestDatabase(): Promise<ProposalGraphStorageTestDatabase> {
  const databaseUrl = process.env.PROPOSAL_GRAPH_TEST_DATABASE_URL;
  if (!databaseUrl) {
    const database = new PGlite();
    return {
      kind: 'pglite',
      query: <Row>(sql: string, params?: unknown[]) => database.query<Row>(sql, params),
      exec: async (sql) => { await database.exec(sql); },
      transaction: (action) => database.transaction((transaction) => action({
        query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
      })),
      close: () => database.close(),
    };
  }

  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  assert.match(databaseName, /^proposal_graph_test_[a-z0-9_]+$/u,
    'Storage tests require an explicitly isolated proposal_graph_test_* database');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  return {
    kind: 'postgres',
    query: async <Row>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    exec: async (sql) => { await pool.query(sql); },
    transaction: async (action) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
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
    close: () => pool.end(),
  };
}

const PROPOSAL_TABLES = [
  'file_change_proposals',
  'file_proposal_action_receipts',
  'file_proposal_artifact_pins',
  'file_proposal_artifacts',
  'file_proposal_choice_groups',
  'file_proposal_choice_memberships',
  'file_proposal_evaluations',
  'file_proposal_graphs',
  'file_revision_proposal_bindings',
] as const;

async function proposalTableNames(database: ProposalGraphStorageTestDatabase): Promise<string[]> {
  const result = await database.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1)
    ORDER BY table_name
  `, [[...PROPOSAL_TABLES]]);
  return result.rows.map((row) => row.table_name);
}

export async function seedProposalGraphStorageTestScope(database: ProposalGraphStorageTestDatabase): Promise<void> {
  await database.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES ('proposal-owner', 'Proposal owner', 'proposal-owner@test.invalid', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('proposal-org', 'proposal-owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES
      ('proposal-workspace', 'proposal-org', 'personal', 'proposal-owner', 'workspaces/proposal-test', 'Proposal test', 'user-round', 'active', 1, 1, 1),
      ('proposal-other-workspace', 'proposal-org', 'team', NULL, 'workspaces/proposal-other', 'Other', 'users', 'active', 0, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, workspace_id, workspace_type, path, status, created_at
    ) VALUES
      ('proposal-lineage', 'proposal-workspace', 'personal', 'shipping.md', 'active', 1),
      ('proposal-other-lineage', 'proposal-other-workspace', 'team', 'shipping.md', 'active', 1);
    INSERT INTO collaboration_documents (
      id, workspace_id, workspace_type, path, lineage_id, provider,
      state_version, status, created_at, updated_at
    ) VALUES
      ('proposal-document', 'proposal-workspace', 'personal', 'shipping.md', 'proposal-lineage', 'yjs', 0, 'active', 1, 1),
      ('proposal-other-document', 'proposal-other-workspace', 'team', 'shipping.md', 'proposal-other-lineage', 'yjs', 0, 'active', 1, 1);
    INSERT INTO file_revisions (
      id, workspace_id, workspace_type, path, content_hash, size_bytes,
      created_by_actor_type, lineage_id, revision_number, created_at
    ) VALUES
      ('proposal-v0', 'proposal-workspace', 'personal', 'shipping.md', repeat('a', 64), 10, 'user', 'proposal-lineage', 1, 1),
      ('proposal-other-v0', 'proposal-other-workspace', 'team', 'shipping.md', repeat('b', 64), 10, 'user', 'proposal-other-lineage', 1, 1);
    INSERT INTO collaboration_agent_operations (
      operation_id, document_id, workspace_id, initiated_by_user_id, actor_id,
      idempotency_key, payload_hash, status, base_state_vector, created_at, updated_at
    ) VALUES
      ('proposal-legacy-operation', 'proposal-document', 'proposal-workspace', 'proposal-owner', 'main',
       'proposal-legacy-key', repeat('c', 64), 'needs_review', '\\x00', 1, 1),
      ('proposal-other-operation', 'proposal-other-document', 'proposal-other-workspace', 'proposal-owner', 'main',
       'proposal-other-key', repeat('d', 64), 'needs_review', '\\x00', 1, 1);
  `);
}

async function legacyRows(database: ProposalGraphStorageTestDatabase): Promise<unknown> {
  const operations = await database.query(`
    SELECT operation_id, document_id, workspace_id, payload_hash, status
    FROM collaboration_agent_operations
    WHERE operation_id IN ('proposal-legacy-operation', 'proposal-other-operation') ORDER BY operation_id
  `);
  const revisions = await database.query(`
    SELECT id, workspace_id, lineage_id, content_hash, revision_number
    FROM file_revisions WHERE id IN ('proposal-v0', 'proposal-other-v0') ORDER BY id
  `);
  return { operations: operations.rows, revisions: revisions.rows };
}

async function insertOperation(database: ProposalGraphStorageTestDatabase, operationId: string): Promise<void> {
  await database.query(`
    INSERT INTO collaboration_agent_operations (
      operation_id, document_id, workspace_id, initiated_by_user_id, actor_id,
      idempotency_key, payload_hash, status, base_state_vector, created_at, updated_at
    ) VALUES ($1, 'proposal-document', 'proposal-workspace', 'proposal-owner', 'main',
      $1, repeat('a', 64), 'needs_review', $2, 10, 10)
  `, [operationId, Buffer.from([0])]);
}

async function runStorageBehaviorScenarios(database: ProposalGraphStorageTestDatabase): Promise<void> {
  let clock = 100;
  let nextId = 0;
  const createStorage = () => createProposalGraphStorage({
    database, now: () => clock, createId: () => `stored-artifact-${++nextId}`,
  });
  const storage = createStorage();
  for (const operationId of [
    'proposal-operation-p1', 'proposal-operation-p2', 'proposal-operation-q',
    'proposal-operation-dangling', 'proposal-operation-bad-artifact', 'proposal-operation-chain',
    'proposal-operation-retained-parent', 'proposal-operation-retained-child',
    'proposal-operation-created-detach', 'proposal-operation-choice-a', 'proposal-operation-choice-b',
  ]) await insertOperation(database, operationId);

  const fixtures = await storage.withLockedGraph(scope, {}, prepareStoredChain);
  const initialGraph = await storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph());
  assert.equal(initialGraph.nodes.length, 0, 'stored artifacts do not create a proposal');
  await storage.withLockedGraph(scope, {}, async (transaction) => {
    await transaction.insertProposal(fixtures.parent);
    await transaction.insertProposal(fixtures.child);
    await transaction.insertProposal(fixtures.independent);
  });
  const graph = await storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph());
  assert.equal(graph.graphRevision, initialGraph.graphRevision + 1,
    'one transaction advances graph revision once, even when it creates several nodes');
  assert.deepEqual(graph.nodes.map((node) => node.proposalId).sort(), ['stored-p1', 'stored-p2', 'stored-q']);
  const earlierEvaluation = parseProposalEvaluationV1({
    contractVersion: 1, evaluationId: 'stored-evaluation-before-graph-change',
    proposalId: 'stored-p2', scope, current, graphRevision: graph.graphRevision,
    status: 'clean', reasonCode: null,
    effectiveCandidate: fixtures.child.authoredCandidate.cumulativeCandidate,
    anchorMap: fixtures.child.source.anchorMap,
    effectPreconditions: fixtures.child.authoredCandidate.effectPreconditions,
    evaluatedAt: clock, expiresAt: clock + 60_000,
  });
  await storage.withLockedGraph(scope, {}, (transaction) => transaction.putEvaluation(earlierEvaluation));

  // A new service instance reads exactly the persisted Yjs identities after restart.
  const restarted = createStorage();
  const persistedChild = await restarted.withLockedGraph(scope, {}, (transaction) => transaction.getProposal('stored-p2'));
  assert.deepEqual(persistedChild, fixtures.child);
  const persistedBytes = await restarted.withLockedGraph(scope, {}, (transaction) =>
    transaction.readArtifact(fixtures.child.authoredCandidate.cumulativeCandidate));
  assert.equal(sha256(persistedBytes), sha256(fixtures.childBytes));
  const restored = new Y.Doc();
  Y.applyUpdate(restored, persistedBytes);
  assert.deepEqual(restored.getMap('blocks').toJSON(), {
    price: '12 EUR', delivery: '5 days', insurance: '150 EUR',
  });
  restored.destroy();

  const missingParent = parseProposalNodeV1({
    ...fixtures.child,
    proposalId: 'dangling-child', operationId: 'proposal-operation-dangling',
    source: { ...fixtures.child.source, proposalId: 'missing-parent' },
    relationships: {
      ...fixtures.child.relationships,
      dependency: { ...fixtures.child.relationships.dependency, proposalId: 'missing-parent' },
    },
  });
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal(missingParent)), code('PROPOSAL_PARENT_CHANGED'));
  assert.equal(await storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal('dangling-child')), null);
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal({
    ...fixtures.independent,
    proposalId: 'bad-artifact', operationId: 'proposal-operation-bad-artifact',
    authoredCandidate: {
      ...fixtures.independent.authoredCandidate,
      effectPreconditions: { ...fixtures.independent.authoredCandidate.effectPreconditions, ref: 'missing-artifact' },
    },
  })), code('PROPOSAL_CONTENT_UNAVAILABLE'));
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.readArtifact({
    ...fixtures.parent.source.snapshot, sha256: '0'.repeat(64),
  })), code('PROPOSAL_CONTENT_UNAVAILABLE'));
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal(parseProposalNodeV1({
    ...fixtures.parent,
    proposalId: 'mismatched-encoding', operationId: 'proposal-operation-bad-artifact',
    source: {
      ...fixtures.parent.source,
      snapshot: { ...fixtures.parent.source.anchorMap, encoding: 'yjs_full_update_v1' },
    },
  }))), code('PROPOSAL_CONTENT_UNAVAILABLE'), 'JSON blob cannot masquerade as an identity-preserving Yjs snapshot');
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal(parseProposalNodeV1({
    ...fixtures.child, proposalId: 'stale-parent-cas', operationId: 'proposal-operation-dangling',
    source: { ...fixtures.child.source, proposalCasVersion: 9 },
  }))), code('PROPOSAL_PARENT_CHANGED'), 'parent CAS belongs to the source identity, not just its unchanged hash');
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal({
    ...fixtures.child, proposalId: 'stored-p1',
  })), code('PROPOSAL_CYCLE'), 'self dependency is rejected before touching storage');
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal({
    ...fixtures.parent, proposalId: 'foreign-operation', operationId: 'proposal-other-operation',
  })), code('23503'), 'database operation binding cannot cross document or workspace scope');

  const otherScope = {
    ...scope, workspaceId: 'proposal-other-workspace', lineageId: 'proposal-other-lineage', documentId: 'proposal-other-document',
  };
  await assert.rejects(storage.withLockedGraph(otherScope, {}, (transaction) =>
    transaction.readArtifact(fixtures.parent.source.snapshot)), code('PROPOSAL_CONTENT_UNAVAILABLE'));
  for (const field of ['workspaceId', 'lineageId', 'documentId', 'lifecycleGeneration', 'schemaVersion'] as const) {
    const foreignScope = { ...scope, [field]: typeof scope[field] === 'string' ? 'foreign-id' : 2 };
    await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal({
      ...fixtures.independent,
      scope: foreignScope,
      source: { ...fixtures.independent.source, scope: foreignScope },
    })), code('PROPOSAL_SCOPE_MISMATCH'), field);
  }
  await assert.rejects(database.query(`
    UPDATE file_change_proposals SET cas_version = cas_version + 2 WHERE proposal_id = 'stored-p1'
  `), code('23514'), 'database rejects a CAS jump');
  await assert.rejects(database.query(`
    UPDATE file_change_proposals SET node_json = jsonb_set(node_json, '{createdByActorId}', '"someone-else"'),
      cas_version = cas_version + 1 WHERE proposal_id = 'stored-p1'
  `), code('23514'), 'immutable authored provenance cannot be rewritten through SQL');
  await assert.rejects(database.query(`
    DELETE FROM file_proposal_artifacts WHERE artifact_ref = $1
  `, [fixtures.parent.authoredCandidate.cumulativeCandidate.ref]), code('23001'), 'pins prevent parent blob deletion');

  const changed = await storage.withLockedGraph(scope, {}, (transaction) =>
    transaction.transitionProposal('stored-q', 1, 'rejected'));
  assert.equal(changed.lifecycle, 'rejected');
  assert.equal(changed.casVersion, 2);
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) =>
    transaction.transitionProposal('stored-q', 1, 'applied')), code('PROPOSAL_GRAPH_CHANGED'));
  assert.equal((await storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal('stored-q')))?.lifecycle, 'rejected');

  // Give a terminal parent a unique payload that only its open descendant keeps alive.
  const ancestorOnlyPayload = await storage.withLockedGraph(scope, {}, async (transaction) => {
    const payload = reference(await transaction.putArtifact('json_v1', Buffer.from('{"retention":"ancestor-only"}')));
    const retainedParent = parseProposalNodeV1({
      ...fixtures.parent, proposalId: 'retained-parent', operationId: 'proposal-operation-retained-parent',
      authoredCandidate: { ...fixtures.parent.authoredCandidate, incrementalPayload: payload },
    });
    const retainedChild = parseProposalNodeV1({
      ...fixtures.child, proposalId: 'retained-child', operationId: 'proposal-operation-retained-child',
      source: { ...fixtures.child.source, proposalId: 'retained-parent' },
      relationships: {
        ...fixtures.child.relationships,
        dependency: { ...fixtures.child.relationships.dependency, proposalId: 'retained-parent' },
      },
    });
    await transaction.insertProposal(retainedParent);
    await transaction.insertProposal(retainedChild);
    await transaction.transitionProposal('retained-parent', 1, 'rejected');
    return payload;
  });

  const afterCas = await storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph());
  const evaluation = parseProposalEvaluationV1({
    contractVersion: 1,
    evaluationId: 'stored-evaluation-p2', proposalId: 'stored-p2', scope, current,
    graphRevision: afterCas.graphRevision,
    status: 'clean', reasonCode: null,
    effectiveCandidate: fixtures.child.authoredCandidate.cumulativeCandidate,
    anchorMap: fixtures.child.source.anchorMap,
    effectPreconditions: fixtures.child.authoredCandidate.effectPreconditions,
    evaluatedAt: clock, expiresAt: clock + 60_000,
  });
  await storage.withLockedGraph(scope, {}, (transaction) => transaction.putEvaluation(evaluation));
  assert.deepEqual(await restarted.withLockedGraph(scope, {}, (transaction) => transaction.getEvaluation(evaluation.evaluationId)), evaluation);
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.insertProposal(parseProposalNodeV1({
    ...fixtures.child, proposalId: 'wrong-evaluation-parent', operationId: 'proposal-operation-dangling',
    source: { ...fixtures.child.source, evaluationId: evaluation.evaluationId },
  }))), code('PROPOSAL_SOURCE_INVALID'), 'an evaluation of P2 is not a source proof for its parent P1');
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.putEvaluation({
    ...evaluation, status: 'conflicted', reasonCode: 'PROPOSAL_BATCH_CONFLICT',
  })), code('PROPOSAL_CANDIDATE_CHANGED'), 'an existing evaluation must not be overwritten under the same immutable identity');

  // Open descendants keep their parent/source/candidate proofs; only an orphan is collectible.
  const orphan = await storage.withLockedGraph(scope, {}, (transaction) =>
    transaction.putArtifact('json_v1', Buffer.from('{"unused":true}')));
  clock = 200;
  const collected = await storage.withLockedGraph(scope, {}, (transaction) => transaction.collectArtifacts(clock));
  assert.equal(collected.deleted, 1, 'only the unreferenced orphan is eligible for retention');
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.readArtifact(orphan)), code('PROPOSAL_CONTENT_UNAVAILABLE'));
  const parentAfterRetention = await storage.withLockedGraph(scope, {}, (transaction) =>
    transaction.readArtifact(fixtures.parent.authoredCandidate.cumulativeCandidate));
  assert.equal(sha256(parentAfterRetention), fixtures.parent.authoredCandidate.cumulativeCandidate.sha256);
  const retainedAncestorBytes = await storage.withLockedGraph(scope, {}, (transaction) => transaction.readArtifact(ancestorOnlyPayload));
  assert.equal(Buffer.from(retainedAncestorBytes).toString('utf8'), '{"retention":"ancestor-only"}',
    'a terminal ancestor remains pinned while an open descendant depends on it');

  const fence = parseProposalActionFenceV1({
    contractVersion: 1, fenceId: 'stored-fence-p2', scope,
    actor: { userId: 'proposal-owner', actorId: 'main', authorizationRevision: 'access-1' },
    actionType: 'accept', current, graphRevision: afterCas.graphRevision,
    evaluationId: evaluation.evaluationId,
    effectiveCandidateHash: fixtures.child.authoredCandidate.cumulativeCandidate.sha256,
    closure: [
      { proposalId: 'stored-p1', casVersion: 1, candidateHash: fixtures.parent.authoredCandidate.cumulativeCandidate.sha256 },
      { proposalId: 'stored-p2', casVersion: 1, candidateHash: fixtures.child.authoredCandidate.cumulativeCandidate.sha256 },
    ],
    closureHash: 'a'.repeat(64), selectedProposalIds: ['stored-p2'], applyProposalIds: ['stored-p1', 'stored-p2'],
    batchHash: 'b'.repeat(64), choiceResolutions: [], requestDigest: 'c'.repeat(64),
    issuedAt: 100, expiresAt: 60_100,
  });
  const receipt = parseProposalActionReceiptV1({
    contractVersion: 1, actionId: 'stored-action-p2', scope, actorId: 'proposal-owner', actionType: 'accept',
    requestDigest: fence.requestDigest, idempotencyKeyHash: 'd'.repeat(64),
    affectedProposalIds: ['stored-p1', 'stored-p2'], operationId: 'proposal-operation-chain',
    createdAt: 200, updatedAt: 200, phase: 'prepared', result: null, errorCode: null,
  });
  const request = { fence, creation: null };
  const actionContext = { actionId: receipt.actionId };
  await assert.rejects(storage.withLockedGraph(scope, actionContext, (transaction) => transaction.reserveAction(receipt, {
    ...request, fence: { ...fence, current: { ...current, fullStateHash: '0'.repeat(64) } },
  })), code('PROPOSAL_CANDIDATE_CHANGED'), 'same candidate hash cannot hide a different current proof');
  await assert.rejects(storage.withLockedGraph(scope, actionContext, (transaction) => transaction.reserveAction(receipt, {
    ...request, fence: { ...fence, evaluationId: earlierEvaluation.evaluationId },
  })), code('PROPOSAL_CANDIDATE_CHANGED'), 'same result hash cannot make an old graph evaluation current');
  const otherProposalEvaluation = parseProposalEvaluationV1({
    ...evaluation, evaluationId: 'stored-evaluation-other-proposal', proposalId: 'retained-child',
  });
  await storage.withLockedGraph(scope, {}, (transaction) => transaction.putEvaluation(otherProposalEvaluation));
  await assert.rejects(storage.withLockedGraph(scope, actionContext, (transaction) => transaction.reserveAction(receipt, {
    ...request, fence: { ...fence, evaluationId: otherProposalEvaluation.evaluationId },
  })), code('PROPOSAL_CANDIDATE_CHANGED'), 'an evaluation of another proposal cannot approve this selection');
  await assert.rejects(storage.withLockedGraph(scope, actionContext, (transaction) => transaction.reserveAction({
    ...receipt, affectedProposalIds: ['stored-p2'],
  }, request)), code('PROPOSAL_INVALID_REQUEST'), 'receipt must record every implicitly included parent');
  const unexpectedCreation = parseProposalCreateRequestV1({
    contractVersion: 1, proposalId: 'unexpected-created-proposal', operationId: 'unused-created-operation',
    scope, source: fixtures.parent.source, relationships: fixtures.parent.relationships,
    authoredCandidate: fixtures.parent.authoredCandidate,
    creationKind: 'independent', detachedFromProposalId: null, reviewRequired: true,
  });
  await assert.rejects(storage.withLockedGraph(scope, actionContext, (transaction) => transaction.reserveAction(receipt, {
    fence, creation: unexpectedCreation,
  })), code('PROPOSAL_INVALID_REQUEST'), 'accept cannot smuggle in an unreviewed creation');
  const reserved = await storage.withLockedGraph(scope, actionContext, (transaction) => transaction.reserveAction(receipt, request));
  assert.deepEqual(reserved, receipt);
  assert.deepEqual(await restarted.withLockedGraph(scope, actionContext, (transaction) => transaction.getAction(receipt.actionId)), receipt);
  assert.deepEqual(await restarted.withLockedGraph(scope, actionContext, (transaction) => transaction.getActionRequest(receipt.actionId)), request,
    'restart retains exact reviewed closure and result identity, without an approval token');
  assert.deepEqual(await storage.withLockedGraph(scope, actionContext, (transaction) => transaction.reserveAction(receipt, request)), receipt,
    'an identical lost-response retry returns the original receipt');
  await assert.rejects(storage.withLockedGraph(otherScope, {}, (transaction) => transaction.reserveAction({
    ...receipt, actionId: 'foreign-action-same-key', scope: otherScope,
  }, { ...request, fence: { ...fence, scope: otherScope } })), code('PROPOSAL_IDEMPOTENCY_MISMATCH'),
  'an authenticated actor cannot reuse the same idempotency key in another document scope');
  await assert.rejects(storage.withLockedGraph(scope, actionContext, (transaction) => transaction.reserveAction({
    ...receipt, requestDigest: 'e'.repeat(64),
  }, { ...request, fence: { ...fence, requestDigest: 'e'.repeat(64) } })), code('PROPOSAL_IDEMPOTENCY_MISMATCH'),
  'same action identity cannot authorize a changed request');

  await storage.withLockedGraph(scope, actionContext, (transaction) => transaction.advanceAction(parseProposalActionReceiptV1({
    ...receipt, phase: 'applying', updatedAt: 201,
  })));
  await storage.withLockedGraph(scope, actionContext, (transaction) => transaction.advanceAction(parseProposalActionReceiptV1({
    ...receipt, phase: 'awaiting_durability', updatedAt: 202,
  })));
  clock = 300;
  const retained = await storage.withLockedGraph(scope, actionContext, (transaction) => transaction.collectArtifacts(300));
  assert.equal(retained.deleted, 0, 'pending action and its parent/evaluation proofs remain retained');
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.transitionProposal('stored-p1', 1, 'rejected')), code('PROPOSAL_RECOVERY_REQUIRED'),
    'a competing graph mutation cannot cross an unresolved content action');

  await database.query(`
    INSERT INTO file_revisions (
      id, workspace_id, workspace_type, path, content_hash, size_bytes,
      created_by_actor_type, lineage_id, revision_number, created_at
    ) VALUES ('proposal-v1', 'proposal-workspace', 'personal', 'shipping.md', $1, $2,
      'agent', 'proposal-lineage', 2, 300)
  `, [fixtures.child.authoredCandidate.cumulativeCandidate.sha256, fixtures.childBytes.byteLength]);
  const durableResult = {
    kind: 'content_changed', revisionId: 'proposal-v1',
    current: { ...current, revisionId: 'proposal-v1', contentHash: fixtures.child.authoredCandidate.cumulativeCandidate.sha256 },
    resolutions: [
      { proposalId: 'stored-p1', lifecycle: 'included' },
      { proposalId: 'stored-p2', lifecycle: 'applied' },
    ],
    createdProposalIds: [],
  };
  const succeeded = parseProposalActionReceiptV1({
    ...receipt, phase: 'succeeded', updatedAt: 300, result: durableResult,
  });
  await assert.rejects(storage.withLockedGraph(scope, actionContext, (transaction) => transaction.advanceAction(succeeded)),
    code('PROPOSAL_RECOVERY_REQUIRED'), 'new receipt cannot invent durability of its underlying operation');
  const durableDocument = new Y.Doc();
  Y.applyUpdate(durableDocument, fixtures.childBytes);
  const durableSnapshot = Y.encodeSnapshot(Y.snapshot(durableDocument));
  durableDocument.destroy();
  await database.query(`
    UPDATE collaboration_agent_operations SET persisted_at = 300, checkpoint_revision_id = 'proposal-v1',
      resulting_state_snapshot = $1 WHERE operation_id = 'proposal-operation-chain'
  `, [Buffer.from(durableSnapshot)]);
  await assert.rejects(storage.withLockedGraph(scope, actionContext, (transaction) => transaction.advanceAction(succeeded)),
    code('PROPOSAL_INVALID_TRANSITION'), 'successful action cannot commit without proposal resolution and revision binding');
  assert.equal((await storage.withLockedGraph(scope, actionContext, (transaction) => transaction.getAction(receipt.actionId)))?.phase,
    'awaiting_durability', 'failed incomplete finalization leaves its durable reservation intact');
  assert.equal((await storage.withLockedGraph(scope, actionContext, (transaction) => transaction.getProposal('stored-p1')))?.lifecycle, 'open');
  await assert.rejects(storage.withLockedGraph(scope, actionContext, async (transaction) => {
    await transaction.transitionProposal('stored-p2', 1, 'applied');
    await transaction.advanceAction(parseProposalActionReceiptV1({
      ...succeeded,
      result: { ...durableResult, resolutions: [{ proposalId: 'stored-p2', lifecycle: 'applied' }] },
    }));
    await transaction.bindRevision('proposal-v1', receipt.actionId, [
      { proposalId: 'stored-p2', resolution: 'applied', applicationOrder: 0 },
    ]);
  }), code('PROPOSAL_INVALID_TRANSITION'), 'success cannot omit the parent approved in the apply set');
  assert.equal((await storage.withLockedGraph(scope, actionContext, (transaction) => transaction.getProposal('stored-p2')))?.lifecycle, 'open');
  await storage.withLockedGraph(scope, actionContext, async (transaction) => {
    await transaction.transitionProposal('stored-p1', 1, 'included');
    await transaction.transitionProposal('stored-p2', 1, 'applied');
    await transaction.advanceAction(succeeded);
    await transaction.bindRevision('proposal-v1', receipt.actionId, [
      { proposalId: 'stored-p1', resolution: 'included', applicationOrder: 0 },
      { proposalId: 'stored-p2', resolution: 'applied', applicationOrder: 1 },
    ]);
  });
  const finalReceipt = await restarted.withLockedGraph(scope, {}, (transaction) => transaction.getAction(receipt.actionId));
  assert.equal(finalReceipt?.phase, 'succeeded');
  const bindings = await database.query<{ proposal_id: string; resolution: string; application_order: number }>(`
    SELECT proposal_id, resolution, application_order FROM file_revision_proposal_bindings
    WHERE revision_id = 'proposal-v1' ORDER BY application_order
  `);
  assert.deepEqual(bindings.rows.map((row) => ({ ...row, application_order: Number(row.application_order) })), [
    { proposal_id: 'stored-p1', resolution: 'included', application_order: 0 },
    { proposal_id: 'stored-p2', resolution: 'applied', application_order: 1 },
  ]);
  const revisionCount = await database.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM file_revisions WHERE id = 'proposal-v1'
  `);
  assert.equal(revisionCount.rows[0]?.count, '1', 'chain audit points to one authoritative revision');

  clock = 400;
  const creation = await storage.withLockedGraph(scope, {}, async (transaction) => {
    const document = new Y.Doc();
    Y.applyUpdate(document, fixtures.childBytes);
    document.getMap('blocks').set('delivery', '2 days');
    const candidate = await transaction.putArtifact('yjs_full_update_v1', Y.encodeStateAsUpdate(document));
    document.destroy();
    const payload = reference(await transaction.putArtifact('json_v1', Buffer.from('{"delivery":"2 days"}')));
    return parseProposalCreateRequestV1({
      contractVersion: 1, proposalId: 'detached-new', operationId: 'proposal-operation-created-detach', scope,
      source: {
        kind: 'authoritative', scope, current: durableResult.current,
        snapshot: fixtures.child.authoredCandidate.cumulativeCandidate, anchorMap: fixtures.child.source.anchorMap,
      },
      relationships: { dependency: null, replacesProposalId: null, choiceGroupId: null },
      authoredCandidate: {
        ...fixtures.child.authoredCandidate, incrementalPayload: payload, cumulativeCandidate: candidate,
      },
      creationKind: 'detached', detachedFromProposalId: 'retained-child', reviewRequired: true,
    });
  });
  const detachGraph = await storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph());
  const detachFence = parseProposalActionFenceV1({
    ...fence,
    fenceId: 'stored-detach-fence', actionType: 'detach', graphRevision: detachGraph.graphRevision,
    current: durableResult.current, evaluationId: null, effectiveCandidateHash: null,
    closure: [{ proposalId: 'retained-child', casVersion: 1, candidateHash: fixtures.child.authoredCandidate.cumulativeCandidate.sha256 }],
    selectedProposalIds: ['retained-child'], applyProposalIds: [], requestDigest: 'e'.repeat(64),
    issuedAt: 400, expiresAt: 60_400,
  });
  const detachReceipt = parseProposalActionReceiptV1({
    ...receipt, actionId: 'stored-action-detach', actionType: 'detach', requestDigest: detachFence.requestDigest,
    idempotencyKeyHash: 'f'.repeat(64), affectedProposalIds: ['retained-child'], operationId: null,
    phase: 'prepared', result: null, createdAt: 400, updatedAt: 400,
  });
  const detachContext = { actionId: detachReceipt.actionId };
  await storage.withLockedGraph(scope, detachContext, (transaction) => transaction.reserveAction(detachReceipt, {
    fence: detachFence, creation,
  }));
  clock = 500;
  assert.equal((await storage.withLockedGraph(scope, detachContext, (transaction) => transaction.collectArtifacts(clock))).deleted, 1,
    'completed action may release its unreferenced original payload');
  await assert.rejects(storage.withLockedGraph(scope, detachContext, (transaction) =>
    transaction.readArtifact(fixtures.parent.authoredCandidate.incrementalPayload)), code('PROPOSAL_CONTENT_UNAVAILABLE'));
  assert.equal(Buffer.from(await storage.withLockedGraph(scope, detachContext, (transaction) =>
    transaction.readArtifact(creation.authoredCandidate.incrementalPayload))).toString('utf8'), '{"delivery":"2 days"}',
  'pending creation retains its incremental payload before the new proposal exists');
  assert.equal(sha256(await storage.withLockedGraph(scope, detachContext, (transaction) =>
    transaction.readArtifact(creation.authoredCandidate.cumulativeCandidate))), creation.authoredCandidate.cumulativeCandidate.sha256,
  'pending creation retains its candidate before the new proposal exists');

  const detachedResult = {
    kind: 'metadata_only', revisionId: null, current: durableResult.current,
    resolutions: [], createdProposalIds: ['detached-new'],
  };
  const detachedSucceeded = parseProposalActionReceiptV1({
    ...detachReceipt, phase: 'succeeded', updatedAt: 500, result: detachedResult,
  });
  await assert.rejects(storage.withLockedGraph(scope, detachContext, (transaction) => transaction.advanceAction(parseProposalActionReceiptV1({
    ...detachedSucceeded, result: { ...detachedResult, createdProposalIds: ['stored-q'] },
  }))), code('PROPOSAL_INVALID_TRANSITION'), 'an existing unrelated proposal cannot stand in for the prepared creation');
  const detachedNode = parseProposalNodeV1({
    contractVersion: 1, proposalId: creation.proposalId, operationId: creation.operationId,
    scope: creation.scope, source: creation.source, relationships: creation.relationships,
    authoredCandidate: creation.authoredCandidate, lifecycle: 'open', casVersion: 1,
    createdAt: 500, createdByActorId: 'main',
  });
  await assert.rejects(storage.withLockedGraph(scope, detachContext, async (transaction) => {
    await transaction.insertProposal({
      ...detachedNode,
      authoredCandidate: { ...detachedNode.authoredCandidate, incrementalPayload: ancestorOnlyPayload },
    });
    await transaction.advanceAction(detachedSucceeded);
  }), code('PROPOSAL_INVALID_TRANSITION'), 'created proposal content must match the approved prepared creation');
  assert.equal(await storage.withLockedGraph(scope, detachContext, (transaction) => transaction.getProposal('detached-new')), null);
  await storage.withLockedGraph(scope, detachContext, async (transaction) => {
    await transaction.insertProposal(detachedNode);
    await transaction.advanceAction(detachedSucceeded);
  });
  assert.equal((await storage.withLockedGraph(scope, {}, (transaction) => transaction.getProposal('detached-new')))?.lifecycle, 'open');

  // Resolving a choice must not re-insert its existing immutable memberships.
  await storage.withLockedGraph(scope, {}, async (transaction) => {
    const incrementalPayload = reference(await transaction.putArtifact('json_v1', Buffer.from('{"price":"12 EUR","insurance":"100 EUR"}')));
    const choiceParent = { ...fixtures.parent, authoredCandidate: { ...fixtures.parent.authoredCandidate, incrementalPayload } };
    await transaction.insertProposal({ ...choiceParent, proposalId: 'choice-a', operationId: 'proposal-operation-choice-a' });
    await transaction.insertProposal({ ...choiceParent, proposalId: 'choice-b', operationId: 'proposal-operation-choice-b' });
    await transaction.putChoiceGroup({
      groupId: 'stored-choice', groupRevision: 0, dependencyProposalId: null,
      memberProposalIds: ['choice-a', 'choice-b'], chosenProposalId: null,
    }, null);
  });
  await storage.withLockedGraph(scope, {}, (transaction) => transaction.putChoiceGroup({
    groupId: 'stored-choice', groupRevision: 1, dependencyProposalId: null,
    memberProposalIds: ['choice-a', 'choice-b'], chosenProposalId: 'choice-a',
  }, 0));
  const chosen = await storage.withLockedGraph(scope, {}, (transaction) => transaction.loadGraph());
  assert.equal(chosen.choiceGroups.find((group) => group.groupId === 'stored-choice')?.chosenProposalId, 'choice-a');
  await assert.rejects(storage.withLockedGraph(scope, {}, (transaction) => transaction.putChoiceGroup({
    groupId: 'stored-choice', groupRevision: 2, dependencyProposalId: null,
    memberProposalIds: ['choice-a', 'choice-b'], chosenProposalId: 'choice-b',
  }, 1)), code('PROPOSAL_CHOICE_CONFLICT'), 'chosen alternative cannot be silently changed');
}

export async function runProposalGraphStorageSuite(database: ProposalGraphStorageTestDatabase): Promise<void> {
  const existingTables = await database.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  assert.equal(existingTables.rows[0]?.count, '0',
    'Storage suite requires an empty isolated database and refuses to modify an existing schema');
  await runPostgresMigrations(database as unknown as Parameters<typeof runPostgresMigrations>[0]);
  await rollbackProposalGraphStorageMigration(database);
  await seedProposalGraphStorageTestScope(database);
  const legacyBeforeMigration = await legacyRows(database);
  assert.deepEqual(await proposalTableNames(database), []);

  await runProposalGraphStorageMigration(database);
  await runProposalGraphStorageMigration(database);
  assert.deepEqual(await proposalTableNames(database), [...PROPOSAL_TABLES]);
  assert.deepEqual(await legacyRows(database), legacyBeforeMigration,
    'repeatable proposal migration preserves existing reviews and historical versions');

  await runStorageBehaviorScenarios(database);

  await rollbackProposalGraphStorageMigration(database);
  assert.deepEqual(await proposalTableNames(database), []);
  assert.deepEqual(await legacyRows(database), legacyBeforeMigration,
    'proposal rollback preserves all pre-existing reviews and versions');
  await runProposalGraphStorageMigration(database);
  assert.deepEqual(await proposalTableNames(database), [...PROPOSAL_TABLES]);
}

async function main(): Promise<void> {
  const database = await createProposalGraphStorageTestDatabase();
  try {
    await runProposalGraphStorageSuite(database);
    console.log(`proposal-graph-storage-test: ok (${database.kind})`);
  } finally {
    await database.close();
  }
}

if (path.resolve(process.argv[1] ?? '') === __filename) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
