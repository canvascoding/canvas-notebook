import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationNativeSourceEvidence, captureWorkspaceOperationNativeSourceEvidenceV2,
  decodeWorkspaceOperationNativeSourceEvidence, assertWorkspaceOperationNativeSourceEvidenceCurrent,
  WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';

// Actual Yjs snapshots, link inspection and existing C1/Stage fixture. Catalogue
// and filesystem observations are pure declared data, never current DB/ACL,
// lifecycle, mutation or publication authority.
type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type Row = WorkspaceDocumentCatalogueEntry;
type Observation = Mutable<WorkspaceLinkSourceAuthorityObservation> & { privateCatalogue: Row[] };
type Fixture = { scope: WorkspaceOperationJobScope; observation: Observation };
type Evidence = ReturnType<typeof captureWorkspaceOperationNativeSourceEvidenceV2>;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const errorCode = (code: WorkspaceOperationNativeSourceEvidenceError['code']) => (error: unknown) =>
  error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === code && error.status === 409;
const invalid = errorCode('NATIVE_SOURCE_EVIDENCE_INVALID');
const changed = errorCode('NATIVE_SOURCE_EVIDENCE_CHANGED');
const tooLarge = errorCode('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');

function catalogueRow(binding: WorkspaceNativeSourceBinding): Row {
  const expected = binding.expected;
  return { id: expected.documentId, lineage_id: expected.lineageId, path: expected.path,
    workspace_id: expected.workspaceId, organization_id: expected.organizationId, status: 'active',
    state_version: expected.registryStateVersion, yjs_state_lifecycle: 'initialized', has_persisted_state: true,
    has_state_history: true, lifecycle_generation: expected.lifecycleGeneration, authority: 'initialized',
    state_status: 'active', state_path: expected.path, state_workspace_id: expected.workspaceId,
    state_organization_id: expected.organizationId };
}
function pristine(scope: WorkspaceOperationJobScope, index = 0): Row {
  return { id: `asset-${index}`, lineage_id: `asset-lineage-${index}`, path: index ? `assets/extra-${index}.bin` : 'assets/report.pdf',
    workspace_id: scope.workspaceId, organization_id: scope.organizationId, status: 'active', state_version: 0,
    yjs_state_lifecycle: 'never_initialized', has_persisted_state: false, has_state_history: false,
    lifecycle_generation: null, authority: 'pristine', state_status: null, state_path: null,
    state_workspace_id: null, state_organization_id: null };
}
function refresh(observation: Observation): void {
  observation.stage.catalogueProof = proof(observation.privateCatalogue);
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
}
function fixture(representation: PersistedCollaborationState['representation'] = 'plain_text'): Fixture {
  const original = nativeCopyMetadataFixture(representation), evidence = original.plan.sourceEvidence;
  const scope = evidence.workspaceScope, nativeBindings = clone(evidence.nativeBindings);
  for (const binding of nativeBindings) {
    binding.expected.registryStateVersion = 6; binding.registry.stateVersion = 6;
  }
  const privateNativeStates = clone(original.nativeRecords.filter(record => record.state.workspaceId === scope.workspaceId).map(record => record.state));
  const missing: Row = { ...pristine(scope, 99_999), id: 'missing-state-document', lineage_id: 'missing-state-lineage',
    path: 'missing-state.bin', state_version: 2, yjs_state_lifecycle: 'legacy_unknown', has_state_history: true,
    authority: 'missing-state' };
  const observation: Observation = { stage: clone(evidence.stage), nativeBindings, privateNativeStates,
    privateCatalogue: [...nativeBindings.map(catalogueRow), pristine(scope), missing].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) };
  observation.stage.namespace.push({ workspaceId: scope.workspaceId, path: 'assets', kind: 'directory',
    identity: '1:30:4096:100:100', filesystemIdentity: '1:30:4096:100:100', documentId: null, lifecycleGeneration: null },
  { workspaceId: scope.workspaceId, path: 'assets/report.pdf', kind: 'file', identity: '1:31:3:100:100',
    filesystemIdentity: '1:31:3:100:100', documentId: null, lifecycleGeneration: null });
  refresh(observation); return { scope, observation };
}
function withoutWitness(observation: Observation): WorkspaceLinkSourceAuthorityObservation {
  return { stage: observation.stage, nativeBindings: observation.nativeBindings, privateNativeStates: observation.privateNativeStates };
}
function project(original: Observation): Observation {
  const result = clone(original);
  for (const binding of result.nativeBindings) {
    binding.expected.registryStateVersion = 7; binding.registry.stateVersion = 7;
    result.privateCatalogue.find(row => row.id === binding.expected.documentId)!.state_version = 7;
  }
  result.stage.namespace.forEach((entry, index) => {
    if (entry.documentId !== null) entry.filesystemIdentity = `2:${200 + index}:180:400:401`;
    if (entry.path === 'assets') entry.identity = entry.filesystemIdentity = '1:30:8192:500:501';
  });
  for (const state of result.privateNativeStates) {
    state.checkpointSequence = 7; state.checkpointedAt = 200;
    state.canonicalHash = 'a'.repeat(64); state.serializedHash = 'b'.repeat(64);
  }
  refresh(result); return result;
}
function capture(input: Fixture): Evidence { return captureWorkspaceOperationNativeSourceEvidenceV2(input.scope, input.observation); }
function assertFreshChanged(original: Evidence, input: Fixture): void {
  const fresh = capture(input); assert.notEqual(fresh.semanticProof, original.semanticProof);
  assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(original, input.observation, input.scope), changed);
}
function replaceNative(observation: Observation, index: number, state: PersistedCollaborationState): void {
  const old = observation.nativeBindings[index], previousId = old.expected.documentId;
  const inventory = inspectPersistedDocumentLinks(state), lineageId = state.documentId === previousId
    ? old.expected.lineageId : `lineage:${state.documentId}`;
  const binding: Mutable<WorkspaceNativeSourceBinding> = { ...clone(old), expected: { ...clone(old.expected),
    documentId: state.documentId, lineageId, workspaceId: state.workspaceId, organizationId: state.organizationId,
    path: state.path, representation: state.representation, schemaVersion: state.schemaVersion,
    lifecycleGeneration: state.lifecycleGeneration, documentSequence: state.documentSequence, persistedAt: state.persistedAt,
    stateProof: inventory.version.stateProof, binaryHash: hash(state.yjsState), vectorHash: hash(state.stateVector) },
    registry: { ...clone(old.registry), documentId: state.documentId, lineageId, path: state.path },
    lineage: { ...clone(old.lineage), lineageId, path: state.path },
    byteProfile: { newlineStyle: state.newlineStyle, hasBom: state.hasBom }, inventoryProof: proof(inventory) };
  observation.nativeBindings[index] = binding; observation.privateNativeStates[index] = clone(state);
  const sourceIndex = observation.stage.sources.findIndex(source => source.kind === 'native' && source.inventory.document.documentId === previousId);
  assert(sourceIndex >= 0); observation.stage.sources[sourceIndex] = { kind: 'native', inventory };
  const entry = observation.stage.namespace.find(value => value.documentId === previousId); assert(entry);
  entry.documentId = state.documentId; entry.path = state.path; entry.lifecycleGeneration = state.lifecycleGeneration;
  entry.identity = `registry:${state.documentId}:${state.lifecycleGeneration}`;
  const rowIndex = observation.privateCatalogue.findIndex(row => row.id === previousId); assert(rowIndex >= 0);
  observation.privateCatalogue[rowIndex] = catalogueRow(binding); refresh(observation);
}
/** Independent V1 wire-contract oracle: original full catalogue and registry
 * clocks stay in the semantic body, and every raw field stays in evidenceProof. */
function legacyWire(input: Fixture) {
  const { stageProof: _historical, namespace, ...stage } = input.observation.stage;
  const semantic = { workspaceScope: input.scope, stage: { ...stage, namespace: namespace.map(entry => {
    if (entry.kind === 'file' && entry.documentId !== null) return { ...entry, filesystemIdentity: null };
    if (entry.kind === 'directory' && entry.filesystemIdentity !== null) {
      const [device, inode] = entry.filesystemIdentity.split(':');
      return { ...entry, identity: `directory:${device}:${inode}`, filesystemIdentity: null };
    }
    return entry;
  }) }, nativeBindings: input.observation.nativeBindings };
  const body = { evidenceVersion: 1, workspaceScope: input.scope, stage: input.observation.stage,
    nativeBindings: input.observation.nativeBindings, semanticProof: proof(semantic) };
  return { ...body, evidenceProof: proof(body) };
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: V2 permits coherent checkpoint 6→7 and replaceable projections while preserving raw evidence and inputs`, () => {
    const original = fixture(representation), updated: Fixture = { scope: original.scope, observation: project(original.observation) };
    const before = clone(original), after = clone(updated), first = capture(original), second = capture(updated);
    assert.equal(first.evidenceVersion, 2); assert.equal(second.evidenceVersion, 2);
    assert.notEqual(first.stage.catalogueProof, second.stage.catalogueProof);
    assert.notEqual(first.evidenceProof, second.evidenceProof);
    assert.equal(first.semanticCatalogueProof, second.semanticCatalogueProof); assert.equal(first.semanticProof, second.semanticProof);
    const { evidenceProof: rawProof, ...rawBody } = first; assert.equal(proof(rawBody), rawProof);
    assert.equal(first.nativeBindings[0].expected.registryStateVersion, 6); assert.equal(second.nativeBindings[0].expected.registryStateVersion, 7);
    assertWorkspaceOperationNativeSourceEvidenceCurrent(first, updated.observation, updated.scope);
    assert.deepEqual(decodeWorkspaceOperationNativeSourceEvidence(JSON.parse(JSON.stringify(first))), first);
    assert.deepEqual(original, before); assert.deepEqual(updated, after);
    assert.deepEqual(original.observation.privateNativeStates.map(state => [state.yjsState, state.stateVector]),
      updated.observation.privateNativeStates.map(state => [state.yjsState, state.stateVector]));
    assert(Object.isFrozen(first)); assert(Object.isFrozen(first.nativeBindings[0].expected));
    const json = JSON.stringify(first); assert.equal(json.includes('privateCatalogue'), false);
    assert.equal(json.includes('yjsState'), false); assert.equal(json.includes('privateNativeStates'), false);
  });

  test(`${representation}: actual native content and link changes remain different semantic evidence`, () => {
    const input = fixture(representation), original = capture(input), update = clone(input);
    const previous = update.observation.privateNativeStates[0];
    const doc = representation === 'plain_text' ? createPlainTextYDoc('[Keep](keep.md#Changed)\n\nChanged native content')
      : createRichMarkdownYDoc('[Keep](keep.md#Changed)\n\nChanged native content', representation);
    try { replaceNative(update.observation, 0, { ...previous, documentSequence: 8, persistedAt: 101,
      yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }); }
    finally { doc.destroy(); }
    assertFreshChanged(original, update);
    assert.notEqual(original.nativeBindings[0].expected.binaryHash, capture(update).nativeBindings[0].expected.binaryHash);
    assert.notDeepEqual(input.observation.stage.sources[0].inventory.links, update.observation.stage.sources[0].inventory.links);
  });
}

test('V1 retains the original wire formula and still refuses registry-checkpoint drift', () => {
  const input = fixture(), before = clone(input);
  const legacy = captureWorkspaceOperationNativeSourceEvidence(input.scope, input.observation);
  assert.equal(legacy.evidenceVersion, 1); assert.deepEqual(legacy, legacyWire(input));
  assert.equal(JSON.stringify(legacy), JSON.stringify(legacyWire(input)));
  assert.notEqual(legacy.semanticProof, capture(input).semanticProof);
  assert.equal(Object.hasOwn(legacy, 'semanticCatalogueProof'), false);
  assert.deepEqual(decodeWorkspaceOperationNativeSourceEvidence(JSON.parse(JSON.stringify(legacy))), legacy);
  const next = project(input.observation);
  assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(legacy, next, input.scope), changed);
  assert.deepEqual(input, before);
});

test('V2 capture requires its own complete catalogue and never treats missing or undefined as a legacy request', () => {
  const input = fixture();
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope, withoutWitness(input.observation)), invalid);
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope,
    { ...withoutWitness(input.observation), privateCatalogue: undefined }), invalid);
  const incomplete = clone(input); incomplete.observation.privateCatalogue = incomplete.observation.privateCatalogue
    .filter(row => row.id !== 'missing-state-document');
  // Keep the original raw catalogue proof: a truncated witness cannot prove the
  // same original observation even when the omitted row has no native binding.
  assert.throws(() => capture(incomplete), invalid);
});

test('V2 Current without a catalogue permits only the identical raw original and freshly verified native bytes', () => {
  const input = fixture(), evidence = capture(input), before = clone(input);
  assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, withoutWitness(input.observation), input.scope);
  const decoded = decodeWorkspaceOperationNativeSourceEvidence(JSON.parse(JSON.stringify(evidence)));
  assertWorkspaceOperationNativeSourceEvidenceCurrent(decoded, withoutWitness(input.observation), input.scope);
  const observations: Observation[] = [];
  const projection = clone(input.observation); projection.stage.namespace[0].filesystemIdentity = '3:333:120:200:201';
  refresh(projection); observations.push(projection);
  const directory = clone(input.observation), parent = directory.stage.namespace.find(entry => entry.path === 'assets')!;
  parent.identity = parent.filesystemIdentity = '1:30:9999:700:701'; refresh(directory); observations.push(directory);
  observations.push(project(input.observation));
  const catalogue = clone(input.observation); catalogue.privateCatalogue.push(pristine(input.scope, 1)); refresh(catalogue); observations.push(catalogue);
  const lineage = clone(input.observation); lineage.nativeBindings[0].lineage.trashEntryId = 'different-history';
  refresh(lineage); observations.push(lineage);
  for (const observation of observations) {
    assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, withoutWitness(observation), input.scope), changed);
  }
  assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, withoutWitness(input.observation),
    { ...input.scope, rootPath: '/different/root' }), changed);
  const bytes = clone(input.observation); bytes.privateNativeStates[0].yjsState[0] ^= 1;
  assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, withoutWitness(bytes), input.scope), invalid);
  assert.deepEqual(input, before);
});

test('present malformed or contradictory Current witness never falls back to the identical-raw replay branch', () => {
  const input = fixture(), evidence = capture(input), bad = clone(input.observation);
  bad.privateCatalogue[0].id = 'contradictory-id';
  for (const privateCatalogue of [undefined, [], bad.privateCatalogue]) {
    assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence,
      { ...withoutWitness(input.observation), privateCatalogue }, input.scope), invalid);
  }
});

test('unbound initialized, pristine and missing-state row clocks are not normalized', () => {
  const input = fixture();
  const unbound = catalogueRow(input.observation.nativeBindings[0]); unbound.id = 'unbound-native';
  unbound.lineage_id = 'unbound-lineage'; unbound.path = unbound.state_path = 'unbound.bin';
  input.observation.privateCatalogue.push(unbound); refresh(input.observation);
  const original = capture(input);
  for (const id of [unbound.id, 'asset-0', 'missing-state-document']) {
    const next = clone(input); const row = next.observation.privateCatalogue.find(entry => entry.id === id)!;
    row.state_version++;
    if (row.authority === 'pristine') row.authority = 'missing-state';
    refresh(next.observation); assertFreshChanged(original, next);
  }
});

test('nonbinding catalogue fields, order and membership remain part of V2 semantic evidence', () => {
  const input = fixture(), original = capture(input);
  const variants: Array<(observation: Observation) => void> = [
    observation => { observation.privateCatalogue.find(row => row.authority === 'initialized')!.has_state_history = false; },
    observation => { observation.privateCatalogue.find(row => row.id === 'asset-0')!.lineage_id = 'another-asset-lineage'; },
    observation => { delete observation.privateCatalogue.find(row => row.id === 'missing-state-document')!.yjs_state_lifecycle; },
    observation => { observation.privateCatalogue.reverse(); },
    observation => { observation.privateCatalogue.push(pristine(input.scope, 1)); },
    observation => { observation.privateCatalogue = observation.privateCatalogue.filter(row => row.id !== 'missing-state-document'); },
  ];
  for (const mutate of variants) { const next = clone(input); mutate(next.observation); refresh(next.observation); assertFreshChanged(original, next); }
});

test('coherently changed document ID, lineage and generation remain real semantic changes', () => {
  const input = fixture(), original = capture(input);
  const id = clone(input); replaceNative(id.observation, 0, { ...id.observation.privateNativeStates[0], documentId: 'replacement-D2' });
  assertFreshChanged(original, id);
  const generation = clone(input); replaceNative(generation.observation, 0,
    { ...generation.observation.privateNativeStates[0], lifecycleGeneration: 2 }); assertFreshChanged(original, generation);
  const lineage = clone(input), binding = lineage.observation.nativeBindings[0];
  binding.expected.lineageId = binding.registry.lineageId = binding.lineage.lineageId = 'replacement-lineage';
  lineage.observation.privateCatalogue.find(row => row.id === binding.expected.documentId)!.lineage_id = 'replacement-lineage';
  refresh(lineage.observation); assertFreshChanged(original, lineage);
});

test('scope, byte profile, asset identity and directory inode remain bound despite projection normalization', () => {
  const input = fixture(), original = capture(input);
  for (const scope of [{ ...input.scope, rootPath: '/different/root' }, { ...input.scope, ownerUserId: 'different-owner' }]) {
    assertFreshChanged(original, { scope, observation: clone(input.observation) });
  }
  for (const field of ['newlineStyle', 'hasBom'] as const) {
    const next = clone(input), state = next.observation.privateNativeStates[0];
    if (field === 'newlineStyle') state.newlineStyle = 'crlf'; else state.hasBom = true;
    replaceNative(next.observation, 0, state); assertFreshChanged(original, next);
  }
  for (const [path, fingerprint] of [['assets', '1:999:4096:100:100'], ['assets', '2:30:4096:100:100'],
    ['assets/report.pdf', '1:31:4:100:100'], ['assets/report.pdf', '1:32:3:100:100'],
    ['assets/report.pdf', '1:31:3:200:100']] as const) {
    const next = clone(input), entry = next.observation.stage.namespace.find(value => value.path === path)!;
    entry.identity = entry.filesystemIdentity = fingerprint; refresh(next.observation); assertFreshChanged(original, next);
  }
});

test('new paths, case spelling and vanished namespace entries are not treated as projection refresh', () => {
  const input = fixture(), original = capture(input);
  const added = clone(input); added.observation.stage.namespace.push({ workspaceId: input.scope.workspaceId,
    path: 'foreign.pdf', kind: 'file', identity: '1:32:3:100:100', filesystemIdentity: '1:32:3:100:100', documentId: null, lifecycleGeneration: null });
  refresh(added.observation); assertFreshChanged(original, added);
  const missing = clone(input); missing.observation.stage.namespace = missing.observation.stage.namespace.filter(entry => entry.path !== 'assets/report.pdf');
  refresh(missing.observation); assertFreshChanged(original, missing);
  const spelling = clone(input); spelling.observation.stage.namespace.find(entry => entry.path === 'assets/report.pdf')!.path = 'assets/Report.pdf';
  refresh(spelling.observation); assertFreshChanged(original, spelling);
});

test('native deletions retain their vector but cannot retain original V2 state or binary evidence', () => {
  const input = fixture('plain_text'), original = capture(input), state = input.observation.privateNativeStates[0];
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state.yjsState); doc.getText('content').delete(0, 1);
    const nextState = { ...state, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
    assert.deepEqual(nextState.stateVector, state.stateVector); assert.notEqual(hash(nextState.yjsState), hash(state.yjsState));
    assert.equal(nextState.documentSequence, state.documentSequence);
    const stale = clone(input); stale.observation.privateNativeStates[0] = nextState;
    assert.throws(() => capture(stale), invalid);
    const coherent = clone(input); replaceNative(coherent.observation, 0, nextState);
    assertFreshChanged(original, coherent);
    assert.notEqual(capture(coherent).nativeBindings[0].expected.stateProof, original.nativeBindings[0].expected.stateProof);
  } finally { doc.destroy(); }
});

test('private binary, vector, inventory and semantic-catalogue claims cannot replace freshly inspected native data', () => {
  const input = fixture(), original = capture(input);
  const binary = clone(input); binary.observation.privateNativeStates[0].yjsState = Uint8Array.of(1, 2, 3);
  assert.throws(() => capture(binary), invalid);
  const vector = clone(input); vector.observation.privateNativeStates[0].stateVector = Uint8Array.of(0);
  assert.throws(() => capture(vector), invalid);
  const links = clone(input); links.observation.stage.sources[0].inventory.links.length = 0;
  links.observation.nativeBindings[0].inventoryProof = proof(links.observation.stage.sources[0].inventory); refresh(links.observation);
  assert.throws(() => capture(links), invalid);
  const semantic = clone(original); semantic.semanticCatalogueProof = 'f'.repeat(64);
  const { evidenceProof: _raw, ...body } = semantic; semantic.evidenceProof = proof(body);
  assert.throws(() => decodeWorkspaceOperationNativeSourceEvidence(semantic), invalid);
});

test('strict V1/V2 decoding rejects missing, additional, malformed and stale digest fields', () => {
  const input = fixture(), evidence = capture(input), legacy = captureWorkspaceOperationNativeSourceEvidence(input.scope, input.observation);
  const probes: unknown[] = [{ ...evidence, extra: true }, { ...evidence, semanticCatalogueProof: 'wrong' },
    { ...evidence, semanticProof: 'f'.repeat(64) }, { ...evidence, evidenceProof: 'f'.repeat(64) },
    { ...evidence, evidenceVersion: 1 }, { ...legacy, evidenceVersion: 2 },
    { ...legacy, semanticCatalogueProof: evidence.semanticCatalogueProof }];
  const missing = { ...evidence } as Record<string, unknown>; delete missing.semanticCatalogueProof; probes.push(missing);
  for (const value of probes) assert.throws(() => decodeWorkspaceOperationNativeSourceEvidence(value), invalid);
});

test('a self-consistent foreign semantic-catalogue claim remains historical data and fails genuine fresh Current', () => {
  const input = fixture(), baseline = capture(input), foreign = clone(input);
  const unbound = foreign.observation.privateCatalogue.find(row => row.id === 'missing-state-document')!;
  unbound.has_state_history = false; refresh(foreign.observation);
  const alternate = capture(foreign);
  assert.notEqual(alternate.semanticCatalogueProof, baseline.semanticCatalogueProof);
  assert.notEqual(alternate.semanticProof, baseline.semanticProof);
  const forged = { ...clone(baseline), semanticCatalogueProof: alternate.semanticCatalogueProof, semanticProof: alternate.semanticProof };
  const { evidenceProof: _old, ...body } = forged; forged.evidenceProof = proof(body);
  assert.deepEqual(forged.stage, baseline.stage); assert.deepEqual(forged.nativeBindings, baseline.nativeBindings);
  assert.deepEqual(forged.workspaceScope, baseline.workspaceScope);
  // The historical wire has no complete catalogue with which to refute the
  // supplied opaque hash. The current full witness is the necessary check.
  const decoded = decodeWorkspaceOperationNativeSourceEvidence(forged);
  assert.deepEqual(decoded, forged);
  assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(decoded, input.observation, input.scope), changed);
});

test('getter-backed witness, observation, scope or V2 proof fields never execute', () => {
  const input = fixture(); let getters = 0;
  const getter = () => { getters++; return input.observation.privateCatalogue; };
  const witness = { ...input.observation }; Object.defineProperty(witness, 'privateCatalogue', { enumerable: true, get: getter });
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope, witness), invalid);
  const rows = clone(input.observation); Object.defineProperty(rows.privateCatalogue[0], 'id', { enumerable: true, get: getter });
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope, rows), invalid);
  const scope = { ...input.scope }; Object.defineProperty(scope, 'rootPath', { enumerable: true, get: getter });
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(scope, input.observation), invalid);
  const evidence = { ...capture(input) }; Object.defineProperty(evidence, 'semanticCatalogueProof', { enumerable: true, get: getter });
  assert.throws(() => decodeWorkspaceOperationNativeSourceEvidence(evidence), invalid);
  assert.equal(getters, 0);
});

test('extra, inherited and sparse input data cannot acquire V2 equivalence through a prior valid capture', () => {
  const input = fixture(); capture(input);
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope,
    { ...input.observation, extra: true } as unknown as WorkspaceLinkSourceAuthorityObservation), invalid);
  const binding = clone(input); Object.defineProperty(binding.observation.nativeBindings[0].expected, 'extra', { enumerable: true, value: true });
  assert.throws(() => capture(binding), invalid);
  const row = clone(input); Object.defineProperty(row.observation.privateCatalogue[0], 'extra', { enumerable: true, value: true });
  assert.throws(() => capture(row), invalid);
  const inherited = clone(input); Object.setPrototypeOf(inherited.observation.privateCatalogue[0], { inherited: true });
  assert.throws(() => capture(inherited), invalid);
  const sparse = clone(input); delete sparse.observation.privateCatalogue[0];
  assert.throws(() => capture(sparse), invalid);
});

test('Observation, Scope, nested Stage/Bindings/arrays, Decode and Current proxies reject before any trap runs', () => {
  const input = fixture(), evidence = capture(input); let traps = 0;
  const trap = (): never => { traps++; throw new Error('Proxy trap must not execute.'); };
  const proxied = <T extends object>(value: T): T => new Proxy<T>(value, { get: trap, ownKeys: trap,
    getPrototypeOf: trap, getOwnPropertyDescriptor: trap, has: trap, isExtensible: trap });
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope, proxied(input.observation)), invalid);
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(proxied(input.scope), input.observation), invalid);
  const observations: WorkspaceLinkSourceAuthorityObservation[] = [
    { ...input.observation, stage: proxied(input.observation.stage) },
    { ...input.observation, nativeBindings: proxied(input.observation.nativeBindings) },
    { ...input.observation, nativeBindings: input.observation.nativeBindings.map((binding, index) => index ? binding : proxied(binding)) },
    { ...input.observation, nativeBindings: input.observation.nativeBindings.map((binding, index) => index ? binding :
      { ...binding, expected: proxied(binding.expected) }) },
    { ...input.observation, privateNativeStates: proxied(input.observation.privateNativeStates) },
    { ...input.observation, privateCatalogue: proxied(input.observation.privateCatalogue) },
  ];
  for (const observation of observations) {
    assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope, observation), invalid);
  }
  assert.throws(() => decodeWorkspaceOperationNativeSourceEvidence(proxied(evidence)), invalid);
  assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(proxied(evidence), input.observation, input.scope), invalid);
  assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, proxied(input.observation), input.scope), invalid);
  assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(evidence, proxied(withoutWitness(input.observation)), input.scope), invalid);
  const revoked = Proxy.revocable(input.observation, {}); revoked.revoke();
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope, revoked.proxy), invalid);
  assert.equal(traps, 0);
});

test('V2 keeps catalogue, evidence JSON, native binary and vector limits before accepting supplied claims', () => {
  const input = fixture();
  const catalogue = clone(input); catalogue.observation.privateCatalogue = Array.from({ length: 10_001 }, (_, index) => pristine(input.scope, index));
  refresh(catalogue.observation); assert.throws(() => capture(catalogue), tooLarge);
  const json = clone(input); json.observation.stage.scope.excludedPaths = Array.from({ length: 9000 }, (_, index) => `ignored/${index}/${'x'.repeat(1024)}`);
  refresh(json.observation); assert.throws(() => capture(json), tooLarge);
  const binary = clone(input); binary.observation.privateNativeStates[0].yjsState = new Uint8Array(16 * 1024 * 1024 + 1);
  assert.throws(() => capture(binary), tooLarge);
  const vector = clone(input); vector.observation.privateNativeStates[0].stateVector = new Uint8Array(1024 * 1024 + 1);
  assert.throws(() => capture(vector), tooLarge);
});
