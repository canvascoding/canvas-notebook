'use client';

import { useRef, useState } from 'react';
import { FolderOpen, Loader2, Plus, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { uploadWorkspaceFiles } from '@/app/lib/files/client';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { HomeSkeleton } from './HomeSkeletons';
import { HomeNewNoteDialog } from './HomeNewNoteDialog';
import { HomeContinueList } from './HomeContinueList';

export function HomeFilesPanel({ workspace, workspaceError }: { workspace?: ClientWorkspaceSummary; workspaceError?: string | null }) {
  const t = useTranslations('home.start');
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const importFiles = async (files: File[]) => {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadWorkspaceFiles({ files, targetDir: '.' });
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : t('uploadFailed'));
    } finally {
      setUploading(false);
      setRevision(value => value + 1);
    }
  };

  return (
    <section aria-labelledby="home-files-heading" className="min-w-0" data-testid="home-files">
      <div className="mb-5 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div className="min-w-0"><div className="mb-1 h-4 truncate text-xs font-medium text-muted-foreground">{workspace ? workspace.name : <HomeSkeleton className="h-3 w-24" />}</div><h1 id="home-files-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('title')}</h1></div>
        <div className="flex min-h-8 flex-wrap items-center gap-2">
          {!workspace ? <HomeSkeleton className="h-8 w-72" /> : <>
          <Button asChild variant="outline" size="sm"><Link href={`/notebook?${new URLSearchParams({ workspaceId: workspace.id })}`} aria-label={t('openNotebook')}><FolderOpen className="h-4 w-4" /><span className="sr-only min-[360px]:not-sr-only">{t('openNotebook')}</span></Link></Button>
          {workspace?.permissions.canWrite ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />{t('newNote')}</Button> : null}
          {workspace.permissions.canWrite ? <>
            <input ref={uploadRef} type="file" multiple className="hidden" aria-label={t('importFiles')} onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={uploading} aria-label={uploading ? t('uploading') : t('importFiles')} title={t('importFiles')} onClick={() => uploadRef.current?.click()}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}</Button>
          </> : null}
          </>}
        </div>
      </div>
      <HomeContinueList key={workspace?.id ?? 'loading'} workspace={workspace} workspaceError={workspaceError} revision={revision} />
      {uploadError ? <p role="alert" className="mt-2 text-sm text-destructive">{uploadError}</p> : null}
      {creating && workspace ? <HomeNewNoteDialog workspaceId={workspace.id} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}
