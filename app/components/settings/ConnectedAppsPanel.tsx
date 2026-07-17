'use client';

import { useCallback, useEffect, useState, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Loader2, Link2, Unlink, RefreshCw, Search, ExternalLink, Plug, Eye, EyeOff, ChevronDown, ChevronRight, Plus } from 'lucide-react';

import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToolkitToolsDialog } from './ToolkitToolsDialog';
import { SettingsAccordionCard } from './SettingsAccordionCard';
import {
  ComposioProfileSwitcher,
  type ComposioEffectiveProfile,
} from './ComposioProfileSwitcher';

type ConnectedAccount = {
  id: string;
  toolkit: {
    slug: string;
    name: string;
  };
  connectedAt: string;
  status: string;
};

type ToolkitInfo = {
  slug: string;
  name: string;
  logo: string;
  description: string;
  toolsCount: number;
  triggerCount?: number;
  connected: boolean;
  connectedAccountId?: string;
  connectedAccountStatus?: string;
};

type TriggerAppInfo = {
  slug: string;
  triggerCount?: number;
};

type ComposioStatus = {
  configured: boolean;
  apiKeyValid: boolean;
  mode: 'local' | 'managed' | 'disabled';
  localConfigured?: boolean;
  managedAvailable?: boolean;
  connectedAccounts: ConnectedAccount[];
  effectiveProfile?: ComposioEffectiveProfile;
  workspace?: {
    id: string;
    name: string | null;
    type: string;
  };
};

type ConnectedAppsPanelProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  isAdmin?: boolean;
};

export function ConnectedAppsPanel({ isOpen, onOpenChange, isAdmin = false }: ConnectedAppsPanelProps) {
  const t = useTranslations('settings.connectedApps');
  const searchParams = useSearchParams();
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);

  const [status, setStatus] = useState<ComposioStatus | null>(null);
  const [toolkits, setToolkits] = useState<ToolkitInfo[]>([]);
  const [triggerCountsByToolkit, setTriggerCountsByToolkit] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [toolkitsLoading, setToolkitsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [dialogToolkit, setDialogToolkit] = useState<ToolkitInfo | null>(null);
  const [pendingConnectToolkit, setPendingConnectToolkit] = useState<ToolkitInfo | null>(null);
  const [profileSelectionRequest, setProfileSelectionRequest] = useState(0);
  const [profileCreateRequest, setProfileCreateRequest] = useState(0);
  const [effectiveProfileUsage, setEffectiveProfileUsage] = useState({ workspaceOverrideCount: 0, automationCount: 0 });
  const [availablePage, setAvailablePage] = useState(1);
  const [availableOpen, setAvailableOpen] = useState<boolean | undefined>(undefined);
  const [connectedSearchQuery, setConnectedSearchQuery] = useState('');
  const [connectedPage, setConnectedPage] = useState(1);
  const CONNECTED_PAGE_SIZE = 6;
  const AVAILABlE_PAGE_SIZE = 30;
  const activeWorkspaceId = activeWorkspace?.id || '';

  const composioHeaders = useCallback((json = false): HeadersInit => ({
    ...(activeWorkspaceId ? { [WORKSPACE_ID_HEADER]: activeWorkspaceId } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }), [activeWorkspaceId]);

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  const loadStatus = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading !== false;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/composio/status', {
        credentials: 'include',
        cache: 'no-store',
        headers: composioHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('loadError'));
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadError'));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [composioHeaders, t]);

  const loadToolkits = useCallback(async () => {
    setToolkitsLoading(true);
    try {
      const response = await fetch('/api/composio/toolkits', {
        credentials: 'include',
        headers: composioHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('loadError'));
      setToolkits(data.toolkits || []);
    } catch {
      // toolkits may fail if not configured, that's ok
    } finally {
      setToolkitsLoading(false);
    }
  }, [composioHeaders, t]);

  const loadTriggerCounts = useCallback(async () => {
    try {
      const response = await fetch('/api/composio/trigger-apps', {
        credentials: 'include',
        headers: composioHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('loadError'));
      const apps: TriggerAppInfo[] = Array.isArray(data.apps) ? data.apps : [];
      const nextCounts: Record<string, number> = {};
      for (const app of apps) {
        if (app.slug && typeof app.triggerCount === 'number' && app.triggerCount > 0) {
          nextCounts[app.slug] = app.triggerCount;
        }
      }
      setTriggerCountsByToolkit(nextCounts);
    } catch {
      setTriggerCountsByToolkit({});
    }
  }, [composioHeaders, t]);

  const loadExistingEnvEntries = useCallback(async (): Promise<Array<{ key: string; value: string }>> => {
    try {
      const response = await fetch('/api/integrations/env?scope=integrations&secretScope=system', { credentials: 'include' });
      const data = await response.json();
      if (data.success && data.data?.entries) {
        return data.data.entries;
      }
    } catch {
      // ignore
    }
    return [];
  }, []);

  const saveApiKey = useCallback(async () => {
    if (!apiKeyDraft.trim()) return;
    setApiKeySaving(true);
    setApiKeySaved(false);
    setError(null);
    try {
      const existing = await loadExistingEnvEntries();
      const composioEntry = existing.find((e) => e.key.trim().toUpperCase() === 'COMPOSIO_API_KEY');
      let entries: Array<{ key: string; value: string }>;

      if (composioEntry) {
        entries = existing.map((e) =>
          e.key.trim().toUpperCase() === 'COMPOSIO_API_KEY' ? { key: 'COMPOSIO_API_KEY', value: apiKeyDraft.trim() } : e
        );
      } else {
        entries = [...existing, { key: 'COMPOSIO_API_KEY', value: apiKeyDraft.trim() }];
      }

      const response = await fetch('/api/integrations/env?scope=integrations&secretScope=system', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ scope: 'integrations', secretScope: 'system', mode: 'kv', entries }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save API key');
      setApiKeySaved(true);
      setApiKeyDraft('');
      void loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setApiKeySaving(false);
    }
  }, [apiKeyDraft, loadExistingEnvEntries, loadStatus]);

  useEffect(() => {
    startTransition(() => {
      void loadStatus();
    });
  }, [loadStatus]);

  useEffect(() => {
    const connectedParam = searchParams.get('connected');
    if (connectedParam) {
      startTransition(() => {
        void loadStatus();
      });
    }
  }, [searchParams, loadStatus]);

  useEffect(() => {
    if (status?.configured && status?.apiKeyValid) {
      startTransition(() => {
        void loadToolkits();
        void loadTriggerCounts();
      });
    }
  }, [status?.configured, status?.apiKeyValid, loadToolkits, loadTriggerCounts]);

  useEffect(() => {
    const connectedParam = searchParams.get('connected');
    if (connectedParam && status?.configured && status?.apiKeyValid) {
      startTransition(() => {
        void loadToolkits();
        void loadTriggerCounts();
      });
    }
  }, [searchParams, status?.configured, status?.apiKeyValid, loadToolkits, loadTriggerCounts]);

  const connectToolkit = async (toolkitSlug: string) => {
    setActionInProgress(`connect-${toolkitSlug}`);
    setError(null);
    try {
      const response = await fetch(`/api/composio/connect/${encodeURIComponent(toolkitSlug)}`, {
        method: 'POST',
        credentials: 'include',
        headers: composioHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('connectError'));
      if (data.noAuth) {
        void loadStatus();
        void loadToolkits();
        void loadTriggerCounts();
        return;
      }
      if (data.redirectUrl) {
        window.open(data.redirectUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('connectError'));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleConnect = (toolkit: ToolkitInfo) => {
    if (!status?.effectiveProfile || !status.workspace?.id) {
      void connectToolkit(toolkit.slug);
      return;
    }
    setPendingConnectToolkit(toolkit);
  };

  const handleDisconnect = async (toolkitSlug: string) => {
    if (!window.confirm(t('disconnectConfirm', {
      toolkit: toolkitSlug,
      profile: status?.effectiveProfile?.name || t('profiles.unknownProfile'),
      workspace: status?.workspace?.name || activeWorkspace?.name || t('profiles.unknownWorkspace'),
      workspaces: effectiveProfileUsage.workspaceOverrideCount,
      automations: effectiveProfileUsage.automationCount,
    }))) return;
    setActionInProgress(`disconnect-${toolkitSlug}`);
    try {
      const response = await fetch(`/api/composio/disconnect/${encodeURIComponent(toolkitSlug)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: composioHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('disconnectError'));
      setConnectedPage(1);
      void loadStatus();
      void loadToolkits();
      void loadTriggerCounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('disconnectError'));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRefresh = async (toolkitSlug: string) => {
    setActionInProgress(`refresh-${toolkitSlug}`);
    try {
      const response = await fetch(`/api/composio/refresh/${encodeURIComponent(toolkitSlug)}`, {
        method: 'POST',
        credentials: 'include',
        headers: composioHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('refreshError'));
      void loadStatus();
      void loadToolkits();
      void loadTriggerCounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('refreshError'));
    } finally {
      setActionInProgress(null);
    }
  };

  const isManagedMode = status?.mode === 'managed';
  const needsApiKey = !loading && !isManagedMode && (!status?.configured || !status?.apiKeyValid);

  if (loading) {
    return (
      <SettingsAccordionCard
        title={t('title')}
        description={t('description')}
        icon={Plug}
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        summaryItems={[t('apiKeyChecking')]}
      >
        <div className="flex items-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('apiKeyChecking')}
        </div>
      </SettingsAccordionCard>
    );
  }

  const connectedToolkits = toolkits
    .map((tk) => ({ ...tk, triggerCount: triggerCountsByToolkit[tk.slug] }))
    .filter((tk) => tk.connected)
    .sort((a, b) => a.name.localeCompare(b.name));
  const filteredConnected = connectedSearchQuery
    ? connectedToolkits.filter(
        (tk) =>
          tk.name.toLowerCase().includes(connectedSearchQuery.toLowerCase()) ||
          tk.slug.toLowerCase().includes(connectedSearchQuery.toLowerCase())
      )
    : connectedToolkits;
  const pagedConnected = connectedSearchQuery ? filteredConnected : filteredConnected.slice(0, connectedPage * CONNECTED_PAGE_SIZE);
  const hasMoreConnected = !connectedSearchQuery && filteredConnected.length > pagedConnected.length;
  const effectiveAvailableOpen = availableOpen ?? (connectedToolkits.length === 0);
  const availableToolkits = toolkits
    .map((tk) => ({ ...tk, triggerCount: triggerCountsByToolkit[tk.slug] }))
    .filter((tk) => !tk.connected);
  const filteredAvailable = searchQuery
    ? availableToolkits.filter(
        (tk) =>
          tk.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          tk.slug.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : availableToolkits;
  const pagedAvailable = searchQuery ? filteredAvailable : filteredAvailable.slice(0, availablePage * AVAILABlE_PAGE_SIZE);
  const hasMoreAvailable = !searchQuery && filteredAvailable.length > pagedAvailable.length;

  const statusBadge = (s: string) => {
    switch (s) {
      case 'ACTIVE':
        return <Badge variant="secondary">{t('statusActive')}</Badge>;
      case 'EXPIRED':
        return <Badge variant="outline">{t('statusExpired')}</Badge>;
      default:
        return <Badge variant="outline">{t('statusInactive')}</Badge>;
    }
  };
  const summaryItems = [
    isManagedMode ? t('modeManaged') : needsApiKey ? t('notConfiguredShort') : t('summary', { connected: connectedToolkits.length, available: availableToolkits.length }),
    status?.effectiveProfile?.name ? t('profiles.summaryProfile', { name: status.effectiveProfile.name }) : null,
    error ? t('errorSummary') : null,
  ].filter((item): item is string => Boolean(item));
  const modeLabel = isManagedMode
    ? t('modeManaged')
    : status?.mode === 'local'
      ? t('modeLocal')
      : t('modeMissing');

  return (
    <SettingsAccordionCard
      title={t('title')}
      description={t('description')}
      icon={Plug}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={summaryItems}
      contentClassName="space-y-6"
    >
        {error && <p className="text-sm text-destructive">{error}</p>}

        {status?.workspace?.id && status.effectiveProfile ? (
          <ComposioProfileSwitcher
            key={status.workspace.id}
            workspaceId={status.workspace.id}
            workspaceName={status.workspace.name || activeWorkspace?.name || t('profiles.unknownWorkspace')}
            initialEffectiveProfile={status.effectiveProfile}
            selectionRequest={profileSelectionRequest}
            createRequest={profileCreateRequest}
            onEffectiveProfileUsageChange={setEffectiveProfileUsage}
            onProfileChanged={async () => {
              await loadStatus({ showLoading: false });
              await Promise.all([loadToolkits(), loadTriggerCounts()]);
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status?.configured ? 'default' : 'secondary'}>{modeLabel}</Badge>
          {status?.localConfigured && <Badge variant="outline">{t('localConfigured')}</Badge>}
          {status?.managedAvailable && <Badge variant="outline">{t('managedAvailable')}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {isManagedMode ? t('managedDescription') : t('localDescription')}
        </p>

        {/* API Key Section */}
        {needsApiKey && isAdmin && (
          <div className="rounded-md border border-border p-4 space-y-3">
            <h3 className="text-sm font-semibold">Composio API Key</h3>
            <p className="text-sm text-muted-foreground">
              {status?.configured && !status?.apiKeyValid ? t('apiKeyInvalid') : t('notConfigured')}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Input
                  type={apiKeyVisible ? 'text' : 'password'}
                  placeholder="composio_..."
                  value={apiKeyDraft}
                  onChange={(e) => { setApiKeyDraft(e.target.value); setApiKeySaved(false); }}
                  disabled={apiKeySaving}
                  className={apiKeyVisible ? undefined : 'pr-11'}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label={apiKeyVisible ? t('hideSecret') : t('showSecret')}
                  onClick={() => setApiKeyVisible(!apiKeyVisible)}
                  disabled={apiKeySaving}
                >
                  {apiKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <Button onClick={() => void saveApiKey()} disabled={apiKeySaving || !apiKeyDraft.trim()} className="w-full sm:w-auto">
                {apiKeySaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                {t('saveApiKey')}
              </Button>
            </div>
            {apiKeySaved && (
              <p className="text-sm text-primary">{t('apiKeySaved')}</p>
            )}
            <a
              href="https://composio.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline"
            >
              {t('getApiKey')} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}

        {needsApiKey && !isAdmin && (
          <div className="rounded-md border border-border bg-muted/20 p-4">
            <h3 className="text-sm font-semibold">{t('apiKeyAdminTitle')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('apiKeyAdminDescription')}</p>
          </div>
        )}

        {/* Connected Apps */}
        {!needsApiKey && (
          <div>
            <h3 className="mb-3 text-sm font-semibold">{t('connectedApps')}</h3>
            {connectedToolkits.length > 0 && (
              <div className="mb-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={t('searchApps')}
                    value={connectedSearchQuery}
                    onChange={(e) => { setConnectedSearchQuery(e.target.value); setConnectedPage(1); }}
                    className="pl-9"
                  />
                </div>
              </div>
            )}
            {connectedToolkits.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noConnections')}</p>
            ) : filteredConnected.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noResults')}</p>
            ) : (
              <>
                <div className="space-y-2">
                  {pagedConnected.map((tk) => (
                    <div
                      key={tk.slug}
                      className="flex cursor-pointer flex-col gap-2 rounded border border-border p-3 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                      onClick={() => setDialogToolkit(tk)}
                    >
                      <div className="flex items-center gap-3">
                        {tk.logo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={tk.logo} alt={tk.name} className="h-6 w-6" />
                        ) : (
                          <div className="flex h-6 w-6 items-center justify-center rounded bg-muted text-xs font-bold">
                            {tk.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{tk.name}</p>
                          <p className="text-xs text-muted-foreground">{tk.slug}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {statusBadge(tk.connectedAccountStatus || 'ACTIVE')}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRefresh(tk.slug)}
                          disabled={actionInProgress === `refresh-${tk.slug}`}
                        >
                          {actionInProgress === `refresh-${tk.slug}` ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-1 h-3 w-3" />
                          )}
                          {t('refresh')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => void handleDisconnect(tk.slug)}
                          disabled={actionInProgress === `disconnect-${tk.slug}`}
                        >
                          {actionInProgress === `disconnect-${tk.slug}` ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Unlink className="mr-1 h-3 w-3" />
                          )}
                          {t('disconnect')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                {hasMoreConnected && (
                  <div className="flex justify-center pt-3">
                    <Button variant="outline" size="sm" onClick={() => setConnectedPage((p) => p + 1)}>
                      <ChevronDown className="mr-1 h-3 w-3" />
                      {t('loadMore')} ({filteredConnected.length - pagedConnected.length} {t('remaining')})
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Available Apps */}
        {!needsApiKey && (
          <Collapsible open={effectiveAvailableOpen} onOpenChange={setAvailableOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded border border-border bg-muted/30 p-3 text-sm transition-colors hover:bg-muted/50">
              <span className="font-semibold">{t('availableApps')}</span>
              <div className="flex items-center gap-2">
                {availableToolkits.length > 0 && (
                  <Badge variant="outline" className="text-xs">{availableToolkits.length}</Badge>
                )}
                <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${availableOpen ? 'rotate-90' : ''}`} />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="mb-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={t('searchApps')}
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setAvailablePage(1); }}
                    className="pl-9"
                  />
                </div>
              </div>
              {toolkitsLoading ? (
                <div className="flex items-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('apiKeyChecking')}
                </div>
              ) : filteredAvailable.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noResults')}</p>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {pagedAvailable.map((tk) => (
                      <div
                        key={tk.slug}
                        className="flex cursor-pointer items-center justify-between rounded border border-border p-3 transition-colors hover:bg-muted/50"
                        onClick={() => setDialogToolkit(tk)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {tk.logo ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={tk.logo} alt={tk.name} className="h-5 w-5 shrink-0" />
                          ) : (
                            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-bold">
                              {tk.name.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{tk.name}</p>
                            {tk.toolsCount > 0 && (
                              <p className="text-[10px] text-muted-foreground">{tk.toolsCount} tools</p>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); handleConnect(tk); }}
                          disabled={actionInProgress === `connect-${tk.slug}`}
                        >
                          {actionInProgress === `connect-${tk.slug}` ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Link2 className="mr-1 h-3 w-3" />
                          )}
                          {t('connect')}
                        </Button>
                      </div>
                    ))}
                  </div>
                  {hasMoreAvailable && (
                    <div className="flex justify-center pt-3">
                      <Button variant="outline" size="sm" onClick={() => setAvailablePage((p) => p + 1)}>
                        <ChevronDown className="mr-1 h-3 w-3" />
                        {t('loadMore')} ({filteredAvailable.length - pagedAvailable.length} {t('remaining')})
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      {dialogToolkit && (
        <ToolkitToolsDialog
          slug={dialogToolkit.slug}
          name={dialogToolkit.name}
          logo={dialogToolkit.logo}
          connected={dialogToolkit.connected}
          toolsCount={dialogToolkit.toolsCount}
          hasTriggers={Boolean(triggerCountsByToolkit[dialogToolkit.slug] && triggerCountsByToolkit[dialogToolkit.slug] > 0)}
          workspaceId={status?.workspace?.id || activeWorkspaceId}
          onClose={() => setDialogToolkit(null)}
          onConnect={dialogToolkit.connected ? undefined : () => {
            const toolkit = dialogToolkit;
            setDialogToolkit(null);
            handleConnect(toolkit);
          }}
          onDisconnect={(slug) => { setDialogToolkit(null); void handleDisconnect(slug); }}
        />
      )}
      <Dialog open={Boolean(pendingConnectToolkit)} onOpenChange={(open) => {
        if (!open) setPendingConnectToolkit(null);
      }}>
        <DialogContent className="sm:max-w-lg" data-testid="composio-connect-context-dialog">
          <DialogHeader>
            <DialogTitle>{t('connectContext.title', { toolkit: pendingConnectToolkit?.name || '' })}</DialogTitle>
            <DialogDescription>
              {t('connectContext.description', {
                toolkit: pendingConnectToolkit?.name || '',
                profile: status?.effectiveProfile?.name || t('profiles.unknownProfile'),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/25 p-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
              <dt className="text-muted-foreground">{t('connectContext.workspaceLabel')}</dt>
              <dd className="font-medium">{status?.workspace?.name || activeWorkspace?.name || t('profiles.unknownWorkspace')}</dd>
              <dt className="text-muted-foreground">{t('connectContext.profileLabel')}</dt>
              <dd className="font-medium">{status?.effectiveProfile?.name || t('profiles.unknownProfile')}</dd>
            </dl>
          </div>
          <p className="text-sm leading-5 text-muted-foreground">{t('connectContext.reuseHint')}</p>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <Button
              variant="ghost"
              onClick={() => {
                setPendingConnectToolkit(null);
                setProfileSelectionRequest((request) => request + 1);
              }}
            >
              {t('connectContext.chooseProfile')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setPendingConnectToolkit(null);
                setProfileCreateRequest((request) => request + 1);
              }}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t('connectContext.createProfile')}
            </Button>
            <Button
              onClick={() => {
                const toolkit = pendingConnectToolkit;
                setPendingConnectToolkit(null);
                if (toolkit) void connectToolkit(toolkit.slug);
              }}
              data-testid="composio-connect-current-profile"
            >
              <Link2 className="mr-1.5 h-4 w-4" />
              {t('connectContext.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsAccordionCard>
  );
}
