import assert from 'node:assert/strict';
import { createWorkspaceOperationBatchPlan, computeWorkspaceOperationBatchPlanId,
  workspaceOperationBatchPublicPreview } from '../app/lib/files/workspace-operation-batch-plan';
import type { WorkspacePlannerEntry, WorkspacePlannerSnapshot } from '../app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceOperationBatchAction } from '../app/lib/files/workspace-operation-batch-contract';

const file = (path: string, content: string): WorkspacePlannerEntry => ({ path, identity: `file:${path}`, kind: 'file', markdownContent: content });
const dir = (path: string): WorkspacePlannerEntry => ({ path, identity: `dir:${path}`, kind: 'directory' });
const snapshot = (entries: WorkspacePlannerEntry[]): WorkspacePlannerSnapshot => ({ workspaceId: 'w1', entries });
const actions: WorkspaceOperationBatchAction[] = [
  { reviewId: 'delete', kind: 'delete', selections: [{ sourcePath: 'Trash.md' }] },
  { reviewId: 'move-a', kind: 'move', selections: [{ sourcePath: 'Notes/A.md', destinationPath: 'Channels/A.md' }] },
  { reviewId: 'move-b', kind: 'rename', selections: [{ sourcePath: 'Notes/B.md', destinationPath: 'Channels/B.md' }] },
];
const entries = [dir('Notes'), dir('Channels'), file('Trash.md', '# Trash'),
  file('Notes/A.md', '[Removed](../Trash.md) [B](./B.md) [[Notes/B|Partner]]'),
  file('Notes/B.md', '[A](./A.md) ![Old alt](../Trash.md)'),
  file('Home.md', '[A](Notes/A.md) [B](Notes/B.md) [[Trash|Visible]]\n\n[Text **bold**][obsolete] ![Image alt][obsolete]\n\n[obsolete]: Trash.md "Old title"\n'),
  file('archive/old.md', '[Unrelated](gone.md)')];
const plan = createWorkspaceOperationBatchPlan({ snapshot: snapshot(entries), actions });
assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
assert.equal(plan.pathMappings.length, 2);
assert.equal(plan.pathMappings.every((entry) => entry.sourceKind === 'file'), true);
assert.equal(plan.deletedPaths.length, 1);
assert.deepEqual(plan.pathSteps.map((step) => step.reviewId), ['delete', 'move-a', 'move-b']);
assert.equal(plan.previewContents.find((doc) => doc.path === 'Channels/A.md')?.content, 'Removed [B](./B.md) [[Channels/B|Partner]]');
assert.equal(plan.previewContents.find((doc) => doc.path === 'Channels/B.md')?.content, '[A](./A.md) Old alt');
assert.equal(plan.previewContents.find((doc) => doc.path === 'Home.md')?.content,
  '[A](Channels/A.md) [B](Channels/B.md) Visible\n\nText **bold** Image alt\n\n\n');
assert.equal(plan.originalDocuments.some((doc) => doc.path === 'Trash.md'), false, 'Deleted source bytes are backed up, never rewritten');
assert.equal(plan.linkEdits.some((edit) => edit.sourcePathBefore === 'Trash.md'), false);
assert.equal(plan.coverage.complete, false);
assert.equal(plan.linkAssessment.warnings.length, 1);
assert.equal(computeWorkspaceOperationBatchPlanId(plan), plan.planId);
for (const edit of plan.linkEdits) {
  const content = plan.originalDocuments.find((doc) => doc.path === edit.sourcePathBefore)!.content;
  assert.equal(content.slice(edit.targetRange.startUtf16, edit.targetRange.endUtf16), edit.previousTargetLiteral);
  assert.equal(Buffer.byteLength(content.slice(0, edit.targetRange.startUtf16)), edit.targetRange.startUtf8Byte);
}
const noisy = createWorkspaceOperationBatchPlan({ snapshot: snapshot([...entries, file('archive/new.md', '[Another](missing.md)')]), actions });
assert.equal(noisy.planId, plan.planId, 'Unrelated diagnostic warning changes do not stale the immutable mutation');
const backlinkAdded = createWorkspaceOperationBatchPlan({ snapshot: snapshot([...entries, file('New.md', '[A](Notes/A.md)')]), actions });
assert.notEqual(backlinkAdded.planId, plan.planId, 'New inbound link changes the combined mutation proof');
assert.equal('originalDocuments' in workspaceOperationBatchPublicPreview(plan), false);
assert.equal('previewContents' in workspaceOperationBatchPublicPreview(plan), false);
assert.equal('linkPlan' in workspaceOperationBatchPublicPreview(plan), false);

const deleteOnly = createWorkspaceOperationBatchPlan({ snapshot: snapshot([file('Trash.md', '# Trash'), file('Home.md', '[Label](Trash.md)')]), actions: [actions[0]] });
assert.equal(deleteOnly.readiness, 'ready');
assert.equal(deleteOnly.previewContents[0].content, 'Label');
assert.equal(deleteOnly.linkPlan.pathMappings[0].sourcePath, 'Home.md', 'Delete-only Yjs writer retains exact source scope');
const empty = createWorkspaceOperationBatchPlan({ snapshot: snapshot([file('Trash.md', '# Trash'), file('Home.md', '[](Trash.md)')]), actions: [actions[0]] });
assert.equal(empty.readiness, 'ready');
assert.equal(empty.previewContents[0].content, '');

const ambiguous = createWorkspaceOperationBatchPlan({ snapshot: snapshot([file('Notes/Trash.md', '# T'), file('Other/Trash.md', '# T'), file('Home.md', '[[Trash]]')]),
  actions: [{ reviewId: 'delete', kind: 'delete', selections: [{ sourcePath: 'Notes/Trash.md' }] }] });
assert.equal(ambiguous.readiness, 'blocked', 'A deleted ambiguous candidate must not silently become an unrelated unique resolution');
assert.ok(ambiguous.issues.some((issue) => issue.code === 'affected-unresolved-link'));
const omitted = createWorkspaceOperationBatchPlan({ snapshot: snapshot([{ path: 'Trash.md', identity: 'x', kind: 'file', omissionReason: 'permission-denied' }]), actions: [actions[0]] });
assert.equal(omitted.readiness, 'blocked', 'Unreadable deleted source can hide aliases');

const overlap = createWorkspaceOperationBatchPlan({ snapshot: snapshot([dir('Notes'), file('Notes/A.md', '# A')]), actions: [
  { reviewId: 'move', kind: 'move', selections: [{ sourcePath: 'Notes', destinationPath: 'Archive' }] },
  { reviewId: 'delete', kind: 'delete', selections: [{ sourcePath: 'Notes/A.md' }] },
] });
assert.equal(overlap.readiness, 'blocked');
assert.ok(overlap.issues.some((issue) => issue.code === 'overlapping-selection'));
const cycle = createWorkspaceOperationBatchPlan({ snapshot: snapshot([file('A.md', '# A'), file('B.md', '# B')]), actions: [
  { reviewId: 'a', kind: 'move', selections: [{ sourcePath: 'A.md', destinationPath: 'B.md' }] },
  { reviewId: 'b', kind: 'move', selections: [{ sourcePath: 'B.md', destinationPath: 'A.md' }] },
] });
assert.equal(cycle.readiness, 'blocked');
assert.ok(cycle.issues.some((issue) => issue.code === 'dependency-cycle'));
const replacement = createWorkspaceOperationBatchPlan({ snapshot: snapshot([file('Old.md', '# Old'), file('New.md', '# New'), file('Home.md', '[Old](Old.md) [New](New.md)')]), actions: [
  { reviewId: 'old', kind: 'delete', selections: [{ sourcePath: 'Old.md' }] },
  { reviewId: 'new', kind: 'move', selections: [{ sourcePath: 'New.md', destinationPath: 'Old.md' }] },
] });
assert.equal(replacement.readiness, 'ready');
assert.equal(replacement.previewContents[0].content, 'Old [New](Old.md)', 'Delete cleanup precedes new destination binding and preserves exact target identity');

console.log('workspace-operation-batch-plan-test: mixed final state, Markdown cleanup, span translation, dependency/conflict checks and stable mutation identity passed');
