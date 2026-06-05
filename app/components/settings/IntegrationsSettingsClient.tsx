'use client';

import { useCallback, useEffect, useRef, useState, startTransition, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronDown, ExternalLink, Eye, EyeOff, Loader2, Mail, Menu, Plus, RefreshCw, Save, Search, Settings, Trash2 } from 'lucide-react';

import { GeneralSettingsPanel } from '@/app/components/settings/GeneralSettingsPanel';
import { SettingsAccordionCard } from '@/app/components/settings/SettingsAccordionCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHintContext } from '@/app/components/onboarding/HintProvider';

type EnvScope = 'integrations' | 'agents';

interface EnvEntry {
  key: string;
  value: string;
  encrypted: boolean;
}

interface EnvState {
  scope: EnvScope;
  path: string;
  exists: boolean;
  rawContent: string;
  entries: EnvEntry[];
  encryptionEnabled: boolean;
}

interface DraftEntry {
  id: string;
  key: string;
  value: string;
  encrypted: boolean;
}

type ScopeEditorState = {
  state: EnvState | null;
  draftEntries: DraftEntry[];
  rawContent: string;
  activeTab: 'kv' | 'raw';
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  success: string | null;
  secretVisibilityById: Record<string, boolean>;
};

type McpConfigState = {
  path: string;
  exists: boolean;
  rawContent: string;
};

type McpEditorState = {
  state: McpConfigState | null;
  status: McpStatusState | null;
  rawContent: string;
  isLoading: boolean;
  isSaving: boolean;
  isStatusLoading: boolean;
  activeServerAction: string | null;
  error: string | null;
  success: string | null;
};

type McpStatusState = {
  servers: Array<{
    name: string;
    transport: string;
    enabled: boolean;
    connected: boolean;
    activeCalls: number;
    cachedToolCount: number;
    cacheRefreshedAt: string | null;
    lastError: string | null;
    stderrTail: string | null;
    iconUrl: string | null;
  }>;
  directTools: Array<{
    name: string;
    label: string;
    description: string;
  }>;
  warnings: Array<{
    server: string;
    tool?: string;
    message: string;
  }>;
  oauth: Array<{
    serverName: string;
    authorized: boolean;
    requiresAuth: boolean;
    expiresAt: string | null;
    reason?: string;
  }>;
};

type McpCachedTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type McpToolsDialogState = {
  server: string | null;
  tools: McpCachedTool[];
  isLoading: boolean;
  error: string | null;
};

type EmailAccount = {
  id: string;
  provider: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  policy: {
    readFrom: string[];
    sendTo: string[];
  };
};

type EmailOAuthDraft = {
  googleClientId: string;
  googleClientSecret: string;
  microsoftClientId: string;
  microsoftClientSecret: string;
};

type EmailMode = 'unknown' | 'managed' | 'local';

type SearchIntegrationStatus = {
  configured: boolean;
  mode: 'local' | 'managed' | 'disabled';
  localConfigured: boolean;
  managedAvailable: boolean;
};

// Microsoft email OAuth stays in the code but is hidden until provider setup is active.
const SHOW_MICROSOFT_EMAIL_OAUTH = false;

type McpTransportMode = 'stdio' | 'http';

type McpPairDraft = {
  id: string;
  key: string;
  value: string;
  storeInEnv: boolean;
  envKey: string;
};

type McpServerDraft = {
  name: string;
  enabled: boolean;
  mode: McpTransportMode;
  command: string;
  args: string[];
  env: McpPairDraft[];
  envPassthrough: string[];
  cwd: string;
  url: string;
  auth: 'oauth' | 'none';
  bearerTokenEnv: string;
  bearerTokenValue: string;
  headers: McpPairDraft[];
  headersFromEnv: McpPairDraft[];
};

type McpConfigFile = {
  settings?: Record<string, unknown>;
  mcpServers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type ScopeCardConfig = {
  scope: EnvScope;
  emptyPath: string;
  keyHint: string;
};

const SETTINGS_TAB_ITEMS = [
  { value: 'general', labelKey: 'tabs.general' },
  { value: 'integrations', labelKey: 'tabs.integrations' },
  { value: 'agent-settings', labelKey: 'tabs.agentSettings' },
  { value: 'workspace', labelKey: 'tabs.workspace' },
  { value: 'channels', labelKey: 'tabs.channels' },
  { value: 'usage', labelKey: 'tabs.usage' },
  { value: 'skills', labelKey: 'tabs.skills' },
  { value: 'license', labelKey: 'tabs.license' },
] as const;
const SETTINGS_TABS = SETTINGS_TAB_ITEMS.map((tab) => tab.value);
const SETTINGS_TAB_STORAGE_KEY = 'canvas-settings-active-tab';
const ENV_CARD_OPEN_STORAGE_KEY = 'canvas-settings-env-card-open-state';
const INTEGRATIONS_SECTION_OPEN_STORAGE_KEY = 'canvas-settings-integrations-section-open-state';
const SETTINGS_TAB_TRIGGER_CLASS = 'min-h-9 min-w-0 border border-border px-2 data-[state=active]:bg-muted';
const SETTINGS_TAB_CONTENT_CLASS = 'space-y-4 data-[state=inactive]:hidden';

type SettingsTab = (typeof SETTINGS_TAB_ITEMS)[number]['value'];
type EnvCardOpenState = Record<EnvScope, boolean>;
type IntegrationsSectionId = 'search' | 'connectedApps' | 'emailAccounts' | 'mcpConfig';
type IntegrationsSectionOpenState = Record<IntegrationsSectionId, boolean>;
type ConnectedAppsPanelProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};
type UsageAnalyticsClientProps = {
  isAdmin: boolean;
};
type LicenseActivationPanelProps = {
  defaultEmail: string;
};
type CodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  path?: string;
};

const DEFAULT_SETTINGS_TAB: SettingsTab = 'general';
const DEFAULT_ENV_CARD_OPEN_STATE: EnvCardOpenState = { integrations: false, agents: false };
const DEFAULT_INTEGRATIONS_SECTION_OPEN_STATE: IntegrationsSectionOpenState = {
  search: false,
  connectedApps: false,
  emailAccounts: false,
  mcpConfig: false,
};

function SettingsTabLoader() {
  const t = useTranslations('settings');

  return (
    <div className="flex items-center py-8 text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {t('envCard.loadingConfig')}
    </div>
  );
}

const AgentSettingsPanel = dynamic(
  () => import('@/app/components/settings/AgentSettingsPanel').then((module) => module.AgentSettingsPanel),
  { loading: SettingsTabLoader },
);

const SkillsPanel = dynamic(
  () => import('@/app/components/settings/SkillsPanel').then((module) => module.SkillsPanel),
  { loading: SettingsTabLoader },
);

const WorkspaceSettingsPanel = dynamic(
  () => import('@/app/components/settings/WorkspaceSettingsPanel').then((module) => module.WorkspaceSettingsPanel),
  { loading: SettingsTabLoader },
);

const ChannelsPanel = dynamic(
  () => import('@/app/components/settings/ChannelsPanel').then((module) => module.ChannelsPanel),
  { loading: SettingsTabLoader },
);

const ConnectedAppsPanel = dynamic<ConnectedAppsPanelProps>(
  () => import('@/app/components/settings/ConnectedAppsPanel').then((module) => module.ConnectedAppsPanel),
  { loading: SettingsTabLoader },
);

const UsageAnalyticsClient = dynamic<UsageAnalyticsClientProps>(
  () => import('@/app/components/usage/UsageAnalyticsClient').then((module) => module.UsageAnalyticsClient),
  { loading: SettingsTabLoader },
);

const LicenseActivationPanel = dynamic<LicenseActivationPanelProps>(
  () => import('@/app/components/license/LicenseActivationPanel').then((module) => module.LicenseActivationPanel),
  { loading: SettingsTabLoader },
);

const CodeEditor = dynamic<CodeEditorProps>(
  () => import('@/app/components/editor/CodeEditor').then((module) => module.CodeEditor),
  { loading: SettingsTabLoader },
);

function isSettingsTab(value: string | null): value is SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab);
}

function normalizeSettingsTab(value: string | null): SettingsTab | null {
  if (isSettingsTab(value)) return value;
  if (value === 'agent' || value === 'agentSettings') return 'agent-settings';
  return null;
}

function getInitialSettingsTab(requestedTab: string | null): SettingsTab {
  return normalizeSettingsTab(requestedTab) ?? DEFAULT_SETTINGS_TAB;
}

function getStoredSettingsTab(): SettingsTab | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeSettingsTab(window.localStorage.getItem(SETTINGS_TAB_STORAGE_KEY));
  } catch {
    return null;
  }
}

function getStoredEnvCardOpenState(): EnvCardOpenState {
  if (typeof window === 'undefined') return DEFAULT_ENV_CARD_OPEN_STATE;

  try {
    const storedState = JSON.parse(window.localStorage.getItem(ENV_CARD_OPEN_STORAGE_KEY) || '{}') as Partial<EnvCardOpenState>;
    return {
      integrations: typeof storedState.integrations === 'boolean' ? storedState.integrations : DEFAULT_ENV_CARD_OPEN_STATE.integrations,
      agents: typeof storedState.agents === 'boolean' ? storedState.agents : DEFAULT_ENV_CARD_OPEN_STATE.agents,
    };
  } catch {
    return DEFAULT_ENV_CARD_OPEN_STATE;
  }
}

function getStoredIntegrationsSectionOpenState(): IntegrationsSectionOpenState {
  if (typeof window === 'undefined') return DEFAULT_INTEGRATIONS_SECTION_OPEN_STATE;

  try {
    const storedState = JSON.parse(window.localStorage.getItem(INTEGRATIONS_SECTION_OPEN_STORAGE_KEY) || '{}') as Partial<IntegrationsSectionOpenState>;
    return {
      search: typeof storedState.search === 'boolean' ? storedState.search : DEFAULT_INTEGRATIONS_SECTION_OPEN_STATE.search,
      connectedApps: typeof storedState.connectedApps === 'boolean' ? storedState.connectedApps : DEFAULT_INTEGRATIONS_SECTION_OPEN_STATE.connectedApps,
      emailAccounts: typeof storedState.emailAccounts === 'boolean' ? storedState.emailAccounts : DEFAULT_INTEGRATIONS_SECTION_OPEN_STATE.emailAccounts,
      mcpConfig: typeof storedState.mcpConfig === 'boolean' ? storedState.mcpConfig : DEFAULT_INTEGRATIONS_SECTION_OPEN_STATE.mcpConfig,
    };
  } catch {
    return DEFAULT_INTEGRATIONS_SECTION_OPEN_STATE;
  }
}

const DEFAULT_SCOPE_KEYS: Record<EnvScope, string[]> = {
  integrations: ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'KIE_API_KEY', 'BRAVE_API_KEY', 'GROQ_API_KEY', 'COMPOSIO_API_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ENABLED'],
  agents: ['OPENROUTER_API_KEY', 'OLLAMA_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
};

const INITIAL_SCOPE_STATE = (scope: EnvScope): ScopeEditorState => ({
  state: null,
  draftEntries: toDefaultDraftEntries(scope),
  rawContent: '',
  activeTab: 'kv',
  isLoading: true,
  isSaving: false,
  error: null,
  success: null,
  secretVisibilityById: {},
});

const INITIAL_MCP_STATE: McpEditorState = {
  state: null,
  status: null,
  rawContent: '',
  isLoading: true,
  isSaving: false,
  isStatusLoading: false,
  activeServerAction: null,
  error: null,
  success: null,
};

const SCOPE_CARDS: ScopeCardConfig[] = [
  {
    scope: 'integrations',
    emptyPath: '/data/secrets/Canvas-Integrations.env',
    keyHint: 'Canvas-Integrations.env',
  },
  {
    scope: 'agents',
    emptyPath: '/data/secrets/Canvas-Agents.env',
    keyHint: 'Canvas-Agents.env',
  },
];

function normalizeKeyForSecretCheck(key: string): string {
  return key.trim().toUpperCase();
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKeyForSecretCheck(key);
  if (normalized.endsWith('_KEY_SOURCE')) {
    return false;
  }
  return (
    normalized.endsWith('_KEY') ||
    normalized.includes('_TOKEN') ||
    normalized.includes('TOKEN') ||
    normalized.includes('SECRET') ||
    normalized.includes('PASSWORD')
  );
}

function createDraftEntry(entry?: Partial<EnvEntry>): DraftEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    key: entry?.key || '',
    value: entry?.value || '',
    encrypted: Boolean(entry?.encrypted),
  };
}

function toDefaultDraftEntries(scope: EnvScope): DraftEntry[] {
  return DEFAULT_SCOPE_KEYS[scope].map((key) => createDraftEntry({ key, value: '', encrypted: false }));
}

function toDraftEntries(scope: EnvScope, entries: EnvEntry[]): DraftEntry[] {
  if (!entries || entries.length === 0) {
    return toDefaultDraftEntries(scope);
  }

  const existingEntries = entries.map((entry) => createDraftEntry(entry));
  const existingKeys = new Set(entries.map((entry) => entry.key.trim().toUpperCase()).filter(Boolean));
  const missingDefaults = DEFAULT_SCOPE_KEYS[scope]
    .filter((key) => !existingKeys.has(key.toUpperCase()))
    .map((key) => createDraftEntry({ key, value: '', encrypted: false }));

  return [...existingEntries, ...missingDefaults];
}

function buildHiddenState(entries: DraftEntry[]): Record<string, boolean> {
  return Object.fromEntries(entries.map((entry) => [entry.id, false])) as Record<string, boolean>;
}

function countConfiguredEntries(entries: DraftEntry[]): number {
  return entries.filter((entry) => entry.key.trim().length > 0 && (entry.value.length > 0 || entry.encrypted)).length;
}

function createMcpPairDraft(entry?: Partial<McpPairDraft>): McpPairDraft {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    key: entry?.key || '',
    value: entry?.value || '',
    storeInEnv: Boolean(entry?.storeInEnv),
    envKey: entry?.envKey || '',
  };
}

function normalizeEnvKeyPart(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function makeMcpEnvKey(serverName: string, key: string): string {
  const server = normalizeEnvKeyPart(serverName) || 'SERVER';
  const name = normalizeEnvKeyPart(key) || 'VALUE';
  return `MCP_${server}_${name}`;
}

function makeMcpBearerTokenEnvKey(draft: Pick<McpServerDraft, 'bearerTokenEnv' | 'name'>): string {
  return draft.bearerTokenEnv.trim() || makeMcpEnvKey(draft.name, 'BEARER_TOKEN');
}

function parseEnvReference(value: string): string | null {
  const match = value.trim().match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u);
  return match?.[1] || null;
}

function parseMcpConfigFile(rawContent: string): McpConfigFile {
  const parsed = JSON.parse(rawContent || '{}') as Partial<McpConfigFile>;
  return {
    ...parsed,
    settings: parsed.settings || { toolPrefix: 'server', idleTimeout: 10 },
    mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers
      : {},
  } as McpConfigFile;
}

function toMcpServerDraft(name: string, serverConfig: Record<string, unknown> = {}): McpServerDraft {
  const env = serverConfig.env && typeof serverConfig.env === 'object' && !Array.isArray(serverConfig.env)
    ? Object.entries(serverConfig.env as Record<string, unknown>).map(([key, value]) => {
      const stringValue = typeof value === 'string' ? value : String(value ?? '');
      const envKey = parseEnvReference(stringValue);
      return createMcpPairDraft({ key, value: envKey ? '' : stringValue, storeInEnv: Boolean(envKey), envKey: envKey || makeMcpEnvKey(name, key) });
    })
    : [];
  const headers = serverConfig.headers && typeof serverConfig.headers === 'object' && !Array.isArray(serverConfig.headers)
    ? Object.entries(serverConfig.headers as Record<string, unknown>).map(([key, value]) => {
      const stringValue = typeof value === 'string' ? value : String(value ?? '');
      const envKey = parseEnvReference(stringValue);
      return createMcpPairDraft({ key, value: envKey ? '' : stringValue, storeInEnv: Boolean(envKey), envKey: envKey || makeMcpEnvKey(name, key) });
    })
    : [];
  const headersFromEnv = serverConfig.headersFromEnv && typeof serverConfig.headersFromEnv === 'object' && !Array.isArray(serverConfig.headersFromEnv)
    ? Object.entries(serverConfig.headersFromEnv as Record<string, unknown>).map(([key, value]) => createMcpPairDraft({ key, value: typeof value === 'string' ? value : String(value ?? '') }))
    : [];

  return {
    name,
    enabled: serverConfig.enabled !== false,
    mode: typeof serverConfig.command === 'string' && serverConfig.command.trim() ? 'stdio' : 'http',
    command: typeof serverConfig.command === 'string' ? serverConfig.command : '',
    args: Array.isArray(serverConfig.args) ? serverConfig.args.filter((arg): arg is string => typeof arg === 'string') : [],
    env,
    envPassthrough: Array.isArray(serverConfig.envPassthrough) ? serverConfig.envPassthrough.filter((value): value is string => typeof value === 'string') : [],
    cwd: typeof serverConfig.cwd === 'string' ? serverConfig.cwd : '',
    url: typeof serverConfig.url === 'string' ? serverConfig.url : '',
    auth: serverConfig.auth === 'oauth' || (serverConfig.oauth && typeof serverConfig.oauth === 'object' && !Array.isArray(serverConfig.oauth)) ? 'oauth' : 'none',
    bearerTokenEnv: typeof serverConfig.bearerTokenEnv === 'string' ? serverConfig.bearerTokenEnv : '',
    bearerTokenValue: '',
    headers,
    headersFromEnv,
  };
}

function createBlankMcpServerDraft(): McpServerDraft {
  return toMcpServerDraft('', { enabled: true, command: '', args: [''], env: {}, envPassthrough: [''], cwd: '' });
}

function pairsToRecord(pairs: McpPairDraft[], options: { envReference?: boolean } = {}): Record<string, string> | undefined {
  const entries = pairs
    .map((pair) => {
      const key = pair.key.trim();
      const value = options.envReference && pair.storeInEnv && pair.envKey.trim()
        ? `\${${pair.envKey.trim()}}`
        : pair.value;
      return [key, value] as const;
    })
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function collectMcpEnvEntries(draft: McpServerDraft): Array<{ key: string; value: string }> {
  const pairs = draft.mode === 'stdio' ? draft.env : draft.headers;
  const entries = pairs
    .filter((pair) => pair.storeInEnv && pair.envKey.trim() && pair.value)
    .map((pair) => ({ key: pair.envKey.trim(), value: pair.value }));
  if (draft.mode === 'http' && draft.bearerTokenValue.trim()) {
    entries.push({
      key: makeMcpBearerTokenEnvKey(draft),
      value: draft.bearerTokenValue.trim(),
    });
  }
  return entries;
}

function draftToMcpServerConfig(draft: McpServerDraft): Record<string, unknown> {
  if (draft.mode === 'http') {
    const bearerTokenEnv = draft.bearerTokenEnv.trim() || (draft.bearerTokenValue.trim() ? makeMcpBearerTokenEnvKey(draft) : '');
    return {
      enabled: draft.enabled,
      url: draft.url.trim(),
      auth: draft.auth,
      ...(bearerTokenEnv ? { bearerTokenEnv } : {}),
      ...(pairsToRecord(draft.headers, { envReference: true }) ? { headers: pairsToRecord(draft.headers, { envReference: true }) } : {}),
      ...(pairsToRecord(draft.headersFromEnv) ? { headersFromEnv: pairsToRecord(draft.headersFromEnv) } : {}),
    };
  }

  return {
    enabled: draft.enabled,
    command: draft.command.trim(),
    args: draft.args.map((arg) => arg.trim()).filter(Boolean),
    ...(pairsToRecord(draft.env, { envReference: true }) ? { env: pairsToRecord(draft.env, { envReference: true }) } : {}),
    ...(draft.envPassthrough.map((value) => value.trim()).filter(Boolean).length > 0 ? { envPassthrough: draft.envPassthrough.map((value) => value.trim()).filter(Boolean) } : {}),
    ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
  };
}

function updateMcpConfigRawServer(rawContent: string, draft: McpServerDraft, originalName?: string): string {
  const config = parseMcpConfigFile(rawContent);
  const nextName = draft.name.trim();
  if (!nextName) throw new Error('MCP server name is required.');
  if (draft.mode === 'stdio' && !draft.command.trim()) throw new Error('MCP stdio command is required.');
  if (draft.mode === 'http' && !draft.url.trim()) throw new Error('MCP HTTP URL is required.');
  if (originalName && originalName !== nextName) {
    delete config.mcpServers[originalName];
  }
  config.mcpServers[nextName] = draftToMcpServerConfig(draft);
  return `${JSON.stringify(config, null, 2)}\n`;
}

function deleteMcpConfigRawServer(rawContent: string, serverName: string): string {
  const config = parseMcpConfigFile(rawContent);
  delete config.mcpServers[serverName];
  return `${JSON.stringify(config, null, 2)}\n`;
}

function EnvEditorCard(props: {
  card: ScopeCardConfig;
  editor: ScopeEditorState;
  isOpen: boolean;
  onOpenChange: (scope: EnvScope, isOpen: boolean) => void;
  onActiveTabChange: (scope: EnvScope, value: 'kv' | 'raw') => void;
  onLoad: (scope: EnvScope) => Promise<void>;
  onAddEntry: (scope: EnvScope) => void;
  onRemoveEntry: (scope: EnvScope, index: number) => void;
  onUpdateEntry: (scope: EnvScope, index: number, patch: Partial<DraftEntry>) => void;
  onToggleSecret: (scope: EnvScope, entryId: string) => void;
  onRawChange: (scope: EnvScope, value: string) => void;
  onSaveKeyValue: (scope: EnvScope) => Promise<void>;
  onSaveRaw: (scope: EnvScope) => Promise<void>;
}) {
  const t = useTranslations('settings');
  const {
    card,
    editor,
    isOpen,
    onActiveTabChange,
    onAddEntry,
    onLoad,
    onOpenChange,
    onRawChange,
    onRemoveEntry,
    onSaveKeyValue,
    onSaveRaw,
    onToggleSecret,
    onUpdateEntry,
  } = props;
  const configuredCount = countConfiguredEntries(editor.draftEntries);

  return (
    <Collapsible open={isOpen} onOpenChange={(nextOpen) => onOpenChange(card.scope, nextOpen)}>
      <Card id={card.scope === 'integrations' ? 'onboarding-settings-env-integrations' : 'onboarding-settings-env-agents'} className="gap-0 py-0">
        <CardHeader className="p-0">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full flex-col gap-3 rounded-lg px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:px-6"
              aria-label={isOpen ? t('envCard.collapse') : t('envCard.expand')}
            >
              <div className="flex w-full items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <CardTitle>{t(`scopes.${card.scope}.title`)}</CardTitle>
                  <CardDescription>
                    {t(`scopes.${card.scope}.description`)} {t('envCard.fileLocatedAt')}{' '}
                    <span className="break-all font-mono">{editor.state?.path || card.emptyPath}</span>.
                  </CardDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm font-medium text-muted-foreground">
                  <span className="hidden sm:inline">{isOpen ? t('envCard.collapse') : t('envCard.expand')}</span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-2 py-1">{t('envCard.configuredSummary', { count: configuredCount })}</span>
                <span className="rounded-md bg-muted px-2 py-1">{t('envCard.fileLabel')}: {card.keyHint}</span>
                {editor.isLoading ? (
                  <span className="inline-flex items-center rounded-md bg-muted px-2 py-1">
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    {t('envCard.loadingConfig')}
                  </span>
                ) : (
                  <span className="rounded-md bg-muted px-2 py-1">
                    {editor.state?.encryptionEnabled ? t('envCard.encryptionActive') : t('envCard.encryptionInactive')}
                  </span>
                )}
                {editor.error && (
                  <span className="rounded-md bg-destructive/10 px-2 py-1 text-destructive">
                    {t('envCard.errorSummary')}
                  </span>
                )}
              </div>
            </button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-4 px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
            {editor.isLoading ? (
              <div className="flex items-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('envCard.loadingConfig')}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('envCard.fileLabel')}: {card.keyHint}</span>
                  <span>•</span>
                  <span>{t('envCard.formatLabel')}: .env</span>
                  <span>•</span>
                  <span>{t('envCard.permissionsLabel')}: 0600</span>
                  <span>•</span>
                  <span>{editor.state?.encryptionEnabled ? t('envCard.encryptionActive') : t('envCard.encryptionInactive')}</span>
                </div>

                {editor.error && <p className="text-sm text-destructive">{editor.error}</p>}
                {editor.success && <p className="text-sm text-primary">{editor.success}</p>}

                <Tabs
                  value={editor.activeTab}
                  onValueChange={(value) => onActiveTabChange(card.scope, value as 'kv' | 'raw')}
                >
                  <TabsList className="grid h-auto w-full grid-cols-2">
                    <TabsTrigger value="kv">{t('envCard.tabKeyValue')}</TabsTrigger>
                    <TabsTrigger value="raw">{t('envCard.tabRaw')}</TabsTrigger>
                  </TabsList>

                  <TabsContent value="kv" className="space-y-3">
                    <div className="hidden grid-cols-[minmax(220px,0.9fr)_minmax(0,1.6fr)_auto] gap-3 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase md:grid">
                      <span>{t('envCard.columnKey')}</span>
                      <span>{t('envCard.columnValue')}</span>
                      <span className="text-right">{t('envCard.columnAction')}</span>
                    </div>

                    <div className="space-y-3">
                      {editor.draftEntries.map((entry, index) => {
                        const secret = isSecretKey(entry.key);
                        const visible = Boolean(editor.secretVisibilityById[entry.id]);

                        return (
                          <div
                            key={entry.id}
                            className="grid gap-2 md:grid-cols-[minmax(220px,0.9fr)_minmax(0,1.6fr)_auto] md:items-center"
                          >
                            <Input
                              placeholder={t('envCard.placeholderKeyName')}
                              value={entry.key}
                              onChange={(event) => onUpdateEntry(card.scope, index, { key: event.target.value })}
                              disabled={editor.isSaving}
                            />
                            <div className="relative min-w-0">
                              <Input
                                type={secret && !visible ? 'password' : 'text'}
                                placeholder={entry.encrypted ? t('envCard.placeholderEncryptedValue') : t('envCard.placeholderValue')}
                                value={entry.value}
                                onChange={(event) => onUpdateEntry(card.scope, index, { value: event.target.value })}
                                disabled={editor.isSaving}
                                className={secret ? 'pr-11' : undefined}
                              />
                              {secret && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className="absolute right-1 top-1/2 -translate-y-1/2"
                                  aria-label={visible ? t('envCard.hideSecret') : t('envCard.showSecret')}
                                  onClick={() => onToggleSecret(card.scope, entry.id)}
                                  disabled={editor.isSaving}
                                >
                                  {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </Button>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="icon-sm"
                              aria-label={t('envCard.deleteRow')}
                              onClick={() => onRemoveEntry(card.scope, index)}
                              disabled={editor.isSaving}
                              className="justify-self-start md:justify-self-end"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" onClick={() => onAddEntry(card.scope)} disabled={editor.isSaving}>
                        <Plus className="mr-1 h-4 w-4" />
                        {t('envCard.addRow')}
                      </Button>
                      <Button type="button" onClick={() => void onSaveKeyValue(card.scope)} disabled={editor.isSaving || editor.isLoading}>
                        {editor.isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {t('envCard.save')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void onLoad(card.scope)} disabled={editor.isSaving}>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        {t('envCard.reload')}
                      </Button>
                    </div>
                  </TabsContent>

                  <TabsContent value="raw" className="space-y-2">
                    <textarea
                      className="min-h-[360px] w-full rounded-md border border-input bg-background p-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      value={editor.rawContent}
                      onChange={(event) => onRawChange(card.scope, event.target.value)}
                      spellCheck={false}
                      disabled={editor.isSaving}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" onClick={() => void onSaveRaw(card.scope)} disabled={editor.isSaving || editor.isLoading}>
                        {editor.isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {t('envCard.saveRaw')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void onLoad(card.scope)} disabled={editor.isSaving}>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        {t('envCard.reload')}
                      </Button>
                    </div>
                  </TabsContent>
                </Tabs>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function SearchIntegrationCard({
  isOpen,
  onOpenChange,
  onEnvSaved,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onEnvSaved: () => Promise<void>;
}) {
  const t = useTranslations('settings.searchIntegration');
  const [status, setStatus] = useState<SearchIntegrationStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [isVisible, setIsVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSearchIntegration = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [statusResponse, envResponse] = await Promise.all([
        fetch('/api/integrations/search/status', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/integrations/env?scope=integrations', { credentials: 'include', cache: 'no-store' }),
      ]);
      const statusPayload = await statusResponse.json();
      const envPayload = await envResponse.json();
      if (!statusResponse.ok || !statusPayload.success) {
        throw new Error(statusPayload.error || t('errors.load'));
      }
      if (!envResponse.ok || !envPayload.success) {
        throw new Error(envPayload.error || t('errors.load'));
      }
      setStatus(statusPayload.data as SearchIntegrationStatus);
      const entries = (envPayload.data?.entries || []) as EnvEntry[];
      const braveKey = entries.find((entry) => entry.key === 'BRAVE_API_KEY')?.value || '';
      setApiKey(braveKey);
      setMessage(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadSearchIntegration();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadSearchIntegration]);

  const saveApiKey = async (nextValue: string) => {
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const currentResponse = await fetch('/api/integrations/env?scope=integrations', {
        credentials: 'include',
        cache: 'no-store',
      });
      const currentPayload = await currentResponse.json();
      if (!currentResponse.ok || !currentPayload.success) {
        throw new Error(currentPayload.error || t('errors.load'));
      }
      const currentEntries = (currentPayload.data?.entries || []) as EnvEntry[];
      const nextEntries = currentEntries
        .filter((entry) => entry.key !== 'BRAVE_API_KEY')
        .map((entry) => ({ key: entry.key, value: entry.value }));
      const trimmed = nextValue.trim();
      if (trimmed) {
        nextEntries.push({ key: 'BRAVE_API_KEY', value: trimmed });
      }

      const saveResponse = await fetch('/api/integrations/env?scope=integrations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ scope: 'integrations', mode: 'kv', entries: nextEntries }),
      });
      const savePayload = await saveResponse.json();
      if (!saveResponse.ok || !savePayload.success) {
        throw new Error(savePayload.error || t('errors.save'));
      }
      setApiKey(trimmed);
      setMessage(trimmed ? t('saved') : t('removed'));
      await Promise.all([loadSearchIntegration(), onEnvSaved()]);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  const modeLabel = status?.mode === 'local'
    ? t('modeLocal')
    : status?.mode === 'managed'
      ? t('modeManaged')
      : t('modeMissing');
  const summaryItems = [
    isLoading ? t('loading') : modeLabel,
    status?.managedAvailable ? t('managedAvailable') : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <SettingsAccordionCard
      title={t('title')}
      description={t('description')}
      icon={Search}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={summaryItems}
      contentClassName="space-y-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={status?.configured ? 'default' : 'secondary'}>{modeLabel}</Badge>
        {status?.localConfigured && <Badge variant="outline">{t('localConfigured')}</Badge>}
        {status?.managedAvailable && <Badge variant="outline">{t('managedAvailable')}</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">
        {status?.mode === 'managed' ? t('managedDescription') : t('localDescription')}
      </p>
      {error && <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {message && <div className="border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{message}</div>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="search-brave-api-key">
            {t('apiKeyLabel')}
          </Label>
          <div className="relative">
            <Input
              id="search-brave-api-key"
              type={isVisible ? 'text' : 'password'}
              className="font-mono text-xs pr-11"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="BRAVE_API_KEY"
              disabled={isLoading || isSaving}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              aria-label={isVisible ? t('hideSecret') : t('showSecret')}
              onClick={() => setIsVisible((current) => !current)}
              disabled={isLoading || isSaving}
            >
              {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('apiKeyHint')}</p>
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          <Button type="button" variant="outline" onClick={() => void loadSearchIntegration()} disabled={isLoading || isSaving}>
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('reload')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void saveApiKey('')} disabled={isLoading || isSaving || !apiKey.trim()}>
            <Trash2 className="mr-2 h-4 w-4" />
            {t('remove')}
          </Button>
          <Button type="button" onClick={() => void saveApiKey(apiKey)} disabled={isLoading || isSaving}>
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </SettingsAccordionCard>
  );
}

type McpServerAction = 'enable' | 'disable' | 'test' | 'authorize' | 'clear_auth';

function getMcpServerInitials(name: string): string {
  const parts = name
    .split(/[\s._-]+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'M';
}

function McpServerAvatar({ iconUrl, serverName }: { iconUrl?: string | null; serverName: string }) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const initials = getMcpServerInitials(serverName);
  const showIcon = Boolean(iconUrl && failedIconUrl !== iconUrl);

  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-xs font-semibold text-muted-foreground">
      {iconUrl && showIcon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={iconUrl}
          alt=""
          className="h-full w-full object-contain p-1"
          loading="lazy"
          onError={() => setFailedIconUrl(iconUrl)}
        />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}

function McpConfigCard(props: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  editor: McpEditorState;
  onLoad: () => Promise<void>;
  onLoadStatus: () => Promise<void>;
  onServerAction: (server: string, action: McpServerAction) => Promise<void>;
  onSaveServer: (draft: McpServerDraft, originalName?: string) => Promise<void>;
  onDeleteServer: (server: string) => Promise<void>;
  onRawChange: (value: string) => void;
  onSave: () => Promise<void>;
}) {
  const t = useTranslations('settings');
  const { editor, isOpen, onLoad, onLoadStatus, onOpenChange, onServerAction, onSaveServer, onDeleteServer, onRawChange, onSave } = props;
  const [mcpView, setMcpView] = useState<'list' | 'form'>('list');
  const [editingServerName, setEditingServerName] = useState<string | undefined>();
  const [serverDraft, setServerDraft] = useState<McpServerDraft>(() => createBlankMcpServerDraft());
  const [toolsDialog, setToolsDialog] = useState<McpToolsDialogState>({
    server: null,
    tools: [],
    isLoading: false,
    error: null,
  });
  const config = (() => {
    try {
      return parseMcpConfigFile(editor.rawContent);
    } catch {
      return { settings: {}, mcpServers: {} } as McpConfigFile;
    }
  })();
  const configuredServers = Object.entries(config.mcpServers);
  const connectedServerCount = configuredServers.filter(([serverName]) =>
    editor.status?.servers.find((entry) => entry.name === serverName)?.connected
  ).length;
  const summaryItems = [
    editor.isLoading ? t('mcpConfig.loading') : t('mcpConfig.summary', { count: configuredServers.length }),
    !editor.isLoading && configuredServers.length > 0 ? t('mcpConfig.connectedSummary', { count: connectedServerCount }) : null,
    editor.error ? t('mcpConfig.errorSummary') : null,
  ].filter((item): item is string => Boolean(item));

  const startAddServer = () => {
    setEditingServerName(undefined);
    setServerDraft(createBlankMcpServerDraft());
    setMcpView('form');
  };

  const startEditServer = (serverName: string) => {
    setEditingServerName(serverName);
    setServerDraft(toMcpServerDraft(serverName, config.mcpServers[serverName]));
    setMcpView('form');
  };

  const updateServerDraft = (patch: Partial<McpServerDraft>) => {
    setServerDraft((current) => ({ ...current, ...patch }));
  };

  const closeToolsDialog = () => {
    setToolsDialog({
      server: null,
      tools: [],
      isLoading: false,
      error: null,
    });
  };

  const openToolsDialog = async (serverName: string) => {
    setToolsDialog({
      server: serverName,
      tools: [],
      isLoading: true,
      error: null,
    });

    try {
      const response = await fetch(`/api/integrations/mcp-tools?server=${encodeURIComponent(serverName)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('mcpConfig.errors.tools'));
      }

      setToolsDialog({
        server: serverName,
        tools: Array.isArray(payload.data?.tools) ? payload.data.tools : [],
        isLoading: false,
        error: null,
      });
    } catch (error) {
      setToolsDialog({
        server: serverName,
        tools: [],
        isLoading: false,
        error: error instanceof Error ? error.message : t('mcpConfig.errors.tools'),
      });
    }
  };

  const updatePair = (field: 'env' | 'headers' | 'headersFromEnv', index: number, patch: Partial<McpPairDraft>) => {
    setServerDraft((current) => ({
      ...current,
      [field]: current[field].map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry),
    }));
  };

  const removePair = (field: 'env' | 'headers' | 'headersFromEnv', index: number) => {
    setServerDraft((current) => ({
      ...current,
      [field]: current[field].filter((_entry, entryIndex) => entryIndex !== index),
    }));
  };

  const bearerTokenEnvKey = makeMcpBearerTokenEnvKey(serverDraft);

  const renderPairRows = (field: 'env' | 'headers' | 'headersFromEnv', keyPlaceholder: string, valuePlaceholder: string) => (
    <div className="space-y-2">
      {serverDraft[field].map((entry, index) => (
        <div key={entry.id} className="space-y-2 rounded-md border border-border p-2">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
            <Input value={entry.key} onChange={(event) => updatePair(field, index, { key: event.target.value, envKey: entry.envKey || makeMcpEnvKey(serverDraft.name, event.target.value) })} placeholder={keyPlaceholder} />
            <Input
              value={entry.value}
              onChange={(event) => updatePair(field, index, { value: event.target.value })}
              placeholder={entry.storeInEnv ? t('mcpConfig.secretValuePlaceholder') : valuePlaceholder}
              type={entry.storeInEnv ? 'password' : 'text'}
              disabled={field === 'headersFromEnv'}
            />
            <Button type="button" variant="ghost" size="icon" onClick={() => removePair(field, index)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          {field !== 'headersFromEnv' && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <label className="flex items-center gap-2">
                <Switch
                  size="sm"
                  checked={entry.storeInEnv}
                  onCheckedChange={(checked) => updatePair(field, index, { storeInEnv: checked, envKey: entry.envKey || makeMcpEnvKey(serverDraft.name, entry.key) })}
                />
                {t('mcpConfig.storeInIntegrationsEnv')}
              </label>
              {entry.storeInEnv && (
                <Input
                  className="h-8 max-w-xs"
                  value={entry.envKey || makeMcpEnvKey(serverDraft.name, entry.key)}
                  onChange={(event) => updatePair(field, index, { envKey: event.target.value })}
                  placeholder="MCP_SERVER_TOKEN"
                />
              )}
            </div>
          )}
        </div>
      ))}
      <Button type="button" variant="secondary" className="w-full" onClick={() => updateServerDraft({ [field]: [...serverDraft[field], createMcpPairDraft()] } as Partial<McpServerDraft>)}>
        <Plus className="mr-2 h-4 w-4" />
        {field === 'headers' ? t('mcpConfig.addHeader') : field === 'headersFromEnv' ? t('mcpConfig.addVariable') : t('mcpConfig.addEnvVar')}
      </Button>
    </div>
  );

  return (
    <>
    <SettingsAccordionCard
      id="onboarding-settings-mcp-config"
      title={t('mcpConfig.title')}
      description={`${t('mcpConfig.description')} ${t('envCard.fileLocatedAt')} ${editor.state?.path || '/data/canvas-agent/mcp.json'}.`}
      icon={Settings}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={summaryItems}
      contentClassName="space-y-4"
    >
        {editor.isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('mcpConfig.loading')}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t('envCard.fileLabel')}: mcp.json</span>
              <span>•</span>
              <span>{t('envCard.formatLabel')}: JSON</span>
              <span>•</span>
              <span>{t('envCard.permissionsLabel')}: 0600</span>
            </div>

            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{t('mcpConfig.secretNote')}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href="https://mcpservers.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {t('mcpConfig.examplesLink')}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <span>•</span>
                <a
                  href="https://github.com/mcp"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {t('mcpConfig.registryLink')}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <span>{t('mcpConfig.examplesCaution')}</span>
              </div>
            </div>

            {editor.error && <p className="text-sm text-destructive">{editor.error}</p>}
            {editor.success && <p className="text-sm text-primary">{editor.success}</p>}

            {mcpView === 'list' ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{t('mcpConfig.serversTitle')}</h3>
                    <p className="text-sm text-muted-foreground">{t('mcpConfig.serversDescription')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => void onLoadStatus()} disabled={editor.isStatusLoading || editor.isSaving}>
                      {editor.isStatusLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                      {t('mcpConfig.refreshStatus')}
                    </Button>
                    <Button type="button" onClick={startAddServer}>
                      <Plus className="mr-2 h-4 w-4" />
                      {t('mcpConfig.addServer')}
                    </Button>
                  </div>
                </div>

                {configuredServers.length === 0 ? (
                  <div className="rounded-md border border-border p-6 text-sm text-muted-foreground">{t('mcpConfig.noServers')}</div>
                ) : (
                  <div className="overflow-hidden rounded-md border border-border">
                    {configuredServers.map(([serverName, serverConfig]) => {
                      const status = editor.status?.servers.find((entry) => entry.name === serverName);
                      const oauth = editor.status?.oauth.find((entry) => entry.serverName === serverName);
                      const draft = toMcpServerDraft(serverName, serverConfig);
                      const enabled = status?.enabled ?? draft.enabled;
                      return (
                        <div key={serverName} className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 last:border-b-0">
                          <button
                            type="button"
                            className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            onClick={() => void openToolsDialog(serverName)}
                            title={t('mcpConfig.showCachedTools')}
                          >
                            <McpServerAvatar iconUrl={status?.iconUrl} serverName={serverName} />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{serverName}</span>
                                <Badge variant="outline">{draft.mode === 'stdio' ? 'stdio' : 'http'}</Badge>
                                {status?.connected && <Badge>{t('mcpConfig.connected')}</Badge>}
                                {oauth?.requiresAuth && <Badge variant={oauth.authorized ? 'default' : 'destructive'}>{oauth.authorized ? t('mcpConfig.oauthAuthorized') : t('mcpConfig.oauthRequired')}</Badge>}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {t('mcpConfig.cachedTools')}: {status?.cachedToolCount ?? 0}
                                {status?.lastError ? ` · ${t('mcpConfig.lastError')}: ${status.lastError}` : ''}
                              </div>
                            </div>
                          </button>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void onServerAction(serverName, 'test')}
                              disabled={!enabled || Boolean(editor.activeServerAction) || editor.isSaving}
                            >
                              {editor.activeServerAction === `${serverName}:test` && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                              {t('mcpConfig.testConnection')}
                            </Button>
                            {oauth?.requiresAuth && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void onServerAction(serverName, 'authorize')}
                                disabled={!enabled || Boolean(editor.activeServerAction) || editor.isSaving}
                              >
                                {editor.activeServerAction === `${serverName}:authorize` && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {oauth.authorized ? t('mcpConfig.reauthorize') : t('mcpConfig.authorize')}
                              </Button>
                            )}
                            <Button type="button" variant="ghost" size="icon" onClick={() => startEditServer(serverName)} title={t('mcpConfig.editServer')}>
                              <Settings className="h-4 w-4" />
                            </Button>
                            <Switch
                              checked={enabled}
                              onCheckedChange={(checked) => void onServerAction(serverName, checked ? 'enable' : 'disable')}
                              disabled={Boolean(editor.activeServerAction) || editor.isSaving}
                              aria-label={enabled ? t('mcpConfig.disable') : t('mcpConfig.enable')}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">{t('mcpConfig.rawJson')}</summary>
                  <div className="mt-3 h-[360px] overflow-hidden rounded-md border border-input bg-background">
                    <CodeEditor value={editor.rawContent} onChange={onRawChange} path="mcp.json" readOnly={editor.isSaving} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" onClick={() => void onSave()} disabled={editor.isSaving || editor.isLoading}>
                      {editor.isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t('mcpConfig.save')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void onLoad()} disabled={editor.isSaving}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {t('envCard.reload')}
                    </Button>
                  </div>
                </details>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <Button type="button" variant="ghost" onClick={() => setMcpView('list')}>
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    {t('mcpConfig.backToServers')}
                  </Button>
                  {editingServerName && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void onDeleteServer(editingServerName).then(() => setMcpView('list')).catch(() => undefined)}
                      disabled={editor.isSaving}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('mcpConfig.deleteServer')}
                    </Button>
                  )}
                </div>

                <div>
                  <h3 className="text-2xl font-semibold">{t('mcpConfig.customTitle')}</h3>
                  <a className="mt-2 inline-flex items-center text-sm text-primary" href="https://modelcontextprotocol.io/docs" target="_blank" rel="noreferrer">
                    {t('mcpConfig.docs')}
                    <ExternalLink className="ml-1 h-3.5 w-3.5" />
                  </a>
                </div>

                <div className="rounded-md border border-border p-4">
                  <Label htmlFor="mcp-server-name">{t('mcpConfig.name')}</Label>
                  <Input id="mcp-server-name" className="mt-2" value={serverDraft.name} onChange={(event) => updateServerDraft({ name: event.target.value })} placeholder={t('mcpConfig.namePlaceholder')} />
                </div>

                <Tabs value={serverDraft.mode} onValueChange={(value) => updateServerDraft({ mode: value as McpTransportMode })}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="stdio">STDIO</TabsTrigger>
                    <TabsTrigger value="http">Streamable HTTP</TabsTrigger>
                  </TabsList>
                </Tabs>

                {serverDraft.mode === 'stdio' ? (
                  <div className="space-y-4 rounded-md border border-border p-4">
                    <div>
                      <Label htmlFor="mcp-command">{t('mcpConfig.command')}</Label>
                      <Input id="mcp-command" className="mt-2" value={serverDraft.command} onChange={(event) => updateServerDraft({ command: event.target.value })} placeholder="npx" />
                    </div>
                    <div>
                      <Label>{t('mcpConfig.arguments')}</Label>
                      <div className="mt-2 space-y-2">
                        {serverDraft.args.map((arg, index) => (
                          <div key={`${index}-${arg}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <Input value={arg} onChange={(event) => updateServerDraft({ args: serverDraft.args.map((entry, entryIndex) => entryIndex === index ? event.target.value : entry) })} />
                            <Button type="button" variant="ghost" size="icon" onClick={() => updateServerDraft({ args: serverDraft.args.filter((_entry, entryIndex) => entryIndex !== index) })}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                        <Button type="button" variant="secondary" className="w-full" onClick={() => updateServerDraft({ args: [...serverDraft.args, ''] })}>
                          <Plus className="mr-2 h-4 w-4" />
                          {t('mcpConfig.addArgument')}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <Label>{t('mcpConfig.envVars')}</Label>
                      <div className="mt-2">{renderPairRows('env', t('mcpConfig.keyPlaceholder'), t('mcpConfig.valuePlaceholder'))}</div>
                    </div>
                    <div>
                      <Label>{t('mcpConfig.envPassthrough')}</Label>
                      <div className="mt-2 space-y-2">
                        {serverDraft.envPassthrough.map((value, index) => (
                          <div key={`${index}-${value}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <Input value={value} onChange={(event) => updateServerDraft({ envPassthrough: serverDraft.envPassthrough.map((entry, entryIndex) => entryIndex === index ? event.target.value : entry) })} placeholder="OPENAI_API_KEY" />
                            <Button type="button" variant="ghost" size="icon" onClick={() => updateServerDraft({ envPassthrough: serverDraft.envPassthrough.filter((_entry, entryIndex) => entryIndex !== index) })}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                        <Button type="button" variant="secondary" className="w-full" onClick={() => updateServerDraft({ envPassthrough: [...serverDraft.envPassthrough, ''] })}>
                          <Plus className="mr-2 h-4 w-4" />
                          {t('mcpConfig.addVariable')}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="mcp-cwd">{t('mcpConfig.cwd')}</Label>
                      <Input id="mcp-cwd" className="mt-2" value={serverDraft.cwd} onChange={(event) => updateServerDraft({ cwd: event.target.value })} placeholder="/data/workspace" />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 rounded-md border border-border p-4">
                    <div>
                      <Label htmlFor="mcp-url">URL</Label>
                      <Input id="mcp-url" className="mt-2" value={serverDraft.url} onChange={(event) => updateServerDraft({ url: event.target.value })} placeholder="https://mcp.example.com/mcp" />
                    </div>
                    <div>
                      <Label>{t('mcpConfig.oauthMode')}</Label>
                      <Tabs value={serverDraft.auth} onValueChange={(value) => updateServerDraft({ auth: value as McpServerDraft['auth'] })} className="mt-2">
                        <TabsList className="grid w-full grid-cols-2">
                          <TabsTrigger value="none">{t('mcpConfig.oauthNone')}</TabsTrigger>
                          <TabsTrigger value="oauth">{t('mcpConfig.oauthEnabled')}</TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </div>
                    <div>
                      <Label htmlFor="mcp-bearer">{t('mcpConfig.bearerEnv')}</Label>
                      <Input
                        id="mcp-bearer"
                        className="mt-2"
                        value={serverDraft.bearerTokenValue}
                        onChange={(event) => updateServerDraft({ bearerTokenValue: event.target.value })}
                        placeholder={serverDraft.bearerTokenEnv ? t('mcpConfig.bearerTokenPlaceholderExisting') : t('mcpConfig.bearerTokenPlaceholder')}
                        type="password"
                        autoComplete="off"
                      />
                      <p className="mt-2 break-all text-xs text-muted-foreground">
                        {t('mcpConfig.bearerEnvStoredAs', { key: bearerTokenEnvKey })}
                      </p>
                    </div>
                    <div>
                      <Label>{t('mcpConfig.headers')}</Label>
                      <div className="mt-2">{renderPairRows('headers', t('mcpConfig.keyPlaceholder'), t('mcpConfig.valuePlaceholder'))}</div>
                    </div>
                    <div>
                      <Label>{t('mcpConfig.headersFromEnv')}</Label>
                      <div className="mt-2">{renderPairRows('headersFromEnv', t('mcpConfig.keyPlaceholder'), t('mcpConfig.valuePlaceholder'))}</div>
                    </div>
                  </div>
                )}

                <div className="flex justify-end">
                  <Button
                    type="button"
                    onClick={() => void onSaveServer(serverDraft, editingServerName).then(() => setMcpView('list')).catch(() => undefined)}
                    disabled={editor.isSaving}
                  >
                    {editor.isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    {t('mcpConfig.saveServer')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
    </SettingsAccordionCard>
    <Dialog open={Boolean(toolsDialog.server)} onOpenChange={(open) => { if (!open) closeToolsDialog(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('mcpConfig.cachedToolsTitle', { server: toolsDialog.server || '' })}</DialogTitle>
          <DialogDescription>{t('mcpConfig.cachedToolsDescription')}</DialogDescription>
        </DialogHeader>
        {toolsDialog.isLoading ? (
          <div className="flex items-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('mcpConfig.loadingTools')}
          </div>
        ) : toolsDialog.error ? (
          <p className="text-sm text-destructive">{toolsDialog.error}</p>
        ) : toolsDialog.tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('mcpConfig.noCachedTools')}</p>
        ) : (
          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="space-y-3">
              {toolsDialog.tools.map((tool) => (
                <div key={tool.name} className="rounded-md border border-border p-3">
                  <div className="font-mono text-sm font-semibold">{tool.name}</div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {tool.description || t('mcpConfig.noToolDescription')}
                  </p>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}

function EmailAccountsCard({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (isOpen: boolean) => void }) {
  const t = useTranslations('settings.emailAccounts');
  const searchParams = useSearchParams();
  const handledEmailOAuthReturn = useRef(false);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { readFrom: string; sendTo: string }>>({});
  const [emailMode, setEmailMode] = useState<EmailMode>('unknown');
  const [oauthDraft, setOauthDraft] = useState<EmailOAuthDraft>({
    googleClientId: '',
    googleClientSecret: '',
    microsoftClientId: '',
    microsoftClientSecret: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isOAuthLoading, setIsOAuthLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOAuthEnv = useCallback(async () => {
    setIsOAuthLoading(true);
    try {
      const response = await fetch('/api/integrations/env?scope=integrations', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadOAuthSettings'));
      const entries = (payload.data?.entries || []) as EnvEntry[];
      const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
      setOauthDraft({
        googleClientId: byKey.get('GOOGLE_OAUTH_CLIENT_ID') || '',
        googleClientSecret: byKey.get('GOOGLE_OAUTH_CLIENT_SECRET') || '',
        microsoftClientId: byKey.get('MICROSOFT_OAUTH_CLIENT_ID') || '',
        microsoftClientSecret: byKey.get('MICROSOFT_OAUTH_CLIENT_SECRET') || '',
      });
    } catch (oauthLoadError) {
      setError(oauthLoadError instanceof Error ? oauthLoadError.message : t('errors.loadOAuthSettings'));
    } finally {
      setIsOAuthLoading(false);
    }
  }, [t]);

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/email/accounts', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadAccounts'));
      const nextAccounts = (payload.data?.accounts || []) as EmailAccount[];
      setEmailMode(payload.data?.mode === 'managed' ? 'managed' : 'local');
      setAccounts(nextAccounts);
      setDrafts(Object.fromEntries(nextAccounts.map((account) => [
        account.id,
        {
          readFrom: account.policy.readFrom.join('\n'),
          sendTo: account.policy.sendTo.join('\n'),
        },
      ])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.loadAccounts'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const clearEmailOAuthParams = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('emailOAuth');
    url.searchParams.delete('emailOAuthError');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadAccounts();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadAccounts]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (emailMode === 'local') {
        void loadOAuthEnv();
        return;
      }
      if (emailMode === 'managed') {
        setOauthDraft({
          googleClientId: '',
          googleClientSecret: '',
          microsoftClientId: '',
          microsoftClientSecret: '',
        });
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [emailMode, loadOAuthEnv]);

  useEffect(() => {
    if (handledEmailOAuthReturn.current) return;
    const emailOAuthStatus = searchParams.get('emailOAuth');
    const emailOAuthError = searchParams.get('emailOAuthError');
    if (emailOAuthStatus === 'connected') {
      handledEmailOAuthReturn.current = true;
      const timeout = window.setTimeout(() => {
        setMessage(t('messages.accountConnected'));
        setError(null);
        void loadAccounts();
        clearEmailOAuthParams();
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    if (emailOAuthStatus === 'failed' || emailOAuthError) {
      handledEmailOAuthReturn.current = true;
      const timeout = window.setTimeout(() => {
        setError(emailOAuthError || t('errors.oauthFailed'));
        setMessage(null);
        clearEmailOAuthParams();
      }, 0);
      return () => window.clearTimeout(timeout);
    }
  }, [clearEmailOAuthParams, loadAccounts, searchParams, t]);

  const persistOAuthProvider = async (provider: 'google' | 'microsoft') => {
    const keys = provider === 'google'
      ? {
          clientId: 'GOOGLE_OAUTH_CLIENT_ID',
          clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
          clientIdValue: oauthDraft.googleClientId.trim(),
          clientSecretValue: oauthDraft.googleClientSecret.trim(),
        }
      : {
          clientId: 'MICROSOFT_OAUTH_CLIENT_ID',
          clientSecret: 'MICROSOFT_OAUTH_CLIENT_SECRET',
          clientIdValue: oauthDraft.microsoftClientId.trim(),
          clientSecretValue: oauthDraft.microsoftClientSecret.trim(),
        };
    if (!keys.clientIdValue || !keys.clientSecretValue) {
      throw new Error(t('errors.oauthCredentialsRequired'));
    }
    const currentResponse = await fetch('/api/integrations/env?scope=integrations', { cache: 'no-store' });
    const currentPayload = await currentResponse.json();
    if (!currentResponse.ok || !currentPayload.success) throw new Error(currentPayload.error || t('errors.loadIntegrationKeys'));
    const currentEntries = (currentPayload.data?.entries || []) as EnvEntry[];
    const nextEntries = currentEntries
      .filter((entry) => entry.key !== keys.clientId && entry.key !== keys.clientSecret)
      .map((entry) => ({ key: entry.key, value: entry.value }));
    nextEntries.push({ key: keys.clientId, value: keys.clientIdValue });
    nextEntries.push({ key: keys.clientSecret, value: keys.clientSecretValue });
    const saveResponse = await fetch('/api/integrations/env?scope=integrations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'integrations', mode: 'kv', entries: nextEntries }),
    });
    const savePayload = await saveResponse.json();
    if (!saveResponse.ok || !savePayload.success) throw new Error(savePayload.error || t('errors.saveOAuthSettings'));
    await loadOAuthEnv();
  };

  const saveOAuthProvider = async (provider: 'google' | 'microsoft') => {
    setActiveAction(`oauth-save:${provider}`);
    setError(null);
    setMessage(null);
    try {
      await persistOAuthProvider(provider);
      setMessage(t('messages.oauthSettingsSaved', { provider: provider === 'google' ? t('providers.google') : t('providers.microsoft') }));
    } catch (saveOAuthError) {
      setError(saveOAuthError instanceof Error ? saveOAuthError.message : t('errors.saveOAuthSettings'));
    } finally {
      setActiveAction(null);
    }
  };

  const startOAuth = async (provider: 'google' | 'microsoft') => {
    if (accounts.length > 0) return;
    setActiveAction(`oauth:${provider}`);
    setError(null);
    setMessage(null);
    try {
      if (emailMode !== 'managed') {
        await persistOAuthProvider(provider);
      }
      const response = await fetch('/api/email/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.startOAuth'));
      if (!payload.data?.authorizationUrl) throw new Error(t('errors.missingAuthorizationUrl'));
      window.location.assign(payload.data.authorizationUrl);
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : t('errors.startOAuth'));
    } finally {
      setActiveAction(null);
    }
  };

  const savePolicy = async (accountId: string) => {
    setActiveAction(`policy:${accountId}`);
    setError(null);
    setMessage(null);
    try {
      const draft = drafts[accountId] || { readFrom: '', sendTo: '' };
      const response = await fetch(`/api/email/accounts/${encodeURIComponent(accountId)}/policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          readFrom: draft.readFrom.split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean),
          sendTo: draft.sendTo.split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean),
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.savePolicy'));
      setMessage(t('messages.policySaved'));
      await loadAccounts();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.savePolicy'));
    } finally {
      setActiveAction(null);
    }
  };

  const disconnect = async (accountId: string) => {
    setActiveAction(`disconnect:${accountId}`);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/email/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.disconnect'));
      setMessage(t('messages.accountDisconnected'));
      await loadAccounts();
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : t('errors.disconnect'));
    } finally {
      setActiveAction(null);
    }
  };

  const isManagedEmailMode = emailMode === 'managed';
  const isLocalEmailMode = emailMode === 'local';
  const hasConnectedEmailAccount = accounts.length > 0;
  const oauthActionDisabled = activeAction !== null || isOAuthLoading || emailMode === 'unknown' || hasConnectedEmailAccount;
  const providerLabel = (provider: string) => {
    if (provider === 'google') return t('providers.google');
    if (provider === 'microsoft') return t('providers.microsoft');
    return provider;
  };
  const statusLabel = (status: string) => {
    if (status === 'active') return t('statuses.active');
    if (status === 'expired') return t('statuses.expired');
    if (status === 'revoked') return t('statuses.revoked');
    return status;
  };
  const summaryItems = [
    isLoading ? t('loadingSummary') : t('summary', { count: accounts.length }),
    error ? t('errorSummary') : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <SettingsAccordionCard
      title={t('title')}
      description={t('description')}
      icon={Mail}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={summaryItems}
      contentClassName="space-y-4"
    >
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => void loadAccounts()} disabled={isLoading}>
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('refresh')}
          </Button>
        </div>
        {error && <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        {message && <div className="border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{message}</div>}
        {!hasConnectedEmailAccount && (
          <div className={`grid gap-3 ${SHOW_MICROSOFT_EMAIL_OAUTH ? 'lg:grid-cols-2' : 'lg:grid-cols-1'}`}>
            <div className="space-y-3 border border-border p-4">
              <div>
                <h3 className="text-base font-semibold">{t('oauth.googleTitle')}</h3>
                <p className="text-sm text-muted-foreground">{isManagedEmailMode ? t('oauth.googleManagedDescription') : t('oauth.googleLocalDescription')}</p>
              </div>
              {isLocalEmailMode && (
                <>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="email-google-client-id">{t('oauth.clientId')}</Label>
                    <Input
                      id="email-google-client-id"
                      className="font-mono text-xs"
                      value={oauthDraft.googleClientId}
                      onChange={(event) => setOauthDraft((current) => ({ ...current, googleClientId: event.target.value }))}
                      placeholder="GOOGLE_OAUTH_CLIENT_ID"
                      disabled={isOAuthLoading || activeAction !== null}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="email-google-client-secret">{t('oauth.clientSecret')}</Label>
                    <Input
                      id="email-google-client-secret"
                      type="password"
                      className="font-mono text-xs"
                      value={oauthDraft.googleClientSecret}
                      onChange={(event) => setOauthDraft((current) => ({ ...current, googleClientSecret: event.target.value }))}
                      placeholder="GOOGLE_OAUTH_CLIENT_SECRET"
                      disabled={isOAuthLoading || activeAction !== null}
                    />
                  </div>
                </>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {isLocalEmailMode && (
                  <Button type="button" variant="outline" onClick={() => void saveOAuthProvider('google')} disabled={isOAuthLoading || activeAction !== null}>
                    {activeAction === 'oauth-save:google' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    {t('save')}
                  </Button>
                )}
                <Button type="button" onClick={() => void startOAuth('google')} disabled={oauthActionDisabled}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {t('connect')}
                </Button>
              </div>
            </div>
            {/* Microsoft OAuth UI is intentionally disabled until the provider is configured and active. */}
            {SHOW_MICROSOFT_EMAIL_OAUTH && (
              <div className="space-y-3 border border-border p-4">
                <div>
                  <h3 className="text-base font-semibold">{t('oauth.microsoftTitle')}</h3>
                  <p className="text-sm text-muted-foreground">{isManagedEmailMode ? t('oauth.microsoftManagedDescription') : t('oauth.microsoftLocalDescription')}</p>
                </div>
                {isLocalEmailMode && (
                  <>
                    <div className="space-y-2">
                      <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="email-microsoft-client-id">{t('oauth.clientId')}</Label>
                      <Input
                        id="email-microsoft-client-id"
                        className="font-mono text-xs"
                        value={oauthDraft.microsoftClientId}
                        onChange={(event) => setOauthDraft((current) => ({ ...current, microsoftClientId: event.target.value }))}
                        placeholder="MICROSOFT_OAUTH_CLIENT_ID"
                        disabled={isOAuthLoading || activeAction !== null}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="email-microsoft-client-secret">{t('oauth.clientSecret')}</Label>
                      <Input
                        id="email-microsoft-client-secret"
                        type="password"
                        className="font-mono text-xs"
                        value={oauthDraft.microsoftClientSecret}
                        onChange={(event) => setOauthDraft((current) => ({ ...current, microsoftClientSecret: event.target.value }))}
                        placeholder="MICROSOFT_OAUTH_CLIENT_SECRET"
                        disabled={isOAuthLoading || activeAction !== null}
                      />
                    </div>
                  </>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  {isLocalEmailMode && (
                    <Button type="button" variant="outline" onClick={() => void saveOAuthProvider('microsoft')} disabled={isOAuthLoading || activeAction !== null}>
                      {activeAction === 'oauth-save:microsoft' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      {t('save')}
                    </Button>
                  )}
                  <Button type="button" onClick={() => void startOAuth('microsoft')} disabled={oauthActionDisabled}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {t('connect')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {accounts.length === 0 ? (
          <div className="border border-border p-4 text-sm text-muted-foreground">{t('noAccounts')}</div>
        ) : (
          accounts.map((account) => {
            const draft = drafts[account.id] || { readFrom: '', sendTo: '' };
            return (
              <div key={account.id} className="space-y-3 border border-border p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">{account.emailAddress}</h3>
                      <Badge variant="outline">{providerLabel(account.provider)}</Badge>
                      <Badge variant={account.status === 'active' ? 'default' : 'secondary'}>{statusLabel(account.status)}</Badge>
                    </div>
                    {account.displayName && <p className="text-sm text-muted-foreground">{account.displayName}</p>}
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void disconnect(account.id)} disabled={activeAction !== null}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('disconnect')}
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">{t('policy.readFromLabel')}</Label>
                    <textarea
                      className="mt-2 min-h-28 w-full border border-input bg-background px-3 py-2 text-sm"
                      value={draft.readFrom}
                      onChange={(event) => setDrafts((current) => ({ ...current, [account.id]: { ...draft, readFrom: event.target.value } }))}
                      placeholder={t('policy.readFromPlaceholder')}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('policy.readFromDescription')}
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">{t('policy.sendToLabel')}</Label>
                    <textarea
                      className="mt-2 min-h-28 w-full border border-input bg-background px-3 py-2 text-sm"
                      value={draft.sendTo}
                      onChange={(event) => setDrafts((current) => ({ ...current, [account.id]: { ...draft, sendTo: event.target.value } }))}
                      placeholder={t('policy.sendToPlaceholder')}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('policy.sendToDescription')}
                    </p>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="button" onClick={() => void savePolicy(account.id)} disabled={activeAction !== null}>
                    <Save className="mr-2 h-4 w-4" />
                    {t('savePolicy')}
                  </Button>
                </div>
              </div>
            );
          })
        )}
    </SettingsAccordionCard>
  );
}

export function IntegrationsSettingsClient({
  isAdmin = false,
  userName = '',
  userEmail = '',
  isManagedControlPlane = false,
}: {
  isAdmin?: boolean;
  userName?: string;
  userEmail?: string;
  isManagedControlPlane?: boolean;
}) {
  const t = useTranslations('settings');
  const searchParams = useSearchParams();

  const requestedTab = searchParams.get('tab');
  const initialTab = getInitialSettingsTab(requestedTab);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialTab);
  const [loadedTabs, setLoadedTabs] = useState<Set<SettingsTab>>(() => new Set([initialTab]));
  const { activeTabOverride } = useHintContext();
  const integrationsInitialLoadStartedRef = useRef(false);

  const effectiveTab = normalizeSettingsTab(activeTabOverride) ?? settingsTab;
  const shouldRenderTab = (tab: SettingsTab) => effectiveTab === tab || loadedTabs.has(tab);
  const renderLazyTabContent = (
    tab: SettingsTab,
    children: ReactNode,
    options: { id?: string } = {},
  ) => {
    const shouldRender = shouldRenderTab(tab);

    return (
      <TabsContent
        value={tab}
        className={SETTINGS_TAB_CONTENT_CLASS}
        id={options.id}
        forceMount={shouldRender ? true : undefined}
      >
        {shouldRender ? children : null}
      </TabsContent>
    );
  };
  const handleTabChange = (value: string) => {
    const nextTab = normalizeSettingsTab(value);
    if (!nextTab) return;

    setSettingsTab(nextTab);
    setLoadedTabs((current) => {
      if (current.has(nextTab)) return current;
      const nextTabs = new Set(current);
      nextTabs.add(nextTab);
      return nextTabs;
    });
    try {
      window.localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, nextTab);
    } catch {
      // Settings still work if persistent browser storage is unavailable.
    }

    const url = new URL(window.location.href);
    url.searchParams.set('tab', nextTab);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const [editors, setEditors] = useState<Record<EnvScope, ScopeEditorState>>({
    integrations: INITIAL_SCOPE_STATE('integrations'),
    agents: INITIAL_SCOPE_STATE('agents'),
  });
  const [mcpEditor, setMcpEditor] = useState<McpEditorState>(INITIAL_MCP_STATE);
  const [envCardOpenByScope, setEnvCardOpenByScope] = useState<EnvCardOpenState>(DEFAULT_ENV_CARD_OPEN_STATE);
  const [integrationsSectionOpenById, setIntegrationsSectionOpenById] = useState<IntegrationsSectionOpenState>(DEFAULT_INTEGRATIONS_SECTION_OPEN_STATE);

  const loadState = useCallback(async (scope: EnvScope) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        isLoading: true,
        error: null,
      },
    }));

    try {
      const response = await fetch(`/api/integrations/env?scope=${scope}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('envCard.errors.loadEnvFile'));
      }

      const nextState: EnvState = payload.data;
      const nextDraftEntries = toDraftEntries(scope, nextState.entries);
      setEditors((current) => ({
        ...current,
        [scope]: {
          ...current[scope],
          state: nextState,
          draftEntries: nextDraftEntries,
          rawContent: nextState.rawContent,
          isLoading: false,
          error: null,
          success: null,
          secretVisibilityById: buildHiddenState(nextDraftEntries),
        },
      }));
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : t('envCard.errors.loadEnvFile');
      setEditors((current) => ({
        ...current,
        [scope]: {
          ...current[scope],
          isLoading: false,
          error: message,
        },
      }));
    }
  }, [t]);

  const loadMcpConfig = useCallback(async () => {
    setMcpEditor((current) => ({
      ...current,
      isLoading: true,
      error: null,
    }));

    try {
      const response = await fetch('/api/integrations/mcp-config', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('mcpConfig.errors.load'));
      }

      const nextState: McpConfigState = payload.data;
      setMcpEditor((current) => ({
        ...current,
        state: nextState,
        rawContent: nextState.rawContent,
        isLoading: false,
        error: null,
        success: null,
      }));
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : t('mcpConfig.errors.load');
      setMcpEditor((current) => ({
        ...current,
        isLoading: false,
        error: message,
      }));
    }
  }, [t]);

  const loadMcpStatus = useCallback(async () => {
    setMcpEditor((current) => ({
      ...current,
      isStatusLoading: true,
    }));

    try {
      const response = await fetch('/api/integrations/mcp-status', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('mcpConfig.errors.status'));
      }
      setMcpEditor((current) => ({
        ...current,
        status: payload.data,
        isStatusLoading: false,
      }));
    } catch (statusError) {
      const message = statusError instanceof Error ? statusError.message : t('mcpConfig.errors.status');
      setMcpEditor((current) => ({
        ...current,
        isStatusLoading: false,
        error: message,
      }));
    }
  }, [t]);

  const pollMcpAuthorizationStatus = useCallback(async (server: string) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 2000 : 3000));

      try {
        const response = await fetch('/api/integrations/mcp-status', {
          credentials: 'include',
          cache: 'no-store',
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) continue;

        const nextStatus = payload.data as McpStatusState;
        const oauth = nextStatus.oauth.find((entry) => entry.serverName === server);
        const authorized = Boolean(oauth?.authorized);
        setMcpEditor((current) => ({
          ...current,
          status: nextStatus,
          success: authorized ? t('mcpConfig.authorizationCompleted', { server }) : current.success,
        }));

        if (authorized) return;
      } catch {
        // Keep polling; transient errors should not interrupt the OAuth window flow.
      }
    }
  }, [t]);

  const runMcpServerAction = useCallback(async (server: string, action: McpServerAction) => {
    setMcpEditor((current) => ({
      ...current,
      activeServerAction: `${server}:${action}`,
      error: null,
      success: null,
    }));

    try {
      if (action === 'authorize') {
        const authWindow = window.open('about:blank', '_blank');
        if (!authWindow) {
          throw new Error(t('mcpConfig.errors.popupBlocked'));
        }
        try {
          authWindow.opener = null;
        } catch {
          // Some browsers expose opener as read-only; the OAuth route itself is same-origin until it redirects.
        }
        authWindow.location.href = `/api/mcp/oauth/start?server=${encodeURIComponent(server)}`;

        setMcpEditor((current) => ({
          ...current,
          activeServerAction: null,
          success: t('mcpConfig.authorizationStarted', { server, count: 0 }),
        }));
        void pollMcpAuthorizationStatus(server);
        return;
      }

      const response = await fetch('/api/integrations/mcp-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ server, action }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('mcpConfig.errors.action'));
      }

      const successKey = action === 'test'
        ? 'mcpConfig.testSucceeded'
        : action === 'enable'
          ? 'mcpConfig.enabledSaved'
          : action === 'disable'
            ? 'mcpConfig.disabledSaved'
            : 'mcpConfig.authCleared';

      setMcpEditor((current) => ({
        ...current,
        activeServerAction: null,
        success: t(successKey, { server, count: payload.data?.toolCount ?? 0 }),
      }));
      await Promise.all([loadMcpConfig(), loadMcpStatus()]);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : t('mcpConfig.errors.action');
      setMcpEditor((current) => ({
        ...current,
        activeServerAction: null,
        error: message,
      }));
      await loadMcpStatus();
    }
  }, [loadMcpConfig, loadMcpStatus, pollMcpAuthorizationStatus, t]);

  useEffect(() => {
    if (effectiveTab !== 'integrations' || integrationsInitialLoadStartedRef.current) {
      return;
    }

    integrationsInitialLoadStartedRef.current = true;
    startTransition(() => {
      void Promise.all([
        ...SCOPE_CARDS.map((card) => loadState(card.scope)),
        loadMcpConfig(),
        loadMcpStatus(),
      ]);
    });
  }, [effectiveTab, loadMcpConfig, loadMcpStatus, loadState]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    const nextTab = normalizeSettingsTab(tab) ?? getStoredSettingsTab() ?? DEFAULT_SETTINGS_TAB;
    startTransition(() => {
      setSettingsTab(nextTab);
      setLoadedTabs((current) => {
        if (current.has(nextTab)) return current;
        const nextTabs = new Set(current);
        nextTabs.add(nextTab);
        return nextTabs;
      });
    });
  }, [searchParams]);

  useEffect(() => {
    startTransition(() => {
      setEnvCardOpenByScope(getStoredEnvCardOpenState());
      setIntegrationsSectionOpenById(getStoredIntegrationsSectionOpenState());
    });
  }, []);

  const saveScope = async (scope: EnvScope, payload: { mode: 'kv'; entries: Array<{ key: string; value: string }> } | { mode: 'raw'; rawContent: string }) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        isSaving: true,
        error: null,
        success: null,
      },
    }));

    try {
      const response = await fetch('/api/integrations/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          scope,
          ...payload,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || t('envCard.errors.saveEnvFile'));
      }

      const nextState: EnvState = result.data;
      const nextDraftEntries = toDraftEntries(scope, nextState.entries);
      setEditors((current) => ({
        ...current,
        [scope]: {
          ...current[scope],
          state: nextState,
          draftEntries: nextDraftEntries,
          rawContent: nextState.rawContent,
          isSaving: false,
          error: null,
          success: payload.mode === 'raw' ? t('envCard.rawSaved') : t('envCard.saved'),
          secretVisibilityById: buildHiddenState(nextDraftEntries),
        },
      }));
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : t('envCard.errors.saveEnvFile');
      setEditors((current) => ({
        ...current,
        [scope]: {
          ...current[scope],
          isSaving: false,
          error: message,
        },
      }));
    }
  };

  const saveMcpConfig = async () => {
    setMcpEditor((current) => ({
      ...current,
      isSaving: true,
      error: null,
      success: null,
    }));

    try {
      const response = await fetch('/api/integrations/mcp-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rawContent: mcpEditor.rawContent,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || t('mcpConfig.errors.save'));
      }

      const nextState: McpConfigState = result.data;
      setMcpEditor((current) => ({
        ...current,
        state: nextState,
        rawContent: nextState.rawContent,
        isSaving: false,
        error: null,
        success: t('mcpConfig.saved'),
      }));
      void loadMcpStatus();
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : t('mcpConfig.errors.save');
      setMcpEditor((current) => ({
        ...current,
        isSaving: false,
        error: message,
      }));
      throw saveError;
    }
  };

  const saveMcpServer = async (draft: McpServerDraft, originalName?: string) => {
    try {
      const envEntries = collectMcpEnvEntries(draft);
      if (envEntries.length > 0) {
        const currentEntries = editors.integrations.state?.entries.map((entry) => ({ key: entry.key, value: entry.value })) || [];
        const nextEntriesByKey = new Map(currentEntries.map((entry) => [entry.key, entry]));
        for (const entry of envEntries) {
          nextEntriesByKey.set(entry.key, entry);
        }
        const response = await fetch('/api/integrations/env', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            scope: 'integrations',
            mode: 'kv',
            entries: Array.from(nextEntriesByKey.values()),
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || t('envCard.errors.saveEnvFile'));
        }
        const nextState: EnvState = result.data;
        const nextDraftEntries = toDraftEntries('integrations', nextState.entries);
        setEditors((current) => ({
          ...current,
          integrations: {
            ...current.integrations,
            state: nextState,
            draftEntries: nextDraftEntries,
            rawContent: nextState.rawContent,
            secretVisibilityById: buildHiddenState(nextDraftEntries),
          },
        }));
      }

      const rawContent = updateMcpConfigRawServer(mcpEditor.rawContent, draft, originalName);
      setMcpEditor((current) => ({
        ...current,
        rawContent,
        isSaving: true,
        error: null,
        success: null,
      }));

      const response = await fetch('/api/integrations/mcp-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ rawContent }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || t('mcpConfig.errors.save'));
      }

      const nextState: McpConfigState = result.data;
      setMcpEditor((current) => ({
        ...current,
        state: nextState,
        rawContent: nextState.rawContent,
        isSaving: false,
        error: null,
        success: t('mcpConfig.serverSaved'),
      }));
      await loadMcpStatus();
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : t('mcpConfig.errors.save');
      setMcpEditor((current) => ({
        ...current,
        isSaving: false,
        error: message,
      }));
      throw saveError;
    }
  };

  const deleteMcpServer = async (serverName: string) => {
    try {
      const rawContent = deleteMcpConfigRawServer(mcpEditor.rawContent, serverName);
      setMcpEditor((current) => ({
        ...current,
        rawContent,
        isSaving: true,
        error: null,
        success: null,
      }));

      const response = await fetch('/api/integrations/mcp-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ rawContent }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || t('mcpConfig.errors.save'));
      }

      const nextState: McpConfigState = result.data;
      setMcpEditor((current) => ({
        ...current,
        state: nextState,
        rawContent: nextState.rawContent,
        isSaving: false,
        error: null,
        success: t('mcpConfig.serverDeleted'),
      }));
      await loadMcpStatus();
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : t('mcpConfig.errors.save');
      setMcpEditor((current) => ({
        ...current,
        isSaving: false,
        error: message,
      }));
      throw deleteError;
    }
  };

  const setActiveTab = (scope: EnvScope, value: 'kv' | 'raw') => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        activeTab: value,
      },
    }));
  };

  const setEnvCardOpen = (scope: EnvScope, isOpen: boolean) => {
    setEnvCardOpenByScope((current) => {
      const nextState = {
        ...current,
        [scope]: isOpen,
      };
      try {
        window.localStorage.setItem(ENV_CARD_OPEN_STORAGE_KEY, JSON.stringify(nextState));
      } catch {
        // Settings still work if persistent browser storage is unavailable.
      }
      return nextState;
    });
  };

  const setIntegrationsSectionOpen = (sectionId: IntegrationsSectionId, isOpen: boolean) => {
    setIntegrationsSectionOpenById((current) => {
      const nextState = {
        ...current,
        [sectionId]: isOpen,
      };
      try {
        window.localStorage.setItem(INTEGRATIONS_SECTION_OPEN_STORAGE_KEY, JSON.stringify(nextState));
      } catch {
        // Settings still work if persistent browser storage is unavailable.
      }
      return nextState;
    });
  };

  const updateDraftEntry = (scope: EnvScope, index: number, patch: Partial<DraftEntry>) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        draftEntries: current[scope].draftEntries.map((entry, currentIndex) =>
          currentIndex === index ? { ...entry, ...patch } : entry
        ),
      },
    }));
  };

  const toggleSecretVisibility = (scope: EnvScope, entryId: string) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        secretVisibilityById: {
          ...current[scope].secretVisibilityById,
          [entryId]: !current[scope].secretVisibilityById[entryId],
        },
      },
    }));
  };

  const addDraftEntry = (scope: EnvScope) => {
    const entry = createDraftEntry();
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        draftEntries: [...current[scope].draftEntries, entry],
        secretVisibilityById: {
          ...current[scope].secretVisibilityById,
          [entry.id]: false,
        },
      },
    }));
  };

  const removeDraftEntry = (scope: EnvScope, index: number) => {
    setEditors((current) => {
      const editor = current[scope];
      const target = editor.draftEntries[index];
      if (editor.draftEntries.length <= 1) {
        const fallback = createDraftEntry();
        return {
          ...current,
          [scope]: {
            ...editor,
            draftEntries: [fallback],
            secretVisibilityById: { [fallback.id]: false },
          },
        };
      }

      const nextVisibility = { ...editor.secretVisibilityById };
      if (target) {
        delete nextVisibility[target.id];
      }

      return {
        ...current,
        [scope]: {
          ...editor,
          draftEntries: editor.draftEntries.filter((_, currentIndex) => currentIndex !== index),
          secretVisibilityById: nextVisibility,
        },
      };
    });
  };

  const setRawContent = (scope: EnvScope, value: string) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        rawContent: value,
      },
    }));
  };

  const saveKeyValue = async (scope: EnvScope) => {
    const editor = editors[scope];
    await saveScope(scope, {
      mode: 'kv',
      entries: editor.draftEntries
        .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
        .filter((entry) => entry.key.length > 0),
    });
  };

  const saveRaw = async (scope: EnvScope) => {
    await saveScope(scope, {
      mode: 'raw',
      rawContent: editors[scope].rawContent,
    });
  };

  const setMcpRawContent = (value: string) => {
    setMcpEditor((current) => ({
      ...current,
      rawContent: value,
    }));
  };

  const activeSettingsTab = SETTINGS_TAB_ITEMS.find((tab) => tab.value === effectiveTab) ?? SETTINGS_TAB_ITEMS[0];

  return (
    <div className="mx-auto w-full max-w-6xl overflow-x-hidden px-3 py-4 sm:px-6 sm:py-6">
      <Tabs
        value={effectiveTab}
        onValueChange={handleTabChange}
        className="min-w-0 space-y-4"
      >
        <div className="lg:hidden">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" className="h-11 w-full justify-between px-3">
                <span className="flex min-w-0 items-center gap-2">
                  <Menu className="h-4 w-4" aria-hidden="true" />
                  <span className="min-w-0 truncate">{t(activeSettingsTab.labelKey)}</span>
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={8} className="max-h-[min(26rem,calc(100dvh-8rem))] w-[calc(100vw-1.5rem)] max-w-sm overflow-y-auto">
              <DropdownMenuRadioGroup value={effectiveTab} onValueChange={handleTabChange}>
                {SETTINGS_TAB_ITEMS.map((tab) => (
                  <DropdownMenuRadioItem key={tab.value} value={tab.value} className="min-h-10">
                    {t(tab.labelKey)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <TabsList className="hidden h-auto w-full grid-cols-8 gap-2 bg-transparent p-0 lg:grid">
          {SETTINGS_TAB_ITEMS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className={SETTINGS_TAB_TRIGGER_CLASS}>
              <span className="min-w-0 truncate">{t(tab.labelKey)}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {renderLazyTabContent('general',
          <GeneralSettingsPanel
            userName={userName}
            userEmail={userEmail}
            isManagedControlPlane={isManagedControlPlane}
          />,
        )}

        {renderLazyTabContent('integrations',
          <>
            <SearchIntegrationCard
              isOpen={integrationsSectionOpenById.search}
              onOpenChange={(isOpen) => setIntegrationsSectionOpen('search', isOpen)}
              onEnvSaved={() => loadState('integrations')}
            />
            <ConnectedAppsPanel
              isOpen={integrationsSectionOpenById.connectedApps}
              onOpenChange={(isOpen) => setIntegrationsSectionOpen('connectedApps', isOpen)}
            />
            <EmailAccountsCard
              isOpen={integrationsSectionOpenById.emailAccounts}
              onOpenChange={(isOpen) => setIntegrationsSectionOpen('emailAccounts', isOpen)}
            />
            <McpConfigCard
              isOpen={integrationsSectionOpenById.mcpConfig}
              onOpenChange={(isOpen) => setIntegrationsSectionOpen('mcpConfig', isOpen)}
              editor={mcpEditor}
              onLoad={loadMcpConfig}
              onLoadStatus={loadMcpStatus}
              onServerAction={runMcpServerAction}
              onSaveServer={saveMcpServer}
              onDeleteServer={deleteMcpServer}
              onRawChange={setMcpRawContent}
              onSave={saveMcpConfig}
            />
            {SCOPE_CARDS.map((card) => (
              <EnvEditorCard
                key={card.scope}
                card={card}
                editor={editors[card.scope]}
                isOpen={envCardOpenByScope[card.scope]}
                onOpenChange={setEnvCardOpen}
                onActiveTabChange={setActiveTab}
                onLoad={loadState}
                onAddEntry={addDraftEntry}
                onRemoveEntry={removeDraftEntry}
                onUpdateEntry={updateDraftEntry}
                onToggleSecret={toggleSecretVisibility}
                onRawChange={setRawContent}
                onSaveKeyValue={saveKeyValue}
                onSaveRaw={saveRaw}
              />
            ))}
          </>,
          { id: 'onboarding-settings-integrations' },
        )}

        {renderLazyTabContent('agent-settings', <AgentSettingsPanel />)}

        {renderLazyTabContent('workspace', <WorkspaceSettingsPanel isAdmin={isAdmin} />)}

        {renderLazyTabContent('channels', <ChannelsPanel />)}

        {renderLazyTabContent('usage', <UsageAnalyticsClient isAdmin={isAdmin} />, { id: 'onboarding-settings-usage' })}

        {renderLazyTabContent('skills', <SkillsPanel />)}

        {renderLazyTabContent('license', <LicenseActivationPanel defaultEmail={userEmail} />)}
      </Tabs>
    </div>
  );
}
