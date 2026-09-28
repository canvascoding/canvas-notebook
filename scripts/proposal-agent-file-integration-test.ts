import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { Y } from '../app/lib/collaboration/server-runtime';
import type * as Operations from '../app/lib/pi/agent-file-operations';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { AgentTextTarget } from '../app/lib/collaboration/agent-operations';
import type { ProposalDocumentScopeV1, ProposalNodeV1, ProposalSourceProofV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { ProposalGraphContractError } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolCreationResultV1, ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { authorProposalYjsCandidate, proposalYjsCurrentProof } from '../app/lib/file-version-center/proposal-yjs-candidate';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const currentContent = 'Kosten: 10 EUR\n';
const parentContent = 'Kosten: 12 EUR\nNur im Vorschlag: 100 EUR\n';
const proposedContent = 'Kosten: 12 EUR\nNur im Vorschlag: 150 EUR\n';
const scope: ProposalDocumentScopeV1 = { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document',
  lifecycleGeneration: 2, schemaVersion: 1 };
const errorCode = (code: string) => (error: unknown) => error instanceof ProposalGraphContractError && error.code === code;

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  return exports as T;
}

/** Real facade, path guards and Yjs target preparation; only the authorized runtime boundary is injected. */
async function facadeHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-proposal-tool-facade-'));
  const fullPath = path.join(root, 'document.md');
  const projection = 'Old disk projection';
  await fs.writeFile(fullPath, projection);
  const live = new Y.Doc({ gc: false }); live.clientID = 300;
  live.getText('content').insert(0, currentContent);
  const parent = new Y.Doc({ gc: false }); parent.clientID = 301;
  Y.applyUpdate(parent, Y.encodeStateAsUpdate(live));
  parent.getText('content').delete(0, parent.getText('content').length);
  parent.getText('content').insert(0, parentContent);
  const parentUpdate = Y.encodeStateAsUpdate(parent);
  const parentHash = hash(parentUpdate);
  const source: ProposalSourceProofV1 = { kind: 'proposal', scope,
    current: proposalYjsCurrentProof({ update: Y.encodeStateAsUpdate(live), representation: 'plain_text', revisionId: 'revision' }),
    snapshot: { ref: 'parent-snapshot', sha256: parentHash, sizeBytes: parentUpdate.byteLength, encoding: 'yjs_full_update_v1' },
    anchorMap: { ref: 'parent-anchors', sha256: 'a'.repeat(64), sizeBytes: 2 }, proposalId: 'parent',
    proposalCasVersion: 3, authoredCandidateHash: parentHash, candidateHash: parentHash, evaluationId: 'parent-evaluation' };
  const proposal: ProposalToolEditV1 = { contractVersion: 1, creationKind: 'extends', source,
    expectedParentCandidateHash: parentHash, expectedParentCasVersion: 3, replaces: null, choice: null };
  const context: AgentExecutionContext = { userId: 'user', sessionId: 'session', agentId: 'agent', workspaceId: 'workspace',
    workspaceType: 'team', workspaceName: null, organizationId: 'organization', customerId: null, projectId: null,
    workspaceRoot: root, workspaceRootRelativePath: null, canWrite: true, canDelete: false, canShare: false, legacy: false };
  const state = { documentId: 'document', workspaceId: 'workspace', organizationId: 'organization', path: 'document.md',
    representation: 'plain_text' as const, status: 'active', lifecycleGeneration: 2, schemaVersion: 1,
    documentSequence: 7, checkpointSequence: 5 };
  const controls = { enabled: true, supported: true, reviewMode: 'review_required' as 'review_required' | 'safe_direct',
    allowProjectionRead: false,
    factoryCalls: 0, creates: 0, ordinaryCreates: 0, builds: 0, ordinaryBuilds: 0, currentReads: 0,
    projectionReads: 0, legacyCalls: [] as string[], readIds: [] as Array<string | null>,
    mutations: [] as unknown[], forwardedProposals: [] as ProposalToolEditV1[], idempotencyKeys: [] as string[],
    afterFirst: null as (() => void) | null };
  const forbid = (label: string) => () => { controls.legacyCalls.push(label); throw new Error(`Forbidden fallback: ${label}`); };
  type Created = { node: ProposalNodeV1; proposal: ProposalToolCreationResultV1; reused: boolean;
    authoringPreview: { beforeContent: string; proposedContent: string; beforeSha256: string; proposedSha256: string } };
  const receipts = new Map<string, Created>();
  const ordinaryReceipts = new Map<string, { digest: string; value: Created }>();
  const mocks: Record<string, unknown> = {
    'node:fs': { ...nodeFs, promises: { ...fs,
      readFile: async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === fullPath) {
          controls.projectionReads++;
          if (!controls.allowProjectionRead) throw new Error('Projection must not be consulted');
        }
        return fs.readFile(...args);
      }, writeFile: forbid('fs.writeFile'), rename: forbid('fs.rename') } },
    '@/app/lib/audit/audit-service': { recordAuditEvent: async () => {} },
    '@/app/lib/agents/storage': { DEFAULT_MANAGED_AGENT_ID: 'agent' },
    '@/app/lib/logging': { logger: { module: () => ({ warn() {} }) } },
    '@/app/lib/files/collaboration-policy': {
      readFileCollaborationState: async () => ({ crdtCapable: controls.supported, document: controls.supported
        ? { id: 'document', workspaceId: 'workspace', path: 'document.md', provider: 'yjs', status: 'active' } : null }),
      ensureFileRevisionForCurrentContent: forbid('ensureFileRevisionForCurrentContent'),
      getFileCollaborationState: forbid('getFileCollaborationState'),
      assertFileCollaborationWriteAllowed: forbid('assertFileCollaborationWriteAllowed'),
    },
    '@/app/lib/collaboration/persistence': { loadCollaborationStateIncludingArchived: async () => state },
    '@/app/lib/collaboration/document-state-service': {
      CollaborationDocumentStateError: class extends Error {},
      resolveTextCollaborationState: forbid('resolveTextCollaborationState'),
    },
    '@/app/lib/collaboration/agent-operations': {
      AgentFileEditOperationScopeError: class extends Error {}, findAgentFileEditOperation: async () => null,
    },
    '@/app/lib/file-version-center/proposal-review-capability': {
      proposalReviewWritesEnabled: () => controls.enabled,
    },
    '@/app/lib/file-version-center/agent-review-policy-adapter': {
      readAgentReviewPolicySnapshot: async () => ({ policy: { effectiveMode: controls.reviewMode, locked: false } }),
    },
    '@/app/lib/public-sharing/public-file-shares': {},
    '@/app/lib/filesystem/workspace-files': { writeFile: forbid('writeWorkspaceFile'), withWorkspaceFileMutationLocks: forbid('withWorkspaceFileMutationLocks') },
    '@/app/lib/filesystem/file-watcher': { publishWorkspaceFileMutation: forbid('publishWorkspaceFileMutation') },
    '@/app/lib/pi/agent-execution-context': { getAgentExecutionContext: () => context },
    '@/app/lib/pi/tool-output-store': { getToolOutputRoot: () => path.join(root, 'outputs'), getToolOutputSessionDirectory: () => path.join(root, 'outputs/session') },
    '@/app/lib/chat/agent-display': { getAgentDisplayName: () => 'Agent' },
    '@/app/lib/pi/agent-runtime-temp': { resolveAgentRuntimeTempDir: () => path.join(root, 'temp') },
    '@/app/lib/integrations/studio-workspace': { getStudioRoot: () => path.join(root, 'studio'), getStudioWorkspaceRoot: () => path.join(root, 'studio/workspace') },
    '@/app/lib/excalidraw-collaboration/agent-operations': {}, '@/app/lib/excalidraw-collaboration/repository': {},
    '@/app/lib/file-version-center/proposal-agent-runtime': {
      assertProposalToolsEnabled: () => { if (!controls.enabled) throw new ProposalGraphContractError('PROPOSAL_UPGRADE_REQUIRED', 'Proposal tools are disabled'); },
      assertProposalCreationEnabled: () => { if (!controls.enabled) throw new ProposalGraphContractError('PROPOSAL_UPGRADE_REQUIRED', 'Proposal creation is disabled'); },
      hasPotentialProposalAgentRetryKey: async (input: { idempotencyKey: string }) => ordinaryReceipts.has(input.idempotencyKey),
      createRuntimeProposalAgentService: async (input: { workspace: { workspaceId: string }; documentId: string; path: string;
        identity: { actorId: string; initiatedByUserId: string; actorSessionId: string } }) => {
        controls.factoryCalls++;
        assert.equal(input.documentId, scope.documentId); assert.equal(input.workspace.workspaceId, scope.workspaceId);
        assert.equal(input.path, state.path);
        assert.deepEqual({ actorId: input.identity.actorId, userId: input.identity.initiatedByUserId, session: input.identity.actorSessionId },
          { actorId: 'agent', userId: 'user', session: context.sessionId });
        return { scope, state, service: {
          createIndependent: async (request: { scope: ProposalDocumentScopeV1; actorId: string; idempotencyKey: string;
            mutation: unknown; allowCreate: boolean; buildTargets(input: { update: Uint8Array; representation: 'plain_text';
              content: string; structure: null }): AgentTextTarget[] | Promise<AgentTextTarget[]> }) => {
            controls.ordinaryCreates++;
            const digest = JSON.stringify(request.mutation);
            const stored = ordinaryReceipts.get(request.idempotencyKey);
            if (stored) {
              if (stored.digest !== digest) throw new ProposalGraphContractError('PROPOSAL_IDEMPOTENCY_MISMATCH', 'Changed intent');
              return { ...stored.value, reused: true };
            }
            if (!request.allowCreate) return null;
            controls.ordinaryBuilds++;
            const update = Y.encodeStateAsUpdate(live);
            const base = live.getText('content').toString();
            const targets = await request.buildTargets({ update, representation: 'plain_text', content: base, structure: null });
            const authored = authorProposalYjsCandidate({ representation: 'plain_text', sourceUpdate: update, targets });
            const ref = (label: string, bytes: Uint8Array) => ({ ref: label, sha256: hash(bytes), sizeBytes: bytes.byteLength });
            const ordinarySource: ProposalSourceProofV1 = { kind: 'authoritative', scope,
              current: proposalYjsCurrentProof({ update, representation: 'plain_text', revisionId: 'revision' }),
              snapshot: { ...ref('ordinary-current', update), encoding: 'yjs_full_update_v1' },
              anchorMap: { ref: 'ordinary-anchors', sha256: 'a'.repeat(64), sizeBytes: 2 } };
            const node: ProposalNodeV1 = { contractVersion: 1, proposalId: 'ordinary-root', operationId: 'ordinary-operation',
              scope, casVersion: 1, source: ordinarySource,
              relationships: { dependency: null, replacesProposalId: null, choiceGroupId: null },
              authoredCandidate: { incrementalPayload: ref('ordinary-payload', authored.incrementalPayload),
                cumulativeCandidate: { ...ref('ordinary-candidate', authored.cumulativeCandidate), encoding: 'yjs_full_update_v1' },
                effectPreconditions: ref('ordinary-witness', authored.effectPreconditions), sourceProofHash: 'f'.repeat(64) },
              lifecycle: 'open', createdAt: 1, createdByActorId: 'agent' };
            const value: Created = { node, reused: false, proposal: { contractVersion: 1, proposalId: node.proposalId,
              operationId: node.operationId, scope, creationKind: 'independent', casVersion: 1,
              candidateHash: node.authoredCandidate.cumulativeCandidate.sha256, source: ordinarySource,
              relationships: node.relationships, reviewRequired: true },
              authoringPreview: { beforeContent: base, proposedContent: authored.content,
                beforeSha256: hash(base), proposedSha256: hash(authored.content) } };
            ordinaryReceipts.set(request.idempotencyKey, { digest, value });
            return value;
          },
          create: async (request: { scope: ProposalDocumentScopeV1; actorId: string; idempotencyKey: string; proposal: ProposalToolEditV1;
            mutation: unknown; buildTargets(input: { update: Uint8Array; representation: 'plain_text'; content: string; structure: null }): AgentTextTarget[] | Promise<AgentTextTarget[]> }) => {
            controls.creates++; controls.mutations.push(structuredClone(request.mutation));
            controls.forwardedProposals.push(structuredClone(request.proposal)); controls.idempotencyKeys.push(request.idempotencyKey);
            assert.deepEqual(request.scope, scope); assert.equal(request.actorId, 'agent');
            const recorded = receipts.get(request.idempotencyKey);
            if (recorded) return { ...recorded, reused: true };
            controls.builds++;
            const targets = await request.buildTargets({ update: new Uint8Array(parentUpdate), representation: 'plain_text', content: parentContent, structure: null });
            const authored = authorProposalYjsCandidate({ representation: 'plain_text', sourceUpdate: parentUpdate, targets });
            const ref = (label: string, bytes: Uint8Array) => ({ ref: label, sha256: hash(bytes), sizeBytes: bytes.byteLength });
            const node: ProposalNodeV1 = { contractVersion: 1, proposalId: 'child', operationId: 'operation', scope, casVersion: 1,
              source, relationships: { dependency: { proposalId: 'parent', candidateHash: parentHash }, replacesProposalId: null, choiceGroupId: null },
              authoredCandidate: { incrementalPayload: ref('payload', authored.incrementalPayload),
                cumulativeCandidate: { ...ref('child-candidate', authored.cumulativeCandidate), encoding: 'yjs_full_update_v1' },
                effectPreconditions: ref('witness', authored.effectPreconditions), sourceProofHash: 'f'.repeat(64) },
              lifecycle: 'open', createdAt: 1, createdByActorId: 'agent' };
            const result: Created = { node, reused: false, proposal: { contractVersion: 1, proposalId: node.proposalId,
              operationId: node.operationId, scope, creationKind: 'extends', casVersion: 1,
              candidateHash: node.authoredCandidate.cumulativeCandidate.sha256, source, relationships: node.relationships, reviewRequired: true },
              authoringPreview: { beforeContent: parentContent, proposedContent: authored.content,
                beforeSha256: hash(parentContent), proposedSha256: hash(authored.content) } };
            receipts.set(request.idempotencyKey, result); controls.afterFirst?.(); return result;
          },
          readExact: async (request: { scope: ProposalDocumentScopeV1; proposalId: string | null }) => {
            controls.readIds.push(request.proposalId); assert.deepEqual(request.scope, scope);
            if (request.proposalId !== null && request.proposalId !== 'parent') throw new ProposalGraphContractError('PROPOSAL_SOURCE_INVALID', 'Explicit proposal missing');
            const content = request.proposalId === null ? currentContent : parentContent;
            const selectedUpdate = request.proposalId === null ? Y.encodeStateAsUpdate(live) : parentUpdate;
            const selectedSource: ProposalSourceProofV1 = request.proposalId === null
              ? { kind: 'authoritative', scope, current: source.current,
                snapshot: { ref: 'current-snapshot', sha256: hash(selectedUpdate), sizeBytes: selectedUpdate.byteLength, encoding: 'yjs_full_update_v1' }, anchorMap: source.anchorMap }
              : source;
            return { content, structure: null, metadata: { contractVersion: 1, source: selectedSource, contentSha256: hash(content), graphRevision: 2 },
              sourceStateVector: Buffer.from(Y.encodeStateVectorFromUpdate(selectedUpdate)).toString('base64') };
          },
        } };
      },
    },
  };
  const edits = await compile<typeof import('../app/lib/collaboration/agent-file-edits')>('app/lib/collaboration/agent-file-edits.ts', {});
  mocks['@/app/lib/collaboration/agent-file-edits'] = { ...edits,
    prepareCollaborationTextEdit: async () => ({ ...state, content: currentContent, sha256: hash(currentContent),
      stateVector: Buffer.from(Y.encodeStateVector(live)).toString('base64'), proposedContent: 'Kosten: 20 EUR\n',
      proposedSha256: hash('Kosten: 20 EUR\n'), targets: [], requestedMode: 'review' }),
    prepareCollaborationMarkdownEdit: forbid('prepareCollaborationMarkdownEdit'),
    prepareCollaborationBlockEdit: forbid('prepareCollaborationBlockEdit'), executePreparedCollaborationTextEdit: forbid('executePreparedCollaborationTextEdit'),
    readCurrentCollaborationTextSnapshot: async () => { controls.currentReads++; return { ...state, content: currentContent,
      sha256: hash(currentContent), stateVector: Buffer.from(Y.encodeStateVector(live)).toString('base64') }; },
  };
  const operations = await compile<typeof Operations>('app/lib/pi/agent-file-operations.ts', mocks);
  const call = (method: 'write' | 'edit' | 'patch', proof: unknown = proposal) => {
    const common = { path: 'document.md', expectedSha256: hash(parentContent), proposal: proof as ProposalToolEditV1 };
    if (method === 'write') return operations.writeAgentTextFile({ ...common, content: proposedContent, idempotencyKey: 'facade-write-request' });
    if (method === 'edit') return operations.editAgentFile({ ...common, oldText: '100 EUR', newText: '150 EUR', idempotencyKey: 'facade-edit-request' });
    return operations.applyAgentFilePatch({ files: [{ ...common, edits: [{ oldText: '100 EUR', newText: '150 EUR' }] }], idempotencyKeyPrefix: 'facade-patch-request' }).then((results) => results[0]);
  };
  const callOrdinary = (method: 'write' | 'edit' | 'patch', retryKey = `ordinary-${method}`) => {
    const common = { path: 'document.md', expectedSha256: hash(currentContent) };
    if (method === 'write') return operations.writeAgentTextFile({ ...common,
      content: 'Kosten: 20 EUR\n', idempotencyKey: retryKey });
    if (method === 'edit') return operations.editAgentFile({ ...common,
      oldText: '10 EUR', newText: '20 EUR', idempotencyKey: retryKey });
    return operations.applyAgentFilePatch({ files: [{ ...common, edits: [{ oldText: '10 EUR', newText: '20 EUR' }] }],
      idempotencyKeyPrefix: retryKey }).then((results) => results[0]);
  };
  return { operations, controls, call, callOrdinary, proposal, fullPath, live, parent, receipts, ordinaryReceipts, context,
    close: async () => { live.destroy(); parent.destroy(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('write, edit_file and apply_patch prepare real targets against the explicit parent candidate', async () => {
  for (const method of ['write', 'edit', 'patch'] as const) {
    const h = await facadeHarness();
    try {
      const result = await h.call(method);
      assert.equal(result.proposal?.proposalId, 'child');
      assert.equal(result.proposal?.source.kind, 'proposal');
      assert.equal(result.collaboration?.reviewRequired, true);
      assert.equal(result.changed, false, 'creating a review proposal does not claim a live write');
      assert.equal(result.beforeSha256, hash(parentContent));
      assert.equal(result.collaboration?.proposedSha256, hash(proposedContent));
      assert.deepEqual(h.controls.forwardedProposals, [h.proposal]);
      assert.equal(h.controls.builds, 1);
      assert.equal(h.controls.projectionReads, 0);
      assert.deepEqual(h.controls.legacyCalls, []);
      assert.equal(h.live.getText('content').toString(), currentContent);
      assert.equal(await fs.readFile(h.fullPath, 'utf8'), 'Old disk projection');
    } finally { await h.close(); }
  }
});

test('ordinary write, edit_file and apply_patch create independent graph roots and reuse exact intent after current changes', async () => {
  for (const method of ['write', 'edit', 'patch'] as const) {
    const h = await facadeHarness();
    try {
      h.controls.allowProjectionRead = method === 'write';
      const first = await h.callOrdinary(method);
      assert.equal(first.proposal?.creationKind, 'independent');
      assert.equal(first.proposal?.source.kind, 'authoritative');
      assert.equal(first.proposal?.relationships.dependency, null);
      assert.equal(first.collaboration?.operationStatus, 'needs_review');
      assert.equal(first.collaboration?.reviewRequired, true);
      assert.equal(first.changed, false);
      assert.equal(first.beforeSha256, hash(currentContent));
      assert.equal(first.collaboration?.proposedSha256, hash('Kosten: 20 EUR\n'));
      assert.equal(h.controls.ordinaryBuilds, 1);
      assert.deepEqual(h.controls.legacyCalls, []);
      assert.equal(h.live.getText('content').toString(), currentContent);
      assert.equal(await fs.readFile(h.fullPath, 'utf8'), 'Old disk projection');

      h.live.getText('content').insert(h.live.getText('content').length, 'Peer change\n');
      for (const receipt of h.ordinaryReceipts.values()) receipt.value.node.lifecycle = 'applied';
      const retry = await h.callOrdinary(method);
      assert.equal(retry.proposal?.proposalId, first.proposal?.proposalId);
      assert.equal(retry.proposal?.operationId, first.proposal?.operationId);
      assert.equal(retry.collaboration?.operationStatus, 'applied');
      assert.equal(retry.collaboration?.reviewRequired, false);
      assert.equal(h.controls.ordinaryBuilds, 1, 'a retry must not read or prepare against the newer source');
      assert.equal(h.live.getText('content').toString(), `${currentContent}Peer change\n`);
      assert.equal(await fs.readFile(h.fullPath, 'utf8'), 'Old disk projection');
    } finally { await h.close(); }
  }
});

test('an existing ordinary graph intent remains an exact retry when the graph creation gate closes', async () => {
  const h = await facadeHarness();
  try {
    const first = await h.callOrdinary('edit', 'rollback-retry-key');
    h.controls.enabled = false;
    h.live.getText('content').insert(0, 'Human ');
    const retry = await h.callOrdinary('edit', 'rollback-retry-key');
    assert.equal(retry.proposal?.proposalId, first.proposal?.proposalId);
    assert.equal(retry.collaboration?.operationId, first.collaboration?.operationId);
    assert.equal(h.controls.ordinaryBuilds, 1);
    await assert.rejects(h.operations.editAgentFile({ path: 'document.md', expectedSha256: hash(currentContent),
      oldText: '10 EUR', newText: '30 EUR', idempotencyKey: 'rollback-retry-key' }), errorCode('PROPOSAL_IDEMPOTENCY_MISMATCH'));
    assert.equal(h.controls.ordinaryBuilds, 1);
    assert.deepEqual(h.controls.legacyCalls, []);
    assert.equal(await fs.readFile(h.fullPath, 'utf8'), 'Old disk projection');
  } finally { await h.close(); }
});

test('malformed declared proposal never falls back to the old mutation path', async () => {
  const h = await facadeHarness();
  try {
    for (const method of ['write', 'edit', 'patch'] as const) for (const proof of [null, {}, false]) {
      await assert.rejects(h.call(method, proof), errorCode('PROPOSAL_INVALID_REQUEST'));
    }
    assert.equal(h.controls.factoryCalls, 0); assert.equal(h.controls.creates, 0);
    assert.equal(h.controls.projectionReads, 0); assert.deepEqual(h.controls.legacyCalls, []);
  } finally { await h.close(); }
});

test('rollout disabled rejects explicit proposal reads and all mutation forms before effects', async () => {
  const h = await facadeHarness();
  try {
    h.controls.enabled = false;
    for (const method of ['write', 'edit', 'patch'] as const) await assert.rejects(h.call(method), errorCode('PROPOSAL_UPGRADE_REQUIRED'));
    await assert.rejects(h.operations.readAgentCollaborativeTextFile(h.fullPath, undefined, { proposal: { contractVersion: 1, proposalId: 'parent' } }), errorCode('PROPOSAL_UPGRADE_REQUIRED'));
    assert.equal(h.controls.factoryCalls, 0); assert.equal(h.controls.currentReads, 0);
    assert.equal(h.controls.projectionReads, 0); assert.deepEqual(h.controls.legacyCalls, []);
  } finally { await h.close(); }
});

test('unsupported files cannot downgrade explicit graph mutations or reads to filesystem writes', async () => {
  const h = await facadeHarness();
  try {
    h.controls.supported = false;
    for (const method of ['write', 'edit', 'patch'] as const) await assert.rejects(h.call(method), errorCode('PROPOSAL_UPGRADE_REQUIRED'));
    await assert.rejects(h.operations.readAgentCollaborativeTextFile(h.fullPath, undefined, { proposal: { contractVersion: 1, proposalId: 'parent' } }), errorCode('PROPOSAL_UPGRADE_REQUIRED'));
    assert.equal(h.controls.factoryCalls, 0); assert.equal(h.controls.projectionReads, 0);
    assert.deepEqual(h.controls.legacyCalls, []);
  } finally { await h.close(); }
});

test('multi-file proposal patches reject the entire request before creating the first proposal', async () => {
  const h = await facadeHarness();
  try {
    await assert.rejects(h.operations.applyAgentFilePatch({ files: [
      { path: 'document.md', proposal: h.proposal, edits: [{ oldText: '100 EUR', newText: '150 EUR' }] },
      { path: 'other.md', edits: [{ oldText: 'Before', newText: 'After' }] },
    ], idempotencyKeyPrefix: 'multi-file-request' }), errorCode('PROPOSAL_INVALID_REQUEST'));
    assert.equal(h.controls.creates, 0); assert.equal(h.controls.factoryCalls, 0);
    assert.deepEqual(h.controls.legacyCalls, []);
  } finally { await h.close(); }
});

test('facade retry returns the stored preview without preparing another candidate', async () => {
  const h = await facadeHarness();
  try {
    const first = await h.call('edit');
    h.live.getText('content').insert(0, 'Unrelated current edit.\n');
    const second = await h.call('edit');
    assert.equal(second.proposal?.proposalId, first.proposal?.proposalId);
    assert.equal(second.collaboration?.proposedSha256, first.collaboration?.proposedSha256);
    assert.equal(h.controls.creates, 2); assert.equal(h.controls.builds, 1);
    const expectedKey = 'proposal-tool:d571f33299886ee11acee14fe36dc96de5f489adb78c24bad45759e8c8f99968';
    assert.deepEqual(h.controls.idempotencyKeys, [expectedKey, expectedKey]);
    assert.deepEqual(h.controls.legacyCalls, []);
  } finally { await h.close(); }
});

test('short provider call IDs are stable within one session but cannot collide across sessions', async () => {
  const h = await facadeHarness();
  try {
    const request = { path: 'document.md', proposal: h.proposal, expectedSha256: hash(parentContent),
      oldText: '100 EUR', newText: '150 EUR', idempotencyKey: 'call_0' };
    await h.operations.editAgentFile(request);
    await h.operations.editAgentFile(request);
    assert.equal(h.controls.builds, 1, 'same provider call retry reuses the original candidate');
    h.context.sessionId = 'another-session';
    await h.operations.editAgentFile(request);
    assert.equal(h.controls.builds, 2, 'another session has its own request identity');
    const [first, retry, anotherSession] = h.controls.idempotencyKeys;
    assert.equal(first, retry);
    assert.notEqual(first, anotherSession);
    for (const key of h.controls.idempotencyKeys) {
      assert.match(key, /^proposal-tool:[a-f0-9]{64}$/u, 'short provider IDs become bounded opaque server identities');
      assert.ok(key.length >= 16 && key.length <= 128);
    }
    assert.equal(h.receipts.size, 2);
    assert.deepEqual(h.controls.legacyCalls, []);
  } finally { await h.close(); }
});

test('exact read selector distinguishes authoritative current, named proposal and ordinary legacy read', async () => {
  const h = await facadeHarness();
  try {
    const parent = await h.operations.readAgentCollaborativeTextFile(h.fullPath, undefined, { proposal: { contractVersion: 1, proposalId: 'parent', expectedScope: scope } });
    assert.equal(parent?.content, parentContent); assert.equal(parent?.proposal?.source.kind, 'proposal');
    const current = await h.operations.readAgentCollaborativeTextFile(h.fullPath, undefined, { proposal: { contractVersion: 1, proposalId: null } });
    assert.equal(current?.content, currentContent); assert.equal(current?.proposal?.source.kind, 'authoritative');
    const ordinary = await h.operations.readAgentCollaborativeTextFile(h.fullPath);
    assert.equal(ordinary?.content, currentContent); assert.equal(ordinary?.proposal, undefined);
    await assert.rejects(h.operations.readAgentCollaborativeTextFile(h.fullPath, undefined, { proposal: { contractVersion: 1, proposalId: 'missing-explicit-id' } }), errorCode('PROPOSAL_SOURCE_INVALID'));
    assert.deepEqual(h.controls.readIds, ['parent', null, 'missing-explicit-id']);
    assert.equal(h.controls.currentReads, 1, 'explicit missing ID never falls through to current/latest');
    assert.equal(h.controls.projectionReads, 0);
  } finally { await h.close(); }
});

test('exact read rejects a foreign expected scope before accessing the proposal', async () => {
  const h = await facadeHarness();
  try {
    await assert.rejects(h.operations.readAgentCollaborativeTextFile(h.fullPath, undefined,
      { proposal: { contractVersion: 1, proposalId: 'parent', expectedScope: { ...scope, workspaceId: 'foreign' } } }), errorCode('PROPOSAL_SCOPE_MISMATCH'));
    assert.deepEqual(h.controls.readIds, []); assert.equal(h.controls.currentReads, 0);
  } finally { await h.close(); }
});
