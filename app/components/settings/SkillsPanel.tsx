'use client';

import { useState, useEffect, useCallback, startTransition, useDeferredValue } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  Upload,
  Download,
  Package,
  Search,
  RefreshCw,
  Trash2,
  FolderOpen,
  Folder,
  FileText,
  FileCode,
  File,
  ChevronLeft,
  ChevronRight,
  Info,
  Plug,
  Mail,
  Server,
  ArrowUpCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SkillDetailDialog } from '@/app/components/skills/SkillDetailDialog';
import { SkillUploadDialog } from '@/app/components/skills/SkillUploadDialog';
import { CanvasPluginIcon } from '@/app/lib/plugins/plugin-icons';
import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';

interface SkillFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: SkillFileNode[];
}

type RightPanelView = 'info' | 'preview';
type SkillsPanelTab = 'plugins' | 'skills';
type PluginStoreTab = 'discover' | 'installed' | 'updates' | 'advanced';
type SkillLibraryTab = 'installed' | 'library' | 'updates';

type CanvasPluginComposioConnector = {
  toolkit: string;
  label?: string;
  reason?: string;
  recommended?: boolean;
  required?: boolean;
  tools?: string[];
};

type CanvasPluginEmailConnector = {
  kind?: 'mailbox';
  label?: string;
  reason?: string;
  recommended?: boolean;
  required?: boolean;
  providers?: Array<'gmail' | 'imap-smtp'>;
};

type CanvasPluginMcpConnector = {
  name: string;
  label?: string;
  reason?: string;
  recommended?: boolean;
  required?: boolean;
  configPath?: string;
  env?: string[];
  oauth?: boolean;
};

type CanvasPluginSettingsRecord = {
  name: string;
  version: string;
  description: string;
  license?: string;
  enabled: boolean;
  sourceRegistryId?: string;
  sourceRegistryUrl?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    category?: string;
    brandColor?: string;
    icon?: string;
    logo?: string;
  };
  connectors?: {
    composio?: CanvasPluginComposioConnector[];
    email?: CanvasPluginEmailConnector[];
    mcp?: CanvasPluginMcpConnector[];
    mcpServers?: string;
    composioToolkits?: string[];
  };
  skills: Array<{
    name: string;
    title: string;
    description: string;
  }>;
};

type CanvasPluginStoreEntry = {
  name: string;
  displayName: string;
  description: string;
  category?: string;
  latestVersion: string;
  icon?: string;
  iconUrl?: string;
  brandColor?: string;
  publisher?: {
    name?: string;
    url?: string;
  };
  connectors?: CanvasPluginSettingsRecord['connectors'];
  skills?: string[];
  installed: {
    installed: boolean;
    enabled: boolean;
    version?: string;
    updateAvailable: boolean;
  };
};

type CanvasPluginStoreMetadata = {
  id: string;
  name: string;
  updatedAt: string;
  homepage?: string;
};

type CanvasPluginStorePagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

type CanvasPluginStoreStats = {
  total: number;
  installed: number;
  available: number;
  updates: number;
  filteredTotal: number;
};

type CanvasSkillStoreEntry = {
  name: string;
  displayName: string;
  description: string;
  category?: string;
  latestVersion: string;
  icon?: string;
  iconUrl?: string;
  brandColor?: string;
  license?: string;
  publisher?: {
    name?: string;
    url?: string;
  };
  installed: {
    installed: boolean;
    enabled: boolean;
    version?: string;
    updateAvailable: boolean;
    modified: boolean;
    restoreAvailable: boolean;
  };
};

type CanvasSkillStoreMetadata = {
  id: string;
  name: string;
  updatedAt: string;
  homepage?: string;
};

type CanvasSkillStorePagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

type CanvasSkillStoreStats = {
  total: number;
  installed: number;
  available: number;
  updates: number;
  filteredTotal: number;
};

type PluginPreflightItem = {
  type: 'composio' | 'email' | 'mcp';
  key: string;
  label: string;
  required: boolean;
  ready: boolean;
  available?: boolean;
  connected?: boolean;
  configured?: boolean;
  logo?: string;
  reason?: string;
  details?: string[];
  action: 'none' | 'configure-composio' | 'connect-composio' | 'configure-email' | 'configure-mcp';
};

type PluginPreflight = {
  pluginName: string;
  version: string;
  ready: boolean;
  hasRequiredMissing: boolean;
  items: PluginPreflightItem[];
  summary: {
    total: number;
    ready: number;
    requiredMissing: number;
    recommendedMissing: number;
  };
};

type PluginPreflightState = {
  isLoading?: boolean;
  error?: string;
  result?: PluginPreflight;
};

type ComposioToolkitSummary = {
  slug: string;
  name: string;
  logo?: string;
  connected?: boolean;
  connectedAccountStatus?: string;
  toolsCount?: number;
};

type ComposioConnectorState = {
  isLoading: boolean;
  configured: boolean;
  apiKeyValid: boolean;
  toolkitsBySlug: Record<string, ComposioToolkitSummary>;
  connectedSlugs: Record<string, boolean>;
  error?: string;
};

const EMPTY_COMPOSIO_CONNECTOR_STATE: ComposioConnectorState = {
  isLoading: false,
  configured: false,
  apiKeyValid: false,
  toolkitsBySlug: {},
  connectedSlugs: {},
};

const PLUGIN_STORE_PAGE_SIZE = 12;
const EMPTY_STORE_PAGINATION: CanvasPluginStorePagination = {
  page: 1,
  pageSize: PLUGIN_STORE_PAGE_SIZE,
  totalItems: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
};
const EMPTY_STORE_STATS: CanvasPluginStoreStats = {
  total: 0,
  installed: 0,
  available: 0,
  updates: 0,
  filteredTotal: 0,
};

const SKILL_STORE_PAGE_SIZE = 12;
const EMPTY_SKILL_STORE_PAGINATION: CanvasSkillStorePagination = {
  page: 1,
  pageSize: SKILL_STORE_PAGE_SIZE,
  totalItems: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
};
const EMPTY_SKILL_STORE_STATS: CanvasSkillStoreStats = {
  total: 0,
  installed: 0,
  available: 0,
  updates: 0,
  filteredTotal: 0,
};

function uniqueByKey<T>(entries: T[], getKey: (entry: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const entry of entries) {
    const key = getKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function getComposioRecommendations(connectors: CanvasPluginSettingsRecord['connectors']): CanvasPluginComposioConnector[] {
  return uniqueByKey(
    [
      ...(connectors?.composio || []),
      ...(connectors?.composioToolkits || []).map((toolkit) => ({ toolkit, recommended: true })),
    ],
    (connector) => connector.toolkit,
  );
}

function getMcpRecommendations(connectors: CanvasPluginSettingsRecord['connectors']): CanvasPluginMcpConnector[] {
  return uniqueByKey(
    [
      ...(connectors?.mcp || []),
      ...(connectors?.mcpServers ? [{ name: 'mcp', label: 'MCP', configPath: connectors.mcpServers, recommended: true }] : []),
    ],
    (connector) => connector.name,
  );
}

function hasConnectorRecommendations(connectors: CanvasPluginSettingsRecord['connectors']): boolean {
  return getComposioRecommendations(connectors).length > 0
    || (connectors?.email?.length || 0) > 0
    || getMcpRecommendations(connectors).length > 0;
}

function getPreflightKey(pluginName: string, version?: string): string {
  return `${pluginName}@${version || 'latest'}`;
}

function CanvasPluginsSection({ onPluginsChanged }: { onPluginsChanged: () => void }) {
  const t = useTranslations('skills.plugins');
  const [plugins, setPlugins] = useState<CanvasPluginSettingsRecord[]>([]);
  const [storePlugins, setStorePlugins] = useState<CanvasPluginStoreEntry[]>([]);
  const [storeMetadata, setStoreMetadata] = useState<CanvasPluginStoreMetadata | null>(null);
  const [storePagination, setStorePagination] = useState<CanvasPluginStorePagination>(EMPTY_STORE_PAGINATION);
  const [storeStats, setStoreStats] = useState<CanvasPluginStoreStats>(EMPTY_STORE_STATS);
  const [storeTab, setStoreTab] = useState<PluginStoreTab>('discover');
  const [storePage, setStorePage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [sourcePath, setSourcePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [pendingPluginName, setPendingPluginName] = useState<string | null>(null);
  const [preflightByPlugin, setPreflightByPlugin] = useState<Record<string, PluginPreflightState>>({});
  const [composioConnectorState, setComposioConnectorState] = useState<ComposioConnectorState>(EMPTY_COMPOSIO_CONNECTOR_STATE);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const loadPluginData = useCallback(async () => {
    const storeState = storeTab === 'updates' ? 'updates' : storeTab === 'installed' ? 'installed' : 'all';
    const storeParams = new URLSearchParams({
      page: String(storePage),
      pageSize: String(PLUGIN_STORE_PAGE_SIZE),
      q: deferredSearchQuery.trim(),
      state: storeState,
    });

    setIsLoading(true);
    setError(null);
    setStoreError(null);
    try {
      const [pluginsResult, storeResult] = await Promise.allSettled([
        fetch('/api/plugins', { credentials: 'include', cache: 'no-store' }).then((response) => response.json()),
        fetch(`/api/plugins/store?${storeParams.toString()}`, { credentials: 'include', cache: 'no-store' }).then((response) => response.json()),
      ]);

      if (pluginsResult.status === 'fulfilled' && pluginsResult.value?.success) {
        setPlugins(Array.isArray(pluginsResult.value.plugins) ? pluginsResult.value.plugins : []);
      } else {
        const message = pluginsResult.status === 'rejected'
          ? pluginsResult.reason
          : pluginsResult.value?.error;
        throw new Error(message instanceof Error ? message.message : message || t('errors.load'));
      }

      if (storeResult.status === 'fulfilled' && storeResult.value?.success) {
        setStorePlugins(Array.isArray(storeResult.value.plugins) ? storeResult.value.plugins : []);
        setStoreMetadata(storeResult.value.registry || null);
        setStorePagination(storeResult.value.pagination || EMPTY_STORE_PAGINATION);
        setStoreStats(storeResult.value.stats || EMPTY_STORE_STATS);
      } else {
        const message = storeResult.status === 'rejected'
          ? storeResult.reason
          : storeResult.value?.error;
        setStorePlugins([]);
        setStoreMetadata(null);
        setStorePagination(EMPTY_STORE_PAGINATION);
        setStoreStats(EMPTY_STORE_STATS);
        setStoreError(message instanceof Error ? message.message : message || t('errors.storeLoad'));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [deferredSearchQuery, storePage, storeTab, t]);

  useEffect(() => {
    startTransition(() => {
      void loadPluginData();
    });
  }, [loadPluginData]);

  useEffect(() => {
    const requiredToolkits = uniqueByKey(
      plugins.flatMap((plugin) => getComposioRecommendations(plugin.connectors)),
      (connector) => connector.toolkit,
    );

    if (requiredToolkits.length === 0) {
      setComposioConnectorState(EMPTY_COMPOSIO_CONNECTOR_STATE);
      return;
    }

    let cancelled = false;

    async function loadComposioConnectorState() {
      try {
        setComposioConnectorState((current) => ({ ...current, isLoading: true, error: undefined }));
        const statusResponse = await fetch('/api/composio/status', { credentials: 'include', cache: 'no-store' });
        const status = await statusResponse.json();
        const configured = Boolean(status.configured);
        const apiKeyValid = Boolean(status.apiKeyValid);
        const connectedSlugs: Record<string, boolean> = {};

        if (Array.isArray(status.connectedAccounts)) {
          for (const account of status.connectedAccounts) {
            const slug = typeof account?.toolkit?.slug === 'string' ? account.toolkit.slug : '';
            if (slug) connectedSlugs[slug] = true;
          }
        }

        let toolkitsBySlug: Record<string, ComposioToolkitSummary> = {};
        if (configured && apiKeyValid) {
          const toolkitsResponse = await fetch('/api/composio/toolkits?summary=1&includeLogos=1', {
            credentials: 'include',
            cache: 'no-store',
          });
          const toolkitsPayload = await toolkitsResponse.json();
          if (Array.isArray(toolkitsPayload.toolkits)) {
            toolkitsBySlug = Object.fromEntries(
              toolkitsPayload.toolkits
                .filter((toolkit: ComposioToolkitSummary) => toolkit.slug)
                .map((toolkit: ComposioToolkitSummary) => [
                  toolkit.slug,
                  {
                    ...toolkit,
                    connected: Boolean(toolkit.connected || connectedSlugs[toolkit.slug]),
                  },
                ]),
            );
          }
        }

        if (!cancelled) {
          setComposioConnectorState({
            isLoading: false,
            configured,
            apiKeyValid,
            toolkitsBySlug,
            connectedSlugs,
          });
        }
      } catch (stateError) {
        if (!cancelled) {
          setComposioConnectorState({
            ...EMPTY_COMPOSIO_CONNECTOR_STATE,
            isLoading: false,
            error: stateError instanceof Error ? stateError.message : t('connectors.composioStatusError'),
          });
        }
      }
    }

    startTransition(() => {
      void loadComposioConnectorState();
    });

    return () => {
      cancelled = true;
    };
  }, [plugins, t]);

  async function installLocalPlugin() {
    const trimmedPath = sourcePath.trim();
    if (!trimmedPath) {
      setError(t('errors.sourcePathRequired'));
      return;
    }

    setIsInstalling(true);
    setError(null);
    try {
      const response = await fetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: trimmedPath, enable: true, replace: true }),
      });
      const data = await response.json();
      if (!data.success) {
        const details = data.validation?.errors?.length ? ` ${data.validation.errors.join(' ')}` : '';
        throw new Error(`${data.error || t('errors.install')}${details}`);
      }
      setSourcePath('');
      await loadPluginData();
      onPluginsChanged();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : t('errors.install'));
    } finally {
      setIsInstalling(false);
    }
  }

  async function checkStorePluginPreflight(pluginName: string, version?: string) {
    const preflightKey = getPreflightKey(pluginName, version);
    setPreflightByPlugin((current) => ({
      ...current,
      [preflightKey]: { ...current[preflightKey], isLoading: true, error: undefined },
    }));
    setError(null);
    try {
      const response = await fetch('/api/plugins/store/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pluginName, version }),
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('errors.preflight'));
      }
      setPreflightByPlugin((current) => ({
        ...current,
        [preflightKey]: { isLoading: false, result: data.preflight },
      }));
    } catch (preflightError) {
      setPreflightByPlugin((current) => ({
        ...current,
        [preflightKey]: {
          isLoading: false,
          error: preflightError instanceof Error ? preflightError.message : t('errors.preflight'),
        },
      }));
    }
  }

  async function installStorePlugin(pluginName: string, version?: string) {
    const storePlugin = storePlugins.find((plugin) => plugin.name === pluginName);
    const preflightKey = getPreflightKey(pluginName, version);
    const shouldPreflight = Boolean(
      storePlugin
      && hasConnectorRecommendations(storePlugin.connectors)
      && !preflightByPlugin[preflightKey]?.result,
    );

    if (shouldPreflight) {
      await checkStorePluginPreflight(pluginName, version);
      return;
    }

    setPendingPluginName(`store:${pluginName}`);
    setError(null);
    try {
      const response = await fetch('/api/plugins/store/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pluginName, version, enable: true, replace: true }),
      });
      const data = await response.json();
      if (!data.success) {
        const details = data.validation?.errors?.length ? ` ${data.validation.errors.join(' ')}` : '';
        throw new Error(`${data.error || t('errors.install')}${details}`);
      }
      await loadPluginData();
      setPreflightByPlugin((current) => {
        const next = { ...current };
        delete next[preflightKey];
        return next;
      });
      onPluginsChanged();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : t('errors.install'));
    } finally {
      setPendingPluginName(null);
    }
  }

  async function setPluginEnabled(pluginName: string, enabled: boolean) {
    setPendingPluginName(pluginName);
    setError(null);
    try {
      const response = await fetch(`/api/plugins/${pluginName}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('errors.toggle'));
      }
      await loadPluginData();
      onPluginsChanged();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : t('errors.toggle'));
    } finally {
      setPendingPluginName(null);
    }
  }

  async function deletePlugin(pluginName: string) {
    if (!window.confirm(t('deleteConfirm', { name: pluginName }))) {
      return;
    }

    setPendingPluginName(pluginName);
    setError(null);
    try {
      const response = await fetch(`/api/plugins/${pluginName}`, { method: 'DELETE' });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('errors.delete'));
      }
      await loadPluginData();
      onPluginsChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('errors.delete'));
    } finally {
      setPendingPluginName(null);
    }
  }

  function renderComposioConnector(connector: CanvasPluginComposioConnector, showLiveStatus = true) {
    const toolkit = composioConnectorState.toolkitsBySlug[connector.toolkit];
    const isConnected = Boolean(toolkit?.connected || composioConnectorState.connectedSlugs[connector.toolkit]);
    const label = connector.label || toolkit?.name || connector.toolkit;
    const logo = toolkit?.logo;
    const statusLabel = !showLiveStatus
      ? t('connectors.recommended')
      : composioConnectorState.isLoading
      ? t('connectors.checking')
      : !composioConnectorState.configured || !composioConnectorState.apiKeyValid
        ? t('connectors.composioNotConfigured')
        : toolkit
          ? isConnected
            ? t('connectors.connected')
            : t('connectors.notConnected')
          : t('connectors.unavailable');
    const statusVariant = showLiveStatus && isConnected ? 'default' : 'secondary';
    const actionLabel = !composioConnectorState.configured || !composioConnectorState.apiKeyValid
      ? t('connectors.configureComposio')
      : isConnected
        ? t('connectors.manage')
        : t('connectors.connect');

    return (
      <div key={`composio-${connector.toolkit}`} className="rounded-md border bg-muted/20 p-3">
        <div className="flex items-start gap-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background bg-center bg-contain bg-no-repeat text-[10px] font-semibold text-muted-foreground"
            style={logo ? { backgroundImage: `url(${logo})` } : undefined}
          >
            {logo ? null : label.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium">{label}</span>
              <Badge variant="outline" className="text-[10px]">Composio</Badge>
              {connector.required ? <Badge variant="destructive" className="text-[10px]">{t('connectors.required')}</Badge> : null}
              <Badge variant={statusVariant} className="text-[10px]">{statusLabel}</Badge>
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{connector.toolkit}</div>
            {connector.reason ? <p className="mt-1 text-xs text-muted-foreground">{connector.reason}</p> : null}
            {connector.tools?.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {connector.tools.slice(0, 4).map((tool) => (
                  <span key={tool} className="rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">{tool}</span>
                ))}
              </div>
            ) : null}
          </div>
          {showLiveStatus ? (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href={`/settings?tab=integrations&section=composio&connected=${encodeURIComponent(connector.toolkit)}`}>
                {actionLabel}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  function renderMcpConnector(connector: CanvasPluginMcpConnector) {
    const label = connector.label || connector.name;
    const details = [
      connector.configPath ? t('connectors.mcpConfigPath', { path: connector.configPath }) : null,
      connector.env?.length ? t('connectors.envVars', { vars: connector.env.join(', ') }) : null,
      connector.oauth ? t('connectors.oauthRequired') : null,
    ].filter(Boolean);

    return (
      <div key={`mcp-${connector.name}`} className="rounded-md border bg-muted/20 p-3">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
            <Server className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium">{label}</span>
              <Badge variant="outline" className="text-[10px]">MCP</Badge>
              {connector.required ? <Badge variant="destructive" className="text-[10px]">{t('connectors.required')}</Badge> : null}
              <Badge variant="secondary" className="text-[10px]">{t('connectors.recommended')}</Badge>
            </div>
            {connector.reason ? <p className="mt-1 text-xs text-muted-foreground">{connector.reason}</p> : null}
            {details.length ? <p className="mt-1 text-[11px] text-muted-foreground">{details.join(' · ')}</p> : null}
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href="/settings?tab=integrations&section=mcp">{t('connectors.reviewMcp')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  function renderEmailConnector(connector: CanvasPluginEmailConnector, index: number) {
    const label = connector.label || t('connectors.emailAccount');
    const providers = connector.providers?.length ? connector.providers.join(', ') : t('connectors.emailProvidersDefault');

    return (
      <div key={`email-${index}-${label}`} className="rounded-md border bg-muted/20 p-3">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
            <Mail className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium">{label}</span>
              <Badge variant="outline" className="text-[10px]">Email</Badge>
              {connector.required ? <Badge variant="destructive" className="text-[10px]">{t('connectors.required')}</Badge> : null}
              <Badge variant="secondary" className="text-[10px]">{t('connectors.recommended')}</Badge>
            </div>
            {connector.reason ? <p className="mt-1 text-xs text-muted-foreground">{connector.reason}</p> : null}
            <p className="mt-1 text-[11px] text-muted-foreground">{t('connectors.emailProviders', { providers })}</p>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href="/settings?tab=integrations&section=email">{t('connectors.openEmail')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  function renderConnectorRecommendations(connectors: CanvasPluginSettingsRecord['connectors'], options: { showLiveStatus?: boolean } = {}) {
    const composio = getComposioRecommendations(connectors);
    const email = connectors?.email || [];
    const mcp = getMcpRecommendations(connectors);
    const showLiveStatus = options.showLiveStatus ?? true;

    if (composio.length === 0 && email.length === 0 && mcp.length === 0) {
      return null;
    }

    return (
      <div className="mt-3 space-y-2 border-t pt-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Plug className="h-3.5 w-3.5" />
          {t('connectors.title')}
        </div>
        <div className="space-y-2">
          {composio.map((connector) => renderComposioConnector(connector, showLiveStatus))}
          {email.map((connector, index) => renderEmailConnector(connector, index))}
          {mcp.map((connector) => renderMcpConnector(connector))}
        </div>
      </div>
    );
  }

  function renderStoreIcon(plugin: CanvasPluginStoreEntry) {
    const initials = plugin.displayName
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    if (plugin.iconUrl) {
      return (
        <span className="flex h-10 w-10 shrink-0 overflow-hidden rounded-lg border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- Store icons are remote marketplace assets. */}
          <img src={plugin.iconUrl} alt="" className="h-full w-full object-cover" />
        </span>
      );
    }

    return (
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold text-white"
        style={{ backgroundColor: plugin.brandColor || '#64748b' }}
      >
        {initials || 'CP'}
      </span>
    );
  }

  function getPreflightActionHref(item: PluginPreflightItem): string | null {
    if (item.action === 'configure-composio' || item.action === 'connect-composio') {
      return `/settings?tab=integrations&section=composio&connected=${encodeURIComponent(item.key)}`;
    }
    if (item.action === 'configure-email') {
      return '/settings?tab=integrations&section=email';
    }
    if (item.action === 'configure-mcp') {
      return '/settings?tab=integrations&section=mcp';
    }
    return null;
  }

  function renderPreflightTypeIcon(item: PluginPreflightItem) {
    if (item.logo) {
      return (
        <span
          className="flex h-7 w-7 shrink-0 rounded-md border bg-background bg-center bg-contain bg-no-repeat"
          style={{ backgroundImage: `url(${item.logo})` }}
        />
      );
    }
    if (item.type === 'email') {
      return (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          <Mail className="h-3.5 w-3.5" />
        </span>
      );
    }
    if (item.type === 'mcp') {
      return (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          <Server className="h-3.5 w-3.5" />
        </span>
      );
    }
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
        <Plug className="h-3.5 w-3.5" />
      </span>
    );
  }

  function renderPluginPreflight(plugin: CanvasPluginStoreEntry) {
    const preflight = preflightByPlugin[getPreflightKey(plugin.name, plugin.latestVersion)];
    if (!preflight) return null;

    if (preflight.isLoading) {
      return (
        <div className="mt-3 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('preflight.checking')}
        </div>
      );
    }

    if (preflight.error) {
      return (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {preflight.error}
        </div>
      );
    }

    if (!preflight.result) return null;

    const result = preflight.result;
    return (
      <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {result.hasRequiredMissing ? <Info className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {t('preflight.title')}
          </div>
          <Badge variant={result.hasRequiredMissing ? 'destructive' : 'secondary'} className="text-[10px]">
            {result.hasRequiredMissing ? t('preflight.needsSetup') : t('preflight.ready')}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('preflight.summary', {
            ready: result.summary.ready,
            total: result.summary.total,
            required: result.summary.requiredMissing,
            recommended: result.summary.recommendedMissing,
          })}
        </p>
        {result.items.length ? (
          <div className="space-y-1.5">
            {result.items.map((item) => {
              const actionHref = getPreflightActionHref(item);
              return (
                <div key={`${item.type}-${item.key}`} className="flex items-start gap-2 rounded-md bg-background/70 px-2 py-2">
                  {renderPreflightTypeIcon(item)}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{item.label}</span>
                      <Badge variant="outline" className="text-[9px]">{item.type}</Badge>
                      <Badge variant={item.required ? 'destructive' : 'secondary'} className="text-[9px]">
                        {item.required ? t('connectors.required') : t('connectors.recommended')}
                      </Badge>
                      <Badge variant={item.ready ? 'default' : 'secondary'} className="text-[9px]">
                        {item.ready ? t('connectors.connected') : t('connectors.notConnected')}
                      </Badge>
                    </div>
                    {item.reason ? <p className="mt-1 text-[11px] text-muted-foreground">{item.reason}</p> : null}
                    {item.details?.length ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">{item.details.join(' · ')}</p>
                    ) : null}
                  </div>
                  {actionHref ? (
                    <Button asChild variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs">
                      <Link href={actionHref}>{t('preflight.setup')}</Link>
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-md bg-background/70 px-2 py-2 text-xs text-muted-foreground">
            {t('preflight.noConnectors')}
          </div>
        )}
      </div>
    );
  }

  const storeByName = new Map(storePlugins.map((plugin) => [plugin.name, plugin]));

  function isStoreEntry(plugin: CanvasPluginStoreEntry | CanvasPluginSettingsRecord): plugin is CanvasPluginStoreEntry {
    return 'latestVersion' in plugin;
  }

  function matchesSearch(plugin: CanvasPluginStoreEntry | CanvasPluginSettingsRecord) {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    const storeEntry = isStoreEntry(plugin);
    const displayName = storeEntry
      ? plugin.displayName
      : plugin.interface?.displayName || plugin.name;
    const category = storeEntry ? plugin.category : plugin.interface?.category;
    const skillNames = Array.isArray(plugin.skills)
      ? plugin.skills.map((skill) => typeof skill === 'string' ? skill : skill.name).join(' ')
      : '';
    return [
      plugin.name,
      displayName,
      plugin.description,
      category,
      skillNames,
    ].filter(Boolean).join(' ').toLowerCase().includes(query);
  }

  function renderStorePluginCard(plugin: CanvasPluginStoreEntry) {
    const isPending = pendingPluginName === `store:${plugin.name}`;
    const isInstalled = plugin.installed.installed;
    const updateAvailable = plugin.installed.updateAvailable;
    const preflightKey = getPreflightKey(plugin.name, plugin.latestVersion);
    const preflightState = preflightByPlugin[preflightKey];
    const needsPreflight = hasConnectorRecommendations(plugin.connectors)
      && !preflightState?.result
      && (!isInstalled || updateAvailable);
    const isChecking = Boolean(preflightState?.isLoading);
    const buttonLabel = needsPreflight
      ? t('checkApps')
      : updateAvailable
      ? t('update')
      : isInstalled
        ? t('installed')
        : t('addPlugin');
    const buttonIcon = needsPreflight
      ? <Plug className="h-3.5 w-3.5" />
      : updateAvailable
      ? <ArrowUpCircle className="h-3.5 w-3.5" />
      : <Download className="h-3.5 w-3.5" />;

    return (
      <div key={plugin.name} className="rounded-lg border bg-background p-4">
        <div className="flex items-start gap-3">
          {renderStoreIcon(plugin)}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{plugin.displayName}</h3>
              {plugin.category ? <Badge variant="secondary" className="text-[10px]">{plugin.category}</Badge> : null}
              <Badge variant="outline" className="text-[10px]">v{plugin.latestVersion}</Badge>
              {isInstalled ? (
                <Badge variant={updateAvailable ? 'destructive' : 'default'} className="text-[10px]">
                  {updateAvailable ? t('updateAvailable') : t('installed')}
                </Badge>
              ) : null}
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">/{plugin.name}</div>
            <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{plugin.description}</p>
            {plugin.skills?.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {plugin.skills.map((skill) => (
                  <Badge key={skill} variant="secondary" className="max-w-full text-[10px]">
                    <span className="truncate">/{skill}</span>
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {renderConnectorRecommendations(plugin.connectors, { showLiveStatus: false })}
        {renderPluginPreflight(plugin)}
        <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {plugin.publisher?.name || storeMetadata?.name || t('officialStore')}
          </span>
          <Button
            variant={updateAvailable || !isInstalled ? 'default' : 'outline'}
            size="sm"
            disabled={isPending || isChecking || (isInstalled && !updateAvailable)}
            onClick={() => void installStorePlugin(plugin.name, plugin.latestVersion)}
            className="gap-1.5"
          >
            {isPending || isChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : buttonIcon}
            {buttonLabel}
          </Button>
        </div>
      </div>
    );
  }

  function renderInstalledPluginCard(plugin: CanvasPluginSettingsRecord) {
    const displayName = plugin.interface?.displayName || plugin.name;
    const description = plugin.interface?.shortDescription || plugin.description;
    const isPending = pendingPluginName === plugin.name || pendingPluginName === `store:${plugin.name}`;
    const storePlugin = storeByName.get(plugin.name);
    const updateAvailable = Boolean(storePlugin?.installed.updateAvailable);

    return (
      <div key={plugin.name} className="rounded-lg border bg-background p-4">
        <div className="flex items-start gap-3">
          <CanvasPluginIcon plugin={plugin} className="h-10 w-10 text-sm" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{displayName}</h3>
              <Badge variant={plugin.enabled ? 'default' : 'secondary'} className="text-[10px]">
                {plugin.enabled ? t('enabled') : t('disabled')}
              </Badge>
              <Badge variant="outline" className="text-[10px]">v{plugin.version}</Badge>
              {updateAvailable ? <Badge variant="destructive" className="text-[10px]">{t('updateAvailable')}</Badge> : null}
              {plugin.license ? <Badge variant="outline" className="text-[10px]">{plugin.license}</Badge> : null}
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">/{plugin.name}</div>
            <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {plugin.skills.map((skill) => (
                <Badge key={skill.name} variant="secondary" className="max-w-full text-[10px]">
                  <span className="truncate">/{skill.name}</span>
                </Badge>
              ))}
            </div>
          </div>
        </div>
        {renderConnectorRecommendations(plugin.connectors)}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch
              checked={plugin.enabled}
              disabled={isPending}
              onCheckedChange={(checked) => void setPluginEnabled(plugin.name, checked)}
              aria-label={t('toggle', { name: plugin.name })}
            />
            {plugin.enabled ? t('enabled') : t('disabled')}
          </label>
          <div className="flex items-center gap-2">
            {updateAvailable ? (
              <Button
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => void installStorePlugin(plugin.name, storePlugin?.latestVersion)}
                className="gap-1.5"
              >
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
                {t('update')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => void deletePlugin(plugin.name)}
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {t('delete')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;
  const filteredInstalledPlugins = plugins.filter(matchesSearch);
  const updatePlugins = storeTab === 'updates' ? storePlugins : [];

  function renderStorePagination() {
    if (storeTab === 'installed' || storeTab === 'advanced' || storePagination.totalItems === 0) {
      return null;
    }

    return (
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
        <span>
          {t('pagination.status', {
            page: storePagination.page,
            totalPages: storePagination.totalPages,
            totalItems: storePagination.totalItems,
          })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isLoading || !storePagination.hasPreviousPage}
            onClick={() => setStorePage((page) => Math.max(1, page - 1))}
            className="h-8 gap-1.5"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('pagination.previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isLoading || !storePagination.hasNextPage}
            onClick={() => setStorePage((page) => page + 1)}
            className="h-8 gap-1.5"
          >
            {t('pagination.next')}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Package className="h-4 w-4" />
            {t('title')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="shrink-0">
            {t('stats', { enabled: enabledCount, total: plugins.length })}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => void loadPluginData()} disabled={isLoading} className="gap-1.5">
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t('reload')}
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(event) => {
            setStorePage(1);
            setSearchQuery(event.target.value);
          }}
          placeholder={t('searchPlaceholder')}
          className="pl-9"
        />
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {storeError ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {storeError}
        </div>
      ) : null}

      <Tabs
        value={storeTab}
        onValueChange={(value) => {
          if (value === 'discover' || value === 'installed' || value === 'updates' || value === 'advanced') {
            setStorePage(1);
            setStoreTab(value);
          }
        }}
        className="space-y-4"
      >
        <TabsList className="flex h-auto flex-wrap justify-start bg-muted/60 p-1">
          <TabsTrigger value="discover" className="rounded-md px-3">
            {t('storeTabs.discover')}
          </TabsTrigger>
          <TabsTrigger value="installed" className="rounded-md px-3">
            {t('storeTabs.installed')}
          </TabsTrigger>
          <TabsTrigger value="updates" className="rounded-md px-3">
            {t('storeTabs.updates', { count: storeStats.updates })}
          </TabsTrigger>
          <TabsTrigger value="advanced" className="rounded-md px-3">
            {t('storeTabs.advanced')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="discover" className="space-y-3">
          {storeMetadata ? (
            <div className="text-xs text-muted-foreground">
              {t('storeSource', { name: storeMetadata.name })}
            </div>
          ) : null}
          {isLoading ? (
            <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : storePlugins.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
              {t('emptyStore')}
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                {storePlugins.map((plugin) => renderStorePluginCard(plugin))}
              </div>
              {renderStorePagination()}
            </>
          )}
        </TabsContent>

        <TabsContent value="installed" className="space-y-3">
          {isLoading ? (
            <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filteredInstalledPlugins.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
              {t('empty')}
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filteredInstalledPlugins.map((plugin) => renderInstalledPluginCard(plugin))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="updates" className="space-y-3">
          {isLoading ? (
            <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : updatePlugins.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
              {t('noUpdates')}
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                {updatePlugins.map((plugin) => renderStorePluginCard(plugin))}
              </div>
              {renderStorePagination()}
            </>
          )}
        </TabsContent>

        <TabsContent value="advanced" className="space-y-3">
          <div className="rounded-lg border bg-muted/20 p-4">
            <div className="mb-3">
              <h3 className="text-sm font-semibold">{t('advancedLocalTitle')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('advancedLocalDescription')}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                value={sourcePath}
                onChange={(event) => setSourcePath(event.target.value)}
                placeholder={t('sourcePathPlaceholder')}
                disabled={isInstalling}
              />
              <Button onClick={() => void installLocalPlugin()} disabled={isInstalling || !sourcePath.trim()} className="gap-1.5">
                {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {t('install')}
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}

export function SkillsPanel() {
  const t = useTranslations('skills');
  const [skills, setSkills] = useState<CanvasSkill[]>([]);
  const [stats, setStats] = useState({ total: 0, enabled: 0, disabled: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<CanvasSkill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<SkillsPanelTab>('plugins');
  const [skillLibraryTab, setSkillLibraryTab] = useState<SkillLibraryTab>('installed');
  const [skillTree, setSkillTree] = useState<SkillFileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [rightView, setRightView] = useState<RightPanelView>('info');
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [skillStoreSkills, setSkillStoreSkills] = useState<CanvasSkillStoreEntry[]>([]);
  const [skillStoreMetadata, setSkillStoreMetadata] = useState<CanvasSkillStoreMetadata | null>(null);
  const [skillStorePagination, setSkillStorePagination] = useState<CanvasSkillStorePagination>(EMPTY_SKILL_STORE_PAGINATION);
  const [skillStoreStats, setSkillStoreStats] = useState<CanvasSkillStoreStats>(EMPTY_SKILL_STORE_STATS);
  const [skillStorePage, setSkillStorePage] = useState(1);
  const [skillStoreQuery, setSkillStoreQuery] = useState('');
  const deferredSkillStoreQuery = useDeferredValue(skillStoreQuery);
  const [skillStoreLoading, setSkillStoreLoading] = useState(false);
  const [skillStoreError, setSkillStoreError] = useState<string | null>(null);
  const [skillActionError, setSkillActionError] = useState<string | null>(null);
  const [pendingSkillAction, setPendingSkillAction] = useState<string | null>(null);

  async function loadSkills() {
    try {
      setIsLoading(true);
      const [skillsRes, statusRes] = await Promise.all([
        fetch('/api/skills'),
        fetch('/api/skills/status'),
      ]);
      const skillsData = await skillsRes.json();
      const statusData = await statusRes.json();

      if (skillsData.success) {
        const allSkills: CanvasSkill[] = skillsData.skills;
        const enabledNames: string[] = statusData.success ? (statusData.enabledSkills || []) : [];
        const allEnabled = statusData.success && statusData.allEnabled === true;

        const merged = allSkills.map((skill: CanvasSkill) => ({
          ...skill,
          enabled: allEnabled || enabledNames.includes(skill.name),
        }));

        const enabledCount = merged.filter((s: CanvasSkill) => s.enabled).length;
        setSkills(merged);
        setStats({
          total: merged.length,
          enabled: enabledCount,
          disabled: merged.length - enabledCount,
        });
      }
    } catch (error) {
      console.error('Failed to load skills:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadSkillTree() {
    try {
      const res = await fetch('/api/skills/tree?depth=4');
      const data = await res.json();
      if (data.success) {
        setSkillTree(data.data || []);
      }
    } catch (error) {
      console.error('Failed to load skill tree:', error);
    }
  }

  const loadSkillStore = useCallback(async () => {
    const storeState = skillLibraryTab === 'updates' ? 'updates' : 'all';
    const params = new URLSearchParams({
      page: String(skillStorePage),
      pageSize: String(SKILL_STORE_PAGE_SIZE),
      q: deferredSkillStoreQuery.trim(),
      state: storeState,
    });

    setSkillStoreLoading(true);
    setSkillStoreError(null);
    try {
      const response = await fetch(`/api/skills/store?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('skillLibrary.errors.storeLoad'));
      }
      setSkillStoreSkills(Array.isArray(data.skills) ? data.skills : []);
      setSkillStoreMetadata(data.registry || null);
      setSkillStorePagination(data.pagination || EMPTY_SKILL_STORE_PAGINATION);
      setSkillStoreStats(data.stats || EMPTY_SKILL_STORE_STATS);
    } catch (error) {
      setSkillStoreSkills([]);
      setSkillStoreMetadata(null);
      setSkillStorePagination(EMPTY_SKILL_STORE_PAGINATION);
      setSkillStoreStats(EMPTY_SKILL_STORE_STATS);
      setSkillStoreError(error instanceof Error ? error.message : t('skillLibrary.errors.storeLoad'));
    } finally {
      setSkillStoreLoading(false);
    }
  }, [deferredSkillStoreQuery, skillLibraryTab, skillStorePage, t]);

  useEffect(() => {
    startTransition(() => {
      loadSkills();
      loadSkillTree();
    });
  }, []);

  useEffect(() => {
    if (skillLibraryTab === 'library' || skillLibraryTab === 'updates') {
      startTransition(() => {
        void loadSkillStore();
      });
    }
  }, [loadSkillStore, skillLibraryTab]);

  const toggleDirectory = useCallback((dirPath: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const handleSkillClick = useCallback((skillName: string) => {
    const skill = skills.find(s => s.name === skillName);
    if (skill) {
      setSelectedSkill(skill);
      setRightView('info');
      setSelectedPath(skillName);
    }
  }, [skills]);

  const handleFileClick = useCallback(async (filePath: string) => {
    setSelectedPath(filePath);
    setRightView('preview');
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/skills/file?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.success) {
        setPreviewContent(data.content || '');
      } else {
        setPreviewError(data.error || 'Failed to load file');
      }
    } catch {
      setPreviewError('Failed to load file');
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  async function toggleSkill(skillName: string, enabled: boolean) {
    try {
      const endpoint = enabled ? `/api/skills/${skillName}/enable` : `/api/skills/${skillName}/disable`;
      const response = await fetch(endpoint, { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        setSkills(prev => prev.map(skill =>
          skill.name === skillName ? { ...skill, enabled } : skill
        ));
        setStats(prev => ({
          ...prev,
          enabled: enabled ? prev.enabled + 1 : prev.enabled - 1,
          disabled: enabled ? prev.disabled - 1 : prev.disabled + 1
        }));
      }
    } catch (error) {
      console.error('Failed to toggle skill:', error);
    }
  }

  async function enableAllSkills() {
    try {
      const response = await fetch('/api/skills/enable-all', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setSkills(prev => prev.map(skill => ({ ...skill, enabled: true })));
        setStats(prev => ({ ...prev, enabled: prev.total, disabled: 0 }));
      }
    } catch (error) {
      console.error('Failed to enable all skills:', error);
    }
  }

  async function disableAllSkills() {
    try {
      const response = await fetch('/api/skills/disable-all', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setSkills(prev => prev.map(skill => ({ ...skill, enabled: false })));
        setStats(prev => ({ ...prev, enabled: 0, disabled: prev.total }));
      }
    } catch (error) {
      console.error('Failed to disable all skills:', error);
    }
  }

  async function installStoreSkill(skillName: string, version?: string) {
    setPendingSkillAction(`install:${skillName}`);
    setSkillActionError(null);
    try {
      const response = await fetch('/api/skills/store/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skillName, version, enable: true, replace: true }),
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('skillLibrary.errors.install'));
      }
      await loadSkills();
      await loadSkillTree();
      await loadSkillStore();
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : t('skillLibrary.errors.install'));
    } finally {
      setPendingSkillAction(null);
    }
  }

  async function restoreSkill(skillName: string, prefer?: 'store' | 'seed') {
    setPendingSkillAction(`restore:${skillName}`);
    setSkillActionError(null);
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skillName)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefer, enable: true }),
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('skillLibrary.errors.restore'));
      }
      await loadSkills();
      await loadSkillTree();
      if (skillLibraryTab === 'library' || skillLibraryTab === 'updates') {
        await loadSkillStore();
      }
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : t('skillLibrary.errors.restore'));
    } finally {
      setPendingSkillAction(null);
    }
  }

  async function deleteSkill(skillName: string) {
    setPendingSkillAction(`delete:${skillName}`);
    setSkillActionError(null);
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skillName)}/delete`, { method: 'DELETE' });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('detail.errors.deleteFailed'));
      }
      setSelectedSkill((current) => current?.name === skillName ? null : current);
      setSelectedPath((current) => current === skillName || current?.startsWith(`${skillName}/`) ? null : current);
      setRightView('info');
      await loadSkills();
      await loadSkillTree();
      await loadSkillStore();
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : t('detail.errors.deleteFailed'));
    } finally {
      setPendingSkillAction(null);
    }
  }

  function getFileIcon(node: SkillFileNode, skill?: CanvasSkill | null) {
    if (skill) {
      return <CanvasSkillIcon skill={skill} className="h-5 w-5 text-[10px]" />;
    }

    if (node.type === 'directory') {
      return expandedDirs.has(node.path) ? (
        <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
      ) : (
        <Folder className="h-4 w-4 text-amber-500 shrink-0" />
      );
    }
    const ext = node.name.split('.').pop()?.toLowerCase();
    if (ext === 'md') return <FileText className="h-4 w-4 text-blue-500 shrink-0" />;
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'yaml', 'yml', 'html', 'css'].includes(ext || '')) {
      return <FileCode className="h-4 w-4 text-green-500 shrink-0" />;
    }
    return <File className="h-4 w-4 text-muted-foreground shrink-0" />;
  }

  function renderTree(nodes: SkillFileNode[], depth: number = 0): React.ReactNode {
    return nodes.map(node => {
      const isSkillDir = node.type === 'directory' && depth === 0;
      const skill = isSkillDir ? skills.find(s => s.name === node.name) : null;
      const isExpanded = expandedDirs.has(node.path);
      const isSelected = selectedPath === node.path;

      return (
        <div key={node.path}>
          <div
            role="button"
            tabIndex={0}
            className={cn(
              'w-full flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-left cursor-pointer',
              isSelected
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-muted text-foreground',
              depth > 0 && 'text-muted-foreground'
            )}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => {
              if (node.type === 'directory') {
                if (isSkillDir && skill) {
                  handleSkillClick(skill.name);
                }
                toggleDirectory(node.path);
              } else {
                handleFileClick(node.path);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (node.type === 'directory') {
                  if (isSkillDir && skill) handleSkillClick(skill.name);
                  toggleDirectory(node.path);
                } else {
                  handleFileClick(node.path);
                }
              }
            }}
          >
            {node.type === 'directory' && (
              <ChevronRight className={cn(
                'h-3 w-3 shrink-0 transition-transform',
                isExpanded && 'rotate-90'
              )} />
            )}
            {node.type === 'file' && <span className="w-3 shrink-0" />}
            {getFileIcon(node, skill)}
            <span className="truncate flex-1">{node.name}</span>
            {isSkillDir && skill && (
              <Switch
                checked={skill.enabled}
                onCheckedChange={(checked) => {
                  toggleSkill(skill.name, checked);
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className="scale-75 shrink-0"
                aria-label={t('toggleSkill', { name: skill.name })}
              />
            )}
          </div>
          {node.type === 'directory' && isExpanded && node.children && (
            <div>{renderTree(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });
  }

  function renderSkillStoreIcon(skill: CanvasSkillStoreEntry) {
    const initials = skill.displayName
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    if (skill.iconUrl) {
      return (
        <span className="flex h-10 w-10 shrink-0 overflow-hidden rounded-lg border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- Store icons are remote marketplace assets. */}
          <img src={skill.iconUrl} alt="" className="h-full w-full object-cover" />
        </span>
      );
    }

    return (
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold text-white"
        style={{ backgroundColor: skill.brandColor || '#64748b' }}
      >
        {initials || 'CS'}
      </span>
    );
  }

  function renderSkillStoreCard(skill: CanvasSkillStoreEntry) {
    const isInstalled = skill.installed.installed;
    const updateAvailable = skill.installed.updateAvailable;
    const isModified = skill.installed.modified;
    const isInstalling = pendingSkillAction === `install:${skill.name}`;
    const isRestoring = pendingSkillAction === `restore:${skill.name}`;
    const canInstall = !isInstalled || updateAvailable;
    const installLabel = updateAvailable
      ? t('skillLibrary.update')
      : isInstalled
        ? t('skillLibrary.installed')
        : t('skillLibrary.install');

    return (
      <div key={skill.name} className="rounded-lg border bg-background p-4">
        <div className="flex items-start gap-3">
          {renderSkillStoreIcon(skill)}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{skill.displayName}</h3>
              {skill.category ? <Badge variant="secondary" className="text-[10px]">{skill.category}</Badge> : null}
              <Badge variant="outline" className="text-[10px]">v{skill.latestVersion}</Badge>
              {isInstalled ? (
                <Badge variant={updateAvailable ? 'destructive' : 'default'} className="text-[10px]">
                  {updateAvailable ? t('skillLibrary.updateAvailable') : t('skillLibrary.installed')}
                </Badge>
              ) : null}
              {isModified ? <Badge variant="secondary" className="text-[10px]">{t('skillLibrary.modified')}</Badge> : null}
              {skill.license ? <Badge variant="outline" className="text-[10px]">{skill.license}</Badge> : null}
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">/{skill.name}</div>
            <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{skill.description}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {skill.publisher?.name || skillStoreMetadata?.name || t('skillLibrary.officialStore')}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {isInstalled && skill.installed.restoreAvailable ? (
              <Button
                variant="outline"
                size="sm"
                disabled={isRestoring || isInstalling}
                onClick={() => void restoreSkill(skill.name)}
                className="gap-1.5"
              >
                {isRestoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {t('skillLibrary.restore')}
              </Button>
            ) : null}
            <Button
              variant={canInstall ? 'default' : 'outline'}
              size="sm"
              disabled={isInstalling || isRestoring || !canInstall}
              onClick={() => void installStoreSkill(skill.name, skill.latestVersion)}
              className="gap-1.5"
            >
              {isInstalling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : updateAvailable ? (
                <ArrowUpCircle className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {installLabel}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  function renderSkillStorePagination() {
    if (skillStorePagination.totalItems === 0) {
      return null;
    }

    return (
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
        <span>
          {t('skillLibrary.pagination.status', {
            page: skillStorePagination.page,
            totalPages: skillStorePagination.totalPages,
            totalItems: skillStorePagination.totalItems,
          })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={skillStoreLoading || !skillStorePagination.hasPreviousPage}
            onClick={() => setSkillStorePage((page) => Math.max(1, page - 1))}
            className="h-8 gap-1.5"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('skillLibrary.pagination.previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={skillStoreLoading || !skillStorePagination.hasNextPage}
            onClick={() => setSkillStorePage((page) => page + 1)}
            className="h-8 gap-1.5"
          >
            {t('skillLibrary.pagination.next')}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const selectedSkillData = selectedPath
    ? skills.find(s => s.name === selectedPath)
    : null;
  const selectedSkillDeleting = selectedSkillData
    ? pendingSkillAction === `delete:${selectedSkillData.name}`
    : false;

  return (
    <>
      <Tabs
        value={panelTab}
        onValueChange={(value) => {
          if (value === 'plugins' || value === 'skills') {
            setPanelTab(value);
          }
        }}
        className="space-y-4"
      >
        <TabsList className="bg-transparent p-0">
          <TabsTrigger value="plugins" className="rounded-full px-4 data-[state=active]:bg-muted">
            {t('tabs.plugins')}
          </TabsTrigger>
          <TabsTrigger value="skills" className="rounded-full px-4 data-[state=active]:bg-muted">
            {t('tabs.skills')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="plugins" className="space-y-4">
          <CanvasPluginsSection
            onPluginsChanged={() => {
              void loadSkills();
              void loadSkillTree();
            }}
          />
        </TabsContent>

        <TabsContent value="skills" className="space-y-4">
          <Tabs
            value={skillLibraryTab}
            onValueChange={(value) => {
              if (value === 'installed' || value === 'library' || value === 'updates') {
                setSkillStorePage(1);
                setSkillLibraryTab(value);
              }
            }}
            className="space-y-4"
          >
            <TabsList className="flex h-auto flex-wrap justify-start bg-muted/60 p-1">
              <TabsTrigger value="installed" className="rounded-md px-3">
                {t('skillLibrary.tabs.installed')}
              </TabsTrigger>
              <TabsTrigger value="library" className="rounded-md px-3">
                {t('skillLibrary.tabs.library')}
              </TabsTrigger>
              <TabsTrigger value="updates" className="rounded-md px-3">
                {t('skillLibrary.tabs.updates', { count: skillStoreStats.updates })}
              </TabsTrigger>
            </TabsList>

            {skillActionError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {skillActionError}
              </div>
            ) : null}

            <TabsContent value="installed" className="space-y-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <span>{stats.total} {t('stats.total').toLowerCase()}</span>
                    <span className="text-green-600">{stats.enabled} {t('stats.enabled').toLowerCase()}</span>
                    <span>{stats.disabled} {t('stats.disabled').toLowerCase()}</span>
                  </div>
                  <div className="flex-1" />
                  <Button variant="outline" size="sm" onClick={enableAllSkills} disabled={stats.enabled === stats.total} className="gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                    {t('actions.enableAll')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={disableAllSkills} disabled={stats.disabled === stats.total} className="gap-1.5">
                    <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    {t('actions.disableAll')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)} className="gap-1.5">
                    <Upload className="h-3.5 w-3.5" />
                    {t('upload.button')}
                  </Button>
                </div>

                <div
                  className="grid h-[calc(100dvh-16rem)] min-h-[420px] grid-cols-1 grid-rows-[minmax(12rem,35%)_minmax(0,1fr)] overflow-hidden rounded-lg border lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] lg:grid-rows-1"
                  data-testid="skills-browser"
                >
                  <div className="flex min-h-0 flex-col border-b bg-muted/30 lg:border-b-0 lg:border-r">
                    <div className="shrink-0 border-b bg-muted/50 p-2">
                      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {t('stats.total')}
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-1 text-sm" data-testid="skills-tree-scroll">
                      {skillTree.length === 0 ? (
                        <div className="px-3 py-8 text-center text-muted-foreground text-sm">
                          <Wrench className="h-8 w-8 mx-auto mb-2 opacity-50" />
                          {t('emptyState.title')}
                        </div>
                      ) : (
                        renderTree(skillTree)
                      )}
                    </div>
                  </div>

                  <div className="min-h-0 overflow-y-auto" data-testid="skills-detail-scroll">
                    {rightView === 'info' && selectedSkillData ? (
                      <div className="p-5 space-y-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            <CanvasSkillIcon skill={selectedSkillData} className="h-12 w-12 text-sm" />
                            <div className="min-w-0">
                              <h2 className="text-xl font-bold">{selectedSkillData.title}</h2>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-sm font-mono text-muted-foreground">{selectedSkillData.name}</span>
                                <Badge variant={selectedSkillData.enabled ? 'default' : 'secondary'} className="text-xs">
                                  {selectedSkillData.enabled ? t('detail.enabled') : t('detail.disabled')}
                                </Badge>
                              </div>
                            </div>
                          </div>
                          <Switch
                            checked={selectedSkillData.enabled}
                            onCheckedChange={(checked) => toggleSkill(selectedSkillData.name, checked)}
                            aria-label={t('toggleSkill', { name: selectedSkillData.name })}
                          />
                        </div>

                        <div className="bg-muted/30 rounded-lg p-4">
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                            {selectedSkillData.description}
                          </p>
                        </div>

                        {(selectedSkillData.compatibility || selectedSkillData.license) && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                            {selectedSkillData.compatibility && (
                              <div>
                                <span className="font-medium text-foreground">{t('detail.compatibility')}</span>
                                <p className="text-muted-foreground mt-0.5">{selectedSkillData.compatibility}</p>
                              </div>
                            )}
                            {selectedSkillData.license && (
                              <div>
                                <span className="font-medium text-foreground">{t('detail.license')}</span>
                                <p className="text-muted-foreground mt-0.5">{selectedSkillData.license}</p>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSelectedSkill(selectedSkillData);
                              setDialogOpen(true);
                            }}
                            className="gap-1.5"
                          >
                            <Info className="h-4 w-4" />
                            {t('detail.viewDocumentation')}
                          </Button>
                          {!selectedSkillData.plugin ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={pendingSkillAction === `restore:${selectedSkillData.name}`}
                              onClick={() => void restoreSkill(selectedSkillData.name)}
                              className="gap-1.5"
                            >
                              {pendingSkillAction === `restore:${selectedSkillData.name}` ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="h-4 w-4" />
                              )}
                              {t('skillLibrary.restore')}
                            </Button>
                          ) : null}
                          {!selectedSkillData.plugin ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={selectedSkillDeleting}
                                  className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                >
                                  {selectedSkillDeleting ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-4 w-4" />
                                  )}
                                  {t('detail.deleteSkill')}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>{t('detail.deleteConfirmTitle')}</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {t('detail.deleteConfirmDescription', { name: selectedSkillData.name })}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>{t('detail.deleteCancel')}</AlertDialogCancel>
                                  <AlertDialogAction
                                    variant="destructive"
                                    onClick={() => void deleteSkill(selectedSkillData.name)}
                                  >
                                    {t('detail.deleteConfirm')}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          ) : null}
                        </div>
                      </div>
                    ) : rightView === 'preview' && selectedPath ? (
                      <div className="p-4">
                        <div className="flex items-center gap-2 mb-3 text-sm font-mono text-muted-foreground">
                          <FileText className="h-4 w-4" />
                          {selectedPath.split('/').pop()}
                        </div>
                        {previewLoading ? (
                          <div className="flex items-center justify-center py-12">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          </div>
                        ) : previewError ? (
                          <div className="text-sm text-destructive bg-destructive/10 p-4 rounded-lg">
                            {previewError}
                          </div>
                        ) : (
                          <pre className="overflow-x-auto rounded-lg bg-muted/30 p-4 font-mono text-sm whitespace-pre-wrap break-words">
                            {previewContent}
                          </pre>
                        )}
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center py-16 text-muted-foreground">
                        <FolderOpen className="h-10 w-10 mb-3 opacity-50" />
                        <p className="text-sm">{t('detail.selectPrompt')}</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Card className="border-dashed border-muted-foreground/30 bg-muted/30">
                    <CardContent className="px-4 py-4 sm:px-6">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">{t('integrationsHint.label')}</span> {t('integrationsHint.body')}
                        </p>
                        <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                          <Link href="/settings?tab=integrations">{t('integrationsHint.openSettings')}</Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-dashed border-blue-500/30 bg-blue-50/30 dark:bg-blue-950/20">
                    <CardContent className="px-4 py-4 sm:px-6">
                      <div className="flex items-start gap-3">
                        <div className="flex-1">
                          <p className="text-sm text-foreground">
                            <span className="font-medium">{t('creationHint.label')}</span> {t('creationHint.bodyBefore')}{' '}
                            <span className="font-semibold text-blue-600 dark:text-blue-400">{t('creationHint.creatorSkill')}</span>
                            {t('creationHint.bodyAfter')}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="library" className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={skillStoreQuery}
                    onChange={(event) => {
                      setSkillStorePage(1);
                      setSkillStoreQuery(event.target.value);
                    }}
                    placeholder={t('skillLibrary.searchPlaceholder')}
                    className="pl-9"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadSkillStore()} disabled={skillStoreLoading} className="gap-1.5">
                  {skillStoreLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {t('skillLibrary.reload')}
                </Button>
              </div>
              {skillStoreMetadata ? (
                <div className="text-xs text-muted-foreground">
                  {t('skillLibrary.storeSource', { name: skillStoreMetadata.name })}
                </div>
              ) : null}
              {skillStoreError ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                  {skillStoreError}
                </div>
              ) : null}
              {skillStoreLoading ? (
                <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : skillStoreSkills.length === 0 ? (
                <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                  {t('skillLibrary.emptyStore')}
                </div>
              ) : (
                <>
                  <div className="grid gap-3 md:grid-cols-2">
                    {skillStoreSkills.map((skill) => renderSkillStoreCard(skill))}
                  </div>
                  {renderSkillStorePagination()}
                </>
              )}
            </TabsContent>

            <TabsContent value="updates" className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={skillStoreQuery}
                    onChange={(event) => {
                      setSkillStorePage(1);
                      setSkillStoreQuery(event.target.value);
                    }}
                    placeholder={t('skillLibrary.searchPlaceholder')}
                    className="pl-9"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadSkillStore()} disabled={skillStoreLoading} className="gap-1.5">
                  {skillStoreLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {t('skillLibrary.reload')}
                </Button>
              </div>
              {skillStoreError ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                  {skillStoreError}
                </div>
              ) : null}
              {skillStoreLoading ? (
                <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : skillStoreSkills.length === 0 ? (
                <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                  {t('skillLibrary.noUpdates')}
                </div>
              ) : (
                <>
                  <div className="grid gap-3 md:grid-cols-2">
                    {skillStoreSkills.map((skill) => renderSkillStoreCard(skill))}
                  </div>
                  {renderSkillStorePagination()}
                </>
              )}
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>

      <SkillDetailDialog
        skill={selectedSkill}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onDeleted={() => {
          setSelectedSkill(null);
          setSelectedPath(null);
          loadSkills();
          loadSkillTree();
        }}
      />

      <SkillUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={() => { loadSkills(); loadSkillTree(); }}
      />
    </>
  );
}
