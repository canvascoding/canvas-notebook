import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceExclusiveFilePublication } from '../app/lib/filesystem/workspace-files';

test('exclusive publication compensation proves its own inode and preserves peer files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-exclusive-publication-'));
  const previousData = process.env.DATA; process.env.DATA = root;
  const workspace: WorkspaceContext = { workspaceId: `exclusive-${randomUUID()}`, organizationId: null,
    workspaceType: 'personal', rootPath: path.join(root, 'files'), legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: false, canManageWorkspace: false,
      canCreatePublicLinks: false, canRunAgent: false } };
  await fs.mkdir(workspace.rootPath);
  const { writeFileIfAbsent, rollbackWorkspaceExclusiveFilePublication } = await import('../app/lib/filesystem/workspace-files');
  const options = { workspace };
  const publish = async (filename: string) => {
    let claim: WorkspaceExclusiveFilePublication | undefined;
    await writeFileIfAbsent(filename, 'Exact owned bytes\r\n😀', options, undefined, undefined, value => { claim = value; });
    assert.ok(claim); return claim;
  };
  try {
    const own = await publish('own.md'); let identityChecks = 0;
    await rollbackWorkspaceExclusiveFilePublication(own, async () => { identityChecks++; });
    await assert.rejects(fs.stat(path.join(workspace.rootPath, 'own.md')), { code: 'ENOENT' });
    await rollbackWorkspaceExclusiveFilePublication(own, async () => { throw new Error('Already compensated'); });
    assert.equal(identityChecks, 1);
    await assert.rejects(rollbackWorkspaceExclusiveFilePublication(Object.freeze({}), async () => {}), /attributable/u);

    const changed = await publish('changed.md');
    await fs.writeFile(path.join(workspace.rootPath, 'changed.md'), 'Peer changed bytes');
    await assert.rejects(rollbackWorkspaceExclusiveFilePublication(changed, async () => {}), /changed before compensation/u);
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'changed.md'), 'utf8'), 'Peer changed bytes');

    const replaced = await publish('replaced.md');
    const replacedPath = path.join(workspace.rootPath, 'replaced.md');
    await fs.writeFile(`${replacedPath}.peer`, await fs.readFile(replacedPath));
    await fs.rename(`${replacedPath}.peer`, replacedPath);
    await assert.rejects(rollbackWorkspaceExclusiveFilePublication(replaced, async () => {}), /different file inode/u);
    assert.equal(await fs.readFile(replacedPath, 'utf8'), 'Exact owned bytes\r\n😀');

    const denied = await publish('denied.md');
    await assert.rejects(rollbackWorkspaceExclusiveFilePublication(denied, async () => { throw new Error('Lifecycle changed'); }), /Lifecycle changed/u);
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'denied.md'), 'utf8'), 'Exact owned bytes\r\n😀');
    await assert.rejects(writeFileIfAbsent('denied.md', 'Wrong bytes', options), { code: 'EEXIST' });

    const race = await publish('race.md');
    await assert.rejects(rollbackWorkspaceExclusiveFilePublication(race, async () => {
      const filename = path.join(workspace.rootPath, 'race.md');
      await fs.writeFile(`${filename}.peer`, 'Peer during lifecycle check'); await fs.rename(`${filename}.peer`, filename);
    }), /changed before compensation removal/u);
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'race.md'), 'utf8'), 'Peer during lifecycle check');

    let failedPublication: WorkspaceExclusiveFilePublication | undefined;
    await assert.rejects(writeFileIfAbsent('callback-failed.md', 'Exact owned bytes\r\n😀', options, undefined, undefined, claim => {
      failedPublication = claim; throw new Error('Publication metadata failed');
    }), /Publication metadata failed/u);
    assert.ok(failedPublication);
    await rollbackWorkspaceExclusiveFilePublication(failedPublication, async () => {});
    await assert.rejects(fs.stat(path.join(workspace.rootPath, 'callback-failed.md')), { code: 'ENOENT' });
  } finally {
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    await fs.rm(root, { recursive: true, force: true });
  }
});
