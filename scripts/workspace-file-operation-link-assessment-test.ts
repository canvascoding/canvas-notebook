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
  assert.equal(preview.readiness, 'blocked', `${kind}: missing link inside relocated/copied source stays blocked`);
  assert.deepEqual(preview.linkAssessment?.blockers, [{ workspaceId: 'w1', sourcePath: 'Notes/plan.md',
    targetLiteral: 'The First 100 Collection', status: 'missing', reason: 'affected-unresolved-link' }]);
  assert.equal(preview.linkAssessment?.warnings.length, 2);
  assert.equal(preview.linkAssessment?.complete, true, 'Known broken link is evaluated, but remains a blocker');
  assert.equal(preview.issues[0]?.path, 'Notes/plan.md');
}

const absentDescendant = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Home.md', '[Missing](Notes/missing.md)')]);
assert.equal(absentDescendant.readiness, 'blocked', 'Missing target under moved directory is affected even without a file mapping');
assert.equal(absentDescendant.linkAssessment?.blockers[0]?.reason, 'affected-unresolved-link');

const newlyResolved = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Home.md', '[Missing](Channels/Notes/plan.md)')]);
assert.equal(newlyResolved.readiness, 'blocked', 'Existing missing literal cannot silently bind to the new destination');
assert.equal(newlyResolved.linkAssessment?.blockers[0]?.reason, 'resolution-changed');
assert.equal(newlyResolved.linkAssessment?.blockers[0]?.status, 'resolved');

const unchangedAmbiguity = plan('move', [directory('Notes'), file('Notes/plan.md', '# Content'),
  file('A/Other.md', '# Other'), file('B/Other.md', '# Other'), file('Home.md', '[[Other]]')]);
assert.equal(unchangedAmbiguity.readiness, 'ready', 'Unrelated ambiguous candidates stay a warning when unchanged');
assert.equal(unchangedAmbiguity.linkAssessment?.warnings[0]?.status, 'ambiguous');

const affectedAmbiguity = plan('move', [directory('Notes'), file('Notes/plan.md', '# Plan'),
  file('Other/plan.md', '# Plan'), file('Home.md', '[[Plan]]')]);
assert.equal(affectedAmbiguity.readiness, 'blocked', 'Moving a Wiki candidate cannot be waved through as an unrelated ambiguity');
assert.equal(affectedAmbiguity.linkAssessment?.blockers[0]?.reason, 'affected-unresolved-link');

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
assert.equal(crossNewBinding.readiness, 'blocked', 'Cross-copy destination missing links cannot silently change resolution');
assert.equal(crossNewBinding.linkAssessment?.blockers[0]?.workspaceId, 'w2');
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
