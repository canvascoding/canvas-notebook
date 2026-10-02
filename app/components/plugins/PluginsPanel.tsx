'use client';

import { useState, useEffect, useCallback, useMemo, useRef, startTransition, useDeferredValue } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
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
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditorClient';
import {
  SearchablePolicyTargetPicker,
  type PolicyTargetOption,
} from '@/app/components/organization/SearchablePolicyTargetPicker';
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
import { McpAuthorizationError, startMcpAuthorization, waitForMcpAuthorization, cancelMcpAuthorization, type McpAuthorizationFlow } from '@/app/lib/desktop/mcp-oauth-client';
import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
import type { OrganizationPolicyTargetCatalog } from '@/app/lib/organization/policy-targets';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { usePluginNavigation } from '@/app/components/plugins/usePluginNavigation';
import { pluginSetupSettingsHref } from '@/app/lib/plugins/plugin-return';
import { PLUGIN_CONNECTION_FILTERS, PLUGIN_READINESS_FILTERS, type PluginNavigation } from '@/app/lib/plugins/plugin-navigation';

interface SkillFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  resourceId?: string;
  skillName?: string;
  scopeType?: 'system' | 'organization' | 'user';
  sourceType?: 'core' | 'standalone' | 'plugin';
  relativePath?: string;
  size?: number;
  modified?: number;
  children?: SkillFileNode[];
}

type RightPanelView = 'info' | 'preview';
type SkillsPanelTab = 'plugins' | 'skills';
type PluginStoreTab = 'discover' | 'installed' | 'updates' | 'advanced';
type SkillLibraryTab = 'installed' | 'library' | 'updates';
type SelectedPluginDetail = {
  source: 'store' | 'installed';
  name: string;
  resourceId?: string;
};
type CapabilityManagementScope = 'user' | 'organization';
type CapabilityPolicyEffect = 'optional' | 'default-enabled' | 'required' | 'blocked';
type CapabilityPolicyTargetType = 'organization' | 'role' | 'workspace' | 'project' | 'user';

type CapabilityPolicyRecord = {
  id: string;
  resourceType: 'skill' | 'plugin';
  resourceId: string;
  targetType: CapabilityPolicyTargetType;
  targetId: string;
  effect: CapabilityPolicyEffect;
  revision: number;
};

type EffectiveCapabilitySummary = {
  ref: {
    resourceType: 'skill' | 'plugin';
    scopeType: 'system' | 'organization' | 'user';
    resourceId: string;
    name: string;
    version: string;
  };
  readiness: string;
};

const EMPTY_POLICY_TARGETS: OrganizationPolicyTargetCatalog = {
  users: [],
  workspaces: [],
  projects: [],
};

function isMarkdownFilePath(filePath: string) {
  return /\.mdx?$/i.test(filePath);
}

function capabilityScopeUrl(url: string, scope: CapabilityManagementScope): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}scope=${scope}`;
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
  resourceId?: string;
  installedBy?: string;
  ownerUserId?: string | null;
  scopeType?: 'system' | 'organization' | 'user' | 'legacy';
  sourceType?: 'standalone';
  revision?: number;
  effectivePolicy?: CapabilityPolicyEffect;
  readiness?: 'available' | 'disabled' | 'blocked' | 'conflict' | 'personal-connection-required';
  connectionReadiness?: Pick<PluginPreflight, 'ready' | 'items' | 'summary'>;
  blockedReason?: string | null;
  conflictResourceIds?: string[];
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

type CanvasPluginStoreFacets = { categories: string[]; connectionTypes: Array<NonNullable<PluginNavigation['connection']>> };
const EMPTY_STORE_FACETS: CanvasPluginStoreFacets = { categories: [], connectionTypes: [] };

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
  apiKeyState?: 'missing' | 'valid' | 'invalid_or_insufficient_scope' | 'unknown';
  providerHealthy?: boolean;
  errorCode?: string;
  retryAfterMs?: number;
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
  errorCode?: string;
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

function preflightBlocksPluginWrite(preflight: PluginPreflightState | undefined): boolean {
  return Boolean(preflight?.isLoading || preflight?.error || preflight?.result?.hasRequiredMissing
    || preflight?.result?.items.some((item) => item.required && !item.ready));
}

function CanvasPluginsSection({
  managementScope,
  canManagePackages,
  onPluginsChanged,
}: {
  managementScope: CapabilityManagementScope;
  canManagePackages: boolean;
  onPluginsChanged: () => void;
}) {
  const t = useTranslations('skills.plugins');
  const locale = useLocale();
  const router = useRouter();
  const { navigation, navigate } = usePluginNavigation();
  const searchParams = useSearchParams();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId) || '';
  const activeWorkspaceName = useWorkspaceStore((state) => state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.name);
  const composioHeaders = useCallback((json = false): HeadersInit => ({
    ...(activeWorkspaceId ? { [WORKSPACE_ID_HEADER]: activeWorkspaceId } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }), [activeWorkspaceId]);
  const [plugins, setPlugins] = useState<CanvasPluginSettingsRecord[]>([]);
  const [storePlugins, setStorePlugins] = useState<CanvasPluginStoreEntry[]>([]);
  const [installedStorePlugins, setInstalledStorePlugins] = useState<CanvasPluginStoreEntry[]>([]);
  const [storeFacets, setStoreFacets] = useState<CanvasPluginStoreFacets>(EMPTY_STORE_FACETS);
  const [storeMetadata, setStoreMetadata] = useState<CanvasPluginStoreMetadata | null>(null);
  const [storePagination, setStorePagination] = useState<CanvasPluginStorePagination>(EMPTY_STORE_PAGINATION);
  const [storeStats, setStoreStats] = useState<CanvasPluginStoreStats>(EMPTY_STORE_STATS);
  const storeTab = navigation.view as PluginStoreTab;
  const storePage = navigation.page || 1;
  const searchQuery = navigation.q || '';
  const categoryFilter = storeTab === 'discover' || storeTab === 'updates' ? navigation.category : undefined;
  const connectionFilter = storeTab === 'discover' || storeTab === 'updates' ? navigation.connection : undefined;
  const [isLoading, setIsLoading] = useState(true);
  const [isStoreLoading, setIsStoreLoading] = useState(true);
  const [pluginsLoadFailed, setPluginsLoadFailed] = useState(false);
  const [sourcePath, setSourcePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [pendingPluginName, setPendingPluginName] = useState<string | null>(null);
  const [preflightByPlugin, setPreflightByPlugin] = useState<Record<string, PluginPreflightState>>({});
  const [composioConnectorState, setComposioConnectorState] = useState<ComposioConnectorState>(EMPTY_COMPOSIO_CONNECTOR_STATE);
  const [activeConnectorAction, setActiveConnectorAction] = useState<string | null>(null);
  const [mcpSetupState, setMcpSetupState] = useState<PluginMcpSetupState>(EMPTY_PLUGIN_MCP_SETUP_STATE);
  const selectedPluginDetail = useMemo<SelectedPluginDetail | null>(() => navigation.plugin ? ({
    source: navigation.source || 'store', name: navigation.plugin, resourceId: navigation.resourceId,
  }) : null, [navigation.plugin, navigation.resourceId, navigation.source]);
  const [detailStorePlugin, setDetailStorePlugin] = useState<CanvasPluginStoreEntry | null>(null);
  const [detailRefreshRevision, setDetailRefreshRevision] = useState(0);
  const [detailStoreError, setDetailStoreError] = useState<string | null>(null);
  const [isDetailStoreLoading, setIsDetailStoreLoading] = useState(false);
  const pluginLoadRequestRef = useRef(0);
  const storeLoadRequestRef = useRef(0);
  const latestPluginLoadersRef = useRef<{ installed: () => Promise<void>; store: () => Promise<void> } | null>(null);
  const mcpSetupRequestRef = useRef(0);
  const connectorFlowRequestRef = useRef(0);
  const mcpAuthorizationRef = useRef<{ controller: AbortController; flow?: McpAuthorizationFlow } | null>(null);
  const preflightRequestRef = useRef<Record<string, number>>({});
  const activeWorkspaceRef = useRef(activeWorkspaceId);
  activeWorkspaceRef.current = activeWorkspaceId;
  const workspaceReady = !navigation.workspaceId || navigation.workspaceId === activeWorkspaceId;
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const selectedInstalledPlugin = useMemo(() => {
    if (selectedPluginDetail?.source !== 'installed') return undefined;
    return plugins.find((plugin) => (
      selectedPluginDetail.resourceId
        ? plugin.resourceId === selectedPluginDetail.resourceId
        : plugin.name === selectedPluginDetail.name
    ));
  }, [plugins, selectedPluginDetail]);
  const requiredComposioToolkits = useMemo(() => {
    if (!selectedPluginDetail) return [];
    const connectors = selectedPluginDetail.source === 'store'
      ? (storePlugins.find((plugin) => plugin.name === selectedPluginDetail.name) || detailStorePlugin)?.connectors
      : selectedInstalledPlugin?.connectors;
    return uniqueByKey(getComposioRecommendations(connectors), (connector) => connector.toolkit);
  }, [detailStorePlugin, selectedInstalledPlugin, selectedPluginDetail, storePlugins]);

  useEffect(() => {
    mcpSetupRequestRef.current += 1;
    connectorFlowRequestRef.current += 1;
    setActiveConnectorAction(null);
    setPreflightByPlugin({});
    setMcpSetupState(EMPTY_PLUGIN_MCP_SETUP_STATE);
    return () => {
      mcpSetupRequestRef.current += 1;
      connectorFlowRequestRef.current += 1;
      mcpAuthorizationRef.current?.controller.abort();
      if (mcpAuthorizationRef.current?.flow) void cancelMcpAuthorization(mcpAuthorizationRef.current.flow);
      mcpAuthorizationRef.current = null;
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    setDetailStorePlugin(null);
    setDetailStoreError(null);
    if (!selectedPluginDetail || !workspaceReady) { setIsDetailStoreLoading(false); return; }
    setIsDetailStoreLoading(true);
    const params = new URLSearchParams({ name: selectedPluginDetail.name, scope: managementScope });
    void fetch(`/api/plugins/store?${params}`, { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.storeLoad'));
        if (!cancelled) setDetailStorePlugin(payload.plugins?.find((plugin: CanvasPluginStoreEntry) => plugin.name === selectedPluginDetail.name) || null);
      })
      .catch((loadError) => { if (!cancelled) setDetailStoreError(loadError instanceof Error ? loadError.message : t('errors.storeLoad')); })
      .finally(() => { if (!cancelled) setIsDetailStoreLoading(false); });
    return () => { cancelled = true; };
  }, [detailRefreshRevision, managementScope, selectedPluginDetail, t, workspaceReady]);

  const loadInstalledPlugins = useCallback(async () => {
    const requestId = ++pluginLoadRequestRef.current;
    setIsLoading(true);
    setPluginsLoadFailed(false);
    setError(null);
    try {
      const installedParams = new URLSearchParams({ scope: managementScope, fresh: '1' });
      if (activeWorkspaceId) installedParams.set('workspaceId', activeWorkspaceId);
      const response = await fetch(`/api/plugins?${installedParams}`, { credentials: 'include', cache: 'no-store', headers: composioHeaders() });
      if (requestId !== pluginLoadRequestRef.current) return;
      const data = await response.json();
      if (requestId !== pluginLoadRequestRef.current) return;
      if (!response.ok || !data.success) throw new Error(data.error || t('errors.load'));
      setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
    } catch (loadError) {
      if (requestId === pluginLoadRequestRef.current) {
        setPluginsLoadFailed(true);
        setError(loadError instanceof Error ? loadError.message : t('errors.load'));
      }
    } finally {
      if (requestId === pluginLoadRequestRef.current) setIsLoading(false);
    }
  }, [activeWorkspaceId, composioHeaders, managementScope, t]);

  const loadStorePlugins = useCallback(async () => {
    const requestId = ++storeLoadRequestRef.current;
    const storeState = storeTab === 'updates' ? 'updates' : storeTab === 'installed' ? 'installed' : 'all';
    const storeParams = new URLSearchParams({
      page: String(storePage),
      pageSize: String(PLUGIN_STORE_PAGE_SIZE),
      q: deferredSearchQuery.trim(),
      state: storeState,
      scope: managementScope,
    });
    if (categoryFilter) storeParams.set('category', categoryFilter);
    if (connectionFilter) storeParams.set('connection', connectionFilter);
    setIsStoreLoading(true);
    setStoreError(null);
    try {
      const response = await fetch(`/api/plugins/store?${storeParams}`, { credentials: 'include', cache: 'no-store' });
      if (requestId !== storeLoadRequestRef.current) return;
      const data = await response.json();
      if (requestId !== storeLoadRequestRef.current) return;
      if (!response.ok || !data.success) throw new Error(data.error || t('errors.storeLoad'));
      setStorePlugins(Array.isArray(data.plugins) ? data.plugins : []);
      setInstalledStorePlugins(Array.isArray(data.installedPlugins) ? data.installedPlugins : []);
      setStoreFacets(data.facets || EMPTY_STORE_FACETS);
      setStoreMetadata(data.registry || null);
      setStorePagination(data.pagination || EMPTY_STORE_PAGINATION);
      setStoreStats(data.stats || EMPTY_STORE_STATS);
    } catch (loadError) {
      if (requestId === storeLoadRequestRef.current) setStoreError(loadError instanceof Error ? loadError.message : t('errors.storeLoad'));
    } finally {
      if (requestId === storeLoadRequestRef.current) setIsStoreLoading(false);
    }
  }, [categoryFilter, connectionFilter, deferredSearchQuery, managementScope, storePage, storeTab, t]);

  latestPluginLoadersRef.current = { installed: loadInstalledPlugins, store: loadStorePlugins };
  const loadPluginData = useCallback(async () => {
    const loaders = latestPluginLoadersRef.current;
    if (!loaders) return;
    const installedRequestId = pluginLoadRequestRef.current + 1;
    await Promise.all([loaders.installed(), loaders.store()]);
    if (installedRequestId === pluginLoadRequestRef.current) setDetailRefreshRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    if (!workspaceReady) return;
    startTransition(() => {
      void loadInstalledPlugins();
    });
    return () => { pluginLoadRequestRef.current += 1; };
  }, [loadInstalledPlugins, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady) return;
    startTransition(() => { void loadStorePlugins(); });
    return () => { storeLoadRequestRef.current += 1; };
  }, [loadStorePlugins, workspaceReady]);

  const loadComposioConnectorState = useCallback(async (options: { isCancelled?: () => boolean } = {}) => {
    const workspaceId = activeWorkspaceId;
    const isCancelled = () => activeWorkspaceRef.current !== workspaceId || Boolean(options.isCancelled?.());
    if (requiredComposioToolkits.length === 0) {
      setComposioConnectorState(EMPTY_COMPOSIO_CONNECTOR_STATE);
      return;
    }

    try {
      setComposioConnectorState((current) => ({ ...current, isLoading: true, error: undefined }));
      const statusResponse = await fetch('/api/composio/status', {
        credentials: 'include',
        cache: 'no-store',
        headers: composioHeaders(),
      });
      const status = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(status.error || t('connectors.composioStatusError'));
      const configured = Boolean(status.configured);
      const apiKeyValid = Boolean(status.apiKeyValid);
      const providerHealthy = status.providerHealthy !== false;
      const connectedSlugs: Record<string, boolean> = {};

      if (Array.isArray(status.connectedAccounts)) {
        for (const account of status.connectedAccounts) {
          const slug = typeof account?.toolkit?.slug === 'string' ? account.toolkit.slug : '';
          if (slug) connectedSlugs[slug] = true;
        }
      }

      let toolkitsBySlug: Record<string, ComposioToolkitSummary> = {};
      if (configured && apiKeyValid && providerHealthy) {
        const toolkitsResponse = await fetch('/api/composio/toolkits?summary=1&includeLogos=1', {
          credentials: 'include',
          cache: 'no-store',
          headers: composioHeaders(),
        });
        const toolkitsPayload = await toolkitsResponse.json();
        if (!toolkitsResponse.ok) throw new Error(toolkitsPayload.error || t('connectors.composioStatusError'));
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

      if (!isCancelled()) {
        setComposioConnectorState({
          isLoading: false,
          configured,
          apiKeyValid,
          apiKeyState: status.apiKeyState,
          providerHealthy,
          errorCode: typeof status.errorCode === 'string' ? status.errorCode : undefined,
          retryAfterMs: typeof status.retryAfterMs === 'number' ? status.retryAfterMs : undefined,
          toolkitsBySlug,
          connectedSlugs,
        });
      }
    } catch (stateError) {
      if (!isCancelled()) {
        setComposioConnectorState({
          ...EMPTY_COMPOSIO_CONNECTOR_STATE,
          isLoading: false,
          error: stateError instanceof Error ? stateError.message : t('connectors.composioStatusError'),
        });
      }
    }
  }, [activeWorkspaceId, composioHeaders, requiredComposioToolkits, t]);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceReady) return;
    startTransition(() => {
      void loadComposioConnectorState({ isCancelled: () => cancelled });
    });

    return () => {
      cancelled = true;
    };
  }, [loadComposioConnectorState, workspaceReady]);

  async function installLocalPlugin() {
    if (!canManagePackages) { setError(t('permissions.askAdmin')); return; }
    if (!workspaceReady) return;
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
        body: JSON.stringify({ sourcePath: trimmedPath, enable: true, replace: true, scope: managementScope }),
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

  const checkStorePluginPreflight = useCallback(async (pluginName: string, version?: string) => {
    const preflightKey = getPreflightKey(pluginName, version);
    const workspaceId = activeWorkspaceId;
    const requestId = (preflightRequestRef.current[preflightKey] || 0) + 1;
    preflightRequestRef.current[preflightKey] = requestId;
    const isCurrent = () => activeWorkspaceRef.current === workspaceId && preflightRequestRef.current[preflightKey] === requestId;
    setPreflightByPlugin((current) => ({
      ...current,
      [preflightKey]: { isLoading: true },
    }));
    setError(null);
    try {
      const response = await fetch('/api/plugins/store/preflight', {
        method: 'POST',
        headers: composioHeaders(true),
        body: JSON.stringify({ name: pluginName, version, scope: managementScope }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || t('errors.preflight'));
      }
      if (!isCurrent()) return;
      setPreflightByPlugin((current) => ({
        ...current,
        [preflightKey]: { isLoading: false, result: data.preflight },
      }));
    } catch (preflightError) {
      if (!isCurrent()) return;
      setPreflightByPlugin((current) => ({
        ...current,
        [preflightKey]: {
          isLoading: false,
          error: preflightError instanceof Error ? preflightError.message : t('errors.preflight'),
        },
      }));
    }
  }, [activeWorkspaceId, composioHeaders, managementScope, t]);

  const selectedCatalogPlugin = selectedPluginDetail
    ? storePlugins.find((plugin) => plugin.name === selectedPluginDetail.name) || detailStorePlugin
    : null;
  useEffect(() => {
    if (!workspaceReady || !selectedCatalogPlugin || !selectedPluginDetail) return;
    if (selectedPluginDetail.source === 'installed' && (isLoading || !selectedInstalledPlugin)) return;
    if (selectedPluginDetail.source === 'installed' && selectedInstalledPlugin?.scopeType === 'organization' && managementScope === 'user') return;
    void checkStorePluginPreflight(selectedCatalogPlugin.name, selectedCatalogPlugin.latestVersion);
  }, [checkStorePluginPreflight, isLoading, managementScope, selectedCatalogPlugin, selectedInstalledPlugin, selectedPluginDetail, workspaceReady]);

  const emailOAuthError = searchParams.get('emailOAuthError');
  const composioOAuthError = searchParams.get('composioError');
  const connectionReturnError = composioOAuthError || emailOAuthError;
  const returnErrorNotice = connectionReturnError ? (['access_denied', 'user_cancelled', 'cancelled'].includes(connectionReturnError)
    ? t('connectors.connectionCancelled') : t('connectors.connectionFailed')) : null;
  const displayedError = error || returnErrorNotice;

  function clearConnectionReturnFeedback() {
    const url = new URL(window.location.href);
    url.searchParams.delete('composioError');
    url.searchParams.delete('emailOAuthError');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  useEffect(() => {
    if (!selectedPluginDetail || !workspaceReady) return;
    const refreshOnFocus = () => {
      if (document.visibilityState === 'hidden') return;
      void loadPluginData();
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [loadPluginData, selectedPluginDetail, workspaceReady]);

  async function installStorePlugin(pluginName: string, version?: string) {
    if (!canManagePackages) { setError(t('permissions.askAdmin')); return; }
    if (!workspaceReady) return;
    const storePlugin = storePlugins.find((plugin) => plugin.name === pluginName)
      || installedStorePlugins.find((plugin) => plugin.name === pluginName)
      || (detailStorePlugin?.name === pluginName ? detailStorePlugin : undefined);
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
    if (preflightBlocksPluginWrite(preflightByPlugin[preflightKey]) || activeConnectorAction) return;
    if (selectedPluginDetail?.source === 'installed' && selectedPluginDetail.name === pluginName && selectedInstalledPlugin && isAssignedOrganizationPlugin(selectedInstalledPlugin)) return;

    setPendingPluginName(`store:${pluginName}`);
    const workspaceId = activeWorkspaceId;
    setError(null);
    try {
      const response = await fetch('/api/plugins/store/install', {
        method: 'POST',
        headers: composioHeaders(true),
        body: JSON.stringify({
          name: pluginName,
          version,
          enable: storePlugin?.installed.installed ? storePlugin.installed.enabled : true,
          replace: true,
          scope: managementScope,
        }),
      });
      const data = await response.json();
      if (!data.success) {
        const details = data.validation?.errors?.length ? ` ${data.validation.errors.join(' ')}` : '';
        throw new Error(`${data.error || t('errors.install')}${details}`);
      }
      if (activeWorkspaceRef.current !== workspaceId) { onPluginsChanged(); return; }
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

  async function setPluginEnabled(plugin: CanvasPluginSettingsRecord, enabled: boolean) {
    if (!workspaceReady || isPluginPreferenceLocked(plugin)) return;
    setPendingPluginName(plugin.name);
    setError(null);
    try {
      const response = plugin.scopeType === 'organization' && managementScope === 'user'
        ? await fetch('/api/skills/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: plugin.resourceId, enabled }),
        })
        : await fetch(capabilityScopeUrl(`/api/plugins/${plugin.name}/${enabled ? 'enable' : 'disable'}`, managementScope), { method: 'POST' });
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

  async function deletePlugin(plugin: CanvasPluginSettingsRecord) {
    if (!canManagePackages) { setError(t('permissions.askAdmin')); return; }
    if (!workspaceReady || isAssignedOrganizationPlugin(plugin)) return;
    const pluginName = plugin.name;
    if (!window.confirm(t('deleteConfirm', { name: pluginName }))) {
      return;
    }

    setPendingPluginName(pluginName);
    setError(null);
    try {
      const response = await fetch(capabilityScopeUrl(`/api/plugins/${pluginName}`, managementScope), { method: 'DELETE' });
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

  function isAssignedOrganizationPlugin(plugin: CanvasPluginSettingsRecord): boolean {
    return managementScope === 'user' && plugin.scopeType === 'organization';
  }

  function isPluginPreferenceLocked(plugin: CanvasPluginSettingsRecord): boolean {
    if (!isAssignedOrganizationPlugin(plugin) && !canManagePackages) return true;
    if (managementScope !== 'user') return false;

    if (plugin.readiness === 'blocked' || plugin.readiness === 'conflict') {
      return true;
    }

    return isAssignedOrganizationPlugin(plugin) && (
      !plugin.resourceId
      || plugin.effectivePolicy === 'required'
      || plugin.effectivePolicy === 'blocked'
    );
  }

  function pluginActivationGuidance(plugin: CanvasPluginSettingsRecord): string {
    if (plugin.readiness === 'blocked' || plugin.effectivePolicy === 'blocked') return t('permissions.blocked');
    if (plugin.readiness === 'conflict') return t('permissions.conflict');
    if (isAssignedOrganizationPlugin(plugin)) {
      if (plugin.effectivePolicy === 'required') return t('permissions.required');
      return t('permissions.personalActivation');
    }
    return canManagePackages ? t('permissions.packageActivationHint') : t('permissions.askAdmin');
  }

  function pluginReturnPath() {
    const url = new URL(`/${locale}/plugins?${searchParams}`, 'https://canvas.invalid');
    for (const key of ['composio', 'composioError', 'toolkit', 'emailOAuth', 'emailOAuthError']) url.searchParams.delete(key);
    if (activeWorkspaceId) url.searchParams.set('workspaceId', activeWorkspaceId);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  async function refreshPluginConnections() {
    await Promise.all([loadPluginData(), loadComposioConnectorState()]);
    const storePlugin = selectedCatalogPlugin;
    if (storePlugin && !(selectedPluginDetail?.source === 'installed' && selectedInstalledPlugin?.scopeType === 'organization' && managementScope === 'user')) {
      await checkStorePluginPreflight(storePlugin.name, storePlugin.latestVersion);
    }
  }

  async function pollComposioConnector(toolkit: string, authWindow: Window, requestId: number, workspaceId: string) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 500 : 1000));
      if (requestId !== connectorFlowRequestRef.current || activeWorkspaceRef.current !== workspaceId) return 'obsolete';
      const statusResponse = await fetch('/api/composio/status', {
        credentials: 'include',
        cache: 'no-store',
        headers: composioHeaders(),
      }).catch(() => null);
      if (requestId !== connectorFlowRequestRef.current || activeWorkspaceRef.current !== workspaceId) return 'obsolete';
      if (!statusResponse) {
        if (authWindow.closed) return 'cancelled';
        continue;
      }
      const status = await statusResponse.json().catch(() => null);
      const connected = statusResponse.ok && Array.isArray(status?.connectedAccounts)
        && status.connectedAccounts.some((account: { toolkit?: { slug?: unknown }; status?: string }) => account.toolkit?.slug === toolkit && (!account.status || account.status.toUpperCase() === 'ACTIVE'));
      if (connected) {
        await refreshPluginConnections();
        return 'connected';
      }
      if (authWindow.closed) {
        await refreshPluginConnections();
        return 'cancelled';
      }
    }
    await refreshPluginConnections();
    return 'pending';
  }

  async function connectComposioToolkit(toolkit: string) {
    clearConnectionReturnFeedback();
    if (composioConnectorState.providerHealthy === false) {
      setError(composioConnectorState.errorCode === 'COMPOSIO_RATE_LIMITED'
        ? 'Composio is rate limited. Try again later.'
        : 'Composio is temporarily unavailable. Try again later.');
      return;
    }
    if (composioConnectorState.apiKeyState === 'invalid_or_insufficient_scope' || composioConnectorState.apiKeyState === 'missing') {
      router.push(pluginSetupSettingsHref('composio', pluginReturnPath(), activeWorkspaceId));
      return;
    }

    const toolkitState = composioConnectorState.toolkitsBySlug[toolkit];
    const isConnected = Boolean(toolkitState?.connected || composioConnectorState.connectedSlugs[toolkit]);
    if (isConnected) {
      const href = pluginSetupSettingsHref('composio', pluginReturnPath(), activeWorkspaceId);
      router.push(`${href}&connected=${encodeURIComponent(toolkit)}`);
      return;
    }

    setActiveConnectorAction(`composio:${toolkit}`);
    const requestId = ++connectorFlowRequestRef.current;
    const workspaceId = activeWorkspaceId;
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
        headers: composioHeaders(true),
        body: JSON.stringify({ returnPath: pluginReturnPath() }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('connectors.connectError'));
      }
      if (requestId !== connectorFlowRequestRef.current || activeWorkspaceRef.current !== workspaceId) { authWindow.close(); return; }
      if (data.noAuth) {
        authWindow.close();
        await refreshPluginConnections();
        return;
      }
      if (data.redirectUrl) {
        authWindow.location.href = data.redirectUrl;
        const outcome = await pollComposioConnector(toolkit, authWindow, requestId, workspaceId);
        if (requestId !== connectorFlowRequestRef.current || activeWorkspaceRef.current !== workspaceId) return;
        if (outcome === 'cancelled') setError(t('connectors.connectionCancelled'));
        else if (outcome === 'pending') setError(t('connectors.connectionPending'));
      } else {
        authWindow.close();
        await loadComposioConnectorState();
      }
    } catch (connectError) {
      authWindow?.close();
      if (requestId === connectorFlowRequestRef.current) setError(connectError instanceof Error ? connectError.message : t('connectors.connectError'));
    } finally {
      if (requestId === connectorFlowRequestRef.current) setActiveConnectorAction(null);
    }
  }

  async function authorizePluginMcpServer(serverName: string) {
    if (activeConnectorAction) return;
    clearConnectionReturnFeedback();
    const requestId = ++connectorFlowRequestRef.current;
    const authorization = { controller: new AbortController(), flow: undefined as McpAuthorizationFlow | undefined };
    mcpAuthorizationRef.current = authorization;
    setActiveConnectorAction(`mcp:${serverName}`);
    setError(null);
    try {
      authorization.flow = await startMcpAuthorization(serverName);
      if (authorization.controller.signal.aborted) { await cancelMcpAuthorization(authorization.flow); return; }
      await waitForMcpAuthorization(authorization.flow, authorization.controller.signal, () => {});
      if (!authorization.controller.signal.aborted) await refreshPluginConnections();
    } catch (authorizationError) {
      if (!authorization.controller.signal.aborted) setError(authorizationError instanceof Error ? authorizationError.message : t('connectors.connectError'));
    } finally {
      if (requestId === connectorFlowRequestRef.current) {
        setActiveConnectorAction(null);
        mcpAuthorizationRef.current = null;
      }
    }
  }

  async function openPluginMcpSetup(options: {
    pluginName: string;
    version?: string;
    source: 'store' | 'installed';
    resourceId?: string;
    ownerScope?: CapabilityManagementScope;
    connector: CanvasPluginMcpConnector;
  }) {
    const workspaceId = activeWorkspaceId;
    const requestId = ++mcpSetupRequestRef.current;
    const isCurrent = () => requestId === mcpSetupRequestRef.current && activeWorkspaceRef.current === workspaceId;
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
          headers: composioHeaders(true),
          credentials: 'include',
          body: JSON.stringify({
            source: options.source,
            name: options.pluginName,
            version: options.version,
            connector: options.connector.name,
            scope: options.source === 'installed' ? options.ownerScope || managementScope : managementScope,
            resourceId: options.source === 'installed' ? options.resourceId : undefined,
            workspaceId: workspaceId || undefined,
          }),
        }),
      ]);
      if (!isCurrent()) return;

      const configPayload = await configResponse.json();
      if (!isCurrent()) return;
      if (!configResponse.ok || !configPayload.success) {
        throw new Error(configPayload.error || t('connectors.mcpLoadError'));
      }

      const rawContent = String(configPayload.data?.rawContent || '{}');
      const parsedConfig = parseMcpConfigFile(rawContent);
      const existingServer = parsedConfig.mcpServers[options.connector.name];
      const templatePayload = await templateResponse.json().catch(() => null);
      if (!isCurrent()) return;
      if (!templateResponse.ok || !templatePayload?.success) {
        throw new Error(templatePayload?.error || t('connectors.mcpLoadError'));
      }
      const templateConfig = templatePayload.template?.config;

      setMcpSetupState((current) => isCurrent() ? ({
        ...current,
        draft: existingServer
          ? toMcpServerDraft(options.connector.name, existingServer)
          : createMcpServerDraftFromConnector(options.connector, templateConfig),
        originalName: existingServer ? options.connector.name : undefined,
        rawContent,
        isLoading: false,
        error: null,
      }) : current);
    } catch (setupError) {
      if (!isCurrent()) return;
      setMcpSetupState((current) => isCurrent() ? ({
        ...current,
        isLoading: false,
        error: setupError instanceof Error ? setupError.message : t('connectors.mcpLoadError'),
      }) : current);
    }
  }

  async function savePluginMcpServer() {
    if (!mcpSetupState.connector) return;
    const workspaceId = activeWorkspaceId;
    const requestId = mcpSetupRequestRef.current;
    const isCurrent = () => requestId === mcpSetupRequestRef.current && activeWorkspaceRef.current === workspaceId;

    setMcpSetupState((current) => isCurrent() ? ({
      ...current,
      isSaving: true,
      error: null,
      errorCode: undefined,
    }) : current);

    try {
      const rawContent = updateMcpConfigRawServer(
        mcpSetupState.rawContent || '{}',
        mcpSetupState.draft,
        mcpSetupState.originalName,
      );
      const envEntries = collectMcpEnvEntries(mcpSetupState.draft);
      if (envEntries.length > 0) {
        const saveEnvResponse = await fetch('/api/integrations/env', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            scope: 'integrations',
            secretScope: 'user',
            patches: envEntries,
          }),
        });
        const saveEnvPayload = await saveEnvResponse.json().catch(() => null);
        if (!isCurrent()) return;
        if (!saveEnvResponse.ok || !saveEnvPayload?.success) {
          throw new McpAuthorizationError(
            typeof saveEnvPayload?.code === 'string' ? saveEnvPayload.code : 'request_failed',
            typeof saveEnvPayload?.error === 'string' ? saveEnvPayload.error : t('connectors.mcpSaveError'),
          );
        }
        window.dispatchEvent(new CustomEvent('canvas_secrets_updated', { detail: { secretScope: 'user' } }));
      }

      const saveMcpResponse = await fetch('/api/integrations/mcp-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ rawContent }),
      });
      const saveMcpPayload = await saveMcpResponse.json().catch(() => null);
      if (!isCurrent()) return;
      if (!saveMcpResponse.ok || !saveMcpPayload?.success) {
        throw new McpAuthorizationError(
          typeof saveMcpPayload?.code === 'string' ? saveMcpPayload.code : 'request_failed',
          typeof saveMcpPayload?.error === 'string' ? saveMcpPayload.error : t('connectors.mcpSaveError'),
        );
      }

      const storePlugin = storeByName.get(mcpSetupState.pluginName);
      if (storePlugin) {
        await checkStorePluginPreflight(storePlugin.name, storePlugin.latestVersion);
        if (!isCurrent()) return;
      }
      await loadPluginData();
      if (!isCurrent()) return;
      setMcpSetupState((current) => isCurrent() ? EMPTY_PLUGIN_MCP_SETUP_STATE : current);
    } catch (saveError) {
      if (!isCurrent()) return;
      setMcpSetupState((current) => isCurrent() ? ({
        ...current,
        isSaving: false,
        error: saveError instanceof Error ? saveError.message : t('connectors.mcpSaveError'),
        errorCode: saveError instanceof McpAuthorizationError ? saveError.code : undefined,
      }) : current);
    }
  }

  function buildConnectorSetupItems(connectors: CanvasPluginSettingsRecord['connectors']): PluginPreflightItem[] {
    const composio = getComposioRecommendations(connectors);
    const email = connectors?.email || [];
    const mcp = getMcpRecommendations(connectors);
    const composioItems: PluginPreflightItem[] = composio.map((connector) => {
      const toolkit = composioConnectorState.toolkitsBySlug[connector.toolkit];
      const configured = Boolean(composioConnectorState.configured && composioConnectorState.apiKeyValid && composioConnectorState.providerHealthy !== false);
      const degraded = composioConnectorState.providerHealthy === false;
      const needsConfiguration = composioConnectorState.apiKeyState === 'missing'
        || composioConnectorState.apiKeyState === 'invalid_or_insufficient_scope';
      const connected = Boolean(toolkit?.connected || composioConnectorState.connectedSlugs[connector.toolkit]);
      const available = configured && Boolean(toolkit);
      const statusDetail = degraded
        ? composioConnectorState.errorCode === 'COMPOSIO_RATE_LIMITED'
          ? 'Composio is rate limited. Try again later.'
          : 'Composio is temporarily unavailable. Try again later.'
        : undefined;
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
        details: [
          ...(connector.tools?.length ? [`Tools: ${connector.tools.join(', ')}`] : []),
          ...(statusDetail ? [statusDetail] : []),
        ],
        action: degraded ? 'none' : needsConfiguration ? 'configure-composio' : connected ? 'none' : 'connect-composio',
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
          className="h-8 w-full shrink-0 sm:w-auto"
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
      const authorize = Boolean(connector.oauth && item.configured && !item.ready);
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full shrink-0 sm:w-auto"
          disabled={Boolean(activeConnectorAction)}
          onClick={() => authorize ? void authorizePluginMcpServer(connector.name) : void openPluginMcpSetup({
            pluginName,
            version: source === 'store' ? options.storePlugin?.latestVersion : undefined,
            source,
            resourceId: options.installedPlugin?.resourceId,
            ownerScope: options.installedPlugin?.scopeType === 'organization' ? 'organization' : 'user',
            connector,
          })}
        >
          {activeConnectorAction === `mcp:${connector.name}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {authorize ? t('connectors.connect') : item.ready ? t('connectors.manage') : t('preflight.setup')}
        </Button>
      );
    }

    if (item.type === 'email') {
      return (
        <Button asChild variant="outline" size="sm" className="h-8 w-full shrink-0 sm:w-auto">
          <Link href={pluginSetupSettingsHref('email', pluginReturnPath(), activeWorkspaceId)}>{item.ready ? t('connectors.manage') : t('connectors.openEmail')}</Link>
        </Button>
      );
    }

    return null;
  }

  function renderConnectorSetupSkeletonRows(count: number) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: Math.max(1, count) }).map((_, index) => (
          <div key={`connector-skeleton-${index}`} className="flex flex-col gap-2 rounded-md bg-background/70 px-2 py-2 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <Skeleton className="h-7 w-7 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Skeleton className="h-4 w-28 max-w-full" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 w-20" />
                </div>
                <Skeleton className="h-3 w-full max-w-[28rem]" />
                <Skeleton className="h-3 w-3/4 max-w-[22rem]" />
              </div>
            </div>
            <div className="flex w-full justify-end sm:w-auto sm:pl-2">
              <Skeleton className="h-8 w-full sm:w-24" />
            </div>
          </div>
        ))}
      </div>
    );
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
          <p className="mb-1 text-xs">{activeWorkspaceName ? t('connectors.activeWorkspace', { name: activeWorkspaceName }) : t('connectors.noActiveWorkspace')}</p>
          {t('details.noConnectors')}
        </div>
      );
    }

    const preflight = storePlugin && selectedPluginDetail?.source !== 'installed' ? preflightByPlugin[getPreflightKey(storePlugin.name, storePlugin.latestVersion)] : undefined;
    const readiness = selectedPluginDetail?.source === 'installed' ? installedPlugin?.connectionReadiness : preflight?.result;
    const items = readiness?.items || buildConnectorSetupItems(connectors);
    const isSetupLoading = Boolean(
      !workspaceReady || (selectedPluginDetail?.source === 'installed' && isLoading) || preflight?.isLoading
      || (selectedPluginDetail?.source === 'store' && storePlugin && !preflight?.result && !preflight?.error)
      || (composioConnectorState.isLoading && getComposioRecommendations(connectors).length > 0 && !preflight?.result),
    );
    const readyCount = readiness?.summary.ready ?? items.filter((item) => item.ready).length;
    const requiredMissing = readiness?.summary.requiredMissing ?? items.filter((item) => item.required && !item.ready).length;
    const recommendedMissing = readiness?.summary.recommendedMissing ?? items.filter((item) => !item.required && !item.ready).length;
    const total = readiness?.summary.total ?? items.length;
    const hasRequiredMissing = requiredMissing > 0;

    return (
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <p className="text-xs text-muted-foreground">{activeWorkspaceName ? t('connectors.activeWorkspace', { name: activeWorkspaceName }) : t('connectors.noActiveWorkspace')}</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {hasRequiredMissing ? <Info className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {t('connectors.setupTitle')}
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            {isSetupLoading && !preflight?.result ? (
              <Skeleton className="h-5 w-full sm:w-24" />
            ) : (
              <Badge variant={hasRequiredMissing ? 'destructive' : 'secondary'} className="w-full justify-center text-[10px] sm:w-auto">
                {hasRequiredMissing ? t('preflight.needsSetup') : t('preflight.ready')}
              </Badge>
            )}
            {storePlugin || installedPlugin ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { clearConnectionReturnFeedback(); void refreshPluginConnections(); }}
                disabled={isChecking || isSetupLoading || Boolean(activeConnectorAction)}
                className="h-8 w-full gap-1.5 sm:w-auto"
              >
                {isChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {t('details.refreshCheck')}
              </Button>
            ) : null}
          </div>
        </div>
        {isSetupLoading && !preflight?.result ? (
          <Skeleton className="h-4 w-full max-w-md" />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('preflight.summary', {
              ready: readyCount,
              total,
              required: requiredMissing,
              recommended: recommendedMissing,
            })}
          </p>
        )}
        {isSetupLoading && !preflight?.result ? (
          renderConnectorSetupSkeletonRows(items.length)
        ) : null}
        {preflight?.error ? (
          <InlineNotice variant="destructive" size="compact">
            {preflight.error}
          </InlineNotice>
        ) : null}
        {!isSetupLoading || preflight?.result ? (
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
                <div className="flex w-full justify-end sm:w-auto sm:pl-2">
                  {renderConnectorSetupAction(item, { connectors, installedPlugin, storePlugin })}
                </div>
              </div>
            ))}
          </div>
        ) : null}
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

  const storeByName = new Map([...installedStorePlugins, ...storePlugins].map((plugin) => [plugin.name, plugin]));
  if (detailStorePlugin && !storeByName.has(detailStorePlugin.name)) storeByName.set(detailStorePlugin.name, detailStorePlugin);

  function storeMatchesInstalledPlugin(storePlugin: CanvasPluginStoreEntry | undefined, installedPlugin: CanvasPluginSettingsRecord | undefined): boolean {
    const stored = storePlugin?.installed.installedPlugin;
    if (!stored || !installedPlugin) return false;
    if ((stored.scopeType === 'organization') !== (installedPlugin.scopeType === 'organization')) return false;
    if (stored.resourceId && installedPlugin.resourceId) return stored.resourceId === installedPlugin.resourceId;
    if (stored.scopeType === 'organization' || installedPlugin.scopeType === 'organization') return false;
    return managementScope === 'user' && stored.name === installedPlugin.name && !isAssignedOrganizationPlugin(installedPlugin);
  }

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

  function openStorePluginDetail(plugin: CanvasPluginStoreEntry) {
    navigate({ plugin: plugin.name, source: 'store', resourceId: undefined, workspaceId: activeWorkspaceId || undefined });
  }

  function openInstalledPluginDetail(plugin: CanvasPluginSettingsRecord) {
    navigate({
      source: 'installed',
      plugin: plugin.name,
      resourceId: plugin.resourceId,
      workspaceId: activeWorkspaceId || undefined,
    });
  }

  function renderPluginDetailIcon(
    storePlugin: CanvasPluginStoreEntry | undefined,
    installedPlugin: CanvasPluginSettingsRecord | undefined,
  ) {
    if (selectedPluginDetail?.source !== 'installed' && storePlugin) return renderStoreIcon(storePlugin);
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
    const installedPlugin = selectedPluginDetail.source === 'installed' ? selectedInstalledPlugin : storePlugin?.installed.installedPlugin;
    const isInstalledDetail = selectedPluginDetail.source === 'installed';
    const displayName = isInstalledDetail
      ? installedPlugin?.interface?.displayName || installedPlugin?.name || selectedPluginDetail.name
      : storePlugin?.displayName || selectedPluginDetail.name;
    const description = (isInstalledDetail
      ? installedPlugin?.interface?.shortDescription || installedPlugin?.description
      : storePlugin?.description) || t('details.descriptionFallback');
    const category = isInstalledDetail ? installedPlugin?.interface?.category : storePlugin?.category;
    const publisherName = storePlugin?.publisher?.name || storeMetadata?.name || t('officialStore');
    const connectors = selectedPluginDetail.source === 'installed' ? installedPlugin?.connectors : storePlugin?.connectors;
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
    const isInstalled = Boolean(installedPlugin || (selectedPluginDetail.source === 'store' && storePlugin?.installed.installed));
    const installedEnabled = Boolean(installedPlugin?.enabled ?? storePlugin?.installed.enabled);
    const installedMetadataMatches = selectedPluginDetail.source === 'store' || storeMatchesInstalledPlugin(storePlugin, installedPlugin);
    const updateAvailable = Boolean(installedMetadataMatches && storePlugin?.installed.updateAvailable);
    const isPending = pendingPluginName === selectedPluginDetail.name || pendingPluginName === `store:${selectedPluginDetail.name}`;
    const preflight = storePlugin ? preflightByPlugin[getPreflightKey(storePlugin.name, storePlugin.latestVersion)] : undefined;
    const isChecking = Boolean(preflight?.isLoading || !workspaceReady || isDetailStoreLoading || (selectedPluginDetail.source === 'installed' && isLoading));
    const readinessUnchecked = Boolean(storePlugin && hasConnectorRecommendations(storePlugin.connectors) && !preflight?.result);
    const pluginMissing = selectedPluginDetail.source === 'installed' ? !installedPlugin && !isLoading && !pluginsLoadFailed && workspaceReady : !storePlugin && !isDetailStoreLoading && !detailStoreError;
    const skillSummary = installedMetadataMatches ? preflight?.result?.skillSummary || storePlugin?.installed.skillSummary : undefined;
    const skillStates = installedMetadataMatches ? preflight?.result?.skills || storePlugin?.installed.skills || [] : [];
    const skillRepairAvailable = Boolean(isInstalled && skillSummary && skillSummary.repairable > 0);
    const canInstallFromStore = Boolean(storePlugin && !pluginMissing && (!isInstalled || updateAvailable || skillRepairAvailable));
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
          if (!open) navigate({ plugin: undefined, source: undefined, resourceId: undefined });
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
              {displayedError ? <InlineNotice variant="destructive" size="compact">{displayedError}</InlineNotice> : null}
              {detailStoreError ? <InlineNotice variant="destructive" size="compact">{detailStoreError}</InlineNotice> : null}
              {pluginMissing ? <InlineNotice size="compact">{t('details.notFound')}</InlineNotice> : null}
              {installedPlugin?.connectionReadiness?.ready === false ? <InlineNotice size="compact">{t('details.installedNeedsSetup')}</InlineNotice> : null}
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
                {installedPlugin ? (
                  <>
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('details.ownership')}</div>
                      <div className="mt-1">{installedPlugin.scopeType === 'organization' ? t('organizationScope') : installedPlugin.scopeType === 'user' ? t('personalScope') : installedPlugin.scopeType === 'system' ? t('permissions.systemScope') : t('permissions.unknownScope')}</div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('details.installedBy')}</div>
                      <div className="mt-1 break-all">{installedPlugin.installedBy?.trim() || t('details.installedByUnknown')}</div>
                    </div>
                  </>
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

          <div className="flex shrink-0 flex-col gap-3 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            {installedPlugin ? (
              <div className="min-w-0 flex-1 space-y-1">
                <label className="flex w-full items-center gap-2 text-sm text-muted-foreground sm:w-auto">
                  <Switch
                    checked={installedEnabled}
                    disabled={isPending || !workspaceReady || isPluginPreferenceLocked(installedPlugin)}
                    onCheckedChange={(checked) => void setPluginEnabled(installedPlugin, checked)}
                    aria-label={t('toggle', { name: installedPlugin.name })}
                  />
                  {isAssignedOrganizationPlugin(installedPlugin) ? t('permissions.personalActivationLabel') : t('permissions.packageActivation')}
                </label>
                <p className="text-xs text-muted-foreground">{pluginActivationGuidance(installedPlugin)}</p>
              </div>
            ) : (
              <div className="space-y-1 text-sm text-muted-foreground">
                <span>{t('details.notInstalled')}</span>
                {!canManagePackages ? <p className="text-xs">{t('permissions.askAdmin')}</p> : null}
              </div>
            )}
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              {installedPlugin && !isAssignedOrganizationPlugin(installedPlugin) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPending || !canManagePackages || !workspaceReady}
                  onClick={() => void deletePlugin(installedPlugin)}
                  className="w-full gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto"
                >
                  {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {t('delete')}
                </Button>
              ) : null}
              {storePlugin && (!installedPlugin || !isAssignedOrganizationPlugin(installedPlugin)) ? (
                <Button
                  variant={canInstallFromStore ? 'default' : 'outline'}
                  size="sm"
                  disabled={!canManagePackages || isPending || isChecking || readinessUnchecked || preflightBlocksPluginWrite(preflight) || Boolean(activeConnectorAction) || !canInstallFromStore}
                  onClick={() => void installStorePlugin(storePlugin.name, storePlugin.latestVersion)}
                  className="w-full gap-1.5 sm:w-auto"
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

  function renderPluginCardSkeletons(count = 4) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: count }).map((_, index) => (
          <div key={`plugin-card-skeleton-${index}`} className="rounded-lg border bg-background p-4">
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className="h-4 w-36 max-w-full" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-14" />
                </div>
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-24" />
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-8 w-full sm:w-28" />
            </div>
          </div>
        ))}
      </div>
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
        <div className="mt-4 flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="min-w-0 text-xs text-muted-foreground">
            {plugin.publisher?.name || storeMetadata?.name || t('officialStore')}
          </span>
          <Button
            variant={updateAvailable || !isInstalled || skillRepairAvailable ? 'default' : 'outline'}
            size="sm"
            disabled={!canManagePackages || isPending || isChecking || preflightBlocksPluginWrite(preflightState) || Boolean(activeConnectorAction) || (isInstalled && !updateAvailable && !skillRepairAvailable)}
            onClick={(event) => {
              event.stopPropagation();
              if (needsPreflight) {
                openStorePluginDetail(plugin);
                return;
              }
              void installStorePlugin(plugin.name, plugin.latestVersion);
            }}
            className="w-full gap-1.5 sm:w-auto"
          >
            {isPending || isChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : buttonIcon}
            {buttonLabel}
          </Button>
        </div>
        {!canManagePackages ? <p className="mt-2 text-xs text-muted-foreground">{t('permissions.askAdmin')}</p> : null}
      </div>
    );
  }

  function renderInstalledPluginCard(plugin: CanvasPluginSettingsRecord) {
    const displayName = plugin.interface?.displayName || plugin.name;
    const description = plugin.interface?.shortDescription || plugin.description;
    const isPending = pendingPluginName === plugin.name || pendingPluginName === `store:${plugin.name}`;
    const storePlugin = storeByName.get(plugin.name);
    const installedMetadataMatches = storeMatchesInstalledPlugin(storePlugin, plugin);
    const updateAvailable = Boolean(installedMetadataMatches && storePlugin?.installed.updateAvailable);
    const skillRepairAvailable = Boolean(installedMetadataMatches && storePlugin?.installed.skillSummary && storePlugin.installed.skillSummary.repairable > 0);
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
        key={plugin.resourceId || `${plugin.scopeType || 'legacy'}:${plugin.name}`}
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
              {plugin.scopeType === 'organization' || plugin.scopeType === 'user' ? (
                <Badge variant="outline" className="text-[10px]">
                  {plugin.scopeType === 'organization' ? t('organizationScope') : t('personalScope')}
                </Badge>
              ) : null}
              {plugin.readiness && plugin.readiness !== 'available' && plugin.readiness !== 'disabled' ? (
                <Badge
                  variant={plugin.readiness === 'blocked' || plugin.readiness === 'conflict' ? 'destructive' : 'secondary'}
                  className="text-[10px]"
                >
                  {t(`readiness.${plugin.readiness}`)}
                </Badge>
              ) : null}
              {updateAvailable ? <Badge variant="destructive" className="text-[10px]">{t('updateAvailable')}</Badge> : null}
              {skillRepairAvailable ? <Badge variant="destructive" className="text-[10px]">{t('repairNeeded')}</Badge> : null}
              {plugin.license ? <Badge variant="outline" className="text-[10px]">{plugin.license}</Badge> : null}
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">/{plugin.name}</div>
            <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{description}</p>
            {plugin.readiness && plugin.readiness !== 'available' && plugin.readiness !== 'disabled' ? (
              <p className="mt-2 text-xs text-muted-foreground">{t(`readinessHints.${plugin.readiness}`)}</p>
            ) : isAssignedOrganizationPlugin(plugin) && plugin.effectivePolicy === 'required' ? (
              <p className="mt-2 text-xs text-muted-foreground">{t('requiredHint')}</p>
            ) : null}
            {plugin.blockedReason ? (
              <p className="mt-2 line-clamp-2 text-xs text-destructive">{plugin.blockedReason}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {plugin.skills.map((skill) => (
                <Badge key={skill.name} variant="secondary" className="max-w-full text-[10px]">
                  <span className="truncate">/{skill.name}</span>
                </Badge>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <label
              className="flex items-center gap-2 text-sm text-muted-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              <Switch
                checked={plugin.enabled}
                disabled={isPending || !workspaceReady || isPluginPreferenceLocked(plugin)}
                onClick={(event) => event.stopPropagation()}
                onCheckedChange={(checked) => void setPluginEnabled(plugin, checked)}
                aria-label={t('toggle', { name: plugin.name })}
              />
              {isAssignedOrganizationPlugin(plugin) ? t('permissions.personalActivationLabel') : t('permissions.packageActivation')}
            </label>
            <p className="text-xs text-muted-foreground">{pluginActivationGuidance(plugin)}</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            {plugin.readiness === 'personal-connection-required' ? (
              <Button variant="outline" size="sm" className="w-full gap-1.5 sm:w-auto" onClick={(event) => { event.stopPropagation(); openInstalledPluginDetail(plugin); }}>
                <Plug className="h-3.5 w-3.5" />{t('preflight.setup')}
              </Button>
            ) : null}
            {!isAssignedOrganizationPlugin(plugin) && (updateAvailable || skillRepairAvailable) ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canManagePackages || isPending || preflightBlocksPluginWrite(updatePreflightState) || Boolean(activeConnectorAction)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (updateNeedsPreflight) {
                    openInstalledPluginDetail(plugin);
                    return;
                  }
                  void installStorePlugin(plugin.name, storePlugin?.latestVersion);
                }}
                className="w-full gap-1.5 sm:w-auto"
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
            {!isAssignedOrganizationPlugin(plugin) ? <Button
              variant="ghost"
              size="sm"
              disabled={!canManagePackages || isPending || !workspaceReady}
              onClick={(event) => {
                event.stopPropagation();
                void deletePlugin(plugin);
              }}
              className="w-full gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto"
            >
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {t('delete')}
            </Button> : null}
          </div>
        </div>
      </div>
    );
  }

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;
  const filteredInstalledPlugins = plugins.filter((plugin) => {
    const readiness = plugin.readiness || (!plugin.enabled ? 'disabled' : plugin.connectionReadiness?.ready === false ? 'personal-connection-required' : 'available');
    return matchesSearch(plugin)
      && (!navigation.readiness || readiness === navigation.readiness)
      && (!navigation.enabled || plugin.enabled === (navigation.enabled === 'enabled'));
  });
  const updatePlugins = storeTab === 'updates' ? storePlugins : [];
  const hasListFilters = Boolean(searchQuery.trim() || categoryFilter || connectionFilter || (storeTab === 'installed' && (navigation.readiness || navigation.enabled)));
  const clearListFilters = () => navigate({ q: undefined, category: undefined, connection: undefined, readiness: undefined, enabled: undefined, page: undefined });

  function renderEmptyPluginList(message: string, browse = false) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
        <p>{message}</p>
        {hasListFilters ? <Button variant="outline" size="sm" onClick={clearListFilters}>{t('filters.clear')}</Button>
          : browse ? <Button variant="outline" size="sm" onClick={() => navigate({ view: 'discover' })}>{t('browse')}</Button> : null}
      </div>
    );
  }

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
            disabled={isStoreLoading || !storePagination.hasPreviousPage}
            onClick={() => navigate({ page: Math.max(1, storePagination.page - 1) })}
            className="h-8 gap-1.5"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('pagination.previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isStoreLoading || !storePagination.hasNextPage}
            onClick={() => navigate({ page: storePagination.page + 1 })}
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
          onChange={(event) => navigate({ q: event.target.value || undefined })}
          aria-label={t('searchPlaceholder')}
          maxLength={512}
          placeholder={t('searchPlaceholder')}
          className="pl-9"
        />
      </div>

      {storeTab !== 'advanced' ? (
        <div className="flex flex-wrap items-end gap-3">
          {storeTab === 'installed' ? <>
            <label className="grid min-w-0 flex-1 gap-1 text-xs text-muted-foreground">
              {t('filters.readiness')}
              <select aria-label={t('filters.readiness')} value={navigation.readiness || ''} onChange={(event) => navigate({ readiness: (event.target.value || undefined) as PluginNavigation['readiness'] })} className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground">
                <option value="">{t('filters.allReadiness')}</option>
                {PLUGIN_READINESS_FILTERS.map((value) => <option key={value} value={value}>{t(`readiness.${value}`)}</option>)}
              </select>
            </label>
            <label className="grid min-w-0 flex-1 gap-1 text-xs text-muted-foreground">
              {t('filters.enabled')}
              <select aria-label={t('filters.enabled')} value={navigation.enabled || ''} onChange={(event) => navigate({ enabled: (event.target.value || undefined) as PluginNavigation['enabled'] })} className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground">
                <option value="">{t('filters.allEnabled')}</option>
                <option value="enabled">{t('enabled')}</option><option value="disabled">{t('disabled')}</option>
              </select>
            </label>
          </> : <>
            <label className="grid min-w-0 flex-1 gap-1 text-xs text-muted-foreground">
              {t('filters.category')}
              <select aria-label={t('filters.category')} value={categoryFilter || ''} onChange={(event) => navigate({ category: event.target.value || undefined })} className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground">
                <option value="">{t('filters.allCategories')}</option>
                {[...new Set([...storeFacets.categories, ...(categoryFilter ? [categoryFilter] : [])])].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="grid min-w-0 flex-1 gap-1 text-xs text-muted-foreground">
              {t('filters.connection')}
              <select aria-label={t('filters.connection')} value={connectionFilter || ''} onChange={(event) => navigate({ connection: (event.target.value || undefined) as PluginNavigation['connection'] })} className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground">
                <option value="">{t('filters.allConnections')}</option>
                {PLUGIN_CONNECTION_FILTERS.map((value) => <option key={value} value={value}>{t(`filters.connectionTypes.${value}`)}</option>)}
              </select>
            </label>
          </>}
          {hasListFilters ? <Button variant="ghost" size="sm" onClick={clearListFilters} className="shrink-0">{t('filters.clear')}</Button> : null}
        </div>
      ) : null}

      {displayedError && !selectedPluginDetail ? (
        <InlineNotice variant="destructive" size="compact">
          {displayedError}
        </InlineNotice>
      ) : null}

      {storeError ? (
        <InlineNotice variant="warning" size="compact">
          {storeError}
        </InlineNotice>
      ) : null}

      <Tabs
        value={storeTab}
        onValueChange={(value) => {
          if (value === 'discover' || value === 'installed' || value === 'updates' || value === 'advanced') {
            navigate({ view: value });
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
          {isStoreLoading ? (
            renderPluginCardSkeletons()
          ) : storeError ? null : storePlugins.length === 0 ? (
            renderEmptyPluginList(t(hasListFilters ? 'noMatches' : 'emptyStore'))
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
            renderPluginCardSkeletons()
          ) : pluginsLoadFailed ? null : filteredInstalledPlugins.length === 0 ? (
            renderEmptyPluginList(t(plugins.length ? 'noMatches' : 'empty'), !plugins.length)
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filteredInstalledPlugins.map((plugin) => renderInstalledPluginCard(plugin))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="updates" className="space-y-3">
          {isStoreLoading ? (
            renderPluginCardSkeletons()
          ) : storeError ? null : updatePlugins.length === 0 ? (
            renderEmptyPluginList(t(hasListFilters ? 'noMatches' : 'noUpdates'))
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
                disabled={!canManagePackages || isInstalling || !workspaceReady}
              />
              <Button onClick={() => void installLocalPlugin()} disabled={!canManagePackages || !workspaceReady || isInstalling || !sourcePath.trim()} className="gap-1.5">
                {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {t('install')}
              </Button>
            </div>
            {!canManagePackages ? <p className="mt-2 text-xs text-muted-foreground">{t('permissions.askAdmin')}</p> : null}
          </div>
          </TabsContent>
        </Tabs>

      {renderPluginDetailsDialog()}
      <McpServerDialog
        open={mcpSetupState.open}
        onOpenChange={(open) => {
          if (!open) {
            mcpSetupRequestRef.current += 1;
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
        errorCode={mcpSetupState.errorCode}
      />
    </section>
  );
}

function OrganizationCapabilityPolicyPanel() {
  const t = useTranslations('skills.scope.policy');
  const workspaceTypesT = useTranslations('workspaces.types');
  const [capabilities, setCapabilities] = useState<EffectiveCapabilitySummary[]>([]);
  const [policies, setPolicies] = useState<CapabilityPolicyRecord[]>([]);
  const [targets, setTargets] = useState<OrganizationPolicyTargetCatalog>(EMPTY_POLICY_TARGETS);
  const [organizationId, setOrganizationId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [targetType, setTargetType] = useState<CapabilityPolicyTargetType>('organization');
  const [targetId, setTargetId] = useState('');
  const [effect, setEffect] = useState<CapabilityPolicyEffect>('optional');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const [effectiveResponse, policiesResponse] = await Promise.all([
        fetch('/api/skills/effective', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/skills/policies', { credentials: 'include', cache: 'no-store' }),
      ]);
      const [effectivePayload, policiesPayload] = await Promise.all([
        effectiveResponse.json(),
        policiesResponse.json(),
      ]);
      if (!effectivePayload.success) throw new Error(effectivePayload.error || t('errors.load'));
      if (!policiesPayload.success) throw new Error(policiesPayload.error || t('errors.load'));
      const organizationCapabilities = (effectivePayload.snapshot?.capabilities || [])
        .filter((entry: EffectiveCapabilitySummary) => entry.ref?.scopeType === 'organization');
      setCapabilities(organizationCapabilities);
      setPolicies(Array.isArray(policiesPayload.policies) ? policiesPayload.policies : []);
      setTargets(policiesPayload.targets || EMPTY_POLICY_TARGETS);
      const nextOrganizationId = effectivePayload.snapshot?.organizationId || '';
      setOrganizationId(nextOrganizationId);
      setTargetId((current) => current || nextOrganizationId);
      setResourceId((current) => current || organizationCapabilities[0]?.ref.resourceId || '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setPending(false);
    }
  }, [t]);

  const roleLabel = useCallback((role: string) => {
    if (role === 'owner') return t('roles.owner');
    if (role === 'admin') return t('roles.admin');
    if (role === 'external') return t('roles.external');
    return t('roles.member');
  }, [t]);

  const workspaceTypeLabel = useCallback((type: string) => {
    if (type === 'organization') return workspaceTypesT('organization');
    if (type === 'team') return workspaceTypesT('team');
    if (type === 'project') return workspaceTypesT('project');
    return workspaceTypesT('personal');
  }, [workspaceTypesT]);

  const targetOptions = useMemo<PolicyTargetOption[]>(() => {
    if (targetType === 'role') {
      return ['member', 'admin', 'owner', 'external'].map((role) => ({
        id: role,
        label: roleLabel(role),
        description: null,
      }));
    }
    if (targetType === 'user') {
      return targets.users.map((user) => {
        const name = user.name?.trim();
        const email = user.email?.trim();
        const label = name || email || user.userId;
        const description = [
          email && email !== label ? email : null,
          roleLabel(user.role),
        ].filter((value): value is string => Boolean(value)).join(' · ');
        return {
          id: user.userId,
          label,
          description: description || null,
        };
      });
    }
    if (targetType === 'workspace') {
      return targets.workspaces.map((workspace) => ({
        id: workspace.workspaceId,
        label: workspace.name,
        description: workspaceTypeLabel(workspace.type),
      }));
    }
    if (targetType === 'project') {
      return targets.projects.map((project) => ({
        id: project.projectId,
        label: project.name,
        description: t('projectDescription'),
      }));
    }
    return [];
  }, [roleLabel, t, targetType, targets.projects, targets.users, targets.workspaces, workspaceTypeLabel]);

  const optionByPolicyTarget = useMemo(() => {
    const entries: Array<[string, PolicyTargetOption]> = [];
    for (const role of ['member', 'admin', 'owner', 'external']) {
      entries.push([`role:${role}`, { id: role, label: roleLabel(role), description: null }]);
    }
    for (const user of targets.users) {
      const name = user.name?.trim();
      const email = user.email?.trim();
      const label = name || email || user.userId;
      entries.push([`user:${user.userId}`, {
        id: user.userId,
        label,
        description: email && email !== label ? email : roleLabel(user.role),
      }]);
    }
    for (const workspace of targets.workspaces) {
      entries.push([`workspace:${workspace.workspaceId}`, {
        id: workspace.workspaceId,
        label: workspace.name,
        description: workspaceTypeLabel(workspace.type),
      }]);
    }
    for (const project of targets.projects) {
      entries.push([`project:${project.projectId}`, {
        id: project.projectId,
        label: project.name,
        description: t('projectDescription'),
      }]);
    }
    return new Map(entries);
  }, [roleLabel, t, targets.projects, targets.users, targets.workspaces, workspaceTypeLabel]);

  useEffect(() => {
    startTransition(() => {
      void load();
    });
  }, [load]);

  async function savePolicy() {
    if (!resourceId || !targetId.trim()) return;
    const capability = capabilities.find((entry) => entry.ref.resourceId === resourceId);
    if (!capability) return;
    const existing = policies.find((policy) => (
      policy.resourceId === resourceId
      && policy.targetType === targetType
      && policy.targetId === targetId.trim()
    ));
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/skills/policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceType: capability.ref.resourceType,
          resourceId,
          targetType,
          targetId: targetId.trim(),
          effect,
          expectedRevision: existing?.revision || 0,
        }),
      });
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || t('errors.save'));
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setPending(false);
    }
  }

  async function removePolicy(policy: CapabilityPolicyRecord) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/skills/policies', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyId: policy.id, expectedRevision: policy.revision }),
      });
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || t('errors.remove'));
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t('errors.remove'));
    } finally {
      setPending(false);
    }
  }

  function handleTargetTypeChange(nextTargetType: CapabilityPolicyTargetType) {
    setTargetType(nextTargetType);
    setTargetId(nextTargetType === 'organization' ? organizationId : '');
  }

  return (
    <Card data-testid="organization-capability-policies">
      <CardContent className="space-y-4 p-4">
        <div>
          <h3 className="text-sm font-semibold">{t('title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        {error ? (
          <InlineNotice variant="destructive" size="compact">
            {error}
          </InlineNotice>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(9rem,.7fr)_minmax(0,1fr)_minmax(10rem,.8fr)_auto]">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('resource')}</span>
            <select
              value={resourceId}
              onChange={(event) => setResourceId(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground"
              disabled={pending || capabilities.length === 0}
            >
              {capabilities.map((capability) => (
                <option key={capability.ref.resourceId} value={capability.ref.resourceId}>
                  {capability.ref.resourceType}: {capability.ref.name} · v{capability.ref.version}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('targetType')}</span>
            <select
              value={targetType}
              onChange={(event) => handleTargetTypeChange(event.target.value as CapabilityPolicyTargetType)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground"
              disabled={pending}
            >
              {(['organization', 'role', 'workspace', 'project', 'user'] as const).map((value) => (
                <option key={value} value={value}>{t(`targets.${value}`)}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('targetId')}</span>
            {targetType === 'organization' ? (
              <>
                <Input
                  value={organizationId}
                  disabled
                  title={t('organizationHint')}
                  className="font-mono text-xs"
                />
                <span className="block text-[11px] text-muted-foreground">{t('organizationHint')}</span>
              </>
            ) : (
              <SearchablePolicyTargetPicker
                id="capability-policy-target"
                value={targetId}
                options={targetOptions}
                label={t(`pickerLabels.${targetType}`)}
                placeholder={t(`select.${targetType}`)}
                searchPlaceholder={t(`search.${targetType}`)}
                emptyLabel={t(`emptyTargets.${targetType}`)}
                disabled={pending}
                testId={`capability-policy-target-${targetType}-picker`}
                onValueChange={setTargetId}
              />
            )}
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('effect')}</span>
            <select
              value={effect}
              onChange={(event) => setEffect(event.target.value as CapabilityPolicyEffect)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground"
              disabled={pending}
            >
              {(['optional', 'default-enabled', 'required', 'blocked'] as const).map((value) => (
                <option key={value} value={value}>{t(`effects.${value}`)}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <Button onClick={() => void savePolicy()} disabled={pending || !resourceId || !targetId.trim()}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {policies.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('empty')}</p>
          ) : policies.map((policy) => {
            const capability = capabilities.find((entry) => entry.ref.resourceId === policy.resourceId);
            const option = optionByPolicyTarget.get(`${policy.targetType}:${policy.targetId}`);
            const targetLabel = policy.targetType === 'organization'
              ? t('organizationValue')
              : option?.label || policy.targetId;
            return (
              <div key={policy.id} className="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 text-xs">
                  <span className="font-medium">{capability?.ref.name || policy.resourceId}</span>
                  <span className="text-muted-foreground"> · {t(`targets.${policy.targetType}`)}: </span>
                  <span className="font-medium">{targetLabel}</span>
                  {option?.description ? (
                    <span className="mt-1 block truncate text-muted-foreground">{option.description}</span>
                  ) : null}
                  {targetLabel !== policy.targetId ? (
                    <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground/80">{policy.targetId}</span>
                  ) : null}
                </div>
                <Badge variant={policy.effect === 'blocked' ? 'destructive' : policy.effect === 'required' ? 'default' : 'secondary'}>
                  {t(`effects.${policy.effect}`)}
                </Badge>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => void removePolicy(policy)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t('remove')}
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function SkillsPanel({ canManageOrganizationCapabilities: initialCanManageOrganization = false }: { canManageOrganizationCapabilities?: boolean } = {}) {
  const t = useTranslations('skills');
  const { navigation, navigate } = usePluginNavigation();
  const [canManageOrganizationCapabilities, setCanManageOrganizationCapabilities] = useState(initialCanManageOrganization);
  const managementScope: CapabilityManagementScope = navigation.scope === 'organization' && canManageOrganizationCapabilities ? 'organization' : 'user';
  const [skills, setSkills] = useState<CanvasSkill[]>([]);
  const [stats, setStats] = useState({ total: 0, enabled: 0, disabled: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [skillTreeLoading, setSkillTreeLoading] = useState(true);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [pluginsRevision, setPluginsRevision] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<CanvasSkill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [resetSkillsOpen, setResetSkillsOpen] = useState(false);
  const [resetSkillsConfirm, setResetSkillsConfirm] = useState('');
  const panelTab: SkillsPanelTab = navigation.area;
  const skillLibraryTab = (panelTab === 'skills' ? navigation.view : 'installed') as SkillLibraryTab;
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
  const skillsRequestRef = useRef(0);
  const skillTreeRequestRef = useRef(0);
  const skillStoreRequestRef = useRef(0);

  const changeManagementScope = useCallback((scope: CapabilityManagementScope) => {
    if (scope === managementScope) return;
    skillsRequestRef.current += 1;
    skillTreeRequestRef.current += 1;
    setSkillTree([]);
    setExpandedDirs(new Set());
    setSelectedSkill(null);
    setSelectedPath(null);
    setRightView('info');
    navigate({ scope });
  }, [managementScope, navigate]);

  async function loadSkills() {
    const requestId = ++skillsRequestRef.current;
    const requestedScope = managementScope;
    try {
      setIsLoading(true);
      setSkillsError(null);
      const [skillsRes, statusRes] = await Promise.all([
        fetch(capabilityScopeUrl('/api/skills', requestedScope)),
        fetch('/api/skills/status'),
      ]);
      const skillsData = await skillsRes.json();
      const statusData = await statusRes.json();
      if (requestId !== skillsRequestRef.current) return;
      if (!skillsRes.ok || !skillsData.success || !statusRes.ok || !statusData.success) throw new Error(skillsData.error || t('loading.error'));

      if (skillsData.success) {
        const canManageOrganization = skillsData.canManageOrganizationCapabilities === true;
        setCanManageOrganizationCapabilities(canManageOrganization);
        if (!canManageOrganization && requestedScope === 'organization') {
          changeManagementScope('user');
          return;
        }
        const allSkills: CanvasSkill[] = skillsData.skills;
        const enabledNames: string[] = statusData.success ? (statusData.enabledSkills || []) : [];
        const allEnabled = statusData.success && statusData.allEnabled === true;

        const merged = requestedScope === 'organization' || allSkills.some((skill) => Boolean(skill.resourceId))
          ? allSkills
          : allSkills.map((skill: CanvasSkill) => ({
            ...skill,
            enabled: Boolean(skill.core) || allEnabled || enabledNames.includes(skill.name),
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
      if (requestId === skillsRequestRef.current) setSkillsError(error instanceof Error ? error.message : t('loading.error'));
    } finally {
      if (requestId === skillsRequestRef.current) setIsLoading(false);
    }
  }

  async function loadSkillTree() {
    const requestId = ++skillTreeRequestRef.current;
    const requestedScope = managementScope;
    setSkillTreeLoading(true);
    try {
      const res = await fetch(capabilityScopeUrl('/api/skills/tree?depth=4', requestedScope));
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || t('loading.error'));
      if (requestId === skillTreeRequestRef.current && data.success) {
        setSkillTree(data.data || []);
      }
    } catch (error) {
      if (requestId === skillTreeRequestRef.current) setSkillsError(error instanceof Error ? error.message : t('loading.error'));
    } finally {
      if (requestId === skillTreeRequestRef.current) setSkillTreeLoading(false);
    }
  }

  const loadSkillStore = useCallback(async () => {
    const requestId = ++skillStoreRequestRef.current;
    const storeState = skillLibraryTab === 'updates' ? 'updates' : 'all';
    const params = new URLSearchParams({
      page: String(skillStorePage),
      pageSize: String(SKILL_STORE_PAGE_SIZE),
      q: deferredSkillStoreQuery.trim(),
      state: storeState,
      scope: managementScope,
    });

    setSkillStoreLoading(true);
    setSkillStoreError(null);
    try {
      const response = await fetch(`/api/skills/store?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await response.json();
      if (requestId !== skillStoreRequestRef.current) return;
      if (!response.ok || !data.success) {
        throw new Error(data.error || t('skillLibrary.errors.storeLoad'));
      }
      setSkillStoreSkills(Array.isArray(data.skills) ? data.skills : []);
      setSkillStoreMetadata(data.registry || null);
      setSkillStorePagination(data.pagination || EMPTY_SKILL_STORE_PAGINATION);
      setSkillStoreStats(data.stats || EMPTY_SKILL_STORE_STATS);
    } catch (error) {
      if (requestId !== skillStoreRequestRef.current) return;
      setSkillStoreSkills([]);
      setSkillStoreMetadata(null);
      setSkillStorePagination(EMPTY_SKILL_STORE_PAGINATION);
      setSkillStoreStats(EMPTY_SKILL_STORE_STATS);
      setSkillStoreError(error instanceof Error ? error.message : t('skillLibrary.errors.storeLoad'));
    } finally {
      if (requestId === skillStoreRequestRef.current) setSkillStoreLoading(false);
    }
  }, [deferredSkillStoreQuery, managementScope, skillLibraryTab, skillStorePage, t]);

  useEffect(() => {
    if (panelTab !== 'skills') return;
    startTransition(() => {
      loadSkills();
      loadSkillTree();
    });
    return () => { skillsRequestRef.current += 1; skillTreeRequestRef.current += 1; };
    // Skill data is loaded only while the skill area is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managementScope, panelTab, pluginsRevision]);

  useEffect(() => {
    if (panelTab === 'skills' && (skillLibraryTab === 'library' || skillLibraryTab === 'updates')) {
      startTransition(() => {
        void loadSkillStore();
      });
    }
    return () => { skillStoreRequestRef.current += 1; };
  }, [loadSkillStore, skillLibraryTab, panelTab]);

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

  const handleSkillClick = useCallback((node: SkillFileNode) => {
    const skillName = node.skillName || node.name;
    const namedSkills = skills.filter((skill) => skill.name === skillName);
    const skill = (node.resourceId
      ? namedSkills.find((entry) => entry.resourceId === node.resourceId)
      : null)
      || namedSkills.find((entry) => entry.scopeType === 'user')
      || namedSkills.find((entry) => entry.scopeType === 'system')
      || namedSkills.find((entry) => entry.scopeType !== 'organization')
      || namedSkills[0];
    if (skill) {
      setSelectedSkill(skill);
      setRightView('info');
      setSelectedPath(node.path);
    }
  }, [skills]);

  const handleFileClick = useCallback(async (node: SkillFileNode) => {
    setSelectedPath(node.path);
    setRightView('preview');
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const params = new URLSearchParams({
        path: node.relativePath ?? node.path,
        scope: managementScope,
      });
      if (node.resourceId) params.set('resourceId', node.resourceId);
      const res = await fetch(`/api/skills/file?${params.toString()}`);
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
  }, [managementScope]);

  async function toggleSkill(skill: CanvasSkill, enabled: boolean) {
    if (skill.core && !enabled) {
      setSkillActionError(t('detail.coreProtected'));
      return;
    }

    try {
      const response = managementScope === 'user' && skill.scopeType === 'organization' && skill.resourceId
        ? await fetch('/api/skills/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: skill.resourceId, enabled }),
        })
        : await fetch(
          enabled ? `/api/skills/${encodeURIComponent(skill.name)}/enable` : `/api/skills/${encodeURIComponent(skill.name)}/disable`,
          { method: 'POST' },
        );
      const data = await response.json();

      if (data.success) {
        await loadSkills();
      } else {
        setSkillActionError(data.error || t('plugins.errors.toggle'));
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
        await loadSkills();
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
        await loadSkills();
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
        body: JSON.stringify({ name: skillName, version, enable: true, replace: true, scope: managementScope }),
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
        body: JSON.stringify({ prefer, enable: true, scope: managementScope }),
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
      const response = await fetch(capabilityScopeUrl(`/api/skills/${encodeURIComponent(skillName)}/delete`, managementScope), { method: 'DELETE' });
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
        body: JSON.stringify({ confirm: resetSkillsConfirm, scope: managementScope }),
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
      const namedSkills = isSkillDir ? skills.filter((entry) => entry.name === node.name) : [];
      const skill = (node.resourceId
        ? namedSkills.find((entry) => entry.resourceId === node.resourceId)
        : null)
        || namedSkills.find((entry) => entry.scopeType === 'user')
        || namedSkills.find((entry) => entry.scopeType === 'system')
        || namedSkills.find((entry) => entry.scopeType !== 'organization')
        || namedSkills[0]
        || null;
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
                  handleSkillClick(node);
                }
                toggleDirectory(node.path);
              } else {
                handleFileClick(node);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (node.type === 'directory') {
                  if (isSkillDir && skill) handleSkillClick(node);
                  toggleDirectory(node.path);
                } else {
                  handleFileClick(node);
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
                disabled={
                  skill.core
                  || managementScope === 'organization'
                  || skill.effectivePolicy === 'required'
                  || skill.readiness === 'blocked'
                  || skill.readiness === 'conflict'
                }
                onCheckedChange={(checked) => {
                  void toggleSkill(skill, checked);
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

  const selectedSkillData = selectedPath
    ? (selectedSkill?.resourceId
      ? skills.find((skill) => skill.resourceId === selectedSkill.resourceId)
      : skills.find((skill) => (
        skill.name === selectedSkill?.name
        && skill.scopeType === selectedSkill.scopeType
        && skill.sourceType === selectedSkill.sourceType
      )))
      || selectedSkill
      || skills.find((skill) => skill.name === selectedPath)
    : null;
  const selectedSkillDeleting = selectedSkillData
    ? pendingSkillAction === `delete:${selectedSkillData.name}`
    : false;

  return (
    <>
      <div className="mb-4 rounded-lg border bg-muted/20 p-4" data-testid="capability-scope-selector">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">{t('scope.title')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('scope.description')}</p>
          </div>
          <div className="flex rounded-md border bg-background p-1">
            <Button
              type="button"
              size="sm"
              variant={managementScope === 'user' ? 'secondary' : 'ghost'}
              onClick={() => changeManagementScope('user')}
            >
              {t('scope.personal')}
            </Button>
            {canManageOrganizationCapabilities ? (
              <Button
                type="button"
                size="sm"
                variant={managementScope === 'organization' ? 'secondary' : 'ghost'}
                onClick={() => changeManagementScope('organization')}
              >
                {t('scope.organization')}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {managementScope === 'organization' ? t('scope.organizationHint') : t('scope.personalHint')}
        </p>
      </div>
      {navigation.scope === 'organization' && !canManageOrganizationCapabilities ? (
        <InlineNotice variant="warning" size="compact" className="mb-4">{t('scope.organizationDenied')}</InlineNotice>
      ) : null}
      {managementScope === 'organization' ? (
        <div className="mb-4">
          <OrganizationCapabilityPolicyPanel />
        </div>
      ) : null}
      <Tabs
        value={panelTab}
        onValueChange={(value) => {
          if (value === 'plugins' || value === 'skills') {
            navigate({ area: value });
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
            key={managementScope}
            managementScope={managementScope}
            canManagePackages={canManageOrganizationCapabilities}
            onPluginsChanged={() => {
              setPluginsRevision((revision) => revision + 1);
            }}
          />
        </TabsContent>

        <TabsContent value="skills" className="space-y-4">
          <Tabs
            value={skillLibraryTab}
            onValueChange={(value) => {
              if (value === 'installed' || value === 'library' || value === 'updates') {
                setSkillStorePage(1);
                navigate({ view: value });
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
              <InlineNotice variant="destructive" size="compact">
                {skillActionError}
              </InlineNotice>
            ) : null}

            <TabsContent value="installed" className="space-y-4">
              {isLoading || skillTreeLoading ? (
                <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />{t('loading.pending')}
                </div>
              ) : skillsError ? (
                <InlineNotice variant="destructive">
                  <p>{skillsError}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => { void loadSkills(); void loadSkillTree(); }}>{t('loading.retry')}</Button>
                </InlineNotice>
              ) : <>
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <span>{stats.total} {t('stats.total').toLowerCase()}</span>
                    <span className="text-green-600">{stats.enabled} {t('stats.enabled').toLowerCase()}</span>
                    <span>{stats.disabled} {t('stats.disabled').toLowerCase()}</span>
                  </div>
                  <div className="flex-1" />
                  {managementScope === 'user' ? <>
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
                  </> : <Badge variant="outline">{t('scope.centralManaged')}</Badge>}
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

                  <div className="min-h-0 overflow-hidden" data-testid="skills-detail-scroll">
                    {rightView === 'info' && selectedSkillData ? (
                      <div className="h-full space-y-4 overflow-y-auto p-5">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            <CanvasSkillIcon skill={selectedSkillData} className="h-12 w-12 text-sm" />
                            <div className="min-w-0">
                              <h2 className="text-xl font-bold">{selectedSkillData.title}</h2>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className="text-sm font-mono text-muted-foreground">{selectedSkillData.name}</span>
                                <Badge variant={selectedSkillData.enabled ? 'default' : 'secondary'} className="text-xs">
                                  {selectedSkillData.enabled ? t('detail.enabled') : t('detail.disabled')}
                                </Badge>
                                {selectedSkillData.core ? (
                                  <Badge variant="outline" className="text-xs">
                                    {t('detail.core')}
                                  </Badge>
                                ) : null}
                                {selectedSkillData.scopeType ? (
                                  <Badge variant="outline" className="text-xs">
                                    {selectedSkillData.scopeType === 'organization' ? t('scope.organization') : t('scope.personal')}
                                  </Badge>
                                ) : null}
                                {selectedSkillData.sourceType ? (
                                  <Badge variant="outline" className="text-xs">{selectedSkillData.sourceType}</Badge>
                                ) : null}
                                {selectedSkillData.version ? (
                                  <Badge variant="outline" className="text-xs">v{selectedSkillData.version}</Badge>
                                ) : null}
                                {selectedSkillData.readiness && selectedSkillData.readiness !== 'available' && selectedSkillData.readiness !== 'disabled' ? (
                                  <Badge
                                    variant={selectedSkillData.readiness === 'blocked' || selectedSkillData.readiness === 'conflict' ? 'destructive' : 'secondary'}
                                    className="text-xs"
                                  >
                                    {t(`plugins.readiness.${selectedSkillData.readiness}`)}
                                  </Badge>
                                ) : null}
                              </div>
                            </div>
                          </div>
                          <Switch
                            checked={selectedSkillData.enabled}
                            disabled={
                              selectedSkillData.core
                              || managementScope === 'organization'
                              || selectedSkillData.effectivePolicy === 'required'
                              || selectedSkillData.readiness === 'blocked'
                              || selectedSkillData.readiness === 'conflict'
                            }
                            onCheckedChange={(checked) => void toggleSkill(selectedSkillData, checked)}
                            aria-label={t('toggleSkill', { name: selectedSkillData.name })}
                          />
                        </div>

                        <div className="bg-muted/30 rounded-lg p-4">
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                            {selectedSkillData.description}
                          </p>
                        </div>

                        {selectedSkillData.blockedReason ? (
                          <InlineNotice variant="destructive" size="compact">
                            {selectedSkillData.blockedReason}
                          </InlineNotice>
                        ) : null}

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
                          {managementScope === 'user' && !selectedSkillData.plugin && !selectedSkillData.core ? (
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
                          {managementScope === 'user' && !selectedSkillData.plugin && !selectedSkillData.core ? (
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
                      <div className="flex h-full min-h-0 flex-col bg-background">
                        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3 text-sm font-mono text-muted-foreground">
                          {isMarkdownFilePath(selectedPath) ? (
                            <FileText className="h-4 w-4 text-blue-500" />
                          ) : (
                            <FileCode className="h-4 w-4 text-green-500" />
                          )}
                          <span className="truncate" title={selectedPath}>{selectedPath.split('/').pop()}</span>
                        </div>
                        {previewLoading ? (
                          <div className="flex min-h-0 flex-1 items-center justify-center py-12">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          </div>
                        ) : previewError ? (
                          <div className="min-h-0 flex-1 overflow-y-auto p-4">
                            <InlineNotice variant="destructive" size="compact">
                              {previewError}
                            </InlineNotice>
                          </div>
                        ) : isMarkdownFilePath(selectedPath) ? (
                          <div className="min-h-0 flex-1 overflow-hidden" data-testid="skill-markdown-preview">
                            <MarkdownEditor
                              key={selectedPath}
                              value={previewContent}
                              readOnly
                            />
                          </div>
                        ) : (
                          <div className="min-h-0 flex-1 overflow-auto p-4">
                            <pre className="min-h-full rounded-lg bg-muted/30 p-4 font-mono text-sm whitespace-pre-wrap break-words">
                              {previewContent}
                            </pre>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center overflow-y-auto py-16 text-muted-foreground">
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
              </>}
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
                <InlineNotice variant="warning" size="compact">
                  {skillStoreError}
                </InlineNotice>
              ) : null}
              {skillStoreLoading ? (
                <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : skillStoreError ? null : skillStoreSkills.length === 0 ? (
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
                <InlineNotice variant="warning" size="compact">
                  {skillStoreError}
                </InlineNotice>
              ) : null}
              {skillStoreLoading ? (
                <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : skillStoreError ? null : skillStoreSkills.length === 0 ? (
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
