import type { CanvasFullBackupManifest, FullBackupJob } from './types';

export type FullBackupCliJob = Omit<FullBackupJob, 'filePath' | 'manifest'> & {
  manifest?: Omit<CanvasFullBackupManifest, 'files'>;
};

export function serializeFullBackupCliJob(job: FullBackupJob): FullBackupCliJob {
  const { filePath, manifest, ...metadata } = job;
  if (!manifest) return metadata;
  const { files, ...summary } = manifest;
  return { ...metadata, manifest: { ...summary, warnings: summary.warnings.slice(0, 20).map((warning) => warning.slice(0, 1024)) } };
}
