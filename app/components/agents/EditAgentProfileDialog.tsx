'use client';

import { FormEvent, useEffect, useId, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { AgentIconPickerDialog } from '@/app/components/agents/AgentIconPickerDialog';
import { AgentMembersEditor } from '@/app/components/agents/AgentMembersEditor';
import { AgentGrantsEditor } from '@/app/components/agents/AgentGrantsEditor';
import type { AgentIconId } from '@/app/lib/agents/icons';
import type { AgentProfile } from '@/app/lib/chat/types';
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

type EditAgentProfileDialogProps = {
  open: boolean;
  agent: AgentProfile | null;
  onOpenChange: (open: boolean) => void;
  onChanged: (agent: AgentProfile) => void | Promise<void>;
};

export function EditAgentProfileDialog({
  open,
  agent,
  onOpenChange,
  onChanged,
}: EditAgentProfileDialogProps) {
  const t = useTranslations('chat.agentEdit');
  const tCreate = useTranslations('settings.agentPanel.createDialog');
  const nameId = useId();
  const [name, setName] = useState('');
  const [iconId, setIconId] = useState<AgentIconId>('bot');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canManageAccess = Boolean(agent?.access?.canManage);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setName(agent.name);
      setIconId((agent.iconId || 'bot') as AgentIconId);
      setError(null);
      setIsSubmitting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isSubmitting) {
      setError(null);
      setIconPickerOpen(false);
    }
    onOpenChange(nextOpen);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!agent) return;

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
      const response = await fetch('/api/agents', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agent.agentId,
          expectedRevision: agent.revision,
          name: trimmedName,
          iconId,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { agent?: AgentProfile };
        error?: string;
      };
      const updatedAgent = payload.data?.agent;
      if (!response.ok || !payload.success || !updatedAgent) {
        throw new Error(payload.error || t('errors.saveFailed'));
      }

      await onChanged(updatedAgent);
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.saveFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className={canManageAccess ? "!flex max-h-[calc(100dvh-2rem)] !w-[min(100%_-_2rem,_48rem)] !max-w-none !flex-col !gap-0 !overflow-hidden !p-0 sm:!max-w-none" : undefined}>
          <form onSubmit={submit} className={canManageAccess ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-5"}>
            <DialogHeader className={canManageAccess ? "border-b border-border px-5 py-5 pr-12 sm:px-6 sm:pr-14" : undefined}>
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>
                {agent ? t('description', { name: agent.name }) : t('descriptionFallback')}
              </DialogDescription>
            </DialogHeader>

            <div className={canManageAccess ? "min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6" : "flex flex-col gap-4"}>
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-4 rounded-md border bg-muted/20 p-3">
                <button
                  type="button"
                  onClick={() => setIconPickerOpen(true)}
                  className="group shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  title={tCreate('changeIcon')}
                >
                  <AgentAvatar
                    iconId={iconId}
                    className="h-14 w-14 border-primary/30 bg-background transition-colors group-hover:bg-muted"
                    iconClassName="h-7 w-7"
                  />
                </button>
                <div className="min-w-0 text-sm text-muted-foreground">{t('iconHint')}</div>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor={nameId}>{tCreate('nameLabel')}</Label>
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

                {error ? (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>

              {canManageAccess && agent?.scopeType === 'organization' ? (
                <div className="mt-6 border-t border-border pt-6">
                  <AgentGrantsEditor
                    active={open}
                    agentId={agent.agentId}
                    revision={agent.revision || 1}
                    onChanged={(updated) => onChanged({ ...agent, ...updated })}
                  />
                </div>
              ) : canManageAccess && agent && !agent.scopeType ? (
                <div className="mt-6 border-t border-border pt-6">
                  <AgentMembersEditor
                    active={open}
                    agentId={agent.agentId}
                    onChanged={() => onChanged(agent)}
                  />
                </div>
              ) : null}
            </div>

            <DialogFooter className={canManageAccess ? "border-t border-border px-5 py-4 sm:px-6" : undefined}>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                {tCreate('cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting || !name.trim() || !agent}>
                {isSubmitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
                {t('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AgentIconPickerDialog
        open={iconPickerOpen}
        value={iconId}
        onOpenChange={setIconPickerOpen}
        onValueChange={setIconId}
      />
    </>
  );
}
