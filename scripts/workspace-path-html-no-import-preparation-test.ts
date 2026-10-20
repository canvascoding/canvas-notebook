import assert from 'node:assert/strict';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { createWorkspacePathHtmlNoImportPreparationPlanV2, decodeWorkspacePathHtmlNoImportPreparationPlanV2,
  WorkspacePathHtmlNoImportPreparationError, type WorkspacePathHtmlNoImportPreparationPlanV2 }
  from '../app/lib/files/workspace-path-html-no-import-preparation';
import { createWorkspacePathImportPreparationPlanV1, decodeWorkspacePathImportPreparationPlanV1 }
  from '../app/lib/files/workspace-path-import-preparation-plan';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

type Fixture = ReturnType<typeof workspaceOperationMixedSourceEvidenceV5Fixture>;
type Input = Parameters<typeof createWorkspacePathHtmlNoImportPreparationPlanV2>[0];
type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;

/** Pure routing/codec cases with actual Yjs/UTF-8 facts. No tests autorun on
 * import, and no SQL, filesystem authority, B0 or execution grant is simulated. */
export function workspacePathHtmlNoImportPreparationTest(): void {
  let groups = 0;
  const create = (fixture: Fixture, selections: Input['selections'] = [{ sourcePath: 'Move.md', destinationPath: 'Dest/Moved.md' }],
    kind: Input['kind'] = 'move') => createWorkspacePathHtmlNoImportPreparationPlanV2({
      scope: fixture.scope, kind, selections, observation: fixture.observation,
    });
  const native = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['Move.md', '# Move\n'], ['HTML.md', '# Heading\n\n<img src="assets/stable.png">\n']],
    extra: [{ path: 'Dest', kind: 'directory' }, { path: 'assets/stable.png', kind: 'file' }] });

  // A complete operation-specific HTML assessment never changes the original
  // false Stage1 coverage or tags the old parser/inventory as version4.
  const before = clone(native.observation), plan = create(native);
  assert.equal(plan.version, 2); assert.equal(plan.sourceEvidence.evidenceVersion, 5);
  assert.equal(plan.executionReady, false); assert.equal(plan.readiness, 'native-ready');
  assert.deepEqual(plan.coverage, before.stage.coverage); assert.equal(plan.coverage.complete, false);
  assert.equal(plan.linkAssessment.complete, true); assert.deepEqual(plan.requiredRawImports, []);
  assert.deepEqual(plan.issues, []); assert.equal(plan.linkAssessment.warnings[0].sourcePath, 'HTML.md');
  assert.deepEqual(plan.sourceEvidence.nativeComponent.stage.sources.map(source => source.inventory.parserVersion), [2, 2]);
  assert.deepEqual(native.observation, before); assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.linkAssessment));
  assert(!JSON.stringify(plan).includes('originalBytes')); assert(!JSON.stringify(plan).includes('yjsState'));
  groups++;

  // Rename takes the same explicit facts-only arm. The next ordinary public
  // planner must still bind the actual final plan before any action runs.
  const renamed = create(native, [{ sourcePath: 'Move.md', destinationPath: 'Renamed.md' }], 'rename');
  assert.equal(renamed.readiness, 'native-ready'); assert.notEqual(renamed.planId, plan.planId);
  assert.deepEqual(renamed.coverage, plan.coverage); assert.deepEqual(renamed.requiredRawImports, []);
  groups++;

  // Unselected whole HTML files remain separate physical read sources and do
  // not become notebook imports just because their bytes were inspected.
  const physical = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [['page.html', '<img src="stable.png">\n']],
    native: [['Move.md', '# Move\n']], extra: [{ path: 'stable.png', kind: 'file' }, { path: 'Dest', kind: 'directory' }] });
  const physicalPlan = create(physical);
  assert.equal(physicalPlan.readiness, 'native-ready'); assert.equal(physicalPlan.sourceEvidence.physicalHtmlSources4.length, 1);
  assert.equal(physicalPlan.sourceEvidence.physicalSources4.length, 0); assert.deepEqual(physicalPlan.requiredRawImports, []);
  assert.equal(physicalPlan.linkAssessment.warnings[0].sourcePath, 'page.html');
  groups++;

  // Unselected physical Markdown can remain a read-side source when neither
  // its ordinary links nor its inspected HTML depend on the selected move.
  const rawReader = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [['Raw.md', '# Raw\n\n<img src="stable.png">\n']],
    native: [['Move.md', '# Move\n']], extra: [{ path: 'stable.png', kind: 'file' }, { path: 'Dest', kind: 'directory' }] });
  const rawReaderPlan = create(rawReader);
  assert.equal(rawReaderPlan.readiness, 'native-ready'); assert.deepEqual(rawReaderPlan.requiredRawImports, []);
  assert.equal(rawReaderPlan.sourceEvidence.physicalSources4.length, 1); assert.equal(rawReaderPlan.coverage.complete, false);
  groups++;

  // An affected HTML target retains its exact bound diagnostics, including
  // line and target list. No silent HTML mutation recipe is fabricated.
  const affected = create(native, [{ sourcePath: 'assets/stable.png', destinationPath: 'Dest/stable.png' }]);
  assert.equal(affected.readiness, 'blocked'); assert.equal(affected.linkAssessment.complete, false);
  assert.deepEqual(affected.linkAssessment.blockers, [{ workspaceId: native.scope.workspaceId, sourcePath: 'HTML.md',
    targetLiteral: 'assets/stable.png', status: 'not-evaluated', reason: 'affected-html-link',
    htmlTargets: ['assets/stable.png'], line: 3 }]);
  assert(affected.issues.some(issue => issue.code === 'affected-html-link' && issue.path === 'HTML.md'));
  groups++;

  // Selected zero-link raw Markdown still requires real native initialization
  // and rebinding. This no-import version explicitly blocks that path.
  const selectedRaw = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [['Raw.md', '# Raw\n']],
    native: [['HTML.md', '<img src="stable.png">\n']],
    extra: [{ path: 'Dest', kind: 'directory' }, { path: 'stable.png', kind: 'file' }] });
  const selectedRawPlan = create(selectedRaw, [{ sourcePath: 'Raw.md', destinationPath: 'Dest/Raw.md' }]);
  assert.equal(selectedRawPlan.readiness, 'blocked'); assert.equal(selectedRawPlan.executionReady, false);
  assert.equal(selectedRawPlan.coverage.complete, false, 'The later coverage forgery must change an actual incomplete fact');
  assert.deepEqual(selectedRawPlan.requiredRawImports, [{ path: 'Raw.md', reasons: ['selected'] }]);
  assert(selectedRawPlan.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === 'Raw.md'));
  groups++;

  // An unselected physical ordinary backlink requiring a rewrite cannot be
  // dropped to let a native-only selected target pass this early preview.
  const backlink = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [['Raw.md', '[Move](Move.md)\n']],
    native: [['Move.md', '# Move\n'], ['HTML.md', '<img src="stable.png">\n']],
    extra: [{ path: 'stable.png', kind: 'file' }, { path: 'Dest', kind: 'directory' }] });
  const backlinkPlan = create(backlink);
  assert.equal(backlinkPlan.readiness, 'blocked');
  assert.deepEqual(backlinkPlan.requiredRawImports, [{ path: 'Raw.md', reasons: ['link-change'] }]);
  assert(backlinkPlan.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === 'Raw.md' && issue.linkId));
  groups++;

  // Directory selections include descendant originals, including zero-link
  // Markdown, while a physical HTML file is never listed as a Markdown birth.
  const directory = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [['Folder/Raw.md', '# Raw\n'], ['Folder/page.html', '<p>Text</p>\n']],
    native: [['HTML.md', '<p>Text</p>\n']], extra: [{ path: 'Folder', kind: 'directory' }, { path: 'Dest', kind: 'directory' }] });
  const directoryPlan = create(directory, [{ sourcePath: 'Folder', destinationPath: 'Dest/Folder' }]);
  assert.equal(directoryPlan.readiness, 'blocked');
  assert.deepEqual(directoryPlan.requiredRawImports, [{ path: 'Folder/Raw.md', reasons: ['selected'] }]);
  groups++;

  // Unknown HTML has no certificate merely because the known-target list is
  // empty. An unrelated move remains blocked with its original line.
  const unknown = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [], native: [['Move.md', '# Move\n'],
    ['HTML.md', '<custom-element></custom-element>\n']], extra: [{ path: 'Dest', kind: 'directory' }] });
  const unknownPlan = create(unknown);
  assert.equal(unknownPlan.readiness, 'blocked'); assert.equal(unknownPlan.linkAssessment.complete, false);
  assert(unknownPlan.linkAssessment.blockers.some(item => item.reason === 'unevaluated-link' && item.line === 1));
  groups++;

  // Historical decoding replays the complete derived facts, independently of
  // whether supplied hashes were recalculated after malicious field changes.
  assert.deepEqual(decodeWorkspacePathHtmlNoImportPreparationPlanV2(JSON.parse(JSON.stringify(plan))), plan);
  assert.deepEqual(decodeWorkspacePathHtmlNoImportPreparationPlanV2(JSON.parse(JSON.stringify(selectedRawPlan))), selectedRawPlan);
  const rehash = (value: Mutable<WorkspacePathHtmlNoImportPreparationPlanV2>): void => {
    const { planId: _planId, integrityProof: _integrityProof, ...body } = value;
    value.planId = proof({ ...body, sourceEvidence: value.sourceEvidence.semanticProof });
    value.integrityProof = proof({ ...body, planId: value.planId });
  };
  for (const corrupt of [
    (value: Mutable<WorkspacePathHtmlNoImportPreparationPlanV2>) => { value.readiness = 'native-ready'; },
    (value: Mutable<WorkspacePathHtmlNoImportPreparationPlanV2>) => { value.requiredRawImports = []; },
    (value: Mutable<WorkspacePathHtmlNoImportPreparationPlanV2>) => { value.coverage = { complete: true, gaps: [] }; },
    (value: Mutable<WorkspacePathHtmlNoImportPreparationPlanV2>) => { value.issues = []; },
  ]) {
    const forged = clone(selectedRawPlan); corrupt(forged); rehash(forged);
    assert.throws(() => decodeWorkspacePathHtmlNoImportPreparationPlanV2(forged), WorkspacePathHtmlNoImportPreparationError);
  }
  const forgedAssessment = clone(plan); forgedAssessment.linkAssessment.warnings[0].targetLiteral = 'different.png'; rehash(forgedAssessment);
  assert.throws(() => decodeWorkspacePathHtmlNoImportPreparationPlanV2(forgedAssessment), WorkspacePathHtmlNoImportPreparationError);
  groups++;

  // Request capture rejects malformed shapes before any getters execute. The
  // actual Evidence5 capture independently validates observation/state facts.
  const input: Input = { scope: native.scope, kind: 'move', selections: [{ sourcePath: 'Move.md', destinationPath: 'Moved.md' }],
    observation: native.observation };
  let getterCalls = 0;
  const getterInput = { ...input };
  Object.defineProperty(getterInput, 'scope', { enumerable: true, get: () => { getterCalls++; return native.scope; } });
  assert.throws(() => createWorkspacePathHtmlNoImportPreparationPlanV2(getterInput), WorkspacePathHtmlNoImportPreparationError);
  assert.equal(getterCalls, 0);
  assert.throws(() => createWorkspacePathHtmlNoImportPreparationPlanV2(new Proxy(input, {})), WorkspacePathHtmlNoImportPreparationError);
  for (const invalid of [
    { ...input, kind: 'delete' }, { ...input, extra: true },
    { ...input, selections: [{ sourcePath: 'Move.md', destinationPath: '../Moved.md' }] },
    { ...input, selections: [{ sourcePath: 'Move.md' }] },
    { ...input, scope: { ...input.scope, workspaceId: 'other-workspace' } },
  ]) assert.throws(() => createWorkspacePathHtmlNoImportPreparationPlanV2(invalid as Input));
  groups++;

  // The historical complete-coverage preparation and its decoder keep their
  // original version1 contract. Neither accepts this new early version2 DTO.
  const legacy = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [], native: [['Move.md', '# Move\n']] });
  const legacyPlan = createWorkspacePathImportPreparationPlanV1({ scope: legacy.scope, kind: 'move',
    selections: [{ sourcePath: 'Move.md', destinationPath: 'Moved.md' }], observation: legacy.observation });
  assert.equal(legacyPlan.version, 1); assert.equal(legacyPlan.readiness, 'native-ready');
  assert.equal(legacyPlan.coverage.complete, true); assert.deepEqual(decodeWorkspacePathImportPreparationPlanV1(legacyPlan), legacyPlan);
  assert.throws(() => decodeWorkspacePathImportPreparationPlanV1(plan));
  assert.throws(() => decodeWorkspacePathHtmlNoImportPreparationPlanV2(legacyPlan), WorkspacePathHtmlNoImportPreparationError);
  groups++;

  console.log(`workspace HTML no-import preparation: ${groups} families passed`);
}
