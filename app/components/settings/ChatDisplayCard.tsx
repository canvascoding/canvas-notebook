'use client';

import { Eye, EyeOff, ListCollapse, Wrench, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { ToolVerbosity } from '@/app/store/tool-verbosity-store';
import { SettingsAccordionCard } from './SettingsAccordionCard';

type ChatDisplayCardProps = {
  toolVerbosity: ToolVerbosity;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onToolVerbosityChange: (value: ToolVerbosity) => void;
};

export function ChatDisplayCard({
  toolVerbosity,
  isOpen,
  onOpenChange,
  onToolVerbosityChange,
}: ChatDisplayCardProps) {
  const t = useTranslations('settings');

  return (
    <SettingsAccordionCard
      title={t('workspacePanel.chatDisplay.title')}
      description={t('workspacePanel.chatDisplay.description')}
      icon={Eye}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={[t('workspacePanel.chatDisplay.currentMode', { mode: t(`workspacePanel.chatDisplay.${toolVerbosity}`) })]}
    >
      <div className="grid gap-2 md:grid-cols-3">
        {([
          { value: 'minimal', icon: EyeOff },
          { value: 'subtle', icon: ListCollapse },
          { value: 'verbose', icon: Wrench },
        ] as Array<{ value: ToolVerbosity; icon: LucideIcon }>).map((option) => {
          const Icon = option.icon;
          const isActive = toolVerbosity === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onToolVerbosityChange(option.value)}
              className={`rounded-md border p-3 text-left transition-colors ${
                isActive
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border bg-background hover:bg-muted/40'
              }`}
              aria-pressed={isActive}
            >
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Icon className="h-4 w-4" />
                {t(`workspacePanel.chatDisplay.${option.value}`)}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t(`workspacePanel.chatDisplay.${option.value}Description`)}
              </p>
            </button>
          );
        })}
      </div>
    </SettingsAccordionCard>
  );
}
