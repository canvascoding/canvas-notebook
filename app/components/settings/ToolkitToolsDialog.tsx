'use client';

import { useCallback, useEffect, useMemo, useState, useRef, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Loader2, Pause, Play, Plus, Search, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

type ToolkitToolInfo = {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
};

type ToolkitToolsDialogProps = {
  slug: string;
  name: string;
  logo: string;
  connected: boolean;
  toolsCount: number;
  onClose: () => void;
  onConnect?: (slug: string) => void;
  onDisconnect?: (slug: string) => void;
};

const PAGE_SIZE = 20;
const DEFAULT_PROMPT = 'Handle this webhook event. Inspect the payload, decide what changed, and perform the requested notebook work.';

type TriggerTypeInfo = {
  slug: string;
  name: string;
  description: string;
  configSchema: Record<string, unknown> | null;
};

type ActiveTriggerInfo = {
  triggerId: string;
  triggerSlug: string;
  toolkitSlug: string;
  status: string;
  connectedAccountId: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJsonResponse(response: Response, context: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    console.error(`[Composio Triggers UI] ${context} returned non-JSON`, {
      status: response.status,
      bodyPreview: text.slice(0, 500),
      error,
    });
    throw new Error(`${context} returned an invalid response.`);
  }
}

function normalizeTriggerType(value: unknown): TriggerTypeInfo | null {
  const record = asRecord(value);
  const slug = stringValue(record.slug) || stringValue(record.name);
  if (!slug) return null;
  const displayName = stringValue(record.displayName) || stringValue(record.name) || slug;
  const configSchema = asRecord(record.configSchema ?? record.config_schema ?? record.config ?? record.inputParameters ?? record.input_parameters);
  return {
    slug,
    name: displayName,
    description: stringValue(record.description),
    configSchema: Object.keys(configSchema).length > 0 ? configSchema : null,
  };
}

function normalizeActiveTrigger(value: unknown): ActiveTriggerInfo | null {
  const record = asRecord(value);
  const triggerId = stringValue(record.triggerId) || stringValue(record.trigger_id) || stringValue(record.id);
  if (!triggerId) return null;
  const triggerSlug = stringValue(record.triggerSlug) || stringValue(record.trigger_slug) || stringValue(record.triggerName) || stringValue(record.trigger_name) || stringValue(record.slug);
  const toolkitSlug = stringValue(record.toolkitSlug) || stringValue(record.toolkit_slug) || stringValue(asRecord(record.toolkit).slug);
  const disabledAt = record.disabledAt ?? record.disabled_at;
  return {
    triggerId,
    triggerSlug,
    toolkitSlug,
    status: stringValue(record.status) || (disabledAt ? 'paused' : record.enabled === false ? 'paused' : 'active'),
    connectedAccountId: stringValue(record.connectedAccountId) || stringValue(record.connected_account_id),
  };
}

export function ToolkitToolsDialog({
  slug,
  name,
  logo,
  connected,
  toolsCount,
  onClose,
  onConnect,
  onDisconnect,
}: ToolkitToolsDialogProps) {
  const t = useTranslations('settings.connectedApps');

  const [tools, setTools] = useState<ToolkitToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ToolkitToolInfo[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTab, setActiveTab] = useState<'tools' | 'triggers'>('tools');
  const [triggerTypes, setTriggerTypes] = useState<TriggerTypeInfo[]>([]);
  const [activeTriggers, setActiveTriggers] = useState<ActiveTriggerInfo[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggersError, setTriggersError] = useState<string | null>(null);
  const [triggerActionId, setTriggerActionId] = useState<string | null>(null);
  const [selectedTriggerSlug, setSelectedTriggerSlug] = useState('');
  const [triggerName, setTriggerName] = useState('');
  const [triggerPrompt, setTriggerPrompt] = useState(DEFAULT_PROMPT);
  const [triggerConfigText, setTriggerConfigText] = useState('{}');
  const [targetOutputPath, setTargetOutputPath] = useState('');
  const [webhookSubStatus, setWebhookSubStatus] = useState<{ configured: boolean; webhookUrl?: string; mode?: string } | null>(null);

  const loadTools = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/composio/toolkits/${encodeURIComponent(slug)}/tools`, {
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load tools');
      setTools(data.tools || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tools');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    startTransition(() => {
      void loadTools();
    });
  }, [loadTools]);

  const loadTriggers = useCallback(async () => {
    if (!connected) {
      setTriggerTypes([]);
      setActiveTriggers([]);
      return;
    }

    setTriggersLoading(true);
    setTriggersError(null);
    try {
      const [typesResponse, activeResponse] = await Promise.all([
        fetch(`/api/composio/triggers?toolkit=${encodeURIComponent(slug)}`, { credentials: 'include' }),
        fetch('/api/composio/triggers', { credentials: 'include' }),
      ]);
      const [typesPayload, activePayload] = await Promise.all([
        readJsonResponse(typesResponse, 'Trigger types fetch'),
        readJsonResponse(activeResponse, 'Active triggers fetch'),
      ]);
      if (!typesResponse.ok) throw new Error(stringValue(typesPayload.error) || 'Failed to load trigger types');
      if (!activeResponse.ok) throw new Error(stringValue(activePayload.error) || 'Failed to load active triggers');

      const typesData = asRecord(typesPayload.data);
      const activeData = asRecord(activePayload.data);
      const rawTypes: unknown[] = Array.isArray(typesData.triggerTypes) ? typesData.triggerTypes : [];
      const rawTriggers: unknown[] = Array.isArray(activeData.triggers) ? activeData.triggers : [];
      const normalizedTypes = rawTypes.map(normalizeTriggerType).filter((entry): entry is TriggerTypeInfo => Boolean(entry));
      setTriggerTypes(normalizedTypes);
      setActiveTriggers(
        rawTriggers
          .map(normalizeActiveTrigger)
          .filter((entry): entry is ActiveTriggerInfo => Boolean(entry))
          .filter((entry) => entry.toolkitSlug === slug || !entry.toolkitSlug),
      );
      setSelectedTriggerSlug((current) => current || normalizedTypes[0]?.slug || '');

      try {
        const subResponse = await fetch('/api/composio/webhook/subscription', { credentials: 'include' });
        if (subResponse.ok) {
          const subData = await subResponse.json();
          setWebhookSubStatus({ configured: subData.configured, webhookUrl: subData.webhookUrl, mode: subData.mode });
        } else {
          setWebhookSubStatus({ configured: false });
        }
      } catch {
        setWebhookSubStatus({ configured: false });
      }
    } catch (err) {
      console.error('[Composio Triggers UI] Failed to load triggers', { toolkit: slug, error: err });
      setTriggersError(err instanceof Error ? err.message : 'Failed to load triggers');
    } finally {
      setTriggersLoading(false);
    }
  }, [connected, slug]);

  useEffect(() => {
    if (activeTab === 'triggers') {
      startTransition(() => {
        void loadTriggers();
      });
    }
  }, [activeTab, loadTriggers]);

  const searchTools = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    try {
      const response = await fetch(
        `/api/composio/toolkits/${encodeURIComponent(slug)}/tools?search=${encodeURIComponent(query)}`,
        { credentials: 'include' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Search failed');
      setSearchResults(data.tools || []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [slug]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setPage(1);
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    if (!value.trim()) {
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchTimerRef.current = setTimeout(() => {
      void searchTools(value);
    }, 300);
  }, [searchTools]);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  const toggleExpanded = (toolSlug: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolSlug)) {
        next.delete(toolSlug);
      } else {
        next.add(toolSlug);
      }
      return next;
    });
  };

  const displayTools = searchQuery ? (searchResults ?? []) : tools;
  const appliedQuery = searchQuery.trim();

  const filteredDisplay = appliedQuery
    ? displayTools
    : tools;
  const pagedTools = filteredDisplay.slice(0, page * PAGE_SIZE);
  const hasMore = !appliedQuery && filteredDisplay.length > page * PAGE_SIZE;

  const totalCount = toolsCount > 0 ? toolsCount : tools.length;

  const statusText = connected
    ? t('toolsAvailableConnected')
    : t('toolsAvailableNotConnected');
  const selectedTrigger = useMemo(
    () => triggerTypes.find((trigger) => trigger.slug === selectedTriggerSlug) || null,
    [selectedTriggerSlug, triggerTypes],
  );
  const canCreateTrigger = connected && selectedTriggerSlug && triggerName.trim() && triggerPrompt.trim();

  const handleCreateTrigger = async () => {
    setTriggersError(null);
    let triggerConfig: Record<string, unknown>;
    try {
      triggerConfig = asRecord(JSON.parse(triggerConfigText || '{}'));
    } catch {
      setTriggersError('Trigger config must be valid JSON.');
      return;
    }

    setTriggerActionId('create');
    try {
      const response = await fetch('/api/composio/triggers', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: triggerName.trim(),
          prompt: triggerPrompt.trim(),
          triggerSlug: selectedTriggerSlug,
          toolkitSlug: slug,
          triggerConfig,
          targetOutputPath: targetOutputPath.trim() || null,
        }),
      });
      const data = await readJsonResponse(response, 'Create trigger fetch');
      if (!response.ok) throw new Error(stringValue(data.error) || 'Failed to create trigger');
      setTriggerName('');
      setTargetOutputPath('');
      setTriggerConfigText('{}');
      await loadTriggers();
    } catch (err) {
      console.error('[Composio Triggers UI] Failed to create trigger', { toolkit: slug, triggerSlug: selectedTriggerSlug, error: err });
      setTriggersError(err instanceof Error ? err.message : 'Failed to create trigger');
    } finally {
      setTriggerActionId(null);
    }
  };

  const handleTriggerStatus = async (trigger: ActiveTriggerInfo, status: 'active' | 'paused') => {
    setTriggersError(null);
    setTriggerActionId(trigger.triggerId);
    try {
      const response = await fetch(`/api/composio/triggers/${encodeURIComponent(trigger.triggerId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await readJsonResponse(response, 'Update trigger fetch');
      if (!response.ok) throw new Error(stringValue(data.error) || 'Failed to update trigger');
      await loadTriggers();
    } catch (err) {
      console.error('[Composio Triggers UI] Failed to update trigger', { toolkit: slug, triggerId: trigger.triggerId, status, error: err });
      setTriggersError(err instanceof Error ? err.message : 'Failed to update trigger');
    } finally {
      setTriggerActionId(null);
    }
  };

  const handleDeleteTrigger = async (trigger: ActiveTriggerInfo) => {
    setTriggersError(null);
    setTriggerActionId(trigger.triggerId);
    try {
      const response = await fetch(`/api/composio/triggers/${encodeURIComponent(trigger.triggerId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await readJsonResponse(response, 'Delete trigger fetch');
      if (!response.ok) throw new Error(stringValue(data.error) || 'Failed to delete trigger');
      await loadTriggers();
    } catch (err) {
      console.error('[Composio Triggers UI] Failed to delete trigger', { toolkit: slug, triggerId: trigger.triggerId, error: err });
      setTriggersError(err instanceof Error ? err.message : 'Failed to delete trigger');
    } finally {
      setTriggerActionId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative w-full rounded-t-lg border border-border bg-background shadow-lg sm:mx-4 sm:max-w-2xl sm:rounded-lg max-h-[90vh] sm:max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-0">
          <div className="flex items-center gap-3">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={name} className="h-8 w-8" />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded bg-muted text-sm font-bold">
                {name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-semibold truncate">{name}</h2>
              <p className="text-xs text-muted-foreground">
                {loading ? '...' : searchQuery && searchResults !== null
                  ? `${searchResults.length} of ${totalCount} ${t('toolsAvailable')}`
                  : `${totalCount} ${t('toolsAvailable')}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {connected ? (
              onDisconnect && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => onDisconnect(slug)}
                >
                  {t('disconnect')}
                </Button>
              )
            ) : (
              onConnect && (
                <Button size="sm" onClick={() => onConnect(slug)}>
                  {t('connect')}
                </Button>
              )
            )}
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'tools' | 'triggers')} className="min-h-0 flex-1 gap-0">
          <div className="border-b border-border px-4 py-3">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="triggers">Triggers</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="tools" className="min-h-0 flex flex-1 flex-col">
            <div className="border-b border-border px-4 py-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t('searchTools')}
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-9"
                />
                {searchLoading && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
              {loading ? (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('loadingTools')}
                </div>
              ) : error ? (
                <p className="py-4 text-center text-sm text-destructive">{error}</p>
              ) : pagedTools.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('noToolsFound')}</p>
              ) : (
                <div className="space-y-1">
                  {pagedTools.map((tool) => {
                    const isExpanded = expandedTools.has(tool.slug);
                    const hasDescription = tool.description.length > 0;
                    const truncatedDesc = hasDescription && tool.description.length > 120
                      ? tool.description.slice(0, 120) + '...'
                      : tool.description;

                    return (
                      <div
                        key={tool.slug}
                        className="rounded-md border border-transparent px-3 py-2 hover:bg-muted/50"
                      >
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 text-left"
                          onClick={() => hasDescription && toggleExpanded(tool.slug)}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium leading-tight">{tool.name}</p>
                            <p className="text-[11px] font-mono text-muted-foreground">{tool.slug}</p>
                            {hasDescription && (isExpanded ? (
                              <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
                            ) : (
                              <p className="mt-1 text-xs text-muted-foreground">{truncatedDesc}</p>
                            ))}
                          </div>
                          {hasDescription && (
                            <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {hasMore && (
                <div className="flex justify-center pt-3">
                  <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
                    {t('loadMore')} ({filteredDisplay.length - page * PAGE_SIZE} {t('remaining')})
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="triggers" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {!connected ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Connect {name} to create webhook automations.</p>
            ) : triggersLoading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading triggers
              </div>
            ) : (
              <div className="space-y-4">
                {triggersError && (
                  <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {triggersError}
                  </p>
                )}

                {webhookSubStatus && webhookSubStatus.mode === 'local' && (
                  <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${webhookSubStatus.configured ? 'border-primary/30 bg-primary/5 text-primary' : 'border-destructive/30 bg-destructive/5 text-destructive'}`}>
                    <span className={`inline-block h-2 w-2 rounded-full ${webhookSubStatus.configured ? 'bg-primary' : 'bg-destructive'}`} />
                    {webhookSubStatus.configured
                      ? <span>Webhook subscription active — {webhookSubStatus.webhookUrl}</span>
                      : <span>Webhook subscription not configured — events will not be received</span>}
                  </div>
                )}

                <div className="space-y-3 rounded-md border border-border p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Event</span>
                      <select
                        value={selectedTriggerSlug}
                        onChange={(e) => setSelectedTriggerSlug(e.target.value)}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      >
                        {triggerTypes.length === 0 ? (
                          <option value="">No triggers found</option>
                        ) : triggerTypes.map((trigger) => (
                          <option key={trigger.slug} value={trigger.slug}>{trigger.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Automation name</span>
                      <Input
                        value={triggerName}
                        onChange={(e) => setTriggerName(e.target.value)}
                        placeholder={`${name} webhook`}
                      />
                    </label>
                  </div>
                  {selectedTrigger?.description && (
                    <p className="text-xs text-muted-foreground">{selectedTrigger.description}</p>
                  )}
                  <label className="space-y-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">Prompt</span>
                    <Textarea
                      value={triggerPrompt}
                      onChange={(e) => setTriggerPrompt(e.target.value)}
                      className="min-h-24"
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Output path</span>
                      <Input
                        value={targetOutputPath}
                        onChange={(e) => setTargetOutputPath(e.target.value)}
                        placeholder="optional"
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Config JSON</span>
                      <Textarea
                        value={triggerConfigText}
                        onChange={(e) => setTriggerConfigText(e.target.value)}
                        className="min-h-20 font-mono text-xs"
                      />
                    </label>
                  </div>
                  {selectedTrigger?.configSchema && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Schema</summary>
                      <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
                        {JSON.stringify(selectedTrigger.configSchema, null, 2)}
                      </pre>
                    </details>
                  )}
                  <Button
                    size="sm"
                    onClick={handleCreateTrigger}
                    disabled={!canCreateTrigger || triggerActionId === 'create'}
                  >
                    {triggerActionId === 'create' ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    Create trigger
                  </Button>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Active triggers</p>
                  {activeTriggers.length === 0 ? (
                    <p className="rounded-md border border-border px-3 py-4 text-center text-sm text-muted-foreground">
                      No active triggers
                    </p>
                  ) : activeTriggers.map((trigger) => {
                    const isPaused = trigger.status.toLowerCase() === 'paused' || trigger.status.toLowerCase() === 'disabled';
                    return (
                      <div key={trigger.triggerId} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{trigger.triggerSlug || trigger.triggerId}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{trigger.triggerId}</p>
                        </div>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() => handleTriggerStatus(trigger, isPaused ? 'active' : 'paused')}
                          disabled={triggerActionId === trigger.triggerId}
                          title={isPaused ? 'Resume' : 'Pause'}
                        >
                          {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => handleDeleteTrigger(trigger)}
                          disabled={triggerActionId === trigger.triggerId}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>

        <div className="border-t border-border px-4 py-2">
          <p className="text-[11px] text-muted-foreground">{statusText}</p>
        </div>
      </div>
    </div>
  );
}
