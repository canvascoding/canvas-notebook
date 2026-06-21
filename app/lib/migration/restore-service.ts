import 'server-only';

import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import { getPendingRestorePath, ensureMigrationDir } from '@/app/lib/migration/paths';
import type {
  MigrationInspection,
  MigrationUploadStatus,
  PendingMigrationRestore,
} from '@/app/lib/migration/types';

export async function writePendingMigrationRestore(params: {
  upload: MigrationUploadStatus;
  inspection: MigrationInspection;
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

  const pending: PendingMigrationRestore = {
    id: crypto.randomUUID(),
    uploadId: params.upload.id,
    archivePath: params.upload.archivePath,
    requestedAt: new Date().toISOString(),
    requestedBy: params.requestedBy,
    components: params.inspection.manifest.components,
    invalidateSessions: true,
    pauseAutomations: true,
    clearOAuthTokens: true,
    preserveTargetInstanceAndLicense: true,
  };

  const pendingPath = getPendingRestorePath();
  await ensureMigrationDir(path.dirname(pendingPath));
  await fs.writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(pendingPath, 0o600).catch(() => undefined);
  return pending;
}

export function scheduleMigrationRestartIfSupported(): boolean {
  const isDockerRuntime = process.env.CANVAS_RUNTIME_ENV === 'docker';
  if (!isDockerRuntime) return false;

  setTimeout(() => {
    process.exit(0);
  }, 1500).unref();
  return true;
}
