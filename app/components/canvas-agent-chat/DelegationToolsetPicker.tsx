'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DelegationToolsetIcon } from '@/app/components/canvas-agent-chat/DelegationToolsetIcon';
import type { DelegationOptions } from '@/app/lib/chat/delegation-api';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type DelegationToolset = DelegationOptions['toolsets'][number];

export function DelegationToolsetPicker({
  toolsets,
  selectedToolsets,
  onToggle,
  onSelectAll,
  onClear,
}: {
  toolsets: DelegationToolset[];
  selectedToolsets: Set<string>;
  onToggle: (toolset: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const t = useTranslations('chat');

  return (
    <fieldset className="grid min-w-0 gap-2.5">
      <legend className="sr-only">{t('delegationTools')}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{t('delegationTools')}</span>
        <span className="text-[11px] text-muted-foreground">
          {t('delegationSelectedTools', { selected: selectedToolsets.size, total: toolsets.length })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={onSelectAll}>
            {t('delegationSelectAllTools')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onClear}>
            {t('delegationClearTools')}
          </Button>
        </span>
      </div>
      <ScrollArea className="h-[min(18rem,38dvh)] rounded-lg border border-border/70 bg-muted/20">
        <div className="grid gap-2 p-2 sm:grid-cols-2">
          {toolsets.map((toolset) => {
            const selected = selectedToolsets.has(toolset.name);
            return (
              <button
                key={toolset.name}
                type="button"
                aria-pressed={selected}
                data-testid={`delegation-toolset-${toolset.name}`}
                onClick={() => onToggle(toolset.name)}
                className={cn(
                  'group relative flex min-w-0 items-start gap-2.5 rounded-lg border p-3 text-left transition-[border-color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'border-primary/50 bg-primary/[0.07] shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.08)]'
                    : 'border-border/70 bg-background hover:border-primary/30 hover:bg-accent/40',
                )}
              >
                <span className={cn(
                  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors',
                  selected
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-muted text-muted-foreground group-hover:text-foreground',
                )}>
                  <DelegationToolsetIcon toolset={toolset.name} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block pr-5 text-sm font-medium text-foreground">{toolset.label}</span>
                  <span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                    {toolset.description}
                  </span>
                </span>
                <span className={cn(
                  'absolute right-2.5 top-2.5 inline-flex h-4 w-4 items-center justify-center rounded-full border transition-colors',
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-transparent',
                )}>
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </fieldset>
  );
}
