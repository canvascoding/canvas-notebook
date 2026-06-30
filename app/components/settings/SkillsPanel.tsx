'use client';

import { useState, useEffect, useCallback, useMemo, startTransition, useDeferredValue } from 'react';
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
import {
  McpServerDialog,
  collectMcpEnvEntries,
  createBlankMcpServerDraft,
  createMcpServerDraftFromConnector,
  parseMcpConfigFile,
  toMcpServerDraft,
  updateMcpConfigRawServer,
  type McpServerDraft,
} from '@/app/components/settings/McpServerDialog';
import { CanvasPluginIcon } from '@/app/lib/plugins/plugin-icons';
import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
type SelectedPluginDetail = { source: 'store' | 'installed'; name: string };

const PANEL_TAB_STORAGE_KEY = 'canvas.skills.panelTab';
const PLUGIN_STORE_TAB_STORAGE_KEY = 'canvas.skills.pluginStoreTab';
const SKILL_LIBRARY_TAB_STORAGE_KEY = 'canvas.skills.skillLibraryTab';

function readStoredTab<T extends string>(key: string, allowedValues: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return allowedValues.includes(stored as T) ? stored as T : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredTab(key: string, value: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore unavailable storage; tabs still work for the current render.
  }
}

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

type PluginSkillStatus =
  | 'ok'
  | 'missing'
  | 'plugin-update-available'
  | 'skill-update-available'
  | 'modified'
  | 'standalone'
  | 'untracked';

type PluginSkillState = {
  name: string;
  title?: string;
  expectedVersion?: string;
  installed: boolean;
  enabled?: boolean;
  version?: string;
  sourceType?: 'store' | 'seed' | 'local' | 'plugin';
  sourcePluginName?: string;
  status: PluginSkillStatus;
  updateAvailable: boolean;
  modified: boolean;
  repairable: boolean;
};

type PluginSkillSummary = {
  total: number;
  installed: number;
  missing: number;
  updateAvailable: number;
  modified: number;
  repairable: number;
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
    installedPlugin?: CanvasPluginSettingsRecord;
    skills?: PluginSkillState[];
    skillSummary?: PluginSkillSummary;
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
  sourcePlugin?: {
    name: string;
    displayName?: string;
    version?: string;
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
  hasSkillIssues?: boolean;
  items: PluginPreflightItem[];
  skills?: PluginSkillState[];
  summary: {
    total: number;
    ready: number;
    requiredMissing: number;
    recommendedMissing: number;
  };
  skillSummary?: PluginSkillSummary;
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

type PluginMcpSetupState = {
  open: boolean;
  pluginName: string;
  version?: string;
  source: 'store' | 'installed';
  connector: CanvasPluginMcpConnector | null;
  draft: McpServerDraft;
  originalName?: string;
  rawContent: string;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
};

const EMPTY_COMPOSIO_CONNECTOR_STATE: ComposioConnectorState = {
  isLoading: false,
  configured: false,
  apiKeyValid: false,
  toolkitsBySlug: {},
  connectedSlugs: {},
};

const EMPTY_PLUGIN_MCP_SETUP_STATE: PluginMcpSetupState = {
  open: false,
  pluginName: '',
  source: 'installed',
  connector: null,
  draft: createBlankMcpServerDraft(),
  rawContent: '',
  isLoading: false,
  isSaving: false,
  error: null,
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
  const [storeTab, setStoreTab] = useState<PluginStoreTab>(() => readStoredTab(
    PLUGIN_STORE_TAB_STORAGE_KEY,
    ['discover', 'installed', 'updates', 'advanced'] as const,
    'discover',
  ));
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
  const [activeConnectorAction, setActiveConnectorAction] = useState<string | null>(null);
  const [mcpSetupState, setMcpSetupState] = useState<PluginMcpSetupState>(EMPTY_PLUGIN_MCP_SETUP_STATE);
  const [selectedPluginDetail, setSelectedPluginDetail] = useState<SelectedPluginDetail | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const requiredComposioToolkits = useMemo(() => uniqueByKey(
    [
      ...plugins.flatMap((plugin) => getComposioRecommendations(plugin.connectors)),
      ...storePlugins.flatMap((plugin) => getComposioRecommendations(plugin.connectors)),
    ],
    (connector) => connector.toolkit,
  ), [plugins, storePlugins]);

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

  const loadComposioConnectorState = useCallback(async (options: { isCancelled?: () => boolean } = {}) => {
    if (requiredComposioToolkits.length === 0) {
      setComposioConnectorState(EMPTY_COMPOSIO_CONNECTOR_STATE);
      return;
    }

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

      if (!options.isCancelled?.()) {
        setComposioConnectorState({
          isLoading: false,
          configured,
          apiKeyValid,
          toolkitsBySlug,
          connectedSlugs,
        });
      }
    } catch (stateError) {
      if (!options.isCancelled?.()) {
        setComposioConnectorState({
          ...EMPTY_COMPOSIO_CONNECTOR_STATE,
          isLoading: false,
          error: stateError instanceof Error ? stateError.message : t('connectors.composioStatusError'),
        });
      }
    }
  }, [requiredComposioToolkits, t]);

  useEffect(() => {
    let cancelled = false;

    startTransition(() => {
      void loadComposioConnectorState({ isCancelled: () => cancelled });
    });

    return () => {
      cancelled = true;
    };
  }, [loadComposioConnectorState]);

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

  async function pollComposioConnector(toolkit: string) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 2500 : 4000));
      await loadComposioConnectorState();
      const statusResponse = await fetch('/api/composio/status', { credentials: 'include', cache: 'no-store' }).catch(() => null);
      if (!statusResponse) continue;
      const status = await statusResponse.json().catch(() => null);
      const connected = Array.isArray(status?.connectedAccounts)
        && status.connectedAccounts.some((account: { toolkit?: { slug?: unknown } }) => account.toolkit?.slug === toolkit);
      if (connected) return;
    }
  }

  async function connectComposioToolkit(toolkit: string) {
    if (!composioConnectorState.configured || !composioConnectorState.apiKeyValid) {
      window.location.href = '/settings?tab=integrations&section=composio';
      return;
    }

    const toolkitState = composioConnectorState.toolkitsBySlug[toolkit];
    const isConnected = Boolean(toolkitState?.connected || composioConnectorState.connectedSlugs[toolkit]);
    if (isConnected) {
      window.location.href = `/settings?tab=integrations&section=composio&connected=${encodeURIComponent(toolkit)}`;
      return;
    }

    setActiveConnectorAction(`composio:${toolkit}`);
    setError(null);
    let authWindow: Window | null = null;
    try {
      authWindow = window.open('about:blank', '_blank');
      if (!authWindow) {
        throw new Error(t('connectors.popupBlocked'));
      }
      try {
        authWindow.opener = null;
      } catch {
        // Some browsers expose opener as read-only after window creation.
      }

      const response = await fetch(`/api/composio/connect/${encodeURIComponent(toolkit)}`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('connectors.connectError'));
      }
      if (data.noAuth) {
        authWindow.close();
        await loadComposioConnectorState();
        const storePlugin = selectedPluginDetail ? storeByName.get(selectedPluginDetail.name) : undefined;
        if (storePlugin) await checkStorePluginPreflight(storePlugin.name, storePlugin.latestVersion);
        return;
      }
      if (data.redirectUrl) {
        authWindow.location.href = data.redirectUrl;
        void pollComposioConnector(toolkit);
      } else {
        authWindow.close();
        await loadComposioConnectorState();
      }
    } catch (connectError) {
      authWindow?.close();
      setError(connectError instanceof Error ? connectError.message : t('connectors.connectError'));
    } finally {
      setActiveConnectorAction(null);
    }
  }

  async function openPluginMcpSetup(options: {
    pluginName: string;
    version?: string;
    source: 'store' | 'installed';
    connector: CanvasPluginMcpConnector;
  }) {
    const fallbackDraft = createMcpServerDraftFromConnector(options.connector);
    setMcpSetupState({
      open: true,
      pluginName: options.pluginName,
      version: options.version,
      source: options.source,
      connector: options.connector,
      draft: fallbackDraft,
      rawContent: '',
      isLoading: true,
      isSaving: false,
      error: null,
    });

    try {
      const [configResponse, templateResponse] = await Promise.all([
        fetch('/api/integrations/mcp-config', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/plugins/mcp-template', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            source: options.source,
            name: options.pluginName,
            version: options.version,
            connector: options.connector.name,
          }),
        }).catch((error) => error as Error),
      ]);

      const configPayload = await configResponse.json();
      if (!configResponse.ok || !configPayload.success) {
        throw new Error(configPayload.error || t('connectors.mcpLoadError'));
      }

      const rawContent = String(configPayload.data?.rawContent || '{}');
      const parsedConfig = parseMcpConfigFile(rawContent);
      const existingServer = parsedConfig.mcpServers[options.connector.name];
      let templateConfig: Record<string, unknown> | undefined;
      if (!(templateResponse instanceof Error)) {
        const templatePayload = await templateResponse.json().catch(() => null);
        if (templateResponse.ok && templatePayload?.success) {
          templateConfig = templatePayload.template?.config;
        }
      }

      setMcpSetupState((current) => ({
        ...current,
        draft: existingServer
          ? toMcpServerDraft(options.connector.name, existingServer)
          : createMcpServerDraftFromConnector(options.connector, templateConfig),
        originalName: existingServer ? options.connector.name : undefined,
        rawContent,
        isLoading: false,
        error: null,
      }));
    } catch (setupError) {
      setMcpSetupState((current) => ({
        ...current,
        isLoading: false,
        error: setupError instanceof Error ? setupError.message : t('connectors.mcpLoadError'),
      }));
    }
  }

  async function savePluginMcpServer() {
    if (!mcpSetupState.connector) return;

    setMcpSetupState((current) => ({
      ...current,
      isSaving: true,
      error: null,
    }));

    try {
      const envEntries = collectMcpEnvEntries(mcpSetupState.draft);
      if (envEntries.length > 0) {
        const envResponse = await fetch('/api/integrations/env?scope=integrations', {
          credentials: 'include',
          cache: 'no-store',
        });
        const envPayload = await envResponse.json();
        if (!envResponse.ok || !envPayload.success) {
          throw new Error(envPayload.error || t('connectors.mcpSaveError'));
        }

        const currentEntries = Array.isArray(envPayload.data?.entries)
          ? envPayload.data.entries.map((entry: { key: string; value: string }) => ({ key: entry.key, value: entry.value }))
          : [];
        const nextEntriesByKey = new Map(currentEntries.map((entry: { key: string; value: string }) => [entry.key, entry]));
        for (const entry of envEntries) {
          nextEntriesByKey.set(entry.key, entry);
        }

        const saveEnvResponse = await fetch('/api/integrations/env', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            scope: 'integrations',
            mode: 'kv',
            entries: Array.from(nextEntriesByKey.values()),
          }),
        });
        const saveEnvPayload = await saveEnvResponse.json();
        if (!saveEnvResponse.ok || !saveEnvPayload.success) {
          throw new Error(saveEnvPayload.error || t('connectors.mcpSaveError'));
        }
      }

      const rawContent = updateMcpConfigRawServer(
        mcpSetupState.rawContent || '{}',
        mcpSetupState.draft,
        mcpSetupState.originalName,
      );
      const saveMcpResponse = await fetch('/api/integrations/mcp-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ rawContent }),
      });
      const saveMcpPayload = await saveMcpResponse.json();
      if (!saveMcpResponse.ok || !saveMcpPayload.success) {
        throw new Error(saveMcpPayload.error || t('connectors.mcpSaveError'));
      }

      const storePlugin = storeByName.get(mcpSetupState.pluginName);
      if (storePlugin) {
        await checkStorePluginPreflight(storePlugin.name, storePlugin.latestVersion);
      }
      setMcpSetupState(EMPTY_PLUGIN_MCP_SETUP_STATE);
    } catch (saveError) {
      setMcpSetupState((current) => ({
        ...current,
        isSaving: false,
        error: saveError instanceof Error ? saveError.message : t('connectors.mcpSaveError'),
      }));
    }
  }

  function buildConnectorSetupItems(connectors: CanvasPluginSettingsRecord['connectors']): PluginPreflightItem[] {
    const composio = getComposioRecommendations(connectors);
    const email = connectors?.email || [];
    const mcp = getMcpRecommendations(connectors);
    const composioItems: PluginPreflightItem[] = composio.map((connector) => {
      const toolkit = composioConnectorState.toolkitsBySlug[connector.toolkit];
      const configured = Boolean(composioConnectorState.configured && composioConnectorState.apiKeyValid);
      const connected = Boolean(toolkit?.connected || composioConnectorState.connectedSlugs[connector.toolkit]);
      const available = configured && Boolean(toolkit);
      return {
        type: 'composio',
        key: connector.toolkit,
        label: connector.label || toolkit?.name || connector.toolkit,
        required: connector.required === true,
        ready: available && connected,
        available,
        connected,
        configured,
        logo: toolkit?.logo,
        reason: connector.reason,
        details: connector.tools?.length ? [`Tools: ${connector.tools.join(', ')}`] : undefined,
        action: !configured ? 'configure-composio' : connected ? 'none' : 'connect-composio',
      };
    });
    const emailItems: PluginPreflightItem[] = email.map((connector, index) => {
      const providers = connector.providers?.length ? connector.providers.join(', ') : t('connectors.emailProvidersDefault');
      return {
        type: 'email',
        key: connector.label || `email-${index}`,
        label: connector.label || t('connectors.emailAccount'),
        required: connector.required === true,
        ready: false,
        configured: false,
        connected: false,
        reason: connector.reason,
        details: [t('connectors.emailProviders', { providers })],
        action: 'configure-email',
      };
    });
    const mcpItems: PluginPreflightItem[] = mcp.map((connector) => {
      const details = [
        connector.configPath ? t('connectors.mcpConfigPath', { path: connector.configPath }) : null,
        connector.env?.length ? t('connectors.envVars', { vars: connector.env.join(', ') }) : null,
        connector.oauth ? t('connectors.oauthRequired') : null,
      ].filter((detail): detail is string => Boolean(detail));
      return {
        type: 'mcp',
        key: connector.name,
        label: connector.label || connector.name,
        required: connector.required === true,
        ready: false,
        configured: false,
        connected: false,
        reason: connector.reason,
        details,
        action: 'configure-mcp',
      };
    });
    return [...composioItems, ...emailItems, ...mcpItems];
  }

  function renderConnectorSetupAction(
    item: PluginPreflightItem,
    options: {
      connectors: CanvasPluginSettingsRecord['connectors'];
      installedPlugin?: CanvasPluginSettingsRecord;
      storePlugin?: CanvasPluginStoreEntry;
    },
  ) {
    if (item.type === 'composio') {
      const isPending = activeConnectorAction === `composio:${item.key}`;
      const label = item.action === 'none'
        ? t('connectors.manage')
        : item.action === 'configure-composio'
          ? t('connectors.configureComposio')
          : t('connectors.connect');
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          onClick={() => void connectComposioToolkit(item.key)}
          disabled={isPending}
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {label}
        </Button>
      );
    }

    if (item.type === 'mcp') {
      const connector = getMcpRecommendations(options.connectors).find((entry) => entry.name === item.key);
      const pluginName = options.installedPlugin?.name || options.storePlugin?.name;
      if (!connector || !pluginName) return null;
      const source = options.installedPlugin ? 'installed' : 'store';
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          onClick={() => void openPluginMcpSetup({
            pluginName,
            version: source === 'store' ? options.storePlugin?.latestVersion : undefined,
            source,
            connector,
          })}
        >
          {item.ready ? t('connectors.manage') : t('preflight.setup')}
        </Button>
      );
    }

    if (item.type === 'email') {
      return (
        <Button asChild variant="outline" size="sm" className="h-8 shrink-0">
          <Link href="/settings?tab=integrations&section=email">{item.ready ? t('connectors.manage') : t('connectors.openEmail')}</Link>
        </Button>
      );
    }

    return null;
  }

  function renderPluginConnectorSetup(options: {
    connectors: CanvasPluginSettingsRecord['connectors'];
    installedPlugin?: CanvasPluginSettingsRecord;
    storePlugin?: CanvasPluginStoreEntry;
    isChecking?: boolean;
  }) {
    const { connectors, installedPlugin, isChecking, storePlugin } = options;
    if (!hasConnectorRecommendations(connectors)) {
      return (
        <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {t('details.noConnectors')}
        </div>
      );
    }

    const preflight = storePlugin ? preflightByPlugin[getPreflightKey(storePlugin.name, storePlugin.latestVersion)] : undefined;
    const items = preflight?.result?.items?.length ? preflight.result.items : buildConnectorSetupItems(connectors);
    const readyCount = preflight?.result?.summary.ready ?? items.filter((item) => item.ready).length;
    const requiredMissing = preflight?.result?.summary.requiredMissing ?? items.filter((item) => item.required && !item.ready).length;
    const recommendedMissing = preflight?.result?.summary.recommendedMissing ?? items.filter((item) => !item.required && !item.ready).length;
    const total = preflight?.result?.summary.total ?? items.length;
    const hasRequiredMissing = preflight?.result?.hasRequiredMissing ?? requiredMissing > 0;

    return (
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {hasRequiredMissing ? <Info className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {t('connectors.setupTitle')}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={hasRequiredMissing ? 'destructive' : 'secondary'} className="text-[10px]">
              {hasRequiredMissing ? t('preflight.needsSetup') : t('preflight.ready')}
            </Badge>
            {storePlugin ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void checkStorePluginPreflight(storePlugin.name, storePlugin.latestVersion)}
                disabled={isChecking}
                className="h-8 gap-1.5"
              >
                {isChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {t('details.refreshCheck')}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('preflight.summary', {
            ready: readyCount,
            total,
            required: requiredMissing,
            recommended: recommendedMissing,
          })}
        </p>
        {preflight?.isLoading ? (
          <div className="flex items-center gap-2 rounded-md bg-background/70 px-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('preflight.checking')}
          </div>
        ) : null}
        {preflight?.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {preflight.error}
          </div>
        ) : null}
        <div className="space-y-1.5">
          {items.map((item) => (
            <div key={`${item.type}-${item.key}`} className="flex flex-col gap-2 rounded-md bg-background/70 px-2 py-2 sm:flex-row sm:items-start">
              <div className="flex min-w-0 flex-1 items-start gap-2">
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
              </div>
              <div className="flex justify-end sm:pl-2">
                {renderConnectorSetupAction(item, { connectors, installedPlugin, storePlugin })}
              </div>
            </div>
          ))}
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

  function getPluginSkillStatusLabel(status: PluginSkillStatus): string {
    if (status === 'ok') return t('skillCheck.status.ok');
    if (status === 'missing') return t('skillCheck.status.missing');
    if (status === 'plugin-update-available') return t('skillCheck.status.pluginUpdateAvailable');
    if (status === 'skill-update-available') return t('skillCheck.status.skillUpdateAvailable');
    if (status === 'modified') return t('skillCheck.status.modified');
    if (status === 'standalone') return t('skillCheck.status.standalone');
    return t('skillCheck.status.untracked');
  }

  function getPluginSkillStatusVariant(status: PluginSkillStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
    if (status === 'ok') return 'default';
    if (status === 'missing' || status === 'plugin-update-available' || status === 'skill-update-available') return 'destructive';
    if (status === 'modified') return 'secondary';
    return 'outline';
  }

  function renderPluginSkillCheck(skills: PluginSkillState[] | undefined, summary: PluginSkillSummary | undefined) {
    if (!summary || summary.total === 0) {
      return (
        <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {t('skillCheck.noInstalledSkills')}
        </div>
      );
    }

    return (
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {summary.repairable > 0 ? <Info className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {t('skillCheck.title')}
          </div>
          <Badge variant={summary.repairable > 0 ? 'destructive' : 'secondary'} className="text-[10px]">
            {summary.repairable > 0 ? t('skillCheck.needsRepair') : t('skillCheck.ready')}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('skillCheck.summary', {
            installed: summary.installed,
            total: summary.total,
            missing: summary.missing,
            updates: summary.updateAvailable,
            modified: summary.modified,
          })}
        </p>
        {skills?.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {skills.map((skill) => (
              <div key={skill.name} className="rounded-md bg-background/70 px-3 py-2">
                <div className="flex items-start gap-2">
                  <CanvasSkillIcon
                    skill={{ name: skill.name, title: skill.title || skill.name } as CanvasSkill}
                    className="h-7 w-7 text-[10px]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{skill.title || skill.name}</span>
                      <Badge variant={getPluginSkillStatusVariant(skill.status)} className="text-[9px]">
                        {getPluginSkillStatusLabel(skill.status)}
                      </Badge>
                      {skill.repairable ? (
                        <Badge variant="secondary" className="text-[9px]">{t('skillCheck.repairable')}</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">/{skill.name}</div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t('skillCheck.versionLine', {
                        installed: skill.version || '-',
                        expected: skill.expectedVersion || '-',
                      })}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const storeByName = new Map(storePlugins.map((plugin) => [plugin.name, plugin]));
  const installedByName = new Map(plugins.map((plugin) => [plugin.name, plugin]));

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

  function maybeCheckStorePluginPreflight(plugin: CanvasPluginStoreEntry) {
    if (!hasConnectorRecommendations(plugin.connectors) && !plugin.installed.installed) return;
    const preflight = preflightByPlugin[getPreflightKey(plugin.name, plugin.latestVersion)];
    if (preflight?.isLoading || preflight?.result) return;
    void checkStorePluginPreflight(plugin.name, plugin.latestVersion);
  }

  function openStorePluginDetail(plugin: CanvasPluginStoreEntry) {
    setSelectedPluginDetail({ source: 'store', name: plugin.name });
    maybeCheckStorePluginPreflight(plugin);
  }

  function openInstalledPluginDetail(plugin: CanvasPluginSettingsRecord) {
    setSelectedPluginDetail({ source: 'installed', name: plugin.name });
    const storePlugin = storeByName.get(plugin.name);
    if (storePlugin) {
      maybeCheckStorePluginPreflight(storePlugin);
    }
  }

  function renderPluginDetailIcon(
    storePlugin: CanvasPluginStoreEntry | undefined,
    installedPlugin: CanvasPluginSettingsRecord | undefined,
  ) {
    if (storePlugin) return renderStoreIcon(storePlugin);
    if (installedPlugin) return <CanvasPluginIcon plugin={installedPlugin} className="h-10 w-10 text-sm" />;
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-sm font-semibold text-muted-foreground">
        CP
      </span>
    );
  }

  function renderPluginDetailsDialog() {
    if (!selectedPluginDetail) return null;

    const storePlugin = storeByName.get(selectedPluginDetail.name);
    const installedPlugin = installedByName.get(selectedPluginDetail.name) || storePlugin?.installed.installedPlugin;
    const displayName = storePlugin?.displayName || installedPlugin?.interface?.displayName || selectedPluginDetail.name;
    const description = storePlugin?.description
      || installedPlugin?.interface?.shortDescription
      || installedPlugin?.description
      || t('details.descriptionFallback');
    const category = storePlugin?.category || installedPlugin?.interface?.category;
    const publisherName = storePlugin?.publisher?.name || storeMetadata?.name || t('officialStore');
    const connectors = storePlugin?.connectors || installedPlugin?.connectors;
    const skillItems = installedPlugin?.skills?.length
      ? installedPlugin.skills.map((skill) => ({
        name: skill.name,
        title: skill.title || skill.name,
        description: skill.description,
      }))
      : (storePlugin?.skills || []).map((skill) => ({
        name: skill,
        title: skill,
        description: '',
      }));
    const isInstalled = Boolean(installedPlugin || storePlugin?.installed.installed);
    const installedEnabled = Boolean(installedPlugin?.enabled ?? storePlugin?.installed.enabled);
    const updateAvailable = Boolean(storePlugin?.installed.updateAvailable);
    const isPending = pendingPluginName === selectedPluginDetail.name || pendingPluginName === `store:${selectedPluginDetail.name}`;
    const preflight = storePlugin ? preflightByPlugin[getPreflightKey(storePlugin.name, storePlugin.latestVersion)] : undefined;
    const isChecking = Boolean(preflight?.isLoading);
    const skillSummary = preflight?.result?.skillSummary || storePlugin?.installed.skillSummary;
    const skillStates = preflight?.result?.skills || storePlugin?.installed.skills || [];
    const skillRepairAvailable = Boolean(isInstalled && skillSummary && skillSummary.repairable > 0);
    const canInstallFromStore = Boolean(storePlugin && (!isInstalled || updateAvailable || skillRepairAvailable));
    const storeActionLabel = updateAvailable
      ? t('update')
      : skillRepairAvailable
        ? t('repair')
        : isInstalled
          ? t('installed')
          : t('addPlugin');

    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) setSelectedPluginDetail(null);
        }}
      >
        <DialogContent layout="viewport" className="gap-0 p-0">
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 text-left">
            <div className="flex items-start gap-3">
              {renderPluginDetailIcon(storePlugin, installedPlugin)}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="truncate text-xl">{displayName}</DialogTitle>
                  {category ? <Badge variant="secondary" className="text-[10px]">{category}</Badge> : null}
                  {storePlugin ? <Badge variant="outline" className="text-[10px]">v{storePlugin.latestVersion}</Badge> : null}
                  {installedPlugin ? <Badge variant="outline" className="text-[10px]">v{installedPlugin.version}</Badge> : null}
                  {isInstalled ? (
                    <Badge variant={updateAvailable ? 'destructive' : 'default'} className="text-[10px]">
                      {updateAvailable ? t('updateAvailable') : t('installed')}
                    </Badge>
                  ) : null}
                  {installedPlugin ? (
                    <Badge variant={installedEnabled ? 'default' : 'secondary'} className="text-[10px]">
                      {installedEnabled ? t('enabled') : t('disabled')}
                    </Badge>
                  ) : null}
                </div>
                <DialogDescription className="mt-1 font-mono text-xs">/{selectedPluginDetail.name}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="mx-auto max-w-4xl space-y-5">
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t('details.description')}</h3>
                <p className="text-sm leading-6 text-muted-foreground">{description}</p>
              </section>

              <section className="grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('details.pluginId')}</div>
                  <div className="mt-1 font-mono text-xs">{selectedPluginDetail.name}</div>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('details.publisher')}</div>
                  <div className="mt-1">{publisherName}</div>
                </div>
                {storePlugin ? (
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('details.latestVersion')}</div>
                    <div className="mt-1">v{storePlugin.latestVersion}</div>
                  </div>
                ) : null}
                {installedPlugin ? (
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('details.installedVersion')}</div>
                    <div className="mt-1">v{installedPlugin.version}</div>
                  </div>
                ) : null}
                {installedPlugin?.sourceRegistryId ? (
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('details.source')}</div>
                    <div className="mt-1">{installedPlugin.sourceRegistryId}</div>
                  </div>
                ) : null}
                {installedPlugin?.license ? (
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('details.license')}</div>
                    <div className="mt-1">{installedPlugin.license}</div>
                  </div>
                ) : null}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t('details.includedSkills')}</h3>
                {skillItems.length ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {skillItems.map((skill) => (
                      <div key={skill.name} className="rounded-md border bg-background p-3">
                        <div className="flex items-center gap-2">
                          <CanvasSkillIcon
                            skill={{ name: skill.name, title: skill.title, enabled: true } as CanvasSkill}
                            className="h-7 w-7 text-[10px]"
                          />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{skill.title}</div>
                            <div className="font-mono text-[11px] text-muted-foreground">/{skill.name}</div>
                          </div>
                        </div>
                        {skill.description ? <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                    {t('details.noSkills')}
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t('connectors.setupTitle')}</h3>
                {renderPluginConnectorSetup({
                  connectors,
                  installedPlugin: installedPlugin || undefined,
                  storePlugin,
                  isChecking,
                })}
              </section>

              {storePlugin && isInstalled ? (
                <section>
                  {renderPluginSkillCheck(skillStates, skillSummary)}
                </section>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
            {installedPlugin ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch
                  checked={installedEnabled}
                  disabled={isPending}
                  onCheckedChange={(checked) => void setPluginEnabled(installedPlugin.name, checked)}
                  aria-label={t('toggle', { name: installedPlugin.name })}
                />
                {installedEnabled ? t('enabled') : t('disabled')}
              </label>
            ) : (
              <span className="text-sm text-muted-foreground">{t('details.notInstalled')}</span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {installedPlugin ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => void deletePlugin(installedPlugin.name)}
                  className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {t('delete')}
                </Button>
              ) : null}
              {storePlugin ? (
                <Button
                  variant={canInstallFromStore ? 'default' : 'outline'}
                  size="sm"
                  disabled={isPending || isChecking || !canInstallFromStore}
                  onClick={() => void installStorePlugin(storePlugin.name, storePlugin.latestVersion)}
                  className="gap-1.5"
                >
                  {isPending || isChecking ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : updateAvailable ? (
                    <ArrowUpCircle className="h-3.5 w-3.5" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {storeActionLabel}
                </Button>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  function renderStorePluginCard(plugin: CanvasPluginStoreEntry) {
    const isPending = pendingPluginName === `store:${plugin.name}`;
    const isInstalled = plugin.installed.installed;
    const updateAvailable = plugin.installed.updateAvailable;
    const skillRepairAvailable = Boolean(isInstalled && plugin.installed.skillSummary && plugin.installed.skillSummary.repairable > 0);
    const preflightKey = getPreflightKey(plugin.name, plugin.latestVersion);
    const preflightState = preflightByPlugin[preflightKey];
    const needsPreflight = (hasConnectorRecommendations(plugin.connectors) || skillRepairAvailable)
      && !preflightState?.result
      && (!isInstalled || updateAvailable || skillRepairAvailable);
    const isChecking = Boolean(preflightState?.isLoading);
    const buttonLabel = needsPreflight
      ? t('details.openDetails')
      : updateAvailable
      ? t('update')
      : skillRepairAvailable
        ? t('repair')
      : isInstalled
        ? t('installed')
        : t('addPlugin');
    const buttonIcon = needsPreflight
      ? <Info className="h-3.5 w-3.5" />
      : updateAvailable
      ? <ArrowUpCircle className="h-3.5 w-3.5" />
      : skillRepairAvailable
        ? <Wrench className="h-3.5 w-3.5" />
      : <Download className="h-3.5 w-3.5" />;

    return (
      <div
        key={plugin.name}
        role="button"
        tabIndex={0}
        onClick={() => openStorePluginDetail(plugin)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openStorePluginDetail(plugin);
          }
        }}
        className="rounded-lg border bg-background p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
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
              {skillRepairAvailable ? <Badge variant="destructive" className="text-[10px]">{t('repairNeeded')}</Badge> : null}
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
        <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {plugin.publisher?.name || storeMetadata?.name || t('officialStore')}
          </span>
          <Button
            variant={updateAvailable || !isInstalled || skillRepairAvailable ? 'default' : 'outline'}
            size="sm"
            disabled={isPending || isChecking || (isInstalled && !updateAvailable && !skillRepairAvailable)}
            onClick={(event) => {
              event.stopPropagation();
              if (needsPreflight) {
                openStorePluginDetail(plugin);
                return;
              }
              void installStorePlugin(plugin.name, plugin.latestVersion);
            }}
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
    const skillRepairAvailable = Boolean(storePlugin?.installed.skillSummary && storePlugin.installed.skillSummary.repairable > 0);
    const updatePreflightState = storePlugin
      ? preflightByPlugin[getPreflightKey(storePlugin.name, storePlugin.latestVersion)]
      : undefined;
    const updateNeedsPreflight = Boolean(
      storePlugin
      && (hasConnectorRecommendations(storePlugin.connectors) || skillRepairAvailable)
      && !updatePreflightState?.result,
    );

    return (
      <div
        key={plugin.name}
        role="button"
        tabIndex={0}
        onClick={() => openInstalledPluginDetail(plugin)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openInstalledPluginDetail(plugin);
          }
        }}
        className="rounded-lg border bg-background p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
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
              {skillRepairAvailable ? <Badge variant="destructive" className="text-[10px]">{t('repairNeeded')}</Badge> : null}
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
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <label
            className="flex items-center gap-2 text-sm text-muted-foreground"
            onClick={(event) => event.stopPropagation()}
          >
            <Switch
              checked={plugin.enabled}
              disabled={isPending}
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={(checked) => void setPluginEnabled(plugin.name, checked)}
              aria-label={t('toggle', { name: plugin.name })}
            />
            {plugin.enabled ? t('enabled') : t('disabled')}
          </label>
          <div className="flex items-center gap-2">
            {updateAvailable || skillRepairAvailable ? (
              <Button
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={(event) => {
                  event.stopPropagation();
                  if (updateNeedsPreflight) {
                    openInstalledPluginDetail(plugin);
                    return;
                  }
                  void installStorePlugin(plugin.name, storePlugin?.latestVersion);
                }}
                className="gap-1.5"
              >
                {isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : updateNeedsPreflight ? (
                  <Info className="h-3.5 w-3.5" />
                ) : skillRepairAvailable ? (
                  <Wrench className="h-3.5 w-3.5" />
                ) : (
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                )}
                {updateNeedsPreflight ? t('details.openDetails') : skillRepairAvailable ? t('repair') : t('update')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={(event) => {
                event.stopPropagation();
                void deletePlugin(plugin.name);
              }}
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
            writeStoredTab(PLUGIN_STORE_TAB_STORAGE_KEY, value);
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

      {renderPluginDetailsDialog()}
      <McpServerDialog
        open={mcpSetupState.open}
        onOpenChange={(open) => {
          if (!open) {
            setMcpSetupState(EMPTY_PLUGIN_MCP_SETUP_STATE);
            return;
          }
          setMcpSetupState((current) => ({ ...current, open }));
        }}
        draft={mcpSetupState.draft}
        onDraftChange={(patch) => setMcpSetupState((current) => ({
          ...current,
          draft: { ...current.draft, ...patch },
        }))}
        onSave={() => void savePluginMcpServer()}
        editingServerName={mcpSetupState.originalName}
        isSaving={mcpSetupState.isSaving || mcpSetupState.isLoading}
        loadingMessage={mcpSetupState.isLoading ? t('connectors.mcpLoadingTemplate') : null}
        error={mcpSetupState.error}
      />
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
  const [resetSkillsOpen, setResetSkillsOpen] = useState(false);
  const [resetSkillsConfirm, setResetSkillsConfirm] = useState('');
  const [panelTab, setPanelTab] = useState<SkillsPanelTab>(() => readStoredTab(
    PANEL_TAB_STORAGE_KEY,
    ['plugins', 'skills'] as const,
    'plugins',
  ));
  const [skillLibraryTab, setSkillLibraryTab] = useState<SkillLibraryTab>(() => readStoredTab(
    SKILL_LIBRARY_TAB_STORAGE_KEY,
    ['installed', 'library', 'updates'] as const,
    'installed',
  ));
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

  async function resetAllSkills() {
    if (resetSkillsConfirm !== 'DELETE_SKILLS') return;

    setPendingSkillAction('reset:all');
    setSkillActionError(null);
    try {
      const response = await fetch('/api/skills/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: resetSkillsConfirm }),
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('skillLibrary.errors.resetAll'));
      }
      setSelectedSkill(null);
      setSelectedPath(null);
      setRightView('info');
      setExpandedDirs(new Set());
      setResetSkillsOpen(false);
      setResetSkillsConfirm('');
      await loadSkills();
      await loadSkillTree();
      await loadSkillStore();
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : t('skillLibrary.errors.resetAll'));
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
              {skill.sourcePlugin ? (
                <Badge variant="secondary" className="text-[10px]">
                  {t('skillLibrary.fromPlugin', { name: skill.sourcePlugin.displayName || skill.sourcePlugin.name })}
                </Badge>
              ) : null}
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
            writeStoredTab(PANEL_TAB_STORAGE_KEY, value);
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
                writeStoredTab(SKILL_LIBRARY_TAB_STORAGE_KEY, value);
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
                  <AlertDialog
                    open={resetSkillsOpen}
                    onOpenChange={(open) => {
                      setResetSkillsOpen(open);
                      if (!open) setResetSkillsConfirm('');
                    }}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pendingSkillAction === 'reset:all'}
                        className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        {pendingSkillAction === 'reset:all' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        {t('skillLibrary.resetAll.button')}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('skillLibrary.resetAll.title')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('skillLibrary.resetAll.description')}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          {t('skillLibrary.resetAll.confirmLabel', { confirmation: 'DELETE_SKILLS' })}
                        </p>
                        <Input
                          value={resetSkillsConfirm}
                          onChange={(event) => setResetSkillsConfirm(event.target.value)}
                          placeholder="DELETE_SKILLS"
                          autoComplete="off"
                        />
                      </div>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('skillLibrary.resetAll.cancel')}</AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          disabled={resetSkillsConfirm !== 'DELETE_SKILLS' || pendingSkillAction === 'reset:all'}
                          onClick={(event) => {
                            event.preventDefault();
                            void resetAllSkills();
                          }}
                        >
                          {pendingSkillAction === 'reset:all' ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : null}
                          {t('skillLibrary.resetAll.confirm')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
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
