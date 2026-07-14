'use client';

import { UsersRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { WorkspaceMembersEditor } from '@/app/components/settings/WorkspaceMembersEditor';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface WorkspaceMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: ClientWorkspaceSummary | null;
}

export function WorkspaceMembersDialog({ open, onOpenChange, workspace }: WorkspaceMembersDialogProps) {
  const t = useTranslations('settings.workspacePanel.management.members');
  const title = workspace ? t('title', { name: workspace.name }) : t('titleFallback');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!flex max-h-[calc(100dvh-2rem)] !w-[min(100%_-_2rem,_48rem)] !max-w-none !flex-col !gap-0 !overflow-hidden !p-0 sm:!max-w-none">
        <DialogHeader className="border-b border-border px-5 py-5 pr-12 sm:px-6 sm:pr-14">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UsersRound className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="mt-1.5 max-w-xl leading-5">{t('description')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {open && workspace ? (
            <WorkspaceMembersEditor key={workspace.id} active={open} workspace={workspace} />
          ) : null}
        </div>

        <DialogFooter className="border-t border-border px-5 py-4 sm:px-6">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
