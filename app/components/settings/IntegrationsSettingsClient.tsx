'use client';

import { useCallback, useEffect, useState, startTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { AgentSettingsPanel } from '@/app/components/settings/AgentSettingsPanel';
import { GeneralSettingsPanel } from '@/app/components/settings/GeneralSettingsPanel';
import { SkillsPanel } from '@/app/components/settings/SkillsPanel';
import { WorkspaceSettingsPanel } from '@/app/components/settings/WorkspaceSettingsPanel';
import { ConnectedAppsPanel } from '@/app/components/settings/ConnectedAppsPanel';
import { ChannelsPanel } from '@/app/components/settings/ChannelsPanel';
import { UsageAnalyticsClient } from '@/app/components/usage/UsageAnalyticsClient';
import { CodeEditor } from '@/app/components/editor/CodeEditor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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

type ScopeCardConfig = {
  scope: EnvScope;
  emptyPath: string;
  keyHint: string;
};

const DEFAULT_SCOPE_KEYS: Record<EnvScope, string[]> = {
  integrations: ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'KIE_API_KEY', 'BRAVE_API_KEY', 'GROQ_API_KEY', 'COMPOSIO_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ENABLED'],
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

function McpConfigCard(props: {
  editor: McpEditorState;
  onLoad: () => Promise<void>;
  onLoadStatus: () => Promise<void>;
  onServerAction: (server: string, action: 'enable' | 'disable' | 'test') => Promise<void>;
  onRawChange: (value: string) => void;
  onSave: () => Promise<void>;
}) {
  const t = useTranslations('settings');
  const { editor, onLoad, onLoadStatus, onServerAction, onRawChange, onSave } = props;

  return (
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

            <p className="text-sm text-muted-foreground">{t('mcpConfig.secretNote')}</p>

            {editor.error && <p className="text-sm text-destructive">{editor.error}</p>}
            {editor.success && <p className="text-sm text-primary">{editor.success}</p>}

            <div className="rounded-md border border-border bg-muted/20 p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{t('mcpConfig.statusTitle')}</h3>
                <Button type="button" variant="outline" size="sm" onClick={() => void onLoadStatus()} disabled={editor.isStatusLoading || editor.isSaving}>
                  {editor.isStatusLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  {t('mcpConfig.refreshStatus')}
                </Button>
              </div>
              {!editor.status || editor.status.servers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('mcpConfig.noServers')}</p>
              ) : (
                <div className="space-y-2">
                  {editor.status.servers.map((server) => {
                    const oauth = editor.status?.oauth.find((entry) => entry.serverName === server.name);
                    return (
                      <div key={server.name} className="rounded-md border border-border bg-background p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{server.name}</span>
                          <span className="text-muted-foreground">{server.transport}</span>
                          <span className={server.enabled ? 'text-primary' : 'text-muted-foreground'}>
                            {server.enabled ? t('mcpConfig.enabled') : t('mcpConfig.disabled')}
                          </span>
                          <span className={server.connected ? 'text-primary' : 'text-muted-foreground'}>
                            {server.connected ? t('mcpConfig.connected') : t('mcpConfig.disconnected')}
                          </span>
                          {oauth?.requiresAuth && (
                            <span className={oauth.authorized ? 'text-primary' : 'text-destructive'}>
                              {oauth.authorized ? t('mcpConfig.oauthAuthorized') : t('mcpConfig.oauthRequired')}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void onServerAction(server.name, server.enabled ? 'disable' : 'enable')}
                            disabled={Boolean(editor.activeServerAction) || editor.isSaving}
                          >
                            {editor.activeServerAction === `${server.name}:${server.enabled ? 'disable' : 'enable'}` && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {server.enabled ? t('mcpConfig.disable') : t('mcpConfig.enable')}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void onServerAction(server.name, 'test')}
                            disabled={!server.enabled || Boolean(editor.activeServerAction) || editor.isSaving}
                          >
                            {editor.activeServerAction === `${server.name}:test` && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {t('mcpConfig.testConnection')}
                          </Button>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t('mcpConfig.cachedTools')}: {server.cachedToolCount}
                          {server.activeCalls > 0 ? ` · ${t('mcpConfig.activeCalls')}: ${server.activeCalls}` : ''}
                          {server.lastError ? ` · ${t('mcpConfig.lastError')}: ${server.lastError}` : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {editor.status?.directTools && editor.status.directTools.length > 0 && (
                <div className="mt-3 text-xs text-muted-foreground">
                  {t('mcpConfig.directTools')}: {editor.status.directTools.map((tool) => tool.name).join(', ')}
                </div>
              )}
              {editor.status?.warnings && editor.status.warnings.length > 0 && (
                <div className="mt-3 space-y-1 text-xs text-destructive">
                  {editor.status.warnings.map((warning, index) => (
                    <p key={`${warning.server}-${warning.tool || 'server'}-${index}`}>
                      {warning.server}{warning.tool ? `.${warning.tool}` : ''}: {warning.message}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className="h-[420px] overflow-hidden rounded-md border border-input bg-background">
              <CodeEditor
                value={editor.rawContent}
                onChange={onRawChange}
                path="mcp.json"
                readOnly={editor.isSaving}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void onSave()} disabled={editor.isSaving || editor.isLoading}>
                {editor.isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('mcpConfig.save')}
              </Button>
              <Button type="button" variant="outline" onClick={() => void onLoad()} disabled={editor.isSaving}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('envCard.reload')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsSettingsClient({ isAdmin = false, userName = '', userEmail = '' }: { isAdmin?: boolean; userName?: string; userEmail?: string }) {
  const t = useTranslations('settings');
  const searchParams = useSearchParams();

  const [settingsTab, setSettingsTab] = useState<'general' | 'integrations' | 'agent-settings' | 'workspace' | 'usage' | 'skills' | 'channels'>('general');
  const { activeTabOverride } = useHintContext();

  const effectiveTab = (activeTabOverride as typeof settingsTab) || settingsTab;
  const handleTabChange = (value: string) => {
    setSettingsTab(value as typeof settingsTab);
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

  const runMcpServerAction = useCallback(async (server: string, action: 'enable' | 'disable' | 'test') => {
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

      const successKey = action === 'test'
        ? 'mcpConfig.testSucceeded'
        : action === 'enable'
          ? 'mcpConfig.enabledSaved'
          : 'mcpConfig.disabledSaved';

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
        <TabsList className="grid h-auto w-full grid-cols-1 gap-2 bg-transparent p-0 sm:grid-cols-7">
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
        </TabsList>

        <TabsContent value="general" className="space-y-4">
          <GeneralSettingsPanel userName={userName} userEmail={userEmail} />
        </TabsContent>

        <TabsContent value="integrations" className="space-y-4" id="onboarding-settings-integrations">
          <ConnectedAppsPanel />
          <McpConfigCard
            editor={mcpEditor}
            onLoad={loadMcpConfig}
            onLoadStatus={loadMcpStatus}
            onServerAction={runMcpServerAction}
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
      </Tabs>
    </div>
  );
}
