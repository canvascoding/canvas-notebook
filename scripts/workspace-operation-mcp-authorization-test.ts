import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import { createWorkspaceOperationNativeMoveBatchPlan } from '../app/lib/files/workspace-operation-native-move-plan';
import { createWorkspaceOperationNativeDeleteBatchPlan } from '../app/lib/files/workspace-operation-native-delete-plan';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationMcpAuthorization, decodeWorkspaceOperationMcpAuthorization,
  assertWorkspaceOperationMcpAuthorizationCurrent, workspaceOperationMcpBatchId, WorkspaceOperationMcpAuthorizationError,
  type WorkspaceOperationMcpAuthorizationCurrent } from '../app/lib/files/workspace-operation-mcp-authorization';

// Pure actual native producer/decoder/hash tests. Namespace/registry/catalogue
// facts are declared fixture data, not actual SQL, OAuth, rights or owner proof.
// Actual Yjs documents are destroyed after capturing their native bytes.
const workspace: WorkspaceContext = { workspaceId: 'mcp-job-workspace', workspaceType: 'personal',
  rootPath: '/fixture/workspace', rootRelativePath: 'users/user-A/workspace', organizationId: null, customerId: null,
  projectId: null, ownerUserId: 'user-A', legacy: false, status: 'active', permissions: { canRead: true,
    canWrite: true, canDelete: true, canRunAgent: true, canCreatePublicLinks: false, canManageWorkspace: true } };
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
function state(filePath: string, text: string): PersistedCollaborationState {
  const doc = createPlainTextYDoc(text);
  try { return { documentId: `document:${filePath}`, workspaceId: workspace.workspaceId, organizationId: null,
    path: filePath, representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, documentSequence: 7,
    persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc) };
  } finally { doc.destroy(); }
}
const states = [state('target.md', 'Original target'), state('incoming.md', '[Target](target.md)')];
function observation(projection: string | null = null, withCatalogue = true): WorkspaceLinkSourceAuthorityObservation {
  const inventories = states.map(value => inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((value, index) => ({
    expected: { documentId: value.documentId, lineageId: `lineage:${value.path}`, workspaceId: value.workspaceId,
      organizationId: value.organizationId, path: value.path, representation: value.representation, schemaVersion: value.schemaVersion,
      lifecycleGeneration: value.lifecycleGeneration, registryStateVersion: 7, documentSequence: value.documentSequence,
      persistedAt: value.persistedAt, binaryHash: sha(value.yjsState), vectorHash: sha(value.stateVector),
      stateProof: inventories[index].version.stateProof },
    registry: { documentId: value.documentId, lineageId: `lineage:${value.path}`, workspaceId: value.workspaceId,
      workspaceType: 'personal', organizationId: null, customerId: null, projectId: null, path: value.path,
      provider: 'yjs', stateLifecycle: 'initialized', stateVersion: 7, status: 'active' },
    lineage: { lineageId: `lineage:${value.path}`, workspaceId: value.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: value.path, status: 'active', archivedAt: null, trashEntryId: null },
    byteProfile: { newlineStyle: value.newlineStyle, hasBom: value.hasBom }, inventoryProof: nativeLinkJsonProof(inventories[index]),
  }));
  const privateCatalogue: WorkspaceDocumentCatalogueEntry[] = nativeBindings.map(({ expected }) => ({
    id: expected.documentId, lineage_id: expected.lineageId, path: expected.path, workspace_id: expected.workspaceId,
    organization_id: null, status: 'active', state_version: 7, has_persisted_state: true, has_state_history: true,
    lifecycle_generation: 1, authority: 'initialized', state_status: 'active', state_path: expected.path,
    state_workspace_id: expected.workspaceId, state_organization_id: null, yjs_state_lifecycle: 'initialized',
  }));
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: workspace.workspaceId,
    organizationId: null, catalogueProof: nativeLinkJsonProof(withCatalogue ? privateCatalogue : nativeBindings.map(value => value.registry)),
    namespace: states.map(value => ({ workspaceId: value.workspaceId, path: value.path, kind: 'file',
      identity: `registry:${value.documentId}:${value.lifecycleGeneration}`, filesystemIdentity: projection,
      documentId: value.documentId, lifecycleGeneration: value.lifecycleGeneration })),
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: states,
    ...(withCatalogue ? { privateCatalogue } : {}) };
}
function move(destinationPath = 'renamed.md', projection: string | null = null, withCatalogue = true, rename = false) {
  return createWorkspaceOperationNativeMoveBatchPlan({ scope: { workspace, fileOptions: {} }, observation: observation(projection, withCatalogue),
    actions: [{ reviewId: 'fixture-action', kind: rename ? 'rename' : 'move', selections: [{ sourcePath: 'target.md', destinationPath }] }] });
}
function deletion(projection: string | null = null, withCatalogue = true) {
  return createWorkspaceOperationNativeDeleteBatchPlan({ scope: { workspace, fileOptions: {} }, observation: observation(projection, withCatalogue),
    actions: [{ reviewId: 'fixture-action', kind: 'delete', selections: [{ sourcePath: 'target.md' }] }] });
}
const selection = (tool: WorkspaceOperationMcpAuthorizationCurrent['tool']): WorkspaceOperationMcpAuthorizationCurrent => ({
  userId: 'user-A', clientId: 'client-A', sessionId: 'session-A', workspace, tool,
});
const errorCode = (code: WorkspaceOperationMcpAuthorizationError['code']) => (error: unknown): boolean =>
  error instanceof WorkspaceOperationMcpAuthorizationError && error.code === code;
const invalid = errorCode('MCP_JOB_AUTHORIZATION_INVALID'), changed = errorCode('MCP_JOB_AUTHORIZATION_CHANGED');
function rekey(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(rekey);
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).reverse().map(([key, value]) => [key, rekey(value)]));
  return input;
}

export function workspaceOperationMcpAuthorizationTest(): void {
  let passed = 0;
  const check = (name: string, callback: () => void): void => {
    callback(); passed++; console.log(`MCP job authorization case passed: ${name}`);
  };
  check('actual native MoveV3/DeleteV2 and rename plans produce exact detached immutable original data', () => {
    for (const withCatalogue of [false, true]) for (const item of [
      { plan: move('renamed.md', null, withCatalogue), current: selection('move_knowledge_source') },
      { plan: move('renamed.md', null, withCatalogue, true), current: selection('move_knowledge_source') },
      { plan: deletion(null, withCatalogue), current: selection('delete_knowledge_source') },
    ]) {
      const before = structuredClone(item.plan), input = { ...item.current, plan: item.plan };
      const original = createWorkspaceOperationMcpAuthorization(input);
      assert.equal(Reflect.ownKeys(original).length, 11); assert.equal(original.mode, 'direct-mcp'); assert.equal(original.version, 1);
      assert.equal(original.tool, item.current.tool); assert.equal(original.actorType, 'agent');
      assert.equal(original.actorId, `direct-mcp:${sha('client-A').slice(0, 32)}`); assert.equal(original.actorDisplayName, 'MCP client');
      assert.equal(original.actorSessionId, 'session-A'); assert.equal(original.actorUserId, 'user-A');
      assert.deepEqual(original.jobScope, captureWorkspaceOperationJobScope(workspace));
      assert(Object.isFrozen(original)); assert(Object.isFrozen(original.jobScope));
      assert.equal(Reflect.set(original, 'actorSessionId', 'replacement'), false);
      const stored = { ...structuredClone(original) }, decoded = decodeWorkspaceOperationMcpAuthorization(stored);
      stored.actorSessionId = 'changed-after-decode';
      assert.deepEqual(decoded, original); assert.equal(decoded.actorSessionId, 'session-A');
      assert.deepEqual(item.plan, before); assert(!Object.hasOwn(original, 'plan')); assert(!JSON.stringify(original).includes('yjsState'));
    }
    let permissionReads = 0;
    const dataOnly = { ...workspace, status: 'archived' as const };
    Object.defineProperty(dataOnly, 'permissions', { enumerable: true, get() { permissionReads++; throw new Error('NO_RIGHTS_READ'); } });
    assert.doesNotThrow(() => createWorkspaceOperationMcpAuthorization({ ...selection('move_knowledge_source'), workspace: dataOnly, plan: move() }));
    assert.equal(permissionReads, 0, 'Namespace data capture must not pretend to check current rights or lifecycle.');
  });
  check('strict stored shape/literals/IDs/scope reject tampering and legacy authorization', () => {
    const original = createWorkspaceOperationMcpAuthorization({ ...selection('move_knowledge_source'), plan: move() });
    for (const key of Object.keys(original)) {
      const missing: Record<string, unknown> = { ...original }; delete missing[key];
      assert.throws(() => decodeWorkspaceOperationMcpAuthorization(missing), invalid);
      assert.throws(() => decodeWorkspaceOperationMcpAuthorization({ ...original, [key]: undefined }), invalid);
    }
    for (const item of [null, [], Object.create(null), Object.create(original), { ...original, unknown: true },
      { ...original, [Symbol('unknown')]: true }, { ...original, mode: 'direct' }, { ...original, version: 2 },
      { ...original, tool: 'copy_knowledge_source' }, { ...original, actorType: 'user' }, { ...original, actorId: 'client-A' },
      { ...original, actorDisplayName: 'Another client' }, { ...original, requestHash: 'A'.repeat(64) },
      { ...original, requestHash: 'a'.repeat(63) }, { ...original, jobScope: { ...original.jobScope, legacy: true } },
      { ...original, jobScope: { ...original.jobScope, rootRelativePath: null } }]) {
      assert.throws(() => decodeWorkspaceOperationMcpAuthorization(item), invalid);
    }
    for (const key of ['actorUserId', 'clientId', 'actorSessionId']) for (const value of ['', ' x ', 'x'.repeat(257), 'bad\0id', '\ud800', 1]) {
      assert.throws(() => decodeWorkspaceOperationMcpAuthorization({ ...original, [key]: value }), invalid);
    }
    const boundary = createWorkspaceOperationMcpAuthorization({ ...selection('move_knowledge_source'),
      userId: 'u'.repeat(256), clientId: '漢'.repeat(256), sessionId: 's'.repeat(256), plan: move() });
    assert.equal(boundary.clientId, '漢'.repeat(256)); assert.equal(boundary.actorUserId.length, 256);
    for (const candidate of [{ ...workspace, legacy: true }, { ...workspace, rootRelativePath: undefined }]) {
      assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...selection('move_knowledge_source'), workspace: candidate, plan: move() }), invalid);
    }
  });
  check('SID renewal retains all Original-A fields while client/user/tool/scope/full hash must match', () => {
    for (const [tool, nativePlan] of [['move_knowledge_source', move()], ['delete_knowledge_source', deletion()]] as const) {
      const current = selection(tool), original = createWorkspaceOperationMcpAuthorization({ ...current, plan: nativePlan });
      const resumed = assertWorkspaceOperationMcpAuthorizationCurrent(original, { ...current, sessionId: 'session-B' }, nativePlan);
      assert.deepEqual(resumed, original); assert.equal(resumed.actorSessionId, 'session-A');
      const newCapture = createWorkspaceOperationMcpAuthorization({ ...current, sessionId: 'session-B', plan: nativePlan });
      assert.equal(newCapture.requestHash, original.requestHash); assert.equal(newCapture.actorSessionId, 'session-B');
      for (const update of [{ clientId: 'client-B' }, { userId: 'user-B' },
        { tool: tool === 'move_knowledge_source' ? 'delete_knowledge_source' as const : 'move_knowledge_source' as const },
        { workspace: { ...workspace, rootPath: '/different/actual-root' } },
        { workspace: { ...workspace, ownerUserId: 'user-B' } }]) {
        assert.throws(() => assertWorkspaceOperationMcpAuthorizationCurrent(original, { ...current, ...update }, nativePlan), changed);
      }
      assert.throws(() => assertWorkspaceOperationMcpAuthorizationCurrent({ ...original, requestHash: '0'.repeat(64) }, current, nativePlan), changed);
      assert.throws(() => assertWorkspaceOperationMcpAuthorizationCurrent(original, { ...current, sessionId: '' }, nativePlan), invalid);
    }
  });
  check('canonical key order is stable but complete raw historical plan binds even with the same semantic plan ID', () => {
    for (const item of [{ tool: 'move_knowledge_source' as const, first: move('renamed.md', null),
      second: move('renamed.md', '1:9:10:100:100') }, { tool: 'delete_knowledge_source' as const,
      first: deletion(null), second: deletion('1:9:10:100:100') }]) {
      assert.equal(item.first.planIdentityVersion, 2); assert.equal(item.second.planIdentityVersion, 2);
      assert.equal(item.first.planId, item.second.planId); assert.notEqual(item.first.integrityProof, item.second.integrityProof);
      const current = selection(item.tool), original = createWorkspaceOperationMcpAuthorization({ ...current, plan: item.first });
      const reordered = createWorkspaceOperationMcpAuthorization({ ...current, plan: rekey(item.first) });
      assert.equal(reordered.requestHash, original.requestHash);
      assert.deepEqual(assertWorkspaceOperationMcpAuthorizationCurrent(rekey(original), current, rekey(item.first)), original);
      const second = createWorkspaceOperationMcpAuthorization({ ...current, plan: item.second });
      assert.notEqual(second.requestHash, original.requestHash);
      assert.throws(() => assertWorkspaceOperationMcpAuthorizationCurrent(original, current, item.second), changed);
    }
    const first = createWorkspaceOperationMcpAuthorization({ ...selection('move_knowledge_source'), plan: move('first.md') });
    const second = createWorkspaceOperationMcpAuthorization({ ...selection('move_knowledge_source'), plan: move('second.md') });
    assert.notEqual(first.requestHash, second.requestHash);
  });
  check('actual native decoders reject forged identity/integrity, tool mismatches and unsupported legacy plans', () => {
    const nativeMove = move(), nativeDelete = deletion();
    for (const item of [{ current: selection('move_knowledge_source'), nativePlan: nativeMove },
      { current: selection('delete_knowledge_source'), nativePlan: nativeDelete }]) {
      for (const plan of [{ ...item.nativePlan, planId: '0'.repeat(64) }, { ...item.nativePlan, integrityProof: '0'.repeat(64) },
        { ...item.nativePlan, workspaceId: 'wrong-workspace' }, { ...item.nativePlan, unexpected: true },
        { ...item.nativePlan, sourceEvidence: { ...item.nativePlan.sourceEvidence, evidenceProof: '0'.repeat(64) } },
        { version: 1, workspaceId: workspace.workspaceId, planId: 'a'.repeat(64), readiness: 'ready', actions: [] }]) {
        assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...item.current, plan }), invalid);
      }
    }
    assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...selection('move_knowledge_source'), plan: nativeDelete }), invalid);
    assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...selection('delete_knowledge_source'), plan: nativeMove }), invalid);
    assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...selection('move_knowledge_source'), plan: nativeMove,
      workspace: { ...workspace, workspaceId: 'different' } }), invalid);
  });
  check('getters, proxies, hidden/symbol fields and caller toJSON never execute during data capture', () => {
    const nativePlan = move(), current = selection('move_knowledge_source');
    const original = createWorkspaceOperationMcpAuthorization({ ...current, plan: nativePlan });
    let traps = 0;
    const getter = { ...original }; Object.defineProperty(getter, 'clientId', { enumerable: true, get() { traps++; return 'client-A'; } });
    const hidden = { ...original }; Object.defineProperty(hidden, 'clientId', { enumerable: false, value: 'client-A' });
    const proxy = new Proxy(original, { get() { traps++; throw new Error('PROXY_GET'); },
      getPrototypeOf() { traps++; throw new Error('PROXY_PROTO'); }, ownKeys() { traps++; throw new Error('PROXY_KEYS'); } });
    const revoked = Proxy.revocable(original, {}); revoked.revoke();
    for (const input of [getter, hidden, proxy, revoked.proxy, { ...original, jobScope: new Proxy(original.jobScope, {
      getPrototypeOf() { traps++; throw new Error('SCOPE_PROXY'); } }) }]) {
      assert.throws(() => decodeWorkspaceOperationMcpAuthorization(input), invalid);
    }
    const workspaceGetter = { ...workspace }; Object.defineProperty(workspaceGetter, 'rootPath', {
      enumerable: true, get() { traps++; return '/fixture/workspace'; } });
    const planGetter = { ...nativePlan }; Object.defineProperty(planGetter, 'planId', { enumerable: true,
      get() { traps++; return nativePlan.planId; } });
    const buildGetter = { ...current, plan: nativePlan }; Object.defineProperty(buildGetter, 'plan', { enumerable: true,
      get() { traps++; return nativePlan; } });
    for (const input of [buildGetter, { ...current, workspace: workspaceGetter, plan: nativePlan },
      { ...current, workspace: new Proxy(workspace, { getPrototypeOf() { traps++; throw new Error('WORKSPACE_PROXY'); } }), plan: nativePlan },
      { ...current, plan: planGetter }, { ...current, plan: new Proxy(nativePlan, { ownKeys() { traps++; throw new Error('PLAN_PROXY'); } }) },
      { ...current, plan: { ...nativePlan, toJSON() { traps++; return nativePlan; } } }, { ...current, plan: nativePlan, unknown: true }]) {
      assert.throws(() => createWorkspaceOperationMcpAuthorization(input), invalid);
    }
    assert.equal(traps, 0);
    const before = JSON.stringify(original), mutable = structuredClone(workspace);
    const created = createWorkspaceOperationMcpAuthorization({ ...current, workspace: mutable, plan: structuredClone(nativePlan) });
    mutable.rootPath = '/later'; assert.equal(JSON.stringify(created), before);
  });
  check('shared plan capture stops excessive depth/bytes and never mutates cyclic or oversized caller objects', () => {
    const current = selection('move_knowledge_source');
    let nested: unknown = 0; for (let depth = 0; depth < 42; depth++) nested = { child: nested };
    assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...current, plan: nested }), errorCode('MCP_JOB_AUTHORIZATION_TOO_LARGE'));
    const oversized = { payload: 'x'.repeat(16 * 1024 * 1024 + 1) };
    assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...current, plan: oversized }), errorCode('MCP_JOB_AUTHORIZATION_TOO_LARGE'));
    assert.equal(oversized.payload.length, 16 * 1024 * 1024 + 1);
    const cyclic: { child?: unknown } = {}; cyclic.child = cyclic;
    assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...current, plan: cyclic }), errorCode('MCP_JOB_AUTHORIZATION_TOO_LARGE'));
    assert.equal(cyclic.child, cyclic);
    const bytes = Uint8Array.of(1, 2, 3);
    assert.throws(() => createWorkspaceOperationMcpAuthorization({ ...current, plan: { bytes } }), invalid);
    assert.deepEqual(bytes, Uint8Array.of(1, 2, 3));
  });
  check('batch namespace is deterministic, separates client/user/workspace/tool and preserves the caller key exactly', () => {
    const input = { userId: 'user-A', clientId: 'client-A', workspaceId: workspace.workspaceId,
      tool: 'move_knowledge_source' as const, operationId: 'Operation_Key_0001' };
    const expected = sha('["workspace-path-operation-direct-mcp-id-v1","user-A","client-A","mcp-job-workspace","move_knowledge_source","Operation_Key_0001"]');
    assert.equal(workspaceOperationMcpBatchId(input), expected); assert.match(expected, /^[a-f0-9]{64}$/u);
    const variants = [{ ...input, userId: 'user-B' }, { ...input, clientId: 'client-B' },
      { ...input, workspaceId: 'workspace-B' }, { ...input, tool: 'delete_knowledge_source' as const },
      { ...input, operationId: 'operation_Key_0001' }];
    assert.equal(new Set([expected, ...variants.map(workspaceOperationMcpBatchId)]).size, 6);
    for (const operationId of ['A'.repeat(16), '_'.repeat(128), '-'.repeat(128)]) assert.match(workspaceOperationMcpBatchId({ ...input, operationId }), /^[a-f0-9]{64}$/u);
    for (const operationId of ['', 'a'.repeat(15), 'a'.repeat(129), ' Operation_Key_0001', 'Operation_Key_0001 ',
      'Operation.Key_0001', 'Operation/Key_0001', 'Operation_Key_0001\n', '漢'.repeat(16)]) {
      assert.throws(() => workspaceOperationMcpBatchId({ ...input, operationId }), invalid);
    }
    let reads = 0; const accessor = { ...input }; Object.defineProperty(accessor, 'operationId', { enumerable: true,
      get() { reads++; return input.operationId; } });
    assert.throws(() => workspaceOperationMcpBatchId(accessor), invalid); assert.equal(reads, 0);
    const extra = { ...input, sessionId: 'session-A' }; assert.throws(() => workspaceOperationMcpBatchId(extra), invalid);
    const failure = (() => { try { workspaceOperationMcpBatchId({ ...input, operationId: 'short' }); } catch (error) { return error; } })();
    assert(failure instanceof WorkspaceOperationMcpAuthorizationError); assert.equal(failure.status, 400);
  });
  assert.equal(passed, 8);
  console.log(JSON.stringify({ test: 'workspace-operation-mcp-authorization', groups: passed,
    claim: 'pure-data-native-producer-decoder-only; no PG, rights, OAuth, OriginalOwner or file effects' }));
}
workspaceOperationMcpAuthorizationTest();
