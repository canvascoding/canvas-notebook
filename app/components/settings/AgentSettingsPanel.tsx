'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  HelpCircle,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Stethoscope,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  getProviderHelp,
  type ProviderHelpInfo,
} from '@/app/lib/pi/provider-help';
import { ProviderEnvEditor } from './ProviderEnvEditor';
import { OpenAICodexOAuth } from './OpenAICodexOAuth';

const MANAGED_FILES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

type ManagedFileName = (typeof MANAGED_FILES)[number];

type PiThinkingLevel = 'none' | 'low' | 'medium' | 'high';

type PiProviderConfig = {
  id: string;
  model: string;
  thinking: PiThinkingLevel;
  enabledTools: string[];
};

type PiRuntimeConfig = {
  version: number;
  activeProvider: string;
  providers: Record<string, PiProviderConfig>;
  updatedAt: string;
  updatedBy: string;
};

type DiscoveryMetadata = Record<string, { models: { id: string; name: string }[] }>;

type AgentConfigResponse = {
  piConfig: PiRuntimeConfig;
  engine: 'legacy' | 'pi';
  readiness: AgentConfigReadiness;
  discovery: DiscoveryMetadata;
};

type AgentConfigReadiness = {
  activeProviderId: string;
  activeProviderReady: boolean;
  pi?: {
    activeProvider: string;
    model: string;
    ready: boolean;
    authSet: boolean;
    issues: string[];
  };
};

type DoctorResult = {
  checkedAt: string;
  summary: {
    ready: boolean;
    errors: number;
    warnings: number;
  };
  readiness: AgentConfigReadiness;
  promptDiagnostics: {
    loadedFiles: ManagedFileName[];
    includedFiles: ManagedFileName[];
    emptyFiles: ManagedFileName[];
    usedFallback: boolean;
    fallbackReason: 'all-empty' | 'read-failed' | null;
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

export function AgentSettingsPanel() {
  const searchParams = useSearchParams();

  const [piConfigDraft, setPiConfigDraft] = useState<PiRuntimeConfig | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryMetadata>({});
  const [readiness, setReadiness] = useState<AgentConfigReadiness | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState<string | null>(null);

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

  // Provider help collapsible state
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // Selected provider status (for live preview)
  const [selectedProviderStatus, setSelectedProviderStatus] = useState<{ isReady: boolean; hasApiKey: boolean; hasOAuth: boolean; requiresKey: boolean; requiresOAuth: boolean; issues: string[] } | null>(null);
  const [selectedProviderLoading, setSelectedProviderLoading] = useState(false);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);

    try {
      const payload = await fetchJson<AgentConfigResponse>(
        '/api/agents/config',
      );
      setPiConfigDraft(deepClone(payload.piConfig));
      setDiscovery(payload.discovery || {});
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

  // Listen for refresh events from ProviderEnvEditor
  useEffect(() => {
    const handleRefresh = () => {
      void loadConfig();
    };
    window.addEventListener('refresh-agent-config', handleRefresh);
    return () => window.removeEventListener('refresh-agent-config', handleRefresh);
  }, [loadConfig]);

  const saveConfig = async () => {
    if (!piConfigDraft) {
      return;
    }

    setConfigSaving(true);
    setConfigError(null);
    setConfigSuccess(null);

    try {
      const payload = await fetchJson<AgentConfigResponse>(
        '/api/agents/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            piConfig: piConfigDraft,
          }),
        },
      );

      setPiConfigDraft(deepClone(payload.piConfig));
      setReadiness(payload.readiness);
      setConfigSuccess('Agent-Konfiguration gespeichert.');
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to save agent config.');
    } finally {
      setConfigSaving(false);
    }
  };

  const setPiProviderField = <K extends keyof PiProviderConfig>(
    providerId: string,
    field: K,
    value: PiProviderConfig[K]
  ) => {
    setPiConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = deepClone(current);
      if (!next.providers[providerId]) {
        next.providers[providerId] = {
          id: providerId,
          model: '',
          thinking: 'none',
          enabledTools: [],
        };
      }
      next.providers[providerId][field] = value;
      return next;
    });
  };

  const setActivePiProvider = (providerId: string) => {
    setPiConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = deepClone(current);
      next.activeProvider = providerId;
      
      // Ensure the provider exists in the config
      if (!next.providers[providerId]) {
        next.providers[providerId] = {
          id: providerId,
          model: '',
          thinking: 'none',
          enabledTools: ['filesystem', 'terminal'],
        };
      }
      
      return next;
    });

    // Load status for the newly selected provider
    void loadProviderStatus(providerId);
  };

  const loadProviderStatus = useCallback(async (providerId: string) => {
    setSelectedProviderLoading(true);
    try {
      const response = await fetch(`/api/agents/provider-status?providerId=${encodeURIComponent(providerId)}`, {
        credentials: 'include',
      });
      const data = await response.json();
      
      if (data.success) {
        setSelectedProviderStatus({
          isReady: data.isReady,
          hasApiKey: data.hasApiKey,
          hasOAuth: data.hasOAuth,
          requiresKey: data.requiresKey,
          requiresOAuth: data.requiresOAuth,
          issues: data.issues,
        });
      }
    } catch (error) {
      console.error('Failed to load provider status:', error);
    } finally {
      setSelectedProviderLoading(false);
    }
  }, []);

  // Load provider status when config is loaded or activeProvider changes
  useEffect(() => {
    if (piConfigDraft?.activeProvider) {
      void loadProviderStatus(piConfigDraft.activeProvider);
    }
  }, [piConfigDraft?.activeProvider, loadProviderStatus]);

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

  if (configLoading && !piConfigDraft) {
    return (
      <div className="flex items-center text-sm text-muted-foreground p-8">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Lade Agent-Konfiguration...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {piConfigDraft && (
        <Card className="border-primary shadow-sm">
          <CardHeader>
            <CardTitle>Agent Runtime Settings</CardTitle>
            <CardDescription>
              Konfiguration der PI-basierten Agent-Engine.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="font-semibold">Aktiver Provider</span>
                <select
                  data-testid="provider-select"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  value={piConfigDraft.activeProvider}
                  onChange={(event) => setActivePiProvider(event.target.value)}
                  disabled={configSaving}
                >
                  {Object.keys(discovery).length > 0 
                    ? Object.keys(discovery).sort().map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))
                    : Object.keys(piConfigDraft.providers).map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))
                  }
                </select>
              </label>

              {piConfigDraft.providers[piConfigDraft.activeProvider] && (
                <div className="space-y-2 text-sm">
                  <span className="font-semibold">Modell für {piConfigDraft.activeProvider}</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    value={piConfigDraft.providers[piConfigDraft.activeProvider].model}
                    onChange={(event) => setPiProviderField(piConfigDraft.activeProvider, 'model', event.target.value)}
                    disabled={configSaving}
                  >
                    <option value="">-- Modell wählen --</option>
                    {(discovery[piConfigDraft.activeProvider]?.models || []).map(m => (
                      <option key={m.id} value={m.id}>{m.name || m.id}</option>
                    ))}
                    {!discovery[piConfigDraft.activeProvider] && (
                      <option value={piConfigDraft.providers[piConfigDraft.activeProvider].model}>
                        {piConfigDraft.providers[piConfigDraft.activeProvider].model} (Manuell)
                      </option>
                    )}
                  </select>
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="font-semibold">Thinking Level</span>
                <select
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  value={piConfigDraft.providers[piConfigDraft.activeProvider]?.thinking || 'none'}
                  onChange={(event) => setPiProviderField(piConfigDraft.activeProvider, 'thinking', event.target.value as PiThinkingLevel)}
                  disabled={configSaving}
                >
                  <option value="none">None (Standard)</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High / Reasoning</option>
                </select>
              </label>

              <div className="rounded border border-border bg-muted/40 p-3 text-xs">
                <p className="font-semibold mb-1">Provider-Status</p>
                {selectedProviderLoading ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span className="text-muted-foreground">Prüfe...</span>
                  </div>
                ) : (
                  <>
                    <p className={selectedProviderStatus?.isReady ? 'text-primary' : 'text-destructive font-bold'}>
                      {selectedProviderStatus?.isReady ? 'Bereit (Ready)' : 'Nicht bereit (Not ready)'}
                    </p>
                    {selectedProviderStatus?.issues?.[0] && (
                      <p className="mt-1 text-muted-foreground">{selectedProviderStatus.issues[0]}</p>
                    )}
                    {piConfigDraft.activeProvider === 'openai-codex' && (
                      <div className="mt-2">
                        <OpenAICodexOAuth providerId="openai-codex" />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="rounded border border-border bg-muted/20 p-3">
              <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-tight">System Info</p>
              <p className="text-xs text-muted-foreground">
                Die Engine nutzt API-Keys aus den Integrations-Einstellungen. 
                Modell-Discovery erfolgt über die PI-Registry.
              </p>
            </div>

            {/* Provider Help Section */}
            {piConfigDraft.activeProvider && (
              <ProviderHelpSection
                providerId={piConfigDraft.activeProvider}
                isProviderReady={readiness?.pi?.ready || false}
                isOpen={isHelpOpen}
                onOpenChange={setIsHelpOpen}
                piConfigDraft={piConfigDraft}
                setPiConfigDraft={setPiConfigDraft}
                setReadiness={setReadiness}
              />
            )}

            {configError && <p className="text-sm text-destructive">{configError}</p>}
            {configSuccess && <p className="text-sm text-primary">{configSuccess}</p>}

            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={() => void saveConfig()} disabled={configSaving}>
                {configSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Einstellungen speichern
              </Button>
              <Button variant="outline" onClick={() => void loadConfig()} disabled={configLoading || configSaving}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Neu laden
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Doctor</CardTitle>
          <CardDescription>System-Check für Provider und Konnektivität.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
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
              <p>Prompt files loaded: {doctorResult.promptDiagnostics.loadedFiles.join(', ') || 'None'}</p>
              <p>Prompt files included: {doctorResult.promptDiagnostics.includedFiles.join(', ') || 'None'}</p>
              <p>Prompt files empty: {doctorResult.promptDiagnostics.emptyFiles.join(', ') || 'None'}</p>
              <p>
                Prompt fallback:{' '}
                <span className={doctorResult.promptDiagnostics.usedFallback ? 'text-destructive font-medium' : 'text-primary'}>
                  {doctorResult.promptDiagnostics.usedFallback
                    ? `Active (${doctorResult.promptDiagnostics.fallbackReason || 'unknown'})`
                    : 'Inactive'}
                </span>
              </p>
              {doctorResult.readiness.pi?.issues.map((issue, idx) => (
                <p key={idx} className="text-destructive font-medium mt-1">• {issue}</p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Managed Files</CardTitle>
          <CardDescription>System-relevante Markdown-Dateien für das Agent-Verhalten.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {filesLoading || !files ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Lade Dateien...
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
                data-testid="agent-managed-file-editor"
                className="min-h-[260px] w-full border border-input rounded-md bg-background p-3 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
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
                <Button data-testid="agent-managed-file-save" onClick={() => void saveActiveFile()} disabled={filesSaving}>
                  {filesSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Speichern
                </Button>
                <Button variant="outline" onClick={() => void loadFiles()} disabled={filesLoading || filesSaving}>
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
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Chat-Historie verwalten.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              className="flex-1 min-w-[200px]"
              placeholder="Neue Session (Titel optional)"
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              disabled={sessionPendingId !== null}
            />
            <Button onClick={() => void createSession()} disabled={sessionPendingId !== null}>
              {sessionPendingId === 'create' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Neu
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void deleteAllSessions()}
              disabled={sessionPendingId !== null || sessionsLoading || sessions.length === 0}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Alle löschen
            </Button>
          </div>

          {sessionError && <p className="text-sm text-destructive">{sessionError}</p>}

          {sessionsLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Lade...
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Kein Verlauf vorhanden.</p>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {sessions.map((sessionItem) => {
                const isPending = sessionPendingId === sessionItem.sessionId;
                const creatorLabel =
                  sessionItem.creator?.name || sessionItem.creator?.email || 'Unknown';

                return (
                  <div key={sessionItem.sessionId} className="rounded border border-border p-3 hover:bg-muted/10 transition-colors">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground uppercase tracking-wider font-bold">
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
                        variant="ghost"
                        size="sm"
                        onClick={() => void renameSession(sessionItem.sessionId)}
                        disabled={sessionPendingId !== null}
                      >
                        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => void deleteSession(sessionItem.sessionId)}
                        disabled={sessionPendingId !== null}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="text-[10px] text-muted-foreground flex justify-between">
                      <span>Model: {sessionItem.model}</span>
                      <span>User: {creatorLabel}</span>
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

/**
 * Provider Help Section Component
 * Shows collapsible help information for the selected provider
 */
interface ProviderHelpSectionProps {
  providerId: string;
  isProviderReady: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  piConfigDraft: PiRuntimeConfig | null;
  setPiConfigDraft: React.Dispatch<React.SetStateAction<PiRuntimeConfig | null>>;
  setReadiness: React.Dispatch<React.SetStateAction<AgentConfigReadiness | null>>;
}

function ProviderHelpSection({ 
  providerId, 
  isProviderReady, 
  isOpen, 
  onOpenChange,
  piConfigDraft,
  setPiConfigDraft,
  setReadiness
}: ProviderHelpSectionProps) {
  const help = getProviderHelp(providerId);

  if (!help) {
    return null;
  }

  const getCategoryIcon = (category: ProviderHelpInfo['category']) => {
    switch (category) {
      case 'api-key':
        return '🔑';
      case 'oauth-cli':
        return '🔐';
      case 'adc':
        return '☁️';
      case 'aws':
        return '⚡';
      case 'azure':
        return '🔷';
      case 'ollama':
        return '🖥️';
      default:
        return '❓';
    }
  };

  const getCategoryLabel = (category: ProviderHelpInfo['category']) => {
    switch (category) {
      case 'api-key':
        return 'API Key';
      case 'oauth-cli':
        return 'OAuth/CLI Login';
      case 'adc':
        return 'Application Default Credentials';
      case 'aws':
        return 'AWS Credentials';
      case 'azure':
        return 'Azure Credentials';
      case 'ollama':
        return 'Local Installation';
      default:
        return 'Unknown';
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex items-center justify-between w-full rounded border border-border bg-muted/30 p-3 text-sm hover:bg-muted/50 transition-colors">
        <div className="flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">
            {getCategoryIcon(help.category)} {help.title} - Konfiguration
          </span>
          {isProviderReady && (
            <span className="ml-2 text-xs text-primary bg-primary/10 px-2 py-0.5 rounded">
              Konfiguriert
            </span>
          )}
        </div>
        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="rounded-b border-x border-b border-border bg-muted/20 p-4 space-y-4">
          {/* Provider Category Badge */}
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-border bg-background px-2 py-1 text-xs font-medium">
              {getCategoryLabel(help.category)}
            </span>
          </div>

          {/* Description */}
          <p className="text-sm text-muted-foreground">{help.shortDescription}</p>

          {/* Setup Steps */}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Einrichtung:</h4>
            <ol className="ml-4 list-decimal text-sm text-muted-foreground space-y-1">
              {help.setupSteps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>

          {/* Environment Variables */}
          {help.envVars && help.envVars.length > 0 && (
            <div className="space-y-4 border-t border-border pt-4">
              <h4 className="text-sm font-semibold">API-Keys konfigurieren:</h4>
              <ProviderEnvEditor
                providerId={providerId}
                envVars={help.envVars}
                onSaveComplete={() => {
                  // Refresh provider status after save
                  window.dispatchEvent(new CustomEvent('refresh-agent-config'));
                }}
                onProviderActivate={async () => {
                  // Activate this provider as the active provider
                  if (piConfigDraft && piConfigDraft.activeProvider !== providerId) {
                    try {
                      const payload = await fetchJson<AgentConfigResponse>(
                        '/api/agents/config',
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            piConfig: {
                              ...piConfigDraft,
                              activeProvider: providerId,
                            },
                          }),
                        },
                      );
                      // Update local state
                      setPiConfigDraft(deepClone(payload.piConfig));
                      setReadiness(payload.readiness);
                    } catch (error) {
                      console.error('Failed to activate provider:', error);
                      throw error;
                    }
                  }
                }}
              />
            </div>
          )}

          {/* CLI Commands */}
          {help.cliCommands && help.cliCommands.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">CLI-Befehle:</h4>
              <div className="space-y-2">
                {help.cliCommands.map((cmd, index) => (
                  <div key={index} className="rounded bg-black/90 p-2 font-mono text-xs text-white">
                    <span className="text-green-400">$</span> {cmd.command}
                    <p className="mt-1 text-gray-400">{cmd.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {help.notes && help.notes.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">Hinweise:</h4>
              <ul className="ml-4 list-disc text-sm text-muted-foreground space-y-1">
                {help.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Documentation Link */}
          {help.documentationUrl && (
            <div className="pt-2 border-t border-border">
              <a
                href={help.documentationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-xs text-primary hover:underline"
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                Offizielle Dokumentation öffnen
              </a>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
