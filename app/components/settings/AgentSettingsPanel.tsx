'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Eye, EyeOff, Loader2, Plus, RefreshCw, Save, Stethoscope, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const MANAGED_FILES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

type ManagedFileName = (typeof MANAGED_FILES)[number];
type ProviderId = 'codex-cli' | 'claude-cli' | 'openrouter' | 'ollama';
type ProviderKind = 'cli' | 'openrouter' | 'ollama';

type CliProviderConfig = {
  enabled: boolean;
  command: string;
};

type OpenRouterProviderConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeySource: 'integrations-env' | 'process-env';
};

type OllamaProviderConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeySource: 'none' | 'integrations-env' | 'process-env';
};

type AgentRuntimeConfig = {
  version: number;
  mainAgent: string;
  provider: {
    id: ProviderId;
    kind: ProviderKind;
  };
  providers: {
    'codex-cli': CliProviderConfig;
    'claude-cli': CliProviderConfig;
    openrouter: OpenRouterProviderConfig;
    ollama: OllamaProviderConfig;
  };
  doctor: {
    enableLivePing: boolean;
    timeoutMs: number;
  };
  updatedAt: string;
  updatedBy: string;
};

type ProviderReadiness = {
  id: ProviderId;
  kind: ProviderKind;
  enabled: boolean;
  available: boolean;
  issues: string[];
  command?: string;
  commandExists?: boolean;
  baseUrl?: string;
  model?: string;
  modelPlausible?: boolean;
  openRouterKeySet?: boolean;
  ollamaKeySet?: boolean;
};

type AgentConfigReadiness = {
  activeProviderId: ProviderId;
  activeProviderReady: boolean;
  openRouterKey: {
    isSet: boolean;
    source: 'integrations-env' | 'process-env' | null;
    last4: string | null;
    warnings: string[];
  };
  providers: Record<ProviderId, ProviderReadiness>;
};

type DoctorResult = {
  checkedAt: string;
  timeoutMs: number;
  summary: {
    ready: boolean;
    errors: number;
    warnings: number;
  };
  checks: {
    livePing?: {
      openrouter?: {
        enabled: boolean;
        ok: boolean | null;
        warning: string | null;
        latencyMs: number | null;
        status: number | null;
        target: string | null;
      };
      ollama?: {
        enabled: boolean;
        ok: boolean | null;
        warning: string | null;
        latencyMs: number | null;
        status: number | null;
        target: string | null;
      };
    };
  };
};

type SessionItem = {
  id: number;
  sessionId: string;
  title: string;
  model: string;
  createdAt: string;
  creator?: {
    name?: string | null;
    email?: string | null;
  };
};

type IntegrationsEnvEntry = {
  key: string;
  value: string;
};

type IntegrationsEnvState = {
  entries: IntegrationsEnvEntry[];
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });

  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: T;
    sessions?: SessionItem[];
  };

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return (payload.data as T) ?? (payload as unknown as T);
}

function toProviderKind(providerId: ProviderId): ProviderKind {
  if (providerId === 'openrouter') {
    return 'openrouter';
  }
  if (providerId === 'ollama') {
    return 'ollama';
  }
  return 'cli';
}

async function upsertIntegrationsEnvEntry(key: string, value: string): Promise<void> {
  const readResponse = await fetch('/api/integrations/env', {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  });
  const readBody = (await readResponse.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: IntegrationsEnvState;
  };

  if (!readResponse.ok || !readBody.success) {
    throw new Error(readBody.error || 'Failed to read integrations env.');
  }

  const currentEntries = Array.isArray(readBody.data?.entries) ? readBody.data.entries : [];
  const mergedEntries = currentEntries
    .filter((entry) => entry.key && entry.key.trim().length > 0 && entry.key !== key)
    .map((entry) => ({ key: entry.key, value: entry.value }));
  mergedEntries.push({ key, value });

  const writeResponse = await fetch('/api/integrations/env', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      mode: 'kv',
      entries: mergedEntries,
    }),
  });
  const writeBody = (await writeResponse.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
  };

  if (!writeResponse.ok || !writeBody.success) {
    throw new Error(writeBody.error || 'Failed to write integrations env.');
  }
}

export function AgentSettingsPanel() {
  const searchParams = useSearchParams();

  const [configDraft, setConfigDraft] = useState<AgentRuntimeConfig | null>(null);
  const [readiness, setReadiness] = useState<AgentConfigReadiness | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState<string | null>(null);
  const [openRouterApiKeyDraft, setOpenRouterApiKeyDraft] = useState('');
  const [openRouterApiKeyVisible, setOpenRouterApiKeyVisible] = useState(false);

  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);

  const [filesLoading, setFilesLoading] = useState(true);
  const [filesSaving, setFilesSaving] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesSuccess, setFilesSuccess] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<ManagedFileName, string> | null>(null);
  const [fileDrafts, setFileDrafts] = useState<Record<ManagedFileName, string>>({
    'AGENTS.md': '',
    'MEMORY.md': '',
    'SOUL.md': '',
    'TOOLS.md': '',
  });
  const [activeFile, setActiveFile] = useState<ManagedFileName>('AGENTS.md');

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [createTitle, setCreateTitle] = useState('');
  const [sessionPendingId, setSessionPendingId] = useState<string | null>(null);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});

  const activeProviderReadiness = useMemo(() => {
    if (!readiness) {
      return null;
    }
    return readiness.providers[readiness.activeProviderId];
  }, [readiness]);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);

    try {
      const payload = await fetchJson<{ config: AgentRuntimeConfig; readiness: AgentConfigReadiness }>(
        '/api/agents/config',
      );
      setConfigDraft(deepClone(payload.config));
      setReadiness(payload.readiness);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to load agent config.');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);

    try {
      const payload = await fetchJson<{ files: Record<ManagedFileName, string> }>('/api/agents/files');
      setFiles(payload.files);
      setFileDrafts(payload.files);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : 'Failed to load agent files.');
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionError(null);

    try {
      const payload = await fetch('/api/sessions', {
        credentials: 'include',
        cache: 'no-store',
      });
      const body = (await payload.json()) as {
        success?: boolean;
        error?: string;
        sessions?: SessionItem[];
      };

      if (!payload.ok || !body.success) {
        throw new Error(body.error || 'Failed to load sessions.');
      }

      const nextSessions = body.sessions || [];
      setSessions(nextSessions);
      setRenameDrafts(
        Object.fromEntries(nextSessions.map((item) => [item.sessionId, item.title || ''])) as Record<string, string>,
      );
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Failed to load sessions.');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const runDoctor = useCallback(async () => {
    setDoctorRunning(true);
    setDoctorError(null);

    try {
      const payload = await fetchJson<DoctorResult>('/api/agents/doctor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ livePing: true }),
      });
      setDoctorResult(payload);
      await loadConfig();
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : 'Doctor check failed.');
    } finally {
      setDoctorRunning(false);
    }
  }, [loadConfig]);

  useEffect(() => {
    void loadConfig();
    void loadFiles();
    void loadSessions();
  }, [loadConfig, loadFiles, loadSessions]);

  useEffect(() => {
    if (searchParams.get('panel') === 'doctor' && !doctorResult && !doctorRunning) {
      void runDoctor();
    }
  }, [searchParams, doctorResult, doctorRunning, runDoctor]);

  const saveConfig = async () => {
    if (!configDraft) {
      return;
    }

    setConfigSaving(true);
    setConfigError(null);
    setConfigSuccess(null);

    try {
      const shouldSaveOpenRouterApiKey =
        configDraft.providers.openrouter.apiKeySource === 'integrations-env' &&
        openRouterApiKeyDraft.trim().length > 0;

      let payload = await fetchJson<{ config: AgentRuntimeConfig; readiness: AgentConfigReadiness }>(
        '/api/agents/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: configDraft }),
        },
      );

      if (shouldSaveOpenRouterApiKey) {
        await upsertIntegrationsEnvEntry('OPENROUTER_API_KEY', openRouterApiKeyDraft.trim());
        payload = await fetchJson<{ config: AgentRuntimeConfig; readiness: AgentConfigReadiness }>(
          '/api/agents/config',
        );
        setOpenRouterApiKeyDraft('');
        setOpenRouterApiKeyVisible(false);
      }

      setConfigDraft(deepClone(payload.config));
      setReadiness(payload.readiness);
      setConfigSuccess(
        shouldSaveOpenRouterApiKey
          ? 'Agent-Konfiguration und OpenRouter API Key gespeichert.'
          : 'Agent-Konfiguration gespeichert.',
      );
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to save agent config.');
    } finally {
      setConfigSaving(false);
    }
  };

  const setProviderEnabled = (providerId: ProviderId, enabled: boolean) => {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = deepClone(current);
      if (providerId === 'openrouter') {
        next.providers.openrouter.enabled = enabled;
      } else if (providerId === 'ollama') {
        next.providers.ollama.enabled = enabled;
      } else {
        next.providers[providerId].enabled = enabled;
      }
      return next;
    });
  };

  const setCliCommand = (providerId: 'codex-cli' | 'claude-cli', command: string) => {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = deepClone(current);
      next.providers[providerId].command = command;
      return next;
    });
  };

  const setOllamaField = (field: 'baseUrl' | 'model' | 'apiKeySource', value: string) => {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = deepClone(current);
      if (field === 'apiKeySource') {
        next.providers.ollama.apiKeySource = value as OllamaProviderConfig['apiKeySource'];
      } else {
        next.providers.ollama[field] = value;
      }
      return next;
    });
  };

  const setOpenRouterField = (field: 'baseUrl' | 'model' | 'apiKeySource', value: string) => {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = deepClone(current);
      if (field === 'apiKeySource') {
        next.providers.openrouter.apiKeySource = value as OpenRouterProviderConfig['apiKeySource'];
      } else {
        next.providers.openrouter[field] = value;
      }
      return next;
    });
  };

  const setActiveProvider = (providerId: ProviderId) => {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = deepClone(current);
      next.provider.id = providerId;
      next.provider.kind = toProviderKind(providerId);
      if (providerId === 'openrouter') {
        next.providers.openrouter.enabled = true;
      } else if (providerId === 'ollama') {
        next.providers.ollama.enabled = true;
      } else {
        next.providers[providerId].enabled = true;
      }
      return next;
    });
  };

  const saveActiveFile = async () => {
    setFilesSaving(true);
    setFilesError(null);
    setFilesSuccess(null);

    try {
      const content = fileDrafts[activeFile] ?? '';
      const payload = await fetchJson<{ fileName: ManagedFileName; content: string }>('/api/agents/files', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: activeFile,
          content,
        }),
      });

      setFiles((current) => ({
        ...(current || fileDrafts),
        [payload.fileName]: payload.content,
      }));
      setFileDrafts((current) => ({
        ...current,
        [payload.fileName]: payload.content,
      }));
      setFilesSuccess(`${payload.fileName} gespeichert.`);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : 'Failed to save agent file.');
    } finally {
      setFilesSaving(false);
    }
  };

  const createSession = async () => {
    setSessionPendingId('create');
    setSessionError(null);

    try {
      await fetchJson<{ session: SessionItem }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: createTitle.trim() || undefined }),
      });

      setCreateTitle('');
      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Failed to create session.');
    } finally {
      setSessionPendingId(null);
    }
  };

  const renameSession = async (sessionId: string) => {
    setSessionPendingId(sessionId);
    setSessionError(null);

    try {
      await fetchJson<{ session: { sessionId: string; title: string } }>('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          title: (renameDrafts[sessionId] || '').trim(),
        }),
      });

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Failed to rename session.');
    } finally {
      setSessionPendingId(null);
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (!window.confirm('Session wirklich löschen?')) {
      return;
    }

    setSessionPendingId(sessionId);
    setSessionError(null);

    try {
      const response = await fetch(`/api/sessions?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        throw new Error(body.error || 'Failed to delete session.');
      }

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Failed to delete session.');
    } finally {
      setSessionPendingId(null);
    }
  };

  const deleteAllSessions = async () => {
    if (!window.confirm('Wirklich alle Sessions inklusive Verlauf löschen?')) {
      return;
    }

    setSessionPendingId('delete-all');
    setSessionError(null);

    try {
      const response = await fetch('/api/sessions?all=true', {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        throw new Error(body.error || 'Failed to delete all sessions.');
      }

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Failed to delete all sessions.');
    } finally {
      setSessionPendingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Provider Settings</CardTitle>
          <CardDescription>Globaler Provider, CLI-Kommandos sowie OpenRouter/Ollama-Konfiguration.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {configLoading || !configDraft ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Lade Agent-Konfiguration...
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span>Aktiver Provider</span>
                  <select
                    className="h-10 w-full border border-input bg-background px-3 text-sm"
                    value={configDraft.provider.id}
                    onChange={(event) => setActiveProvider(event.target.value as ProviderId)}
                    disabled={configSaving}
                  >
                    <option value="codex-cli">codex-cli</option>
                    <option value="claude-cli">claude-cli</option>
                    <option value="openrouter">openrouter</option>
                    <option value="ollama">ollama</option>
                  </select>
                </label>

                <div className="rounded border border-border bg-muted/40 p-3 text-xs">
                  <p className="font-semibold">Provider-Status</p>
                  <p className={activeProviderReadiness?.available ? 'text-primary' : 'text-destructive'}>
                    {activeProviderReadiness?.available ? 'Ready' : 'Not ready'}
                  </p>
                  {activeProviderReadiness?.issues?.[0] && (
                    <p className="mt-1 text-muted-foreground">{activeProviderReadiness.issues[0]}</p>
                  )}
                </div>
              </div>

              <div className="space-y-3 border-t border-border pt-4">
                <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
                  <label className="space-y-2 text-sm">
                    <span>Codex CLI Command</span>
                    <Input
                      value={configDraft.providers['codex-cli'].command}
                      onChange={(event) => setCliCommand('codex-cli', event.target.value)}
                      disabled={configSaving}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={configDraft.providers['codex-cli'].enabled}
                      onChange={(event) => setProviderEnabled('codex-cli', event.target.checked)}
                      disabled={configSaving}
                    />
                    Enabled
                  </label>
                </div>

                <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
                  <label className="space-y-2 text-sm">
                    <span>Claude CLI Command</span>
                    <Input
                      value={configDraft.providers['claude-cli'].command}
                      onChange={(event) => setCliCommand('claude-cli', event.target.value)}
                      disabled={configSaving}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={configDraft.providers['claude-cli'].enabled}
                      onChange={(event) => setProviderEnabled('claude-cli', event.target.checked)}
                      disabled={configSaving}
                    />
                    Enabled
                  </label>
                </div>

                <div className="rounded border border-border p-3">
                  <p className="mb-3 text-sm font-semibold">OpenRouter</p>
                  <div className="mb-3 grid gap-3 md:grid-cols-[auto_1fr] md:items-end">
                    <label className="flex h-10 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={configDraft.providers.openrouter.enabled}
                        onChange={(event) => setProviderEnabled('openrouter', event.target.checked)}
                        disabled={configSaving}
                      />
                      OpenRouter enabled
                    </label>
                    <label className="space-y-2 text-sm">
                      <span>OpenRouter Key Source</span>
                      <select
                        className="h-10 w-full border border-input bg-background px-3 text-sm"
                        value={configDraft.providers.openrouter.apiKeySource}
                        onChange={(event) => setOpenRouterField('apiKeySource', event.target.value)}
                        disabled={configSaving}
                      >
                        <option value="integrations-env">integrations-env</option>
                        <option value="process-env">process-env</option>
                      </select>
                    </label>
                  </div>

                  <div className="mb-3 grid gap-3 md:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span>OpenRouter Base URL</span>
                      <Input
                        value={configDraft.providers.openrouter.baseUrl}
                        onChange={(event) => setOpenRouterField('baseUrl', event.target.value)}
                        disabled={configSaving}
                      />
                    </label>
                    <label className="space-y-2 text-sm">
                      <span>OpenRouter Model</span>
                      <Input
                        value={configDraft.providers.openrouter.model}
                        onChange={(event) => setOpenRouterField('model', event.target.value)}
                        disabled={configSaving}
                      />
                    </label>
                  </div>

                  <label className="space-y-2 text-sm">
                    <span>OpenRouter API Key</span>
                    <div className="relative">
                      <Input
                        type={openRouterApiKeyVisible ? 'text' : 'password'}
                        value={openRouterApiKeyDraft}
                        onChange={(event) => setOpenRouterApiKeyDraft(event.target.value)}
                        placeholder={
                          readiness?.openRouterKey.isSet
                            ? `Gesetzt (endet auf ${readiness.openRouterKey.last4 || '****'})`
                            : 'sk-or-v1-...'
                        }
                        disabled={
                          configSaving || configDraft.providers.openrouter.apiKeySource !== 'integrations-env'
                        }
                        className="pr-12"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2"
                        onClick={() => setOpenRouterApiKeyVisible((current) => !current)}
                        disabled={
                          configSaving || configDraft.providers.openrouter.apiKeySource !== 'integrations-env'
                        }
                        aria-label={openRouterApiKeyVisible ? 'API key ausblenden' : 'API key einblenden'}
                      >
                        {openRouterApiKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </label>

                  {configDraft.providers.openrouter.apiKeySource === 'integrations-env' ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Der Key wird in `integrations-env` gespeichert. Feld leer lassen, um den vorhandenen Key nicht zu
                      ändern.
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Bei `process-env` wird der Key aus `OPENROUTER_API_KEY` gelesen und kann hier nicht gespeichert
                      werden.
                    </p>
                  )}

                  <p className="mt-1 text-xs text-muted-foreground">
                    Aktuell erkannt:{' '}
                    {readiness?.openRouterKey.isSet
                      ? `ja (${readiness.openRouterKey.source || 'unknown'})`
                      : 'nein'}
                  </p>
                </div>

                <div className="rounded border border-border p-3">
                  <p className="mb-3 text-sm font-semibold">Ollama</p>
                  <div className="mb-3 grid gap-3 md:grid-cols-[auto_1fr] md:items-end">
                    <label className="flex h-10 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={configDraft.providers.ollama.enabled}
                        onChange={(event) => setProviderEnabled('ollama', event.target.checked)}
                        disabled={configSaving}
                      />
                      Ollama enabled
                    </label>
                    <label className="space-y-2 text-sm">
                      <span>Ollama Key Source</span>
                      <select
                        className="h-10 w-full border border-input bg-background px-3 text-sm"
                        value={configDraft.providers.ollama.apiKeySource}
                        onChange={(event) => setOllamaField('apiKeySource', event.target.value)}
                        disabled={configSaving}
                      >
                        <option value="none">none</option>
                        <option value="integrations-env">integrations-env</option>
                        <option value="process-env">process-env</option>
                      </select>
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span>Ollama Base URL</span>
                      <Input
                        value={configDraft.providers.ollama.baseUrl}
                        onChange={(event) => setOllamaField('baseUrl', event.target.value)}
                        disabled={configSaving}
                      />
                    </label>
                    <label className="space-y-2 text-sm">
                      <span>Ollama Model</span>
                      <Input
                        value={configDraft.providers.ollama.model}
                        onChange={(event) => setOllamaField('model', event.target.value)}
                        disabled={configSaving}
                      />
                    </label>
                  </div>
                </div>
              </div>

              {configError && <p className="text-sm text-destructive">{configError}</p>}
              {configSuccess && <p className="text-sm text-primary">{configSuccess}</p>}

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveConfig()} disabled={configSaving}>
                  {configSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Provider-Konfiguration speichern
                </Button>
                <Button variant="outline" onClick={() => void loadConfig()} disabled={configLoading || configSaving}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Neu laden
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Doctor</CardTitle>
          <CardDescription>Lokale Provider-Checks und optionale OpenRouter/Ollama-Pings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {configDraft && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={configDraft.doctor.enableLivePing}
                onChange={(event) =>
                  setConfigDraft((current) => {
                    if (!current) {
                      return current;
                    }
                    const next = deepClone(current);
                    next.doctor.enableLivePing = event.target.checked;
                    return next;
                  })
                }
                disabled={configSaving}
              />
              Doctor live ping
            </label>
          )}

          <Button onClick={() => void runDoctor()} disabled={doctorRunning}>
            {doctorRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stethoscope className="mr-2 h-4 w-4" />}
            Doctor ausführen
          </Button>

          {doctorError && <p className="text-sm text-destructive">{doctorError}</p>}

          {doctorResult && (
            <div className="rounded border border-border bg-muted/40 p-3 text-sm">
              <p>
                Status: <span className={doctorResult.summary.ready ? 'text-primary' : 'text-destructive'}>{doctorResult.summary.ready ? 'Ready' : 'Issues detected'}</span>
              </p>
              <p>Errors: {doctorResult.summary.errors}</p>
              <p>Warnings: {doctorResult.summary.warnings}</p>
              <p>Checked: {new Date(doctorResult.checkedAt).toLocaleString()}</p>
              {doctorResult.checks.livePing?.openrouter?.warning && (
                <p className="text-muted-foreground">OpenRouter Ping: {doctorResult.checks.livePing.openrouter.warning}</p>
              )}
              {doctorResult.checks.livePing?.ollama?.warning && (
                <p className="text-muted-foreground">Ollama Ping: {doctorResult.checks.livePing.ollama.warning}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Files</CardTitle>
          <CardDescription>Bearbeite AGENTS.md, MEMORY.md, SOUL.md und TOOLS.md.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {filesLoading || !files ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Lade Agent-Dateien...
            </div>
          ) : (
            <>
              <Tabs value={activeFile} onValueChange={(value) => setActiveFile(value as ManagedFileName)}>
                <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
                  {MANAGED_FILES.map((fileName) => (
                    <TabsTrigger key={fileName} value={fileName} className="border border-border data-[state=active]:bg-muted">
                      {fileName}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              <textarea
                className="min-h-[260px] w-full border border-input bg-background p-3 font-mono text-sm"
                value={fileDrafts[activeFile] ?? ''}
                onChange={(event) =>
                  setFileDrafts((current) => ({
                    ...current,
                    [activeFile]: event.target.value,
                  }))
                }
                spellCheck={false}
                disabled={filesSaving}
              />

              {filesError && <p className="text-sm text-destructive">{filesError}</p>}
              {filesSuccess && <p className="text-sm text-primary">{filesSuccess}</p>}

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveActiveFile()} disabled={filesSaving}>
                  {filesSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Datei speichern
                </Button>
                <Button variant="outline" onClick={() => void loadFiles()} disabled={filesLoading || filesSaving}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Dateien neu laden
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Sessions erstellen, umbenennen, löschen und Verlauf einsehen.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Neue Session (optionaler Titel)"
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              disabled={sessionPendingId !== null}
            />
            <Button onClick={() => void createSession()} disabled={sessionPendingId !== null}>
              {sessionPendingId === 'create' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Neue Session
            </Button>
            <Button variant="outline" onClick={() => void loadSessions()} disabled={sessionsLoading || sessionPendingId !== null}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Neu laden
            </Button>
            <Button
              variant="destructive"
              onClick={() => void deleteAllSessions()}
              disabled={sessionPendingId !== null || sessionsLoading || sessions.length === 0}
            >
              {sessionPendingId === 'delete-all' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Alle Sessions löschen
            </Button>
          </div>

          {sessionError && <p className="text-sm text-destructive">{sessionError}</p>}

          {sessionsLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Lade Sessions...
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine Sessions vorhanden.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((sessionItem) => {
                const isPending = sessionPendingId === sessionItem.sessionId;
                const creatorLabel =
                  sessionItem.creator?.name || sessionItem.creator?.email || 'Unknown creator';

                return (
                  <div key={sessionItem.sessionId} className="rounded border border-border p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{sessionItem.sessionId}</span>
                      <span>{new Date(sessionItem.createdAt).toLocaleString()}</span>
                    </div>

                    <div className="mb-2 grid gap-2 md:grid-cols-[1fr_auto_auto] md:items-center">
                      <Input
                        value={renameDrafts[sessionItem.sessionId] ?? ''}
                        onChange={(event) =>
                          setRenameDrafts((current) => ({
                            ...current,
                            [sessionItem.sessionId]: event.target.value,
                          }))
                        }
                        disabled={sessionPendingId !== null}
                      />
                      <Button
                        variant="outline"
                        onClick={() => void renameSession(sessionItem.sessionId)}
                        disabled={sessionPendingId !== null}
                      >
                        {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        Umbenennen
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => void deleteSession(sessionItem.sessionId)}
                        disabled={sessionPendingId !== null}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Löschen
                      </Button>
                    </div>

                    <div className="text-xs text-muted-foreground">
                      <span className="mr-3">Provider: {sessionItem.model}</span>
                      <span>Creator: {creatorLabel}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
