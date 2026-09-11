import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import type * as Agent from '../app/lib/collaboration/agent-operations';
import type * as Files from '../app/lib/pi/agent-file-operations';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { PreparedCollaborationTextEdit } from '../app/lib/collaboration/agent-file-edits';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { applyAgentBlockEdit, prepareAgentBlockEdit, previewAgentBlockEdit, type AgentBlockEditRequest } from '../app/lib/collaboration/agent-block-edits';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const workspace: WorkspaceContext = {
  workspaceId: 'workspace', workspaceType: 'organization', organizationId: 'organization', rootPath: '/unused', legacy: false,
  permissions: { canRead: true, canWrite: true, canRunAgent: true, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false },
};

async function compile<T>(file: string, mock: (name: string, load: NodeRequire) => unknown, extraSource = ''): Promise<T> {
  const filename = path.resolve(file); const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8') + extraSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)((name: string) => mock(name, load), { exports }, exports);
  return exports as T;
}

async function serviceHarness() {
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_blocks');
  const a = readAgentBlockStructure(doc)[0];
  const requests: AgentBlockEditRequest[] = [{ kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: null, beforeId: null }];
  const target = () => {
    const blockEdit = prepareAgentBlockEdit(doc, requests);
    return { kind: 'block_edit' as const, targetId: 'target', groupId: 'group', startAnchor: '', endAnchor: '',
      baseTargetHash: previewAgentBlockEdit(doc, blockEdit).footprintHash,
      replacement: blockEdit.afterText, blockEdit, boundaryPolicy: 'exclude_external' as const };
  };
  const request = { fingerprint: hash('original request'), beforeSha256: hash('before'), proposedSha256: hash('proposal') };
  const input: Parameters<typeof Agent.applyPersistedAgentTextOperation>[0] = {
    documentId: 'document', workspace, initiatedByUserId: 'user', actorId: 'agent', actorDisplayName: 'Agent', actorSessionId: 'session',
    idempotencyKey: 'same-request', runGeneration: 1, targets: [target()], requestedMode: 'direct_apply', explicitUserRequest: true,
    documentPath: 'document.md', documentRepresentation: 'tiptap_blocks', documentLifecycleGeneration: 2, documentSchemaVersion: 1,
    fileEditRequest: request,
  };
  const state = { documentId: 'document', workspaceId: 'workspace', organizationId: 'organization', path: 'document.md',
    representation: 'tiptap_blocks', lifecycleGeneration: 2, schemaVersion: 1, status: 'active' };
  const result = { status: 'applied_to_ydoc', durability: 'persisted_yjs', appliedTargetIds: ['target'], conflicts: [], stateVector: '' };
  const row = { operation_id: 'original-operation', document_id: input.documentId, workspace_id: workspace.workspaceId,
    organization_id: workspace.organizationId, initiated_by_user_id: 'user', actor_id: 'agent', actor_session_id: 'session',
    document_path: input.documentPath, document_representation: input.documentRepresentation,
    document_lifecycle_generation: 2, schema_version: 1, run_generation: 1, operation_type: 'apply',
    atomicity: 'all_or_nothing', supersedes_operation_id: null, expected_canonical_hash: null,
    file_edit_request_json: JSON.stringify(request) as string | null, payload_hash: '',
    status: 'persisted_yjs', result_json: JSON.stringify(result), base_state_vector: Y.encodeStateVector(doc),
    resulting_state_snapshot: null, cas_version: 3 };
  let writes = 0;
  const agent = await compile<typeof Agent & { operationPayloadHash: (value: unknown) => string }>(
    'app/lib/collaboration/agent-operations.ts', (name, load) => {
      if (name === '@/app/lib/db') return { openDb: async () => ({ get: async () => row,
        run: async () => { writes++; throw new Error('A replay must not write'); }, close: async () => {} }) };
      if (name === './presence') return { getWorkspacePresenceSnapshot: () => ({ entries: [] }) };
      if (name === './agent-direct-edit-grants') return { resolveAgentDirectEditGrant: async () => null };
      if (name === './persistence') return { loadCollaborationState: async () => state };
      if (name === './server-runtime') return { Y };
      if (name.startsWith('node:') || name === 'server-only') return load(name);
      return {};
    }, '\nexport { operationPayloadHash };\n');
  row.payload_hash = agent.operationPayloadHash({ ...input, independentGroups: false, operationType: 'apply' });
  return { agent, row, input, request, state, target, writes: () => writes, close: () => doc.destroy() };
}

test('same server request reuses the original operation despite new prepared Yjs bytes and snapshot hashes', async () => {
  const h = await serviceHarness();
  try {
    const targets = [h.target()];
    assert.notEqual(targets[0].blockEdit.updateBase64, h.input.targets[0].blockEdit!.updateBase64);
    const receiptBefore = h.row.file_edit_request_json;
    const result = await h.agent.applyPersistedAgentTextOperation({ ...h.input, targets,
      fileEditRequest: { ...h.request, beforeSha256: hash('new current'), proposedSha256: hash('new preview') } });
    assert.equal(result.operationId, 'original-operation'); assert.equal(result.fileEditRequestReused, true);
    assert.equal(result.durability, 'persisted_yjs'); assert.equal(h.writes(), 0);
    assert.equal(h.row.file_edit_request_json, receiptBefore, 'original hashes are never replaced by a repeated preparation');
    assert.equal(JSON.parse(h.row.result_json).fileEditRequestReused, undefined, 'the delivery hint is not stored as operation state');
  } finally { h.close(); }
});

test('file receipt replay requires exact actor, session, request and document scope', async (t) => {
  const changes: Array<[string, (input: Parameters<typeof Agent.applyPersistedAgentTextOperation>[0]) => void]> = [
    ['fingerprint', (input) => { input.fileEditRequest = { ...input.fileEditRequest!, fingerprint: hash('changed request') }; }],
    ['actor', (input) => { input.actorId = 'other'; }], ['session', (input) => { input.actorSessionId = 'other'; }],
    ['missing session', (input) => { delete input.actorSessionId; }], ['initiator', (input) => { input.initiatedByUserId = 'other'; }],
    ['workspace', (input) => { input.workspace = { ...workspace, workspaceId: 'other' }; }],
    ['organization', (input) => { input.workspace = { ...workspace, organizationId: null }; }],
    ['document', (input) => { input.documentId = 'other'; }], ['path', (input) => { input.documentPath = 'other.md'; }],
    ['representation', (input) => { input.documentRepresentation = 'plain_text'; }],
    ['generation', (input) => { input.documentLifecycleGeneration = 3; }], ['schema', (input) => { input.documentSchemaVersion = 2; }],
    ['missing reference', (input) => { delete input.documentLifecycleGeneration; }],
    ['run generation', (input) => { input.runGeneration = 2; }], ['operation type', (input) => { input.operationType = 'revert'; }],
    ['atomicity', (input) => { input.independentGroups = true; }], ['revert receipt', (input) => { input.supersedesOperationId = 'other'; }],
    ['expected proposal', (input) => { input.expectedCanonicalHash = hash('other'); }],
  ];
  for (const [label, change] of changes) await t.test(label, async () => {
    const h = await serviceHarness();
    try { change(h.input); await assert.rejects(h.agent.applyPersistedAgentTextOperation(h.input), /different or unverifiable/u); assert.equal(h.writes(), 0); }
    finally { h.close(); }
  });
});

test('missing or invalid stored receipts fail closed and stale lifecycles retain the original operation ID', async () => {
  const h = await serviceHarness();
  try {
    for (const receipt of [null, JSON.stringify({ fingerprint: h.request.fingerprint })]) {
      h.row.file_edit_request_json = receipt;
      await assert.rejects(h.agent.applyPersistedAgentTextOperation(h.input), /unverifiable/u);
    }
    h.row.file_edit_request_json = JSON.stringify(h.request); h.state.lifecycleGeneration++;
    await assert.rejects(h.agent.applyPersistedAgentTextOperation(h.input), (error: unknown) => {
      assert.ok(error instanceof h.agent.AgentFileEditOperationScopeError);
      assert.equal(error.operation.operationId, 'original-operation'); return true;
    });
    assert.equal(h.writes(), 0);
  } finally { h.close(); }
});

test('ordinary low-level replays retain strict payload comparison and do not receive the file hint', async () => {
  const h = await serviceHarness();
  try {
    delete h.input.fileEditRequest; h.row.file_edit_request_json = null;
    const exact = await h.agent.applyPersistedAgentTextOperation(h.input);
    assert.equal(exact.operationId, 'original-operation'); assert.equal(exact.fileEditRequestReused, undefined);
    await assert.rejects(h.agent.applyPersistedAgentTextOperation({ ...h.input, targets: [h.target()] }), /different agent payload/u);
  } finally { h.close(); }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function boundaryHarness(mode: 'apply-race' | 'prepare-race', outcome: 'durable' | 'pending' | 'unreadable' = 'durable',
  form: 'structured' | 'text' | 'patch' = 'structured') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-replay-'));
  const filePath = path.join(root, 'document.md'); await fs.writeFile(filePath, 'old projection');
  const doc = createRichMarkdownYDoc('Remove\n\nKeep', 'tiptap_blocks');
  const originalBlock = readAgentBlockStructure(doc)[0];
  const requests: AgentBlockEditRequest[] = [{ kind: 'delete_block', blockId: originalBlock.id, subtreeHash: originalBlock.subtreeHash }];
  const context: AgentExecutionContext = { userId: 'user', sessionId: 'session', agentId: 'agent', workspaceId: 'workspace',
    workspaceType: 'team', workspaceName: null, organizationId: 'organization', customerId: null, projectId: null,
    workspaceRoot: root, workspaceRootRelativePath: null, canWrite: true, canDelete: false, canShare: false, legacy: false };
  const state = { documentId: 'document', workspaceId: 'workspace', organizationId: 'organization', path: 'document.md',
    status: 'active', representation: 'tiptap_blocks' as const, lifecycleGeneration: 2, schemaVersion: 1 };
  const identity = { path: state.path, representation: state.representation, lifecycleGeneration: 2, schemaVersion: 1 };
  const metadata = { id: state.documentId, workspaceId: state.workspaceId, path: state.path, status: 'active', provider: 'yjs' };
  type Receipt = { request: Agent.AgentFileEditRequestReceipt; operation: Agent.PersistedAgentApplyResult; identity: typeof identity };
  let recorded: Receipt | null = null;
  let lookups = 0; let preparations = 0; let executions = 0; let applied = 0; let audits = 0; let reads = 0;
  const lookupGate = gate(); const preparedGate = gate(); const appliedGate = gate();
  const prepared: PreparedCollaborationTextEdit[] = [];
  class ScopeError extends Error { constructor(readonly operation: Agent.PersistedAgentApplyResult) { super('Scope changed'); } }
  const current = () => {
    if (outcome === 'unreadable' && recorded) throw new Error('Room unavailable after commit');
    const content = richMarkdownFromYDoc(doc);
    return { documentId: state.documentId, ...identity, documentSequence: 5, checkpointSequence: 1,
      content, sha256: hash(content), stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64') };
  };
  const find = async (input: { idempotencyKey: string; fingerprint: string; actorId: string; actorSessionId: string }) => {
    assert.equal(input.idempotencyKey, form === 'patch' ? 'same-delivery:0' : 'same-delivery');
    assert.equal(input.actorId, 'agent'); assert.equal(input.actorSessionId, 'session');
    lookups++;
    if (lookups <= 2) { if (lookups === 2) lookupGate.release(); await lookupGate.promise; return null; }
    if (!recorded) return null;
    if (input.fingerprint !== recorded.request.fingerprint) throw new Error('Different request');
    return recorded;
  };
  const prepare = async (input: { operations: AgentBlockEditRequest[] }) => {
    preparations++;
    if (mode === 'prepare-race' && preparations === 2) await appliedGate.promise;
    const snapshot = current();
    const blockEdit = prepareAgentBlockEdit(doc, input.operations);
    const clone = new Y.Doc();
    try {
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc)); applyAgentBlockEdit(clone, blockEdit, 'preview');
      const proposedContent = richMarkdownFromYDoc(clone);
      const value: PreparedCollaborationTextEdit = { ...snapshot, proposedContent, proposedSha256: hash(proposedContent),
        requestedMode: 'direct_apply', targets: [{ kind: 'block_edit', targetId: 'target', groupId: 'group', startAnchor: '', endAnchor: '',
          baseTargetHash: previewAgentBlockEdit(doc, blockEdit).footprintHash, replacement: blockEdit.afterText, blockEdit, boundaryPolicy: 'exclude_external' }] };
      prepared.push(value);
      if (mode === 'apply-race' && preparations === 1) {
        // Both tools have the same request, but the second prepares after an
        // unrelated human update. Its before/proposed hashes must not replace
        // the original operation receipt when the queued apply becomes a replay.
        const schema = getSchema(richMarkdownSchemaExtensions()); const tree = new CollaborationBlockTree(doc, schema);
        const keep = tree.read().child(1);
        tree.updateInlineContent(keep.attrs.id, keep.type.create(keep.attrs, schema.text('Human keeps this')), 'human');
      }
      if (preparations === 2) preparedGate.release();
      return value;
    } finally { clone.destroy(); }
  };
  const execute = async (input: { prepared: PreparedCollaborationTextEdit; fileEditRequest: Agent.AgentFileEditRequestReceipt }) => {
    executions++;
    if (mode === 'apply-race') await preparedGate.promise;
    if (recorded) return { ...recorded.operation, fileEditRequestReused: true as const };
    applyAgentBlockEdit(doc, input.prepared.targets[0].blockEdit!, 'agent'); applied++;
    const operation: Agent.PersistedAgentApplyResult = { operationId: 'single-operation', operationStatus: outcome === 'pending' ? 'applied_to_ydoc' : 'persisted_yjs',
      durability: outcome === 'pending' ? 'applied_to_ydoc' : 'persisted_yjs', status: 'applied_to_ydoc',
      appliedTargetIds: ['target'], conflicts: [], stateVector: '', casVersion: 1 };
    recorded = { request: input.fileEditRequest, operation, identity };
    appliedGate.release();
    return operation;
  };
  const mocks: Record<string, unknown> = {
    'node:fs': { ...nodeFs, promises: { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === filePath) { reads++; throw new Error('Projection must not be read'); }
      return fs.readFile(...args);
    } } },
    '@/app/lib/audit/audit-service': { recordAuditEvent: async () => { audits++; } },
    '@/app/lib/agents/storage': { DEFAULT_MANAGED_AGENT_ID: 'agent' },
    '@/app/lib/logging': { logger: { module: () => ({ warn() {} }) } },
    '@/app/lib/files/collaboration-policy': { readFileCollaborationState: async () => ({ crdtCapable: true, document: metadata }) },
    '@/app/lib/collaboration/persistence': { loadCollaborationStateIncludingArchived: async () => state },
    '@/app/lib/collaboration/agent-operations': { AgentFileEditOperationScopeError: ScopeError, findAgentFileEditOperation: find },
    '@/app/lib/collaboration/agent-file-edits': { readCurrentCollaborationTextSnapshot: async () => current(),
      prepareCollaborationBlockEdit: prepare,
      prepareCollaborationTextEdit: async (input: { edits: unknown }) => {
        assert.deepEqual(input.edits, [{ oldText: 'Remove\n\n', newText: '', expectedOccurrences: undefined, replaceAll: undefined }]);
        return prepare({ operations: requests });
      },
      executePreparedCollaborationTextEdit: execute },
    '@/app/lib/public-sharing/public-file-shares': {}, '@/app/lib/filesystem/workspace-files': {}, '@/app/lib/filesystem/file-watcher': {},
    '@/app/lib/pi/agent-execution-context': { getAgentExecutionContext: () => context },
    '@/app/lib/pi/tool-output-store': { getToolOutputRoot: () => path.join(root, 'outputs'), getToolOutputSessionDirectory: () => path.join(root, 'outputs/session') },
    '@/app/lib/chat/agent-display': { getAgentDisplayName: () => 'Agent' },
    '@/app/lib/pi/agent-runtime-temp': { resolveAgentRuntimeTempDir: () => path.join(root, 'temp') },
    '@/app/lib/integrations/studio-workspace': { getStudioRoot: () => path.join(root, 'studio'), getStudioWorkspaceRoot: () => path.join(root, 'studio/workspace') },
    '@/app/lib/excalidraw-collaboration/agent-operations': {}, '@/app/lib/excalidraw-collaboration/repository': {},
  };
  const files = await compile<typeof Files>('app/lib/pi/agent-file-operations.ts', (name, load) => Object.hasOwn(mocks, name) ? mocks[name] : load(name));
  const initialSha256 = current().sha256;
  const edit = () => form === 'patch'
    ? files.applyAgentFilePatch({ files: [{ path: 'document.md', expectedSha256: initialSha256,
      edits: [{ oldText: 'Remove\n\n', newText: '', expectedOccurrences: undefined, replaceAll: undefined }] }],
    idempotencyKeyPrefix: 'same-delivery' }).then((results) => results[0])
    : form === 'text' ? files.editAgentFile({ path: 'document.md', oldText: 'Remove\n\n', newText: '',
      expectedSha256: initialSha256, idempotencyKey: 'same-delivery' })
      : files.editAgentFile({ path: 'document.md', operations: requests,
        document: { documentId: 'document', lifecycleGeneration: 2, schemaVersion: 1 }, idempotencyKey: 'same-delivery' });
  return { edit, files, doc, prepared, receipt: () => recorded, counts: () => ({ lookups, preparations, executions, applied, audits, reads }),
    close: async () => { doc.destroy(); await fs.rm(root, { recursive: true, force: true }); } };
}

for (const mode of ['apply-race', 'prepare-race'] as const) test(`concurrent first delivery ${mode} returns one recorded operation and one audit`, async () => {
  const h = await boundaryHarness(mode);
  try {
    const [first, second] = await Promise.all([h.edit(), h.edit()]);
    assert.equal(first.collaboration?.operationId, 'single-operation'); assert.equal(second.collaboration?.operationId, 'single-operation');
    const receipt = h.receipt()!;
    assert.equal(first.beforeSha256, receipt.request.beforeSha256); assert.equal(second.beforeSha256, receipt.request.beforeSha256);
    assert.equal(second.collaboration?.proposedSha256, receipt.request.proposedSha256);
    assert.equal([first, second].filter((result) => /retry did not prepare or apply another edit/u.test(result.diff)).length, 1);
    assert.equal(second.afterSha256, hash(richMarkdownFromYDoc(h.doc)));
    if (mode === 'apply-race') {
      assert.notEqual(h.prepared[0].sha256, h.prepared[1].sha256);
      assert.notEqual(h.prepared[0].proposedSha256, h.prepared[1].proposedSha256);
      assert.equal(richMarkdownFromYDoc(h.doc), 'Human keeps this');
    }
    assert.equal(h.counts().applied, 1); assert.equal(h.counts().audits, 1); assert.equal(h.counts().reads, 0);
    assert.equal(h.counts().executions, mode === 'apply-race' ? 2 : 1);
  } finally { await h.close(); }
});

for (const form of ['text', 'patch'] as const) test(`${form} preparation retries retrieve a racing deletion receipt`, async () => {
  const h = await boundaryHarness('prepare-race', 'durable', form);
  try {
    const results = await Promise.all([h.edit(), h.edit()]);
    for (const result of results) {
      assert.equal(result.collaboration?.operationId, 'single-operation');
      assert.equal(result.beforeSha256, h.receipt()!.request.beforeSha256);
    }
    assert.equal(h.counts().applied, 1); assert.equal(h.counts().executions, 1); assert.equal(h.counts().audits, 1);
  } finally { await h.close(); }
});

for (const outcome of ['pending', 'unreadable'] as const) test(`concurrent replay ${outcome} retains the operation ID without another mutation`, async () => {
  const h = await boundaryHarness('apply-race', outcome);
  try {
    const results = await Promise.allSettled([h.edit(), h.edit()]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status !== 'rejected') continue;
      assert.ok(result.reason instanceof h.files.AgentFileOperationOutcomeUnavailableError);
      assert.equal(result.reason.operationId, 'single-operation');
    }
    assert.equal(h.counts().applied, 1); assert.equal(h.counts().audits, 0); assert.equal(h.counts().reads, 0);
  } finally { await h.close(); }
});

test('a document reference cannot be silently ignored on a whole-file text edit', async () => {
  const h = await boundaryHarness('apply-race');
  try {
    await assert.rejects(h.files.editAgentFile({ path: 'document.md', oldText: 'Remove', newText: 'Changed',
      document: { documentId: 'document', lifecycleGeneration: 99, schemaVersion: 1 } }), /document reference requires/u);
    assert.equal(h.counts().lookups, 0); assert.equal(h.counts().preparations, 0); assert.equal(h.counts().executions, 0);
    assert.equal(richMarkdownFromYDoc(h.doc), 'Remove\n\nKeep');
  } finally { await h.close(); }
});
