'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Building2, Lock, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentIdentityAvatar } from '@/app/components/agents/AgentIdentityVisual';
import { CreateAgentDialog, type CreateAgentInput } from './CreateAgentDialog';
import type { AgentIconId } from '@/app/lib/agents/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export type AgentProfileItem = {
  agentId: string;
  name: string;
  iconId: AgentIconId;
  type: string;
  removable: boolean;
  defaultProviderInstallationId: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinking: string | null;
  enabledTools: string[] | null;
  relevantSkills: string[] | null;
  relevantConnections: string[] | null;
  scopeType: 'user' | 'organization' | 'system';
  organizationId: string | null;
  ownerUserId: string | null;
  createdByUserId: string | null;
  revision: number;
  access?: {
    canUse: boolean;
    canEdit: boolean;
    canManage: boolean;
  };
};

type AgentSelectorCardProps = {
  agents: AgentProfileItem[];
  selectedAgentId: string;
  loading: boolean;
  error: string | null;
  creating: boolean;
  deletingAgentId: string | null;
  canManageAgentDefaults: boolean;
  openCreateDialogOnMount?: boolean;
  onSelectedAgentIdChange: (agentId: string) => void;
  onCreate: (input: CreateAgentInput) => Promise<AgentProfileItem | null>;
  onDelete: (agentId: string) => void;
  onReload: () => void;
};

export function AgentSelectorCard({
  agents,
  selectedAgentId,
  loading,
  error,
  creating,
  deletingAgentId,
  canManageAgentDefaults,
  openCreateDialogOnMount = false,
  onSelectedAgentIdChange,
  onCreate,
  onDelete,
  onReload,
}: AgentSelectorCardProps) {
  const t = useTranslations('settings');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const openCreateDialogHandledRef = useRef(false);

  useEffect(() => {
    if (!openCreateDialogOnMount) {
      openCreateDialogHandledRef.current = false;
      return;
    }

    if (openCreateDialogHandledRef.current) return;
    openCreateDialogHandledRef.current = true;
    setCreateDialogOpen(true);
  }, [openCreateDialogOnMount]);

  return (
    <>
    <Card className="min-w-0 overflow-hidden">
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex min-w-0 items-center gap-2">
              <Bot className="h-5 w-5 shrink-0" />
              <span className="min-w-0 truncate">{t('agentPanel.selector.title')}</span>
            </CardTitle>
            <CardDescription>{t('agentPanel.selector.description')}</CardDescription>
          </div>
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:flex sm:shrink-0">
            <Button type="button" size="sm" onClick={() => setCreateDialogOpen(true)} disabled={creating} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              {t('agentPanel.selector.create')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onReload} disabled={loading} className="w-full sm:w-auto">
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('agentPanel.selector.reload')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {loading && <p className="text-sm text-muted-foreground">{t('agentPanel.selector.loading')}</p>}

        <div className="grid min-w-0 gap-2 md:grid-cols-2">
          {agents.map((agent) => {
            const selected = agent.agentId === selectedAgentId;
            return (
              <div
                key={agent.agentId}
                className={`min-w-0 rounded-md border p-3 text-left transition ${
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                }`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <AgentIdentityAvatar
                    agentId={agent.agentId}
                    iconId={agent.iconId}
                    className="h-11 w-11 shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => onSelectedAgentIdChange(agent.agentId)}
                    className="min-w-0 flex-1 text-left"
                    aria-pressed={selected}
                  >
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{agent.name}</div>
                        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{agent.agentId}</div>
                      </div>
                      <div className="flex min-w-0 flex-wrap gap-1">
                        <Badge variant={agent.type === 'main' ? 'default' : 'secondary'} className="max-w-full whitespace-normal text-left">
                          {agent.type === 'main' ? t('agentPanel.selector.mainAgent') : t('agentPanel.selector.specialAgent')}
                        </Badge>
                        {agent.type !== 'main' ? (
                          <Badge variant="outline" className="max-w-full gap-1 whitespace-normal text-left" data-testid={`agent-scope-${agent.agentId}`}>
                            {agent.scopeType === 'organization' ? <Building2 className="h-3 w-3" /> : <UserRound className="h-3 w-3" />}
                            {agent.scopeType === 'organization'
                              ? t('agentPanel.createDialog.scope.organization')
                              : t('agentPanel.createDialog.scope.personal')}
                          </Badge>
                        ) : null}
                        {!agent.removable && (
                          <Badge variant="outline" className="max-w-full gap-1 whitespace-normal text-left">
                            <Lock className="h-3 w-3 shrink-0" />
                            {t('agentPanel.selector.locked')}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 break-words text-xs text-muted-foreground">
                      {agent.defaultProvider || agent.defaultModel
                        ? t('agentPanel.selector.defaults', {
                            provider: agent.defaultProvider || t('agentPanel.selector.notSet'),
                            model: agent.defaultModel || t('agentPanel.selector.notSet'),
                          })
                        : t('agentPanel.selector.inheritsDefaults')}
                    </div>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!agent.removable || !agent.access?.canManage || deletingAgentId === agent.agentId}
                    onClick={() => onDelete(agent.agentId)}
                    className="shrink-0 px-2"
                    title={agent.removable && agent.access?.canManage ? t('agentPanel.selector.delete') : t('agentPanel.selector.locked')}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="sr-only">{t('agentPanel.selector.delete')}</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {!loading && agents.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('agentPanel.selector.empty')}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('agentPanel.selector.createHint')}</p>
      </CardContent>
    </Card>
    <CreateAgentDialog
      open={createDialogOpen}
      creating={creating}
      error={error}
      canManageAgentDefaults={canManageAgentDefaults}
      onOpenChange={setCreateDialogOpen}
      onCreate={onCreate}
    />
    </>
  );
}
