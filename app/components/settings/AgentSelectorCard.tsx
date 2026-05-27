'use client';

import { Bot, Lock, Plus, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export type AgentProfileItem = {
  agentId: string;
  name: string;
  type: string;
  removable: boolean;
  defaultProvider: string | null;
  defaultModel: string | null;
};

type AgentSelectorCardProps = {
  agents: AgentProfileItem[];
  selectedAgentId: string;
  loading: boolean;
  error: string | null;
  onSelectedAgentIdChange: (agentId: string) => void;
  onReload: () => void;
};

export function AgentSelectorCard({
  agents,
  selectedAgentId,
  loading,
  error,
  onSelectedAgentIdChange,
  onReload,
}: AgentSelectorCardProps) {
  const t = useTranslations('settings');

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {t('agentPanel.selector.title')}
            </CardTitle>
            <CardDescription>{t('agentPanel.selector.description')}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onReload} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('agentPanel.selector.reload')}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled>
              <Plus className="mr-2 h-4 w-4" />
              {t('agentPanel.selector.create')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {loading && <p className="text-sm text-muted-foreground">{t('agentPanel.selector.loading')}</p>}

        <div className="grid gap-2 md:grid-cols-2">
          {agents.map((agent) => {
            const selected = agent.agentId === selectedAgentId;
            return (
              <button
                key={agent.agentId}
                type="button"
                onClick={() => onSelectedAgentIdChange(agent.agentId)}
                className={`rounded-md border p-3 text-left transition ${
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                }`}
                aria-pressed={selected}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{agent.name}</div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{agent.agentId}</div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Badge variant={agent.type === 'main' ? 'default' : 'secondary'}>
                      {agent.type === 'main' ? t('agentPanel.selector.mainAgent') : t('agentPanel.selector.specialAgent')}
                    </Badge>
                    {!agent.removable && (
                      <Badge variant="outline" className="gap-1">
                        <Lock className="h-3 w-3" />
                        {t('agentPanel.selector.locked')}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="mt-3 text-xs text-muted-foreground">
                  {agent.defaultProvider || agent.defaultModel
                    ? t('agentPanel.selector.defaults', {
                        provider: agent.defaultProvider || t('agentPanel.selector.notSet'),
                        model: agent.defaultModel || t('agentPanel.selector.notSet'),
                      })
                    : t('agentPanel.selector.inheritsDefaults')}
                </div>
              </button>
            );
          })}
        </div>

        {!loading && agents.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('agentPanel.selector.empty')}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('agentPanel.selector.createHint')}</p>
      </CardContent>
    </Card>
  );
}
