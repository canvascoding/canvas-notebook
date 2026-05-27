'use client';

import { Eye, EyeOff, ListCollapse, Wrench, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ToolVerbosity } from '@/app/store/tool-verbosity-store';

type AgentChatDisplayCardProps = {
  toolVerbosity: ToolVerbosity;
  onToolVerbosityChange: (value: ToolVerbosity) => void;
};

export function AgentChatDisplayCard({
  toolVerbosity,
  onToolVerbosityChange,
}: AgentChatDisplayCardProps) {
  const t = useTranslations('settings');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-5 w-5" />
          {t('agentPanel.chatDisplay.title')}
        </CardTitle>
        <CardDescription>{t('agentPanel.chatDisplay.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
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
                  {t(`agentPanel.chatDisplay.${option.value}`)}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t(`agentPanel.chatDisplay.${option.value}Description`)}
                </p>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
