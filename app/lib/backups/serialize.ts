import 'server-only';

import type { FullBackupInspection, FullBackupJob } from '@/app/lib/backups/types';

export type SerializedFullBackupJob = Omit<FullBackupJob, 'filePath'> & {
  downloadUrl: string | null;
  inspectUrl: string | null;
};

export function serializeFullBackupJob(job: FullBackupJob): SerializedFullBackupJob {
  const safeJob = { ...job } as FullBackupJob & { filePath?: string };
  delete safeJob.filePath;
  return {
    ...safeJob,
    downloadUrl: job.status === 'completed' ? `/api/admin/backups/${job.id}/download` : null,
    inspectUrl: job.status === 'completed' ? `/api/admin/backups/${job.id}/inspect` : null,
  };
}

export type SerializedFullBackupInspection = Omit<FullBackupInspection, 'archivePath'>;

export function serializeFullBackupInspection(
  inspection: FullBackupInspection,
): SerializedFullBackupInspection {
  const safeInspection = {
    ...inspection,
  } as Omit<FullBackupInspection, 'archivePath'> & { archivePath?: string };
  delete safeInspection.archivePath;
  return safeInspection;
}
