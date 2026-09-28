import assert from 'node:assert/strict';

import {
  createWorkspaceFileOperationPlan,
  type WorkspaceFileOperationPlanRequest,
  type WorkspacePlannerEntry,
  type WorkspacePlannerSnapshot,
} from '../app/lib/markdown/workspace-file-operation-planner';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import {
  WORKSPACE_LINK_CASES_V1,
  WORKSPACE_OPERATION_CASES_V1,
} from './fixtures/workspace-link-contract-v1';

const file = (path: string, content?: string): WorkspacePlannerEntry => ({
  identity: `id:${path}`,
  kind: 'file',
  path,
  ...(content === undefined ? {} : { markdownContent: content }),
});
const directory = (path: string): WorkspacePlannerEntry => ({ identity: `id:${path}`, kind: 'directory', path });
const snapshot = (workspaceId: string, entries: WorkspacePlannerEntry[]): WorkspacePlannerSnapshot => ({ workspaceId, entries });

type Scenario = {
  snapshots: WorkspacePlannerSnapshot[];
  previewPath: string | null;
  previewWorkspaceId?: string;
};

const fixtureScenarios: Record<string, Scenario> = {
  'target-rename-updates-incoming': {
    snapshots: [snapshot('w1', [directory('Notes'), file('Notes/Start.md', '[Plan](./Plan.md)'), file('Notes/Plan.md', '# Plan')])],
    previewPath: 'Notes/Start.md',
  },
  'source-move-preserves-outgoing': {
    snapshots: [snapshot('w1', [directory('Notes'), directory('Archive'), file('Notes/Start.md', '[Plan](./Plan.md)'), file('Notes/Plan.md', '# Plan')])],
    previewPath: 'Archive/Start.md',
  },
  'directory-move-maps-internal-and-external': {
    snapshots: [snapshot('w1', [directory('Notes'), directory('Archive'), file('Notes/Start.md', '[Inside](./Plan.md) [Outside](../Shared.md)'), file('Notes/Plan.md', '# Plan'), file('Shared.md', '# Shared')])],
    previewPath: 'Archive/Notes/Start.md',
  },
  'directory-copy-maps-internal-only': {
    snapshots: [snapshot('w1', [directory('Notes'), directory('Archive'), file('Notes/Start.md', '[Inside](./Plan.md) [Outside](../Shared.md)'), file('Notes/Plan.md', '# Plan'), file('Shared.md', '# Shared')])],
    previewPath: 'Archive/Notes/Start.md',
  },
  'copy-collision-uses-chosen-destination': {
    snapshots: [snapshot('w1', [directory('Notes'), directory('Archive'), directory('Archive/Notes'), file('Notes/Start.md', '[Outside](../Shared.md)'), file('Shared.md', '# Shared')])],
    previewPath: 'Archive/Notes (2)/Start.md',
  },
  'cross-workspace-copy-external-unresolved': {
    snapshots: [
      snapshot('w1', [directory('Notes'), file('Notes/Start.md', '[Outside](../Shared.md)'), file('Shared.md', '# Source')]),
      snapshot('w2', [file('Shared.md', '# Destination')]),
    ],
    previewPath: null,
    previewWorkspaceId: 'w2',
  },
  'large-overwrite-requires-recovery': {
    snapshots: [snapshot('w1', [directory('Notes'), file('Notes/Large.md', '[Plan](./Plan.md)'), file('Notes/Plan.md', '# Plan')])],
    previewPath: null,
  },
};

for (const fixture of WORKSPACE_OPERATION_CASES_V1) {
  const scenario = fixtureScenarios[fixture.id];
  assert.ok(scenario, `${fixture.id}: test scenario is required`);
  const before = JSON.stringify(scenario.snapshots);
  const plan = createWorkspaceFileOperationPlan({
    kind: fixture.kind,
    sourceWorkspaceId: fixture.sourceWorkspaceId,
    destinationWorkspaceId: fixture.destinationWorkspaceId,
    selections: fixture.pathMappings.map(([sourcePath, destinationPath]) => ({ sourcePath, destinationPath })),
    snapshots: scenario.snapshots,
  });
  assert.equal(JSON.stringify(scenario.snapshots), before, `${fixture.id}: input snapshot is untouched`);
  assert.equal(plan.readiness, fixture.expectedStatus === 'complete' ? 'ready' : 'blocked', fixture.id);
  assert.equal(plan.recoveryReady, false, `${fixture.id}: planner cannot infer a durable backup`);
  assert.equal(Object.isFrozen(plan), true, `${fixture.id}: plan is immutable`);
  if (fixture.markdownAfter !== null) {
    assert.equal(
      plan.previewContents.find((item) => item.workspaceId === (scenario.previewWorkspaceId ?? fixture.destinationWorkspaceId)
        && item.path === scenario.previewPath)?.content,
      fixture.markdownAfter,
      `${fixture.id}: exact preview content`,
    );
  }
  if (fixture.kind === 'copy') {
    const original = scenario.snapshots[0].entries.find((entry) => entry.path === 'Notes/Start.md');
    assert.equal(original?.markdownContent, fixture.markdownBefore, `${fixture.id}: original copy source is byte-identical`);
  }
  if (fixture.id === 'cross-workspace-copy-external-unresolved') {
    assert.ok(plan.issues.some((item) => item.code === 'uncopied-cross-workspace-target'), fixture.id);
    assert.equal(plan.linkEdits.length, 0, fixture.id);
  }
  if (fixture.id === 'large-overwrite-requires-recovery') {
    assert.ok(plan.issues.some((item) => item.code === 'unsupported-operation'), fixture.id);
  }
}

for (const fixture of WORKSPACE_LINK_CASES_V1.filter((item) => item.renamedTargetPath)) {
  const entries = fixture.catalog.map((item) => file(item.path, /\.(?:md|markdown)$/iu.test(item.path) ? item.content ?? '' : undefined));
  const source = entries.find((item) => item.path === fixture.sourcePath);
  if (source) source.markdownContent = fixture.markdown;
  else entries.push(file(fixture.sourcePath, fixture.markdown));
  const plan = createWorkspaceFileOperationPlan({
    kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    selections: [{ sourcePath: fixture.expected.targetPath!, destinationPath: fixture.renamedTargetPath! }],
    snapshots: [snapshot('w1', entries)],
  });
  assert.equal(plan.linkEdits.length, 1, `${fixture.id}: exactly one target span changes`);
  assert.equal(plan.linkEdits[0].previousTargetLiteral, fixture.expected.targetLiteral, fixture.id);
  assert.equal(plan.linkEdits[0].nextTargetLiteral, fixture.expected.nextTargetLiteral, fixture.id);
  const start = fixture.markdown.indexOf(fixture.expected.targetLiteral!);
  const expectedMarkdown = fixture.markdown.slice(0, start)
    + fixture.expected.nextTargetLiteral + fixture.markdown.slice(start + fixture.expected.targetLiteral!.length);
  assert.equal(plan.previewContents[0].content, expectedMarkdown, `${fixture.id}: only target literal changes`);
}

const binaryRename = createWorkspaceFileOperationPlan({
  kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'assets/chart.png', destinationPath: 'assets/chart-v2.png' }],
  snapshots: [snapshot('w1', [file('Notes/Start.md', '![Chart](../assets/chart.png)'), file('assets/chart.png')])],
});
assert.equal(binaryRename.readiness, 'ready');
assert.equal(binaryRename.previewContents[0].content, '![Chart](../assets/chart-v2.png)');
assert.equal(binaryRename.expectedPathState.find((item) => item.path === 'assets/chart-v2.png')?.identity, null);

const crossInternal = createWorkspaceFileOperationPlan({
  kind: 'copy', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w2',
  selections: [{ sourcePath: 'Notes', destinationPath: 'Archive/Notes' }],
  snapshots: [
    snapshot('w1', [directory('Notes'), file('Notes/Start.md', '[Plan](./Plan.md)'), file('Notes/Plan.md', '# Plan')]),
    snapshot('w2', [directory('Archive')]),
  ],
});
assert.equal(crossInternal.readiness, 'ready');
assert.equal(crossInternal.linkEdits.length, 0, 'Internal relative link retains identical spelling');
assert.equal(crossInternal.pathMappings.length, 3, 'Directory and descendants are mapped');

const crossRemappedInternal = createWorkspaceFileOperationPlan({
  kind: 'copy', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w2',
  selections: [
    { sourcePath: 'Notes/Start.md', destinationPath: 'Archive/Start.md' },
    { sourcePath: 'Notes/Plan.md', destinationPath: 'Archive/Plans/Plan.md' },
  ],
  snapshots: [
    snapshot('w1', [file('Notes/Start.md', '[Plan](./Plan.md)'), file('Notes/Plan.md', '# Plan')]),
    snapshot('w2', [directory('Archive'), directory('Archive/Plans'), {
      ...file('Unrelated.md', '# Never inspected'), contentHash: 'stale-unrelated-hash',
    }]),
  ],
});
assert.equal(crossRemappedInternal.readiness, 'ready');
assert.equal(crossRemappedInternal.linkEdits.length, 1);
assert.equal(crossRemappedInternal.linkEdits[0].sourceWorkspaceId, 'w1');
assert.equal(crossRemappedInternal.linkEdits[0].destinationWorkspaceId, 'w2');
assert.equal(crossRemappedInternal.previewContents[0].workspaceId, 'w2');
assert.equal(crossRemappedInternal.previewContents[0].path, 'Archive/Start.md');
assert.equal(crossRemappedInternal.previewContents[0].content, '[Plan](./Plans/Plan.md)');

const omitted = createWorkspaceFileOperationPlan({
  kind: 'move', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'Notes/Plan.md', destinationPath: 'Archive/Plan.md' }],
  snapshots: [snapshot('w1', [file('Notes/Start.md'), file('Notes/Plan.md', '# Plan')])],
});
assert.equal(omitted.readiness, 'blocked');
assert.deepEqual(omitted.coverage.omittedSources, [{ path: 'Notes/Start.md', reason: 'source-unreadable' }]);

const deniedEntry = file('Notes/Private.md');
deniedEntry.omissionReason = 'permission-denied';
const denied = createWorkspaceFileOperationPlan({
  kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'Notes/Plan.md', destinationPath: 'Archive/Plan.md' }],
  snapshots: [snapshot('w1', [deniedEntry, file('Notes/Plan.md', '# Plan')])],
});
assert.deepEqual(denied.coverage.omittedSources, [{ path: 'Notes/Private.md', reason: 'permission-denied' }]);

const occupied = createWorkspaceFileOperationPlan({
  kind: 'copy', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'Notes/Start.md', destinationPath: 'Archive/Start.md' }],
  snapshots: [snapshot('w1', [file('Notes/Start.md', '# A'), file('Archive/Start.md', '# B')])],
});
assert.equal(occupied.readiness, 'blocked');
assert.deepEqual(occupied.collisions, [{ workspaceId: 'w1', path: 'Archive/Start.md' }]);
assert.equal(occupied.expectedPathState.find((item) => item.path === 'Archive/Start.md')?.identity, 'id:Archive/Start.md');

for (const fixture of [
  {
    id: 'encoded-hash-with-fragment', before: '[A](./A%23B.md#Frag%20One)', oldPath: 'Notes/A#B.md',
    newPath: 'Notes/C#D.md', after: '[A](./C%23D.md#Frag%20One)',
  },
  {
    id: 'escaped-hash-with-fragment', before: '[A](./A\\#B.md#Frag)', oldPath: 'Notes/A#B.md',
    newPath: 'Notes/C#D.md', after: '[A](./C\\#D.md#Frag)',
  },
  {
    id: 'unbalanced-closing-parenthesis', before: '[A](./A.md)', oldPath: 'Notes/A.md',
    newPath: 'Notes/A).md', after: '[A](./A%29.md)',
  },
  {
    id: 'percent-in-new-file-name', before: '[A](./A.md)', oldPath: 'Notes/A.md',
    newPath: 'Notes/100%20.md', after: '[A](./100%2520.md)',
  },
  {
    id: 'hash-in-angle-target', before: '[A](<./A.md> "keep title")', oldPath: 'Notes/A.md',
    newPath: 'Notes/A#B.md', after: '[A](<./A%23B.md> "keep title")',
  },
  {
    id: 'angle-bracket-in-target', before: '[A](<./A.md> "keep title")', oldPath: 'Notes/A.md',
    newPath: 'Notes/A<B>.md', after: '[A](<./A%3CB%3E.md> "keep title")',
  },
  {
    id: 'scheme-like-basename', before: '[A](./A.md)', oldPath: 'Notes/A.md',
    newPath: 'Notes/foo:bar.md', after: '[A](./foo:bar.md)',
  },
]) {
  const plan = createWorkspaceFileOperationPlan({
    kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    selections: [{ sourcePath: fixture.oldPath, destinationPath: fixture.newPath }],
    snapshots: [snapshot('w1', [file('Notes/Start.md', fixture.before), file(fixture.oldPath, '# A')])],
  });
  assert.equal(plan.readiness, 'ready', fixture.id);
  assert.equal(plan.previewContents[0]?.content, fixture.after, fixture.id);
  const reparsed = buildWorkspaceLinkIndexFromDocuments(
    [{ path: 'Notes/Start.md', content: fixture.after }], new Date(0),
    ['Notes/Start.md', fixture.newPath],
  );
  assert.equal(reparsed.edges[0]?.status, 'resolved', `${fixture.id}: rewritten syntax remains resolvable`);
  assert.equal(reparsed.edges[0]?.targetPath, fixture.newPath, `${fixture.id}: rewritten link keeps file identity`);
}

const selfCopy = createWorkspaceFileOperationPlan({
  kind: 'copy', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'Notes', destinationPath: 'Notes/Copy' }],
  snapshots: [snapshot('w1', [directory('Notes'), file('Notes/Start.md', '# Start')])],
});
assert.equal(selfCopy.readiness, 'blocked');
assert.ok(selfCopy.issues.some((item) => item.code === 'directory-cycle'));

const unsupportedWikiName = createWorkspaceFileOperationPlan({
  kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'Notes/A.md', destinationPath: 'Notes/A#B.md' }],
  snapshots: [snapshot('w1', [file('Notes/Start.md', '[[A]]'), file('Notes/A.md', '# A')])],
});
assert.equal(unsupportedWikiName.readiness, 'blocked');
assert.ok(unsupportedWikiName.issues.some((item) => item.code === 'unsupported-target-format'));

const wikiPipeName = createWorkspaceFileOperationPlan({
  kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'Notes/A.md', destinationPath: 'Notes/A|B.md' }],
  snapshots: [snapshot('w1', [file('Notes/Start.md', '[[A]]'), file('Notes/A.md', '# A')])],
});
const wikiPipeContent = wikiPipeName.previewContents[0]?.content;
if (wikiPipeName.readiness === 'ready' && wikiPipeContent) {
  const reparsed = buildWorkspaceLinkIndexFromDocuments(
    [{ path: 'Notes/Start.md', content: wikiPipeContent }, { path: 'Notes/A|B.md', content: '# A' }],
    new Date(0), ['Notes/Start.md', 'Notes/A|B.md'],
  );
  assert.equal(reparsed.edges[0]?.targetPath, 'Notes/A|B.md', 'Wiki pipe spelling must re-resolve the same file');
} else {
  assert.ok(wikiPipeName.issues.some((item) => item.code === 'unsupported-target-format'));
}

const deterministicRequest: WorkspaceFileOperationPlanRequest = {
  kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'A.md', destinationPath: 'B.md' }],
  snapshots: [snapshot('w1', [file('A.md', '[A](./A.md)')])],
};
assert.equal(createWorkspaceFileOperationPlan(deterministicRequest).planId,
  createWorkspaceFileOperationPlan(deterministicRequest).planId, 'Same snapshot gives same plan ID');

console.log(`Workspace file operation planner: ${WORKSPACE_OPERATION_CASES_V1.length} operation fixtures, ${WORKSPACE_LINK_CASES_V1.filter((item) => item.renamedTargetPath).length} target syntax fixtures and additional invariants passed.`);
