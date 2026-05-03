'use client';

import { useCallback, useEffect, useState, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Loader2, Link2, Unlink, RefreshCw, Search, ExternalLink, Plug, Eye, EyeOff, Check, ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ToolkitToolsDialog } from './ToolkitToolsDialog';

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
  connected: boolean;
  connectedAccountId?: string;
  connectedAccountStatus?: string;
};

type ComposioStatus = {
  configured: boolean;
  apiKeyValid: boolean;
  connectedAccounts: ConnectedAccount[];
};

export function ConnectedAppsPanel() {
  const t = useTranslations('settings.connectedApps');
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<ComposioStatus | null>(null);
  const [toolkits, setToolkits] = useState<ToolkitInfo[]>([]);
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
  const [availablePage, setAvailablePage] = useState(1);
  const PAGE_SIZE = 30;

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/composio/status', { credentials: 'include' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('loadError'));
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadToolkits = useCallback(async () => {
    setToolkitsLoading(true);
    try {
      const response = await fetch('/api/composio/toolkits', { credentials: 'include' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('loadError'));
      setToolkits(data.toolkits || []);
    } catch {
      // toolkits may fail if not configured, that's ok
    } finally {
      setToolkitsLoading(false);
    }
  }, [t]);

  const loadExistingEnvEntries = useCallback(async (): Promise<Array<{ key: string; value: string }>> => {
    try {
      const response = await fetch('/api/integrations/env?scope=integrations', { credentials: 'include' });
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

      const response = await fetch('/api/integrations/env?scope=integrations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ scope: 'integrations', mode: 'kv', entries }),
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
      });
    }
  }, [status?.configured, status?.apiKeyValid, loadToolkits]);

  useEffect(() => {
    const connectedParam = searchParams.get('connected');
    if (connectedParam && status?.configured && status?.apiKeyValid) {
      startTransition(() => {
        void loadToolkits();
      });
    }
  }, [searchParams, status?.configured, status?.apiKeyValid, loadToolkits]);

  const handleConnect = async (toolkitSlug: string) => {
    setActionInProgress(`connect-${toolkitSlug}`);
    setError(null);
    try {
      const response = await fetch(`/api/composio/connect/${encodeURIComponent(toolkitSlug)}`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('connectError'));
      if (data.noAuth) {
        void loadStatus();
        void loadToolkits();
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

  const handleDisconnect = async (toolkitSlug: string) => {
    if (!window.confirm(t('disconnectConfirm', { toolkit: toolkitSlug }))) return;
    setActionInProgress(`disconnect-${toolkitSlug}`);
    try {
      const response = await fetch(`/api/composio/disconnect/${encodeURIComponent(toolkitSlug)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('disconnectError'));
      void loadStatus();
      void loadToolkits();
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
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('refreshError'));
      void loadStatus();
      void loadToolkits();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('refreshError'));
    } finally {
      setActionInProgress(null);
    }
  };

  const needsApiKey = !loading && (!status?.configured || !status?.apiKeyValid);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5" />
            {t('title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('apiKeyChecking')}
          </div>
        </CardContent>
      </Card>
    );
  }

  const connectedToolkits = toolkits.filter((tk) => tk.connected);
  const availableToolkits = toolkits.filter((tk) => !tk.connected);
  const filteredAvailable = searchQuery
    ? availableToolkits.filter(
        (tk) =>
          tk.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          tk.slug.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : availableToolkits;
  const pagedAvailable = searchQuery ? filteredAvailable : filteredAvailable.slice(0, availablePage * PAGE_SIZE);
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="h-5 w-5" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* API Key Section */}
        <div className="rounded-md border border-border p-4 space-y-3">
          <h3 className="text-sm font-semibold">Composio API Key</h3>
          {status?.configured && status?.apiKeyValid ? (
            <div className="flex items-center gap-2 text-sm text-primary">
              <Check className="h-4 w-4" />
              {t('apiKeyValid')}
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {status?.configured && !status?.apiKeyValid ? t('apiKeyInvalid') : t('notConfigured')}
              </p>
              <div className="flex items-center gap-2">
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
                <Button onClick={() => void saveApiKey()} disabled={apiKeySaving || !apiKeyDraft.trim()}>
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
            </>
          )}
        </div>

        {/* Connected Apps */}
        {!needsApiKey && (
          <div>
            <h3 className="mb-3 text-sm font-semibold">{t('connectedApps')}</h3>
            {connectedToolkits.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noConnections')}</p>
            ) : (
              <div className="space-y-2">
                {connectedToolkits.map((tk) => (
                  <div
                    key={tk.slug}
                    className="flex cursor-pointer items-center justify-between rounded border border-border p-3 transition-colors hover:bg-muted/50"
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
                      <div>
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
            )}
          </div>
        )}

        {/* Available Apps */}
        {!needsApiKey && (
          <div>
            <h3 className="mb-3 text-sm font-semibold">{t('availableApps')}</h3>
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
                        onClick={(e) => { e.stopPropagation(); void handleConnect(tk.slug); }}
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
          </div>
        )}
      </CardContent>
      {dialogToolkit && (
        <ToolkitToolsDialog
          slug={dialogToolkit.slug}
          name={dialogToolkit.name}
          logo={dialogToolkit.logo}
          connected={dialogToolkit.connected}
          onClose={() => setDialogToolkit(null)}
          onConnect={dialogToolkit.connected ? undefined : (slug) => { setDialogToolkit(null); void handleConnect(slug); }}
          onDisconnect={(slug) => { setDialogToolkit(null); void handleDisconnect(slug); }}
        />
      )}
    </Card>
  );
}