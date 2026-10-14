'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { createWorkspacePath, WorkspaceMarkdownCreatePendingError } from '@/app/lib/files/client';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';
import { MarkdownCreatePendingAttempts } from '@/app/components/file-browser/MarkdownCreatePendingAttempts';
import { MarkdownCreateAttemptError } from '@/app/store/markdown-create-store';
import { joinWorkspacePath, normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
import { notebookFileHref } from '@/app/lib/files/quick-access';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { WorkspaceDestinationPicker } from '@/app/components/workspaces/WorkspaceDestinationPicker';

export function HomeNewNoteDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useTranslations('home.start');
  const createT = useTranslations('notebook');
  const router = useRouter();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('.');
  const [busy, setBusy] = useState(false);
  const [creatingDirectory, setCreatingDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);
  useEffect(() => subscribeOpenedDocumentAuthInvalidation(onClose), [onClose]);

  const createNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pendingRef.current || busy || creatingDirectory) return;
    const title = name.trim();
    if (!title || /[/\\\0]/u.test(title) || title === '.' || title === '..') {
      setError(t('invalidName'));
      return;
    }
    const filename = /\.md$/iu.test(title) ? title : `${title}.md`;
    const path = normalizeWorkspacePathParam(joinWorkspacePath(folder, filename));
    if (!path) { setError(t('invalidName')); return; }
    await submitNote(path);
  };

  const submitNote = async (path: string, requestId?: string) => {
    if (pendingRef.current || creatingDirectory) return;
    pendingRef.current = true;
    const scope = openedDocumentAuthScope();
    const current = () => activeRef.current && openedDocumentAuthScope() === scope
      && useWorkspaceStore.getState().activeWorkspaceId === workspaceId;
    setBusy(true);
    setError(null);
    try {
      if (!current()) throw new Error(t('workspaceChanged'));
      await createWorkspacePath(path, 'file', { workspaceId, requestId });
      if (!current()) return;
      router.push(notebookFileHref(path, workspaceId));
      onClose();
    } catch (cause) {
      if (current()) setError(cause instanceof WorkspaceMarkdownCreatePendingError ? createT('markdownCreateUnconfirmed')
        : cause instanceof MarkdownCreateAttemptError ? createT(cause.code === 'MARKDOWN_CREATE_LIMIT' ? 'markdownCreateLimit' : 'markdownCreateScopeChanged')
          : cause instanceof Error ? cause.message : t('createFailed'));
    } finally {
      pendingRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy && !creatingDirectory) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('newNote')}</DialogTitle>
          <DialogDescription>{t('newNoteDescription')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void createNote(event)}>
          <div className="space-y-2">
            <label htmlFor="home-note-name" className="text-sm font-medium">{t('noteName')}</label>
            <Input id="home-note-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('notePlaceholder')} autoFocus disabled={busy || creatingDirectory} maxLength={160} />
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer py-2 text-muted-foreground">{t('chooseFolder')}</summary>
            <WorkspaceDestinationPicker
              selectedWorkspaceId={workspaceId}
              selectedDir={folder}
              onWorkspaceChange={() => {}}
              onDirChange={setFolder}
              allowWorkspaceChange={false}
              disabled={busy}
              onCreatingDirectoryChange={setCreatingDirectory}
            />
          </details>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <MarkdownCreatePendingAttempts workspaceId={workspaceId} disabled={busy || creatingDirectory}
            onResume={attempt => submitNote(attempt.targetPath, attempt.requestId)} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy || creatingDirectory}>{t('cancel')}</Button>
            <Button type="submit" disabled={busy || creatingDirectory || !name.trim()}>{busy ? t('creating') : t('createAndOpen')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
