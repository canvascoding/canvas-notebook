'use client';

import { useEffect } from 'react';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cancelUploadCollection, hydrateMarkdownUploadResumes, isUploadActive, uploadJobPercent, useUploadStore } from '@/app/store/upload-store';
import { subscribeMarkdownUploadCompletion, useFileStore } from '@/app/store/file-store';
import { useAuthenticatedRequestScope } from '@/app/components/auth/AuthenticatedSessionBoundary';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { UploadProgress } from './UploadProgress';

export function WorkspaceUploadProgress({ className, includeFinished = false, workspaceId: requestedWorkspaceId, onConfirmedCompletion }: {
  className?: string; includeFinished?: boolean; workspaceId?: string; onConfirmedCompletion?: () => void;
}) {
  const t = useTranslations('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaceId = requestedWorkspaceId ?? activeWorkspaceId;
  const jobs = useUploadStore((state) => state.jobs);
  const { scope, active } = useAuthenticatedRequestScope();
  useEffect(() => {
    if (!onConfirmedCompletion || !active || !scope || workspaceId !== activeWorkspaceId) return;
    return subscribeMarkdownUploadCompletion(notice => {
      if (notice.completion.status === 'completed' && notice.scope === scope && notice.workspaceId === workspaceId
        && openedDocumentAuthScope() === scope && useWorkspaceStore.getState().activeWorkspaceId === workspaceId) onConfirmedCompletion();
    });
  }, [onConfirmedCompletion, scope, active, workspaceId, activeWorkspaceId]);
  useEffect(() => { if (active && scope) hydrateMarkdownUploadResumes(scope); }, [active, scope]);
  const visibleJobs = Object.values(jobs).filter((job) => workspaceId === activeWorkspaceId && job.workspaceId === workspaceId
    && (!job.accountId || active && job.accountId === scope?.userId)
    && (includeFinished || isUploadActive(job) || job.phase === 'partial' || job.phase === 'failed' || job.phase === 'awaiting_completion'));
  if (!visibleJobs.length) return null;
  return <div className={className}>{visibleJobs.map((job) => (
    <div key={job.id}>
      <UploadProgress value={uploadJobPercent(job)} items={job.items} phase={job.phase} />
      <div className="flex h-7 items-center justify-between text-[11px] text-muted-foreground">{job.phase === 'collecting' && <>
        <span>{t('uploadCollectedEntries', { files: job.collection?.files ?? 0, folders: job.collection?.directories ?? 0 })}</span>
        <Button size="sm" variant="ghost" onClick={() => cancelUploadCollection(job)}>{t('cancel')}</Button>
      </>}</div>
      {job.error && <p className="text-xs text-destructive" role="alert">{job.error}</p>}
      {job.items.filter(item => item.resume).map(item => (
        <div key={item.index} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-xs">
          <div className="min-w-0 flex-1" role="status">
            <p className="break-words font-medium">{item.resume!.targetPath}</p>
            <p className="mt-1 text-muted-foreground">{t(item.resume!.status === 'unavailable'
              ? 'uploadMarkdownUnavailable' : 'uploadMarkdownPending')}</p>
            {item.error && <p className="mt-1 break-words text-destructive" role="alert">{item.error}</p>}
          </div>
          <Button variant="outline" size="sm" disabled={!active || item.resuming}
            onClick={() => { void useFileStore.getState().resumeMarkdownUpload(job.id, item.index).catch(() => undefined); }}>
            {t(item.resuming ? 'uploadMarkdownChecking' : 'uploadMarkdownResume')}
          </Button>
        </div>
      ))}
    </div>
  ))}</div>;
}
