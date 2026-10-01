import assert from 'node:assert/strict';
import { serializeFullBackupCliJob } from '../app/lib/backups/cli-result';
import type { FullBackupJob } from '../app/lib/backups/types';

const job = {
  id: 'backup-id',
  status: 'completed',
  filePath: '/data/private.zip',
  archiveSha256: 'a'.repeat(64),
  source: { databaseProvider: 'postgres' },
  manifest: {
    backupId: 'backup-id',
    database: { provider: 'postgres', backupKind: 'postgres_dump' },
    scope: { dataOnly: true },
    consistency: { database: 'consistent_snapshot', files: 'online_best_effort', appStopped: false },
    fileCount: 10_000,
    warnings: Array.from({ length: 1000 }, () => 'w'.repeat(2000)),
    files: Array.from({ length: 10_000 }, (_, i) => ({ archivePath: `users/private/${i}/${'x'.repeat(200)}`, sha256: 'a'.repeat(64), size: 1 })),
  },
} as unknown as FullBackupJob;

assert.ok(Buffer.byteLength(JSON.stringify(job)) > 2 * 1024 * 1024);
const result = serializeFullBackupCliJob(job);
assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32 * 1024);
assert.equal('filePath' in result, false);
assert.equal('files' in result.manifest!, false);
assert.equal(result.manifest?.fileCount, 10_000);
assert.equal(result.manifest?.database.backupKind, 'postgres_dump');
assert.equal(result.manifest?.scope.dataOnly, true);
assert.equal(result.archiveSha256, job.archiveSha256);
assert.equal(job.manifest?.files.length, 10_000);
assert.equal(serializeFullBackupCliJob({ ...job, manifest: undefined }).id, job.id);
console.log('Large backup CLI results remain bounded and preserve upload metadata');
