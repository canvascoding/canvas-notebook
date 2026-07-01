'use client';

import { ExternalLink, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type McpTransportMode = 'stdio' | 'http';

export type McpPairDraft = {
  id: string;
  key: string;
  value: string;
  storeInEnv: boolean;
  envKey: string;
};

export type McpServerDraft = {
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

export type McpConfigFile = {
  settings?: Record<string, unknown>;
  mcpServers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

export type McpConnectorDraftInput = {
  name: string;
  env?: string[];
  oauth?: boolean;
};

export function createMcpPairDraft(entry?: Partial<McpPairDraft>): McpPairDraft {
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

export function makeMcpEnvKey(serverName: string, key: string): string {
  const server = normalizeEnvKeyPart(serverName) || 'SERVER';
  const name = normalizeEnvKeyPart(key) || 'VALUE';
  return `MCP_${server}_${name}`;
}

export function makeMcpBearerTokenEnvKey(draft: Pick<McpServerDraft, 'bearerTokenEnv' | 'name'>): string {
  return draft.bearerTokenEnv.trim() || makeMcpEnvKey(draft.name, 'BEARER_TOKEN');
}

function parseEnvReference(value: string): string | null {
  const match = value.trim().match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u);
  return match?.[1] || null;
}

export function parseMcpConfigFile(rawContent: string): McpConfigFile {
  const parsed = JSON.parse(rawContent || '{}') as Partial<McpConfigFile>;
  return {
    ...parsed,
    settings: parsed.settings || { toolPrefix: 'server', idleTimeout: 10 },
    mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers
      : {},
  } as McpConfigFile;
}

export function toMcpServerDraft(name: string, serverConfig: Record<string, unknown> = {}): McpServerDraft {
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

export function createBlankMcpServerDraft(): McpServerDraft {
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

export function collectMcpEnvEntries(draft: McpServerDraft): Array<{ key: string; value: string }> {
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

export function updateMcpConfigRawServer(rawContent: string, draft: McpServerDraft, originalName?: string): string {
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

export function deleteMcpConfigRawServer(rawContent: string, serverName: string): string {
  const config = parseMcpConfigFile(rawContent);
  delete config.mcpServers[serverName];
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function createMcpServerDraftFromConnector(
  connector: McpConnectorDraftInput,
  templateConfig?: Record<string, unknown>,
): McpServerDraft {
  const rawServerConfig = templateConfig?.mcpServers
    && typeof templateConfig.mcpServers === 'object'
    && !Array.isArray(templateConfig.mcpServers)
    ? (templateConfig.mcpServers as Record<string, Record<string, unknown> | undefined>)[connector.name]
    : undefined;
  const serverConfig = rawServerConfig || templateConfig || {};
  const draft = toMcpServerDraft(connector.name, serverConfig);
  const existingEnvKeys = new Set(draft.env.map((entry) => entry.key.trim()).filter(Boolean));
  const missingEnv = (connector.env || [])
    .filter((key) => !existingEnvKeys.has(key))
    .map((key) => createMcpPairDraft({
      key,
      value: '',
      storeInEnv: true,
      envKey: key,
    }));

  return {
    ...draft,
    name: draft.name || connector.name,
    auth: connector.oauth ? 'oauth' : draft.auth,
    env: [...draft.env, ...missingEnv],
  };
}

export function McpServerDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: McpServerDraft;
  onDraftChange: (patch: Partial<McpServerDraft>) => void;
  onSave: () => void;
  onDelete?: () => void;
  editingServerName?: string;
  isSaving: boolean;
  loadingMessage?: string | null;
  error?: string | null;
}) {
  const t = useTranslations('settings');
  const {
    draft,
    editingServerName,
    error,
    isSaving,
    loadingMessage,
    onDelete,
    onDraftChange,
    onOpenChange,
    onSave,
    open,
  } = props;

  const updatePair = (field: 'env' | 'headers' | 'headersFromEnv', index: number, patch: Partial<McpPairDraft>) => {
    onDraftChange({
      [field]: draft[field].map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry),
    } as Partial<McpServerDraft>);
  };

  const removePair = (field: 'env' | 'headers' | 'headersFromEnv', index: number) => {
    onDraftChange({
      [field]: draft[field].filter((_entry, entryIndex) => entryIndex !== index),
    } as Partial<McpServerDraft>);
  };

  const bearerTokenEnvKey = makeMcpBearerTokenEnvKey(draft);
  const isLoading = Boolean(loadingMessage);

  const renderPairRows = (field: 'env' | 'headers' | 'headersFromEnv', keyPlaceholder: string, valuePlaceholder: string) => (
    <div className="space-y-2">
      {draft[field].map((entry, index) => (
        <div key={entry.id} className="space-y-2 rounded-md border border-border p-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Input className="min-w-0" value={entry.key} onChange={(event) => updatePair(field, index, { key: event.target.value, envKey: entry.envKey || makeMcpEnvKey(draft.name, event.target.value) })} placeholder={keyPlaceholder} />
            <Input
              className="min-w-0"
              value={entry.value}
              onChange={(event) => updatePair(field, index, { value: event.target.value })}
              placeholder={entry.storeInEnv ? t('mcpConfig.secretValuePlaceholder') : valuePlaceholder}
              type={entry.storeInEnv ? 'password' : 'text'}
              disabled={field === 'headersFromEnv'}
            />
            <Button type="button" variant="ghost" size="icon" className="justify-self-end sm:justify-self-auto" onClick={() => removePair(field, index)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          {field !== 'headersFromEnv' ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <label className="flex min-w-0 items-center gap-2">
                <Switch
                  size="sm"
                  checked={entry.storeInEnv}
                  onCheckedChange={(checked) => updatePair(field, index, { storeInEnv: checked, envKey: entry.envKey || makeMcpEnvKey(draft.name, entry.key) })}
                />
                <span className="min-w-0">{t('mcpConfig.storeInIntegrationsEnv')}</span>
              </label>
              {entry.storeInEnv ? (
                <Input
                  className="h-8 w-full min-w-0 sm:max-w-xs"
                  value={entry.envKey || makeMcpEnvKey(draft.name, entry.key)}
                  onChange={(event) => updatePair(field, index, { envKey: event.target.value })}
                  placeholder="MCP_SERVER_TOKEN"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
      <Button type="button" variant="secondary" className="w-full" onClick={() => onDraftChange({ [field]: [...draft[field], createMcpPairDraft()] } as Partial<McpServerDraft>)}>
        <Plus className="mr-2 h-4 w-4" />
        {field === 'headers' ? t('mcpConfig.addHeader') : field === 'headersFromEnv' ? t('mcpConfig.addVariable') : t('mcpConfig.addEnvVar')}
      </Button>
    </div>
  );

  const renderLoadingSkeleton = () => (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/20 p-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {loadingMessage}
        </div>
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
      <div className="rounded-md border border-border p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-10 w-full" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-4 rounded-md border border-border p-4">
        <div>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-2 h-10 w-full" />
        </div>
        <div>
          <Skeleton className="h-4 w-36" />
          <div className="mt-2 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!isSaving) onOpenChange(nextOpen); }}>
      <DialogContent
        layout="viewport"
        className="gap-0 sm:!left-1/2 sm:!right-auto sm:w-[min(960px,calc(100vw-2rem))] sm:!-translate-x-1/2 lg:w-[min(1040px,calc(100vw-4rem))]"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-4 pr-12 text-left sm:px-6">
          <DialogTitle>{editingServerName ? t('mcpConfig.editServer') : t('mcpConfig.addServer')}</DialogTitle>
          <DialogDescription>{t('mcpConfig.serversDescription')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="mx-auto w-full max-w-4xl space-y-4">
            {error ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}

            {isLoading ? renderLoadingSkeleton() : (
              <>
                <div>
                  <h3 className="text-lg font-semibold">{t('mcpConfig.customTitle')}</h3>
                  <a className="mt-2 inline-flex items-center text-sm text-primary" href="https://modelcontextprotocol.io/docs" target="_blank" rel="noreferrer">
                    {t('mcpConfig.docs')}
                    <ExternalLink className="ml-1 h-3.5 w-3.5" />
                  </a>
                </div>

                <div className="rounded-md border border-border p-4">
                  <Label htmlFor="mcp-server-name">{t('mcpConfig.name')}</Label>
                  <Input id="mcp-server-name" className="mt-2" value={draft.name} onChange={(event) => onDraftChange({ name: event.target.value })} placeholder={t('mcpConfig.namePlaceholder')} />
                </div>

                <Tabs value={draft.mode} onValueChange={(value) => onDraftChange({ mode: value as McpTransportMode })}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="stdio">STDIO</TabsTrigger>
                    <TabsTrigger value="http">Streamable HTTP</TabsTrigger>
                  </TabsList>
                </Tabs>

                {draft.mode === 'stdio' ? (
                  <div className="space-y-4 rounded-md border border-border p-4">
                    <div>
                      <Label htmlFor="mcp-command">{t('mcpConfig.command')}</Label>
                      <Input id="mcp-command" className="mt-2" value={draft.command} onChange={(event) => onDraftChange({ command: event.target.value })} placeholder="npx" />
                    </div>
                    <div>
                      <Label>{t('mcpConfig.arguments')}</Label>
                      <div className="mt-2 space-y-2">
                        {draft.args.map((arg, index) => (
                          <div key={`${index}-${arg}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <Input className="min-w-0" value={arg} onChange={(event) => onDraftChange({ args: draft.args.map((entry, entryIndex) => entryIndex === index ? event.target.value : entry) })} />
                            <Button type="button" variant="ghost" size="icon" onClick={() => onDraftChange({ args: draft.args.filter((_entry, entryIndex) => entryIndex !== index) })}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                        <Button type="button" variant="secondary" className="w-full" onClick={() => onDraftChange({ args: [...draft.args, ''] })}>
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
                        {draft.envPassthrough.map((value, index) => (
                          <div key={`${index}-${value}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <Input className="min-w-0" value={value} onChange={(event) => onDraftChange({ envPassthrough: draft.envPassthrough.map((entry, entryIndex) => entryIndex === index ? event.target.value : entry) })} placeholder="OPENAI_API_KEY" />
                            <Button type="button" variant="ghost" size="icon" onClick={() => onDraftChange({ envPassthrough: draft.envPassthrough.filter((_entry, entryIndex) => entryIndex !== index) })}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                        <Button type="button" variant="secondary" className="w-full" onClick={() => onDraftChange({ envPassthrough: [...draft.envPassthrough, ''] })}>
                          <Plus className="mr-2 h-4 w-4" />
                          {t('mcpConfig.addVariable')}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="mcp-cwd">{t('mcpConfig.cwd')}</Label>
                      <Input id="mcp-cwd" className="mt-2" value={draft.cwd} onChange={(event) => onDraftChange({ cwd: event.target.value })} placeholder="/data/workspace" />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 rounded-md border border-border p-4">
                    <div>
                      <Label htmlFor="mcp-url">URL</Label>
                      <Input id="mcp-url" className="mt-2" value={draft.url} onChange={(event) => onDraftChange({ url: event.target.value })} placeholder="https://mcp.example.com/mcp" />
                    </div>
                    <div>
                      <Label>{t('mcpConfig.oauthMode')}</Label>
                      <Tabs value={draft.auth} onValueChange={(value) => onDraftChange({ auth: value as McpServerDraft['auth'] })} className="mt-2">
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
                        value={draft.bearerTokenValue}
                        onChange={(event) => onDraftChange({ bearerTokenValue: event.target.value })}
                        placeholder={draft.bearerTokenEnv ? t('mcpConfig.bearerTokenPlaceholderExisting') : t('mcpConfig.bearerTokenPlaceholder')}
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
              </>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-4 py-3 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {editingServerName && onDelete ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={onDelete}
                  disabled={isSaving}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('mcpConfig.deleteServer')}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={isSaving}>
                {t('mcpConfig.cancel')}
              </Button>
              <Button type="button" className="w-full sm:w-auto" onClick={onSave} disabled={isSaving || isLoading}>
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {t('mcpConfig.saveServer')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
