import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createWorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import { workspacePathOperationPublicIssues } from '../app/lib/files/workspace-path-operation-public';
import { createWorkspaceFileOperationPlan, type WorkspacePlannerEntry } from '../app/lib/markdown/workspace-file-operation-planner';
import { isWorkspaceFileOperationLinkSafe } from '../app/lib/markdown/workspace-file-operation-link-safety';

const file = (path: string, markdownContent = ''): WorkspacePlannerEntry => ({ path, identity: `id:${path}`, kind: 'file', markdownContent });
const directory = (path: string): WorkspacePlannerEntry => ({ path, identity: `id:${path}`, kind: 'directory' });
const html = '<img src="canvas-holdings-screenshot.png" alt="Canvas Holdings Screenshot" style="display:block;max-width:100%;height:auto;margin-left:auto;margin-right:auto">';
const content = `# Core features\n\n${html}\n\n![Same image](canvas-holdings-screenshot.png)\n`;
const reference = 'test_core_bearbeitungsfeatures.md';
const source = 'ek-fuchs-transkript.md';
const destination = 'Koenenstrasse_8/WEG/Waermepumpe/Notizen/ek-fuchs-transkript.md';
const fixture = [file(reference, content), file(source, '# Original transcript'), file('canvas-holdings-screenshot.png')];
const plan = (entries: WorkspacePlannerEntry[], sourcePath = source, destinationPath = destination, kind: 'move' | 'rename' | 'copy' = 'move') =>
  createWorkspaceFileOperationPlan({ kind, sourceWorkspaceId: 'w', destinationWorkspaceId: 'w',
    selections: [{ sourcePath, destinationPath }], snapshots: [{ workspaceId: 'w', entries }] });

for (const kind of ['move', 'rename', 'copy'] as const) {
  for (const entries of [fixture, fixture.filter((entry) => entry.path !== 'canvas-holdings-screenshot.png')]) {
    const result = plan(entries, source, destination, kind);
    assert.equal(result.readiness, 'ready', `${kind}: unrelated explicit HTML is safe, even if its image is missing`);
    assert.equal(result.linkAssessment?.complete, true);
    assert.equal(isWorkspaceFileOperationLinkSafe(result), true);
    assert.equal(result.coverage.complete, false, 'Unsupported HTML rewrite coverage stays visible');
    assert.equal(result.linkAssessment?.warnings[0]?.reason, 'unaffected-explicit-html-link');
    assert.deepEqual(result.linkAssessment?.warnings[0]?.htmlTargets, ['canvas-holdings-screenshot.png']);
    assert.equal(result.previewContents.some((entry) => entry.path === reference), false, 'Unrelated HTML bytes are never rewritten');
    assert.equal(result.expectedPathState.find((entry) => entry.path === reference)?.contentHash,
      createHash('sha256').update(content).digest('hex'), 'No-change evidence is fenced to its exact document bytes');
  }
}

for (const [sourcePath, destinationPath] of [[reference, `Notes/${reference}`],
  ['canvas-holdings-screenshot.png', 'Notes/image.png'], ['Assets', 'NewAssets']]) {
  const entries = sourcePath === 'Assets'
    ? [file(reference, '<img src="Assets/image.png">'), directory('Assets'), file('Assets/image.png'), file(source)] : fixture;
  const result = plan(entries, sourcePath, destinationPath);
  assert.equal(result.readiness, 'blocked', 'HTML source or target movement is protected');
  assert.equal(result.linkAssessment?.blockers[0]?.reason, 'affected-html-link');
  assert.equal(isWorkspaceFileOperationLinkSafe(result), false);
}

for (const kind of ['move', 'copy'] as const) {
  const result = plan([file(reference, '<img src="New/image.png">'), file('old.png')], 'old.png', 'New/image.png', kind);
  assert.equal(result.readiness, 'blocked', 'A previously missing HTML target cannot acquire a new binding');
}
assert.equal(plan(fixture, 'canvas-holdings-screenshot.png', 'other.png', 'copy').readiness, 'ready',
  'Copy preserves an incoming HTML reference to the original image');
assert.equal(plan(fixture, reference, `Notes/${reference}`, 'copy').readiness, 'blocked', 'A copied HTML source needs a separate safety assessment');

for (const raw of ['<img src="stable.png" srcset="other.png 2x">',
  '<img src="stable.png" style="background-image:image-set(\'other.png\' 1x)">',
  '<a href="stable.png"><img src="other.png" onload="load()"></a>']) {
  const result = plan([file(reference, raw), file(source), file('stable.png')]);
  assert.equal(result.readiness, 'blocked', 'Unknown attributes prevent a whole-node no-change proof');
  assert.equal(result.linkAssessment?.blockers[0]?.reason, 'unevaluated-link');
}
const multiple = plan([file(reference, '<a href="stable.png"><img src="affected.png"></a>'), file('stable.png'), file('affected.png')],
  'affected.png', 'new.png');
assert.equal(multiple.readiness, 'blocked', 'Every URL in the node must be unaffected');

for (const [documentPath, renderedTarget] of [['Notes%20Old/Doc.md', 'Notes Old/image.png'],
  ['Notes/Doc%2FSub.md', 'Notes/Doc/image.png']]) {
  const entries = [file(documentPath, '<img src="image.png" alt="Fixture">'), file(renderedTarget)];
  const result = plan(entries, renderedTarget, 'moved.png');
  assert.equal(result.readiness, 'blocked', 'Encoded source paths cannot certify a different relative renderer base');
  assert.equal(result.linkAssessment?.blockers[0]?.reason, 'unevaluated-link');
  const absolute = plan([file(documentPath, '<img src="/stable.png" alt="Fixture">'), file('stable.png'), file(source)]);
  assert.equal(absolute.readiness, 'ready', 'Root HTML targets do not depend on an encoded source base');
}

const cross = (destinationHtml: string) => createWorkspaceFileOperationPlan({ kind: 'copy',
  sourceWorkspaceId: 'w', destinationWorkspaceId: 'other', selections: [{ sourcePath: source, destinationPath: destination }],
  snapshots: [{ workspaceId: 'w', entries: fixture }, { workspaceId: 'other', entries: [file('Destination.md', destinationHtml)] }] });
assert.equal(cross('<img src="existing.png">').readiness, 'ready', 'Unrelated destination HTML is classified separately');
assert.equal(cross('<img src="existing.png">').expectedPathState.find((entry) => entry.workspaceId === 'other' && entry.path === 'Destination.md')?.contentHash,
  createHash('sha256').update('<img src="existing.png">').digest('hex'), 'Destination HTML evidence has an exact byte fence');
assert.equal(cross(`<a href="${destination}">Transcript</a>`).readiness, 'blocked', 'Cross-copy cannot create a destination HTML binding silently');

const batch = (entries: WorkspacePlannerEntry[], actions: Array<{ kind: 'move' | 'delete'; sourcePath: string; destinationPath?: string }>) =>
  createWorkspaceOperationBatchPlan({ snapshot: { workspaceId: 'w', entries }, actions: actions.map((action, index) => ({
    reviewId: `review:${index}`, kind: action.kind, selections: [{ sourcePath: action.sourcePath, ...(action.destinationPath ? { destinationPath: action.destinationPath } : {}) }],
  })) });
for (const actions of [[{ kind: 'delete' as const, sourcePath: 'canvas-holdings-screenshot.png' }],
  [{ kind: 'delete' as const, sourcePath: 'canvas-holdings-screenshot.png' }, { kind: 'move' as const, sourcePath: source, destinationPath: destination }]]) {
  const result = batch(fixture, actions);
  assert.equal(result.readiness, 'blocked', 'Original HTML target deletion is protected before target filtering');
  assert.equal(result.linkAssessment.blockers[0]?.reason, 'affected-html-link');
  assert.equal(isWorkspaceFileOperationLinkSafe(result.linkPlan), false, 'The executor link plan retains the batch blocker');
  assert.equal(result.previewContents.find((entry) => entry.path === reference)?.content.includes(html), true,
    'The preview cleans up the supported Markdown image and retains the HTML tag byte for byte');
  assert.deepEqual(workspacePathOperationPublicIssues(result), [{ code: 'affected-html-link', path: reference,
    targetLiteral: 'canvas-holdings-screenshot.png', line: 3 }]);
}
assert.equal(batch(fixture, [{ kind: 'delete', sourcePath: source }]).readiness, 'ready', 'Unrelated deletion can proceed');
assert.equal(batch(fixture, [{ kind: 'delete', sourcePath: reference }, { kind: 'delete', sourcePath: 'canvas-holdings-screenshot.png' }]).readiness,
  'ready', 'A removed source has no surviving HTML reference');
const missingDescendant = batch([directory('Assets'), file(reference, '<img src="Assets/missing.png">')],
  [{ kind: 'delete', sourcePath: 'Assets' }]);
assert.equal(missingDescendant.readiness, 'blocked', 'Missing explicit descendants still participate in deletion scope');

const safe = plan(fixture);
for (const replacement of [{ ...safe.linkAssessment!.warnings[0], reason: 'unaffected-existing-link' as const },
  { ...safe.linkAssessment!.warnings[0], htmlTargets: [] },
  { ...safe.linkAssessment!.warnings[0], htmlTargets: ['wrong.png'] },
  { ...safe.linkAssessment!.warnings[0], targetLiteral: '<script src="canvas-holdings-screenshot.png"></script>' }]) {
  const forged = { ...safe, linkAssessment: { ...safe.linkAssessment!, warnings: [replacement] }, coverage: { ...safe.coverage,
    unresolvedLinks: [{ sourcePath: reference, targetLiteral: replacement.targetLiteral, status: 'not-evaluated' as const }] } };
  assert.equal(isWorkspaceFileOperationLinkSafe(forged), false, 'Not-evaluated diagnostics require exact certified HTML evidence');
}
assert.notEqual(plan(fixture.map((entry) => entry.path === reference ? file(reference, content.replace('canvas-holdings-screenshot.png', 'another.png')) : entry)).planId,
  safe.planId, 'A changed HTML no-change proof invalidates the preview identity');
console.log('HTML operation assessment: unrelated moves/copies/deletes, affected sources/targets, destination binding, combined deletion, proof fencing and public diagnostics passed.');
