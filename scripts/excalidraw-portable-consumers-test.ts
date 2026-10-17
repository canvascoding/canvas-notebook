import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type * as Backup from '@/app/lib/backups/full-backup-service';
import type * as Export from '@/app/lib/migration/export-service';
import { MIGRATION_COMPONENT_KEYS } from '@/app/lib/migration/types';

const requireDependency = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
function loadModule<T>(filename: string, dependencies: Record<string, unknown>): T {
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const evaluated = { exports: {} };
  const localRequire = createRequire(path.resolve(filename));
  const load = (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name]
    : name.startsWith('.') ? localRequire(name) : requireDependency(name);
  new Function('require', 'module', 'exports', javascript)(load, evaluated, evaluated.exports);
  return evaluated.exports as T;
}

async function finished<T extends { status: string }>(get: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await get();
    if (job?.status === 'completed' || job?.status === 'failed') return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('The portable consumer did not finish.');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-excalidraw-consumers-'));
  const previous = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT,
    DATABASE_URL: process.env.DATABASE_URL, CANVAS_PG_DUMP_BIN: process.env.CANVAS_PG_DUMP_BIN };
  process.env.DATA = root;
  process.env.CANVAS_DATA_ROOT = root;
  process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/consumer_test';
  const marker = path.join(root, 'pg-dump-called');
  const dump = path.join(root, 'fake-pg-dump');
  const portablePath = path.join(root, 'workspace', 'scene.excalidraw');
  let fail = true;
  let validations = 0;
  try {
    await fs.mkdir(path.dirname(portablePath), { recursive: true });
    await fs.writeFile(portablePath, '{"type":"excalidraw","elements":[],"appState":{},"files":{}}');
    await fs.writeFile(dump, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(marker)}, 'called');\nif (args.includes('--version')) { console.log('pg_dump (PostgreSQL) 18.4'); process.exit(0); }\nfs.writeFileSync(args[args.indexOf('--file') + 1], 'isolated fake PostgreSQL dump');\n`);
    await fs.chmod(dump, 0o700);
    process.env.CANVAS_PG_DUMP_BIN = dump;
    const dependency = { '@/app/lib/excalidraw-collaboration/checkpoint-worker': {
      ensureExcalidrawCheckpointsCurrent: async () => {
        validations += 1;
        if (fail) throw Object.assign(new Error('Fixture checkpoint conflict.'), { code: 'EXCALIDRAW_CHECKPOINT_NOT_CURRENT', status: 409 });
        await fs.writeFile(portablePath, '{"type":"excalidraw","elements":[{"id":"fresh"}],"appState":{},"files":{}}');
      },
    } };
    const backup = loadModule<typeof Backup>('app/lib/backups/full-backup-service.ts', dependency);
    const migration = loadModule<typeof Export>('app/lib/migration/export-service.ts', dependency);
    const components = Object.fromEntries(MIGRATION_COMPONENT_KEYS.map(key => [key, key === 'workspace']));
    const blockedBackup = await backup.createFullBackupJob();
    const backupFailure = await finished(() => backup.getFullBackupJob(blockedBackup.id));
    assert.equal(backupFailure.status, 'failed');
    assert.match(backupFailure.error ?? '', /checkpoint conflict/u);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'A failed checkpoint must stop the backup before pg_dump.');
    const blockedExport = await migration.createMigrationExportJob({ components, includePersonalWorkspaces: false });
    const exportFailure = await finished(() => migration.getMigrationExportJob(blockedExport.id));
    assert.equal(exportFailure.status, 'failed');
    assert.match(exportFailure.error ?? '', /checkpoint conflict/u);
    assert.equal(validations, 2);
    fail = false;
    const acceptedBackup = await backup.createFullBackupJob();
    const backupSuccess = await finished(() => backup.getFullBackupJob(acceptedBackup.id));
    assert.equal(backupSuccess.status, 'completed', backupSuccess.error ?? '');
    assert.ok(backupSuccess.filePath);
    const backupPortable = await execFileAsync('unzip', ['-p', backupSuccess.filePath, 'data/workspace/scene.excalidraw'], { encoding: 'utf8' });
    assert.equal(JSON.parse(backupPortable.stdout).elements[0].id, 'fresh');
    const acceptedExport = await migration.createMigrationExportJob({ components, includePersonalWorkspaces: false });
    const exportSuccess = await finished(() => migration.getMigrationExportJob(acceptedExport.id));
    assert.equal(exportSuccess.status, 'completed', exportSuccess.error ?? '');
    assert.ok(exportSuccess.filePath);
    const exportPortable = await execFileAsync('unzip', ['-p', exportSuccess.filePath, 'data/workspace/scene.excalidraw'], { encoding: 'utf8' });
    assert.equal(JSON.parse(exportPortable.stdout).elements[0].id, 'fresh');
    assert.equal(validations, 4);
    console.log(JSON.stringify({ success: true, backupAndExport: true, failedCheckpointBlocksArtifacts: true,
      freshnessBeforeDumpAndArchive: true, isolatedFilesystem: true, substitutedCheckpointAndPgDump: true }));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main();
