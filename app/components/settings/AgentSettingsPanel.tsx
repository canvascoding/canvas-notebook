'use client';

import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { PiProviderSetupCard } from './PiProviderSetupCard';
import {
  resolveEnabledToolNames,
  serializeEnabledToolNames,
  isDefaultToolsConfig,
  getDefaultEnabledToolNames,
  enableToolInConfig,
  disableToolInConfig,
} from '@/app/lib/pi/enabled-tools';
import { useToolVerbosityStore } from '@/app/store/tool-verbosity-store';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { AgentSessionsCard, type AgentSessionItem } from './AgentSessionsCard';
import { AgentDoctorCard, type DoctorResult } from './AgentDoctorCard';
import { AgentManagedFilesCard, getVisibleManagedFileNames, type ManagedFileName, type ResetTarget } from './AgentManagedFilesCard';
import { AgentToolsCard, type ToolMetadata } from './AgentToolsCard';
import { AgentChatDisplayCard } from './AgentChatDisplayCard';
import { AgentSelectorCard, type AgentProfileItem } from './AgentSelectorCard';
import type { CreateAgentInput } from './CreateAgentDialog';
import {
  AgentHeartbeatCard,
  type AgentHeartbeatConfig,
  type AgentHeartbeatDeliveryChannelOption,
  type AgentHeartbeatDeliveryDraft,
  type AgentHeartbeatScheduleDraft,
} from './AgentHeartbeatCard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type {
  FriendlySchedule,
} from '@/app/lib/automations/types';

function buildAgentQuery(agentId: string): string {
  return new URLSearchParams({ agentId }).toString();
}

type SessionItem = AgentSessionItem;

type PiConfigData = {
  activeProvider: string;
  providers: Record<string, { enabledTools: string[]; model?: string; thinking?: PiThinkingLevel; [key: string]: unknown }>;
  [key: string]: unknown;
};

type AgentSettingsSectionId = 'runtime' | 'chatDisplay' | 'tools' | 'heartbeat' | 'files' | 'sessions' | 'doctor';
type AgentSettingsSectionOpenState = Record<AgentSettingsSectionId, boolean>;

const AGENT_SETTINGS_SECTION_OPEN_STORAGE_KEY = 'canvas-settings-agent-section-open-state';
const SHOW_AGENT_DOCTOR_SECTION = false;
const DEFAULT_AGENT_SETTINGS_SECTION_OPEN_STATE: AgentSettingsSectionOpenState = {
  runtime: false,
  chatDisplay: false,
  tools: false,
  heartbeat: false,
  files: false,
  sessions: false,
  doctor: false,
};

function getInitialAgentSectionOpenState(requestedPanel: string | null): AgentSettingsSectionOpenState {
  const fallback = {
    ...DEFAULT_AGENT_SETTINGS_SECTION_OPEN_STATE,
    doctor: SHOW_AGENT_DOCTOR_SECTION && requestedPanel === 'doctor',
  };

  if (typeof window === 'undefined') return fallback;

  try {
    const storedState = JSON.parse(window.localStorage.getItem(AGENT_SETTINGS_SECTION_OPEN_STORAGE_KEY) || '{}') as Partial<AgentSettingsSectionOpenState>;
    return {
      runtime: typeof storedState.runtime === 'boolean' ? storedState.runtime : fallback.runtime,
      chatDisplay: typeof storedState.chatDisplay === 'boolean' ? storedState.chatDisplay : fallback.chatDisplay,
      tools: typeof storedState.tools === 'boolean' ? storedState.tools : fallback.tools,
      heartbeat: typeof storedState.heartbeat === 'boolean' ? storedState.heartbeat : fallback.heartbeat,
      files: typeof storedState.files === 'boolean' ? storedState.files : fallback.files,
      sessions: typeof storedState.sessions === 'boolean' ? storedState.sessions : fallback.sessions,
      doctor: SHOW_AGENT_DOCTOR_SECTION
        ? requestedPanel === 'doctor' || (typeof storedState.doctor === 'boolean' ? storedState.doctor : fallback.doctor)
        : false,
    };
  } catch {
    return fallback;
  }
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

function defaultHeartbeatScheduleDraft(): AgentHeartbeatScheduleDraft {
  return {
    kind: 'daily',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    dailyTime: '09:00',
    weeklyTime: '09:00',
    weeklyDays: ['mon'],
    intervalEvery: '1',
    intervalUnit: 'days',
  };
}

function scheduleToHeartbeatDraft(schedule: FriendlySchedule | null): AgentHeartbeatScheduleDraft {
  const draft = defaultHeartbeatScheduleDraft();
  if (!schedule) return draft;

  if (schedule.kind === 'daily') {
    return {
      ...draft,
      kind: 'daily',
      timeZone: schedule.timeZone,
      dailyTime: schedule.times[0] || draft.dailyTime,
    };
  }

  if (schedule.kind === 'weekly') {
    return {
      ...draft,
      kind: 'weekly',
      timeZone: schedule.timeZone,
      weeklyTime: schedule.times[0] || draft.weeklyTime,
      weeklyDays: schedule.days.length > 0 ? schedule.days : draft.weeklyDays,
    };
  }

  if (schedule.kind === 'interval') {
    return {
      ...draft,
      kind: 'interval',
      timeZone: schedule.timeZone,
      intervalEvery: String(schedule.every || 1),
      intervalUnit: schedule.unit,
    };
  }

  return draft;
}

function heartbeatDraftToSchedule(draft: AgentHeartbeatScheduleDraft): FriendlySchedule {
  if (draft.kind === 'weekly') {
    return {
      kind: 'weekly',
      days: draft.weeklyDays.length > 0 ? draft.weeklyDays : ['mon'],
      times: draft.weeklyTime ? [draft.weeklyTime] : ['09:00'],
      timeZone: draft.timeZone,
    };
  }

  if (draft.kind === 'interval') {
    const every = Number(draft.intervalEvery || '1');
    return {
      kind: 'interval',
      every: Number.isFinite(every) && every > 0 ? Math.floor(every) : 1,
      unit: draft.intervalUnit,
      timeZone: draft.timeZone,
    };
  }

  return {
    kind: 'daily',
    times: draft.dailyTime ? [draft.dailyTime] : ['09:00'],
    timeZone: draft.timeZone,
  };
}

function defaultHeartbeatDeliveryDraft(): AgentHeartbeatDeliveryDraft {
  return {
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
    deliverySessionId: '',
  };
}

function configToHeartbeatDeliveryDraft(config: AgentHeartbeatConfig | null): AgentHeartbeatDeliveryDraft {
  if (!config) return defaultHeartbeatDeliveryDraft();
  const deliveryMode = config.deliveryMode || 'web';
  return {
    deliveryMode,
    deliveryChannelId: config.deliveryChannelId || (deliveryMode === 'web' ? 'web' : ''),
    deliverySessionMode: config.deliverySessionMode || 'new_session',
    deliverySessionId: config.deliverySessionId || '',
  };
}

function normalizeDeliveryChannel(entry: unknown): AgentHeartbeatDeliveryChannelOption | null {
  if (!entry || typeof entry !== 'object') return null;
  const candidate = entry as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  if (!id) return null;
  return {
    id,
    label: id === 'web' ? 'Web Chat' : id.charAt(0).toUpperCase() + id.slice(1),
    connected: Boolean(candidate.connected),
    running: Boolean(candidate.running),
  };
}

export function AgentSettingsPanel() {
  const t = useTranslations('settings');
  const searchParams = useSearchParams();
  const requestedPanel = searchParams.get('panel');
  const toolVerbosity = useToolVerbosityStore((s) => s.toolVerbosity);
  const setToolVerbosity = useToolVerbosityStore((s) => s.setToolVerbosity);
  const [agentSectionOpenById, setAgentSectionOpenById] = useState<AgentSettingsSectionOpenState>(() => getInitialAgentSectionOpenState(requestedPanel));

  const [agents, setAgents] = useState<AgentProfileItem[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState(DEFAULT_AGENT_ID);
  const [agentCreating, setAgentCreating] = useState(false);
  const [agentDeletingId, setAgentDeletingId] = useState<string | null>(null);

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
    'USER.md': '',
    'MEMORY.md': '',
    'SOUL.md': '',
    'TOOLS.md': '',
    'HEARTBEAT.md': '',
  });
  const [activeFile, setActiveFile] = useState<ManagedFileName>('AGENTS.md');
  const [filesResetting, setFilesResetting] = useState(false);
  const [heartbeatFileSaving, setHeartbeatFileSaving] = useState(false);
  const [heartbeatFileResetting, setHeartbeatFileResetting] = useState(false);
  const [heartbeatFileError, setHeartbeatFileError] = useState<string | null>(null);
  const [heartbeatFileSuccess, setHeartbeatFileSuccess] = useState<string | null>(null);

  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);
  const [heartbeatResetDialogOpen, setHeartbeatResetDialogOpen] = useState(false);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [createTitle, setCreateTitle] = useState('');
  const [sessionPendingId, setSessionPendingId] = useState<string | null>(null);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const sessionsRequestSeqRef = useRef(0);

  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [openToolRows, setOpenToolRows] = useState<Record<string, boolean>>({});
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsPiConfig, setToolsPiConfig] = useState<PiConfigData | null>(null);
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [activeToolGroups, setActiveToolGroups] = useState<Set<string>>(new Set());

  const [heartbeatConfig, setHeartbeatConfig] = useState<AgentHeartbeatConfig | null>(null);
  const [heartbeatScheduleDraft, setHeartbeatScheduleDraft] = useState<AgentHeartbeatScheduleDraft>(() => defaultHeartbeatScheduleDraft());
  const [heartbeatDeliveryDraft, setHeartbeatDeliveryDraft] = useState<AgentHeartbeatDeliveryDraft>(() => defaultHeartbeatDeliveryDraft());
  const [heartbeatDeliveryChannels, setHeartbeatDeliveryChannels] = useState<AgentHeartbeatDeliveryChannelOption[]>([]);
  const [heartbeatLoading, setHeartbeatLoading] = useState(true);
  const [heartbeatSaving, setHeartbeatSaving] = useState(false);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [heartbeatSuccess, setHeartbeatSuccess] = useState<string | null>(null);

  const resetAgentScopedState = useCallback(() => {
    sessionsRequestSeqRef.current += 1;
    setDoctorResult(null);
    setDoctorError(null);
    setFiles(null);
    setFilesError(null);
    setFilesSuccess(null);
    setHeartbeatFileError(null);
    setHeartbeatFileSuccess(null);
    setResetDialogOpen(false);
    setResetTarget(null);
    setHeartbeatResetDialogOpen(false);
    setSessions([]);
    setSessionsLoading(true);
    setSessionError(null);
    setCreateTitle('');
    setSessionPendingId(null);
    setRenameDrafts({});
    setToolsPiConfig(null);
    setOpenToolRows({});
    setActiveToolGroups(new Set());
    setHeartbeatConfig(null);
    setHeartbeatScheduleDraft(defaultHeartbeatScheduleDraft());
    setHeartbeatDeliveryDraft(defaultHeartbeatDeliveryDraft());
    setHeartbeatError(null);
    setHeartbeatSuccess(null);
  }, []);

  const selectAgent = useCallback((agentId: string) => {
    if (agentId === selectedAgentId) return;
    resetAgentScopedState();
    setSelectedAgentId(agentId);
  }, [resetAgentScopedState, selectedAgentId]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) || null,
    [agents, selectedAgentId],
  );
  const isMainAgent = selectedAgentId === DEFAULT_AGENT_ID || selectedAgent?.type === 'main';
  const modelOverrideEnabled = isMainAgent || Boolean(selectedAgent?.defaultProvider && selectedAgent.defaultModel);
  const toolsOverrideEnabled = isMainAgent || Array.isArray(selectedAgent?.enabledTools);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);

    try {
      const payload = await fetchJson<{ agents: AgentProfileItem[] }>('/api/agents');
      const nextAgents = payload.agents || [];
      setAgents(nextAgents);
      setSelectedAgentId((current) => {
        if (nextAgents.some((agent) => agent.agentId === current)) {
          return current;
        }
        return nextAgents.find((agent) => agent.agentId === DEFAULT_AGENT_ID)?.agentId
          || nextAgents[0]?.agentId
          || DEFAULT_AGENT_ID;
      });
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : t('agentPanel.selector.errors.load'));
    } finally {
      setAgentsLoading(false);
    }
  }, [t]);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);

    try {
      const payload = await fetchJson<{ files: Record<ManagedFileName, string> }>(`/api/agents/files?${buildAgentQuery(selectedAgentId)}`);
      setFiles(payload.files);
      setFileDrafts(payload.files);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : t('agentPanel.files.errors.load'));
    } finally {
      setFilesLoading(false);
    }
  }, [selectedAgentId, t]);

  const createAgent = async (input: CreateAgentInput): Promise<boolean> => {
    const name = input.name.trim();
    if (!name) return false;

    setAgentCreating(true);
    setAgentsError(null);

    try {
      const payload = await fetchJson<{ agent: AgentProfileItem }>('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          iconId: input.iconId,
          files: input.files,
          relevantSkills: input.relevantSkills,
        }),
      });
      await loadAgents();
      selectAgent(payload.agent.agentId);
      return true;
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : t('agentPanel.selector.errors.create'));
      return false;
    } finally {
      setAgentCreating(false);
    }
  };

  const deleteAgent = async (agentId: string) => {
    if (!window.confirm(t('agentPanel.selector.confirmDelete'))) {
      return;
    }

    setAgentDeletingId(agentId);
    setAgentsError(null);

    try {
      const params = new URLSearchParams({ agentId });
      const response = await fetch(`/api/agents?${params.toString()}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.selector.errors.delete'));
      }
      if (selectedAgentId === agentId) {
        resetAgentScopedState();
        setSelectedAgentId(DEFAULT_AGENT_ID);
      }
      await loadAgents();
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : t('agentPanel.selector.errors.delete'));
    } finally {
      setAgentDeletingId(null);
    }
  };

  const loadSessions = useCallback(async () => {
    const requestSeq = sessionsRequestSeqRef.current + 1;
    sessionsRequestSeqRef.current = requestSeq;
    const agentId = selectedAgentId;

    setSessionsLoading(true);
    setSessionError(null);

    try {
      const params = new URLSearchParams({ agentId });
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
      if (sessionsRequestSeqRef.current !== requestSeq) return;
      setSessions(nextSessions);
      setRenameDrafts(
        Object.fromEntries(nextSessions.map((item) => [item.sessionId, item.title || ''])) as Record<string, string>,
      );
    } catch (error) {
      if (sessionsRequestSeqRef.current !== requestSeq) return;
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.load'));
    } finally {
      if (sessionsRequestSeqRef.current === requestSeq) {
        setSessionsLoading(false);
      }
    }
  }, [selectedAgentId, t]);

  const loadTools = useCallback(async () => {
    setToolsLoading(true);
    setToolsError(null);

    try {
      const payload = await fetchJson<{ tools: ToolMetadata[] }>(`/api/agents/tools?${buildAgentQuery(selectedAgentId)}`);
      setAvailableTools(payload.tools);
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.loading'));
    } finally {
      setToolsLoading(false);
    }
  }, [selectedAgentId, t]);

  const loadToolsConfig = useCallback(async () => {
    try {
      const payload = await fetchJson<{ piConfig: PiConfigData }>(`/api/agents/config?${buildAgentQuery(selectedAgentId)}`);
      setToolsPiConfig(payload.piConfig);
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.saveError'));
    }
  }, [selectedAgentId, t]);

  const loadHeartbeatConfig = useCallback(async () => {
    setHeartbeatLoading(true);
    setHeartbeatError(null);

    try {
      const payload = await fetchJson<AgentHeartbeatConfig>(`/api/automations/heartbeat?${buildAgentQuery(selectedAgentId)}`);
      setHeartbeatConfig(payload);
      setHeartbeatScheduleDraft(scheduleToHeartbeatDraft(payload.schedule));
      setHeartbeatDeliveryDraft(configToHeartbeatDeliveryDraft(payload));
    } catch (error) {
      setHeartbeatError(error instanceof Error ? error.message : t('agentPanel.heartbeat.errors.load'));
    } finally {
      setHeartbeatLoading(false);
    }
  }, [selectedAgentId, t]);

  const loadHeartbeatDeliveryChannels = useCallback(async () => {
    try {
      const response = await fetch('/api/channels/status', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        channels?: unknown[];
      };
      if (response.ok && payload.success && Array.isArray(payload.channels)) {
        const channels = payload.channels
          .map(normalizeDeliveryChannel)
          .filter((channel): channel is AgentHeartbeatDeliveryChannelOption => Boolean(channel));
        setHeartbeatDeliveryChannels(channels);
        return;
      }
    } catch {
      /* ignore */
    }

    setHeartbeatDeliveryChannels([
      { id: 'web', label: 'Web Chat', connected: true, running: true },
    ]);
  }, []);

  const patchSelectedAgent = useCallback(async (payload: Record<string, unknown>) => {
    if (isMainAgent) return;
    await fetchJson<{ agent: AgentProfileItem }>('/api/agents', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: selectedAgentId,
        ...payload,
      }),
    });
    await loadAgents();
    await loadToolsConfig();
  }, [isMainAgent, loadAgents, loadToolsConfig, selectedAgentId]);

  const setAgentSectionOpen = useCallback((sectionId: AgentSettingsSectionId, isOpen: boolean) => {
    setAgentSectionOpenById((current) => {
      const nextState = {
        ...current,
        [sectionId]: isOpen,
      };
      window.localStorage.setItem(AGENT_SETTINGS_SECTION_OPEN_STORAGE_KEY, JSON.stringify(nextState));
      return nextState;
    });
  }, []);

  const runDoctor = useCallback(async () => {
    setAgentSectionOpen('doctor', true);
    setDoctorRunning(true);
    setDoctorError(null);

    try {
      const payload = await fetchJson<DoctorResult>('/api/agents/doctor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, livePing: true }),
      });
      setDoctorResult(payload);
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : t('agentPanel.doctor.errors.run'));
    } finally {
      setDoctorRunning(false);
    }
  }, [selectedAgentId, setAgentSectionOpen, t]);

  useEffect(() => {
    startTransition(() => {
      void loadAgents();
      void loadHeartbeatDeliveryChannels();
    });
  }, [loadAgents, loadHeartbeatDeliveryChannels]);

  useEffect(() => {
    startTransition(() => {
      void loadFiles();
      void loadSessions();
      void loadTools();
      void loadToolsConfig();
      void loadHeartbeatConfig();
    });
  }, [loadFiles, loadSessions, loadTools, loadToolsConfig, loadHeartbeatConfig]);

  useEffect(() => {
    if (SHOW_AGENT_DOCTOR_SECTION && searchParams.get('panel') === 'doctor' && !doctorResult && !doctorRunning) {
      startTransition(() => { void runDoctor(); });
    }
  }, [searchParams, doctorResult, doctorRunning, runDoctor]);

  const saveHeartbeatConfig = async () => {
    setHeartbeatSaving(true);
    setHeartbeatError(null);
    setHeartbeatSuccess(null);

    try {
      const deliveryChannelId = heartbeatDeliveryDraft.deliveryMode === 'web'
        ? 'web'
        : heartbeatDeliveryDraft.deliveryChannelId || 'web';
      const payload = await fetchJson<AgentHeartbeatConfig>('/api/automations/heartbeat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          enabled: heartbeatConfig?.enabled ?? false,
          schedule: heartbeatDraftToSchedule(heartbeatScheduleDraft),
          deliveryMode: deliveryChannelId === 'web' ? 'web' : heartbeatDeliveryDraft.deliveryMode,
          deliveryChannelId,
          deliverySessionMode: heartbeatDeliveryDraft.deliverySessionMode,
          deliverySessionId: heartbeatDeliveryDraft.deliverySessionId.trim() || null,
          deliveryChannelSessionKey: null,
        }),
      });

      setHeartbeatConfig(payload);
      setHeartbeatScheduleDraft(scheduleToHeartbeatDraft(payload.schedule));
      setHeartbeatDeliveryDraft(configToHeartbeatDeliveryDraft(payload));
      setHeartbeatSuccess(t('agentPanel.heartbeat.saved'));
      setTimeout(() => setHeartbeatSuccess(null), 3000);
    } catch (error) {
      setHeartbeatError(error instanceof Error ? error.message : t('agentPanel.heartbeat.errors.save'));
    } finally {
      setHeartbeatSaving(false);
    }
  };

  const applyManagedFileContent = (fileName: ManagedFileName, content: string) => {
    setFiles((current) => ({
      ...(current || fileDrafts),
      [fileName]: content,
    }));
    setFileDrafts((current) => ({
      ...current,
      [fileName]: content,
    }));
  };

  const requestResetManagedFile = async (fileName: ManagedFileName) => fetchJson<{ fileName: ManagedFileName; content: string }>('/api/agents/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: selectedAgentId,
      action: 'reset',
      fileName,
    }),
  });

  const saveManagedFile = async (
    fileName: ManagedFileName,
    options: {
      setSaving: (value: boolean) => void;
      setError: (value: string | null) => void;
      setSuccess: (value: string | null) => void;
      successMessage: (savedFileName: ManagedFileName) => string;
      errorMessage: string;
    },
  ) => {
    options.setSaving(true);
    options.setError(null);
    options.setSuccess(null);

    try {
      const content = fileDrafts[fileName] ?? '';
      const payload = await fetchJson<{ fileName: ManagedFileName; content: string }>('/api/agents/files', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          fileName,
          content,
        }),
      });

      applyManagedFileContent(payload.fileName, payload.content);
      options.setSuccess(options.successMessage(payload.fileName));
    } catch (error) {
      options.setError(error instanceof Error ? error.message : options.errorMessage);
    } finally {
      options.setSaving(false);
    }
  };

  const saveActiveFile = async () => {
    await saveManagedFile(activeFile, {
      setSaving: setFilesSaving,
      setError: setFilesError,
      setSuccess: setFilesSuccess,
      successMessage: (fileName) => t('agentPanel.files.saved', { fileName }),
      errorMessage: t('agentPanel.files.errors.save'),
    });
  };

  const saveHeartbeatFile = async () => {
    await saveManagedFile('HEARTBEAT.md', {
      setSaving: setHeartbeatFileSaving,
      setError: setHeartbeatFileError,
      setSuccess: setHeartbeatFileSuccess,
      successMessage: () => t('agentPanel.heartbeat.fileSaved'),
      errorMessage: t('agentPanel.heartbeat.errors.fileSave'),
    });
  };

  const resetFile = async () => {
    if (!resetTarget) return;

    setFilesResetting(true);
    setFilesError(null);
    setFilesSuccess(null);

    try {
      if (resetTarget === 'current') {
        const payload = await requestResetManagedFile(activeFile);
        applyManagedFileContent(payload.fileName, payload.content);
        setFilesSuccess(t('agentPanel.files.resetSuccess', { fileName: payload.fileName }));
      } else {
        const payload = await Promise.all(getVisibleManagedFileNames(isMainAgent).map((fileName) => requestResetManagedFile(fileName)));

        const newFiles: Record<ManagedFileName, string> = { ...fileDrafts };
        for (const { fileName, content } of payload) {
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

  const resetHeartbeatFile = async () => {
    setHeartbeatFileResetting(true);
    setHeartbeatFileError(null);
    setHeartbeatFileSuccess(null);

    try {
      const payload = await requestResetManagedFile('HEARTBEAT.md');
      applyManagedFileContent(payload.fileName, payload.content);
      setHeartbeatFileSuccess(t('agentPanel.heartbeat.fileResetSuccess'));
    } catch (error) {
      setHeartbeatFileError(error instanceof Error ? error.message : t('agentPanel.heartbeat.errors.fileReset'));
    } finally {
      setHeartbeatFileResetting(false);
      setHeartbeatResetDialogOpen(false);
    }
  };

  const createSession = async () => {
    setSessionPendingId('create');
    setSessionError(null);

    try {
      await fetchJson<{ session: SessionItem }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, title: createTitle.trim() || undefined }),
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
          agentId: selectedAgentId,
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
      const params = new URLSearchParams({ agentId: selectedAgentId, sessionId });
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
      const params = new URLSearchParams({ agentId: selectedAgentId, all: 'true' });
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
      if (!isMainAgent) {
        await patchSelectedAgent({ enabledTools: newEnabledTools });
        return;
      }

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
        body: JSON.stringify({ agentId: selectedAgentId, piConfig: nextConfig }),
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
    const newEnabledTools = enabled
      ? enableToolInConfig(toolName, currentEnabled, allNames)
      : disableToolInConfig(toolName, currentEnabled, allNames);

    void saveToolsConfig(newEnabledTools);
  };

  const handleEnableAll = () => {
    const allNames = availableTools.map((t) => t.name);
    void saveToolsConfig(serializeEnabledToolNames(allNames, allNames));
  };

  const handleDisableAll = () => {
    void saveToolsConfig(['__none__']);
  };

  const setModelOverrideEnabled = async (enabled: boolean) => {
    if (isMainAgent) return;
    setToolsSaving(true);
    setToolsError(null);
    try {
      if (!enabled) {
        await patchSelectedAgent({ defaultProvider: null, defaultModel: null, defaultThinking: null });
        return;
      }

      const providerId = toolsPiConfig?.activeProvider;
      const providerConfig = providerId ? toolsPiConfig?.providers[providerId] : null;
      await patchSelectedAgent({
        defaultProvider: providerId || null,
        defaultModel: providerConfig?.model || null,
        defaultThinking: providerConfig?.thinking || 'off',
      });
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.inheritance.errors.save'));
    } finally {
      setToolsSaving(false);
    }
  };

  const setToolsOverrideEnabled = async (enabled: boolean) => {
    if (isMainAgent) return;
    setToolsSaving(true);
    setToolsError(null);
    try {
      await patchSelectedAgent({ enabledTools: enabled ? getActiveEnabledTools() : null });
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.inheritance.errors.save'));
    } finally {
      setToolsSaving(false);
    }
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
        agentId: selectedAgentId,
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
        agentId: selectedAgentId,
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

  const activeProviderId = toolsPiConfig?.activeProvider || selectedAgent?.defaultProvider || 'default';
  const activeProviderConfig = toolsPiConfig?.providers?.[activeProviderId];
  const inheritedModelSummary = `${activeProviderId} / ${activeProviderConfig?.model || selectedAgent?.defaultModel || t('agentPanel.selector.notSet')}`;
  const effectiveEnabledToolCount = availableTools.filter((tool) => isToolEnabled(tool.name)).length;

  return (
    <div className="space-y-4">
      <AgentSelectorCard
        agents={agents}
        selectedAgentId={selectedAgentId}
        loading={agentsLoading}
        error={agentsError}
        creating={agentCreating}
        deletingAgentId={agentDeletingId}
        onSelectedAgentIdChange={selectAgent}
        onCreate={createAgent}
        onDelete={(agentId) => void deleteAgent(agentId)}
        onReload={() => void loadAgents()}
      />

      {!isMainAgent && (
        <Card>
          <CardHeader>
            <CardTitle>{t('agentPanel.inheritance.title')}</CardTitle>
            <CardDescription>{t('agentPanel.inheritance.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('agentPanel.inheritance.modelOverride')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {modelOverrideEnabled
                    ? t('agentPanel.inheritance.customModel', { summary: inheritedModelSummary })
                    : t('agentPanel.inheritance.inheritedModel', { summary: inheritedModelSummary })}
                </p>
              </div>
              <Switch
                checked={modelOverrideEnabled}
                onCheckedChange={(checked) => void setModelOverrideEnabled(checked)}
                disabled={toolsSaving || !toolsPiConfig}
                aria-label={t('agentPanel.inheritance.modelOverride')}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('agentPanel.inheritance.toolsOverride')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {toolsOverrideEnabled
                    ? t('agentPanel.inheritance.customTools', { count: effectiveEnabledToolCount })
                    : t('agentPanel.inheritance.inheritedTools', { count: effectiveEnabledToolCount })}
                </p>
              </div>
              <Switch
                checked={toolsOverrideEnabled}
                onCheckedChange={(checked) => void setToolsOverrideEnabled(checked)}
                disabled={toolsSaving || toolsLoading}
                aria-label={t('agentPanel.inheritance.toolsOverride')}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {(isMainAgent || modelOverrideEnabled) && (
        <div id="onboarding-settings-agentSettings">
          <PiProviderSetupCard
            agentId={selectedAgentId}
            mode={isMainAgent ? 'main' : 'override'}
            isOpen={agentSectionOpenById.runtime}
            onOpenChange={(isOpen) => setAgentSectionOpen('runtime', isOpen)}
            title={isMainAgent ? undefined : t('agentPanel.inheritance.modelCardTitle')}
            description={isMainAgent ? undefined : t('agentPanel.inheritance.modelCardDescription')}
            saveSuccessMessage={isMainAgent ? undefined : t('agentPanel.inheritance.overrideSaved')}
            onSaved={async () => {
              await loadAgents();
              await loadToolsConfig();
            }}
          />
        </div>
      )}

      <AgentChatDisplayCard
        toolVerbosity={toolVerbosity}
        isOpen={agentSectionOpenById.chatDisplay}
        onOpenChange={(isOpen) => setAgentSectionOpen('chatDisplay', isOpen)}
        onToolVerbosityChange={setToolVerbosity}
      />

      {(isMainAgent || toolsOverrideEnabled) && (
        <AgentToolsCard
          availableTools={availableTools}
          filteredTools={filteredTools}
          toolGroups={toolGroups}
          activeToolGroups={activeToolGroups}
          openToolRows={openToolRows}
          toolsLoading={toolsLoading}
          toolsSaving={toolsSaving}
          toolsError={toolsError}
          isOpen={agentSectionOpenById.tools}
          onOpenChange={(isOpen) => setAgentSectionOpen('tools', isOpen)}
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
      )}

      <AgentHeartbeatCard
        config={heartbeatConfig}
        scheduleDraft={heartbeatScheduleDraft}
        deliveryDraft={heartbeatDeliveryDraft}
        deliveryChannels={heartbeatDeliveryChannels}
        isOpen={agentSectionOpenById.heartbeat}
        loading={heartbeatLoading}
        saving={heartbeatSaving}
        error={heartbeatError}
        success={heartbeatSuccess}
        heartbeatFileDraft={fileDrafts['HEARTBEAT.md'] ?? ''}
        heartbeatFileLoading={filesLoading}
        heartbeatFileSaving={heartbeatFileSaving}
        heartbeatFileResetting={heartbeatFileResetting}
        heartbeatFileError={heartbeatFileError || filesError}
        heartbeatFileSuccess={heartbeatFileSuccess}
        heartbeatResetDialogOpen={heartbeatResetDialogOpen}
        onOpenChange={(isOpen) => setAgentSectionOpen('heartbeat', isOpen)}
        onEnabledChange={(enabled) => setHeartbeatConfig((current) => current ? { ...current, enabled } : current)}
        onScheduleDraftChange={(patch) => setHeartbeatScheduleDraft((current) => ({ ...current, ...patch }))}
        onDeliveryDraftChange={(patch) => setHeartbeatDeliveryDraft((current) => ({ ...current, ...patch }))}
        onSave={() => void saveHeartbeatConfig()}
        onReload={() => void Promise.all([loadHeartbeatConfig(), loadHeartbeatDeliveryChannels()])}
        onHeartbeatFileDraftChange={(value) =>
          setFileDrafts((current) => ({
            ...current,
            'HEARTBEAT.md': value,
          }))
        }
        onSaveHeartbeatFile={() => void saveHeartbeatFile()}
        onReloadHeartbeatFile={() => {
          setHeartbeatFileError(null);
          setHeartbeatFileSuccess(null);
          void loadFiles();
        }}
        onOpenHeartbeatResetDialog={() => setHeartbeatResetDialogOpen(true)}
        onHeartbeatResetDialogOpenChange={setHeartbeatResetDialogOpen}
        onClearHeartbeatResetDialog={() => setHeartbeatResetDialogOpen(false)}
        onResetHeartbeatFile={() => void resetHeartbeatFile()}
      />

      <AgentManagedFilesCard
        isMainAgent={isMainAgent}
        files={files}
        fileDrafts={fileDrafts}
        activeFile={activeFile}
        filesLoading={filesLoading}
        filesSaving={filesSaving}
        filesResetting={filesResetting}
        filesError={filesError}
        filesSuccess={filesSuccess}
        isOpen={agentSectionOpenById.files}
        onOpenChange={(isOpen) => setAgentSectionOpen('files', isOpen)}
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
        activeAgentId={selectedAgentId}
        activeAgentName={selectedAgent?.name || selectedAgentId}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        sessionError={sessionError}
        isOpen={agentSectionOpenById.sessions}
        onOpenChange={(isOpen) => setAgentSectionOpen('sessions', isOpen)}
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

      {SHOW_AGENT_DOCTOR_SECTION && (
        <AgentDoctorCard
          doctorResult={doctorResult}
          doctorRunning={doctorRunning}
          doctorError={doctorError}
          isOpen={agentSectionOpenById.doctor}
          onOpenChange={(isOpen) => setAgentSectionOpen('doctor', isOpen)}
          onRunDoctor={() => void runDoctor()}
        />
      )}
    </div>
  );
}
