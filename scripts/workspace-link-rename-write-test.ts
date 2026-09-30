import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';

async function main() {
  const content = Buffer.from('[[Target]]\n');
  const writes: Array<Record<string, unknown>> = [];
  let blockActiveDocument = false;
  mock.module('@/app/lib/filesystem/workspace-files', { exports: {
    readFile: async () => content,
  } });
  mock.module('@/app/lib/files/write-service', { exports: {
    writeWorkspaceFileContent: async (input: Record<string, unknown>) => {
      if (blockActiveDocument) {
        throw Object.assign(new Error('Active collaboration document'), {
          code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED',
        });
      }
      writes.push(input);
    },
  } });
  const { buildWorkspaceLinkIndexFromDocuments } = await import('../app/lib/markdown/workspace-link-index-core');
  const { applyWorkspaceLinkRename } = await import('../app/lib/markdown/workspace-link-index');
  const index = buildWorkspaceLinkIndexFromDocuments([
    { path: 'Home.md', content: content.toString('utf8') },
    { path: 'Target.md', content: '# Target' },
  ]);
  const workspace = { workspaceId: 'workspace' } as Parameters<typeof applyWorkspaceLinkRename>[3]['workspace'];
  const fileOptions = { workspace };
  const context = { workspace, fileOptions, actorUserId: 'user' };
  try {
    const applied = await applyWorkspaceLinkRename(index, 'Target.md', 'New.md', context);
    assert.deepEqual(applied.updatedFiles, ['Home.md']);
    assert.equal(applied.updatedLinks, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expectedSha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(writes[0].requireExpectedRevision, true);
    assert.equal(writes[0].ensureCollaborationDocument, false);
    assert.equal(writes[0].actorUserId, 'user');
    blockActiveDocument = true;
    const blocked = await applyWorkspaceLinkRename(index, 'Target.md', 'New.md', context);
    assert.deepEqual(blocked.updatedFiles, []);
    assert.equal(blocked.updatedLinks, 0);
    assert.match(blocked.warnings.join(' '), /Active collaboration document/u);
    assert.equal(writes.length, 1, 'blocked collaboration must not write Markdown bytes');
    console.log('workspace-link-rename-write-test: ok');
  } finally {
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
