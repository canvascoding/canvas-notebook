import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';
import * as Y from 'yjs';

import type * as Agent from '../app/lib/collaboration/agent-operations';
import { proposalYjsCurrentProof } from '../app/lib/file-version-center/proposal-yjs-candidate';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const workspace: WorkspaceContext = { workspaceId: 'workspace', workspaceType: 'personal', organizationId: 'organization',
  rootPath: '/unused', legacy: false, permissions: { canRead: true, canWrite: true, canRunAgent: true,
    canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false } };

type Row = Record<string, unknown> & { operation_id: string; cas_version: number; run_generation: number; status: string };

function harness() {
  process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'proposal-candidate-operation-test-secret-32';
  const source = new Y.Doc({ gc: false }); source.getText('content').insert(0, 'before');
  const candidate = new Y.Doc({ gc: false }); Y.applyUpdate(candidate, Y.encodeStateAsUpdate(source));
  candidate.getText('content').delete(0, 6); candidate.getText('content').insert(0, 'after');
  const sourceUpdate = Y.encodeStateAsUpdate(source); const candidateUpdate = Y.encodeStateAsUpdate(candidate);
  const expectedCurrent = proposalYjsCurrentProof({ update: sourceUpdate, representation: 'plain_text', revisionId: null });
  let state = {
    documentId: 'document', workspaceId: workspace.workspaceId, organizationId: workspace.organizationId,
    path: 'document.txt', representation: 'plain_text' as const, status: 'active' as const,
    lifecycleGeneration: 1, schemaVersion: 1, degraded: false, documentSequence: 7, checkpointSequence: 7,
    persistedAt: 100, checkpointedAt: 100, yjsState: sourceUpdate, stateVector: Y.encodeStateVector(source),
  };
  const row: Row = {
    operation_id: 'action-1', document_id: 'document', document_path: 'document.txt', document_representation: 'plain_text',
    workspace_id: workspace.workspaceId, organization_id: workspace.organizationId, document_lifecycle_generation: 1, schema_version: 1,
    initiated_by_user_id: 'user', actor_id: 'agent', agent_run_id: null, actor_session_id: 'session', supersedes_operation_id: null,
    idempotency_key: 'proposal-action:action-1', run_generation: 1, payload_hash: 'a'.repeat(64), operation_type: 'apply',
    requested_mode: 'review', atomicity: 'all_or_nothing', operation_payload: null, reverse_payload: null, status: 'preparing',
    base_state_vector: Buffer.from(state.stateVector), base_document_sequence: 7, resulting_state_vector_hash: null,
    resulting_state_snapshot: null, file_edit_request_json: null, checkpoint_revision_id: null, version_revision_id: null,
    result_json: null, cas_version: 0, cancel_requested_at: null, applied_at: null, persisted_at: null, checkpointed_at: null,
    expires_at: null, error_code: null, correlation_id: null, causation_id: null, trigger_depth: 0,
    expected_canonical_hash: null, applied_document_sequence: null, action_keys_json: '{}', created_at: 1, updated_at: 1,
  };
  const graphScope = { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 };
  const actionReceipt: {
    receipt_json: unknown;
    request_json: { fence: { scope: typeof graphScope; effectiveCandidateHash: string; current: typeof expectedCurrent }; creation: null };
  } = {
    receipt_json: { actionId: 'action-1', operationId: 'action-1', phase: 'applying', scope: graphScope },
    request_json: { fence: { scope: graphScope, effectiveCandidateHash: hash(candidateUpdate), current: expectedCurrent }, creation: null },
  };
  const history: Array<{ content: string; stateVector: string | Uint8Array | null | undefined }> = [];
  let historyAvailable = true;
  let directConnectionCalls = 0;
  let recoveryScanEnabled = false;
  const filename = path.resolve('app/lib/collaboration/agent-operations.ts');
  const require = createRequire(filename);
  const sourceCode = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const connection = {
    async get(sql: string, params: unknown[] = []) {
      if (sql.includes('file_proposal_action_receipts')) return String(params[0]) === 'action-1' ? actionReceipt : undefined;
      if (sql.includes('FROM collaboration_agent_operations operation') || sql.includes('SELECT * FROM collaboration_agent_operations')) {
        return String(params[0]) === row.operation_id ? { ...row } : undefined;
      }
      if (sql.includes('file_change_proposals')) return undefined;
      if (sql.includes('SELECT name, email')) return { name: 'Owner' };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async all() { return []; },
    async run(sql: string, params: unknown[] = []) {
      const matched = /SET ([\s\S]*?)\s+WHERE/u.exec(sql);
      if (!matched) throw new Error(`Unexpected run: ${sql}`);
      const assignments = [...matched[1].matchAll(/(\w+) = \$(\d+)/gu)];
      const count = assignments.length;
      assert.equal(params[count], row.operation_id);
      assert.equal(params[count + 1], row.cas_version);
      assert.equal(params[count + 2], row.run_generation);
      assert.ok((params.slice(count + 3) as string[]).includes(row.status));
      for (const [, key, position] of assignments) row[key] = params[Number(position) - 1];
      row.cas_version += 1;
      return { changes: 1 };
    },
    async close() {},
  };
  const mock = (name: string) => {
    if (name === '@/app/lib/db') return { openDb: async () => connection };
    if (name === '@/app/lib/file-version-center/database') return { createRuntimeFileVersionCenterDatabase: () => ({
      transaction: async (action: (transaction: { query: () => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async () => ({ rows: recoveryScanEnabled ? [{
          action_id: 'action-1', receipt_json: actionReceipt.receipt_json,
          initiated_by_user_id: 'user', actor_id: 'agent', actor_session_id: 'session',
          document_path: 'document.txt', document_representation: 'plain_text', operation_organization_id: 'organization',
          workspace_type: 'personal', root_relative_path: 'workspaces/personal/user/files', display_name: 'Workspace',
          workspace_status: 'active', owner_user_id: 'user', lineage_workspace_type: 'personal',
          lineage_organization_id: 'organization', lineage_customer_id: null, lineage_project_id: null,
          lineage_path: 'document.txt', lineage_status: 'active',
        }] : [] }),
      }),
    }) };
    if (name === '@/app/lib/file-version-center/proposal-storage') return { createProposalGraphStorage: () => ({
      withLockedGraph: async () => { throw new Error('Unexpected graph storage call in the scanner adapter test.'); },
    }) };
    if (name === '@/app/lib/file-version-center/proposal-action-orchestrator') {
      class ProposalActionDefinitelyUnappliedError extends Error {
        constructor(readonly code: string, message: string) { super(message); this.name = 'ProposalActionDefinitelyUnappliedError'; }
      }
      return { ProposalActionDefinitelyUnappliedError, recoverProposalAction: async (
        dependencies: { recoverDurably: (input: unknown) => Promise<unknown> }, scope: typeof graphScope, actionId: string,
      ) => dependencies.recoverDurably({ scope, actionId, proposalIds: ['proposal'], operationIds: ['source-operation'],
        current: expectedCurrent, candidate: { evaluation: { effectiveCandidate: { sha256: hash(candidateUpdate) } }, update: candidateUpdate } }) };
    }
    if (name === '@/app/lib/workspaces/contracts') return { workspaceAbsoluteRoot: (value: string) => `/data/${value}` };
    if (name === '@/app/lib/file-version-center/contracts/proposal-graph-v1') {
      class ProposalGraphContractError extends Error { constructor(readonly code: string, message: string) { super(message); } }
      return { ProposalGraphContractError, parseProposalActionReceiptV1: (value: unknown) => value,
        parseProposalPreparedActionV1: (value: unknown) => value };
    }
    if (name === './persistence') return { loadCollaborationState: async () => ({ ...state }) };
    if (name === './server-runtime') return { Y };
    if (name === './direct-connection') return {
      AgentDirectConnectionAuthorizationError: class extends Error {},
      runCollaborationDirectConnection: async (_input: unknown, apply: (doc: Y.Doc) => string, onApplied?: (value: string) => Promise<void>) => {
        directConnectionCalls++;
        const live = new Y.Doc({ gc: false });
        try {
          Y.applyUpdate(live, state.yjsState);
          const result = apply(live);
          state = { ...state, yjsState: Y.encodeStateAsUpdate(live), stateVector: Y.encodeStateVector(live), persistedAt: 200, documentSequence: 8 };
          await onApplied?.(result);
          return result;
        } finally { live.destroy(); }
      },
    };
    if (name === '@/app/lib/file-version-center/history-service') return { fileVersionHistoryService: {
      capture: async (value: { content: string; stateVector: string | Uint8Array | null | undefined }) => {
        if (!historyAvailable) return { outcome: 'captured', revision: null, binding: null };
        history.push(value); return { outcome: 'captured', revision: { id: 'candidate-revision' }, binding: null };
      },
      capturePersistedCollaboration: async () => { throw new Error('not used'); },
    } };
    if (name === '@/app/lib/file-version-center/agent-review-policy-adapter') return {
      authorizeNewAgentDirectApply: async () => { throw new Error('not used'); }, readAgentReviewPolicySnapshot: async () => { throw new Error('not used'); },
    };
    if (name === './agent-direct-edit-grants') return { AgentDirectEditGrantUnavailableError: class extends Error {}, withAgentDirectEditGrant: async () => { throw new Error('not used'); } };
    if (name === './document-access') return { readCurrentCollaborationDocument: async () => { throw new Error('not used'); } };
    if (name === './presence') return { upsertDocumentPresenceEntry: () => {}, removeDocumentPresenceEntry: () => {} };
    if (name === './diagnostics') return { logCollaborationDiagnostic: () => {} };
    if (name === '@/app/lib/audit/audit-service') return { recordAuditEvent: async () => {} };
    return require(name);
  };
  const compiledModule = { exports: {} as object };
  new Function('require', 'module', 'exports', sourceCode)(mock, compiledModule, compiledModule.exports);
  const persistCandidate = () => {
    state = { ...state, yjsState: candidateUpdate, stateVector: Y.encodeStateVector(candidate), persistedAt: 200, documentSequence: 8 };
  };
  const recordAppliedCallback = () => {
    persistCandidate();
    const document = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(document, state.yjsState);
      row.status = 'applied_to_ydoc';
      row.resulting_state_snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(document)));
      row.applied_at = state.persistedAt;
    } finally { document.destroy(); }
  };
  const applyIndependentEdit = () => {
    const document = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(document, state.yjsState);
      document.getText('content').insert(document.getText('content').length, ' later');
      state = { ...state, yjsState: Y.encodeStateAsUpdate(document), stateVector: Y.encodeStateVector(document),
        persistedAt: 300, documentSequence: 9 };
    } finally { document.destroy(); }
  };
  return { agent: compiledModule.exports as typeof Agent, row, history, actionReceipt, candidateUpdate, expectedCurrent,
    persistCandidate, recordAppliedCallback, applyIndependentEdit, setHistoryAvailable: (value: boolean) => { historyAvailable = value; },
    setRecoveryScanEnabled: (value: boolean) => { recoveryScanEnabled = value; },
    get directConnectionCalls() { return directConnectionCalls; },
    currentText: () => { const doc = new Y.Doc(); try { Y.applyUpdate(doc, state.yjsState); return doc.getText('content').toString(); } finally { doc.destroy(); } },
    close: () => { source.destroy(); candidate.destroy(); } };
}

test('graph candidate action applies only its exact live base, proves durable bytes, and captures its exact candidate revision', async () => {
  const h = harness();
  try {
    const result = await h.agent.applyProposalGraphCandidateOperation({
      actionId: 'action-1', scope: { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 },
      workspace, initiatedByUserId: 'user', actorId: 'agent', actorDisplayName: 'Agent', actorSessionId: 'session',
      representation: 'plain_text', expectedCurrent: h.expectedCurrent, candidateUpdate: h.candidateUpdate,
      candidateSha256: hash(h.candidateUpdate), baseRevisionId: 'base-revision',
    });
    assert.equal(result.operationId, 'action-1'); assert.equal(result.revisionId, 'candidate-revision');
    assert.equal(h.currentText(), 'after'); assert.equal(h.row.status, 'persisted_yjs');
    assert.equal(h.row.version_revision_id, 'candidate-revision'); assert.equal(h.row.checkpoint_revision_id, null);
    assert.equal(h.history.length, 1); assert.equal(h.history[0]!.content, 'after');
  } finally { h.close(); }
});

function candidateActionInput(h: ReturnType<typeof harness>) {
  return {
    actionId: 'action-1', scope: { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 },
    workspace, initiatedByUserId: 'user', actorId: 'agent', actorDisplayName: 'Agent', actorSessionId: 'session',
    representation: 'plain_text' as const, expectedCurrent: h.expectedCurrent, candidateUpdate: h.candidateUpdate,
    candidateSha256: hash(h.candidateUpdate), baseRevisionId: 'base-revision',
  };
}

test('graph candidate recovery finalizes a crash after mutation without replaying Yjs', async () => {
  const h = harness();
  try {
    h.row.status = 'applying';
    h.persistCandidate();
    const result = await h.agent.recoverProposalGraphCandidateOperation(candidateActionInput(h));
    assert.equal(result.revisionId, 'candidate-revision'); assert.equal(h.currentText(), 'after');
    assert.equal(h.row.status, 'persisted_yjs'); assert.equal(h.row.version_revision_id, 'candidate-revision');
    assert.equal(h.directConnectionCalls, 0);
    assert.equal(h.history.length, 1); assert.equal(h.history[0]!.content, 'after');
  } finally { h.close(); }
});

test('graph candidate recovery retries history only after a callback-persisted snapshot proof', async () => {
  const h = harness();
  try {
    h.recordAppliedCallback(); h.setHistoryAvailable(false);
    await assert.rejects(h.agent.recoverProposalGraphCandidateOperation(candidateActionInput(h)), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
    assert.equal(h.row.status, 'applied_to_ydoc'); assert.equal(h.history.length, 0);
    h.setHistoryAvailable(true);
    const result = await h.agent.recoverProposalGraphCandidateOperation(candidateActionInput(h));
    assert.equal(result.revisionId, 'candidate-revision'); assert.equal(h.row.status, 'persisted_yjs');
    assert.equal(h.history.length, 1); assert.equal(h.history[0]!.content, 'after');
  } finally { h.close(); }
});

test('graph candidate recovery finalizes an acknowledged snapshot after later independent edits', async () => {
  const h = harness();
  try {
    h.recordAppliedCallback(); h.applyIndependentEdit();
    const result = await h.agent.recoverProposalGraphCandidateOperation(candidateActionInput(h));
    assert.equal(result.revisionId, 'candidate-revision'); assert.equal(h.currentText(), 'after later');
    assert.equal(h.row.status, 'persisted_yjs'); assert.equal(h.history.length, 1); assert.equal(h.history[0]!.content, 'after');
    assert.equal(h.directConnectionCalls, 0);
  } finally { h.close(); }
});

test('graph candidate recovery never reconstructs an unprovable applying state', async () => {
  const h = harness();
  try {
    h.row.status = 'applying';
    await assert.rejects(h.agent.recoverProposalGraphCandidateOperation(candidateActionInput(h)), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
    assert.equal(h.currentText(), 'before'); assert.equal(h.row.status, 'applying'); assert.equal(h.history.length, 0);
  } finally { h.close(); }
});

test('graph candidate recovery turns malformed graph receipts into a safe recovery requirement', async () => {
  const h = harness();
  try {
    h.row.status = 'persisted_yjs'; h.row.version_revision_id = 'candidate-revision';
    h.actionReceipt.receipt_json = '{not-json';
    await assert.rejects(h.agent.recoverProposalGraphCandidateOperation(candidateActionInput(h)), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
    assert.equal(h.row.status, 'persisted_yjs'); assert.equal(h.history.length, 0);
  } finally { h.close(); }
});

test('startup graph recovery reconstructs metadata without granting permissions or replaying a room mutation', async () => {
  const h = harness();
  try {
    h.row.status = 'persisted_yjs'; h.row.version_revision_id = 'candidate-revision';
    h.setRecoveryScanEnabled(true);
    assert.deepEqual(await h.agent.recoverProposalGraphActions(), { recovered: 1, pending: 0 });
    assert.equal(h.directConnectionCalls, 0); assert.equal(h.history.length, 0);
  } finally { h.close(); }
});

test('graph candidate action refuses a stale live proof before applying candidate bytes', async () => {
  const h = harness();
  try {
    const staleExpectedCurrent = { ...h.expectedCurrent, fullStateHash: 'f'.repeat(64) };
    h.actionReceipt.request_json.fence.current = staleExpectedCurrent;
    await assert.rejects(h.agent.applyProposalGraphCandidateOperation({
      actionId: 'action-1', scope: { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 },
      workspace, initiatedByUserId: 'user', actorId: 'agent', actorDisplayName: 'Agent', actorSessionId: 'session',
      representation: 'plain_text', expectedCurrent: staleExpectedCurrent, candidateUpdate: h.candidateUpdate,
      candidateSha256: hash(h.candidateUpdate),
    }), { code: 'PROPOSAL_CURRENT_CHANGED' });
    assert.equal(h.currentText(), 'before'); assert.equal(h.row.status, 'cancelled');
    assert.equal(h.row.error_code, 'proposal_action_not_applied'); assert.equal(h.history.length, 0);
  } finally { h.close(); }
});

test('graph candidate recovery classifies a prepared operation as definitely unapplied', async () => {
  const h = harness();
  try {
    await assert.rejects(h.agent.recoverProposalGraphCandidateOperation(candidateActionInput(h)), {
      name: 'ProposalActionDefinitelyUnappliedError', code: 'PROPOSAL_NO_EFFECT',
    });
    assert.equal(h.directConnectionCalls, 0); assert.equal(h.currentText(), 'before');
    assert.equal(h.row.status, 'cancelled'); assert.equal(h.row.error_code, 'proposal_action_not_applied');
    assert.equal(h.history.length, 0);
  } finally { h.close(); }
});

test('graph candidate action binds its supplied bytes to the graph receipt fence before applying', async () => {
  const h = harness();
  try {
    h.actionReceipt.request_json.fence.effectiveCandidateHash = 'f'.repeat(64);
    await assert.rejects(h.agent.applyProposalGraphCandidateOperation({
      actionId: 'action-1', scope: { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 },
      workspace, initiatedByUserId: 'user', actorId: 'agent', actorDisplayName: 'Agent', actorSessionId: 'session',
      representation: 'plain_text', expectedCurrent: h.expectedCurrent, candidateUpdate: h.candidateUpdate,
      candidateSha256: hash(h.candidateUpdate),
    }), { code: 'PROPOSAL_CANDIDATE_CHANGED' });
    assert.equal(h.currentText(), 'before'); assert.equal(h.row.status, 'preparing'); assert.equal(h.history.length, 0);
  } finally { h.close(); }
});
