'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Clock3,
  Copy,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { DirectMcpWorkspaceAccessSwitch } from '@/app/components/settings/DirectMcpWorkspaceAccessSwitch';
import {
  buildCodexMcpServerConfiguration,
  missingScopesForEnabledCapabilities,
} from '@/app/lib/mcp/client-configuration';

type McpCapabilityStatus = {
  id: string;
  available: boolean;
  enabled: boolean;
  scopes: string[];
};

type McpServerStatus = {
  desiredEnabled: boolean;
  runtimeEnabled: boolean;
  restartRequired: boolean;
  activationManagedByEnvironment: boolean;
  capabilitiesManagedByEnvironment: boolean;
  endpoint: string | null;
  issuer: string | null;
  protocolVersion: string;
  serverVersion: string;
  transport: 'streamable-http';
  authentication: 'oauth-2.1-pkce';
  configurationError: string | null;
  updatedAt: string | null;
  capabilities: McpCapabilityStatus[];
};

type DraftSettings = {
  enabled: boolean;
  tools: string[];
};

type DirectMcpRequestHistoryEntry = {
  requestId: string;
  serverVersion: string | null;
  phase: string;
  httpMethod: string;
  operation: string | null;
  toolName: string | null;
  outcome: 'succeeded' | 'failed' | 'rejected';
  statusCode: number | null;
  code: string;
  durationMs: number;
  createdAt: string;
};

type DirectMcpRequestHistoryState = {
  retentionHours: number;
  entries: DirectMcpRequestHistoryEntry[];
};

type DirectMcpConnection = {
  connectionId: string;
  clientName: string;
  scopes: string[];
  connectedAt: string | null;
  updatedAt: string | null;
  allowedWorkspaceCount: number;
};

type DirectMcpWorkspaceOption = {
  workspaceId: string;
  name: string;
  description: string | null;
  type: string;
};

type DirectMcpWorkspaceAccess = {
  connectionId: string;
  workspaces: DirectMcpWorkspaceOption[];
  allowedWorkspaceIds: string[];
};

type DirectMcpWorkspaceConfiguration = {
  workspaceId: string;
  name: string;
  description: string | null;
  type: string;
  enabled: boolean;
  canManage: boolean;
};

function enabledTools(status: McpServerStatus): string[] {
  return status.capabilities
    .filter((capability) => capability.available && capability.enabled)
    .map((capability) => capability.id)
    .sort();
}

function draftsEqual(left: DraftSettings, right: DraftSettings): boolean {
  return left.enabled === right.enabled
    && left.tools.length === right.tools.length
    && left.tools.every((tool, index) => tool === right.tools[index]);
}

function formatRequestTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

export function McpServerSettingsPanel({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('settings.mcpServer');
  const [status, setStatus] = useState<McpServerStatus | null>(null);
  const [draft, setDraft] = useState<DraftSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState<'endpoint' | 'config' | null>(null);
  const [requestHistory, setRequestHistory] = useState<DirectMcpRequestHistoryState | null>(null);
  const [isRequestHistoryLoading, setIsRequestHistoryLoading] = useState(false);
  const [requestHistoryError, setRequestHistoryError] = useState<string | null>(null);
  const [connections, setConnections] = useState<DirectMcpConnection[] | null>(null);
  const [isConnectionsLoading, setIsConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [disconnectingConnectionId, setDisconnectingConnectionId] = useState<string | null>(null);
  const [expandedWorkspaceAccessConnectionId, setExpandedWorkspaceAccessConnectionId] = useState<string | null>(null);
  const [workspaceAccess, setWorkspaceAccess] = useState<DirectMcpWorkspaceAccess | null>(null);
  const [isWorkspaceAccessLoading, setIsWorkspaceAccessLoading] = useState(false);
  const [workspaceAccessError, setWorkspaceAccessError] = useState<string | null>(null);
  const [isWorkspaceAccessSaving, setIsWorkspaceAccessSaving] = useState(false);
  const [mcpWorkspaceConfigurations, setMcpWorkspaceConfigurations] = useState<DirectMcpWorkspaceConfiguration[] | null>(null);
  const [isMcpWorkspaceConfigurationsLoading, setIsMcpWorkspaceConfigurationsLoading] = useState(false);
  const [mcpWorkspaceConfigurationsError, setMcpWorkspaceConfigurationsError] = useState<string | null>(null);

  const applyStatus = useCallback((nextStatus: McpServerStatus) => {
    setStatus(nextStatus);
    setDraft({
      enabled: nextStatus.desiredEnabled,
      tools: enabledTools(nextStatus),
    });
  }, []);

  const loadStatus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/integrations/mcp-server', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.load'));
      }
      applyStatus(payload.data as McpServerStatus);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [applyStatus, t]);

  const loadRequestHistory = useCallback(async () => {
    setIsRequestHistoryLoading(true);
    setRequestHistoryError(null);
    try {
      const response = await fetch('/api/integrations/mcp-server/requests', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('requestHistory.errors.load'));
      }
      setRequestHistory({
        retentionHours: typeof payload.data?.retentionHours === 'number' ? payload.data.retentionHours : 24,
        entries: Array.isArray(payload.data?.entries) ? payload.data.entries : [],
      });
    } catch (loadError) {
      setRequestHistoryError(loadError instanceof Error ? loadError.message : t('requestHistory.errors.load'));
    } finally {
      setIsRequestHistoryLoading(false);
    }
  }, [t]);

  const loadConnections = useCallback(async () => {
    setIsConnectionsLoading(true);
    setConnectionsError(null);
    try {
      const response = await fetch('/api/integrations/mcp-server/connections', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('connections.errors.load'));
      }
      setConnections(Array.isArray(payload.data?.connections)
        ? payload.data.connections as DirectMcpConnection[]
        : []);
    } catch (loadError) {
      setConnectionsError(loadError instanceof Error ? loadError.message : t('connections.errors.load'));
    } finally {
      setIsConnectionsLoading(false);
    }
  }, [t]);

  const loadMcpWorkspaceConfigurations = useCallback(async () => {
    setIsMcpWorkspaceConfigurationsLoading(true);
    setMcpWorkspaceConfigurationsError(null);
    try {
      const response = await fetch('/api/integrations/mcp-server/workspaces', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('workspaceCatalog.errors.load'));
      }
      setMcpWorkspaceConfigurations(Array.isArray(payload.data?.workspaces)
        ? payload.data.workspaces as DirectMcpWorkspaceConfiguration[]
        : []);
    } catch (loadError) {
      setMcpWorkspaceConfigurationsError(loadError instanceof Error
        ? loadError.message
        : t('workspaceCatalog.errors.load'));
    } finally {
      setIsMcpWorkspaceConfigurationsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let active = true;
    void fetch('/api/integrations/mcp-server', {
      credentials: 'include',
      cache: 'no-store',
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.load'));
      }
      if (active) applyStatus(payload.data as McpServerStatus);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [applyStatus, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConnections();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConnections]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadMcpWorkspaceConfigurations();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadMcpWorkspaceConfigurations]);

  const disconnectConnection = useCallback(async (connection: DirectMcpConnection) => {
    if (disconnectingConnectionId || !window.confirm(
      t('connections.disconnectConfirm', { client: connection.clientName }),
    )) return;

    setDisconnectingConnectionId(connection.connectionId);
    setConnectionsError(null);
    setSuccess(null);
    try {
      const response = await fetch('/api/integrations/mcp-server/connections', {
        method: 'DELETE',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: connection.connectionId }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('connections.errors.disconnect'));
      }
      setConnections((current) => current?.filter((item) => item.connectionId !== connection.connectionId) ?? []);
      setSuccess(t('connections.disconnected'));
    } catch (disconnectError) {
      setConnectionsError(disconnectError instanceof Error
        ? disconnectError.message
        : t('connections.errors.disconnect'));
    } finally {
      setDisconnectingConnectionId(null);
    }
  }, [disconnectingConnectionId, t]);

  const loadWorkspaceAccess = useCallback(async (connection: DirectMcpConnection) => {
    setIsWorkspaceAccessLoading(true);
    setWorkspaceAccessError(null);
    try {
      const query = new URLSearchParams({ connection_id: connection.connectionId });
      const response = await fetch(`/api/integrations/mcp-server/connections/workspaces?${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success || payload.data?.connectionId !== connection.connectionId) {
        throw new Error(payload.error || t('connections.workspaceAccess.errors.load'));
      }
      setWorkspaceAccess({
        connectionId: connection.connectionId,
        workspaces: Array.isArray(payload.data?.workspaces) ? payload.data.workspaces : [],
        allowedWorkspaceIds: Array.isArray(payload.data?.allowedWorkspaceIds)
          ? payload.data.allowedWorkspaceIds.filter((workspaceId: unknown): workspaceId is string => typeof workspaceId === 'string')
          : [],
      });
    } catch (loadError) {
      setWorkspaceAccessError(loadError instanceof Error
        ? loadError.message
        : t('connections.workspaceAccess.errors.load'));
    } finally {
      setIsWorkspaceAccessLoading(false);
    }
  }, [t]);

  const toggleWorkspaceAccess = useCallback((connection: DirectMcpConnection) => {
    setExpandedWorkspaceAccessConnectionId((current) => {
      const next = current === connection.connectionId ? null : connection.connectionId;
      if (next) void loadWorkspaceAccess(connection);
      return next;
    });
  }, [loadWorkspaceAccess]);

  const setWorkspaceAllowed = useCallback((workspaceId: string, allowed: boolean) => {
    setWorkspaceAccess((current) => {
      if (!current) return current;
      const selected = new Set(current.allowedWorkspaceIds);
      if (allowed) selected.add(workspaceId);
      else selected.delete(workspaceId);
      return { ...current, allowedWorkspaceIds: [...selected].sort() };
    });
  }, []);

  const saveWorkspaceAccess = useCallback(async () => {
    if (!workspaceAccess || isWorkspaceAccessSaving) return;
    setIsWorkspaceAccessSaving(true);
    setWorkspaceAccessError(null);
    setSuccess(null);
    try {
      const response = await fetch('/api/integrations/mcp-server/connections/workspaces', {
        method: 'PUT',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connectionId: workspaceAccess.connectionId,
          workspaceIds: workspaceAccess.allowedWorkspaceIds,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('connections.workspaceAccess.errors.save'));
      }
      const allowedWorkspaceCount = typeof payload.data?.allowedWorkspaceCount === 'number'
        ? payload.data.allowedWorkspaceCount
        : workspaceAccess.allowedWorkspaceIds.length;
      setConnections((current) => current?.map((connection) => (
        connection.connectionId === workspaceAccess.connectionId
          ? { ...connection, allowedWorkspaceCount }
          : connection
      )) ?? []);
      setSuccess(t('connections.workspaceAccess.saved'));
    } catch (saveError) {
      setWorkspaceAccessError(saveError instanceof Error
        ? saveError.message
        : t('connections.workspaceAccess.errors.save'));
    } finally {
      setIsWorkspaceAccessSaving(false);
    }
  }, [isWorkspaceAccessSaving, t, workspaceAccess]);

  const refreshMcpWorkspaceConfiguration = useCallback(async () => {
    setWorkspaceAccess(null);
    setWorkspaceAccessError(null);
    setExpandedWorkspaceAccessConnectionId(null);
    await Promise.all([loadMcpWorkspaceConfigurations(), loadConnections()]);
  }, [loadConnections, loadMcpWorkspaceConfigurations]);

  const savedDraft: DraftSettings | null = status ? ({
    enabled: status.desiredEnabled,
    tools: enabledTools(status),
  }) : null;
  const isDirty = Boolean(draft && savedDraft && !draftsEqual(draft, savedDraft));
  const availableCapabilities = status?.capabilities.filter((capability) => capability.available) ?? [];
  const enabledCapabilityCount = draft?.tools.length ?? 0;
  const serverIsEnabled = draft?.enabled ?? status?.desiredEnabled ?? false;
  const serverIsActive = Boolean(status?.runtimeEnabled && !status.configurationError);
  const configuredMcpWorkspaces = mcpWorkspaceConfigurations ?? [];
  const enabledMcpWorkspaceCount = configuredMcpWorkspaces.filter((workspace) => workspace.enabled).length;
  const connectionConfig = serverIsActive && status?.endpoint
    ? buildCodexMcpServerConfiguration({
      endpoint: status.endpoint,
      enabledTools: enabledTools(status),
    })
    : null;

  const statusLabel = status?.configurationError
    ? t('status.configurationError')
    : status?.restartRequired
      ? t('status.restartRequired')
      : status?.runtimeEnabled
        ? t('status.active')
        : t('status.inactive');
  const statusVariant = status?.configurationError
    ? 'destructive' as const
    : status?.runtimeEnabled && !status.restartRequired
      ? 'default' as const
      : 'secondary' as const;

  const copyText = async (kind: 'endpoint' | 'config', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1800);
    } catch {
      setError(t('errors.copy'));
    }
  };

  const toggleCapability = (capabilityId: string, enabled: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const tools = enabled
        ? [...new Set([...current.tools, capabilityId])].sort()
        : current.tools.filter((tool) => tool !== capabilityId);
      return { ...current, tools };
    });
    setSuccess(null);
  };

  const save = async () => {
    if (!draft) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch('/api/integrations/mcp-server', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(draft),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.save'));
      }
      applyStatus(payload.data as McpServerStatus);
      setSuccess(t('saved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading && !status) {
    return (
      <Card className="rounded-xl">
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden rounded-xl">
      <CardHeader className="border-b bg-muted/25">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              {t('eyebrow')}
            </p>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Server className="h-5 w-5 text-primary" aria-hidden="true" />
              {t('title')}
            </CardTitle>
            <CardDescription className="mt-2 max-w-3xl leading-6">
              {t('description')}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-3 rounded-lg border bg-background px-3 py-2.5 shadow-xs">
            <div className="text-right">
              <p className="text-sm font-medium">{t('activation.label')}</p>
              <p className="text-xs text-muted-foreground">{statusLabel}</p>
            </div>
            <Switch
              checked={draft?.enabled ?? false}
              onCheckedChange={(enabled) => {
                setDraft((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    enabled,
                    tools: enabled && !current.enabled
                      ? availableCapabilities.map((capability) => capability.id)
                      : current.tools,
                  };
                });
                setSuccess(null);
              }}
              disabled={!isAdmin || isSaving || status?.activationManagedByEnvironment}
              aria-label={t('activation.label')}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6 pt-6">
        {status?.restartRequired ? (
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm">
            <p className="font-medium text-foreground">{t('restart.title')}</p>
            <p className="mt-1 leading-5 text-muted-foreground">{t('restart.description')}</p>
          </div>
        ) : null}

        {status?.configurationError ? (
          <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm">
            <p className="font-medium text-destructive">{t('configuration.title')}</p>
            <p className="mt-1 break-words leading-5 text-muted-foreground">{status.configurationError}</p>
          </div>
        ) : null}

        {status?.activationManagedByEnvironment || status?.capabilitiesManagedByEnvironment ? (
          <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm">
            <p className="font-medium">{t('managed.title')}</p>
            <p className="mt-1 leading-5 text-muted-foreground">{t('managed.description')}</p>
          </div>
        ) : null}

        {!isAdmin ? (
          <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm text-muted-foreground">
            {t('adminOnly')}
          </div>
        ) : null}

        {serverIsActive ? (
          <section aria-labelledby="mcp-server-address-title" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 id="mcp-server-address-title" className="font-semibold">{t('endpoint.title')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {status?.endpoint ? t('endpoint.description') : t('endpoint.missing')}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => void loadStatus()} disabled={isLoading}>
                {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t('refresh')}
              </Button>
            </div>
            <div className="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <code className="min-w-0 flex-1 break-all text-sm font-semibold">
                {status?.endpoint ?? t('endpoint.notConfigured')}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!status?.endpoint}
                onClick={() => status?.endpoint && void copyText('endpoint', status.endpoint)}
              >
                {copied === 'endpoint' ? <Check /> : <Copy />}
                {copied === 'endpoint' ? t('copied') : t('copy')}
              </Button>
            </div>
          </section>
        ) : null}

        <section aria-labelledby="mcp-server-workspaces-title" className="space-y-3 border-t pt-6">
          <div>
            <h3 id="mcp-server-workspaces-title" className="font-semibold">{t('workspaceCatalog.title')}</h3>
            <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">
              {t('workspaceCatalog.description')}
            </p>
          </div>

          {serverIsActive && !isMcpWorkspaceConfigurationsLoading && enabledMcpWorkspaceCount === 0 ? (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm">
              <p className="font-medium text-foreground">{t('workspaceCatalog.noneEnabled.title')}</p>
              <p className="mt-1 leading-5 text-muted-foreground">{t('workspaceCatalog.noneEnabled.description')}</p>
            </div>
          ) : null}

          {isMcpWorkspaceConfigurationsLoading && !mcpWorkspaceConfigurations ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('workspaceCatalog.loading')}
            </div>
          ) : mcpWorkspaceConfigurationsError ? (
            <p role="alert" className="text-sm text-destructive">{mcpWorkspaceConfigurationsError}</p>
          ) : configuredMcpWorkspaces.length ? (
            <div className="divide-y overflow-hidden rounded-lg border">
              {configuredMcpWorkspaces.map((workspace) => (
                <div key={workspace.workspaceId} className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{workspace.name}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {workspace.description || t('workspaceCatalog.type', { type: workspace.type })}
                    </p>
                    {!workspace.canManage ? (
                      <p className="mt-2 text-xs text-muted-foreground">{t('workspaceCatalog.notManager')}</p>
                    ) : null}
                  </div>
                  <DirectMcpWorkspaceAccessSwitch
                    workspaceId={workspace.workspaceId}
                    enabled={workspace.enabled}
                    canManage={workspace.canManage}
                    onUpdated={refreshMcpWorkspaceConfiguration}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              {t('workspaceCatalog.empty')}
            </p>
          )}

          <p className="text-xs leading-5 text-muted-foreground">{t('workspaceCatalog.connectionHint')}</p>
        </section>

        <section aria-labelledby="mcp-server-connections-title" className="space-y-3 border-t pt-6">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 id="mcp-server-connections-title" className="font-semibold">{t('connections.title')}</h3>
              <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">
                {t('connections.description')}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadConnections()}
              disabled={isConnectionsLoading}
            >
              {isConnectionsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t('connections.refresh')}
            </Button>
          </div>

          {isConnectionsLoading && !connections ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('connections.loading')}
            </div>
          ) : connectionsError ? (
            <p role="alert" className="text-sm text-destructive">{connectionsError}</p>
          ) : connections?.length ? (
            <div className="divide-y overflow-hidden rounded-lg border">
              {connections.map((connection) => {
                const authorizedAt = connection.updatedAt || connection.connectedAt;
                const missingScopes = status
                  ? missingScopesForEnabledCapabilities({
                    grantedScopes: connection.scopes,
                    capabilities: status.capabilities,
                  })
                  : [];
                const isWorkspaceAccessExpanded = expandedWorkspaceAccessConnectionId === connection.connectionId;
                const accessForConnection = workspaceAccess?.connectionId === connection.connectionId
                  ? workspaceAccess
                  : null;
                const selectedWorkspaceIds = new Set(accessForConnection?.allowedWorkspaceIds ?? []);
                return (
                  <div key={connection.connectionId}>
                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="font-medium">{connection.clientName}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {connection.scopes.map((scope) => (
                            <Badge key={scope} variant="outline" className="font-mono font-normal">{scope}</Badge>
                          ))}
                        </div>
                        {missingScopes.length > 0 ? (
                          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100">
                            <p className="flex items-center gap-2 font-medium">
                              <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                              {t('connections.permissionsMissing.title')}
                            </p>
                            <p className="mt-1 leading-5">
                              {t('connections.permissionsMissing.description', {
                                scopes: missingScopes.join(', '),
                              })}
                            </p>
                          </div>
                        ) : (
                          <p className="mt-3 flex items-center gap-2 text-xs text-primary">
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('connections.permissionsComplete')}
                          </p>
                        )}
                        <p className="mt-2 text-xs text-muted-foreground">
                          {t('connections.workspaceAccess.selectedCount', { count: connection.allowedWorkspaceCount })}
                        </p>
                        {authorizedAt ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('connections.authorizedAt', { time: formatRequestTime(authorizedAt) })}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                        <Button
                          type="button"
                          variant={isWorkspaceAccessExpanded ? 'secondary' : 'outline'}
                          size="sm"
                          disabled={disconnectingConnectionId !== null || isWorkspaceAccessLoading || isWorkspaceAccessSaving}
                          onClick={() => toggleWorkspaceAccess(connection)}
                        >
                          {isWorkspaceAccessLoading && isWorkspaceAccessExpanded
                            ? <Loader2 className="animate-spin" />
                            : <ShieldCheck />}
                          {t('connections.workspaceAccess.manage')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={disconnectingConnectionId !== null || isWorkspaceAccessLoading || isWorkspaceAccessSaving}
                          onClick={() => void disconnectConnection(connection)}
                        >
                          {disconnectingConnectionId === connection.connectionId
                            ? <Loader2 className="animate-spin" />
                            : <Unplug />}
                          {t('connections.disconnect')}
                        </Button>
                      </div>
                    </div>
                    {isWorkspaceAccessExpanded ? (
                      <div className="border-t bg-muted/20 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="font-medium">{t('connections.workspaceAccess.title')}</p>
                            <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
                              {t('connections.workspaceAccess.description')}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void loadWorkspaceAccess(connection)}
                            disabled={isWorkspaceAccessLoading || isWorkspaceAccessSaving}
                          >
                            {isWorkspaceAccessLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                            {t('connections.workspaceAccess.refresh')}
                          </Button>
                        </div>

                        {isWorkspaceAccessLoading && !accessForConnection ? (
                          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t('connections.workspaceAccess.loading')}
                          </div>
                        ) : workspaceAccessError ? (
                          <p role="alert" className="mt-3 text-sm text-destructive">{workspaceAccessError}</p>
                        ) : accessForConnection?.workspaces.length ? (
                          <>
                            <div className="mt-4 max-h-72 divide-y overflow-y-auto rounded-md border bg-background">
                              {accessForConnection.workspaces.map((workspace) => {
                                const checkboxId = `mcp-workspace-${connection.connectionId}-${workspace.workspaceId}`;
                                return (
                                  <label key={workspace.workspaceId} htmlFor={checkboxId} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
                                    <input
                                      id={checkboxId}
                                      type="checkbox"
                                      className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                                      checked={selectedWorkspaceIds.has(workspace.workspaceId)}
                                      disabled={isWorkspaceAccessSaving}
                                      onChange={(event) => setWorkspaceAllowed(workspace.workspaceId, event.target.checked)}
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium">{workspace.name}</span>
                                      <span className="mt-0.5 block text-xs text-muted-foreground">
                                        {workspace.description || t('connections.workspaceAccess.type', { type: workspace.type })}
                                      </span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                            {selectedWorkspaceIds.size === 0 ? (
                              <p className="mt-3 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
                                {t('connections.workspaceAccess.noneSelected')}
                              </p>
                            ) : null}
                            <div className="mt-4 flex justify-end">
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void saveWorkspaceAccess()}
                                disabled={isWorkspaceAccessSaving}
                              >
                                {isWorkspaceAccessSaving ? <Loader2 className="animate-spin" /> : <Save />}
                                {isWorkspaceAccessSaving
                                  ? t('connections.workspaceAccess.saving')
                                  : t('connections.workspaceAccess.save')}
                              </Button>
                            </div>
                          </>
                        ) : accessForConnection ? (
                          <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                            {t('connections.workspaceAccess.noWorkspaces')}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              {t('connections.empty')}
            </p>
          )}
        </section>

        {isAdmin ? (
          <section aria-labelledby="mcp-server-request-history-title" className="border-t pt-6">
            <details
              className="group overflow-hidden rounded-lg border"
              onToggle={(event) => {
                if (event.currentTarget.open) void loadRequestHistory();
              }}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-medium marker:hidden [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span id="mcp-server-request-history-title">{t('requestHistory.title')}</span>
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
              </summary>
              <div className="space-y-3 border-t bg-muted/20 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
                    {t('requestHistory.description', { hours: requestHistory?.retentionHours ?? 24 })}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadRequestHistory()}
                    disabled={isRequestHistoryLoading}
                  >
                    {isRequestHistoryLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    {t('requestHistory.refresh')}
                  </Button>
                </div>

                {isRequestHistoryLoading && !requestHistory ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('requestHistory.loading')}
                  </div>
                ) : requestHistoryError ? (
                  <p role="alert" className="text-sm text-destructive">{requestHistoryError}</p>
                ) : requestHistory?.entries.length ? (
                  <div className="max-h-[28rem] divide-y overflow-y-auto rounded-md border bg-background">
                    {requestHistory.entries.map((entry) => {
                      const requestLabel = entry.toolName
                        ? `${entry.operation || entry.httpMethod} · ${entry.toolName}`
                        : entry.operation || entry.httpMethod;
                      const outcomeVariant = entry.outcome === 'failed'
                        ? 'destructive' as const
                        : entry.outcome === 'rejected'
                          ? 'secondary' as const
                          : 'default' as const;
                      return (
                        <div key={entry.requestId} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{requestLabel}</span>
                              <Badge variant={outcomeVariant}>{t(`requestHistory.outcomes.${entry.outcome}`)}</Badge>
                              {entry.statusCode ? <Badge variant="outline">HTTP {entry.statusCode}</Badge> : null}
                            </div>
                            <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{entry.code}</p>
                            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                              {t('requestHistory.requestId')}: {entry.requestId}
                            </p>
                            {entry.serverVersion ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {t('requestHistory.serverVersion')}: {entry.serverVersion}
                              </p>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground sm:text-right">
                            <p>{formatRequestTime(entry.createdAt)}</p>
                            <p className="mt-1">{t('requestHistory.duration', { duration: entry.durationMs })}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    {t('requestHistory.empty', { hours: requestHistory?.retentionHours ?? 24 })}
                  </p>
                )}
              </div>
            </details>
          </section>
        ) : null}

        <section aria-labelledby="mcp-connect-title" className="space-y-4 border-t pt-6">
          <div>
            <h3 id="mcp-connect-title" className="font-semibold">{t('connect.title')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('connect.description')}</p>
          </div>
          <ol className="grid gap-3 lg:grid-cols-3">
            {(['activate', 'addServer', 'signIn'] as const).map((step, index) => (
              <li key={step} className="rounded-lg border p-4">
                <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  {index + 1}
                </div>
                <p className="font-medium">{t(`connect.steps.${step}.title`)}</p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">{t(`connect.steps.${step}.description`)}</p>
              </li>
            ))}
          </ol>
        </section>

        {serverIsEnabled ? (
          <>
            <section aria-labelledby="mcp-capabilities-title" className="space-y-3 border-t pt-6">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h3 id="mcp-capabilities-title" className="font-semibold">{t('capabilities.title')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('capabilities.description')}</p>
                </div>
                <Badge variant="secondary">{t('capabilities.enabledCount', { count: enabledCapabilityCount })}</Badge>
              </div>
              <div className="divide-y overflow-hidden rounded-lg border">
                {availableCapabilities.map((capability) => (
                  <div key={capability.id} className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{t(`capabilities.items.${capability.id}.title`)}</p>
                      </div>
                      <p className="mt-1 text-sm leading-5 text-muted-foreground">
                        {t(`capabilities.items.${capability.id}.description`)}
                      </p>
                    </div>
                    <Switch
                      checked={draft?.tools.includes(capability.id) ?? false}
                      onCheckedChange={(enabled) => toggleCapability(capability.id, enabled)}
                      disabled={!isAdmin || isSaving || status?.capabilitiesManagedByEnvironment}
                      aria-label={t(`capabilities.items.${capability.id}.title`)}
                    />
                  </div>
                ))}
              </div>
              {enabledCapabilityCount === 0 ? (
                <p className="text-sm text-amber-700 dark:text-amber-300">{t('capabilities.noneEnabled')}</p>
              ) : null}
            </section>

            <details className="group overflow-hidden rounded-lg border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-medium marker:hidden [&::-webkit-details-marker]:hidden">
                <span>{t('developer.title')}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
              </summary>
              <div className="space-y-4 border-t bg-muted/20 p-4">
                <p className="text-sm leading-5 text-muted-foreground">{t('developer.description')}</p>
                <div className="overflow-hidden rounded-lg border bg-slate-950 text-slate-100 dark:bg-black">
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                    <div className="flex items-center gap-2 text-xs text-slate-300">
                      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('developer.codexExample')}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-slate-200 hover:bg-white/10 hover:text-white"
                      disabled={!connectionConfig}
                      onClick={() => connectionConfig && void copyText('config', connectionConfig)}
                    >
                      {copied === 'config' ? <Check /> : <Copy />}
                      {copied === 'config' ? t('copied') : t('copy')}
                    </Button>
                  </div>
                  <pre className="overflow-x-auto p-4 text-xs leading-5"><code>{connectionConfig ?? t('endpoint.notConfigured')}</code></pre>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t('developer.codexHint')}</p>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">{t('developer.endpoint')}</dt>
                    <dd className="mt-1 break-all font-mono text-xs">{status?.endpoint ?? t('endpoint.notConfigured')}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('developer.issuer')}</dt>
                    <dd className="mt-1 break-all font-mono text-xs">{status?.issuer ?? t('endpoint.notConfigured')}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('developer.protocol')}</dt>
                    <dd className="mt-1 font-mono text-xs">MCP {status?.protocolVersion}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('developer.serverVersion')}</dt>
                    <dd className="mt-1 font-mono text-xs">{status?.serverVersion}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('developer.authentication')}</dt>
                    <dd className="mt-1 font-mono text-xs">OAuth 2.1 + PKCE · {status?.transport}</dd>
                  </div>
                </dl>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t('developer.scopes')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {availableCapabilities.flatMap((capability) => capability.scopes).filter((scope, index, scopes) => scopes.indexOf(scope) === index).map((scope) => (
                      <Badge key={scope} variant="outline" className="font-mono font-normal">{scope}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            </details>
          </>
        ) : null}

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {success ? <p className="text-sm text-primary">{success}</p> : null}

        <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className={cn('text-xs text-muted-foreground', isDirty && 'text-foreground')}>
            {isDirty ? t('unsaved') : t('upToDate')}
          </p>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={!isAdmin || !isDirty || isSaving || Boolean(draft?.enabled && !status?.endpoint)}
          >
            {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
            {isSaving ? t('saving') : t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
