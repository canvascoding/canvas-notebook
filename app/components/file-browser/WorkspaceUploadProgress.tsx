'use client';

import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cancelUploadCollection, isUploadActive, uploadJobPercent, useUploadStore } from '@/app/store/upload-store';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { UploadProgress } from './UploadProgress';

export function WorkspaceUploadProgress({ className, includeFinished = false }: { className?: string; includeFinished?: boolean }) {
  const t = useTranslations('notebook');
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const jobs = useUploadStore((state) => state.jobs);
  const visibleJobs = Object.values(jobs).filter((job) => job.workspaceId === workspaceId && (includeFinished || isUploadActive(job) || job.phase === 'partial' || job.phase === 'failed'));
  if (!visibleJobs.length) return null;
  return <div className={className}>{visibleJobs.map((job) => (
    <div key={job.id}>
      <UploadProgress value={uploadJobPercent(job)} items={job.items} phase={job.phase} />
      <div className="flex h-7 items-center justify-between text-[11px] text-muted-foreground">{job.phase === 'collecting' && <>
        <span>{t('uploadCollectedEntries', { files: job.collection?.files ?? 0, folders: job.collection?.directories ?? 0 })}</span>
        <Button size="sm" variant="ghost" onClick={() => cancelUploadCollection(job)}>{t('cancel')}</Button>
      </>}</div>
      {job.error && <p className="text-xs text-destructive" role="alert">{job.error}</p>}
    </div>
  ))}</div>;
}
