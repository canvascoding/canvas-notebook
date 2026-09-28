import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';

import { createWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-file-operation-planner';

const sha256 = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

async function main() {
  let bytes = Buffer.from('[Chart](./a.png)');
  let writes = 0;
  let blockCollaboration = false;
  mock.module('@/app/lib/filesystem/workspace-files', { exports: {
    readFile: async () => bytes,
  } });
  mock.module('@/app/lib/files/write-service', { exports: {
    writeWorkspaceFileContent: async (input: { content: string; expectedSha256: string }) => {
      if (blockCollaboration) throw new Error('Active collaboration document');
      assert.equal(input.expectedSha256, sha256(bytes));
      writes += 1;
      bytes = Buffer.from(input.content);
      return { stats: { sha256: sha256(bytes) } };
    },
  } });
  const { applyWorkspacePlainLinkWrite, WorkspaceLinkFileWriteError } = await import('../app/lib/markdown/workspace-link-file-write');
  const plan = createWorkspaceFileOperationPlan({
    kind: 'rename', sourceWorkspaceId: 'ws', destinationWorkspaceId: 'ws',
    selections: [{ sourcePath: 'a.png', destinationPath: 'b.png' }],
    snapshots: [{ workspaceId: 'ws', entries: [
      { path: 'Home.md', identity: 'home', kind: 'file', markdownContent: bytes.toString('utf8') },
      { path: 'a.png', identity: 'image', kind: 'file' },
    ] }],
  });
  assert.equal(plan.readiness, 'ready');
  const workspace = { workspaceId: 'ws' } as Parameters<typeof applyWorkspacePlainLinkWrite>[0]['workspace'];
  const input = {
    workspace, fileOptions: { workspace }, actorUserId: 'user', path: 'Home.md',
    edits: plan.linkEdits, afterContent: plan.previewContents[0].content,
  };
  try {
    const applied = await applyWorkspacePlainLinkWrite(input);
    assert.equal(applied.status, 'applied');
    assert.equal(bytes.toString('utf8'), '[Chart](./b.png)');
    assert.equal(writes, 1);
    assert.equal((await applyWorkspacePlainLinkWrite(input)).status, 'already-applied');
    assert.equal(writes, 1, 'retry must not write again');

    bytes = Buffer.from('[Chart](./other.png)');
    await assert.rejects(applyWorkspacePlainLinkWrite(input),
      (error) => error instanceof WorkspaceLinkFileWriteError && error.code === 'LINK_WRITE_STALE');
    assert.equal(writes, 1);

    bytes = Buffer.from('[Chart](./a.png)');
    await assert.rejects(applyWorkspacePlainLinkWrite({ ...input, edits: [{
      ...plan.linkEdits[0], previousTargetLiteral: './wrong.png',
    }] }), (error) => error instanceof WorkspaceLinkFileWriteError && error.code === 'LINK_WRITE_INVALID_PLAN');
    assert.equal(writes, 1);

    blockCollaboration = true;
    await assert.rejects(applyWorkspacePlainLinkWrite(input), /Active collaboration document/u);
    assert.equal(bytes.toString('utf8'), '[Chart](./a.png)', 'active collaboration must retain its file bytes');
    assert.equal(writes, 1);
    console.log('workspace-link-file-write-test: ok');
  } finally {
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
