import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import type { WorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationNativeSourceEvidence, decodeWorkspaceOperationNativeSourceEvidence,
  assertWorkspaceOperationNativeSourceEvidenceCurrent, WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';

type Mutable<T> = T extends Uint8Array ? T : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type MutableObservation = Mutable<WorkspaceLinkSourceAuthorityObservation>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const scope: WorkspaceOperationJobScope = { version: 1, workspaceId: 'evidence-workspace', workspaceType: 'project',
  organizationId: 'evidence-org', customerId: 'evidence-customer', projectId: 'evidence-project', ownerUserId: null,
  rootPath: '/owned/data/workspaces/evidence-workspace', rootRelativePath: 'workspaces/evidence-workspace', legacy: false };
const variants = ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const;
function stateFor(doc: InstanceType<typeof Y.Doc>, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  return { documentId: 'native-D1', workspaceId: scope.workspaceId, organizationId: scope.organizationId, path: 'folder/ leading.bin',
    representation, lifecycleGeneration: 2, schemaVersion: COLLABORATION_SCHEMA_VERSION, yjsState: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc), documentSequence: 7, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null,
    canonicalHash: null, serializedHash: null, newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'active' };
}
function observation(state: PersistedCollaborationState): MutableObservation {
  const inventory = inspectPersistedDocumentLinks(state);
  const expected = { ...inventory.document, lineageId: `lineage:${state.documentId}`, registryStateVersion: 3,
    documentSequence: state.documentSequence, persistedAt: state.persistedAt, stateProof: inventory.version.stateProof,
    binaryHash: hash(state.yjsState), vectorHash: hash(state.stateVector) };
  const binding: WorkspaceNativeSourceBinding = { expected, registry: { documentId: state.documentId, lineageId: expected.lineageId,
    workspaceId: scope.workspaceId, workspaceType: scope.workspaceType, organizationId: scope.organizationId,
    customerId: null, projectId: scope.projectId, path: state.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: 3, status: 'active' },
  lineage: { lineageId: expected.lineageId, workspaceId: scope.workspaceId, workspaceType: scope.workspaceType, organizationId: scope.organizationId,
    customerId: scope.customerId, projectId: null, path: state.path, status: 'active', archivedAt: null, trashEntryId: null },
  byteProfile: { newlineStyle: state.newlineStyle, hasBom: state.hasBom }, inventoryProof: nativeLinkJsonProof(inventory) };
  const stageBody = { stageVersion: 1 as const, workspaceId: scope.workspaceId, organizationId: scope.organizationId,
    catalogueProof: 'a'.repeat(64), namespace: [
      { workspaceId: scope.workspaceId, path: 'folder', kind: 'directory' as const, identity: '1:2:4096:100.25:100.5',
        filesystemIdentity: '1:2:4096:100.25:100.5', documentId: null, lifecycleGeneration: null },
      { workspaceId: scope.workspaceId, path: state.path, kind: 'file' as const, identity: `registry:${state.documentId}:${state.lifecycleGeneration}`,
        filesystemIdentity: '1:4:0:100:100', documentId: state.documentId, lifecycleGeneration: state.lifecycleGeneration },
      { workspaceId: scope.workspaceId, path: 'asset.png', kind: 'file' as const, identity: '1:5:7:100:100',
        filesystemIdentity: '1:5:7:100:100', documentId: null, lifecycleGeneration: null },
    ], sources: [{ kind: 'native' as const, inventory }], scope: { kind: 'visible-workspace' as const, excludedPaths: ['.git'] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required' as const, executionReady: false as const };
  return { stage: { ...stageBody, stageProof: workspaceSourceAuthorityStageProof(stageBody) }, nativeBindings: [binding], privateNativeStates: [state] } as MutableObservation;
}
function fixture(representation: PersistedCollaborationState['representation'] = 'plain_text', text = '---\naliases: [Alias]\n---\n\n# Heading 😀\n\n[Target](/notebook?path=%20target.bin#Part%2520)') {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try { return observation(stateFor(doc, representation)); } finally { doc.destroy(); }
}
function refresh(value: MutableObservation): void { value.stage.stageProof = workspaceSourceAuthorityStageProof(value.stage); }
function invalid(operation: () => unknown, code = 'NATIVE_SOURCE_EVIDENCE_INVALID'): void {
  assert.throws(operation, error => error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === code && error.status === 409);
}

test('actual Plain/XML/Blocks inventory, scopes and exact names roundtrip as frozen JSON facts without private native bytes', () => {
  for (const representation of variants) {
    const input = fixture(representation), before = structuredClone(input);
    const evidence = captureWorkspaceOperationNativeSourceEvidence(scope, input);
    assert.deepEqual(decodeWorkspaceOperationNativeSourceEvidence(JSON.parse(JSON.stringify(evidence))), evidence);
    assert.equal(Object.isFrozen(evidence.stage.sources[0].inventory.links[0].ref), true);
    assert.equal(evidence.stage.sources[0].inventory.parserVersion, 2);
    assert.equal(evidence.nativeBindings[0].expected.path, 'folder/ leading.bin');
    assert.equal(JSON.stringify(evidence).includes('yjsState'), false);
    assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, input, scope); assert.deepEqual(input, before);
  }
});

test('rehashed omitted or changed backlinks cannot replace the inventory actually derived from native binary', () => {
  for (const representation of variants) {
    const input = fixture(representation), inventory = input.stage.sources[0].inventory;
    inventory.links.length = 0;
    input.nativeBindings = [{ ...input.nativeBindings[0], inventoryProof: nativeLinkJsonProof(inventory) }]; refresh(input);
    invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input));
  }
});

test('actual Wiki/image atoms, XML membership anchors and Buffer-backed PG bytes retain their native reference forms', () => {
  for (const representation of variants) {
    const input = fixture(representation, '[[Alias]]\n\n![Image](asset.png)');
    input.privateNativeStates[0].yjsState = Buffer.from(input.privateNativeStates[0].yjsState);
    input.privateNativeStates[0].stateVector = Buffer.from(input.privateNativeStates[0].stateVector);
    const evidence = captureWorkspaceOperationNativeSourceEvidence(scope, input), links = evidence.stage.sources[0].inventory.links;
    assert.equal(links.length, 2);
    assert.equal(links.every(link => link.ref.kind === (representation === 'plain_text' ? 'plain-target' : 'node-attribute')), true);
    if (representation === 'tiptap_xml') assert.equal(links.every(link => link.ref.kind === 'node-attribute' && link.ref.membershipAnchor !== null), true);
  }
});

test('deletion-only Yjs changes keep their vector but cannot inherit the prior state/inventory proof', () => {
  const doc = createPlainTextYDoc('[Target](target.md)');
  try {
    const first = stateFor(doc, 'plain_text'), input = observation(first);
    doc.getText('content').delete(0, 1); const deleted = stateFor(doc, 'plain_text');
    assert.deepEqual(deleted.stateVector, first.stateVector); assert.notEqual(hash(deleted.yjsState), hash(first.yjsState));
    input.privateNativeStates = [deleted];
    input.nativeBindings = [{ ...input.nativeBindings[0], expected: { ...input.nativeBindings[0].expected, binaryHash: hash(deleted.yjsState) } }];
    invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input));
    const fresh = captureWorkspaceOperationNativeSourceEvidence(scope, observation(deleted));
    assert.notEqual(fresh.nativeBindings[0].expected.stateProof, input.nativeBindings[0].expected.stateProof);
  } finally { doc.destroy(); }
});

test('scope fields and exact DTOs reject extras, malformed paths, aliases, unsupported clocks and altered namespaces', () => {
  const input = fixture();
  const changes = [{ extra: true }, { rootPath: 'relative/root' }, { rootPath: '/owned/../elsewhere' }, { rootRelativePath: null },
    { rootRelativePath: '../elsewhere' }, { workspaceId: 'evidence-workspace\0' }, { organizationId: 'other-org' }, { legacy: true },
    { workspaceType: 'unsupported' }, { version: -0 }];
  for (const change of changes) invalid(() => captureWorkspaceOperationNativeSourceEvidence({ ...scope, ...change } as WorkspaceOperationJobScope, input));
  for (const change of [
    (value: MutableObservation) => { Object.assign(value.stage, { hidden: true }); },
    (value: MutableObservation) => { Object.assign(value.nativeBindings[0].expected, { hidden: true }); },
    (value: MutableObservation) => { value.nativeBindings[0].expected.schemaVersion++; },
    (value: MutableObservation) => { value.nativeBindings[0].registry.workspaceType = 'team'; },
    (value: MutableObservation) => { value.nativeBindings[0].registry.stateVersion = Number.MAX_SAFE_INTEGER; },
    (value: MutableObservation) => { value.stage.namespace[1].path = 'folder/leading.bin'; },
    (value: MutableObservation) => { value.stage.namespace[1].identity = 'invented-native-identity'; },
    (value: MutableObservation) => { value.stage.namespace[1].documentId = 'D2'; },
    (value: MutableObservation) => { value.stage.namespace[2].filesystemIdentity = null; },
    (value: MutableObservation) => { value.stage.namespace.shift(); },
    (value: MutableObservation) => { value.stage.namespace.push({ ...value.stage.namespace[2] }); },
  ]) {
    const changed = structuredClone(input); change(changed); refresh(changed); invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, changed));
  }
});

test('complete native-only coverage never hides an uninspected physical Markdown, MDX or HTML source', () => {
  for (const extension of ['md', 'markdown', 'html', 'htm', 'mdx']) {
    const input = fixture(); input.stage.namespace[2].path = `physical.${extension}`; refresh(input);
    invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input), 'NATIVE_SOURCE_IMPORT_REQUIRED');
  }
  const input = fixture();
  Object.assign(input.stage.sources[0], { kind: 'physical' });
  invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input), 'NATIVE_SOURCE_IMPORT_REQUIRED');
});

test('semantic comparison ignores only native projection and directory volatility, preserving device/inode and physical asset facts', () => {
  const input = fixture(), evidence = captureWorkspaceOperationNativeSourceEvidence(scope, input), current = structuredClone(input);
  current.stage.namespace[0].identity = current.stage.namespace[0].filesystemIdentity = '1:2:8192:300.75:400.5';
  current.stage.namespace[1].filesystemIdentity = '9:999:300:300:400'; refresh(current);
  assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, current, scope);
  for (const [index, identity] of [[0, '2:2:8192:300:400'], [0, '1:3:8192:300:400'], [2, '1:5:8:100:100'],
    [2, '1:6:7:100:100'], [2, '2:5:7:100:100'], [2, '1:5:7:101:100']] as const) {
    const changed = structuredClone(input); changed.stage.namespace[index].identity = changed.stage.namespace[index].filesystemIdentity = identity; refresh(changed);
    invalid(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, changed, scope), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
  }
  const changed = structuredClone(input); changed.nativeBindings = [{ ...changed.nativeBindings[0], lineage: { ...changed.nativeBindings[0].lineage, trashEntryId: 'old-trash' } }];
  invalid(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, changed, scope), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
});

test('registry-only parent directories remain namespace facts with no invented filesystem identity', () => {
  const input = fixture(); input.stage.namespace[0].filesystemIdentity = null;
  input.stage.namespace[0].identity = `registry-directory:${nativeLinkJsonProof({ workspaceId: scope.workspaceId, path: 'folder' })}`;
  input.stage.namespace[1].filesystemIdentity = null; refresh(input);
  const evidence = captureWorkspaceOperationNativeSourceEvidence(scope, input);
  assert.equal(evidence.stage.namespace[0].filesystemIdentity, null);
  const changed = structuredClone(input); changed.stage.namespace[0].identity = 'registry-directory:invented'; refresh(changed);
  invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, changed));
  const phantom = structuredClone(input); phantom.stage.namespace.push({ ...phantom.stage.namespace[0], path: 'phantom',
    identity: `registry-directory:${nativeLinkJsonProof({ workspaceId: scope.workspaceId, path: 'phantom' })}` }); refresh(phantom);
  invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, phantom));
});

test('accessors at observation, DTO, array or private-state boundaries are rejected without invoking them', () => {
  for (const boundary of ['observation', 'dto', 'array', 'private-state', 'binary-property'] as const) {
    const input = fixture(); let calls = 0;
    if (boundary === 'observation') Object.defineProperty(input, 'stage', { enumerable: true, get: () => { calls++; return fixture().stage; } });
    if (boundary === 'dto') Object.defineProperty(input.stage.namespace[1], 'path', { enumerable: true, get: () => { calls++; return 'wrong'; } });
    if (boundary === 'array') Object.defineProperty(input.nativeBindings, '0', { enumerable: true, get: () => { calls++; return null; } });
    if (boundary === 'private-state') Object.defineProperty(input.privateNativeStates[0], 'yjsState', { enumerable: true, get: () => { calls++; return new Uint8Array([0]); } });
    if (boundary === 'binary-property') Object.defineProperty(input.privateNativeStates[0].yjsState, 'byteLength', { get: () => { calls++; return 1; } });
    invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input)); assert.equal(calls, 0, boundary);
  }
});

test('bounded JSON rejects escaping amplification, excessive nesting, cyclic/custom values and normalized Unicode', () => {
  const evidence = captureWorkspaceOperationNativeSourceEvidence(scope, fixture());
  for (const value of [undefined, null, new Date(), new Uint8Array([0]), Object.create(null),
    new Proxy({}, { getPrototypeOf() { throw undefined; } })]) invalid(() => decodeWorkspaceOperationNativeSourceEvidence(value));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; invalid(() => decodeWorkspaceOperationNativeSourceEvidence(cyclic));
  const invalidUnicode = structuredClone(evidence); invalidUnicode.stage.namespace[1].path = '\ud800'; invalid(() => decodeWorkspaceOperationNativeSourceEvidence(invalidUnicode));
  const large = { text: '\0'.repeat(1_500_000) }; invalid(() => decodeWorkspaceOperationNativeSourceEvidence(large), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  let nested: unknown = null; for (let index = 0; index < 34; index++) nested = { value: nested };
  invalid(() => decodeWorkspaceOperationNativeSourceEvidence(nested), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
});

test('actual native byte/vector limits are enforced before hashing or decoding even with matching oversized claims', () => {
  for (const [key, length] of [['yjsState', 16 * 1024 * 1024 + 1], ['stateVector', 1024 * 1024 + 1]] as const) {
    const input = fixture(); input.privateNativeStates[0][key] = new Uint8Array(length);
    invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  }
  const input = fixture();
  input.privateNativeStates = [...input.privateNativeStates, input.privateNativeStates[0]];
  invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input));
  const shared = fixture(); shared.privateNativeStates[0].yjsState = new Uint8Array(new SharedArrayBuffer(20));
  invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, shared));
  const aggregate = fixture('plain_text', 'Text');
  const second = structuredClone(aggregate);
  second.privateNativeStates[0].documentId = 'native-D2'; second.privateNativeStates[0].path = 'folder/second.bin';
  const rebound = observation(second.privateNativeStates[0]);
  aggregate.stage.sources.push(rebound.stage.sources[0]); aggregate.nativeBindings.push(rebound.nativeBindings[0]);
  aggregate.stage.namespace.push(rebound.stage.namespace[1]); aggregate.privateNativeStates.push(second.privateNativeStates[0]); refresh(aggregate);
  for (const state of aggregate.privateNativeStates) state.yjsState = new Uint8Array(16 * 1024 * 1024);
  // Both buffers satisfy the individual limit; their vectors exceed the whole
  // private-state budget before any hash or Yjs decode can run.
  invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, aggregate), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
});

test('binary/vector, lifecycle, diagnostics and quarantined private state cannot be adopted from a matching DTO', () => {
  for (const change of [{ status: 'archived' }, { path: 'folder/leading.bin' }, { documentId: 'D2' }, { organizationId: 'other-org' },
    { schemaVersion: 999 }, { lifecycleGeneration: 3 }, { documentSequence: 8 }, { persistedAt: 101 }, { checkpointSequence: 8 },
    { degraded: '0' }, { hasBom: '0' }, { checkpointedAt: -1 }, { projectionError: { code: 'permanent', sequence: 7, permanent: true } },
    { degraded: true }, { stateVector: new Uint8Array([0]) }, { yjsState: new Uint8Array([0]) }]) {
    const input = fixture(); Object.assign(input.privateNativeStates[0], change);
    invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input));
  }
  const input = fixture(); input.privateNativeStates[0].projectionError = { code: 'COLLABORATION_YJS_PERSISTENCE_FAILED', sequence: 7, permanent: false };
  input.privateNativeStates[0].degraded = true;
  assert.equal(captureWorkspaceOperationNativeSourceEvidence(scope, input).nativeBindings.length, 1);
  input.privateNativeStates[0].projectionError.phase = '';
  assert.equal(captureWorkspaceOperationNativeSourceEvidence(scope, input).nativeBindings.length, 1, 'An existing empty phase is not a new quarantine rule.');
});

test('unknown raw native schema and unintegrated updates fail without rewriting the original state', () => {
  const doc = createRichMarkdownYDoc('Exact', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions())), blockId = [...tree.records.keys()][0];
    tree.move({ blockId, parentId: null, beforeId: null, operationId: 'evidence-move' }, 'fixture');
    const input = observation(stateFor(doc, 'tiptap_blocks')), operation = tree.operations.get('evidence-move'); assert(operation);
    tree.operations.set(operation.id, { ...operation, futureField: 'hidden' }); const changed = stateFor(doc, 'tiptap_blocks');
    // Visible JSON/inventory cannot certify hidden operation-schema fields.
    assert.equal(inspectPersistedDocumentLinks(changed).coverage.complete, true);
    input.privateNativeStates = [changed]; input.nativeBindings = [{ ...input.nativeBindings[0], expected: {
      ...input.nativeBindings[0].expected, binaryHash: hash(changed.yjsState), stateProof: inspectPersistedDocumentLinks(changed).version.stateProof },
    inventoryProof: nativeLinkJsonProof(inspectPersistedDocumentLinks(changed)) }];
    input.stage.sources[0].inventory = inspectPersistedDocumentLinks(changed); refresh(input);
    const before = Uint8Array.from(changed.yjsState); invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input)); assert.deepEqual(changed.yjsState, before);
  } finally { doc.destroy(); }
  const input = fixture(), pending = createPlainTextYDoc('base');
  try {
    const vector = Y.encodeStateVector(pending); pending.getText('content').insert(4, ' dependent');
    const update = Y.encodeStateAsUpdate(pending, vector); input.privateNativeStates[0].yjsState = update;
    input.nativeBindings = [{ ...input.nativeBindings[0], expected: { ...input.nativeBindings[0].expected, binaryHash: hash(update) } }];
    invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, input));
  } finally { pending.destroy(); }
});

test('legal nonexportable rich content is native evidence without exporting or normalizing its binary', () => {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| [Target](target.bin) |', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
    }
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const state = stateFor(doc, 'tiptap_blocks'), before = Uint8Array.from(state.yjsState), input = observation(state);
    state.projectionError = { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', sequence: 7, permanent: false };
    assert.equal(captureWorkspaceOperationNativeSourceEvidence(scope, input).stage.sources[0].inventory.coverage.complete, true);
    assert.deepEqual(state.yjsState, before);
  } finally { doc.destroy(); }
});

test('proof tampering, old parser evidence and hidden DTO fields never become freshly current facts', () => {
  const evidence = captureWorkspaceOperationNativeSourceEvidence(scope, fixture());
  for (const change of [{ evidenceProof: 'b'.repeat(64) }, { semanticProof: 'b'.repeat(64) }, { unrecognized: true }]) {
    const changed = { ...structuredClone(evidence), ...change };
    if ('unrecognized' in change) { const { evidenceProof: _old, ...body } = changed; changed.evidenceProof = nativeLinkJsonProof(body); }
    invalid(() => decodeWorkspaceOperationNativeSourceEvidence(changed));
  }
  const old = fixture(); old.stage.sources[0].inventory.parserVersion = 1;
  old.nativeBindings = [{ ...old.nativeBindings[0], inventoryProof: nativeLinkJsonProof(old.stage.sources[0].inventory) }]; refresh(old);
  invalid(() => captureWorkspaceOperationNativeSourceEvidence(scope, old));
});
