import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

async function workspacePreviewBusyPostgresTest() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { withWorkspaceRequestPrincipal } = await import('../app/lib/workspaces/request-principal');
    const { readWorkspacePathImportPreparationPlan, WorkspacePathImportPreviewError } = await import('../app/lib/files/workspace-path-import-operation-preview');
    const file = path.join(h.source.rootPath, 'busy-original.txt');
    const bytes = Buffer.from('Keep these original bytes through authorization contention.\n');
    await fs.writeFile(file, bytes, { flag: 'wx' });
    const selections = [{ sourcePath: 'busy-original.txt', destinationPath: 'busy-renamed.txt' }];
    const original = await h.request(h.source, 'owner');
    let failure: unknown;
    await withWorkspaceRequestPrincipal(original, { workspaceId: h.source.workspaceId, permission: 'canWrite' }, async principal => {
      await h.admin.query('BEGIN');
      try {
        // Same lock conflict reported by the actual failed compiled UI run.
        await h.admin.query("SELECT organization_id FROM canvas_organization_settings WHERE organization_id='principal-org' FOR NO KEY UPDATE");
        try { await readWorkspacePathImportPreparationPlan({ principal: { kind: 'request', principal }, kind: 'rename', selections }); }
        catch (error) { failure = error; }
      } finally { await h.admin.query('ROLLBACK'); }
    }).catch(error => { failure ??= error; });
    assert(failure instanceof WorkspacePathImportPreviewError, 'A real row-lock conflict must not escape as a generic 500');
    assert.equal(failure.code, 'PATH_IMPORT_PREVIEW_BUSY'); assert.equal(failure.status, 409);
    assert.deepEqual(await fs.readFile(file), bytes);
    const plan = await withWorkspaceRequestPrincipal(await h.request(h.source, 'owner'),
      { workspaceId: h.source.workspaceId, permission: 'canWrite' }, principal =>
        readWorkspacePathImportPreparationPlan({ principal: { kind: 'request', principal }, kind: 'rename', selections }));
    assert.equal(plan.readiness, 'native-ready');
    assert.deepEqual(await fs.readFile(file), bytes);
    await assert.rejects(fs.stat(path.join(h.source.rootPath, 'busy-renamed.txt')), { code: 'ENOENT' });
    console.log('Real PostgreSQL preview contention: typed busy, fresh principal recovery, original file preserved');
  });
}
void workspacePreviewBusyPostgresTest().catch(error => { console.error(error); process.exitCode = 1; });
