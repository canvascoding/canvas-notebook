import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const original = '![](asset.png)';
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  let content = original;
  let writes = 0;
  mock.module('@/app/lib/filesystem/workspace-files', { exports: { readFile: async () => Buffer.from(content) } });
  mock.module('@/app/lib/files/write-service', { exports: { writeWorkspaceFileContent: async (input: {
    content: string; expectedSha256: string;
  }) => {
    assert.equal(input.expectedSha256, hash(content));
    content = input.content; writes += 1;
    return { stats: { sha256: hash(content) } };
  } } });
  try {
    const { applyWorkspacePlainLinkWrite } = await import('../app/lib/markdown/workspace-link-file-write');
    const workspace = { workspaceId: 'empty-link-test' } as WorkspaceContext;
    const input = (before: string, after: string) => ({ workspace, fileOptions: { workspace },
      actorUserId: 'test-user', path: 'index.md', afterContent: after,
      edits: [{ sourceWorkspaceId: workspace.workspaceId, destinationWorkspaceId: workspace.workspaceId,
        sourcePathBefore: 'index.md', sourcePathAfter: 'index.md', expectedContentHash: hash(before),
        previousTargetLiteral: before, nextTargetLiteral: after,
        targetRange: { startUtf16: 0, endUtf16: before.length, startUtf8Byte: 0, endUtf8Byte: Buffer.byteLength(before) } }] });
    await applyWorkspacePlainLinkWrite(input(original, ''));
    assert.equal(content, '');
    await applyWorkspacePlainLinkWrite(input('', original));
    assert.equal(content, original);
    assert.equal((await applyWorkspacePlainLinkWrite(input('', original))).status, 'already-applied');
    assert.equal(writes, 2);
    content = 'User edit';
    await assert.rejects(applyWorkspacePlainLinkWrite(input('', original)), { code: 'LINK_WRITE_STALE' });
    assert.equal(content, 'User edit');
    content = '';
    const malformed = input('', original);
    malformed.edits[0].targetRange.endUtf16 = 1;
    await assert.rejects(applyWorkspacePlainLinkWrite(malformed), { code: 'LINK_WRITE_INVALID_PLAN' });
    assert.equal(content, '');
    console.log('workspace-link-empty-file-restore-test: ok');
  } finally { mock.reset(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
