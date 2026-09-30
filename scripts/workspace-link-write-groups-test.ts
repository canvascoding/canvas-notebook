import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-file-operation-planner';
import { groupWorkspaceLinkWrites, WorkspaceLinkWriteGroupError } from '../app/lib/markdown/workspace-link-write-groups';

const plan = createWorkspaceFileOperationPlan({
  kind: 'copy', sourceWorkspaceId: 'source', destinationWorkspaceId: 'destination',
  selections: [
    { sourcePath: 'Home.md', destinationPath: 'Archive/Home.md' },
    { sourcePath: 'a.png', destinationPath: 'Assets/a.png' },
  ],
  snapshots: [
    { workspaceId: 'source', entries: [
      { path: 'Home.md', kind: 'file', identity: 'home', markdownContent: '[Chart](./a.png)' },
      { path: 'a.png', kind: 'file', identity: 'image' },
    ] },
    { workspaceId: 'destination', entries: [] },
  ],
});
assert.equal(plan.readiness, 'ready');
const groups = groupWorkspaceLinkWrites(plan);
assert.equal(groups.length, 1);
assert.equal(groups[0].workspaceId, 'destination');
assert.equal(groups[0].sourceWorkspaceId, 'source');
assert.equal(groups[0].sourcePathBefore, 'Home.md');
assert.equal(groups[0].path, 'Archive/Home.md');
assert.equal(groups[0].edits.length, 1);
assert.equal(groups[0].afterContent, '[Chart](../Assets/a.png)');
assert.equal(groups[0].afterSha256,
  createHash('sha256').update(groups[0].afterContent).digest('hex'));
assert.throws(() => groupWorkspaceLinkWrites({ ...plan, previewContents: [] }), WorkspaceLinkWriteGroupError);
assert.throws(() => groupWorkspaceLinkWrites({ ...plan, readiness: 'blocked' }), WorkspaceLinkWriteGroupError);
console.log('workspace-link-write-groups-test: ok');
