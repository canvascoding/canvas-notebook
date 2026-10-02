import assert from 'node:assert/strict';

import {
  computeWorkspaceFileOperationPlanId,
  createWorkspaceFileOperationPlan,
  type WorkspaceFileOperationPlanRequest,
  type WorkspacePlannerEntry,
} from '../app/lib/markdown/workspace-file-operation-planner';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';

const file = (path: string, content?: string): WorkspacePlannerEntry => ({
  identity: `id:${path}`, kind: 'file', path,
  ...(content === undefined ? {} : { markdownContent: content }),
});
const directory = (path: string): WorkspacePlannerEntry => ({ identity: `id:${path}`, kind: 'directory', path });
const plan = (kind: 'move' | 'rename' | 'copy', entries: WorkspacePlannerEntry[], sourcePath = 'Notes', destinationPath = 'Channels/Notes') =>
  createWorkspaceFileOperationPlan({ kind, sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    selections: [{ sourcePath, destinationPath }], snapshots: [{ workspaceId: 'w1', entries }] });

const archived = file('archive/old.md', '[Missing](./gone.md) [Outside](../../../older.md)');
const entries = [directory('Notes'), file('Notes/plan.md', '# Content plan'),
  file('Structure.md', '[Plan](Notes/plan.md)'),
  file('strategy/Pipeline.md', '[Plan](../Notes/plan.md)'), archived];
for (const kind of ['move', 'rename', 'copy'] as const) {
  const preview = plan(kind, entries);
  assert.equal(preview.readiness, 'ready', `${kind}: unrelated archive links do not block`);
  assert.equal(preview.coverage.complete, false, `${kind}: overall incomplete coverage stays visible`);
  assert.equal(preview.linkAssessment?.complete, true);
  assert.equal(preview.linkAssessment?.blockers.length, 0);
  assert.equal(preview.linkAssessment?.warnings.length, 2);
  assert.equal(preview.issues.length, 0);
  assert.equal(preview.previewContents.some((item) => item.path === archived.path), false, 'Unrelated bytes never rewritten');
  if (kind === 'copy') assert.equal(preview.linkEdits.length, 0, 'Copy preserves backlinks to the originals');
  else {
    assert.equal(preview.linkEdits.length, 2, 'Both outside backlinks are rewritten');
    assert.equal(preview.previewContents.find((item) => item.path === 'Structure.md')?.content, '[Plan](Channels/Notes/plan.md)');
    assert.equal(preview.previewContents.find((item) => item.path === 'strategy/Pipeline.md')?.content, '[Plan](../Channels/Notes/plan.md)');
  }
}

for (const kind of ['move', 'rename', 'copy'] as const) {
  const preview = plan(kind, [directory('Notes'), file('Notes/plan.md', '[[The First 100 Collection]]'), archived]);
  assert.equal(preview.readiness, 'ready', `${kind}: unchanged missing Wiki lookup remains a warning after relocation`);
  assert.equal(preview.linkAssessment?.blockers.length, 0);
  assert.equal(preview.linkAssessment?.warnings.length, 3);
  assert.equal(preview.linkAssessment?.complete, true);
  assert.equal(preview.linkEdits.length, 0, 'Do not invent a target for a missing Wiki name');
}

const absentDescendant = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Home.md', '[Missing](Notes/missing.md)')]);
assert.equal(absentDescendant.readiness, 'ready', 'Absent descendants follow the selected directory intent');
assert.equal(absentDescendant.previewContents[0]?.content, '[Missing](Channels/Notes/missing.md)');
assert.equal(absentDescendant.linkAssessment?.warnings.length, 1);

const newlyResolved = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Home.md', '[Missing](Channels/Notes/plan.md)')]);
assert.equal(newlyResolved.readiness, 'ready', 'An exact approved destination repairs an explicit missing path');
assert.deepEqual(newlyResolved.linkAssessment?.restoredLinks, [{ workspaceId: 'w1', sourcePath: 'Home.md', sourcePathAfter: 'Home.md', targetLiteral: 'Channels/Notes/plan.md', targetPath: 'Channels/Notes/plan.md' }]);

const unchangedAmbiguity = plan('move', [directory('Notes'), file('Notes/plan.md', '# Content'),
  file('A/Other.md', '# Other'), file('B/Other.md', '# Other'), file('Home.md', '[[Other]]')]);
assert.equal(unchangedAmbiguity.readiness, 'ready', 'Unrelated ambiguous candidates stay a warning when unchanged');
assert.equal(unchangedAmbiguity.linkAssessment?.warnings[0]?.status, 'ambiguous');

const affectedAmbiguity = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Other/plan.md', '# Plan'), file('Home.md', '[[Plan]]')]);
assert.equal(affectedAmbiguity.readiness, 'ready', 'An unchanged set of candidate identities remains ambiguous after moving');
assert.equal(affectedAmbiguity.linkAssessment?.warnings[0]?.status, 'ambiguous');

const copyAddsAmbiguity = plan('copy', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Home.md', '[[Plan]]')]);
assert.equal(copyAddsAmbiguity.readiness, 'blocked', 'Copy may make original incoming Wiki links ambiguous');
assert.equal(copyAddsAmbiguity.linkAssessment?.blockers[0]?.reason, 'resolution-changed');
assert.equal(copyAddsAmbiguity.linkAssessment?.blockers[0]?.status, 'ambiguous');

const copiedOriginal = plan('copy', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Notes/start.md', '[[Shared/Plan]]'), file('Shared/Plan.md', '# Shared')]);
assert.equal(copiedOriginal.readiness, 'ready', 'Explicit Wiki paths in copied and original source preserve target identity');

for (const omission of [file('Unrelated.md'),
  { ...file('Unrelated.md'), omissionReason: 'permission-denied' as const },
  file('Unrelated.md', 'x'.repeat(MAX_INDEXED_MARKDOWN_BYTES + 1))]) {
  const preview = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'), omission]);
  assert.equal(preview.readiness, 'blocked', 'An uninspected source may hide backlinks and remains blocking');
  assert.equal(preview.linkAssessment?.complete, false);
  assert.equal(preview.linkAssessment?.blockers[0]?.reason, 'uninspected-source');
}
const html = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Unrelated.md', '<a href="Notes/plan.md">Plan</a>')]);
assert.equal(html.readiness, 'blocked', 'Unevaluated HTML cannot be declared unaffected');
assert.equal(html.linkAssessment?.complete, false);
assert.equal(html.linkAssessment?.blockers[0]?.reason, 'unevaluated-link');

const crossRequest: WorkspaceFileOperationPlanRequest = {
  kind: 'copy', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w2',
  selections: [{ sourcePath: 'Notes', destinationPath: 'Channels/Notes' }],
  snapshots: [
    { workspaceId: 'w1', entries: [directory('Notes'), file('Notes/plan.md', '# Content plan'), archived] },
    { workspaceId: 'w2', entries: [file('History.md', '[Unrelated](./gone.md)')] },
  ],
};
const cross = createWorkspaceFileOperationPlan(crossRequest);
assert.equal(cross.readiness, 'ready', 'Unchanged broken links in either workspace are warnings for cross-copy');
assert.equal(cross.linkAssessment?.warnings.length, 3);
assert.equal(cross.coverage.unresolvedLinks.length, 3, 'Destination diagnostic coverage is reported too');
const crossNewBinding = createWorkspaceFileOperationPlan({ ...crossRequest, snapshots: [crossRequest.snapshots[0],
  { workspaceId: 'w2', entries: [file('Home.md', '[Destination](Channels/Notes/plan.md)')] }] });
assert.equal(crossNewBinding.readiness, 'ready', 'An exact approved copied destination can repair its incoming explicit path');
assert.equal(crossNewBinding.linkAssessment?.restoredLinks?.[0]?.workspaceId, 'w2');
const crossOmitted = createWorkspaceFileOperationPlan({ ...crossRequest, snapshots: [crossRequest.snapshots[0],
  { workspaceId: 'w2', entries: [{ ...file('Private.md'), omissionReason: 'permission-denied' }] }] });
assert.equal(crossOmitted.readiness, 'blocked');
assert.equal(crossOmitted.linkAssessment?.complete, false);
assert.deepEqual(crossOmitted.coverage.omittedSources, [{ path: 'Private.md', reason: 'permission-denied' }]);

const warningPlan = plan('move', entries);
assert.equal(computeWorkspaceFileOperationPlanId(warningPlan), warningPlan.planId);
assert.notEqual(computeWorkspaceFileOperationPlanId({ ...warningPlan,
  linkAssessment: { ...warningPlan.linkAssessment!, warnings: [] } }), warningPlan.planId,
'Assessment evidence is part of the immutable plan identity');
assert.equal(plan('move', entries).planId, warningPlan.planId, 'Assessment identity is deterministic');

console.log('Workspace operation link safety: unrelated diagnostics, affected missing links, Wiki candidates, cross-copy, evaluation gaps and plan identity passed.');

// The actual two diagnostics: a missing Wiki collection inside the moved tree,
// and an explicit Wiki path at the selected destination which is repaired.
const actualSource = '05_content-engine/atelier-notes';
const actualDestination = '05_content-engine/channels/atelier-notes';
const userFixture = plan('move', [directory(actualSource),
  file(`${actualSource}/_content-plan.md`, '[[The First 100 Collection]]'),
  file('05_content-engine/strategy/Instagram-Reel-Content-Pipeline-Plan.md',
    `[[${actualDestination}/_content-plan|Atelier notes]]`)], actualSource, actualDestination);
assert.equal(userFixture.readiness, 'ready', JSON.stringify(userFixture.issues));
assert.equal(userFixture.linkAssessment?.warnings[0]?.targetLiteral, 'The First 100 Collection');
assert.equal(userFixture.linkAssessment?.restoredLinks?.[0]?.targetPath, `${actualDestination}/_content-plan.md`);
assert.equal(userFixture.linkEdits.length, 0, 'Repair requires no guessed rewrite');
assert.notEqual(computeWorkspaceFileOperationPlanId({ ...userFixture,
  linkAssessment: { ...userFixture.linkAssessment!, restoredLinks: [] } }), userFixture.planId);

const missingOutgoing = plan('move', [directory('Notes'),
  file('Notes/plan.md', '[Gone](../missing.md#part) [[./absent|Alias]]')]);
assert.equal(missingOutgoing.readiness, 'ready');
assert.equal(missingOutgoing.previewContents[0]?.content, '[Gone](../../missing.md#part) [[Channels/Notes/absent|Alias]]');
assert.equal(missingOutgoing.linkAssessment?.warnings.length, 2);
const explicitWikiDescendant = plan('move', [directory('Notes'), file('Notes/plan.md', '# Content'),
  file('Home.md', '[[Notes/absent|Still absent]]')]);
assert.equal(explicitWikiDescendant.readiness, 'ready');
assert.equal(explicitWikiDescendant.previewContents[0]?.content, '[[Channels/Notes/absent|Still absent]]');

const aliasBinding = plan('move', [directory('Notes'), file('Notes/plan.md', '---\naliases: [Collection]\n---\n# Content'),
  file('Home.md', '[[Collection]]')]);
assert.equal(aliasBinding.readiness, 'ready', 'A resolved alias keeps its exact document identity');
const wrongExplicitBinding = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Home.md', '[[Destination/plan]]')], 'Notes', 'Other/Destination');
assert.equal(wrongExplicitBinding.readiness, 'blocked', 'Wiki suffix resolution is not an exact approved repair');
const bareBinding = plan('move', [directory('Notes'), file('Notes/unrelated.md', '# Plan'),
  file('Home.md', '[[NewName]]')], 'Notes/unrelated.md', 'Channels/NewName.md');
assert.equal(bareBinding.readiness, 'blocked', 'A previously missing bare Wiki name must not acquire a new binding');
const changedAmbiguous = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Other/plan.md', '# Plan'), file('Home.md', '[[Plan]]')], 'Notes/plan.md', 'Channels/renamed.md');
assert.equal(changedAmbiguous.readiness, 'blocked', 'Losing one ambiguous candidate changes the graph');
const newAmbiguous = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Existing/plan.md', '# Plan'), file('Home.md', '[[Channels/Notes/plan]]'),
  file('Other/Channels/Notes/plan.md', '# Suffix')]);
assert.equal(newAmbiguous.readiness, 'blocked', 'Exact repair cannot introduce ambiguity with a suffix candidate');
const self = plan('move', [directory('Notes'), file('Notes/plan.md', '[Self](plan.md#heading) [[Notes/plan#heading]]')]);
assert.equal(self.readiness, 'ready', 'Same-file links continue to point at that file');
assert.equal(self.previewContents[0]?.content, '[Self](plan.md#heading) [[Channels/Notes/plan#heading]]');
const untouched = plan('move', [directory('Notes'), file('Notes/plan.md', '`[[Never]]`\n```md\n[Code](gone.md)\n```\n[Web](https://example.org/path)')]);
assert.equal(untouched.readiness, 'ready');
assert.equal(untouched.linkEdits.length, 0, 'Code and external links retain every byte');
console.log('Link rule regressions: real two-diagnostic fixture, exact repairs, missing outgoing/descendants, candidate identity, self links, code and external links passed.');
