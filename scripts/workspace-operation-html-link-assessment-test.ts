import assert from 'node:assert/strict';
import { assessWorkspaceOperationHtmlLinksV1 } from '../app/lib/files/workspace-operation-html-link-assessment';
import { workspaceOperationSourceHtmlOccurrencesV5 } from '../app/lib/files/workspace-operation-mixed-source-evidence-v5';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

type Input = Parameters<typeof assessWorkspaceOperationHtmlLinksV1>[0];
type Fixture = ReturnType<typeof workspaceOperationMixedSourceEvidenceV5Fixture>;
type Kind = 'move' | 'rename' | 'copy' | 'delete';

/** Real Yjs/UTF-8 captures are facts-only fixtures, never SQL, FD or principal
 * evidence. Importing this module does not execute its assertions. */
export function workspaceOperationHtmlLinkAssessmentTest(): void {
  let groups = 0;
  const html = '# Title\n\n## HTML\n\n<img src="assets/stable.png" alt="Fixture">\n';
  const make = (fixture: Fixture, kind: Kind, selections: Input['request']['selections'], destination?: Fixture): Input => ({
    request: { kind, sourceWorkspaceId: fixture.scope.workspaceId,
      destinationWorkspaceId: destination?.scope.workspaceId ?? fixture.scope.workspaceId, selections },
    pathMappings: kind === 'delete' ? [] : fixture.evidence.namespace.flatMap(entry => {
      const selection = selections.find(value => entry.path === value.sourcePath || entry.path.startsWith(`${value.sourcePath}/`));
      return selection ? [{ sourceWorkspaceId: fixture.scope.workspaceId, sourcePath: entry.path,
        destinationWorkspaceId: destination?.scope.workspaceId ?? fixture.scope.workspaceId,
        destinationPath: selection.destinationPath + entry.path.slice(selection.sourcePath.length), sourceIdentity: entry.identity }] : [];
    }), sourceEvidence: fixture.evidence, ...(destination ? { destinationEvidence: destination.evidence } : {}),
  });
  const invalid = (input: Input): void => assert.throws(() => assessWorkspaceOperationHtmlLinksV1(input),
    error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_HTML_ASSESSMENT_INVALID');
  const selected = [{ sourcePath: 'Move.md', destinationPath: 'Dest/Moved.md' }];
  const native = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['HTML.md', html], ['Move.md', '# Move\n']],
    extra: [{ path: 'assets/stable.png', kind: 'file' }, { path: 'Dest', kind: 'directory' }] });

  // 1. Every no-change proof is tied to actual captured sources. Original
  // incomplete HTML coverage and exact line five are retained, not rewritten.
  assert.equal(native.evidence.coverage.complete, false);
  assert.deepEqual(workspaceOperationSourceHtmlOccurrencesV5(native.evidence).filter(value => value.sourcePath === 'HTML.md'), [
    { sourcePath: 'HTML.md', line: 5, fullyInspected: true, explicitLocalTargets: ['assets/stable.png'] },
  ]);
  for (const kind of ['move', 'rename', 'copy'] as const) {
    const input = make(native, kind, selected), before = structuredClone(input);
    const assessment = assessWorkspaceOperationHtmlLinksV1(input);
    assert.deepEqual(assessment, { version: 1, complete: true, blockers: [], warnings: [{ workspaceId: native.scope.workspaceId,
      sourcePath: 'HTML.md', targetLiteral: 'assets/stable.png', status: 'not-evaluated',
      reason: 'unaffected-explicit-html-link', htmlTargets: ['assets/stable.png'] }] });
    assert.deepEqual(input, before); assert.equal(input.sourceEvidence.coverage.complete, false);
    assert(Object.isFrozen(assessment)); assert(Object.isFrozen(assessment.warnings));
    assert(Object.isFrozen(assessment.warnings[0].htmlTargets));
  }
  groups++;

  // 2. Actual physical Markdown remains a read-side source for unrelated moves
  // and copies; assessment invents no imports, document IDs or rewritten bytes.
  const physical = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [['Move.md', '# Move\n']],
    raw: [['HTML.md', html]], extra: [{ path: 'assets/stable.png', kind: 'file' }, { path: 'Dest', kind: 'directory' }] });
  const physicalBefore = structuredClone(physical.evidence);
  for (const kind of ['move', 'rename', 'copy'] as const) {
    const assessment = assessWorkspaceOperationHtmlLinksV1(make(physical, kind, selected));
    assert.equal(assessment.complete, true); assert.deepEqual(assessment.blockers, []);
    assert.equal(assessment.warnings[0].sourcePath, 'HTML.md');
    assert.deepEqual(assessment.warnings[0].htmlTargets, ['assets/stable.png']);
  }
  assert.deepEqual(physical.evidence, physicalBefore);
  groups++;

  // 3. Relocating or cloning the referring HTML source is protected, with the
  // exact existing diagnostic fields; no HTML rewrite is fabricated.
  for (const fixture of [native, physical]) for (const kind of ['move', 'copy'] as const) {
    const assessment = assessWorkspaceOperationHtmlLinksV1(make(fixture, kind, [
      { sourcePath: 'HTML.md', destinationPath: 'Dest/HTML.md' },
    ]));
    assert.equal(assessment.complete, false); assert.deepEqual(assessment.warnings, []);
    assert.deepEqual(assessment.blockers, [{ workspaceId: fixture.scope.workspaceId, sourcePath: 'HTML.md',
      targetLiteral: 'assets/stable.png', status: 'not-evaluated', reason: 'affected-html-link',
      htmlTargets: ['assets/stable.png'], line: 5 }]);
  }
  groups++;

  // 4. Targets include missing descendants of a selected directory. Namespace
  // mappings alone must not hide a reference that was already missing.
  const affected = assessWorkspaceOperationHtmlLinksV1(make(native, 'move', [
    { sourcePath: 'assets/stable.png', destinationPath: 'Dest/stable.png' },
  ]));
  assert.equal(affected.complete, false); assert.equal(affected.blockers[0].reason, 'affected-html-link');
  assert.equal(affected.blockers[0].line, 5);
  const missing = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['HTML.md', '<img src="Assets/missing.png">\n']], extra: [{ path: 'Assets', kind: 'directory' }] });
  const directory = assessWorkspaceOperationHtmlLinksV1(make(missing, 'move', [{ sourcePath: 'Assets', destinationPath: 'NewAssets' }]));
  assert.equal(directory.complete, false); assert.deepEqual(directory.blockers[0].htmlTargets, ['Assets/missing.png']);
  const deletedDirectory = assessWorkspaceOperationHtmlLinksV1(make(missing, 'delete', [{ sourcePath: 'Assets', destinationPath: '' }]));
  assert.equal(deletedDirectory.complete, false); assert.equal(deletedDirectory.blockers[0].reason, 'affected-html-link');
  groups++;

  // 5. Copy retains incoming references to the original. A new copy may not
  // silently populate an existing HTML URL that was previously unresolved.
  assert.equal(assessWorkspaceOperationHtmlLinksV1(make(native, 'copy', [
    { sourcePath: 'assets/stable.png', destinationPath: 'Dest/stable.png' },
  ])).complete, true);
  const capture = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['HTML.md', '<a href="Dest/New.md">Future</a>\n'], ['Move.md', '# Move\n']], extra: [{ path: 'Dest', kind: 'directory' }] });
  const newBinding = assessWorkspaceOperationHtmlLinksV1(make(capture, 'copy', [{ sourcePath: 'Move.md', destinationPath: 'Dest/New.md' }]));
  assert.equal(newBinding.complete, false); assert.deepEqual(newBinding.blockers[0].htmlTargets, ['Dest/New.md']);
  groups++;

  // 6. Unknown with zero known targets is not fully inspected empty HTML.
  // Removing that source has no surviving outgoing HTML reference.
  const unknown = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['HTML.md', '<custom-element></custom-element>\n'], ['Move.md', '# Move\n']] });
  const opaque = assessWorkspaceOperationHtmlLinksV1(make(unknown, 'move', [{ sourcePath: 'Move.md', destinationPath: 'Moved.md' }]));
  assert.equal(opaque.complete, false); assert.equal(opaque.blockers[0].reason, 'unevaluated-link');
  assert.equal(opaque.blockers[0].targetLiteral, ''); assert.equal(opaque.blockers[0].line, 1);
  assert.equal(assessWorkspaceOperationHtmlLinksV1(make(unknown, 'delete', [{ sourcePath: 'HTML.md', destinationPath: '' }])).complete, true);
  const empty = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['HTML.md', '<div class="note">No local targets</div>\n'], ['Move.md', '# Move\n']] });
  assert.deepEqual(assessWorkspaceOperationHtmlLinksV1(make(empty, 'move', [{ sourcePath: 'Move.md', destinationPath: 'Moved.md' }])),
    { version: 1, complete: true, warnings: [], blockers: [] });
  groups++;

  // 7. Delete protects surviving incoming HTML, while deleting both source and
  // target removes the reference. The original evidence stays untouched.
  const deleteBefore = structuredClone(native.evidence);
  const incoming = assessWorkspaceOperationHtmlLinksV1(make(native, 'delete', [{ sourcePath: 'assets/stable.png', destinationPath: '' }]));
  assert.equal(incoming.complete, false); assert.equal(incoming.blockers[0].reason, 'affected-html-link');
  assert.deepEqual(assessWorkspaceOperationHtmlLinksV1(make(native, 'delete', [
    { sourcePath: 'HTML.md', destinationPath: '' }, { sourcePath: 'assets/stable.png', destinationPath: '' },
  ])), { version: 1, complete: true, warnings: [], blockers: [] });
  assert.deepEqual(native.evidence, deleteBefore);
  groups++;

  // 8. Both actual workspace scopes participate in cross-workspace copy.
  const destination = workspaceOperationMixedSourceEvidenceV5Fixture({ workspaceId: 'html-assessment-destination', raw: [],
    native: [['Other.md', '<img src="unrelated-missing.png">\n']], extra: [{ path: 'Dest', kind: 'directory' }] });
  const cross = assessWorkspaceOperationHtmlLinksV1(make(native, 'copy', selected, destination));
  assert.equal(cross.complete, true); assert.deepEqual(cross.blockers, []);
  assert.deepEqual(new Set(cross.warnings.map(value => value.workspaceId)), new Set([native.scope.workspaceId, destination.scope.workspaceId]));
  const capturedDestination = workspaceOperationMixedSourceEvidenceV5Fixture({ workspaceId: 'html-assessment-destination', raw: [],
    native: [['Other.md', '<a href="Dest/Moved.md">Future</a>\n']], extra: [{ path: 'Dest', kind: 'directory' }] });
  const capturedCross = assessWorkspaceOperationHtmlLinksV1(make(native, 'copy', selected, capturedDestination));
  assert.equal(capturedCross.complete, false);
  assert.deepEqual(capturedCross.blockers[0].htmlTargets, ['Dest/Moved.md']);
  assert.equal(capturedCross.blockers[0].workspaceId, capturedDestination.scope.workspaceId);
  groups++;

  // 9. Invalid request/evidence/mapping combinations fail closed before any
  // successful assessment. Getter and Proxy inputs never execute user code.
  const base = make(native, 'move', selected);
  const change = (mutate: (value: Input) => void): void => { const value = structuredClone(base); mutate(value); invalid(value); };
  change(value => { value.request.sourceWorkspaceId = 'foreign'; });
  change(value => { value.request.destinationWorkspaceId = 'foreign'; });
  change(value => { value.request.kind = 'overwrite'; });
  change(value => { value.request.selections = []; });
  change(value => { value.request.selections = [{ sourcePath: 'Move.md', destinationPath: 'Move.md/child' }]; });
  change(value => { value.request.selections = [{ sourcePath: '\ud800', destinationPath: 'Dest/Moved.md' }]; });
  change(value => { value.pathMappings = []; });
  change(value => { value.pathMappings = [...value.pathMappings, value.pathMappings[0]]; });
  change(value => { value.pathMappings = [{ ...value.pathMappings[0], sourceIdentity: 'foreign' }]; });
  change(value => { value.pathMappings = [{ ...value.pathMappings[0], destinationPath: 'Dest/Other.md' }]; });
  change(value => { value.pathMappings = [{ ...value.pathMappings[0], sourceWorkspaceId: 'foreign' }]; });
  change(value => { value.pathMappings = [{ ...value.pathMappings[0], destinationWorkspaceId: 'foreign' }]; });
  invalid({ ...make(native, 'copy', selected, destination), request: { ...make(native, 'copy', selected, destination).request, kind: 'move' } });
  invalid({ ...base, sourceEvidence: destination.evidence });
  invalid({ ...base, destinationEvidence: capture.evidence });
  invalid({ ...make(native, 'delete', [{ sourcePath: 'Move.md', destinationPath: '' }]), pathMappings: base.pathMappings });
  invalid(make(native, 'delete', [{ sourcePath: 'Move.md', destinationPath: 'Moved.md' }]));
  invalid(make(native, 'move', [{ sourcePath: 'assets', destinationPath: 'OtherAssets' },
    { sourcePath: 'assets/stable.png', destinationPath: 'OtherAssets/stable.png' }]));
  invalid(make(native, 'move', [{ sourcePath: 'Move.md', destinationPath: 'NewFile' },
    { sourcePath: 'HTML.md', destinationPath: 'NewFile/Child.md' }]));
  assert.throws(() => assessWorkspaceOperationHtmlLinksV1({ ...base,
    sourceEvidence: { ...base.sourceEvidence, evidenceProof: '0'.repeat(64) } }),
    error => error instanceof Error && 'code' in error && error.code === 'NATIVE_SOURCE_EVIDENCE_INVALID');
  let getterCalls = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'request', { enumerable: true, get() { getterCalls++; throw new Error('Do not invoke accessor'); } });
  invalid(accessor); assert.equal(getterCalls, 0);
  invalid(new Proxy(base, { get() { getterCalls++; throw new Error('Do not invoke Proxy'); } }));
  assert.equal(getterCalls, 0);
  groups++;

  // 10. Every URL must be unaffected. The renderer's encoded relative-source
  // restriction remains intact, while absolute stable targets are independent.
  const multiple = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['HTML.md', '<a href="stable.png"><img src="assets/stable.png"></a>\n']],
    extra: [{ path: 'stable.png', kind: 'file' }, { path: 'assets/stable.png', kind: 'file' }] });
  const many = assessWorkspaceOperationHtmlLinksV1(make(multiple, 'move', [{ sourcePath: 'assets/stable.png', destinationPath: 'Moved.png' }]));
  assert.equal(many.complete, false);
  assert.deepEqual(many.warnings, [{ workspaceId: multiple.scope.workspaceId, sourcePath: 'HTML.md', targetLiteral: 'stable.png',
    status: 'not-evaluated', reason: 'unaffected-explicit-html-link', htmlTargets: ['stable.png'] }]);
  assert.deepEqual(many.blockers, [{ workspaceId: multiple.scope.workspaceId, sourcePath: 'HTML.md', targetLiteral: 'assets/stable.png',
    status: 'not-evaluated', reason: 'affected-html-link', htmlTargets: ['assets/stable.png'], line: 1 }]);
  // Inline tags are separate actual AST occurrences. A real block occurrence
  // must instead retain every target when only one of its URLs is affected.
  const block = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['HTML.md', '<div>\n<a href="stable.png"><img src="assets/stable.png"></a>\n</div>\n']],
    extra: [{ path: 'stable.png', kind: 'file' }, { path: 'assets/stable.png', kind: 'file' }] });
  assert.deepEqual(workspaceOperationSourceHtmlOccurrencesV5(block.evidence), [{ sourcePath: 'HTML.md', line: 1,
    fullyInspected: true, explicitLocalTargets: ['stable.png', 'assets/stable.png'] }]);
  const mixedBlock = assessWorkspaceOperationHtmlLinksV1(make(block, 'move', [{ sourcePath: 'assets/stable.png', destinationPath: 'Moved.png' }]));
  assert.equal(mixedBlock.complete, false); assert.deepEqual(mixedBlock.warnings, []);
  assert.deepEqual(mixedBlock.blockers, [{ workspaceId: block.scope.workspaceId, sourcePath: 'HTML.md',
    targetLiteral: 'stable.png, assets/stable.png', status: 'not-evaluated', reason: 'affected-html-link',
    htmlTargets: ['stable.png', 'assets/stable.png'], line: 1 }]);
  for (const [literal, complete] of [['image.png', false], ['/stable.png', true]] as const) {
    const encoded = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
      native: [['Notes%20Old/HTML.md', `<img src="${literal}">\n`], ['Move.md', '# Move\n']],
      extra: [{ path: 'stable.png', kind: 'file' }] });
    const assessment = assessWorkspaceOperationHtmlLinksV1(make(encoded, 'move', [{ sourcePath: 'Move.md', destinationPath: 'Moved.md' }]));
    assert.equal(assessment.complete, complete);
    if (!complete) assert.equal(assessment.blockers[0].reason, 'unevaluated-link');
  }
  groups++;
  assert.equal(groups, 10);
  console.log(JSON.stringify({ suite: 'workspace-operation-html-link-assessment', passed: groups, syntaxFactsOnly: true }));
}
