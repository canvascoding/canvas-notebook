import 'server-only';

import crypto from 'crypto';
import path from 'path';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';

import { ensureMigrationDir, getMigrationUploadsRoot } from '@/app/lib/migration/paths';
import type { MigrationUploadStatus } from '@/app/lib/migration/types';

const UPLOAD_STATUS_FILE = 'status.json';
const MAX_ARCHIVE_BYTES = Number(process.env.MIGRATION_MAX_ARCHIVE_BYTES || 50 * 1024 * 1024 * 1024);

function isValidUploadId(uploadId: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(uploadId);
}

function getUploadDir(uploadId: string): string {
  return path.join(getMigrationUploadsRoot(), uploadId);
}

function getUploadPartsDir(uploadId: string): string {
  return path.join(getUploadDir(uploadId), 'parts');
}

function getUploadStatusPath(uploadId: string): string {
  return path.join(getUploadDir(uploadId), UPLOAD_STATUS_FILE);
}

function getPartPath(uploadId: string, partIndex: number): string {
  return path.join(getUploadPartsDir(uploadId), `${partIndex.toString().padStart(8, '0')}.part`);
}

export function getUploadArchivePath(uploadId: string): string {
  return path.join(getUploadDir(uploadId), 'archive.zip');
}

async function writeUploadStatus(status: MigrationUploadStatus): Promise<void> {
  await ensureMigrationDir(getUploadDir(status.id));
  status.updatedAt = new Date().toISOString();
  await fs.writeFile(getUploadStatusPath(status.id), `${JSON.stringify(status, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(getUploadStatusPath(status.id), 0o600).catch(() => undefined);
}

export async function readMigrationUpload(uploadId: string): Promise<MigrationUploadStatus | null> {
  if (!isValidUploadId(uploadId)) return null;
  try {
    const raw = await fs.readFile(getUploadStatusPath(uploadId), 'utf8');
    return JSON.parse(raw) as MigrationUploadStatus;
  } catch {
    return null;
  }
}

export async function createMigrationUpload(params: {
  fileName: string;
  totalBytes: number;
  totalParts: number;
}): Promise<MigrationUploadStatus> {
  if (!params.fileName.trim().toLowerCase().endsWith('.zip')) {
    throw new Error('Migration upload must be a ZIP file.');
  }
  if (!Number.isSafeInteger(params.totalBytes) || params.totalBytes <= 0 || params.totalBytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`Migration archive size is invalid or exceeds the configured limit (${MAX_ARCHIVE_BYTES} bytes).`);
  }
  if (!Number.isSafeInteger(params.totalParts) || params.totalParts <= 0 || params.totalParts > 100000) {
    throw new Error('Migration upload part count is invalid.');
  }

  const id = crypto.randomUUID();
  await ensureMigrationDir(getUploadPartsDir(id));
  const now = new Date().toISOString();
  const status: MigrationUploadStatus = {
    id,
    fileName: path.basename(params.fileName),
    totalBytes: params.totalBytes,
    totalParts: params.totalParts,
    receivedParts: [],
    createdAt: now,
    updatedAt: now,
    status: 'receiving',
  };
  await writeUploadStatus(status);
  return status;
}

export async function writeMigrationUploadPart(params: {
  uploadId: string;
  partIndex: number;
  expectedBytes?: number;
  body: ReadableStream<Uint8Array> | null;
}): Promise<MigrationUploadStatus> {
  const status = await readMigrationUpload(params.uploadId);
  if (!status) throw new Error('Unknown migration upload.');
  if (status.status !== 'receiving') throw new Error('Migration upload is not accepting parts.');
  if (!params.body) throw new Error('Upload part body is required.');
  if (!Number.isSafeInteger(params.partIndex) || params.partIndex < 0 || params.partIndex >= status.totalParts) {
    throw new Error('Upload part index is invalid.');
  }
  if (params.expectedBytes !== undefined && (!Number.isSafeInteger(params.expectedBytes) || params.expectedBytes < 0)) {
    throw new Error('Upload part expected byte count is invalid.');
  }

  await ensureMigrationDir(getUploadPartsDir(params.uploadId));
  const partPath = getPartPath(params.uploadId, params.partIndex);
  await pipeline(
    Readable.fromWeb(params.body as unknown as NodeReadableStream<Uint8Array>),
    createWriteStream(partPath, { mode: 0o600 }),
  );
  await fs.chmod(partPath, 0o600).catch(() => undefined);
  const stats = await fs.stat(partPath);
  if (params.expectedBytes !== undefined && stats.size !== params.expectedBytes) {
    await fs.rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`Migration upload part size mismatch: part ${params.partIndex} expected ${params.expectedBytes}, got ${stats.size}.`);
  }

  if (!status.receivedParts.includes(params.partIndex)) {
    status.receivedParts.push(params.partIndex);
    status.receivedParts.sort((a, b) => a - b);
  }
  await writeUploadStatus(status);
  return status;
}

export async function finalizeMigrationUpload(uploadId: string): Promise<MigrationUploadStatus> {
  const status = await readMigrationUpload(uploadId);
  if (!status) throw new Error('Unknown migration upload.');
  if (status.status === 'completed') return status;
  if (status.status !== 'receiving') throw new Error('Migration upload cannot be finalized.');
  if (status.receivedParts.length !== status.totalParts) {
    throw new Error(`Migration upload is incomplete (${status.receivedParts.length}/${status.totalParts} parts).`);
  }

  status.status = 'finalizing';
  await writeUploadStatus(status);

  const archivePath = getUploadArchivePath(uploadId);
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;

  try {
    const output = createWriteStream(archivePath, { mode: 0o600 });
    for (let index = 0; index < status.totalParts; index++) {
      const partPath = getPartPath(uploadId, index);
      const stats = await fs.stat(partPath);
      totalBytes += stats.size;
      await pipeline(
        createReadStream(partPath).on('data', (chunk) => hash.update(chunk)),
        output,
        { end: false },
      );
    }
    output.end();
    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });

    if (totalBytes !== status.totalBytes) {
      throw new Error(`Migration upload size mismatch: expected ${status.totalBytes}, got ${totalBytes}.`);
    }

    status.archivePath = archivePath;
    status.archiveSha256 = hash.digest('hex');
    status.status = 'completed';
    await fs.chmod(archivePath, 0o600).catch(() => undefined);
    await fs.rm(getUploadPartsDir(uploadId), { recursive: true, force: true }).catch(() => undefined);
    await writeUploadStatus(status);
    return status;
  } catch (error) {
    status.status = 'failed';
    status.error = error instanceof Error ? error.message : 'Failed to finalize migration upload.';
    await writeUploadStatus(status);
    throw error;
  }
}

export async function attachInspectionToUpload(uploadId: string, inspection: MigrationUploadStatus['inspection']) {
  const status = await readMigrationUpload(uploadId);
  if (!status) throw new Error('Unknown migration upload.');
  status.inspection = inspection;
  await writeUploadStatus(status);
  return status;
}
