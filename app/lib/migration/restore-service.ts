import 'server-only';

import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import { getPendingRestorePath, getMigrationUploadsRoot } from '@/app/lib/migration/paths';
import { withFileMutationLock } from '@/app/lib/secrets/file-mutation-lock';
import { migrationFileSha256 } from './archive';
import { migrationTargetFingerprint, readMigrationJson, writeMigrationJson } from './restore-storage';
import type {
  MigrationInspection,
  MigrationUploadStatus,
  PendingMigrationRestore,
  MigrationMappingChoices,
} from '@/app/lib/migration/types';

export async function writePendingMigrationRestore(params: {
  upload: MigrationUploadStatus;
  inspection: MigrationInspection;
  mappings?: MigrationMappingChoices;
  beforePublish?: (pending: PendingMigrationRestore) => Promise<void>;
  requestedBy: {
    userId: string;
    email: string;
  };
}): Promise<PendingMigrationRestore> {
  if (params.upload.status !== 'completed' || !params.upload.archivePath) {
    throw new Error('Migration upload is not finalized.');
  }
  if (!params.inspection.canRestore || !params.inspection.manifest) {
    throw new Error('Migration archive cannot be restored.');
  }
  if (params.inspection.dryRun && !params.inspection.dryRun.canApply) {
    throw new Error('Migration dry run has unresolved blockers and cannot be restored.');
  }
  const archive = await fs.realpath(params.upload.archivePath);
  const uploadsRoot = await fs.realpath(getMigrationUploadsRoot());
  if (!archive.startsWith(uploadsRoot + path.sep) || !params.upload.archiveSha256
    || await migrationFileSha256(archive) !== params.upload.archiveSha256) throw new Error('The finalized migration archive changed. Upload and inspect it again.');

  const pending: PendingMigrationRestore = {
    id: crypto.randomUUID(),
    uploadId: params.upload.id,
    archivePath: archive,
    archiveSha256: params.upload.archiveSha256,
    targetFingerprint: await migrationTargetFingerprint(),
    mappings: params.mappings,
    requestedAt: new Date().toISOString(),
    requestedBy: params.requestedBy,
    components: params.inspection.manifest.components,
    invalidateSessions: true,
    pauseAutomations: true,
    clearOAuthTokens: true,
    preserveTargetInstanceAndLicense: true,
  };

  const pendingPath = getPendingRestorePath();
  return withFileMutationLock(pendingPath, async () => {
    if (await readMigrationJson(pendingPath)) throw Object.assign(new Error('A migration restore is already pending. Restart the application before staging another restore.'), { status: 409 });
    await params.beforePublish?.(pending);
    await writeMigrationJson(pendingPath, pending);
    return pending;
  });
}

export function scheduleMigrationRestartIfSupported(): boolean {
  const isDockerRuntime = process.env.CANVAS_RUNTIME_ENV === 'docker';
  if (!isDockerRuntime) return false;

  setTimeout(() => {
    process.exit(0);
  }, 1500).unref();
  return true;
}
