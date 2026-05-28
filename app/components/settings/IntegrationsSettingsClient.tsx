'use client';

import { useCallback, useEffect, useRef, useState, startTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ExternalLink, Eye, EyeOff, Loader2, Plus, RefreshCw, Save, Settings, Trash2 } from 'lucide-react';

import { AgentSettingsPanel } from '@/app/components/settings/AgentSettingsPanel';
import { GeneralSettingsPanel } from '@/app/components/settings/GeneralSettingsPanel';
import { SkillsPanel } from '@/app/components/settings/SkillsPanel';
import { WorkspaceSettingsPanel } from '@/app/components/settings/WorkspaceSettingsPanel';
import { ConnectedAppsPanel } from '@/app/components/settings/ConnectedAppsPanel';
import { ChannelsPanel } from '@/app/components/settings/ChannelsPanel';
import { UsageAnalyticsClient } from '@/app/components/usage/UsageAnalyticsClient';
import { LicenseActivationPanel } from '@/app/components/license/LicenseActivationPanel';
import { CodeEditor } from '@/app/components/editor/CodeEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

const SETTINGS_TABS = ['general', 'integrations', 'agent-settings', 'workspace', 'usage', 'skills', 'channels', 'license'] as const;
const SETTINGS_TAB_STORAGE_KEY = 'canvas-settings-active-tab';

type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: string | null): value is SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab);
}

function getInitialSettingsTab(requestedTab: string | null): SettingsTab {
  if (isSettingsTab(requestedTab)) return requestedTab;
  if (typeof window === 'undefined') return 'general';

  const storedTab = window.localStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
  return isSettingsTab(storedTab) ? storedTab : 'general';
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
    auth: serverConfig.auth === 'none' ? 'none' : 'oauth',
    bearerTokenEnv: typeof serverConfig.bearerTokenEnv === 'string' ? serverConfig.bearerTokenEnv : '',
    headers,
    headersFromEnv,
  };
}

function createBlankMcpServerDraft(): McpServerDraft {
  return toMcpServerDraft('', { enabled: false, command: '', args: [''], env: {}, envPassthrough: [''], cwd: '' });
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
  return pairs
    .filter((pair) => pair.storeInEnv && pair.envKey.trim() && pair.value)
    .map((pair) => ({ key: pair.envKey.trim(), value: pair.value }));
}

function draftToMcpServerConfig(draft: McpServerDraft): Record<string, unknown> {
  if (draft.mode === 'http') {
    return {
      enabled: draft.enabled,
      url: draft.url.trim(),
      auth: draft.auth,
      ...(draft.bearerTokenEnv.trim() ? { bearerTokenEnv: draft.bearerTokenEnv.trim() } : {}),
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
    onActiveTabChange,
    onAddEntry,
    onLoad,
    onRawChange,
    onRemoveEntry,
    onSaveKeyValue,
    onSaveRaw,
    onToggleSecret,
    onUpdateEntry,
  } = props;

  return (
    <Card id={card.scope === 'integrations' ? 'onboarding-settings-env-integrations' : 'onboarding-settings-env-agents'}>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>{t(`scopes.${card.scope}.title`)}</CardTitle>
        <CardDescription>
          {t(`scopes.${card.scope}.description`)} {t('envCard.fileLocatedAt')}{' '}
          <span className="break-all font-mono">{editor.state?.path || card.emptyPath}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
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
    </Card>
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
  const { editor, onLoad, onLoadStatus, onServerAction, onSaveServer, onDeleteServer, onRawChange, onSave } = props;
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
    <Card id="onboarding-settings-mcp-config">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>{t('mcpConfig.title')}</CardTitle>
        <CardDescription>
          {t('mcpConfig.description')} {t('envCard.fileLocatedAt')}{' '}
          <span className="break-all font-mono">{editor.state?.path || '/data/canvas-agent/mcp.json'}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
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
                      <Label htmlFor="mcp-bearer">{t('mcpConfig.bearerEnv')}</Label>
                      <Input id="mcp-bearer" className="mt-2" value={serverDraft.bearerTokenEnv} onChange={(event) => updateServerDraft({ bearerTokenEnv: event.target.value })} placeholder="MCP_BEARER_TOKEN" />
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
      </CardContent>
    </Card>
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

function EmailAccountsCard() {
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
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Failed to load email OAuth settings');
      const entries = (payload.data?.entries || []) as EnvEntry[];
      const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
      setOauthDraft({
        googleClientId: byKey.get('GOOGLE_OAUTH_CLIENT_ID') || '',
        googleClientSecret: byKey.get('GOOGLE_OAUTH_CLIENT_SECRET') || '',
        microsoftClientId: byKey.get('MICROSOFT_OAUTH_CLIENT_ID') || '',
        microsoftClientSecret: byKey.get('MICROSOFT_OAUTH_CLIENT_SECRET') || '',
      });
    } catch (oauthLoadError) {
      setError(oauthLoadError instanceof Error ? oauthLoadError.message : 'Failed to load email OAuth settings');
    } finally {
      setIsOAuthLoading(false);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/email/accounts', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Failed to load email accounts');
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
      setError(loadError instanceof Error ? loadError.message : 'Failed to load email accounts');
    } finally {
      setIsLoading(false);
    }
  }, []);

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
      setMessage('Email account connected.');
      setError(null);
      void loadAccounts();
      clearEmailOAuthParams();
      return;
    }
    if (emailOAuthStatus === 'failed' || emailOAuthError) {
      handledEmailOAuthReturn.current = true;
      setError(emailOAuthError || 'Email OAuth failed.');
      setMessage(null);
      clearEmailOAuthParams();
    }
  }, [clearEmailOAuthParams, loadAccounts, searchParams]);

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
      throw new Error('Client ID and Client Secret are required before saving or connecting OAuth.');
    }
    const currentResponse = await fetch('/api/integrations/env?scope=integrations', { cache: 'no-store' });
    const currentPayload = await currentResponse.json();
    if (!currentResponse.ok || !currentPayload.success) throw new Error(currentPayload.error || 'Failed to load current integration keys');
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
    if (!saveResponse.ok || !savePayload.success) throw new Error(savePayload.error || 'Failed to save OAuth settings');
    await loadOAuthEnv();
  };

  const saveOAuthProvider = async (provider: 'google' | 'microsoft') => {
    setActiveAction(`oauth-save:${provider}`);
    setError(null);
    setMessage(null);
    try {
      await persistOAuthProvider(provider);
      setMessage(`${provider === 'google' ? 'Google' : 'Microsoft'} OAuth settings saved.`);
    } catch (saveOAuthError) {
      setError(saveOAuthError instanceof Error ? saveOAuthError.message : 'Failed to save OAuth settings');
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
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Failed to start email OAuth');
      if (!payload.data?.authorizationUrl) throw new Error('Email OAuth did not return an authorization URL.');
      window.location.assign(payload.data.authorizationUrl);
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : 'Failed to start email OAuth');
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
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Failed to save email policy');
      setMessage('Email policy saved.');
      await loadAccounts();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save email policy');
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
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Failed to disconnect email account');
      setMessage('Email account disconnected.');
      await loadAccounts();
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Failed to disconnect email account');
    } finally {
      setActiveAction(null);
    }
  };

  const isManagedEmailMode = emailMode === 'managed';
  const isLocalEmailMode = emailMode === 'local';
  const hasConnectedEmailAccount = accounts.length > 0;
  const oauthActionDisabled = activeAction !== null || isOAuthLoading || emailMode === 'unknown' || hasConnectedEmailAccount;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Email Accounts</CardTitle>
            <CardDescription>Connect email accounts and control which senders can be read or recipients can be used for sending.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void loadAccounts()} disabled={isLoading}>
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        {message && <div className="border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{message}</div>}
        {!hasConnectedEmailAccount && (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-3 border border-border p-4">
              <div>
                <h3 className="text-base font-semibold">Google OAuth</h3>
                <p className="text-sm text-muted-foreground">{isManagedEmailMode ? 'Connect Gmail accounts with Canvas Managed Services.' : 'Used for connecting Gmail accounts in self-hosted setups.'}</p>
              </div>
              {isLocalEmailMode && (
                <>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="email-google-client-id">Client ID</Label>
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
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="email-google-client-secret">Client Secret</Label>
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
                    Save
                  </Button>
                )}
                <Button type="button" onClick={() => void startOAuth('google')} disabled={oauthActionDisabled}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Connect
                </Button>
              </div>
            </div>
            <div className="space-y-3 border border-border p-4">
              <div>
                <h3 className="text-base font-semibold">Microsoft OAuth</h3>
                <p className="text-sm text-muted-foreground">{isManagedEmailMode ? 'Connect Microsoft 365 or Outlook accounts with Canvas Managed Services.' : 'Used for connecting Microsoft 365 or Outlook accounts.'}</p>
              </div>
              {isLocalEmailMode && (
                <>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="email-microsoft-client-id">Client ID</Label>
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
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="email-microsoft-client-secret">Client Secret</Label>
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
                    Save
                  </Button>
                )}
                <Button type="button" onClick={() => void startOAuth('microsoft')} disabled={oauthActionDisabled}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Connect
                </Button>
              </div>
            </div>
          </div>
        )}
        {accounts.length === 0 ? (
          <div className="border border-border p-4 text-sm text-muted-foreground">No email accounts connected.</div>
        ) : (
          accounts.map((account) => {
            const draft = drafts[account.id] || { readFrom: '', sendTo: '' };
            return (
              <div key={account.id} className="space-y-3 border border-border p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">{account.emailAddress}</h3>
                      <Badge variant="outline">{account.provider}</Badge>
                      <Badge variant={account.status === 'active' ? 'default' : 'secondary'}>{account.status}</Badge>
                    </div>
                    {account.displayName && <p className="text-sm text-muted-foreground">{account.displayName}</p>}
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void disconnect(account.id)} disabled={activeAction !== null}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Disconnect
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Read from emails</Label>
                    <textarea
                      className="mt-2 min-h-28 w-full border border-input bg-background px-3 py-2 text-sm"
                      value={draft.readFrom}
                      onChange={(event) => setDrafts((current) => ({ ...current, [account.id]: { ...draft, readFrom: event.target.value } }))}
                      placeholder="All senders allowed"
                    />
                  </div>
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Send to emails</Label>
                    <textarea
                      className="mt-2 min-h-28 w-full border border-input bg-background px-3 py-2 text-sm"
                      value={draft.sendTo}
                      onChange={(event) => setDrafts((current) => ({ ...current, [account.id]: { ...draft, sendTo: event.target.value } }))}
                      placeholder="All recipients allowed"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="button" onClick={() => void savePolicy(account.id)} disabled={activeAction !== null}>
                    <Save className="mr-2 h-4 w-4" />
                    Save policy
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsSettingsClient({ isAdmin = false, userName = '', userEmail = '' }: { isAdmin?: boolean; userName?: string; userEmail?: string }) {
  const t = useTranslations('settings');
  const searchParams = useSearchParams();

  const requestedTab = searchParams.get('tab');
  const initialTab = getInitialSettingsTab(requestedTab);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialTab);
  const { activeTabOverride } = useHintContext();

  const effectiveTab = (activeTabOverride as typeof settingsTab) || settingsTab;
  const handleTabChange = (value: string) => {
    if (!isSettingsTab(value)) return;

    setSettingsTab(value);
    window.localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, value);

    const url = new URL(window.location.href);
    url.searchParams.set('tab', value);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const [editors, setEditors] = useState<Record<EnvScope, ScopeEditorState>>({
    integrations: INITIAL_SCOPE_STATE('integrations'),
    agents: INITIAL_SCOPE_STATE('agents'),
  });
  const [mcpEditor, setMcpEditor] = useState<McpEditorState>(INITIAL_MCP_STATE);

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

  const runMcpServerAction = useCallback(async (server: string, action: McpServerAction) => {
    setMcpEditor((current) => ({
      ...current,
      activeServerAction: `${server}:${action}`,
      error: null,
      success: null,
    }));

    try {
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

      if (action === 'authorize' && typeof payload.data?.authorizationUrl === 'string') {
        window.open(payload.data.authorizationUrl, '_blank', 'noopener,noreferrer');
      }

      const successKey = action === 'test'
        ? 'mcpConfig.testSucceeded'
        : action === 'enable'
          ? 'mcpConfig.enabledSaved'
          : action === 'disable'
            ? 'mcpConfig.disabledSaved'
            : action === 'authorize'
              ? 'mcpConfig.authorizationStarted'
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
  }, [loadMcpConfig, loadMcpStatus, t]);

  useEffect(() => {
    startTransition(() => {
      void Promise.all([
        ...SCOPE_CARDS.map((card) => loadState(card.scope)),
        loadMcpConfig(),
        loadMcpStatus(),
      ]);
    });
  }, [loadMcpConfig, loadMcpStatus, loadState]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    startTransition(() => {
      if (tab === 'agent-settings') {
        setSettingsTab('agent-settings');
      } else if (tab === 'workspace') {
        setSettingsTab('workspace');
      } else if (tab === 'integrations') {
        setSettingsTab('integrations');
      } else if (tab === 'usage') {
        setSettingsTab('usage');
      } else if (tab === 'skills') {
        setSettingsTab('skills');
      } else if (tab === 'channels') {
        setSettingsTab('channels');
      }
    });
  }, [searchParams]);

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

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-6">
      <Tabs
        value={effectiveTab}
        onValueChange={handleTabChange}
        className="space-y-4"
      >
        <TabsList className="grid h-auto w-full grid-cols-1 gap-2 bg-transparent p-0 sm:grid-cols-8">
          <TabsTrigger value="general" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.general')}
          </TabsTrigger>
          <TabsTrigger value="integrations" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.integrations')}
          </TabsTrigger>
          <TabsTrigger value="agent-settings" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.agentSettings')}
          </TabsTrigger>
          <TabsTrigger value="workspace" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.workspace')}
          </TabsTrigger>
          <TabsTrigger value="channels" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.channels')}
          </TabsTrigger>
          <TabsTrigger value="usage" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.usage')}
          </TabsTrigger>
          <TabsTrigger value="skills" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.skills')}
          </TabsTrigger>
          <TabsTrigger value="license" className="min-h-9 border border-border data-[state=active]:bg-muted">
            License
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4">
          <GeneralSettingsPanel userName={userName} userEmail={userEmail} />
        </TabsContent>

        <TabsContent value="integrations" className="space-y-4" id="onboarding-settings-integrations">
          <ConnectedAppsPanel />
          <EmailAccountsCard />
          <McpConfigCard
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
        </TabsContent>

        <TabsContent value="agent-settings" className="space-y-4">
          <AgentSettingsPanel />
        </TabsContent>

        <TabsContent value="workspace" className="space-y-4">
          <WorkspaceSettingsPanel />
        </TabsContent>

        <TabsContent value="channels" className="space-y-4">
          <ChannelsPanel />
        </TabsContent>

        <TabsContent value="usage" className="space-y-4" id="onboarding-settings-usage">
          <UsageAnalyticsClient isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="skills" className="space-y-4">
          <SkillsPanel />
        </TabsContent>

        <TabsContent value="license" className="space-y-4">
          <LicenseActivationPanel defaultEmail={userEmail} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
