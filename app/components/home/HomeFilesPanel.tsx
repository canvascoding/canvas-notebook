'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, FileText, FolderOpen, Loader2, Pin, Plus, Search, Star, Upload, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { loadQuickAccessFiles } from '@/app/lib/files/quick-access-client';
import { notebookFileHref, type QuickAccessFile, type QuickAccessResult, type QuickAccessView } from '@/app/lib/files/quick-access';
import { getFileTitle } from '@/app/lib/files/metadata';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { uploadWorkspaceFiles } from '@/app/lib/files/client';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { HomeNewNoteDialog } from './HomeNewNoteDialog';

export function HomeFilesPanel({ workspace }: { workspace: ClientWorkspaceSummary }) {
  const t = useTranslations('home.start');
  const locale = useLocale();
  const [view, setView] = useState<QuickAccessView>('recent');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<QuickAccessResult | null>(null);
  const [favorites, setFavorites] = useState<QuickAccessFile[]>([]);
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setFailed(false);
      try {
        const data = await loadQuickAccessFiles(workspace.id, view, query, expanded ? 20 : 5, controller.signal);
        if (controller.signal.aborted) return;
        setResult(data);
        setFavorites(data.favorites ?? []);
        setFallback(view === 'recent' && data.view === 'all');
      } catch {
        if (!controller.signal.aborted) { setFailed(true); setResult(null); setFavorites([]); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? 220 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [workspace.id, view, query, expanded, revision]);

  const changeView = (next: QuickAccessView) => {
    setView(next);
    setLoading(true);
    setExpanded(next === 'all' || next === 'frequent');
  };

  const importFiles = async (files: File[]) => {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadWorkspaceFiles({ files, targetDir: '.' });
      setView('all');
      setExpanded(true);
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : t('uploadFailed'));
    } finally {
      setUploading(false);
      setRevision((value) => value + 1);
    }
  };

  const renderFile = (file: QuickAccessFile) => (
    <li key={file.path}>
      <Link href={notebookFileHref(file.path, workspace.id)} className="group flex min-h-16 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{getFileIconComponent({ ...file, type: 'file' })}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{getFileTitle({ ...file, type: 'file' })}</span>{file.pinnedAt != null ? <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('pinned')} /> : file.isFavorite ? <Star className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('favorites')} /> : null}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : workspace.name}</span>
        </span>
        {file.openedAt && !query.trim() && (view === 'recent' || view === 'frequent') ? <time dateTime={new Date(file.openedAt).toISOString()} className="hidden shrink-0 text-xs text-muted-foreground sm:block">{new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(file.openedAt)}</time> : null}
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </Link>
    </li>
  );

  return (
    <section aria-labelledby="home-files-heading" className="min-w-0" data-testid="home-files">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><p className="mb-1 text-xs font-medium text-muted-foreground">{workspace.name}</p><h1 id="home-files-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('title')}</h1></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm"><Link href={`/notebook?${new URLSearchParams({ workspaceId: workspace.id })}`}><FolderOpen className="h-4 w-4" />{t('openNotebook')}</Link></Button>
          {workspace.permissions.canWrite ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />{t('newNote')}</Button> : null}
        </div>
      </div>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Input aria-label={t('search')} placeholder={t('search')} value={query} onChange={(event) => { setQuery(event.target.value); setLoading(true); }} className="h-10 pl-9 pr-10" maxLength={256} />
        {query ? <button type="button" onClick={() => { setQuery(''); setLoading(true); }} aria-label={t('clearSearch')} className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground"><X className="h-4 w-4" /></button> : null}
      </div>

      {!query.trim() && view === 'recent' && favorites.length > 0 && !loading ? <div className="mb-5">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t('saved')}</p>
        <div className="grid gap-2 sm:grid-cols-3">{favorites.map((file) => <Link key={file.path} href={notebookFileHref(file.path, workspace.id)} className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:bg-accent"><Star className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{getFileTitle({ ...file, type: 'file' })}</span></Link>)}</div>
      </div> : null}

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex gap-1" role="group" aria-label={t('fileViews')}>
          {(['recent', 'favorites'] as const).map((option) => <button key={option} type="button" aria-pressed={view === option && !query.trim()} onClick={() => { setQuery(''); changeView(option); }} className={`rounded-md px-2.5 py-2 text-sm transition-colors ${view === option && !query.trim() ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-accent'}`}>{option === 'recent' && fallback && !query.trim() ? t('all') : t(option)}</button>)}
        </div>
        <details className="relative">
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-accent">{t('moreViews')}<ChevronDown className="h-3.5 w-3.5" /></summary>
          <div className="absolute right-0 z-10 mt-1 w-44 rounded-lg border border-border bg-popover p-1 shadow-md">{(['frequent', 'all'] as const).map((option) => <button key={option} type="button" onClick={(event) => { setQuery(''); changeView(option); event.currentTarget.closest('details')?.removeAttribute('open'); }} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent">{t(option)}</button>)}</div>
        </details>
      </div>
      <div aria-live="polite" aria-busy={loading}>
        {loading ? <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</div> : failed ? <div className="py-8 text-center"><p role="alert" className="mb-3 text-sm text-muted-foreground">{t('loadFailed')}</p><Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>{t('retry')}</Button></div> : <>
          {(query.trim() || view === 'frequent' || view === 'all') ? <p className="px-3 pt-2 text-xs text-muted-foreground">{query.trim() ? t('results', { count: result?.total ?? 0 }) : t(view)}</p> : null}
          {result?.files.length ? <ul className="divide-y divide-border/50">{result.files.map(renderFile)}</ul> : <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
            <FileText className="mb-1 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">{query.trim() ? t('noResults') : result?.workspaceFileCount === 0 ? t('emptyTitle') : view === 'favorites' ? t('noFavorites') : t('noRecent')}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{query.trim() ? t('searchHint') : result?.workspaceFileCount === 0 ? t('emptyDescription') : view === 'favorites' ? t('favoriteHint') : t('recentHint')}</p>
          </div>}
          {result && result.total > result.files.length && !expanded ? <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => { setExpanded(true); setLoading(true); }}>{t('showMore')}<ChevronDown className="h-4 w-4" /></Button> : null}
          {expanded ? <div className="mt-2 flex items-center justify-between gap-2"><Button variant="ghost" size="sm" onClick={() => { setExpanded(false); setView('recent'); setLoading(true); }}>{t('showLess')}</Button><Link href={`/files?${new URLSearchParams({ workspaceId: workspace.id })}`} className="text-sm text-muted-foreground hover:underline">{t('browseAll')} →</Link></div> : null}
        </>}
      </div>
      {workspace.permissions.canWrite ? <div className="mt-3 border-t border-border pt-3">
        <input ref={uploadRef} type="file" multiple className="hidden" aria-label={t('importFiles')} onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <Button variant="ghost" size="sm" disabled={uploading} onClick={() => uploadRef.current?.click()}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{uploading ? t('uploading') : t('importFiles')}</Button>
        {uploadError ? <p role="alert" className="mt-2 text-sm text-destructive">{uploadError}</p> : null}
      </div> : null}
      {creating ? <HomeNewNoteDialog workspaceId={workspace.id} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}
