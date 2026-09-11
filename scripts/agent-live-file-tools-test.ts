import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';
import { applyExactTextEdits } from '../app/lib/files/exact-text-patch';
import { asAgentFileToolSuccess } from '../app/lib/pi/agent-file-tool-results';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { CollaborationTextSnapshot, PreparedCollaborationTextEdit } from '../app/lib/collaboration/agent-file-edits';
import type { AgentFileEditRequestReceipt, PersistedAgentApplyResult } from '../app/lib/collaboration/agent-operations';
import type * as Operations from '../app/lib/pi/agent-file-operations';
import type * as Core from '../app/lib/pi/core-tools';
import type * as ToolResults from '../app/lib/pi/agent-file-tool-results';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
  );
  return exports as T;
}

/** Real path checks, file I/O and Y.Doc; external policy/operation services are controlled adapters. */
async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-live-file-tools-'));
  const filePath = path.join(root, 'document.md');
  const projected = 'Old projected content';
  await fs.writeFile(filePath, projected);
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'XLive sentence\nOther user paragraph');
  doc.getText('content').delete(0, 1);
  const context: AgentExecutionContext = { userId: 'user', sessionId: 'session', agentId: 'agent', workspaceId: 'workspace',
    workspaceType: 'team', workspaceName: null, organizationId: 'organization', customerId: null, projectId: null,
    workspaceRoot: root, workspaceRootRelativePath: null, canWrite: true, canDelete: false, canShare: false, legacy: false };
  const metadata = { id: 'document', workspaceId: context.workspaceId, path: 'document.md', provider: 'yjs', status: 'active' };
  const state = { documentId: 'document', workspaceId: context.workspaceId, organizationId: context.organizationId,
    path: 'document.md', status: 'active', representation: 'plain_text', lifecycleGeneration: 2 };
  const controls = { eligible: true, metadataPresent: true, persistedPresent: true, unreadable: true,
    durability: 'persisted_yjs', operationStatus: 'applied_to_ydoc', executeError: null as Error | null,
    readFailsAfterApply: false, reads: 0, revisions: 0, initialized: 0, executed: 0, afterPrepare: null as (() => void) | null,
    afterApply: null as (() => void) | null,
    afterLookup: null as (() => void) | null, audits: 0, lookups: 0,
    idempotencyKeys: [] as Array<string | undefined>, prepared: [] as PreparedCollaborationTextEdit[] };
  const receipts = new Map<string, { request: AgentFileEditRequestReceipt; operation: PersistedAgentApplyResult;
    identity: { path: string; representation: 'plain_text'; lifecycleGeneration: number; schemaVersion: number } }>();
  let preparedEdits: Parameters<typeof applyExactTextEdits>[1] = [];
  class OperationScopeError extends Error {
    constructor(readonly operation: PersistedAgentApplyResult) { super('Recorded operation belongs to an old lifecycle.'); }
  }
  const fsAdapter = { ...nodeFs, promises: { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === filePath) {
      controls.reads++;
      if (controls.unreadable) throw Object.assign(new Error('Markdown projection is unreadable'), { code: 'EACCES' });
    }
    return fs.readFile(...args);
  } } };
  const current = (): CollaborationTextSnapshot => {
    if (controls.readFailsAfterApply && controls.executed) throw new Error('Room disconnected after confirmed operation');
    const content = doc.getText('content').toString();
    return { documentId: state.documentId, path: state.path, representation: 'plain_text', lifecycleGeneration: state.lifecycleGeneration,
      schemaVersion: 1, documentSequence: 8, checkpointSequence: 2, content, sha256: operations.sha256Text(content),
      stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64') };
  };
  const policy = {
    readFileCollaborationState: async () => ({ crdtCapable: controls.eligible, document: controls.metadataPresent ? metadata : null }),
    getFileCollaborationState: async (input: { ensureDocument?: boolean }) => {
      if (input.ensureDocument) controls.metadataPresent = true;
      return { crdtCapable: controls.eligible, document: controls.metadataPresent ? metadata : null };
    },
    ensureFileRevisionForCurrentContent: async () => { controls.revisions++; return { id: 'revision' }; },
  };
  const mocks: Record<string, unknown> = {
    'node:fs': fsAdapter,
    '@/app/lib/audit/audit-service': { recordAuditEvent: async () => { controls.audits++; } },
    '@/app/lib/agents/storage': { DEFAULT_MANAGED_AGENT_ID: 'agent' },
    '@/app/lib/logging': { logger: { module: () => ({ warn() {} }) } },
    '@/app/lib/files/collaboration-policy': policy,
    '@/app/lib/collaboration/persistence': { loadCollaborationStateIncludingArchived: async () => controls.persistedPresent ? state : null },
    '@/app/lib/collaboration/agent-operations': {
      AgentFileEditOperationScopeError: OperationScopeError,
      findAgentFileEditOperation: async (input: { idempotencyKey: string; fingerprint: string; documentId: string;
        userId: string; actorId: string; actorSessionId?: string }) => {
        controls.lookups++;
        assert.equal(input.documentId, state.documentId); assert.equal(input.userId, context.userId);
        assert.equal(input.actorId, context.agentId); assert.equal(input.actorSessionId, context.sessionId);
        const found = receipts.get(input.idempotencyKey);
        if (!found) return null;
        if (found.request.fingerprint !== input.fingerprint) throw new Error('Idempotency key used with a different request');
        if (found.identity.lifecycleGeneration !== state.lifecycleGeneration || found.identity.path !== state.path) {
          throw new OperationScopeError(found.operation);
        }
        controls.afterLookup?.();
        return found;
      },
    },
    '@/app/lib/collaboration/document-state-service': {
      CollaborationDocumentStateError: class extends Error { constructor(message: string, readonly code: string) { super(message); } },
      selectInitialTextCollaborationRepresentation: () => 'plain_text',
      resolveTextCollaborationState: async (input: { initialContent: string }) => {
        controls.initialized++; controls.persistedPresent = true;
        doc.transact(() => { const text = doc.getText('content'); text.delete(0, text.length); text.insert(0, input.initialContent); });
      },
    },
    '@/app/lib/collaboration/agent-file-edits': {
      readCurrentCollaborationTextSnapshot: async () => current(),
      prepareCollaborationTextEdit: async (input: { expectedSha256?: string; edits: Parameters<typeof applyExactTextEdits>[1] }) => {
        const read = current();
        if (input.expectedSha256 && input.expectedSha256 !== read.sha256) throw new Error('Live revision conflict');
        const proposedContent = applyExactTextEdits(read.content, input.edits, read.path);
        preparedEdits = input.edits;
        const prepared: PreparedCollaborationTextEdit = { ...read, proposedContent,
          proposedSha256: operations.sha256Text(proposedContent), requestedMode: 'direct_apply', targets: [] };
        controls.prepared.push(prepared);
        controls.afterPrepare?.();
        return prepared;
      },
      executePreparedCollaborationTextEdit: async (input: { prepared: PreparedCollaborationTextEdit; idempotencyKey?: string;
        fileEditRequest?: AgentFileEditRequestReceipt }) => {
        controls.executed++; controls.idempotencyKeys.push(input.idempotencyKey);
        if (controls.executeError) throw controls.executeError;
        if (controls.operationStatus !== 'needs_review') {
          // Stand-in for the separate operation service. A current user's
          // unrelated paragraph is retained while the agent changes its target.
          const text = doc.getText('content');
          doc.transact(() => {
            const next = applyExactTextEdits(text.toString(), preparedEdits, state.path);
            text.delete(0, text.length); text.insert(0, next);
          }, 'agent');
        }
        controls.afterApply?.();
        const operation = { operationId: 'operation-1', operationStatus: controls.operationStatus, durability: controls.durability,
          status: 'applied_to_ydoc', appliedTargetIds: controls.operationStatus === 'needs_review' ? [] : ['target'],
          conflicts: [], stateVector: '', casVersion: 1 } as PersistedAgentApplyResult;
        assert.ok(input.fileEditRequest);
        assert.equal(input.fileEditRequest.beforeSha256, input.prepared.sha256);
        assert.equal(input.fileEditRequest.proposedSha256, input.prepared.proposedSha256);
        assert.deepEqual(Object.keys(input.fileEditRequest).sort(), ['beforeSha256', 'fingerprint', 'proposedSha256']);
        for (const value of Object.values(input.fileEditRequest)) assert.match(value, /^[a-f\d]{64}$/u, 'receipt metadata contains hashes only');
        receipts.set(input.idempotencyKey!, { operation, request: input.fileEditRequest,
          identity: { path: input.prepared.path, representation: 'plain_text', lifecycleGeneration: input.prepared.lifecycleGeneration,
            schemaVersion: input.prepared.schemaVersion } });
        return operation;
      },
    },
    '@/app/lib/public-sharing/public-file-shares': {},
    '@/app/lib/filesystem/workspace-files': {},
    '@/app/lib/filesystem/file-watcher': {},
    '@/app/lib/pi/agent-execution-context': { getAgentExecutionContext: () => context },
    '@/app/lib/pi/tool-output-store': { getToolOutputRoot: () => path.join(root, 'outputs'), getToolOutputSessionDirectory: () => path.join(root, 'outputs/session') },
    '@/app/lib/chat/agent-display': { getAgentDisplayName: () => 'Agent' },
    '@/app/lib/pi/agent-runtime-temp': { resolveAgentRuntimeTempDir: () => path.join(root, 'temp') },
    '@/app/lib/integrations/studio-workspace': { getStudioRoot: () => path.join(root, 'studio'), getStudioWorkspaceRoot: () => path.join(root, 'studio/workspace') },
    '@/app/lib/excalidraw-collaboration/agent-operations': {}, '@/app/lib/excalidraw-collaboration/repository': {},
  };
  const operations = await compile<typeof Operations>('app/lib/pi/agent-file-operations.ts', mocks);
  const toolResults = await compile<typeof ToolResults>('app/lib/pi/agent-file-tool-results.ts', { './agent-file-operations': operations });
  const edit = () => operations.editAgentFile({ path: 'document.md', oldText: 'Live', newText: 'Edited',
    expectedSha256: current().sha256, idempotencyKey: 'stable-request-1' });
  const patch = () => operations.applyAgentFilePatch({ files: [{ path: 'document.md', expectedSha256: current().sha256,
    edits: [{ oldText: 'Live', newText: 'Edited' }] }], idempotencyKeyPrefix: 'stable-patch' });
  return { operations, toolResults, receipts, controls, context, metadata, state, doc, filePath, projected, fsAdapter, current, edit, patch,
    close: async () => { doc.destroy(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('live read/edit/patch do not read or register a stale/unreadable Markdown projection', async (t) => {
  for (const method of ['read', 'edit', 'patch'] as const) await t.test(method, async () => {
    const h = await harness();
    try {
      if (method === 'read') {
        const result = await h.operations.readAgentCollaborativeTextFile(h.filePath, Buffer.from('STALE caller buffer'));
        assert.equal(result?.content, h.current().content);
      } else {
        h.controls.afterPrepare = () => h.doc.getText('content').insert(h.doc.getText('content').length, '\nUser arrived during edit');
        const result = method === 'edit' ? await h.edit() : (await h.patch())[0];
        assert.equal(result.changed, true);
        assert.equal(result.afterSha256, h.current().sha256);
        assert.equal(result.collaboration?.durability, 'persisted_yjs');
        assert.equal(asAgentFileToolSuccess(result, method === 'edit' ? 'edit_file' : 'apply_patch').outcome, 'applied');
        assert.match(h.current().content, /Edited sentence\nOther user paragraph\nUser arrived during edit/u);
        assert.deepEqual(h.controls.idempotencyKeys, [method === 'edit' ? 'stable-request-1' : 'stable-patch:0']);
      }
      assert.equal(h.controls.reads, 0);
      assert.equal(h.controls.revisions, 0);
      assert.equal(h.controls.initialized, 0);
      assert.equal(await fs.readFile(h.filePath, 'utf8'), h.projected, 'the tool never falls back to direct file overwrite');
    } finally { await h.close(); }
  });
});

test('operation receipts preserve uncertain, partial and post-commit-read outcomes', async (t) => {
  for (const scenario of ['checkpointed', 'uncertain', 'partial', 'needs-review', 'read-failed', 'moved-after-apply', 'execution-failed'] as const) await t.test(scenario, async () => {
    const h = await harness();
    try {
      if (scenario === 'checkpointed') h.controls.durability = 'checkpointed_file';
      if (scenario === 'uncertain') h.controls.durability = 'applied_to_ydoc';
      if (scenario === 'partial') h.controls.operationStatus = 'partially_applied';
      if (scenario === 'needs-review') { h.controls.operationStatus = 'needs_review'; h.controls.durability = 'none'; }
      if (scenario === 'read-failed') h.controls.readFailsAfterApply = true;
      if (scenario === 'moved-after-apply') h.controls.afterApply = () => { h.state.path = 'renamed.md'; };
      if (scenario === 'execution-failed') {
        h.controls.executeError = new Error('Operation service unavailable');
        await assert.rejects(h.edit(), /Operation service unavailable/u);
      } else if (scenario === 'uncertain' || scenario === 'read-failed' || scenario === 'moved-after-apply') {
        await assert.rejects(h.edit(), (error) => {
          assert.ok(error instanceof h.operations.AgentFileOperationOutcomeUnavailableError);
          const result = h.toolResults.asAgentFileToolError(error, 'edit_file');
          assert.equal(result.code, 'COLLABORATION_OPERATION_OUTCOME_UNAVAILABLE');
          assert.equal(result.category, 'technical_error');
          assert.equal(result.safeToAutoRetry, false);
          assert.equal(result.currentSha256, null, 'an unavailable current read cannot certify the old before hash');
          assert.equal(result.collaboration?.operationId, 'operation-1');
          assert.equal(result.collaboration?.durability, h.controls.durability);
          return true;
        });
      } else {
        const result = await h.edit();
        assert.equal(result.collaboration?.operationId, 'operation-1');
        assert.equal(result.collaboration?.durability, h.controls.durability);
        assert.equal(result.collaboration?.reviewRequired, scenario !== 'checkpointed');
        assert.equal(asAgentFileToolSuccess(result, 'edit_file').category, scenario === 'checkpointed' ? 'success' : 'review_required');
        if (scenario === 'needs-review') assert.match(h.current().content, /^Live sentence/u, 'an unapproved proposal does not mutate the live document');
      }
      assert.equal(h.controls.executed, 1, 'uncertainty never triggers an automatic second mutation');
      assert.equal(h.controls.reads, 0);
      assert.equal(await fs.readFile(h.filePath, 'utf8'), h.projected);
    } finally { await h.close(); }
  });
});

test('identical edit/patch delivery reuses its receipt before deleted oldText is matched again', async (t) => {
  for (const method of ['edit', 'patch'] as const) await t.test(method, async () => {
    const h = await harness();
    try {
      const expectedSha256 = h.current().sha256;
      const edit = { path: 'document.md', oldText: 'Live ', newText: '', expectedSha256, idempotencyKey: 'deletion-delivery' };
      const patch = { files: [{ path: edit.path, expectedSha256, edits: [{ oldText: edit.oldText, newText: edit.newText }] }],
        idempotencyKeyPrefix: 'deletion-delivery' };
      const call = async () => method === 'edit' ? h.operations.editAgentFile(edit) : (await h.operations.applyAgentFilePatch(patch))[0];
      const first = await call();
      assert.equal(h.current().content.includes('Live'), false);
      h.doc.getText('content').insert(h.doc.getText('content').length, '\nAnother user kept working');
      const beforeRetry = Y.encodeStateAsUpdate(h.doc);
      const second = await call();
      assert.equal(h.controls.executed, 1);
      assert.equal(h.controls.prepared.length, 1, 'retry does not regenerate anchors or match absent text');
      assert.equal(h.controls.audits, 1, 'retrieval does not duplicate the mutation audit');
      assert.equal(second.collaboration?.operationId, first.collaboration?.operationId);
      assert.equal(second.beforeSha256, first.beforeSha256);
      assert.equal(second.collaboration?.proposedSha256, first.collaboration?.proposedSha256);
      assert.equal(second.afterSha256, h.current().sha256, 'current hash includes subsequent user changes');
      assert.deepEqual(Y.encodeStateAsUpdate(h.doc), beforeRetry);
      assert.match(second.diff, /did not prepare or apply another edit/u);
      if (method === 'edit') {
        await assert.rejects(h.operations.editAgentFile({ ...edit, newText: 'different replacement' }), /different request/u);
      } else {
        await assert.rejects(h.operations.applyAgentFilePatch({ ...patch,
          files: [{ ...patch.files[0], edits: [{ oldText: edit.oldText, newText: 'different replacement' }] }] }), /different request/u);
      }
      assert.equal(h.controls.executed, 1);
      assert.equal(h.controls.prepared.length, 1, 'payload mismatch fails before preparation');
      assert.equal(h.controls.reads, 0);
    } finally { await h.close(); }
  });
});

test('receipt reuse retains the operation ID when the current room is unavailable or changes lifecycle', async (t) => {
  for (const scenario of ['read-failed', 'generation-before-lookup', 'generation-after-lookup'] as const) await t.test(scenario, async () => {
    const h = await harness();
    try {
      const input = { path: 'document.md', oldText: 'Live', newText: 'Edited', expectedSha256: h.current().sha256, idempotencyKey: 'same-delivery' };
      await h.operations.editAgentFile(input);
      if (scenario === 'read-failed') h.controls.readFailsAfterApply = true;
      if (scenario === 'generation-before-lookup') h.state.lifecycleGeneration++;
      if (scenario === 'generation-after-lookup') h.controls.afterLookup = () => { h.state.lifecycleGeneration++; };
      await assert.rejects(h.operations.editAgentFile(input), (error) => {
        assert.ok(error instanceof h.operations.AgentFileOperationOutcomeUnavailableError);
        const details = h.toolResults.asAgentFileToolError(error, 'edit_file');
        assert.equal(details.collaboration?.operationId, 'operation-1');
        assert.equal(details.collaboration?.durability, 'persisted_yjs');
        assert.equal(details.currentSha256, null);
        assert.equal(details.safeToAutoRetry, false);
        return true;
      });
      assert.equal(h.controls.executed, 1);
      assert.equal(h.controls.prepared.length, 1);
      assert.equal(h.controls.reads, 0);
    } finally { await h.close(); }
  });
});

test('the shared prepared-edit adapter forwards the exact optional request receipt', async () => {
  const h = await harness();
  try {
    let forwarded: { fileEditRequest?: AgentFileEditRequestReceipt } | undefined;
    const edits = await compile<typeof import('../app/lib/collaboration/agent-file-edits')>('app/lib/collaboration/agent-file-edits.ts', {
      './agent-operations': { applyPersistedAgentTextOperation: async (input: typeof forwarded) => { forwarded = input; return {}; } },
    });
    const receipt = { fingerprint: 'a'.repeat(64), beforeSha256: h.current().sha256, proposedSha256: 'b'.repeat(64) };
    await edits.executePreparedCollaborationTextEdit({ prepared: { ...h.current(), proposedContent: 'Edited', proposedSha256: receipt.proposedSha256,
      targets: [], requestedMode: 'direct_apply' }, workspace: h.operations.getAgentWorkspaceContext()!,
      identity: { initiatedByUserId: 'user', actorId: 'agent', actorDisplayName: 'Agent' }, idempotencyKey: 'adapter-test', fileEditRequest: receipt });
    assert.deepEqual(forwarded?.fileEditRequest, receipt);
  } finally { await h.close(); }
});

test('path, rights, current hash and lifecycle checks remain mandatory', async (t) => {
  for (const scenario of ['readonly', 'archived', 'moved', 'other-workspace', 'other-organization', 'wrong-provider', 'missing-file', 'stale-hash', 'symlink-outside', 'outside-workspace'] as const) await t.test(scenario, async () => {
    const h = await harness();
    try {
      if (scenario === 'readonly') h.context.canWrite = false;
      if (scenario === 'archived') h.state.status = 'archived';
      if (scenario === 'moved') h.state.path = 'new-name.md';
      if (scenario === 'other-workspace') h.state.workspaceId = 'another-workspace';
      if (scenario === 'other-organization') h.state.organizationId = 'another-organization';
      if (scenario === 'wrong-provider') h.metadata.provider = 'excalidraw';
      if (scenario === 'missing-file') await fs.unlink(h.filePath);
      if (scenario === 'symlink-outside') {
        await fs.unlink(h.filePath);
        await fs.symlink(path.dirname(path.dirname(h.filePath)), h.filePath);
      }
      const request = scenario === 'stale-hash'
        ? h.operations.editAgentFile({ path: 'document.md', oldText: 'Live', newText: 'Edited', expectedSha256: h.operations.sha256Text(h.projected) })
        : scenario === 'outside-workspace'
          ? h.operations.editAgentFile({ path: '../another-workspace/document.md', oldText: 'Live', newText: 'Edited', expectedSha256: h.current().sha256 })
          : h.edit();
      await assert.rejects(request);
      assert.equal(h.controls.executed, 0);
      assert.equal(h.controls.reads, 0, 'a known live document never silently reinitializes from the projection');
      assert.equal(h.controls.initialized, 0);
    } finally { await h.close(); }
  });
});

test('only an uninitialized collaboration document reads file content; ordinary files retain their existing path', async () => {
  const h = await harness();
  try {
    h.controls.metadataPresent = false; h.controls.persistedPresent = false; h.controls.unreadable = false;
    assert.equal((await h.operations.readAgentCollaborativeTextFile(h.filePath))?.content, h.projected);
    assert.equal(h.controls.reads, 1); assert.equal(h.controls.initialized, 1); assert.equal(h.controls.revisions, 1);
    h.controls.eligible = false;
    assert.equal(await h.operations.readAgentCollaborativeTextFile(h.filePath), null);
    const result = await h.operations.editAgentFile({ path: 'document.md', oldText: h.projected, newText: h.projected,
      expectedSha256: h.operations.sha256Text(h.projected) });
    assert.equal(result.collaboration, undefined);
    assert.equal(result.changed, false);
    assert.equal(h.controls.reads, 2);
  } finally { await h.close(); }
});

test('the actual read-tool wrapper chooses live text before projected bytes or media classification', async () => {
  const h = await harness();
  try {
    const helper = { ...h.operations, getErrorMessage: (error: unknown) => String(error), throwIfAborted() {},
      resolveReadToolPath: async () => ({ fullPath: h.filePath, displayPath: 'document.md', source: 'workspace' }),
      clampReadTextLimit: () => 2000, clampPositiveInteger: () => 2000, isPdfPath: () => false,
      imageContentForBuffer: async () => { throw new Error('live text must not pass through image classification'); },
      isPdfBuffer: () => { throw new Error('live text must not pass through PDF classification'); },
      bufferLooksBinary: () => { throw new Error('live text must not pass through binary classification'); },
    };
    const factories = new Proxy({}, { get: (_, key) => String(key) === 'createPdfTools' || String(key) === 'createOfficeDocumentTools'
      ? () => [] : () => ({ name: `unused-${String(key)}` }) });
    const mocks: Record<string, unknown> = { fs: h.fsAdapter, '@/app/lib/pi/tool-runtime-helpers': helper };
    for (const dependency of ['@/app/lib/mcp/proxy-tool', '@/app/lib/pi/browser/tool', '@/app/lib/pi/studio-tools',
      '@/app/lib/pi/web-tools', '@/app/lib/pi/document-relations-tool', '@/app/lib/pi/pdf-tools', '@/app/lib/pi/office-document-tools',
      '@/app/lib/pi/agent-shell-sandbox', '@/app/lib/pi/agent-runtime-temp', '@/app/lib/pi/agent-bash-runtime']) mocks[dependency] = factories;
    const core = await compile<typeof Core>('app/lib/pi/core-tools.ts', mocks);
    const read = core.piTools.find((tool) => tool.name === 'read');
    assert.ok(read);
    const result = await read.execute('read-1', { path: 'document.md' }, undefined);
    assert.equal((result.details as { error?: string }).error, undefined);
    assert.match(JSON.stringify(result), /Live sentence/u);
    assert.equal(h.controls.reads, 0);
    assert.equal(h.controls.revisions, 0);
  } finally { await h.close(); }
});
