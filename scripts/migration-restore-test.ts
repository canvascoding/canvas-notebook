import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openMigrationArchive, stageMigrationEntry } from '../app/lib/migration/archive';
import { mapMigrationWorkspaces, parseMigrationMappingChoices } from '../app/lib/migration/mappings';
import { prepareRestoreFileJournal, publishRestoreFiles, rollbackRestoreFiles } from '../app/lib/migration/restore-files';
import type { CanvasMigrationManifest, MigrationWorkspaceDescriptor } from '../app/lib/migration/types';
import type { Client } from 'pg';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-restore-'));
  process.env.DATA = process.env.CANVAS_DATA_ROOT = root;
  try {
    const zip = path.join(root, 'valid.zip');
    execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("manifest.json","{}"); z.writestr("data/workspace/a.txt","verified bytes"); z.close()', zip]);
    const entries = await openMigrationArchive(zip);
    await stageMigrationEntry(entries.find(e => e.path.endsWith('a.txt'))!, path.join(root, 'staged'));
    assert.equal(await fs.readFile(path.join(root, 'staged'), 'utf8'), 'verified bytes');
    await assert.rejects(stageMigrationEntry(entries.find(e => e.path.endsWith('a.txt'))!, path.join(root, 'bad-hash'), '0'.repeat(64)), /checksum/);
    for (const [name, source] of [
      ['traversal', 'z.writestr("data/../escape","x")'],
      ['duplicate', 'z.writestr("data/a","x"); z.writestr("data/A","y")'],
      ['link', 'i=zipfile.ZipInfo("data/link"); i.external_attr=(0o120777<<16); z.writestr(i,"outside")'],
    ]) {
      const file = path.join(root, name + '.zip');
      execFileSync('python3', ['-W', 'ignore', '-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); ' + source + '; z.close()', file]);
      await assert.rejects(openMigrationArchive(file));
    }
    const source: MigrationWorkspaceDescriptor = { id: 'source', type: 'personal', rootRelativePath: 'workspaces/personal/source-user/nested/files', displayName: 'Notes', organizationId: null, ownerUserId: 'source-user' };
    const target: MigrationWorkspaceDescriptor = { ...source, id: 'target', ownerUserId: 'target-user', rootRelativePath: 'workspaces/personal/target-user/different/files' };
    const manifest = { workspaces: [source] } as CanvasMigrationManifest;
    const input = { manifest, archivePaths: ['data/' + source.rootRelativePath + '/note.md'], targets: [target],
      users: [{ sourceUserId: 'source-user', sourceEmail: null, targetUserId: 'target-user', targetEmail: null, status: 'mapped' as const, required: true, reason: '' }] };
    assert.equal(mapMigrationWorkspaces(input)[0].status, 'proposed');
    const choices = { users: {}, workspaces: { ['data/' + source.rootRelativePath]: target.id } };
    assert.equal(mapMigrationWorkspaces({ ...input, choices })[0].status, 'mapped');
    assert.throws(() => mapMigrationWorkspaces({ ...input, users: [], choices }), /owner/);
    assert.throws(() => parseMigrationMappingChoices({ users: { a: 1 } }));
    await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
    await fs.writeFile(path.join(root, 'workspace/old.txt'), 'old bytes');
    const journal = await prepareRestoreFileJournal({ id: randomUUID(), dataRoot: root, directories: ['workspace/new-dir'], files: [
      { target: 'workspace/old.txt', staged: 'staged', workspaceId: null, workspacePath: null },
      { target: 'workspace/new-dir/new.txt', staged: 'missing', workspaceId: null, workspacePath: null },
    ] });
    await assert.rejects(publishRestoreFiles(root, journal), /ENOENT/);
    assert.equal(await fs.readFile(path.join(root, 'workspace/old.txt'), 'utf8'), 'verified bytes');
    await rollbackRestoreFiles(root, journal);
    await rollbackRestoreFiles(root, journal);
    assert.equal(await fs.readFile(path.join(root, 'workspace/old.txt'), 'utf8'), 'old bytes');
    await assert.rejects(fs.stat(path.join(root, 'workspace/new-dir')), /ENOENT/);
    await fs.symlink(os.tmpdir(), path.join(root, 'workspace/outside'));
    await assert.rejects(prepareRestoreFileJournal({ id: randomUUID(), dataRoot: root, directories: [], files: [
      { target: 'workspace/outside/file', staged: 'staged', workspaceId: null, workspacePath: null },
    ] }), /symbolic/);
    const { getUnifiedEnvFilePath, mutateUnifiedSecretValue, readUnifiedSecretValue } = await import('../app/lib/secrets/unified-env-store');
    const { resetMigrationSecrets, restoreMigrationSecrets } = await import('../app/lib/migration/restore-secrets');
    const scope = { secretScope: 'system' as const };
    await mutateUnifiedSecretValue('CANVAS_CREDENTIAL_PI_OAUTH', async () => '{"fixture":true}', scope);
    await mutateUnifiedSecretValue('MIGRATION_KEEP_API_KEY', async () => 'fixture-api-key', scope);
    const previous = await fs.readFile(getUnifiedEnvFilePath(scope));
    const secretsJournal = await prepareRestoreFileJournal({ id: randomUUID(), dataRoot: root, directories: [], files: [] });
    await resetMigrationSecrets({ query: async () => ({ rows: [] }) } as unknown as Client, root, secretsJournal);
    assert.equal(readUnifiedSecretValue('CANVAS_CREDENTIAL_PI_OAUTH', scope), 'null');
    assert.equal(readUnifiedSecretValue('MIGRATION_KEEP_API_KEY', scope), 'fixture-api-key');
    await restoreMigrationSecrets(root, secretsJournal);
    assert.deepEqual(await fs.readFile(getUnifiedEnvFilePath(scope)), previous);
    console.log('PASS: archive checksums/unsafe paths/links, explicit owner mapping, interrupted publication rollback, symlink targets and OAuth reset preserving API keys with exact rollback.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
