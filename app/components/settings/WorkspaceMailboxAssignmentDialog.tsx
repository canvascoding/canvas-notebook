'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

type Mailbox = {
  id: string;
  mailboxId: string | null;
  emailAddress: string;
  displayName: string | null;
  assignedWorkspaceId: string | null;
};

export function WorkspaceMailboxAssignmentDialog({
  open,
  onOpenChange,
  workspace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: { id: string; name: string } | null;
}) {
  const t = useTranslations('settings.workspacePanel.management.mailbox');
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !workspace) return;
    let cancelled = false;
    // Opening the dialog starts a fresh request; these are UI loading-state resets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);
    void fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/email/mailbox`, { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || t('loadError'));
        if (cancelled) return;
        const next = Array.isArray(payload.data?.mailboxes) ? payload.data.mailboxes as Mailbox[] : [];
        setMailboxes(next);
        setSelectedAccountId(next.find((mailbox) => mailbox.assignedWorkspaceId === workspace.id)?.id || '');
      })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : t('loadError')); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [open, t, workspace]);

  const save = async (method: 'PUT' | 'DELETE') => {
    if (!workspace || !selectedAccountId) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/email/mailbox`, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('saveError'));
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  const hasCurrentAssignment = mailboxes.some((mailbox) => mailbox.id === selectedAccountId && mailbox.assignedWorkspaceId === workspace?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{workspace ? t('description', { workspace: workspace.name }) : t('description', { workspace: '' })}</DialogDescription>
        </DialogHeader>
        {isLoading ? <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</div> : <div className="space-y-2"><Label htmlFor="workspace-business-mailbox">{t('select')}</Label><select id="workspace-business-mailbox" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)} disabled={isSaving}><option value="">{t('none')}</option>{mailboxes.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.displayName ? `${mailbox.displayName} — ` : ''}{mailbox.emailAddress}</option>)}</select>{mailboxes.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}</div>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>{t('cancel')}</Button>{hasCurrentAssignment ? <Button type="button" variant="outline" onClick={() => void save('DELETE')} disabled={isSaving}>{isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('unassign')}</Button> : <Button type="button" onClick={() => void save('PUT')} disabled={isSaving || !selectedAccountId}>{isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('assign')}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
