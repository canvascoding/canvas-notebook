import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  getMigrationUploadPartRange,
  getMigrationUploadTotalParts,
  MIGRATION_UPLOAD_CHUNK_SIZE,
} from '../app/lib/migration/upload-chunks';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-migration-upload-'));
process.env.DATA = dataDir;

async function main(): Promise<void> {
  assert.ok(MIGRATION_UPLOAD_CHUNK_SIZE < 10 * 1024 * 1024);

  const userArchiveSize = 14_785_794;
  assert.equal(getMigrationUploadTotalParts(userArchiveSize), 2);
  assert.deepEqual(getMigrationUploadPartRange(userArchiveSize, 0), {
    start: 0,
    end: MIGRATION_UPLOAD_CHUNK_SIZE,
    size: MIGRATION_UPLOAD_CHUNK_SIZE,
  });
  assert.deepEqual(getMigrationUploadPartRange(userArchiveSize, 1), {
    start: MIGRATION_UPLOAD_CHUNK_SIZE,
    end: userArchiveSize,
    size: userArchiveSize - MIGRATION_UPLOAD_CHUNK_SIZE,
  });

  const {
    createMigrationUpload,
    finalizeMigrationUpload,
    readMigrationUpload,
    writeMigrationUploadPart,
  } = await import('../app/lib/migration/upload-service');

  const archiveBytes = Buffer.from('not a real zip, but enough to test upload assembly');
  const upload = await createMigrationUpload({
    fileName: 'migration.zip',
    totalBytes: archiveBytes.length,
    totalParts: 1,
  });

  await assert.rejects(
    () => writeMigrationUploadPart({
      uploadId: upload.id,
      partIndex: 0,
      expectedBytes: archiveBytes.length,
      body: new Blob([archiveBytes.subarray(0, 10)]).stream(),
    }),
    /Migration upload part size mismatch: part 0 expected/,
  );

  const afterMismatch = await readMigrationUpload(upload.id);
  assert.deepEqual(afterMismatch?.receivedParts, []);

  await writeMigrationUploadPart({
    uploadId: upload.id,
    partIndex: 0,
    expectedBytes: archiveBytes.length,
    body: new Blob([archiveBytes]).stream(),
  });

  const finalized = await finalizeMigrationUpload(upload.id);
  assert.equal(finalized.status, 'completed');
  assert.ok(finalized.archivePath);
  assert.deepEqual(await fs.readFile(finalized.archivePath), archiveBytes);

  console.log('migration-upload-test: ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
