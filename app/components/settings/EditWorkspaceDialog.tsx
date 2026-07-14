'use client';

import { FormEvent, useId, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WorkspaceMembersEditor } from '@/app/components/settings/WorkspaceMembersEditor';
import { WorkspaceIconPicker } from '@/app/components/workspaces/WorkspaceIconPicker';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { getDefaultWorkspaceIcon, type WorkspaceIcon } from '@/app/lib/workspaces/icons';

type EditWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: ClientWorkspaceSummary | null;
  onChanged: () => void | Promise<void>;
};

export function EditWorkspaceDialog({
  open,
  onOpenChange,
  workspace,
  onChanged,
}: EditWorkspaceDialogProps) {
  const workspaceKey = workspace ? `${workspace.id}:${open ? 'open' : 'closed'}` : 'empty';

  return (
    <EditWorkspaceDialogContent
      key={workspaceKey}
      open={open}
      onOpenChange={onOpenChange}
      workspace={workspace}
      onChanged={onChanged}
    />
  );
}

function EditWorkspaceDialogContent({
  open,
  onOpenChange,
  workspace,
  onChanged,
}: EditWorkspaceDialogProps) {
  const t = useTranslations('settings.workspacePanel.management');
  const nameId = useId();
  const [name, setName] = useState(() => workspace?.name ?? '');
  const [icon, setIcon] = useState<WorkspaceIcon>(() => (
    workspace ? workspace.icon ?? getDefaultWorkspaceIcon(workspace.type) : getDefaultWorkspaceIcon('personal')
  ));
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const supportsMembers = workspace?.type === 'team' || workspace?.type === 'project';

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isSubmitting) setError(null);
    onOpenChange(nextOpen);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspace) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('errors.nameRequired'));
      return;
    }
    if (trimmedName.length > 80) {
      setError(t('errors.nameTooLong'));
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, icon }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.updateFailed'));
      }
      await onChanged();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.updateFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={supportsMembers ? "!flex max-h-[calc(100dvh-2rem)] !w-[min(100%_-_2rem,_48rem)] !max-w-none !flex-col !gap-0 !overflow-hidden !p-0 sm:!max-w-none" : undefined}>
        <form onSubmit={submit} className={supportsMembers ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-5"}>
          <DialogHeader className={supportsMembers ? "border-b border-border px-5 py-5 pr-12 sm:px-6 sm:pr-14" : undefined}>
            <DialogTitle>{t('editDialog.title')}</DialogTitle>
            <DialogDescription>
              {workspace ? t('editDialog.description', { name: workspace.name }) : t('editDialog.descriptionFallback')}
            </DialogDescription>
          </DialogHeader>

          <div className={supportsMembers ? "min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6" : "flex flex-col gap-4"}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={nameId}>{t('fields.name')}</Label>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={isSubmitting}
                  aria-invalid={Boolean(error)}
                />
              </div>

              <WorkspaceIconPicker value={icon} onChange={setIcon} disabled={isSubmitting} />

              {error ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>

            {supportsMembers && workspace ? (
              <div className="mt-6 border-t border-border pt-6">
                <WorkspaceMembersEditor active={open} workspace={workspace} onChanged={onChanged} />
              </div>
            ) : null}
          </div>

          <DialogFooter className={supportsMembers ? "border-t border-border px-5 py-4 sm:px-6" : undefined}>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              {t('editDialog.cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting || !name.trim() || !workspace}>
              {isSubmitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
              {t('editDialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
