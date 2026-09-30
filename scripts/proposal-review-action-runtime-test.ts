import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { Y } from '../app/lib/collaboration/server-runtime';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError,
  type ProposalActionReceiptV1, type ProposalEvaluationV1, type ProposalGraphSnapshotV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { hashProposalEvaluationSelectionV1 } from '../app/lib/file-version-center/proposal-action-fence';
import { createRuntimeProposalReviewActionService } from '../app/lib/file-version-center/proposal-review-action-runtime';
import { proposalYjsCurrentProof } from '../app/lib/file-version-center/proposal-yjs-candidate';
import { serverPreferencesPath } from '../app/lib/terminal-policy';
import type { FileVersionCenterDatabase, FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import type { ProposalGraphStorageTransaction } from '../app/lib/file-version-center/proposal-storage';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { alternativeChildFixture, childProposalFixture, proposalScopeFixture,
  rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const secret = 'review-action-test-signing-secret-32-bytes';
const previousDataRoot = process.env.CANVAS_DATA_ROOT;
const testDataRoot = mkdtempSync(join(tmpdir(), 'canvas-review-action-'));
before(() => {
  process.env.CANVAS_DATA_ROOT = testDataRoot;
  mkdirSync(dirname(serverPreferencesPath()), { recursive: true });
  setReviewEnabled(true);
});
after(() => {
  if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
  else process.env.CANVAS_DATA_ROOT = previousDataRoot;
  rmSync(testDataRoot, { recursive: true, force: true });
});
function setReviewEnabled(enabled: boolean): void {
  writeFileSync(serverPreferencesPath(), JSON.stringify({ version: 1, settings: {
    documentReviewEnabled: enabled, documentReviewUpdatedAt: new Date().toISOString(),
  } }));
}
const clock = 1_789_646_400_100;
const target: ResolvedFileVersionTarget = { workspaceId: proposalScopeFixture.workspaceId,
  lineageId: proposalScopeFixture.lineageId, documentId: proposalScopeFixture.documentId, path: 'review.md',
  latestRevisionId: null, latestRevisionHash: null, latestRevisionSize: 0 };
const workspace: WorkspaceContext = { workspaceId: target.workspaceId, workspaceType: 'team', rootPath: '/unused',
  organizationId: 'org-review', actor: { userId: 'reviewer', role: 'member', email: 'reviewer@example.test' }, legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: false, canCreatePublicLinks: false,
    canManageWorkspace: false, canRunAgent: false } };
const access: FileVersionCenterAccess = { userId: 'reviewer', authenticatedWorkspaceId: target.workspaceId,
  requestedWorkspaceId: target.workspaceId, membership: 'active', permissionsResolved: true, canRead: true,
  canWrite: true, canManageWorkspace: false };
const document = new Y.Doc({ gc: false });
document.getText('content').insert(0, 'current');
const update = Y.encodeStateAsUpdate(document);
document.destroy();
const proof = proposalYjsCurrentProof({ update, representation: 'plain_text', revisionId: null });

function state(): PersistedCollaborationState {
  return { documentId: target.documentId!, workspaceId: target.workspaceId, organizationId: 'org-review',
    path: target.path, representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: update, stateVector: new Uint8Array(), documentSequence: 4, persistedAt: 1, checkpointedAt: null,
    checkpointSequence: 0, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active' };
}

function harness(options: { owner?: string; write?: boolean; manager?: boolean; enabled?: boolean; rolloutWritable?: boolean;
  graphRevision?: number; evaluationStatus?: 'clean' | 'satisfied_elsewhere' | 'empty_effect'; withChildren?: boolean;
  session?: string | null } = {}) {
  let applyCalls = 0;
  let recoverCalls = 0;
  let failApply = false;
  let interruptMetadata = false;
  let afterTransaction: (() => void) | undefined;
  let activeSql: FileVersionCenterTransaction | null = null;
  let admissionReserved = false;
  const statements: string[] = [];
  const snapshot: ProposalGraphSnapshotV1 = { contractVersion: 1, scope: proposalScopeFixture,
    graphRevision: options.graphRevision ?? 3,
    nodes: (options.withChildren ? [rootProposalFixture, childProposalFixture, alternativeChildFixture] : [rootProposalFixture])
      .map((node) => ({ ...node, lifecycle: 'open' as const })) as ProposalGraphSnapshotV1['nodes'],
    choiceGroups: options.withChildren ? [{ groupId: 'choice-insurance', groupRevision: 1,
      dependencyProposalId: 'p1', memberProposalIds: ['p2', 'p3'], chosenProposalId: null }] : [] };
  const selectionHash = hashProposalEvaluationSelectionV1({ selectedProposalIds: ['p1'], closureProposalIds: ['p1'],
    applyProposalIds: ['p1'], graphRevision: 3 });
  const evaluation: ProposalEvaluationV1 = { contractVersion: 1, evaluationId: 'evaluation-p1', proposalId: 'p1',
    scope: proposalScopeFixture, current: proof, graphRevision: 3, selectionHash,
    status: options.evaluationStatus ?? 'clean', reasonCode: null,
    effectiveCandidate: { ref: 'candidate', sha256: createHash('sha256').update(update).digest('hex'),
      sizeBytes: update.byteLength, encoding: 'yjs_full_update_v1' },
    anchorMap: { ref: 'anchors', sha256: 'b'.repeat(64), sizeBytes: 1 },
    effectPreconditions: { ref: 'preconditions', sha256: 'c'.repeat(64), sizeBytes: 1 },
    evaluatedAt: clock, expiresAt: clock + 10_000 };
  const binding = { evaluationId: evaluation.evaluationId, selectedProposalIds: ['p1'], selectionHash,
    graphRevision: 3, current: proof };
  const actions = new Map<string, ProposalActionReceiptV1>();
  const requests = new Map<string, unknown>();
  const sql: FileVersionCenterTransaction = { query: async <Row>(statement: string, parameters: unknown[] = []) => {
    statements.push(statement);
    if (statement.includes('FROM collaboration_admission_scopes')) {
      return { rows: admissionReserved ? [{ request_id: 'reserved-request' }] as Row[] : [] };
    }
    if (statement.includes('FROM collaboration_admission_targets')) {
      return { rows: admissionReserved ? [{ request_id: 'reserved-request' }] as Row[] : [] };
    }
    if (statement.includes('pg_advisory_xact_lock')) return { rows: [] as Row[] };
    if (statement.includes('SELECT id FROM file_collaboration_lineages')) return { rows: [{ id: target.lineageId }] as Row[] };
    if (statement.includes('SELECT document_id FROM collaboration_yjs_states')) return { rows: [{ document_id: target.documentId }] as Row[] };
    if (statement.includes('FROM file_proposal_action_receipts')) {
      const action = [...actions.values()].find((item) => item.actorId === 'reviewer'
        && item.idempotencyKeyHash === parameters[1]);
      return { rows: action ? [{ action_id: action.actionId }] as Row[] : [] };
    }
    if (statement.includes('FROM collaboration_documents')) return { rows: [{
      lineage_id: target.lineageId, document_workspace_id: target.workspaceId, document_path: target.path,
      document_status: 'active', provider: 'yjs', lineage_workspace_id: target.workspaceId,
      lineage_path: target.path, lineage_status: 'active', workspace_id: target.workspaceId,
      organization_id: 'org-review', path: target.path, representation: 'plain_text', lifecycle_generation: 1,
      schema_version: 1, document_sequence: 4, status: 'active', degraded: false,
    }] as Row[] };
    if (statement.includes('FROM file_change_proposals')) return { rows: (parameters[5] as string[]).map((id) => ({
      proposal_id: id, initiated_by_user_id: options.owner ?? 'reviewer' })) as Row[] };
    throw new Error(`Unexpected query: ${statement.slice(0, 70)}`);
  } };
  const database = { transaction: async <T>(action: (tx: FileVersionCenterTransaction) => Promise<T>) => {
    assert.equal(activeSql, null, 'runtime must reuse, not nest, its owner transaction');
    const savedActions = structuredClone([...actions.entries()]);
    const savedRequests = structuredClone([...requests.entries()]);
    const savedNodes = structuredClone(snapshot.nodes);
    const savedRevision = snapshot.graphRevision;
    activeSql = sql;
    try { return await action(sql); }
    catch (error) {
      actions.clear(); for (const [key, value] of savedActions) actions.set(key, value);
      requests.clear(); for (const [key, value] of savedRequests) requests.set(key, value);
      snapshot.nodes.splice(0, snapshot.nodes.length, ...savedNodes);
      snapshot.graphRevision = savedRevision;
      throw error;
    } finally { activeSql = null; }
  } } as FileVersionCenterDatabase;
  const graphTransaction = {
    loadGraph: async () => structuredClone(snapshot), getEvaluation: async (id: string) => id === evaluation.evaluationId ? evaluation : null,
    readArtifact: async () => update,
    reserveAction: async (receipt: ProposalActionReceiptV1, request: unknown) => {
      const existing = [...actions.values()].find((item) => item.idempotencyKeyHash === receipt.idempotencyKeyHash);
      if (existing) return existing;
      actions.set(receipt.actionId, receipt); requests.set(receipt.actionId, request); return receipt;
    },
    getAction: async (id: string) => actions.get(id) ?? null,
    getActionRequest: async (id: string) => requests.get(id) ?? null,
    advanceAction: async (receipt: ProposalActionReceiptV1) => { actions.set(receipt.actionId, receipt); },
    transitionProposal: async (_id: string, _cas: number, lifecycle: string) => {
      const node = snapshot.nodes.find((candidate) => candidate.proposalId === _id)!;
      node.lifecycle = lifecycle as typeof node.lifecycle;
      node.casVersion += 1;
      snapshot.graphRevision += 1;
      return node;
    },
    bindRevision: async () => {},
  } as unknown as ProposalGraphStorageTransaction;
  const storage = { withLockedGraph: async <T>(_scope: unknown, _options: unknown,
    action: (transaction: ProposalGraphStorageTransaction, tx: FileVersionCenterTransaction) => Promise<T>) => {
    assert.equal(activeSql, sql, 'graph storage must receive the outer action transaction');
    if (interruptMetadata && [...actions.values()].some((receipt) => receipt.phase === 'prepared')) {
      interruptMetadata = false;
      throw new Error('simulated interruption after committed metadata reservation');
    }
    const result = await action(graphTransaction, sql);
    afterTransaction?.();
    return result;
  } };
  const createService = () => createRuntimeProposalReviewActionService({ target,
    workspace: { ...workspace, permissions: { ...workspace.permissions, canManageWorkspace: options.manager ?? false } },
    access: { ...access, canWrite: options.write ?? true, canManageWorkspace: options.manager ?? false },
    reviewerSessionId: options.session === null ? undefined : options.session ?? 'reviewer-session-1234',
    dependencies: { database, createStorage: () => storage,
      loadState: async () => { assert.equal(activeSql, null, 'unscoped state reader used inside transaction'); return state(); },
      loadStateOnConnection: async (connection, documentId) => {
        assert.ok(activeSql, 'scoped state reader requires the owner transaction');
        assert.equal(documentId, target.documentId);
        assert.equal(typeof connection.get, 'function');
        return state();
      },
      readCurrent: async () => update,
      readWorkspace: async () => { assert.equal(activeSql, null, 'unscoped workspace reader used inside transaction'); return { ...workspace, permissions: { ...workspace.permissions,
        canWrite: options.write ?? true, canManageWorkspace: options.manager ?? false } }; },
      readWorkspaceOnConnection: async (connection, userId, workspaceId) => {
        assert.ok(activeSql, 'scoped workspace reader requires the owner transaction');
        assert.equal(userId, 'reviewer'); assert.equal(workspaceId, target.workspaceId);
        assert.equal(typeof connection.get, 'function'); assert.equal(typeof connection.all, 'function');
        assert.throws(() => connection.run('UPDATE forbidden'), /cannot write/u);
        assert.throws(() => connection.close(), /cannot release/u);
        return { ...workspace, permissions: { ...workspace.permissions,
          canWrite: options.write ?? true, canManageWorkspace: options.manager ?? false } };
      },
      signingSecret: secret, writesEnabled: () => options.enabled ?? true,
      rolloutWritable: () => options.rolloutWritable ?? true,
      prepareDurably: async (request) => { assert.equal(request.actorSessionId, 'reviewer-session-1234'); },
      applyDurably: async (request) => {
        assert.equal(request.actorType, 'user');
        assert.equal(request.actorSessionId, 'reviewer-session-1234');
        applyCalls++;
        if (failApply) throw new Error('simulated uncertain durable response');
        return { operationId: request.actionId, revisionId: 'revision-action',
          current: { ...proof, revisionId: 'revision-action' } };
      },
      recoverDurably: async (request) => {
        recoverCalls++;
        return { operationId: request.actionId, revisionId: 'revision-action',
          current: { ...proof, revisionId: 'revision-action' } };
      },
      now: () => clock, createId: (() => { let next = 0; return () => `action-${++next}`; })() } });
  return { service: createService(), reopen: createService, binding, snapshot, actions,
    applyCalls: () => applyCalls, recoverCalls: () => recoverCalls,
    failApply: () => { failApply = true; }, interruptMetadata: () => { interruptMetadata = true; },
    afterTransaction: (callback?: () => void) => { afterTransaction = callback; },
    setAdmissionReserved: (value: boolean) => { admissionReserved = value; },
    statementCount: () => statements.length, statementsSince: (index: number) => statements.slice(index) };
}

const code = (expected: string) => (error: unknown) => error instanceof ProposalGraphContractError && error.code === expected;

test('closed rollout denies new actions but permits an authorized absent receipt lookup', async () => {
  for (const options of [{ enabled: false }, { rolloutWritable: false }]) {
    const h = harness(options);
    const runtime = await h.service;
    await assert.rejects(runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'reject' }), code(Codes.upgradeRequired));
    await assert.rejects(runtime.prepareTransform({ kind: 'replace', sourceProposalId: 'p1', expectedGraphRevision: 3 }),
      code(Codes.upgradeRequired));
    await assert.rejects(runtime.execute({}), code(Codes.upgradeRequired));
    assert.equal(await runtime.status({ idempotencyKey: 'unreserved-action-0001', requestDigest: '0'.repeat(64) }), null);
    assert.equal(h.actions.size, 0);
    assert.equal(h.applyCalls(), 0);
    assert.equal(h.recoverCalls(), 0);
  }
  await assert.rejects(harness({ write: false }).service, code(Codes.accessDenied));
});

test('instance review switch cannot be bypassed by an injected rollout capability', async () => {
  setReviewEnabled(false);
  try {
    const h = harness({ enabled: true, rolloutWritable: true });
    const runtime = await h.service;
    await assert.rejects(runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'reject' }),
      code(Codes.upgradeRequired));
    assert.equal(h.actions.size, 0);
  } finally {
    setReviewEnabled(true);
  }
});

test('prepare signs only the exact stored evaluation selection and current proof', async () => {
  const h = harness();
  const runtime = await h.service;
  const beforePrepare = h.statementCount();
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'accept', binding: h.binding });
  assert.equal(h.statementsSince(beforePrepare).some((statement) => statement.includes('pg_advisory_xact_lock')), false,
    'read-only preparation must not acquire the admission guard');
  assert.equal(prepared.fence.evaluationId, 'evaluation-p1');
  assert.deepEqual(prepared.fence.current, proof);
  assert.equal(prepared.fenceToken.startsWith('pg1.'), true);
  await assert.rejects(runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'accept',
    binding: { ...h.binding, selectionHash: '0'.repeat(64) } }), code(Codes.candidateChanged));
});

test('graph revision and owner changes fail before issuing approval', async () => {
  const stale = harness({ graphRevision: 4 });
  await assert.rejects((await stale.service).prepare({ selectedProposalIds: ['p1'], actionType: 'accept', binding: stale.binding }),
    code(Codes.candidateChanged));
  const foreign = harness({ owner: 'other-user' });
  await assert.rejects((await foreign.service).prepare({ selectedProposalIds: ['p1'], actionType: 'reject' }),
    code(Codes.accessDenied));
});

test('reject uses a signed graph closure and returns the durable result for an exact retry', async () => {
  const h = harness();
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'reject' });
  const action = { contractVersion: 1 as const, ...prepared, idempotencyKey: 'reject-review-0001', creation: null };
  const first = await runtime.execute(action);
  assert.equal(first.phase, 'succeeded');
  assert.equal(h.snapshot.nodes[0]!.lifecycle, 'rejected');
  const retry = await runtime.execute(action);
  assert.deepEqual(retry, first);
  assert.equal(h.actions.size, 1);
  assert.deepEqual(await runtime.status({ idempotencyKey: action.idempotencyKey,
    requestDigest: action.fence.requestDigest }), first);
  await assert.rejects(runtime.status({ idempotencyKey: action.idempotencyKey,
    requestDigest: '0'.repeat(64) }), code(Codes.idempotencyMismatch));
});

test('turning review off before metadata commit rolls back rejection and choice resolution', async () => {
  const h = harness({ withChildren: true });
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'branch_reject' });
  let graphTransactions = 0;
  h.afterTransaction(() => { if (++graphTransactions === 2) setReviewEnabled(false); });
  try {
    const receipt = await runtime.execute({ contractVersion: 1, ...prepared,
      idempotencyKey: 'branch-reject-admin-off-race-0001', creation: null });
    assert.equal(receipt.phase, 'failed');
    assert.equal(receipt.errorCode, Codes.upgradeRequired);
    assert.deepEqual(h.snapshot.nodes.map((node) => node.lifecycle), ['open', 'open', 'open']);
    assert.equal(h.applyCalls(), 0);
  } finally {
    h.afterTransaction();
    setReviewEnabled(true);
  }
});

test('branch reject signs the descendant closure and resolves every member without content apply', async () => {
  const h = harness({ withChildren: true });
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'branch_reject' });
  assert.deepEqual(prepared.fence.closure.map((member) => member.proposalId), ['p1', 'p2', 'p3']);
  const result = await runtime.execute({ contractVersion: 1, ...prepared,
    idempotencyKey: 'branch-reject-review-0001', creation: null });
  assert.equal(result.phase, 'succeeded');
  assert.deepEqual(h.snapshot.nodes.map((node) => node.lifecycle), ['rejected', 'rejected', 'rejected']);
  assert.equal(h.applyCalls(), 0);
});

test('status returns null for an unreserved action without creating a receipt', async () => {
  const h = harness();
  const runtime = await h.service;
  assert.equal(await runtime.status({ idempotencyKey: 'unreserved-action-0001', requestDigest: '0'.repeat(64) }), null);
  assert.equal(h.actions.size, 0);
});

test('accept applies once and an exact retry returns the stored content receipt', async () => {
  const h = harness();
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'accept', binding: h.binding });
  const action = { contractVersion: 1 as const, ...prepared, idempotencyKey: 'accept-review-0001', creation: null };
  const first = await runtime.execute(action);
  assert.equal(first.phase, 'succeeded');
  assert.equal(first.result?.kind, 'content_changed');
  assert.equal(h.snapshot.nodes[0]!.lifecycle, 'applied');
  h.setAdmissionReserved(true);
  const beforeRetry = h.statementCount();
  assert.deepEqual(await runtime.execute(action), first);
  assert.ok(h.statementsSince(beforeRetry).some((statement) => statement.includes('pg_advisory_xact_lock')),
    'an exact retry uses the transaction guard but does not need open admission');
  const beforeStatus = h.statementCount();
  assert.deepEqual(await runtime.status({ idempotencyKey: action.idempotencyKey,
    requestDigest: action.fence.requestDigest }), first);
  assert.equal(h.statementsSince(beforeStatus).some((statement) => statement.includes('pg_advisory_xact_lock')), false,
    'status and recovery of an existing action do not acquire the new-operation guard');
  assert.equal(h.applyCalls(), 1);
});

test('turning review off before reservation commit rolls back an unapplied accept', async () => {
  const h = harness();
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'accept', binding: h.binding });
  const action = { contractVersion: 1 as const, ...prepared,
    idempotencyKey: 'accept-admin-off-race-0001', creation: null };
  h.afterTransaction(() => setReviewEnabled(false));
  try {
    await assert.rejects(runtime.execute(action), code(Codes.upgradeRequired));
    assert.equal(h.actions.size, 0, 'the still uncommitted reservation rolls back');
    assert.equal(h.applyCalls(), 0);
    assert.equal(h.snapshot.nodes[0]!.lifecycle, 'open');
  } finally {
    h.afterTransaction();
    setReviewEnabled(true);
  }
});

test('active admission blocks new accept and batch-accept atomically while exact retries remain available', async () => {
  for (const actionType of ['accept', 'batch_accept'] as const) {
    const h = harness();
    const runtime = await h.service;
    const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType, binding: h.binding });
    const action = { contractVersion: 1 as const, ...prepared,
      idempotencyKey: `${actionType}-admission-blocked-0001`, creation: null };
    h.setAdmissionReserved(true);
    await assert.rejects(runtime.execute(action), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ADMISSION_CONFLICT');
    assert.equal(h.actions.size, 0, 'denial rolls back the prepared action receipt');
    assert.equal(h.applyCalls(), 0);
  }
});

test('content execution without a reviewer session fails before durable reservation', async () => {
  const h = harness({ session: null });
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'accept', binding: h.binding });
  await assert.rejects(runtime.execute({ contractVersion: 1, ...prepared,
    idempotencyKey: 'accept-no-session-0001', creation: null }), code(Codes.accessDenied));
  assert.equal(h.actions.size, 0);
});

test('complete satisfied retains the evaluated apply selection while resolving metadata only', async () => {
  const h = harness({ evaluationStatus: 'satisfied_elsewhere' });
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'complete_satisfied', binding: h.binding });
  assert.deepEqual(prepared.fence.applyProposalIds, []);
  assert.equal(prepared.fence.evaluationId, h.binding.evaluationId);
  const receipt = await runtime.execute({ contractVersion: 1, ...prepared,
    idempotencyKey: 'satisfied-review-0001', creation: null });
  assert.equal(receipt.phase, 'succeeded');
  assert.equal(receipt.result?.kind, 'metadata_only');
  assert.equal(h.snapshot.nodes[0]!.lifecycle, 'satisfied_elsewhere');
  assert.equal(h.applyCalls(), 0);
});

test('uncertain apply is recovered from durable evidence without replaying mutation', async () => {
  const h = harness();
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'accept', binding: h.binding });
  const action = { contractVersion: 1 as const, ...prepared, idempotencyKey: 'accept-recovery-0001', creation: null };
  h.failApply();
  await assert.rejects(runtime.execute(action), code(Codes.recoveryRequired));
  const pending = [...h.actions.values()][0]!;
  assert.equal(pending.phase, 'recovery_required');
  h.setAdmissionReserved(true);
  const recovered = await runtime.status({ idempotencyKey: action.idempotencyKey,
    requestDigest: action.fence.requestDigest });
  assert.ok(recovered);
  assert.equal(recovered.phase, 'succeeded');
  assert.equal(h.applyCalls(), 1);
  assert.equal(h.recoverCalls(), 1);
});

test('rollback after an uncertain apply retains restart recovery without new mutations', async () => {
  const options = { enabled: true, rolloutWritable: true, write: true };
  const h = harness(options);
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'accept', binding: h.binding });
  const action = { contractVersion: 1 as const, ...prepared, idempotencyKey: 'rollback-recovery-0001', creation: null };
  h.failApply();
  await assert.rejects(runtime.execute(action), code(Codes.recoveryRequired));
  options.enabled = false;
  options.rolloutWritable = false;
  setReviewEnabled(false);
  const restarted = await h.reopen();
  try {
    await assert.rejects(restarted.execute(action), code(Codes.upgradeRequired));
    const identity = { idempotencyKey: action.idempotencyKey, requestDigest: action.fence.requestDigest };
    await assert.rejects(restarted.status({ ...identity, requestDigest: '0'.repeat(64) }), code(Codes.idempotencyMismatch));
    options.write = false;
    await assert.rejects(restarted.status(identity), code(Codes.accessDenied));
    assert.equal(h.recoverCalls(), 0);
    options.write = true;
    const receipt = await restarted.status(identity);
    assert.equal(receipt?.phase, 'succeeded');
    assert.equal(h.snapshot.nodes[0]!.lifecycle, 'applied');
    assert.deepEqual(await restarted.status(identity), receipt);
    assert.equal(h.actions.size, 1);
    assert.equal(h.applyCalls(), 1);
    assert.equal(h.recoverCalls(), 1);
  } finally {
    setReviewEnabled(true);
  }
});

test('review-off preserves a previously reserved metadata proposal after restart', async () => {
  const options = { enabled: true, rolloutWritable: true, owner: 'reviewer' };
  const h = harness(options);
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'reject' });
  const action = { contractVersion: 1 as const, ...prepared, idempotencyKey: 'rollback-metadata-0001', creation: null };
  h.interruptMetadata();
  await assert.rejects(runtime.execute(action), /interruption after committed metadata reservation/u);
  assert.equal([...h.actions.values()][0]!.phase, 'prepared');
  assert.equal(h.snapshot.nodes[0]!.lifecycle, 'open');
  options.enabled = false;
  options.rolloutWritable = false;
  const restarted = await h.reopen();
  const identity = { idempotencyKey: action.idempotencyKey, requestDigest: action.fence.requestDigest };
  options.owner = 'other-user';
  await assert.rejects(restarted.status(identity), code(Codes.accessDenied));
  assert.equal(h.snapshot.nodes[0]!.lifecycle, 'open');
  options.owner = 'reviewer';
  const receipt = await restarted.status(identity);
  assert.equal(receipt?.phase, 'failed');
  assert.equal(receipt?.errorCode, Codes.upgradeRequired);
  assert.equal(h.snapshot.nodes[0]!.lifecycle, 'open');
  assert.deepEqual(await restarted.status(identity), receipt);
  assert.equal(h.actions.size, 1);
  assert.equal(h.applyCalls(), 0);
  assert.equal(h.recoverCalls(), 0);
});

test('manager authority revoked between status lookup and content recovery blocks recovery', async () => {
  const options = { owner: 'other-user', manager: true, enabled: true };
  const h = harness(options);
  const runtime = await h.service;
  const prepared = await runtime.prepare({ selectedProposalIds: ['p1'], actionType: 'accept', binding: h.binding });
  const action = { contractVersion: 1 as const, ...prepared, idempotencyKey: 'manager-recovery-race-0001', creation: null };
  h.failApply();
  await assert.rejects(runtime.execute(action), code(Codes.recoveryRequired));
  options.enabled = false;
  h.afterTransaction(() => { options.manager = false; });
  const identity = { idempotencyKey: action.idempotencyKey, requestDigest: action.fence.requestDigest };
  await assert.rejects(runtime.status(identity), code(Codes.accessDenied));
  assert.equal([...h.actions.values()][0]!.phase, 'recovery_required');
  assert.equal(h.snapshot.nodes[0]!.lifecycle, 'open');
  assert.equal(h.recoverCalls(), 0);
  assert.equal(h.applyCalls(), 1);
  assert.equal('recover' in runtime, false, 'recovery requires the exact status identity, not a bare public action ID');
  h.afterTransaction();
  options.manager = true;
  assert.equal((await runtime.status(identity))?.phase, 'succeeded');
  assert.equal(h.recoverCalls(), 1);
  assert.equal(h.applyCalls(), 1);
});
