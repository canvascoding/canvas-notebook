'use client';

import type { ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

type AgentSettingsAccordionCardProps = {
  id?: string;
  title: string;
  description: string;
  icon?: LucideIcon;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  summaryItems?: ReactNode[];
  cardClassName?: string;
  contentClassName?: string;
  children: ReactNode;
};

export function AgentSettingsAccordionCard({
  id,
  title,
  description,
  icon: Icon,
  isOpen,
  onOpenChange,
  summaryItems = [],
  cardClassName,
  contentClassName,
  children,
}: AgentSettingsAccordionCardProps) {
  const t = useTranslations('settings');

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <Card id={id} className={cn('gap-0 py-0', cardClassName)}>
        <CardHeader className="p-0">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full flex-col gap-3 rounded-lg px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:px-6"
              aria-label={isOpen ? t('agentPanel.sections.collapse') : t('agentPanel.sections.expand')}
            >
              <div className="flex w-full items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <CardTitle className="flex items-center gap-2">
                    {Icon && <Icon className="h-5 w-5" />}
                    {title}
                  </CardTitle>
                  <CardDescription>{description}</CardDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm font-medium text-muted-foreground">
                  <span className="hidden sm:inline">
                    {isOpen ? t('agentPanel.sections.collapse') : t('agentPanel.sections.expand')}
                  </span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </div>
              </div>
              {summaryItems.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {summaryItems.map((item, index) => (
                    <span key={index} className="rounded-md bg-muted px-2 py-1">
                      {item}
                    </span>
                  ))}
                </div>
              )}
            </button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className={cn('space-y-3 px-4 pb-4 pt-0 sm:px-6 sm:pb-6', contentClassName)}>
            {children}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
