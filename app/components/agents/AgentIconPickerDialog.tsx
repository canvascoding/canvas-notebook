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
import { ScrollArea } from '@/components/ui/scroll-area';
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
      <DialogContent className="grid max-h-[calc(100dvh-2rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0">
        <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 px-4 sm:px-6">
          <div className="grid min-w-0 grid-cols-2 gap-2 pb-1 sm:grid-cols-4 sm:gap-3">
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
                    'group flex min-h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-md border p-2 text-center transition sm:min-h-28 sm:p-3',
                    selected
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background hover:border-primary/50 hover:bg-muted/50',
                  )}
                >
                  <AgentAvatar
                    iconId={iconId}
                    className={cn(
                      'h-12 w-12 transition sm:h-14 sm:w-14',
                      selected ? 'border-primary bg-primary text-primary-foreground' : 'group-hover:bg-muted',
                    )}
                    iconClassName="h-6 w-6 sm:h-7 sm:w-7"
                  />
                  <span className="max-w-full break-words text-xs font-medium">{t(`icons.${iconId}`)}</span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
        <div className="flex justify-end border-t px-4 py-3 sm:px-6 sm:py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
            {t('close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
