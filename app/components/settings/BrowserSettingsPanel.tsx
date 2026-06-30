'use client';

import { useCallback, useEffect, useMemo, useState, startTransition } from 'react';
import Link from 'next/link';
import { Bot, Globe, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { AgentBrowserCard, type AgentBrowserStatus } from './AgentBrowserCard';
import type { AgentProfileItem } from './AgentSelectorCard';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type AgentsResponse = {
  agents: AgentProfileItem[];
};

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: T;
  };

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload.data as T;
}

function buildAgentQuery(agentId: string): string {
  return new URLSearchParams({ agentId }).toString();
}

export function BrowserSettingsPanel() {
  const t = useTranslations('settings.browserSettings');
  const browserT = useTranslations('settings.agentPanel.browser');
  const selectorT = useTranslations('settings.agentPanel.selector');
  const [agents, setAgents] = useState<AgentProfileItem[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(DEFAULT_AGENT_ID);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [browserStatus, setBrowserStatus] = useState<AgentBrowserStatus | null>(null);
  const [browserLoading, setBrowserLoading] = useState(true);
  const [browserPendingAction, setBrowserPendingAction] = useState<string | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [browserSuccess, setBrowserSuccess] = useState<string | null>(null);
  const [runtimeCardOpen, setRuntimeCardOpen] = useState(true);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) || null,
    [agents, selectedAgentId],
  );

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const payload = await fetchJson<AgentsResponse>('/api/agents');
      const nextAgents = payload.agents || [];
      setAgents(nextAgents);
      setSelectedAgentId((current) => {
        if (nextAgents.some((agent) => agent.agentId === current)) return current;
        return nextAgents.find((agent) => agent.agentId === DEFAULT_AGENT_ID)?.agentId
          || nextAgents[0]?.agentId
          || DEFAULT_AGENT_ID;
      });
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : t('errors.loadAgents'));
    } finally {
      setAgentsLoading(false);
    }
  }, [t]);

  const loadBrowserStatus = useCallback(async () => {
    setBrowserLoading(true);
    setBrowserError(null);
    try {
      const payload = await fetchJson<AgentBrowserStatus>(`/api/agents/browser?${buildAgentQuery(selectedAgentId)}`);
      setBrowserStatus(payload);
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : browserT('errors.load'));
    } finally {
      setBrowserLoading(false);
    }
  }, [browserT, selectedAgentId]);

  useEffect(() => {
    startTransition(() => {
      void loadAgents();
    });
  }, [loadAgents]);

  useEffect(() => {
    startTransition(() => {
      void loadBrowserStatus();
    });
  }, [loadBrowserStatus]);

  const runBrowserRuntimeAction = async (
    action: 'close_session' | 'delete_profile' | 'launch_probe',
    successMessage: string,
  ) => {
    setBrowserPendingAction(action);
    setBrowserError(null);
    setBrowserSuccess(null);

    try {
      const payload = await fetchJson<AgentBrowserStatus>('/api/agents/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, action }),
      });
      setBrowserStatus(payload);
      const probe = payload.probe?.launchProbe;
      setBrowserSuccess(probe && !probe.ok && probe.reason ? probe.reason : successMessage);
      setTimeout(() => setBrowserSuccess(null), 4000);
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : browserT('errors.action'));
    } finally {
      setBrowserPendingAction(null);
    }
  };

  const deleteBrowserProfileForAgent = async () => {
    if (!window.confirm(browserT('confirmDeleteProfile'))) return;
    await runBrowserRuntimeAction('delete_profile', browserT('profileDeleted'));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5" />
                {t('title')}
              </CardTitle>
              <CardDescription>{t('description')}</CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings?tab=agent-settings">
                <Settings2 className="mr-2 h-4 w-4" />
                {t('agentToolsLink')}
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
          <div className="grid gap-3 md:grid-cols-3">
            <StatusTile
              label={t('status.tool')}
              value={browserStatus?.toolEnabled ? t('enabled') : t('disabled')}
              tone={browserStatus?.toolEnabled ? 'default' : 'secondary'}
            />
            <StatusTile
              label={t('status.chromium')}
              value={browserStatus?.requirements.available ? t('available') : t('unavailable')}
              tone={browserStatus?.requirements.available ? 'default' : 'destructive'}
            />
            <StatusTile
              label={t('status.session')}
              value={browserStatus?.profile.running ? t('running') : t('stopped')}
              tone={browserStatus?.profile.running ? 'default' : 'secondary'}
            />
          </div>
          <p className="text-sm text-muted-foreground">{t('policyHint')}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5" />
                {t('agentScopeTitle')}
              </CardTitle>
              <CardDescription>{t('agentScopeDescription')}</CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadAgents()} disabled={agentsLoading}>
              {agentsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {t('reloadAgents')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
          {agentsError && <p className="text-sm text-destructive">{agentsError}</p>}
          {agentsLoading && agents.length === 0 ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('loadingAgents')}
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {agents.map((agent) => {
                const selected = agent.agentId === selectedAgentId;
                return (
                  <button
                    key={agent.agentId}
                    type="button"
                    onClick={() => setSelectedAgentId(agent.agentId)}
                    className={`min-w-0 rounded-md border p-3 text-left transition ${
                      selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                    }`}
                    aria-pressed={selected}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <AgentAvatar iconId={agent.iconId} className="h-10 w-10 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          <Badge variant={agent.type === 'main' ? 'default' : 'secondary'}>
                            {agent.type === 'main' ? selectorT('mainAgent') : selectorT('specialAgent')}
                          </Badge>
                        </div>
                        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{agent.agentId}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {!agentsLoading && agents.length === 0 && (
            <p className="text-sm text-muted-foreground">{selectorT('empty')}</p>
          )}
          {selectedAgent && (
            <p className="text-xs text-muted-foreground">
              {t('selectedAgentHint', { agentName: selectedAgent.name })}
            </p>
          )}
        </CardContent>
      </Card>

      <AgentBrowserCard
        status={browserStatus}
        loading={browserLoading}
        pendingAction={browserPendingAction}
        error={browserError}
        success={browserSuccess}
        isOpen={runtimeCardOpen}
        onOpenChange={setRuntimeCardOpen}
        onReload={() => void loadBrowserStatus()}
        onCloseSession={() => void runBrowserRuntimeAction('close_session', browserT('sessionClosed'))}
        onDeleteProfile={() => void deleteBrowserProfileForAgent()}
        onLaunchProbe={() => void runBrowserRuntimeAction('launch_probe', browserT('launchProbeOk'))}
      />
    </div>
  );
}

function StatusTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'default' | 'secondary' | 'destructive';
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <Badge variant={tone} className="mt-2">{value}</Badge>
    </div>
  );
}
