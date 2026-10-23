import assert from 'node:assert/strict';
import { captureWorkspaceOperationNativeSourceEvidence, captureWorkspaceOperationNativeSourceEvidenceV2,
  decodeWorkspaceOperationNativeSourceEvidence, captureWorkspaceOperationNativeHtmlSourceEvidenceV4,
  decodeWorkspaceOperationNativeHtmlSourceEvidenceV4, assertWorkspaceOperationNativeHtmlSourceEvidenceV4Current,
  WorkspaceOperationNativeSourceEvidenceError, type WorkspaceOperationNativeHtmlSourceEvidenceV4 }
  from '../app/lib/files/workspace-operation-native-source-evidence';
import { captureWorkspaceOperationNativeSourceEvidenceV3 } from '../app/lib/files/workspace-operation-native-source-evidence-v3';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import { workspacePathImportPreparationFixture } from './workspace-path-import-preparation-plan-test';
import { v3EvidenceFixture, workspaceOperationNativeSourceEvidenceV3Test } from './workspace-operation-native-source-evidence-v3-test';
import { workspaceMarkdownHtmlOccurrenceTest } from './workspace-markdown-html-occurrence-test';

type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
type Fixture = ReturnType<typeof workspacePathImportPreparationFixture>;

function refresh(fixture: Fixture): void {
  const stage = fixture.observation.stage;
  const gaps = stage.sources.flatMap(source => source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })));
  stage.coverage = { complete: gaps.length === 0, gaps };
  stage.readiness = gaps.length ? 'blocked' : 'native-coordinator-required';
  stage.catalogueProof = proof(fixture.observation.privateCatalogue);
  stage.stageProof = workspaceSourceAuthorityStageProof(stage);
}
function fixture(text = '<img src="assets/stable.png">\n'): Fixture {
  const result = workspacePathImportPreparationFixture({ raw: [], native: [['note.md', text], ['keep.md', '# Keep\n']] });
  refresh(result); return result;
}
function rejected(action: () => unknown, code = 'NATIVE_SOURCE_EVIDENCE_INVALID'): void {
  assert.throws(action, error => error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === code && error.status === 409);
}

/** An attacker may recalculate every transport hash. This independently applies
 * the published clock/projection normalization to demonstrate why a historical
 * decode is facts-only and the actual same-binary Current check is mandatory. */
function rehash(value: Mutable<WorkspaceOperationNativeHtmlSourceEvidenceV4>): WorkspaceOperationNativeHtmlSourceEvidenceV4 {
  const stage = clone(value.stage), bindings = clone(value.nativeBindings);
  const { stageProof: _rawStageProof, ...stageFields } = stage;
  const namespace = stageFields.namespace.map(entry => {
    if (entry.kind === 'file' && entry.documentId !== null) return { ...entry, filesystemIdentity: null };
    if (entry.kind === 'directory' && entry.filesystemIdentity !== null) {
      const [device, inode] = entry.filesystemIdentity.split(':');
      return { ...entry, identity: `directory:${device}:${inode}`, filesystemIdentity: null };
    }
    return entry;
  });
  value.semanticProof = proof({ semanticVersion: 4, workspaceScope: value.workspaceScope,
    stage: { ...stageFields, namespace, catalogueProof: value.semanticCatalogueProof },
    nativeBindings: bindings.map(binding => ({ ...binding, expected: { ...binding.expected, registryStateVersion: 0 },
      registry: { ...binding.registry, stateVersion: 0 } })), htmlSources: value.htmlSources });
  const { evidenceProof: _rawEvidenceProof, ...body } = value;
  value.evidenceProof = proof(body); return value;
}

function nativeHtmlSourceEvidenceTest(): void {
  let groups = 0;
  const input = fixture(), before = clone(input.observation);
  const evidence = captureWorkspaceOperationNativeHtmlSourceEvidenceV4(input.scope, input.observation);
  assert.equal(evidence.evidenceVersion, 4);
  assert.equal(evidence.stage.coverage.complete, false);
  assert.deepEqual(evidence.stage.coverage, input.observation.stage.coverage);
  assert.equal(evidence.stage.readiness, 'blocked');
  assert.equal(evidence.htmlSources.length, input.observation.nativeBindings.length);
  assert.deepEqual(evidence.htmlSources.find(source => source.path === 'keep.md')?.inspection, { parserVersion: 4, occurrences: [] });
  assert.deepEqual(evidence.htmlSources.find(source => source.path === 'note.md')?.inspection.occurrences.map(value => value.explicitLocalTargets), [['assets/stable.png']]);
  assert.deepEqual(input.observation, before);
  assert(Object.isFrozen(evidence)); assert(Object.isFrozen(evidence.htmlSources[0].inspection.occurrences));
  assert.deepEqual(decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(JSON.parse(JSON.stringify(evidence))), evidence);
  assertWorkspaceOperationNativeHtmlSourceEvidenceV4Current(evidence, input.observation, input.scope);
  groups++;

  // Existing contracts keep their original rejection and cannot inherit V4 facts.
  rejected(() => captureWorkspaceOperationNativeSourceEvidence(input.scope, input.observation));
  rejected(() => captureWorkspaceOperationNativeSourceEvidenceV2(input.scope, input.observation));
  rejected(() => captureWorkspaceOperationNativeSourceEvidenceV3(input.scope, input.observation));
  rejected(() => decodeWorkspaceOperationNativeSourceEvidence(evidence));
  groups++;

  // Unknown HTML with no old gap remains explicit incomplete syntax inspection;
  // this component never turns that fact into operation readiness.
  for (const text of ['<custom-element resource="hidden.png"></custom-element>',
    '<div custom-resource="hidden.md">Text</div>', '<img src="stable.png" onerror="this.src=\'hidden.png\'">',
    '[<custom-element resource="hidden.png">Label</custom-element>](keep.md)']) {
    const actual = fixture(text), value = captureWorkspaceOperationNativeHtmlSourceEvidenceV4(actual.scope, actual.observation);
    const occurrences = value.htmlSources.find(source => source.path === 'note.md')!.inspection.occurrences;
    assert(occurrences.length > 0); assert(occurrences.some(occurrence => !occurrence.fullyInspected));
    assert.equal(Object.hasOwn(value, 'executionReady'), false);
  }
  groups++;

  // Parser 2 inventories and parser 4 visible grammar are independently bound:
  // Wiki literals and corrected BOM offsets must not rewrite old inventory gaps.
  for (const text of ['[[Note|<img src="wiki-alias.png">]]', '\uFEFF<img src="asset.png">',
    '\uFEFF---\r\ntitle: Example\r\n---\r\n\r\n😀 <img src="asset.png">']) {
    const actual = fixture(text), original = clone(actual.observation.stage.sources);
    const value = captureWorkspaceOperationNativeHtmlSourceEvidenceV4(actual.scope, actual.observation);
    assert.deepEqual(value.stage.sources, original);
    const occurrences = value.htmlSources.find(source => source.path === 'note.md')!.inspection.occurrences;
    if (text.startsWith('[[')) assert.equal(occurrences.length, 0);
    else for (const occurrence of occurrences) assert.equal(text.slice(occurrence.start, occurrence.end), occurrence.raw);
    assertWorkspaceOperationNativeHtmlSourceEvidenceV4Current(value, actual.observation, actual.scope);
  }
  const nested = fixture('[<img src="nested.png">](keep.md)');
  const nestedEvidence = captureWorkspaceOperationNativeHtmlSourceEvidenceV4(nested.scope, nested.observation);
  assert.deepEqual(nestedEvidence.htmlSources.find(source => source.path === 'note.md')!.inspection.occurrences
    .flatMap(occurrence => occurrence.explicitLocalTargets), ['nested.png']);
  groups++;

  // Exact global coverage includes every original source gap and its multiplicity.
  for (const alter of [
    (actual: Fixture) => { actual.observation.stage.coverage = { complete: true, gaps: [] }; },
    (actual: Fixture) => { actual.observation.stage.coverage.gaps.push({ ...actual.observation.stage.coverage.gaps[0] }); },
    (actual: Fixture) => { actual.observation.stage.coverage.gaps[0].path = 'keep.md'; },
  ]) {
    const actual = fixture(); alter(actual); actual.observation.stage.stageProof = workspaceSourceAuthorityStageProof(actual.observation.stage);
    rejected(() => captureWorkspaceOperationNativeHtmlSourceEvidenceV4(actual.scope, actual.observation));
  }
  groups++;

  // No missing witness, catalogue forgery, hidden state or altered byte payload.
  const noWitness = { stage: input.observation.stage, nativeBindings: input.observation.nativeBindings,
    privateNativeStates: input.observation.privateNativeStates };
  rejected(() => captureWorkspaceOperationNativeHtmlSourceEvidenceV4(input.scope, noWitness));
  for (const alter of [
    (actual: Fixture) => { actual.observation.privateCatalogue.pop(); },
    (actual: Fixture) => { actual.observation.privateNativeStates[0].yjsState[0] ^= 1; },
    (actual: Fixture) => { actual.observation.privateNativeStates[0].stateVector[0] ^= 1; },
    (actual: Fixture) => { actual.observation.privateNativeStates.push(clone(actual.observation.privateNativeStates[0])); },
  ]) { const actual = fixture(); alter(actual); rejected(() => captureWorkspaceOperationNativeHtmlSourceEvidenceV4(actual.scope, actual.observation)); }
  groups++;

  // All HTML-source and occurrence records are exact, bounded data descriptors.
  for (const alter of [
    (value: Mutable<typeof evidence>) => { value.htmlSources.pop(); },
    (value: Mutable<typeof evidence>) => { value.htmlSources[0] = clone(value.htmlSources[1]); },
    (value: Mutable<typeof evidence>) => { value.htmlSources[0].path = 'other.md'; },
    (value: Mutable<typeof evidence>) => { value.htmlSources[0].inventoryProof = '0'.repeat(64); },
    (value: Mutable<typeof evidence>) => { value.htmlSources[0].inspection.parserVersion = 3 as 4; },
    (value: Mutable<typeof evidence>) => { const occurrence = value.htmlSources.find(source => source.path === 'note.md')!.inspection.occurrences[0]; occurrence.end++; },
    (value: Mutable<typeof evidence>) => { const occurrence = value.htmlSources.find(source => source.path === 'note.md')!.inspection.occurrences[0]; occurrence.fullyInspected = false; },
  ]) { const value = clone(evidence); alter(value); rejected(() => decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(rehash(value))); }
  groups++;

  // Rehashed plausible offsets remain historical facts, but cannot become Current.
  const forged = clone(evidence), moved = forged.htmlSources.find(source => source.path === 'note.md')!.inspection.occurrences[0];
  moved.start++; moved.end++;
  const decoded = decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(rehash(forged));
  rejected(() => assertWorkspaceOperationNativeHtmlSourceEvidenceV4Current(decoded, input.observation, input.scope), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
  const omitted = clone(evidence); omitted.htmlSources.find(source => source.path === 'note.md')!.inspection.occurrences = [];
  const historicalOmission = decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(rehash(omitted));
  rejected(() => assertWorkspaceOperationNativeHtmlSourceEvidenceV4Current(historicalOmission, input.observation, input.scope), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
  groups++;

  let accessorCalls = 0;
  const hostile = clone(input.observation);
  Object.defineProperty(hostile, 'privateNativeStates', { enumerable: true, get: () => { accessorCalls++; return []; } });
  rejected(() => captureWorkspaceOperationNativeHtmlSourceEvidenceV4(input.scope, hostile));
  assert.equal(accessorCalls, 0);
  groups++;

  // Rich states stay binary inspections with empty HTML facts, including actual
  // content that cannot be exported as portable Markdown.
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const actual = v3EvidenceFixture(representation), physical = new Set(actual.observation.stage.sources
      .flatMap(source => source.kind === 'physical' ? [source.inventory.path] : []));
    actual.observation.stage.sources = actual.observation.stage.sources.filter(source => source.kind === 'native');
    actual.observation.stage.namespace = actual.observation.stage.namespace.filter(entry => !physical.has(entry.path));
    actual.observation.privateCatalogue = actual.observation.privateCatalogue.filter(row => row.authority === 'initialized');
    actual.observation.stage.catalogueProof = proof(actual.observation.privateCatalogue);
    actual.observation.stage.readiness = 'native-coordinator-required';
    actual.observation.stage.stageProof = workspaceSourceAuthorityStageProof(actual.observation.stage);
    const value = captureWorkspaceOperationNativeHtmlSourceEvidenceV4(actual.scope, actual.observation);
    assert(value.htmlSources.every(source => source.inspection.occurrences.length === 0));
    assertWorkspaceOperationNativeHtmlSourceEvidenceV4Current(value, actual.observation, actual.scope);
  }
  groups++;
  // Workspace budgets span documents, before the next document can allocate
  // an additional target/occurrence beyond the fixed remaining allowance.
  for (const text of ['<div>' + '<img src="stable.png">'.repeat(10_001) + '</div>', '<br>\n\n'.repeat(10_001)]) {
    const actual = workspacePathImportPreparationFixture({ raw: [], native: [['one.md', text], ['two.md', text]] });
    refresh(actual);
    rejected(() => captureWorkspaceOperationNativeHtmlSourceEvidenceV4(actual.scope, actual.observation), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  }
  groups++;
  assert.equal(groups, 11);
  console.log(JSON.stringify({ suite: 'native-html-source-evidence', groups, factsOnly: true, executionAuthority: false }));
}

workspaceMarkdownHtmlOccurrenceTest();
workspaceOperationNativeSourceEvidenceV3Test();
nativeHtmlSourceEvidenceTest();
