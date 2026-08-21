import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-atomic-write-'));
  const workspace: WorkspaceContext = {
    workspaceId: 'atomic-write-test',
    workspaceType: 'personal',
    rootPath: root,
    rootRelativePath: '.',
    displayName: 'Atomic write test',
    status: 'active',
    organizationId: null,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };

  try {
    const { writeFile } = await import('../app/lib/filesystem/workspace-files');
    await fs.writeFile(path.join(root, 'deck.md'), 'before\n', { mode: 0o640 });
    await writeFile('deck.md', 'after\n', { workspace });

    assert.equal(await fs.readFile(path.join(root, 'deck.md'), 'utf8'), 'after\n');
    assert.equal((await fs.stat(path.join(root, 'deck.md'))).mode & 0o777, 0o640);
    assert.equal((await fs.readdir(root)).some((name) => name.includes('.canvas-write-')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log('atomic-workspace-write-test: ok');
}

void main();
