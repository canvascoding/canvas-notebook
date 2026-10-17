import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import { captureWorkspaceOperationNativeCatalogueWitness } from '../app/lib/files/workspace-operation-native-catalogue-witness';
import { captureWorkspaceOperationNativeSourceEvidence } from '../app/lib/files/workspace-operation-native-source-evidence';
import type { WorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-batch-contract';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';

// Real Yjs/C1/Stage fixture data; declared catalogue rows are neither current
// PostgreSQL/ACL evidence nor a lifecycle, mutation or publication capability.
type Row = WorkspaceDocumentCatalogueEntry;
type Reason = 'invalid' | 'too-large';
class RejectedCatalogue extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
const reject = (reason: Reason): never => { throw new RejectedCatalogue(reason); };
const rejected = (reason: Reason) => (error: unknown) => error instanceof RejectedCatalogue && error.reason === reason;
const clone = <T>(value: T): T => structuredClone(value);
const MAX_ROWS = 10_000;
const MAX_BYTES = 32 * 1024 * 1024;

function initialized(binding: WorkspaceNativeSourceBinding): Row {
  const expected = binding.expected;
  return { id: expected.documentId, lineage_id: expected.lineageId, path: expected.path,
    workspace_id: expected.workspaceId, organization_id: expected.organizationId, status: 'active',
    state_version: expected.registryStateVersion, yjs_state_lifecycle: 'initialized', has_persisted_state: true,
    has_state_history: true, lifecycle_generation: expected.lifecycleGeneration, authority: 'initialized',
    state_status: 'active', state_path: expected.path, state_workspace_id: expected.workspaceId,
    state_organization_id: expected.organizationId };
}
function pristine(scope: WorkspaceOperationJobScope, index = 0): Row {
  return { id: `asset-${index}`, lineage_id: `asset-lineage-${index}`, path: `assets/${String(index).padStart(5, '0')}.bin`,
    workspace_id: scope.workspaceId, organization_id: scope.organizationId, status: 'active', state_version: 0,
    yjs_state_lifecycle: 'never_initialized', has_persisted_state: false, has_state_history: false,
    lifecycle_generation: null, authority: 'pristine', state_status: null, state_path: null,
    state_workspace_id: null, state_organization_id: null };
}
function fixture(representation: PersistedCollaborationState['representation'] = 'plain_text') {
  const stage = nativeCopyMetadataFixture(representation), evidence = stage.plan.sourceEvidence;
  const scope = evidence.workspaceScope, bindings = evidence.nativeBindings;
  const missing: Row = { ...pristine(scope, 99_999), id: 'missing-state-document', lineage_id: 'missing-state-lineage',
    path: 'missing-state.bin', state_version: 2, yjs_state_lifecycle: 'legacy_unknown', has_state_history: true,
    authority: 'missing-state' };
  const rows = [...bindings.map(initialized), pristine(scope), missing].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)) || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  const observation = { stage: clone(evidence.stage), nativeBindings: bindings,
    privateNativeStates: stage.nativeRecords.filter(record => record.state.workspaceId === scope.workspaceId).map(record => record.state) };
  observation.stage.catalogueProof = proof(rows);
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
  return { scope, bindings, rows, observation };
}
function read(rows: unknown, scope: WorkspaceOperationJobScope, bindings: readonly WorkspaceNativeSourceBinding[], rawProof: string) {
  return captureWorkspaceOperationNativeCatalogueWitness(rows, scope, rawProof, bindings, reject);
}
function captured(input: ReturnType<typeof fixture>) { return read(input.rows, input.scope, input.bindings, proof(input.rows)); }
function version(bindings: readonly WorkspaceNativeSourceBinding[], documentId: string, stateVersion: number) {
  return bindings.map(binding => binding.expected.documentId !== documentId ? binding : { ...binding,
    expected: { ...binding.expected, registryStateVersion: stateVersion }, registry: { ...binding.registry, stateVersion } });
}
function sensitive(rows: Row[], input: ReturnType<typeof fixture>, originalProof: string): void {
  try { assert.notEqual(read(rows, input.scope, input.bindings, proof(rows)).semanticCatalogueProof, originalProof); }
  catch (error) { if (!rejected('invalid')(error)) throw error; }
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: complete catalogue is detached and freezes real native bindings plus pristine/missing-state rows`, () => {
    const input = fixture(representation), before = clone(input.rows), output = captured(input);
    assert.deepEqual(output.entries, before); assert.notEqual(output.entries, input.rows);
    assert(Object.isFrozen(output)); assert(Object.isFrozen(output.entries));
    assert(output.entries.every(row => Object.isFrozen(row)));
    assert(input.bindings.every(binding => output.entries.some(row => row.id === binding.expected.documentId)));
    input.rows[0].path = 'later.bin'; input.rows[0].state_version = 6;
    assert.deepEqual(output.entries, before);
    assert.equal(Object.isFrozen(input.rows), false);
    assert.equal(JSON.stringify(output).includes('yjsState'), false);
  });
}

test('only a coherently bound initialized checkpoint version is normalized, while raw rows and hashes remain different', () => {
  const input = fixture(), id = input.bindings[0].expected.documentId;
  const before = clone(input.rows), after = clone(input.rows);
  before.find(row => row.id === id)!.state_version = 6;
  const first = read(before, input.scope, version(input.bindings, id, 6), proof(before));
  const second = read(after, input.scope, version(input.bindings, id, 7), proof(after));
  assert.notEqual(proof(before), proof(after)); assert.notDeepEqual(first.entries, second.entries);
  assert.equal(first.semanticCatalogueProof, second.semanticCatalogueProof);
  assert.equal(first.entries.find(row => row.id === id)!.state_version, 6);
  assert.equal(second.entries.find(row => row.id === id)!.state_version, 7);
  // The catalogue has no filesystem projection field to normalize or adopt.
  const physical = clone(before) as unknown as Array<Record<string, unknown>>;
  physical[0].filesystemIdentity = '1:2:3:4:5';
  assert.throws(() => read(physical, input.scope, input.bindings, proof(physical)), rejected('invalid'));
});

test('an initialized row without its exact binding never gains checkpoint-version equivalence', () => {
  const input = fixture(), row = input.rows.find(entry => entry.authority === 'initialized')!;
  const missingBinding = input.bindings.filter(binding => binding.expected.documentId !== row.id);
  const changed = clone(input.rows); changed.find(entry => entry.id === row.id)!.state_version = 6;
  const first = read(input.rows, input.scope, missingBinding, proof(input.rows));
  const second = read(changed, input.scope, missingBinding, proof(changed));
  assert.notEqual(first.semanticCatalogueProof, second.semanticCatalogueProof);
  // A claimed original binding with a different raw checkpoint version is also
  // not evidence that the row is the exact bound initialized document.
  sensitive(changed, input, captured(input).semanticCatalogueProof);
});

test('pristine and missing-state rows, original order and catalogue membership remain semantically bound', () => {
  const input = fixture(), baseline = captured(input).semanticCatalogueProof;
  for (const authority of ['pristine', 'missing-state'] as const) {
    const changed = clone(input.rows), row = changed.find(entry => entry.authority === authority)!;
    row.state_version++; sensitive(changed, input, baseline);
    const history = clone(input.rows), historical = history.find(entry => entry.authority === authority)!;
    historical.has_state_history = !historical.has_state_history; sensitive(history, input, baseline);
  }
  sensitive(input.rows.slice(1), input, baseline);
  sensitive([...clone(input.rows), pristine(input.scope, 1)], input, baseline);
  sensitive(clone(input.rows).reverse(), input, baseline);
});

test('catalogue workspace and organization plus bound registry workspace type must match the validated scope', () => {
  const input = fixture();
  for (const change of [{ workspaceId: 'foreign-workspace' }, { organizationId: 'foreign-organization' },
    { workspaceType: 'organization' as const }]) {
    assert.throws(() => read(input.rows, { ...input.scope, ...change }, input.bindings, proof(input.rows)), rejected('invalid'));
  }
});

test('all initialized identity, lineage, generation, scope, authority and state-header fields remain bound', () => {
  const input = fixture(), baseline = captured(input).semanticCatalogueProof;
  const changes: Array<(row: Record<string, unknown>) => void> = [
    row => { row.id = 'foreign-document'; }, row => { row.lineage_id = 'foreign-lineage'; },
    row => { row.path = 'foreign.md'; }, row => { row.workspace_id = 'foreign-workspace'; },
    row => { row.organization_id = 'foreign-organization'; }, row => { row.status = 'archived'; },
    row => { row.lifecycle_generation = 2; }, row => { row.authority = 'pristine'; },
    row => { row.has_persisted_state = false; }, row => { row.has_state_history = false; },
    row => { row.yjs_state_lifecycle = 'legacy_unknown'; }, row => { row.state_status = 'archived'; },
    row => { row.state_path = 'foreign.md'; }, row => { row.state_workspace_id = 'foreign-workspace'; },
    row => { row.state_organization_id = 'foreign-organization'; },
  ];
  for (const change of changes) {
    const changed = clone(input.rows); change(changed.find(row => row.authority === 'initialized')!);
    sensitive(changed, input, baseline);
  }
});

test('optional lifecycle absence stays distinct from explicit NULL, while explicit undefined is invalid', () => {
  const input = fixture(), index = input.rows.findIndex(row => row.authority === 'missing-state');
  const absent = clone(input.rows); delete absent[index].yjs_state_lifecycle;
  const nullable = clone(absent); nullable[index].yjs_state_lifecycle = null;
  const first = read(absent, input.scope, input.bindings, proof(absent));
  const second = read(nullable, input.scope, input.bindings, proof(nullable));
  assert.notEqual(first.semanticCatalogueProof, second.semanticCatalogueProof);
  const undefinedValue: Array<Record<string, unknown>> = clone(absent);
  undefinedValue[index].yjs_state_lifecycle = undefined;
  assert.throws(() => read(undefinedValue, input.scope, input.bindings, proof(absent)), rejected('invalid'));
});

test('malformed primitive values, paths, keys and duplicate identities cannot be hidden by a matching raw hash', () => {
  const input = fixture();
  const changes: Array<(row: Record<string, unknown>) => void> = [
    row => { row.id = ''; }, row => { row.id = 'x'.repeat(257); }, row => { row.id = '\ud800'; },
    row => { row.path = '../outside.bin'; }, row => { row.path = 'x'.repeat(4097); },
    row => { row.path = 'alias\\file.bin'; }, row => { row.state_version = -0; },
    row => { row.state_version = '7'; }, row => { row.state_version = -1; },
    row => { row.state_version = Number.MAX_SAFE_INTEGER + 1; }, row => { row.state_version = NaN; },
    row => { row.lifecycle_generation = 0; }, row => { row.has_persisted_state = 1; },
    row => { row.extra = null; }, row => { delete row.state_status; },
  ];
  for (const change of changes) {
    const changed = clone(input.rows); change(changed[0]);
    assert.throws(() => read(changed, input.scope, input.bindings, proof(changed)), rejected('invalid'));
  }
  const duplicate = [...clone(input.rows), clone(input.rows[0])];
  assert.throws(() => read(duplicate, input.scope, input.bindings, proof(duplicate)), rejected('invalid'));
  for (const key of ['id', 'path'] as const) {
    const changed = clone(input.rows); changed[0][key] = changed[1][key];
    assert.throws(() => read(changed, input.scope, input.bindings, proof(changed)), rejected('invalid'));
  }
});

test('accessors at array, row and optional-field boundaries are rejected without execution', () => {
  const input = fixture(), rawProof = proof(input.rows); let calls = 0;
  const accessor = () => { calls++; return input.rows[0]; };
  const rows = clone(input.rows); Object.defineProperty(rows, '0', { enumerable: true, get: accessor });
  assert.throws(() => read(rows, input.scope, input.bindings, rawProof), rejected('invalid'));
  for (const key of ['id', 'yjs_state_lifecycle', 'extra']) {
    const changed = clone(input.rows);
    Object.defineProperty(changed[0], key, { enumerable: true, get: accessor });
    assert.throws(() => read(changed, input.scope, input.bindings, rawProof), rejected('invalid'));
  }
  assert.equal(calls, 0);
});

test('proxies, custom prototypes, symbols, nonenumerable fields and sparse or decorated arrays are rejected', () => {
  const input = fixture(), rawProof = proof(input.rows); let traps = 0;
  const handler: ProxyHandler<object> = { get() { traps++; throw new Error('proxy get'); },
    ownKeys() { traps++; throw new Error('proxy ownKeys'); },
    getPrototypeOf() { traps++; throw new Error('proxy prototype'); },
    getOwnPropertyDescriptor() { traps++; throw new Error('proxy descriptor'); } };
  assert.throws(() => read(new Proxy(input.rows, handler), input.scope, input.bindings, rawProof), rejected('invalid'));
  const proxyRow = clone(input.rows); proxyRow[0] = new Proxy<Row>(proxyRow[0], handler);
  assert.throws(() => read(proxyRow, input.scope, input.bindings, rawProof), rejected('invalid')); assert.equal(traps, 0);
  const variants: unknown[] = [];
  const inherited = clone(input.rows); Object.setPrototypeOf(inherited[0], { inherited: true }); variants.push(inherited);
  const symbolic = clone(input.rows); Object.defineProperty(symbolic[0], Symbol('hidden'), { value: true, enumerable: true }); variants.push(symbolic);
  const hidden = clone(input.rows); Object.defineProperty(hidden[0], 'id', { value: hidden[0].id, enumerable: false }); variants.push(hidden);
  const sparse = clone(input.rows); delete sparse[0]; variants.push(sparse);
  const decorated = clone(input.rows); Object.defineProperty(decorated, 'extra', { value: true, enumerable: true }); variants.push(decorated);
  const customArray = clone(input.rows); Object.setPrototypeOf(customArray, Object.create(Array.prototype)); variants.push(customArray);
  for (const value of variants) assert.throws(() => read(value, input.scope, input.bindings, rawProof), rejected('invalid'));
});

test('the complete raw catalogue hash is checked before any semantic normalization', () => {
  const input = fixture();
  assert.throws(() => read(input.rows, input.scope, input.bindings, 'f'.repeat(64)), rejected('invalid'));
  for (const rawProof of ['', 'A'.repeat(64), 'a'.repeat(63)]) {
    assert.throws(() => read(input.rows, input.scope, input.bindings, rawProof), rejected('invalid'));
  }
  const changed = clone(input.rows); changed.find(row => row.authority === 'initialized')!.state_version = 6;
  assert.throws(() => read(changed, input.scope, input.bindings, proof(input.rows)), rejected('invalid'));
});

test('mechanical catalogue-format fixture accepts 10000 rows and rejects the next row', () => {
  const { scope } = fixture(), rows = Array.from({ length: MAX_ROWS }, (_, index) => pristine(scope, index));
  const empty = read([], scope, [], proof([])); assert.deepEqual(empty.entries, []); assert.equal(empty.semanticCatalogueProof, proof([]));
  const output = read(rows, scope, [], proof(rows));
  assert.equal(output.entries.length, MAX_ROWS); assert.equal(output.semanticCatalogueProof, proof(rows));
  const excessive = [...rows, pristine(scope, MAX_ROWS)];
  assert.throws(() => read(excessive, scope, [], proof(excessive)), rejected('too-large'));
});

test('canonical Unicode paths retain the existing UTF16 path limit while invalid UTF8 is never normalized', () => {
  const { scope } = fixture(), row = pristine(scope); row.id = '😀'.repeat(128); row.path = 'ä'.repeat(4096);
  const rows = [row], output = read(rows, scope, [], proof(rows));
  assert.equal(row.id.length, 256); assert.equal(row.path.length, 4096); assert.equal(Buffer.byteLength(row.path), 8192);
  assert.deepEqual(output.entries, rows);
  const tooLong = [{ ...row, id: row.id + '😀' }];
  assert.throws(() => read(tooLong, scope, [], proof(tooLong)), rejected('invalid'));
  const invalidUtf8 = [{ ...row, path: 'invalid\ud800.bin' }];
  assert.throws(() => read(invalidUtf8, scope, [], proof(invalidUtf8)), rejected('invalid'));
});

test('mechanical catalogue-format fixture accepts exactly 32MiB UTF8 JSON and rejects one additional byte', () => {
  const { scope } = fixture(), rows = Array.from({ length: 9500 }, (_, index) => pristine(scope, index));
  let remaining = MAX_BYTES - Buffer.byteLength(JSON.stringify(rows));
  assert(remaining > 0);
  for (const row of rows) {
    const addition = Math.min(remaining, 4096 - row.path.length);
    row.path = row.path.slice(0, -4) + 'x'.repeat(addition) + '.bin'; remaining -= addition;
    if (!remaining) break;
  }
  assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(rows)), MAX_BYTES);
  const output = read(rows, scope, [], proof(rows)); assert.equal(output.entries.length, rows.length);
  const index = rows.findIndex(row => row.path.length < 4096); assert(index >= 0);
  const originalPath = rows[index].path;
  rows[index].path = rows[index].path.slice(0, -4) + 'x.bin';
  assert.equal(Buffer.byteLength(JSON.stringify(rows)), MAX_BYTES + 1);
  assert.throws(() => read(rows, scope, [], proof(rows)), rejected('too-large'));
  rows[index].path = originalPath;
  const originalLineage = rows[index].lineage_id; assert(originalLineage);
  rows[index].lineage_id = '"' + originalLineage.slice(1);
  assert.equal(Buffer.byteLength(JSON.stringify(rows)), MAX_BYTES + 1, 'a legal escaped identifier also consumes its exact JSON overhead');
  assert.throws(() => read(rows, scope, [], proof(rows)), rejected('too-large'));
});

test('optional full catalogue is validated during Evidence capture without changing serialized V1 evidence', () => {
  const input = fixture(), before = clone(input.observation);
  const without = captureWorkspaceOperationNativeSourceEvidence(input.scope, input.observation);
  const withCatalogue = captureWorkspaceOperationNativeSourceEvidence(input.scope,
    { ...input.observation, privateCatalogue: input.rows });
  assert.deepEqual(withCatalogue, without); assert.equal(withCatalogue.evidenceVersion, 1);
  assert.deepEqual(input.observation, before); assert.equal(withCatalogue.stage.executionReady, false);
  const json = JSON.stringify(withCatalogue);
  assert.equal(json.includes('privateCatalogue'), false); assert.equal(json.includes('"entries"'), false);
  const changed = clone(input.rows); changed[0].path = 'contradictory.bin';
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidence(input.scope,
    { ...input.observation, privateCatalogue: changed }));
  assert.throws(() => captureWorkspaceOperationNativeSourceEvidence(input.scope,
    { ...input.observation, privateCatalogue: undefined }));
});
