'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, Plus, RefreshCw, Save, Stethoscope, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PiProviderSetupCard } from './PiProviderSetupCard';

const MANAGED_FILES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

type ManagedFileName = (typeof MANAGED_FILES)[number];

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
  qmd: {
    ready: boolean;
    binaryAvailable: boolean;
    defaultMode: 'search' | 'vsearch' | 'query';
    allowExpensiveQueryMode: boolean;
    collections: Array<{
      name: string;
      sourceType: 'workspace-text' | 'workspace-derived';
      path: string;
      present: boolean;
    }>;
    lastUpdateAt: string | null;
    lastUpdateSuccess: boolean;
    lastEmbedAt: string | null;
    derivedDocxIndexing: {
      enabled: boolean;
      healthy: boolean;
      lastRunAt: string | null;
      extractedCount: number;
      updatedCount: number;
      errorCount: number;
      warningCount: number;
    };
    issues: string[];
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
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : 'Doctor check failed.');
    } finally {
      setDoctorRunning(false);
    }
  }, []);

  useEffect(() => {
    void loadFiles();
    void loadSessions();
  }, [loadFiles, loadSessions]);

  useEffect(() => {
    if (searchParams.get('panel') === 'doctor' && !doctorResult && !doctorRunning) {
      void runDoctor();
    }
  }, [searchParams, doctorResult, doctorRunning, runDoctor]);

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
      <PiProviderSetupCard />

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
              <div className="mt-3 rounded border border-border/70 bg-background/70 p-3">
                <p>
                  qmd: <span className={doctorResult.qmd.ready ? 'text-primary font-medium' : 'text-destructive font-medium'}>
                    {doctorResult.qmd.ready ? 'Ready' : 'Needs attention'}
                  </span>
                </p>
                <p>qmd binary: {doctorResult.qmd.binaryAvailable ? 'available' : 'missing'}</p>
                <p>Default mode: {doctorResult.qmd.defaultMode}</p>
                <p>Expensive query mode: {doctorResult.qmd.allowExpensiveQueryMode ? 'enabled' : 'disabled'}</p>
                <p>Collections: {doctorResult.qmd.collections.map((collection) => collection.name).join(', ') || 'None'}</p>
                <p>Last qmd update: {doctorResult.qmd.lastUpdateAt ? new Date(doctorResult.qmd.lastUpdateAt).toLocaleString() : 'No successful update yet'}</p>
                <p>Last qmd embed: {doctorResult.qmd.lastEmbedAt ? new Date(doctorResult.qmd.lastEmbedAt).toLocaleString() : 'Not recorded yet'}</p>
                <p>
                  Derived DOCX indexing:{' '}
                  <span className={doctorResult.qmd.derivedDocxIndexing.enabled && doctorResult.qmd.derivedDocxIndexing.healthy ? 'text-primary font-medium' : 'text-destructive font-medium'}>
                    {doctorResult.qmd.derivedDocxIndexing.enabled
                      ? doctorResult.qmd.derivedDocxIndexing.healthy
                        ? 'Healthy'
                        : 'With issues'
                      : 'Disabled'}
                  </span>
                </p>
                <p>Derived last run: {doctorResult.qmd.derivedDocxIndexing.lastRunAt ? new Date(doctorResult.qmd.derivedDocxIndexing.lastRunAt).toLocaleString() : 'Not run yet'}</p>
                <p>Derived files: {doctorResult.qmd.derivedDocxIndexing.extractedCount}</p>
                <p>Derived updates: {doctorResult.qmd.derivedDocxIndexing.updatedCount}</p>
                <p>Derived warnings: {doctorResult.qmd.derivedDocxIndexing.warningCount}</p>
                <p>Derived errors: {doctorResult.qmd.derivedDocxIndexing.errorCount}</p>
              </div>
              {doctorResult.readiness.pi?.issues.map((issue, idx) => (
                <p key={idx} className="text-destructive font-medium mt-1">• {issue}</p>
              ))}
              {doctorResult.qmd.issues.map((issue, idx) => (
                <p key={`qmd-${idx}`} className="text-destructive font-medium mt-1">• {issue}</p>
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
