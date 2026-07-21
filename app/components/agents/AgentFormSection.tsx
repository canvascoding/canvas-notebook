'use client';

import type { ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

type AgentFormSectionProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled?: boolean;
  showWhenDisabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  children: ReactNode;
};

export function AgentFormSection({
  title,
  description,
  icon: Icon,
  open,
  onOpenChange,
  enabled = true,
  showWhenDisabled = false,
  onEnabledChange,
  children,
}: AgentFormSectionProps) {
  const contentAvailable = enabled || showWhenDisabled;

  return (
    <section className="min-w-0 overflow-hidden rounded-md border bg-muted/10">
      <div className="flex min-w-0 items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/30 sm:gap-4 sm:px-4">
        <button
          type="button"
          onClick={() => contentAvailable && onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left disabled:cursor-default"
          aria-expanded={contentAvailable && open}
          disabled={!contentAvailable}
        >
          <span className="flex min-w-0 flex-1 gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-base font-semibold">{title}</span>
              <span className="line-clamp-2 text-sm text-muted-foreground">{description}</span>
            </span>
          </span>
          {contentAvailable ? (
            <ChevronDown
              className={cn(
                'mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          ) : null}
        </button>
        {onEnabledChange ? (
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              onEnabledChange(checked);
              if (checked) onOpenChange(true);
            }}
            aria-label={title}
            className="mt-1 shrink-0"
          />
        ) : null}
      </div>
      {contentAvailable && open ? (
        <div className="min-w-0 border-t px-3 py-3 sm:px-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}
