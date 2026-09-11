import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';
import type * as Agent from '../app/lib/collaboration/agent-operations';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { prepareAgentBlockEdit, previewAgentBlockEdit } from '../app/lib/collaboration/agent-block-edits';
import { blockTreeTextScopes } from '../app/lib/collaboration/rich-document';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const workspace: WorkspaceContext = { workspaceId: 'workspace', workspaceType: 'organization', organizationId: 'organization',
  rootPath: '/unused', legacy: false, permissions: { canRead: true, canWrite: true, canRunAgent: true,
    canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false } };
type Review = { targets: Agent.AgentOperationView['reviewTargets']; proposalVersion: string | null };
type Row = Record<string, unknown> & { cas_version: number; status: string; action_keys_json: string; operation_payload: string };
type Internals = typeof Agent & {
  sealPayload(value: unknown): string;
  reviewTargetsInDocument(row: Row, doc: Y.Doc, userId: string): Review;
  reviewTargets(row: Row, userId: string): Promise<Review>;
};

function harness(markdown?: string) {
  process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'approval-test-secret-never-used-outside-unit-tests';
  const doc = markdown === undefined ? new Y.Doc() : createRichMarkdownYDoc(markdown, 'tiptap_blocks');
  if (markdown === undefined) doc.getText('content').insert(0, 'Original.\n\nOther.');
  const state = { documentId: 'document', workspaceId: workspace.workspaceId, organizationId: workspace.organizationId,
    path: 'document.md', representation: markdown === undefined ? 'plain_text' : 'tiptap_blocks', status: 'active',
    lifecycleGeneration: 1, schemaVersion: 1, degraded: false, documentSequence: 1, checkpointSequence: 0,
    persistedAt: Date.now(), yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  let directCalls = 0;
  let beforeApply = () => {};
  let reads = 0;
  let newDelivery = false;
  let directGrant: { id: string; expiresAt: number } | null = null;
  let denyGrantLock = false;
  let failGrantCommit = false;
  let beforeGrantLock = () => {};
  class GrantUnavailableError extends Error {}

  const database = {
    get: async (sql: string) => sql.includes('SELECT name, email') ? { name: 'User' }
      : newDelivery && sql.includes('WHERE document_id = $1 AND initiated_by_user_id') ? undefined : { ...row },
    close: async () => {},
    run: async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO collaboration_agent_operations')) {
        const insert = /\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/.exec(sql)!;
        const columns = insert[1].split(',').map((value) => value.trim());
        const values = insert[2].split(',').map((value) => value.trim());
        columns.forEach((column, index) => {
          const value = values[index];
          row[column] = value.startsWith('$') ? params[Number(value.slice(1)) - 1]
            : value === 'NULL' ? null : value.startsWith("'") ? value.slice(1, -1) : Number(value);
        });
        newDelivery = false;
        return { changes: 1 };
      }
      const match = /SET ([\s\S]*?)\s+WHERE/.exec(sql);
      assert.ok(match, sql);
      const assignments = [...match[1].matchAll(/(\w+) = \$(\d+)/g)];
      const n = assignments.length;
      assert.equal(params[n + 1], row.cas_version, 'the exact row revision is claimed');
      for (const [, field, position] of assignments) row[field] = params[Number(position) - 1];
      if (sql.includes('cas_version = cas_version + 1')) row.cas_version++;
      return { changes: 1 };
    },
  };
  const filename = path.resolve('app/lib/collaboration/agent-operations.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, 'utf8')
    + '\nexport { sealPayload, reviewTargetsInDocument, reviewTargets };\n', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mock = (name: string) => {
    if (name === '@/app/lib/db') return { openDb: async () => database };
    if (name === './persistence') return { loadCollaborationState: async () => ({ ...state }) };
    if (name === './document-access') return { readCurrentCollaborationDocument: async (input: { read: (doc: Y.Doc) => unknown }) => {
      reads++; return input.read(doc);
    } };
    if (name === './server-runtime') return { Y };
    if (name === './agent-direct-edit-grants') return {
      resolveAgentDirectEditGrant: async () => directGrant,
      AgentDirectEditGrantUnavailableError: GrantUnavailableError,
      withAgentDirectEditGrant: async (input: { grantId: string }, apply: (grant: { id: string; expiresAt: number }) => unknown) => {
        beforeGrantLock();
        if (!directGrant || denyGrantLock || input.grantId !== directGrant.id) throw new GrantUnavailableError();
        const result = await apply(directGrant);
        if (failGrantCommit) throw new Error('Grant COMMIT response lost');
        return result;
      },
    };
    if (name === './direct-connection') return {
      AgentDirectConnectionAuthorizationError: class extends Error {},
      runCollaborationDirectConnection: async (_input: unknown, apply: (doc: Y.Doc) => Agent.AgentApplyResult,
        onApplied: (result: Agent.AgentApplyResult) => Promise<void>) => {
        directCalls++; beforeApply();
        const result = apply(doc); await onApplied(result);
        state.documentSequence++; state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc);
        state.persistedAt = Date.now(); return result;
      },
    };
    if (name === './presence') return { getWorkspacePresenceSnapshot: () => ({ entries: [] }),
      upsertDocumentPresenceEntry: () => {}, removeDocumentPresenceEntry: () => {} };
    if (name === './diagnostics') return { logCollaborationDiagnostic: () => {} };
    if (name === '@/app/lib/audit/audit-service') return { recordAuditEvent: async () => {} };
    return load(name);
  };
  new Function('require', 'module', 'exports', source)(mock, { exports }, exports);
  const agent = exports as Internals;
  const target = markdown === undefined ? agent.createAgentTextTarget({ text: doc.getText('content'), from: 0, to: 8,
    replacement: 'Revised', targetId: 'target', groupId: 'group' }) : (() => {
    const block = readAgentBlockStructure(doc)[0];
    const blockEdit = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: block.id,
      placementHash: block.placementHash, parentId: null, beforeId: null }]);
    return { kind: 'block_edit' as const, targetId: 'target', groupId: 'group', startAnchor: '', endAnchor: '',
      baseTargetHash: previewAgentBlockEdit(doc, blockEdit).footprintHash, replacement: blockEdit.afterText,
      blockEdit, boundaryPolicy: 'exclude_external' as const };
  })();
  const row: Row = { operation_id: 'operation', document_id: 'document', workspace_id: workspace.workspaceId,
    organization_id: workspace.organizationId, document_path: state.path, document_representation: state.representation,
    document_lifecycle_generation: 1, schema_version: 1, initiated_by_user_id: 'user', actor_id: 'agent', actor_session_id: 'session',
    operation_type: 'apply', requested_mode: 'review', atomicity: 'all_or_nothing', run_generation: 1,
    payload_hash: hash(JSON.stringify(target)), operation_payload: agent.sealPayload([target]), reverse_payload: null,
    status: 'needs_review', cas_version: 1, action_keys_json: '{}', base_state_vector: Y.encodeStateVector(doc),
    base_document_sequence: 1, resulting_state_snapshot: null, expected_canonical_hash: null,
    expires_at: Date.now() + 60_000, created_at: Date.now(), updated_at: Date.now(),
    result_json: JSON.stringify({ status: 'needs_review', appliedTargetIds: [], conflicts: [], stateVector: '', durability: 'needs_review' }) };
  const preview = () => agent.reviewTargetsInDocument(row, doc, 'user');
  const accept = (proposalVersion: string, idempotencyKey = 'accept') => agent.acceptAgentOperation({
    operationId: 'operation', workspace, userId: 'user', idempotencyKey, proposalVersion });
  const deliver = (overrides: Partial<Parameters<typeof Agent.applyPersistedAgentTextOperation>[0]> = {}) => {
    newDelivery = true;
    return agent.applyPersistedAgentTextOperation({ documentId: 'document', workspace, initiatedByUserId: 'user',
      actorId: 'agent', actorSessionId: 'session', actorDisplayName: 'Agent', idempotencyKey: 'delivery',
      runGeneration: 1, targets: [target], documentPath: state.path,
      documentRepresentation: state.representation as 'plain_text' | 'tiptap_blocks', documentLifecycleGeneration: 1,
      documentSchemaVersion: 1, ...overrides });
  };
  return { doc, state, row, agent, target, preview, accept, deliver,
    setGrant: (value: { id: string; expiresAt: number } | null) => { directGrant = value; },
    denyGrant: () => { denyGrantLock = true; },
    failGrantCommit: () => { failGrantCommit = true; },
    beforeGrantLock: (value: () => void) => { beforeGrantLock = value; }, directCalls: () => directCalls, reads: () => reads,
    beforeApply: (value: () => void) => { beforeApply = value; }, close: () => doc.destroy() };
}

test('review reads the live document instead of the older persisted snapshot', async () => {
  const h = harness();
  try {
    h.doc.getText('content').delete(0, 8); h.doc.getText('content').insert(0, 'Changed');
    const review = await h.agent.reviewTargets(h.row, 'user');
    assert.equal(review.proposalVersion, null); assert.ok(h.reads() > 0);
    assert.notEqual(review.targets?.[0].currentText, 'Original');
    assert.equal(new TextDecoder().decode(h.state.yjsState).includes('Changed'), false);
  } finally { h.close(); }
});

test('approval binds user, payload, operation revision, generation and scope', () => {
  const h = harness();
  try {
    const token = h.preview().proposalVersion; assert.match(token!, /^v1\.[a-f0-9]{64}$/);
    assert.notEqual(h.agent.reviewTargetsInDocument(h.row, h.doc, 'other').proposalVersion, token);
    for (const [field, value] of Object.entries({ operation_id: 'other', workspace_id: 'other', organization_id: 'other',
      document_id: 'other', payload_hash: hash('other'), cas_version: 2, document_lifecycle_generation: 2, schema_version: 2 })) {
      assert.notEqual(h.agent.reviewTargetsInDocument({ ...h.row, [field]: value }, h.doc, 'user').proposalVersion, token, field);
    }
  } finally { h.close(); }
});

test('independent paragraph edits preserve the exact approval and are not overwritten', async () => {
  const h = harness();
  try {
    const token = h.preview().proposalVersion!;
    h.doc.getText('content').insert(h.doc.getText('content').length, ' Human.');
    assert.equal(h.preview().proposalVersion, token);
    const result = await h.accept(token);
    assert.equal(result.durability, 'persisted_yjs'); assert.equal(result.appliedTargetIds.length, 1);
    assert.equal(h.doc.getText('content').toString(), 'Revised.\n\nOther. Human.');
  } finally { h.close(); }
});

test('same key and token after a lost response returns the original result once', async () => {
  const h = harness();
  try {
    const token = h.preview().proposalVersion!;
    const [first, second] = await Promise.all([h.accept(token), h.accept(token)]);
    assert.equal(first.operationId, second.operationId); assert.equal(second.durability, 'persisted_yjs');
    assert.equal(h.directCalls(), 1);
    await assert.rejects(h.accept(`v1.${'0'.repeat(64)}`), { code: 'AGENT_PROPOSAL_CHANGED' });
    assert.equal(h.directCalls(), 1);
  } finally { h.close(); }
});

test('stale or missing preview cannot start application', async () => {
  const h = harness();
  try {
    const token = h.preview().proposalVersion!;
    h.row.cas_version++;
    await assert.rejects(h.accept(token), { code: 'AGENT_PROPOSAL_CHANGED' });
    await assert.rejects(h.accept(undefined as unknown as string), { code: 'AGENT_PROPOSAL_CHANGED' });
    assert.equal(h.directCalls(), 0); assert.equal(h.row.action_keys_json, '{}');
  } finally { h.close(); }
});

test('edit between approval precheck and room callback rejects without mutation or retry', async () => {
  const h = harness();
  try {
    const token = h.preview().proposalVersion!;
    let humanBytes: Uint8Array;
    h.beforeApply(() => { h.doc.getText('content').delete(0, 8); h.doc.getText('content').insert(0, 'Human');
      humanBytes = Y.encodeStateAsUpdate(h.doc); });
    const result = await h.accept(token);
    assert.equal(result.operationStatus, 'needs_review'); assert.equal(result.appliedTargetIds.length, 0);
    assert.equal(result.conflicts[0]?.code, 'target_changed'); assert.deepEqual(Y.encodeStateAsUpdate(h.doc), humanBytes!);
    await h.accept(token); assert.equal(h.directCalls(), 1, 'uncertain retry never recalculates a new edit');
  } finally { h.close(); }
});

test('one approved group never silently applies only the nonconflicting remainder', async () => {
  const h = harness();
  try {
    const other = h.agent.createAgentTextTarget({ text: h.doc.getText('content'), from: 11, to: 16,
      replacement: 'Second', targetId: 'second', groupId: 'separate' });
    h.row.atomicity = 'independent'; h.row.operation_payload = h.agent.sealPayload([h.target, other]);
    const token = h.preview().proposalVersion!;
    h.beforeApply(() => h.doc.getText('content').insert(14, 'Human'));
    const result = await h.accept(token);
    assert.equal(result.appliedTargetIds.length, 0); assert.match(h.doc.getText('content').toString(), /^Original/);
  } finally { h.close(); }
});

test('a block move keeps later typing and its approval binds placement rather than context text', async () => {
  const h = harness('First\n\nSecond');
  try {
    const token = h.preview().proposalVersion!;
    const first = readAgentBlockStructure(h.doc)[0];
    const text = [...blockTreeTextScopes(h.doc)].find(([, id]) => id === first.id)![0]; text.insert(text.length, ' human');
    assert.equal(h.preview().proposalVersion, token);
    assert.notEqual(h.preview().targets?.[0].currentText, (h.target as Agent.AgentTextTarget).blockEdit?.beforeText);
    const result = await h.accept(token);
    assert.equal(result.durability, 'persisted_yjs'); assert.equal(richMarkdownFromYDoc(h.doc), 'Second\n\nFirst human');
  } finally { h.close(); }
});

test('expiry during the connection wait invalidates the pending approval', async () => {
  const h = harness();
  try {
    const token = h.preview().proposalVersion!;
    // A real wall clock change affects both captured row and freshly loaded row.
    const now = Date.now;
    h.beforeApply(() => { Date.now = () => Number(h.row.expires_at) + 1; });
    try { const result = await h.accept(token); assert.equal(result.appliedTargetIds.length, 0); }
    finally { Date.now = now; }
    assert.equal(h.doc.getText('content').toString(), 'Original.\n\nOther.');
  } finally { h.close(); }
});


test('default is a proposal even when the caller sets explicitUserRequest or direct_apply', async () => {
  for (const overrides of [{}, { explicitUserRequest: true }, { requestedMode: 'direct_apply' as const, explicitUserRequest: true }]) {
    const h = harness();
    try {
      const bytes = Y.encodeStateAsUpdate(h.doc);
      const result = await h.deliver(overrides);
      assert.equal(result.operationStatus, 'needs_review'); assert.equal(result.appliedTargetIds.length, 0);
      assert.equal(h.directCalls(), 0); assert.deepEqual(Y.encodeStateAsUpdate(h.doc), bytes);
      assert.equal(h.row.requested_mode, 'review'); assert.equal(h.row.direct_edit_grant_id, null);
    } finally { h.close(); }
  }
});

test('a current scoped grant is recorded and applies through the same durable pipeline', async () => {
  const h = harness();
  try {
    h.setGrant({ id: 'grant-original', expiresAt: Date.now() + 60_000 });
    const result = await h.deliver();
    assert.equal(result.durability, 'persisted_yjs'); assert.equal(h.row.direct_edit_grant_id, 'grant-original');
    assert.equal(h.directCalls(), 1); assert.match(h.doc.getText('content').toString(), /^Revised/);
  } finally { h.close(); }
});

test('explicit review mode stays a proposal even when direct permission exists', async () => {
  const h = harness();
  try {
    h.setGrant({ id: 'grant-original', expiresAt: Date.now() + 60_000 });
    const result = await h.deliver({ requestedMode: 'review' });
    assert.equal(result.operationStatus, 'needs_review'); assert.equal(h.directCalls(), 0);
  } finally { h.close(); }
});

test('revocation or replacement of the captured grant leaves a proposal', async () => {
  for (const action of ['revoke', 'replace']) {
    const h = harness();
    try {
      h.setGrant({ id: 'grant-original', expiresAt: Date.now() + 60_000 });
      h.beforeGrantLock(() => action === 'revoke' ? h.denyGrant()
        : h.setGrant({ id: 'grant-new', expiresAt: Date.now() + 60_000 }));
      const result = await h.deliver();
      assert.equal(result.operationStatus, 'needs_review'); assert.equal(h.directCalls(), 0);
      assert.equal(h.row.direct_edit_grant_id, 'grant-original');
    } finally { h.close(); }
  }
});

test('direct permission expiring while the room opens cannot mutate', async () => {
  const h = harness();
  try {
    const expiresAt = Date.now() + 60_000; h.setGrant({ id: 'grant-original', expiresAt });
    const now = Date.now; h.beforeApply(() => { Date.now = () => expiresAt + 1; });
    try {
      const result = await h.deliver();
      assert.equal(result.operationStatus, 'needs_review'); assert.equal(result.appliedTargetIds.length, 0);
      assert.equal(result.conflicts[0]?.code, 'authorization_revoked');
    } finally { Date.now = now; }
    assert.equal(h.doc.getText('content').toString(), 'Original.\n\nOther.');
  } finally { h.close(); }
});


test('lost grant COMMIT response preserves a completed operation receipt', async () => {
  const h = harness();
  try {
    h.setGrant({ id: 'grant-original', expiresAt: Date.now() + 60_000 }); h.failGrantCommit();
    const result = await h.deliver();
    assert.equal(result.durability, 'persisted_yjs'); assert.equal(result.appliedTargetIds.length, 1);
    assert.equal(h.directCalls(), 1); assert.match(h.doc.getText('content').toString(), /^Revised/);
    const stored = JSON.parse(String(h.row.result_json)); assert.equal(stored.operationId, result.operationId);
    assert.equal(stored.durability, 'persisted_yjs');
  } finally { h.close(); }
});
