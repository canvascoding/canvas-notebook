'use client';

import { useCallback, useEffect, useMemo, useState, startTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, ListCollapse, Wrench, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PiProviderSetupCard } from './PiProviderSetupCard';
import {
  resolveEnabledToolNames,
  serializeEnabledToolNames,
  isDefaultToolsConfig,
  getDefaultEnabledToolNames,
} from '@/app/lib/pi/enabled-tools';
import { useToolVerbosityStore, type ToolVerbosity } from '@/app/store/tool-verbosity-store';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { AgentSessionsCard, type AgentSessionItem } from './AgentSessionsCard';
import { AgentDoctorCard, type DoctorResult } from './AgentDoctorCard';
import { AgentManagedFilesCard, MANAGED_FILES, type ManagedFileName, type ResetTarget } from './AgentManagedFilesCard';
import { AgentToolsCard, type ToolMetadata } from './AgentToolsCard';

const SETTINGS_AGENT_ID = DEFAULT_AGENT_ID;

function buildAgentQuery(): string {
  return new URLSearchParams({ agentId: SETTINGS_AGENT_ID }).toString();
}

type SessionItem = AgentSessionItem;

type PiConfigData = {
  activeProvider: string;
  providers: Record<string, { enabledTools: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
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
  const t = useTranslations('settings');
  const searchParams = useSearchParams();
  const toolVerbosity = useToolVerbosityStore((s) => s.toolVerbosity);
  const setToolVerbosity = useToolVerbosityStore((s) => s.setToolVerbosity);

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
    'IDENTITY.md': '',
    'USER.md': '',
    'MEMORY.md': '',
    'SOUL.md': '',
    'TOOLS.md': '',
    'HEARTBEAT.md': '',
  });
  const [activeFile, setActiveFile] = useState<ManagedFileName>('AGENTS.md');
  const [filesResetting, setFilesResetting] = useState(false);

  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [createTitle, setCreateTitle] = useState('');
  const [sessionPendingId, setSessionPendingId] = useState<string | null>(null);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});

  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [openToolRows, setOpenToolRows] = useState<Record<string, boolean>>({});
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsPiConfig, setToolsPiConfig] = useState<PiConfigData | null>(null);
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [activeToolGroups, setActiveToolGroups] = useState<Set<string>>(new Set());

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);

    try {
      const payload = await fetchJson<{ files: Record<ManagedFileName, string> }>(`/api/agents/files?${buildAgentQuery()}`);
      setFiles(payload.files);
      setFileDrafts(payload.files);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : t('agentPanel.files.errors.load'));
    } finally {
      setFilesLoading(false);
    }
  }, [t]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionError(null);

    try {
      const params = new URLSearchParams({ agentId: SETTINGS_AGENT_ID });
      const payload = await fetch(`/api/sessions?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const body = (await payload.json()) as {
        success?: boolean;
        error?: string;
        sessions?: SessionItem[];
      };

      if (!payload.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.sessions.errors.load'));
      }

      const nextSessions = body.sessions || [];
      setSessions(nextSessions);
      setRenameDrafts(
        Object.fromEntries(nextSessions.map((item) => [item.sessionId, item.title || ''])) as Record<string, string>,
      );
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.load'));
    } finally {
      setSessionsLoading(false);
    }
  }, [t]);

  const loadTools = useCallback(async () => {
    setToolsLoading(true);
    setToolsError(null);

    try {
      const payload = await fetchJson<{ tools: ToolMetadata[] }>(`/api/agents/tools?${buildAgentQuery()}`);
      setAvailableTools(payload.tools);
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.loading'));
    } finally {
      setToolsLoading(false);
    }
  }, [t]);

  const loadToolsConfig = useCallback(async () => {
    try {
      const payload = await fetchJson<{ piConfig: PiConfigData }>(`/api/agents/config?${buildAgentQuery()}`);
      setToolsPiConfig(payload.piConfig);
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.saveError'));
    }
  }, [t]);

  const runDoctor = useCallback(async () => {
    setDoctorRunning(true);
    setDoctorError(null);

    try {
      const payload = await fetchJson<DoctorResult>('/api/agents/doctor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: SETTINGS_AGENT_ID, livePing: true }),
      });
      setDoctorResult(payload);
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : t('agentPanel.doctor.errors.run'));
    } finally {
      setDoctorRunning(false);
    }
  }, [t]);

  useEffect(() => {
    startTransition(() => {
      void loadFiles();
      void loadSessions();
      void loadTools();
      void loadToolsConfig();
    });
  }, [loadFiles, loadSessions, loadTools, loadToolsConfig]);

  useEffect(() => {
    if (searchParams.get('panel') === 'doctor' && !doctorResult && !doctorRunning) {
      startTransition(() => { void runDoctor(); });
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
          agentId: SETTINGS_AGENT_ID,
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
      setFilesSuccess(t('agentPanel.files.saved', { fileName: payload.fileName }));
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : t('agentPanel.files.errors.save'));
    } finally {
      setFilesSaving(false);
    }
  };

  const resetFile = async () => {
    if (!resetTarget) return;

    setFilesResetting(true);
    setFilesError(null);
    setFilesSuccess(null);

    try {
      if (resetTarget === 'current') {
        const payload = await fetchJson<{ fileName: ManagedFileName; content: string }>('/api/agents/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: SETTINGS_AGENT_ID,
            action: 'reset',
            fileName: activeFile,
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
        setFilesSuccess(t('agentPanel.files.resetSuccess', { fileName: payload.fileName }));
      } else {
        const payload = await fetchJson<{ files: Array<{ fileName: ManagedFileName; content: string }> }>('/api/agents/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: SETTINGS_AGENT_ID,
            action: 'reset',
          }),
        });

        const newFiles: Record<ManagedFileName, string> = { ...fileDrafts };
        for (const { fileName, content } of payload.files) {
          newFiles[fileName] = content;
        }

        setFiles((current) => ({
          ...(current || fileDrafts),
          ...newFiles,
        }));
        setFileDrafts(newFiles);
        setFilesSuccess(t('agentPanel.files.resetAllSuccess'));
      }
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : t('agentPanel.files.errors.reset'));
    } finally {
      setFilesResetting(false);
      setResetDialogOpen(false);
      setResetTarget(null);
    }
  };

  const openResetDialog = (target: ResetTarget) => {
    setResetTarget(target);
    setResetDialogOpen(true);
  };

  const createSession = async () => {
    setSessionPendingId('create');
    setSessionError(null);

    try {
      await fetchJson<{ session: SessionItem }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: SETTINGS_AGENT_ID, title: createTitle.trim() || undefined }),
      });

      setCreateTitle('');
      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.create'));
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
          agentId: SETTINGS_AGENT_ID,
          sessionId,
          title: (renameDrafts[sessionId] || '').trim(),
        }),
      });

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.rename'));
    } finally {
      setSessionPendingId(null);
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (!window.confirm(t('agentPanel.sessions.confirmDeleteOne'))) {
      return;
    }

    setSessionPendingId(sessionId);
    setSessionError(null);

    try {
      const params = new URLSearchParams({ agentId: SETTINGS_AGENT_ID, sessionId });
      const response = await fetch(`/api/sessions?${params.toString()}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.sessions.errors.delete'));
      }

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.delete'));
    } finally {
      setSessionPendingId(null);
    }
  };

  const deleteAllSessions = async () => {
    if (!window.confirm(t('agentPanel.sessions.confirmDeleteAll'))) {
      return;
    }

    setSessionPendingId('delete-all');
    setSessionError(null);

    try {
      const params = new URLSearchParams({ agentId: SETTINGS_AGENT_ID, all: 'true' });
      const response = await fetch(`/api/sessions?${params.toString()}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.sessions.errors.deleteAll'));
      }

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.deleteAll'));
    } finally {
      setSessionPendingId(null);
    }
  };

  const getActiveEnabledTools = (): string[] => {
    if (!toolsPiConfig) return [];
    const activeProvider = toolsPiConfig.providers[toolsPiConfig.activeProvider];
    return activeProvider?.enabledTools ?? [];
  };

  const isToolEnabled = (toolName: string): boolean => {
    const enabledTools = getActiveEnabledTools();
    const allNames = availableTools.map((t) => t.name);
    
    // If the user has never configured tools (empty config), use defaults
    if (isDefaultToolsConfig(enabledTools)) {
      const defaultSet = getDefaultEnabledToolNames(allNames);
      return defaultSet.has(toolName);
    }
    
    const enabledSet = resolveEnabledToolNames(allNames, enabledTools);
    return enabledSet.has(toolName);
  };

  const saveToolsConfig = async (newEnabledTools: string[]) => {
    if (!toolsPiConfig) return;
    setToolsSaving(true);
    setToolsError(null);

    try {
      const nextConfig = { ...toolsPiConfig };
      const providerId = nextConfig.activeProvider;
      nextConfig.providers = {
        ...nextConfig.providers,
        [providerId]: {
          ...nextConfig.providers[providerId],
          enabledTools: newEnabledTools,
        },
      };

      const payload = await fetchJson<{ piConfig: PiConfigData }>('/api/agents/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: SETTINGS_AGENT_ID, piConfig: nextConfig }),
      });
      setToolsPiConfig(payload.piConfig);
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.saveError'));
    } finally {
      setToolsSaving(false);
    }
  };

  const handleToolToggle = (toolName: string, enabled: boolean) => {
    const currentEnabled = getActiveEnabledTools();
    const allNames = availableTools.map((t) => t.name);
    let newEnabledTools: string[];

    if (enabled) {
      const enabledSet = resolveEnabledToolNames(allNames, currentEnabled);
      enabledSet.add(toolName);
      newEnabledTools = serializeEnabledToolNames(enabledSet, allNames);
    } else {
      const enabledSet = resolveEnabledToolNames(allNames, currentEnabled);
      enabledSet.delete(toolName);
      newEnabledTools = serializeEnabledToolNames(enabledSet, allNames);
    }

    void saveToolsConfig(newEnabledTools);
  };

  const handleEnableAll = () => {
    void saveToolsConfig([]);
  };

  const handleDisableAll = () => {
    void saveToolsConfig(['__none__']);
  };

  const toolGroups = useMemo(() => {
    const groups = [...new Set(availableTools.map(t => t.group).filter(Boolean))] as string[];
    return groups.sort();
  }, [availableTools]);

  const filteredTools = useMemo(() => {
    let result = availableTools;
    if (activeToolGroups.size > 0) {
      result = result.filter(t => t.group && activeToolGroups.has(t.group));
    }
    if (toolSearchQuery.trim()) {
      const q = toolSearchQuery.trim().toLowerCase();
      result = result.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.group && t.group.toLowerCase().includes(q))
      );
    }
    return result;
  }, [availableTools, activeToolGroups, toolSearchQuery]);

  const toggleToolGroup = (group: string) => {
    setActiveToolGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const deleteOlderSessions = async () => {
    setSessionPendingId('delete-older');
    setSessionError(null);

    try {
      const countParams = new URLSearchParams({
        agentId: SETTINGS_AGENT_ID,
        countOnly: 'true',
        olderThanDays: '14',
      });
      const countResponse = await fetch(`/api/sessions?${countParams.toString()}`, {
        credentials: 'include',
      });
      const countBody = (await countResponse.json()) as { success?: boolean; count?: number; error?: string };
      if (!countResponse.ok || !countBody.success) {
        throw new Error(countBody.error || t('agentPanel.sessions.errors.deleteOlder'));
      }

      const olderCount = countBody.count ?? 0;
      if (olderCount === 0) {
        setSessionError(t('agentPanel.sessions.noOlderSessions'));
        return;
      }

      if (!window.confirm(t('agentPanel.sessions.deleteOlderConfirm', { count: olderCount }))) {
        return;
      }

      const deleteParams = new URLSearchParams({
        agentId: SETTINGS_AGENT_ID,
        olderThanDays: '14',
      });
      const response = await fetch(`/api/sessions?${deleteParams.toString()}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await response.json()) as { success?: boolean; error?: string; count?: number };
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.sessions.errors.deleteOlder'));
      }

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.deleteOlder'));
    } finally {
      setSessionPendingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div id="onboarding-settings-agentSettings">
        <PiProviderSetupCard />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5" />
            {t('agentPanel.chatDisplay.title')}
          </CardTitle>
          <CardDescription>{t('agentPanel.chatDisplay.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-3">
            {([
              { value: 'minimal', icon: EyeOff },
              { value: 'subtle', icon: ListCollapse },
              { value: 'verbose', icon: Wrench },
            ] as Array<{ value: ToolVerbosity; icon: LucideIcon }>).map((option) => {
              const Icon = option.icon;
              const isActive = toolVerbosity === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setToolVerbosity(option.value)}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    isActive
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border bg-background hover:bg-muted/40'
                  }`}
                  aria-pressed={isActive}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Icon className="h-4 w-4" />
                    {t(`agentPanel.chatDisplay.${option.value}`)}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t(`agentPanel.chatDisplay.${option.value}Description`)}
                  </p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <AgentToolsCard
        availableTools={availableTools}
        filteredTools={filteredTools}
        toolGroups={toolGroups}
        activeToolGroups={activeToolGroups}
        openToolRows={openToolRows}
        toolsLoading={toolsLoading}
        toolsSaving={toolsSaving}
        toolsError={toolsError}
        toolSearchQuery={toolSearchQuery}
        isToolEnabled={isToolEnabled}
        onToolSearchQueryChange={setToolSearchQuery}
        onToggleToolGroup={toggleToolGroup}
        onClearToolGroups={() => setActiveToolGroups(new Set())}
        onToolRowOpenChange={(toolName, open) => setOpenToolRows((current) => ({ ...current, [toolName]: open }))}
        onToolToggle={handleToolToggle}
        onEnableAll={handleEnableAll}
        onDisableAll={handleDisableAll}
      />

      <AgentManagedFilesCard
        files={files}
        fileDrafts={fileDrafts}
        activeFile={activeFile}
        filesLoading={filesLoading}
        filesSaving={filesSaving}
        filesResetting={filesResetting}
        filesError={filesError}
        filesSuccess={filesSuccess}
        resetDialogOpen={resetDialogOpen}
        resetTarget={resetTarget}
        onActiveFileChange={setActiveFile}
        onDraftChange={(fileName, value) =>
          setFileDrafts((current) => ({
            ...current,
            [fileName]: value,
          }))
        }
        onSaveActiveFile={() => void saveActiveFile()}
        onReloadFiles={() => void loadFiles()}
        onOpenResetDialog={openResetDialog}
        onResetDialogOpenChange={setResetDialogOpen}
        onClearResetTarget={() => {
          setResetDialogOpen(false);
          setResetTarget(null);
        }}
        onResetFile={() => void resetFile()}
      />

      <AgentSessionsCard
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        sessionError={sessionError}
        createTitle={createTitle}
        sessionPendingId={sessionPendingId}
        renameDrafts={renameDrafts}
        onCreateTitleChange={setCreateTitle}
        onRenameDraftChange={(sessionId, value) =>
          setRenameDrafts((current) => ({
            ...current,
            [sessionId]: value,
          }))
        }
        onCreateSession={() => void createSession()}
        onRenameSession={(sessionId) => void renameSession(sessionId)}
        onDeleteSession={(sessionId) => void deleteSession(sessionId)}
        onDeleteAllSessions={() => void deleteAllSessions()}
        onDeleteOlderSessions={() => void deleteOlderSessions()}
      />

      <AgentDoctorCard
        doctorResult={doctorResult}
        doctorRunning={doctorRunning}
        doctorError={doctorError}
        onRunDoctor={() => void runDoctor()}
      />
    </div>
  );
}
