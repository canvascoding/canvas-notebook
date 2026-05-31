'use client';

import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { AGENT_ICON_IDS, type AgentIconId } from '@/app/lib/agents/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type AgentIconPickerDialogProps = {
  open: boolean;
  value: AgentIconId;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: AgentIconId) => void;
};

export function AgentIconPickerDialog({
  open,
  value,
  onOpenChange,
  onValueChange,
}: AgentIconPickerDialogProps) {
  const t = useTranslations('settings.agentPanel.iconPicker');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {AGENT_ICON_IDS.map((iconId) => {
            const selected = iconId === value;
            return (
              <button
                key={iconId}
                type="button"
                onClick={() => {
                  onValueChange(iconId);
                  onOpenChange(false);
                }}
                className={cn(
                  'group flex min-h-28 flex-col items-center justify-center gap-2 rounded-md border p-3 text-center transition',
                  selected
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background hover:border-primary/50 hover:bg-muted/50',
                )}
              >
                <AgentAvatar
                  iconId={iconId}
                  className={cn(
                    'h-14 w-14 transition',
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'group-hover:bg-muted',
                  )}
                  iconClassName="h-7 w-7"
                />
                <span className="text-xs font-medium">{t(`icons.${iconId}`)}</span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
