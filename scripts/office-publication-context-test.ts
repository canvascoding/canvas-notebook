import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFile, writeFileIfAbsent, replaceWorkspaceFileFromPath } from '../app/lib/filesystem/workspace-files';
import { assertOfficePublicationAllowed, OfficePublicationRequiredError, withOfficePublication } from '../app/lib/office/publication-context';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-office-publication-'));
  const previousData = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  const workspace: WorkspaceContext = {
    workspaceId: 'office-publication-test', workspaceType: 'personal', rootPath: path.join(dataRoot, 'workspace'),
    ownerUserId: 'owner', organizationId: null, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
  };
  const options = { workspace };
  try {
    await fs.mkdir(workspace.rootPath);
    const source = path.join(dataRoot, 'staged-upload');
    await fs.writeFile(source, 'test content');
    await assert.rejects(writeFile('report.docx', 'unsafe', options), OfficePublicationRequiredError);
    await assert.rejects(writeFileIfAbsent('report.docx', 'unsafe', options), OfficePublicationRequiredError);
    await assert.rejects(replaceWorkspaceFileFromPath(source, 'report.docx', options, async () => undefined), OfficePublicationRequiredError);
    await withOfficePublication(workspace.workspaceId, './report.docx', async () => {
      assertOfficePublicationAllowed(workspace.workspaceId, 'report.docx');
      assert.throws(() => assertOfficePublicationAllowed('other-workspace', 'report.docx'), OfficePublicationRequiredError);
      assert.throws(() => assertOfficePublicationAllowed(workspace.workspaceId, 'other.docx'), OfficePublicationRequiredError);
      await writeFileIfAbsent('report.docx', 'complete content', options, async () => {
        await assert.rejects(fs.stat(path.join(workspace.rootPath, 'report.docx')), { code: 'ENOENT' });
        const staged = (await fs.readdir(workspace.rootPath)).find((entry) => entry.includes('.canvas-create-'));
        assert.ok(staged);
        assert.equal(await fs.readFile(path.join(workspace.rootPath, staged), 'utf8'), 'complete content');
      });
    });
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'report.docx'), 'utf8'), 'complete content');
    await assert.rejects(withOfficePublication(workspace.workspaceId, 'report.docx', () => writeFileIfAbsent('report.docx', 'replacement', options)), { code: 'EEXIST' });
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'report.docx'), 'utf8'), 'complete content');

    const expected = new Error('Publication cancelled');
    await assert.rejects(withOfficePublication(workspace.workspaceId, 'cancelled.docx', () => (
      writeFileIfAbsent('cancelled.docx', 'cancelled', options, async () => { throw expected; })
    )), (error) => error === expected);
    await assert.rejects(fs.stat(path.join(workspace.rootPath, 'cancelled.docx')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(workspace.rootPath), ['report.docx']);
    assert.throws(() => assertOfficePublicationAllowed(workspace.workspaceId, 'report.docx'), OfficePublicationRequiredError);

    let wake!: () => void;
    const deferred = new Promise<void>((resolve) => { wake = resolve; });
    let escaped!: Promise<void>;
    await withOfficePublication(workspace.workspaceId, 'report.docx', async () => {
      escaped = deferred.then(() => assertOfficePublicationAllowed(workspace.workspaceId, 'report.docx'));
    });
    const rejects = assert.rejects(escaped, OfficePublicationRequiredError);
    wake();
    await rejects;
    await writeFileIfAbsent('ordinary.txt', 'ordinary content', options);
    console.log('Office publication capabilities and atomic create tests passed.');
  } finally {
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousData;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
