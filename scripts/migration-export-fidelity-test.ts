import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadArchiveServiceFixture } from './helpers/archive-service-fixture';
import type * as ExportService from '../app/lib/migration/export-service';
import { FILE_ONLY_MIGRATION_COMPONENTS } from '../app/lib/migration/types';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-export-fidelity-'));
  process.env.DATA = process.env.CANVAS_DATA_ROOT = root;
  try {
    const organization = 'workspaces/organization/org/shared/files';
    const personal = 'workspaces/personal/user/files';
    for (const folder of [organization + '/empty', personal, 'workspace/cache']) await fs.mkdir(path.join(root, folder), { recursive: true });
    await fs.writeFile(path.join(root, organization, '日本語.md'), 'organization bytes');
    await fs.writeFile(path.join(root, personal, 'personal.txt'), 'personal bytes');
    await fs.writeFile(path.join(root, 'workspace/cache/keep.txt'), 'user folder named cache');
    const service = loadArchiveServiceFixture<typeof ExportService>('app/lib/migration/export-service.ts');
    for (const includePersonalWorkspaces of [false, true]) {
      const queued = await service.createMigrationExportJob({ components: FILE_ONLY_MIGRATION_COMPONENTS,
        profile: 'full_admin', includePersonalWorkspaces });
      let job = queued;
      for (let n = 0; n < 300 && !['completed', 'failed'].includes(job.status); n++) {
        await delay(10); job = (await service.getMigrationExportJob(queued.id))!;
      }
      assert.equal(job.status, 'completed', job.error || 'Export must complete.');
      const entries: string[] = JSON.parse(execFileSync('python3', ['-c',
        'import zipfile,json,sys; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', job.filePath!], { encoding: 'utf8' }));
      assert.ok(entries.includes('data/' + organization + '/日本語.md'));
      assert.ok(entries.includes('data/' + organization + '/empty/'));
      assert.ok(entries.includes('data/workspace/cache/keep.txt'));
      assert.equal(entries.includes('data/' + personal + '/personal.txt'), includePersonalWorkspaces);
      assert.ok(job.manifest?.directories?.includes('data/' + organization + '/empty/'));
      assert.equal(execFileSync('python3', ['-c', 'import zipfile,sys; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',
        job.filePath!, 'data/' + organization + '/日本語.md'], { encoding: 'utf8' }), 'organization bytes');
    }
    console.log('PASS: organization files, empty directories and user cache folders survive; personal inclusion stays explicit.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
