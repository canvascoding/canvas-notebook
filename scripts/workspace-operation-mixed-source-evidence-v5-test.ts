import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  assertWorkspaceOperationMixedSourceEvidenceV5Current, workspaceOperationMixedSourceSnapshotV5,
  workspaceOperationMixedSourceBindingsV5, workspaceOperationSourceHtmlOccurrencesV5,
  type WorkspaceOperationMixedSourceEvidenceV5 } from '../app/lib/files/workspace-operation-mixed-source-evidence-v5';
import { decodeWorkspaceOperationNativeSourceEvidence, WorkspaceOperationNativeSourceEvidenceError }
  from '../app/lib/files/workspace-operation-native-source-evidence';
import { captureWorkspaceOperationNativeSourceEvidenceV3 } from '../app/lib/files/workspace-operation-native-source-evidence-v3';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks, inspectOriginalPhysicalLinksV3, workspaceSourceAuthorityStageProof }
  from '../app/lib/markdown/workspace-physical-link-inventory';
import { workspacePathImportPreparationFixture } from './workspace-path-import-preparation-plan-test';
import { v3EvidenceFixture } from './workspace-operation-native-source-evidence-v3-test';

type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type FixtureOptions = { native?: readonly (readonly [string, string])[]; raw?: readonly (readonly [string, string])[];
  extra?: readonly Readonly<{ path: string; kind: 'file' | 'directory' }>[]; workspaceId?: string; documentSequence?: number };

/** Declared pure catalogue/FS observations with actual Yjs/UTF8 payloads. This
 * is not a genuine SQL/FD/principal/lease or execution-authority fixture. */
export function workspaceOperationMixedSourceEvidenceV5Fixture(options: FixtureOptions = {}) {
  const fixture = workspacePathImportPreparationFixture({ native: options.native ?? [['note.md', '# Native\n'], ['empty.md', '']],
    raw: options.raw ?? [['raw.md', '# Raw\n'], ['page.html', '<p>External <a href="https://example.com">link</a></p>']], extra: options.extra });
  const workspaceId = options.workspaceId ?? fixture.scope.workspaceId;
  const scope = { ...fixture.scope, workspaceId, rootPath: `/data/users/${workspaceId}/files`, rootRelativePath: `users/${workspaceId}/files` };
  const observation = fixture.observation;
  const documentSequence = options.documentSequence ?? 0;
  assert(Number.isSafeInteger(documentSequence) && documentSequence >= 0);
  for (const state of observation.privateNativeStates) { state.workspaceId = workspaceId; state.documentSequence = documentSequence; }
  const inventories = observation.privateNativeStates.map(inspectPersistedDocumentLinks);
  for (const row of observation.privateCatalogue) { row.workspace_id = workspaceId; row.state_workspace_id = workspaceId; }
  for (const [index, binding] of observation.nativeBindings.entries()) {
    const inventory = inventories[index];
    binding.expected.workspaceId = workspaceId; binding.expected.documentSequence = inventory.version.documentSequence;
    binding.expected.stateProof = inventory.version.stateProof;
    binding.registry.workspaceId = workspaceId; binding.lineage.workspaceId = workspaceId; binding.inventoryProof = proof(inventory);
  }
  const catalogueProof = proof(observation.privateCatalogue);
  observation.stage.workspaceId = workspaceId; observation.stage.catalogueProof = catalogueProof;
  for (const entry of observation.stage.namespace) entry.workspaceId = workspaceId;
  observation.stage.sources = [...inventories.map(inventory => ({ kind: 'native' as const, inventory })),
    ...observation.stage.sources.flatMap(source => source.kind === 'physical' ? [{ kind: 'physical' as const,
      inventory: inspectOriginalPhysicalLinksV3({ workspaceId, organizationId: scope.organizationId, path: source.inventory.path,
        authority: { ...source.inventory.authority, catalogueProof }, filesystemIdentity: source.inventory.physical.filesystemIdentity,
        bytes: source.inventory.originalBytes }) }] : [])];
  const gaps = observation.stage.sources.flatMap(source => source.kind === 'native'
    ? source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })) : source.inventory.coverage.gaps);
  observation.stage.coverage = { complete: !gaps.length, gaps };
  observation.stage.readiness = gaps.length ? 'blocked' : observation.stage.sources.some(source => source.kind === 'physical')
    ? 'requires-import-and-rebinding' : 'native-coordinator-required';
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
  return { scope, observation, evidence: captureWorkspaceOperationMixedSourceEvidenceV5(scope, observation) };
}
function rejected(action: () => unknown, code = 'NATIVE_SOURCE_EVIDENCE_INVALID'): void {
  assert.throws(action, error => error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === code && error.status === 409);
}
/** Independent public normalization recipe: recalculating every transport hash
 * still cannot manufacture same-byte current source observation. */
function rehash(value: Mutable<WorkspaceOperationMixedSourceEvidenceV5>): WorkspaceOperationMixedSourceEvidenceV5 {
  const normalize = (source: typeof value.physicalSources4[number] | typeof value.physicalHtmlSources4[number]) => {
    const { authority, ...body } = source;
    if ('links' in body) {
      const { physicalSourceProof: _raw, links, ...rest } = body;
      return { ...rest, authority: { ...authority, catalogueProof: value.nativeComponent.semanticCatalogueProof },
        links: links.map(({ physicalLinkId: _id, ...link }) => link) };
    }
    const { htmlSourceProof: _raw, ...rest } = body;
    return { ...rest, authority: { ...authority, catalogueProof: value.nativeComponent.semanticCatalogueProof } };
  };
  value.semanticProof = proof({ semanticVersion: 5, workspaceScope: value.workspaceScope, scope: value.scope, coverage: value.coverage,
    nativeComponent: value.nativeComponent.semanticProof, nativeOrdinarySources4: value.nativeOrdinarySources4,
    physicalSources4: value.physicalSources4.map(normalize), physicalHtmlSources4: value.physicalHtmlSources4.map(normalize),
    nativeHtmlSourceLocations: value.nativeHtmlSourceLocations,
    physicalHtmlSourceLocations: value.physicalHtmlSourceLocations.map(({ path, locations }) => ({ path, locations })) });
  const { evidenceProof: _raw, ...body } = value; value.evidenceProof = proof(body); return value;
}
function rehashPhysical(source: Mutable<WorkspaceOperationMixedSourceEvidenceV5>['physicalSources4'][number]): void {
  const { physicalSourceProof: _raw, ...body } = source;
  source.physicalSourceProof = proof({ ...body, observedOriginalByteHash: source.physical.byteHash });
}

export function workspaceOperationMixedSourceEvidenceV5Test(): void {
  let groups = 0;
  const fixture = workspaceOperationMixedSourceEvidenceV5Fixture(), before = clone(fixture.observation), value = fixture.evidence;
  assert.equal(value.evidenceVersion, 5); assert.equal(value.nativeComponent.evidenceVersion, 4);
  assert.equal(value.physicalSources4.length, 1); assert.equal(value.physicalHtmlSources4.length, 1);
  assert.equal(value.nativeOrdinarySources4.length, fixture.observation.nativeBindings.length);
  assert(value.nativeOrdinarySources4.every(source => source.inventory.parserVersion === 4));
  assert.deepEqual(value.nativeComponent.stage.sources.map(source => source.inventory.parserVersion), [2, 2]);
  assert.deepEqual(value.coverage, fixture.observation.stage.coverage);
  assert.equal(value.coverage.complete, false, 'Original HTML gap must remain false even for inspected external-only HTML.');
  assert.deepEqual(decodeWorkspaceOperationMixedSourceEvidenceV5(JSON.parse(JSON.stringify(value))), value);
  assertWorkspaceOperationMixedSourceEvidenceV5Current(value, fixture.observation, fixture.scope);
  assert.deepEqual(fixture.observation, before);
  assert(Object.isFrozen(value)); assert(Object.isFrozen(value.nativeOrdinarySources4[0].inventory));
  assert.equal(Object.hasOwn(value, 'executionReady'), false);
  assert(!JSON.stringify(value).includes('originalBytes')); assert(!JSON.stringify(value).includes('yjsState'));
  groups++;

  const derived = workspaceOperationMixedSourceBindingsV5(value), snapshot = workspaceOperationMixedSourceSnapshotV5(value);
  assert.equal(snapshot.contractVersion, 5); assert.equal(snapshot.coverage.complete, false);
  assert.deepEqual(snapshot.namespace, value.namespace); assert.equal(snapshot.documents.length, 2);
  assert.deepEqual(snapshot.documents, value.nativeOrdinarySources4.map(source => source.inventory));
  assert.deepEqual(derived, value.nativeComponent.nativeBindings.map((binding, index) => ({ ...binding,
    inventoryProof: value.nativeOrdinarySources4[index].inventoryProof })));
  assert.equal(workspaceOperationSourceHtmlOccurrencesV5(value).length, 1);
  assert.deepEqual(workspaceOperationSourceHtmlOccurrencesV5(value)[0], { sourcePath: 'page.html', line: 1,
    fullyInspected: true, explicitLocalTargets: [] });
  rejected(() => decodeWorkspaceOperationNativeSourceEvidence(value));
  rejected(() => captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation));
  groups++;

  // Same actual state binary yields old missing Wiki edge + preserved HTML gap,
  // alongside the new positive Wiki edge. Nothing gets silently retagged.
  {
    const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [], native: [['note.md', '[[Other|<img src="alias.png">]]'], ['Other.md', '']] });
    const old = actual.evidence.nativeComponent.stage.sources.find(source => source.inventory.document.path === 'note.md')!.inventory;
    const fresh = actual.evidence.nativeOrdinarySources4.find(source => source.inventory.document.path === 'note.md')!;
    assert.equal(old.links.length, 0); assert.equal(old.coverage.complete, false);
    assert.equal(fresh.inventory.links.length, 1); assert.equal(fresh.inventory.links[0].targetPathText, 'Other');
    assert.deepEqual(fresh.inventory.document, old.document); assert.deepEqual(fresh.inventory.version, old.version);
    assert.equal(fresh.legacyInventoryProof, proof(old)); assert.notEqual(fresh.inventoryProof, fresh.legacyInventoryProof);
    assert.equal(workspaceOperationSourceHtmlOccurrencesV5(actual.evidence).length, 0);
    assert.equal(workspaceOperationMixedSourceSnapshotV5(actual.evidence).coverage.complete, false);
  }
  groups++;

  {
    const nativeText = '\uFEFF---\r\ntitle: Native\r\n---\r\n😀 first\r\n<img src="one.png">\r<span>external</span>\n<custom-node></custom-node>';
    const physicalText = '\uFEFF---\r\ntitle: Physical\r\n---\r\n😀 first\r\n<img src="two.png">';
    const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [['native.md', nativeText]], raw: [['raw.md', physicalText], ['whole.html', '<unknown value="hidden.md">x</unknown>']] });
    const evidence = actual.evidence;
    for (const source of evidence.nativeComponent.htmlSources) {
      const locations = evidence.nativeHtmlSourceLocations.find(row => row.documentId === source.documentId)!;
      assert.equal(locations.locations.length, source.inspection.occurrences.length);
      source.inspection.occurrences.forEach((occurrence, index) => {
        assert.equal(nativeText.slice(occurrence.start, occurrence.end), occurrence.raw);
        assert.equal(locations.locations[index].line, nativeText.slice(0, occurrence.start).split(/\r\n|\r|\n/u).length);
      });
    }
    const physical = evidence.physicalSources4[0], locations = evidence.physicalHtmlSourceLocations[0];
    assert.equal(physical.hasBom, true); assert.equal(physical.lineEndings.crlf > 0, true);
    physical.htmlInspection.occurrences.forEach((occurrence, index) => {
      assert.equal(physicalText.slice(occurrence.start, occurrence.end), occurrence.raw);
      assert.equal(locations.locations[index].line, physicalText.slice(0, occurrence.start).split(/\r\n|\r|\n/u).length);
    });
    const normalized = workspaceOperationSourceHtmlOccurrencesV5(evidence);
    assert(normalized.some(occurrence => !occurrence.fullyInspected));
    assert(normalized.some(occurrence => occurrence.fullyInspected && occurrence.explicitLocalTargets.length === 0));
    assert(normalized.some(occurrence => occurrence.sourcePath === 'whole.html' && occurrence.line === 1));
    assertWorkspaceOperationMixedSourceEvidenceV5Current(evidence, actual.observation, actual.scope);
  }
  groups++;

  // Rehashed membership/identity/old-new proof omissions fail historical shape.
  for (const alter of [
    (item: Mutable<typeof value>) => { item.nativeOrdinarySources4.pop(); },
    (item: Mutable<typeof value>) => { item.nativeOrdinarySources4[0] = clone(item.nativeOrdinarySources4[1]); },
    (item: Mutable<typeof value>) => { item.nativeOrdinarySources4[0].legacyInventoryProof = '0'.repeat(64); },
    (item: Mutable<typeof value>) => { item.nativeOrdinarySources4[0].inventory.document.path = 'other.md'; item.nativeOrdinarySources4[0].inventoryProof = proof(item.nativeOrdinarySources4[0].inventory); },
    (item: Mutable<typeof value>) => { item.nativeOrdinarySources4[0].inventory.version.stateProof = '0'.repeat(64); item.nativeOrdinarySources4[0].inventoryProof = proof(item.nativeOrdinarySources4[0].inventory); },
    (item: Mutable<typeof value>) => { item.nativeOrdinarySources4[0].inventory.parserVersion = 2 as 4; item.nativeOrdinarySources4[0].inventoryProof = proof(item.nativeOrdinarySources4[0].inventory); },
    (item: Mutable<typeof value>) => { item.nativeHtmlSourceLocations.pop(); },
    (item: Mutable<typeof value>) => { item.physicalSources4.pop(); item.physicalHtmlSourceLocations.pop(); },
    (item: Mutable<typeof value>) => { item.physicalHtmlSources4.pop(); },
  ]) { const altered = clone(value); alter(altered); rejected(() => decodeWorkspaceOperationMixedSourceEvidenceV5(rehash(altered))); }
  groups++;

  // Rehashed facts cannot impersonate an actual AST-complete Current proof.
  {
    const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [['n.md', '[Other](other.md)']], raw: [] });
    const altered = clone(actual.evidence), source = altered.nativeOrdinarySources4[0];
    source.inventory.links = []; source.inventoryProof = proof(source.inventory);
    const historical = decodeWorkspaceOperationMixedSourceEvidenceV5(rehash(altered));
    rejected(() => assertWorkspaceOperationMixedSourceEvidenceV5Current(historical, actual.observation, actual.scope), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
    assert.equal(actual.evidence.nativeOrdinarySources4[0].inventory.links.length, 1);
  }
  groups++;

  {
    const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [['n.md', 'first\n\n<img src="x.png">']], raw: [] });
    const altered = clone(actual.evidence); altered.nativeHtmlSourceLocations[0].locations[0].line = 1;
    const historical = decodeWorkspaceOperationMixedSourceEvidenceV5(rehash(altered));
    rejected(() => assertWorkspaceOperationMixedSourceEvidenceV5Current(historical, actual.observation, actual.scope), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
  }
  groups++;

  // Original byte/vector/schema/CAS evidence cannot be supplied as a matching assertion.
  for (const alter of [
    (input: typeof fixture.observation) => { input.privateNativeStates[0].yjsState[0] ^= 1; },
    (input: typeof fixture.observation) => { input.privateNativeStates[0].stateVector[0] ^= 1; },
    (input: typeof fixture.observation) => { input.privateNativeStates[0].degraded = true; },
    (input: typeof fixture.observation) => { input.nativeBindings[0].expected.binaryHash = '0'.repeat(64); },
    (input: typeof fixture.observation) => { input.nativeBindings[0].lineage.lineageId = 'different-lineage'; },
    (input: typeof fixture.observation) => { input.privateCatalogue.pop(); },
    (input: typeof fixture.observation) => { input.privateNativeStates.push(clone(input.privateNativeStates[0])); },
    (input: typeof fixture.observation) => { const physical = input.stage.sources.find(source => source.kind === 'physical')!;
      assert.equal(physical.kind, 'physical'); if (physical.kind === 'physical') physical.inventory.originalBytes[0] ^= 1; },
  ]) { const input = clone(fixture.observation); alter(input); rejected(() => captureWorkspaceOperationMixedSourceEvidenceV5(fixture.scope, input)); }
  groups++;

  for (const alter of [
    (item: Mutable<typeof value>) => { item.physicalSources4[0].links.push({} as never); rehashPhysical(item.physicalSources4[0]); },
    (item: Mutable<typeof value>) => { item.physicalSources4[0].metadata.headings.push({ depth: 7, text: 'bad' }); rehashPhysical(item.physicalSources4[0]); },
    (item: Mutable<typeof value>) => { item.physicalHtmlSources4[0].htmlInspection.explicitLocalTargets = [5 as never];
      const { htmlSourceProof: _raw, ...body } = item.physicalHtmlSources4[0]; item.physicalHtmlSources4[0].htmlSourceProof = proof({ ...body, observedOriginalByteHash: body.physical.byteHash }); },
    (item: Mutable<typeof value>) => { item.physicalHtmlSourceLocations[0].path = 'wrong.md'; },
  ]) { const item = clone(value); alter(item); rejected(() => decodeWorkspaceOperationMixedSourceEvidenceV5(rehash(item))); }
  groups++;

  // New profile is strictly physical3/native2; neither an old2 relabel nor an
  // existing V3 complete DTO is a new5 original-source observation.
  {
    const input = clone(fixture.observation), source = input.stage.sources.find(source => source.kind === 'physical')!;
    assert.equal(source.kind, 'physical');
    if (source.kind === 'physical') source.inventory = inspectOriginalPhysicalLinks({ workspaceId: source.inventory.workspaceId,
      organizationId: source.inventory.organizationId, path: source.inventory.path, bytes: source.inventory.originalBytes,
      filesystemIdentity: source.inventory.physical.filesystemIdentity, authority: source.inventory.authority });
    input.stage.stageProof = workspaceSourceAuthorityStageProof(input.stage);
    rejected(() => captureWorkspaceOperationMixedSourceEvidenceV5(fixture.scope, input));
    const second = workspaceOperationMixedSourceEvidenceV5Fixture({ workspaceId: 'second-workspace', raw: [], native: [] });
    assert.equal(second.evidence.workspaceScope.workspaceId, 'second-workspace');
    assert.deepEqual(second.evidence.nativeOrdinarySources4, []);
    assert.deepEqual(second.evidence.physicalSources4, []);
    assertWorkspaceOperationMixedSourceEvidenceV5Current(second.evidence, second.observation, second.scope);
  }
  groups++;

  let getterCalls = 0;
  const hostile = clone(fixture.observation);
  Object.defineProperty(hostile, 'privateNativeStates', { enumerable: true, get: () => { getterCalls++; return []; } });
  rejected(() => captureWorkspaceOperationMixedSourceEvidenceV5(fixture.scope, hostile)); assert.equal(getterCalls, 0);
  const getterDto = clone(value);
  Object.defineProperty(getterDto.nativeOrdinarySources4[0], 'inventory', { enumerable: true, get: () => { getterCalls++; return {}; } });
  rejected(() => decodeWorkspaceOperationMixedSourceEvidenceV5(getterDto)); assert.equal(getterCalls, 0);
  rejected(() => decodeWorkspaceOperationMixedSourceEvidenceV5(new Proxy(value, {})));
  groups++;

  {
    const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [], native: [['n.md', '<img src="x.png">']] });
    const altered = clone(actual.evidence); altered.coverage = { complete: true, gaps: [] };
    rejected(() => decodeWorkspaceOperationMixedSourceEvidenceV5(rehash(altered)));
    if (typeof SharedArrayBuffer !== 'undefined') {
      for (const disguise of [false, true]) {
        const input = clone(actual.observation), original = input.privateNativeStates[0].yjsState;
        const backing = new SharedArrayBuffer(original.byteLength), bytes = new Uint8Array(backing); bytes.set(original);
        if (disguise) Object.setPrototypeOf(backing, ArrayBuffer.prototype);
        input.privateNativeStates[0].yjsState = bytes;
        rejected(() => captureWorkspaceOperationMixedSourceEvidenceV5(actual.scope, input));
      }
    }
  }
  groups++;

  // Replaceable registry/projection clocks and a directory's own mtime do not
  // leak the raw component/stage proof back into semantic5.
  {
    const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [['folder/n.md', '# Note']], raw: [['raw.md', '# Raw']], documentSequence: 1 });
    const input = clone(actual.observation);
    for (const binding of input.nativeBindings) { binding.expected.registryStateVersion++; binding.registry.stateVersion++; }
    for (const row of input.privateCatalogue) row.state_version++;
    const catalogueProof = proof(input.privateCatalogue); input.stage.catalogueProof = catalogueProof;
    for (const source of input.stage.sources) if (source.kind === 'physical') {
      source.inventory = inspectOriginalPhysicalLinksV3({ workspaceId: source.inventory.workspaceId,
        organizationId: source.inventory.organizationId, path: source.inventory.path, bytes: source.inventory.originalBytes,
        authority: { ...source.inventory.authority, catalogueProof }, filesystemIdentity: source.inventory.physical.filesystemIdentity });
    }
    for (const entry of input.stage.namespace) if (entry.kind === 'directory' && entry.filesystemIdentity) {
      const parts = entry.filesystemIdentity.split(':'); parts[3] = '101'; parts[4] = '101';
      entry.identity = entry.filesystemIdentity = parts.join(':');
    }
    input.stage.stageProof = workspaceSourceAuthorityStageProof(input.stage);
    const current = captureWorkspaceOperationMixedSourceEvidenceV5(actual.scope, input);
    assert.deepEqual(input.privateNativeStates, actual.observation.privateNativeStates);
    assert.deepEqual(current.nativeOrdinarySources4, actual.evidence.nativeOrdinarySources4);
    assert.notEqual(current.evidenceProof, actual.evidence.evidenceProof);
    assert.equal(current.semanticProof, actual.evidence.semanticProof);
    assertWorkspaceOperationMixedSourceEvidenceV5Current(actual.evidence, input, actual.scope);
  }
  groups++;

  // Aggregate metadata and actual private payload limits precede clone/parse.
  {
    const input = clone(fixture.observation);
    input.privateNativeStates[0].yjsState = new Uint8Array(16 * 1024 * 1024 + 1);
    rejected(() => captureWorkspaceOperationMixedSourceEvidenceV5(fixture.scope, input), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    const metadata = clone(fixture.observation), large = 'x'.repeat(4 * 1024 * 1024);
    for (const state of metadata.privateNativeStates) state.canonicalHash = large;
    rejected(() => captureWorkspaceOperationMixedSourceEvidenceV5(fixture.scope, metadata), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  }
  groups++;

  // Both actual Rich binary representations share the original typed snapshot
  // seam; paired parser4 facts must preserve their refs without Markdown export.
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const actual = v3EvidenceFixture(representation), originalStates = actual.observation.privateNativeStates.map(state => ({
      id: state.documentId, binary: sha(state.yjsState), vector: sha(state.stateVector) }));
    actual.observation.stage.sources = actual.observation.stage.sources.map(source => source.kind === 'native' ? source : ({
      kind: 'physical', inventory: inspectOriginalPhysicalLinksV3({ workspaceId: source.inventory.workspaceId,
        organizationId: source.inventory.organizationId, path: source.inventory.path, bytes: source.inventory.originalBytes,
        filesystemIdentity: source.inventory.physical.filesystemIdentity, authority: source.inventory.authority }) }));
    const gaps = actual.observation.stage.sources.flatMap(source => source.kind === 'native'
      ? source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })) : source.inventory.coverage.gaps);
    actual.observation.stage.coverage = { complete: !gaps.length, gaps };
    actual.observation.stage.readiness = gaps.length ? 'blocked' : 'requires-import-and-rebinding';
    actual.observation.stage.stageProof = workspaceSourceAuthorityStageProof(actual.observation.stage);
    const evidence = captureWorkspaceOperationMixedSourceEvidenceV5(actual.scope, actual.observation);
    assert(evidence.nativeOrdinarySources4.some(row => row.inventory.document.representation === representation));
    for (const source of evidence.nativeOrdinarySources4) {
      const legacy = evidence.nativeComponent.stage.sources.find(row => row.inventory.document.documentId === source.documentId)!.inventory;
      assert.deepEqual(source.inventory.document, legacy.document); assert.deepEqual(source.inventory.version, legacy.version);
      assert.deepEqual(source.inventory.links, legacy.links);
    }
    assert(evidence.nativeHtmlSourceLocations.every(row => row.locations.length === 0));
    assert.deepEqual(actual.observation.privateNativeStates.map(state => ({ id: state.documentId,
      binary: sha(state.yjsState), vector: sha(state.stateVector) })), originalStates);
    assertWorkspaceOperationMixedSourceEvidenceV5Current(evidence, actual.observation, actual.scope);
  }
  groups++;

  // Identity and clocks returned by the original binary remain exactly bound.
  for (const state of fixture.observation.privateNativeStates) {
    const expected = value.nativeComponent.nativeBindings.find(binding => binding.expected.documentId === state.documentId)!.expected;
    assert.equal(sha(state.yjsState), expected.binaryHash); assert.equal(sha(state.stateVector), expected.vectorHash);
    const fresh = value.nativeOrdinarySources4.find(source => source.documentId === state.documentId)!.inventory;
    assert.equal(fresh.version.documentSequence, state.documentSequence); assert.equal(fresh.version.persistedAt, state.persistedAt);
    assert(isDeepStrictEqual(fresh.version, inspectPersistedDocumentLinks(state).version));
  }
  groups++;
  assert.equal(groups, 16);
  console.log(JSON.stringify({ suite: 'mixed-source-evidence-v5', groups, factsOnly: true, executionAuthority: false }));
}
