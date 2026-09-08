'use client';

import { useWorkspaceStore } from '@/app/store/workspace-store';
import { isUploadActive, uploadJobPercent, useUploadStore } from '@/app/store/upload-store';
import { UploadProgress } from './UploadProgress';

export function WorkspaceUploadProgress({ className, includeFinished = false }: { className?: string; includeFinished?: boolean }) {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const jobs = useUploadStore((state) => state.jobs);
  const visibleJobs = Object.values(jobs).filter((job) => job.workspaceId === workspaceId && (includeFinished || isUploadActive(job)));
  if (!visibleJobs.length) return null;
  return <div className={className}>{visibleJobs.map((job) => (
    <UploadProgress key={job.id} value={uploadJobPercent(job)} items={job.items} phase={job.phase} />
  ))}</div>;
}
