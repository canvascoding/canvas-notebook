'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { createWorkspacePath } from '@/app/lib/files/client';
import { normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
import { notebookFileHref } from '@/app/lib/files/quick-access';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export function HomeNewNoteDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useTranslations('home.start');
  const router = useRouter();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const title = name.trim();
    if (!title || /[/\\\0]/u.test(title) || title === '.' || title === '..') {
      setError(t('invalidName'));
      return;
    }
    const filename = /\.md$/iu.test(title) ? title : `${title}.md`;
    const directory = folder.trim().replace(/\/+$/u, '');
    const path = normalizeWorkspacePathParam(directory ? `${directory}/${filename}` : filename);
    if (!path) { setError(t('invalidName')); return; }
    setBusy(true);
    setError(null);
    try {
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) throw new Error(t('workspaceChanged'));
      await createWorkspacePath(path, 'file');
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
      router.push(notebookFileHref(path, workspaceId));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('createFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('newNote')}</DialogTitle>
          <DialogDescription>{t('newNoteDescription')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void createNote(event)}>
          <div className="space-y-2">
            <label htmlFor="home-note-name" className="text-sm font-medium">{t('noteName')}</label>
            <Input id="home-note-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('notePlaceholder')} autoFocus disabled={busy} maxLength={160} />
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer py-2 text-muted-foreground">{t('chooseFolder')}</summary>
            <label htmlFor="home-note-folder" className="sr-only">{t('chooseFolder')}</label>
            <Input id="home-note-folder" value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={t('rootFolder')} disabled={busy} />
          </details>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t('cancel')}</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{busy ? t('creating') : t('createAndOpen')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
