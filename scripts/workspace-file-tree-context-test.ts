import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildWorkspaceFileTreePrompt,
  replaceWorkspaceFileTreePromptBlock,
  WORKSPACE_FILE_TREE_MAX_PROMPT_BYTES,
} from '../app/lib/agents/workspace-file-tree-context';

async function main() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-tree-'));
  try {
    for (let index = 0; index < 45; index += 1) {
      await fs.mkdir(path.join(workspaceRoot, `root-${String(index).padStart(2, '0')}`), { recursive: true });
    }
    await fs.mkdir(path.join(workspaceRoot, 'alpha', 'beta', 'gamma', 'deeper'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, 'alpha', 'beta', 'gamma', 'another-deeper'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'alpha', 'beta', 'gamma', 'older.md'), 'old');
    await fs.writeFile(path.join(workspaceRoot, 'alpha', 'beta', 'gamma', 'newer.md'), 'new');
    await fs.utimes(
      path.join(workspaceRoot, 'alpha', 'beta', 'gamma', 'older.md'),
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await fs.utimes(
      path.join(workspaceRoot, 'alpha', 'beta', 'gamma', 'newer.md'),
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-01T00:00:00.000Z'),
    );

    for (let index = 0; index < 45; index += 1) {
      await fs.mkdir(path.join(workspaceRoot, 'alpha', `child-${String(index).padStart(2, '0')}`), { recursive: true });
    }
    await fs.writeFile(path.join(workspaceRoot, '.env.local'), 'SECRET=hidden');
    await fs.mkdir(path.join(workspaceRoot, '.hidden'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'unsafe<tree>.md'), 'escaped');
    await fs.symlink(os.tmpdir(), path.join(workspaceRoot, 'outside-link'));

    const first = await buildWorkspaceFileTreePrompt({
      workspaceId: 'workspace-tree-test',
      rootPath: workspaceRoot,
    });

    assert.ok(Buffer.byteLength(first.promptBlock, 'utf8') <= WORKSPACE_FILE_TREE_MAX_PROMPT_BYTES);
    assert.equal(first.diagnostics.displayedRootDirectories, 46);
    for (let index = 0; index < 45; index += 1) {
      assert.match(first.promptBlock, new RegExp(`root-${String(index).padStart(2, '0')}/`));
    }
    assert.match(first.promptBlock, /additional directories omitted/);
    assert.match(first.promptBlock, /newer\.md[\s\S]*older\.md/);
    assert.match(first.promptBlock, /…\/ 2 additional directories omitted/);
    assert.doesNotMatch(first.promptBlock, /\.env\.local|\.hidden|node_modules|outside-link/);
    assert.match(first.promptBlock, /unsafe\\u003ctree\\u003e\.md/);

    await fs.writeFile(path.join(workspaceRoot, 'latest-root-file.md'), 'latest');
    const second = await buildWorkspaceFileTreePrompt({
      workspaceId: 'workspace-tree-test',
      rootPath: workspaceRoot,
    });
    assert.match(second.promptBlock, /latest-root-file\.md/);

    const replaced = replaceWorkspaceFileTreePromptBlock(
      `Base prompt\n\n${first.promptBlock}\n\nTrailing prompt`,
      second.promptBlock,
    );
    assert.equal(replaced.split('<!-- canvas-workspace-file-tree:start -->').length - 1, 1);
    assert.match(replaced, /latest-root-file\.md/);
    assert.match(replaced, /Trailing prompt/);

    const boundedDirectoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-tree-bounded-'));
    try {
      await fs.mkdir(path.join(boundedDirectoryRoot, 'parent'), { recursive: true });
      for (let index = 0; index < 45; index += 1) {
        await fs.mkdir(
          path.join(boundedDirectoryRoot, 'parent', `child-${String(index).padStart(2, '0')}`),
          { recursive: true },
        );
      }
      const bounded = await buildWorkspaceFileTreePrompt({
        workspaceId: 'workspace-tree-bounded',
        rootPath: boundedDirectoryRoot,
      });
      assert.match(bounded.promptBlock, /child-39\//);
      assert.doesNotMatch(bounded.promptBlock, /child-40\//);
      assert.match(bounded.promptBlock, /…\/ 5 additional directories omitted/);
    } finally {
      await fs.rm(boundedDirectoryRoot, { recursive: true, force: true });
    }

    const oversizedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-tree-large-'));
    try {
      for (let index = 0; index < 300; index += 1) {
        await fs.mkdir(
          path.join(oversizedRoot, `${String(index).padStart(3, '0')}-${'very-long-root-directory-name-'.repeat(4)}`),
          { recursive: true },
        );
      }
      const oversized = await buildWorkspaceFileTreePrompt({
        workspaceId: 'workspace-tree-large',
        rootPath: oversizedRoot,
      });
      assert.ok(Buffer.byteLength(oversized.promptBlock, 'utf8') <= WORKSPACE_FILE_TREE_MAX_PROMPT_BYTES);
      assert.equal(oversized.diagnostics.truncatedByByteLimit, true);
      assert.match(oversized.promptBlock, /hard prompt safety limit/);
    } finally {
      await fs.rm(oversizedRoot, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }

  console.log('Workspace file tree context test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
