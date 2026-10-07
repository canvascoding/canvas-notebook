'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, startTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { AgentCatalogModelOverrideCard } from './AgentCatalogModelOverrideEditor';
import {
  resolveEnabledToolNames,
  isDefaultToolsConfig,
  getDefaultEnabledToolNames,
  enableToolInConfig,
  disableToolInConfig,
} from '@/app/lib/pi/enabled-tools';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { AgentSessionsCard, type AgentSessionItem } from './AgentSessionsCard';
import { AgentDoctorCard, type DoctorResult } from './AgentDoctorCard';
import { AgentManagedFilesCard, type ManagedFileName, type ResetTarget } from './AgentManagedFilesCard';
import { AgentToolsCard, type ToolMetadata } from './AgentToolsCard';
import { AgentConnectionsPicker, AgentRelevantSkillsPicker } from './AgentCapabilityPickers';
import { AgentGrantsEditor } from '@/app/components/agents/AgentGrantsEditor';
import { AgentWorkflowChoiceDialog } from '@/app/components/agents/AgentWorkflowChoiceDialog';
import { AgentWorkflowManagementDialog } from '@/app/components/agents/AgentWorkflowManagementDialog';
import { saveAgentWorkflowManagement, type AgentWorkflowManagementContext,
  type AgentWorkflowManagementSaveInput } from '@/app/components/agents/agent-workflow-management-client';
import { AgentWorkflowClientError } from '@/app/components/agents/agent-workflow-client';
import { Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentSelectorCard, type AgentProfileItem } from './AgentSelectorCard';
import { AgentSettingsAccordionCard } from './AgentSettingsAccordionCard';
import { AgentRuntimePreferenceCard } from './AgentRuntimePreferenceCard';
import { MemoryReviewAgentCard } from './MemoryReviewAgentCard';
import type { CreateAgentInput } from './CreateAgentDialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

function buildAgentQuery(agentId: string): string {
  return new URLSearchParams({ agentId }).toString();
}

type SessionItem = AgentSessionItem;
type WorkflowAgentProfileItem = AgentProfileItem & { workflowVersion?: number | null; workflowRevision?: number };

type AgentToolsConfigData = {
  agentId: string;
  enabledTools: string[];
};

type AgentToolsMutationTicket = {
  agentId: string;
  selectionEpoch: number;
  expectedRevision: number | undefined;
};

type AgentToolsSaveToken = AgentToolsMutationTicket & {
  settled: Promise<void>;
  settle: () => void;
};

type AgentSettingsSectionId = 'runtime' | 'tools' | 'connections' | 'skills' | 'files' | 'sessions' | 'doctor';
type AgentSettingsSectionOpenState = Record<AgentSettingsSectionId, boolean>;

const AGENT_SETTINGS_SECTION_OPEN_STORAGE_KEY = 'canvas-settings-agent-section-open-state';
const SHOW_AGENT_DOCTOR_SECTION = false;
const DEFAULT_AGENT_SETTINGS_SECTION_OPEN_STATE: AgentSettingsSectionOpenState = {
  runtime: false,
  tools: false,
  connections: false,
  skills: false,
  files: false,
  sessions: false,
  doctor: false,
};

function getFallbackAgentSectionOpenState(requestedPanel: string | null): AgentSettingsSectionOpenState {
  return {
    ...DEFAULT_AGENT_SETTINGS_SECTION_OPEN_STATE,
    runtime: requestedPanel === 'runtime',
    doctor: SHOW_AGENT_DOCTOR_SECTION && requestedPanel === 'doctor',
  };
}

function getInitialAgentSectionOpenState(requestedPanel: string | null): AgentSettingsSectionOpenState {
  const fallback = getFallbackAgentSectionOpenState(requestedPanel);

  if (typeof window === 'undefined') return fallback;

  try {
    const storedState = JSON.parse(window.localStorage.getItem(AGENT_SETTINGS_SECTION_OPEN_STORAGE_KEY) || '{}') as Partial<AgentSettingsSectionOpenState>;
    return {
      runtime: typeof storedState.runtime === 'boolean' ? storedState.runtime : fallback.runtime,
      tools: typeof storedState.tools === 'boolean' ? storedState.tools : fallback.tools,
      connections: typeof storedState.connections === 'boolean' ? storedState.connections : fallback.connections,
      skills: typeof storedState.skills === 'boolean' ? storedState.skills : fallback.skills,
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

/* Retired legacy heartbeat settings. Migration is handled by workspace automations.
function defaultHeartbeatScheduleDraft(): AgentHeartbeatScheduleDraft {
  const timeZone = DEFAULT_USER_TIME_ZONE;
  return {
    kind: 'interval',
    timeZone,
    dailyTime: '09:00',
    weeklyTime: '09:00',
    weeklyDays: ['mon'],
    intervalEvery: '60',
    intervalUnit: 'minutes',
    workingHoursEnabled: true,
    workingHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    workingHoursStart: '09:00',
    workingHoursEnd: '18:00',
    workingHoursTimeZone: timeZone,
  };
}

function scheduleToHeartbeatDraft(schedule: FriendlySchedule | null): AgentHeartbeatScheduleDraft {
  const draft = defaultHeartbeatScheduleDraft();
  if (!schedule) return draft;
  const workingHours = schedule.workingHours;
  const workingHoursDraft = workingHours
    ? {
        workingHoursEnabled: workingHours.enabled,
        workingHoursDays: workingHours.days.length > 0 ? workingHours.days : draft.workingHoursDays,
        workingHoursStart: workingHours.start || draft.workingHoursStart,
        workingHoursEnd: workingHours.end || draft.workingHoursEnd,
        workingHoursTimeZone: workingHours.timeZone || schedule.timeZone || draft.workingHoursTimeZone,
      }
    : {};

  if (schedule.kind === 'daily') {
    return {
      ...draft,
      ...workingHoursDraft,
      kind: 'daily',
      timeZone: schedule.timeZone,
      dailyTime: schedule.times[0] || draft.dailyTime,
    };
  }

  if (schedule.kind === 'weekly') {
    return {
      ...draft,
      ...workingHoursDraft,
      kind: 'weekly',
      timeZone: schedule.timeZone,
      weeklyTime: schedule.times[0] || draft.weeklyTime,
      weeklyDays: schedule.days.length > 0 ? schedule.days : draft.weeklyDays,
    };
  }

  if (schedule.kind === 'interval') {
    return {
      ...draft,
      ...workingHoursDraft,
      kind: 'interval',
      timeZone: schedule.timeZone,
      intervalEvery: String(schedule.every || 1),
      intervalUnit: schedule.unit,
    };
  }

  return draft;
}

function heartbeatDraftToSchedule(draft: AgentHeartbeatScheduleDraft): FriendlySchedule {
  const defaultWorkingDays: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const workingHours: AutomationWorkingHours = {
    enabled: draft.workingHoursEnabled,
    days: draft.workingHoursDays.length > 0 ? draft.workingHoursDays : defaultWorkingDays,
    start: draft.workingHoursStart || '09:00',
    end: draft.workingHoursEnd || '18:00',
    timeZone: draft.workingHoursTimeZone || draft.timeZone,
  };

  if (draft.kind === 'weekly') {
    return {
      kind: 'weekly',
      days: draft.weeklyDays.length > 0 ? draft.weeklyDays : ['mon'],
      times: draft.weeklyTime ? [draft.weeklyTime] : ['09:00'],
      timeZone: draft.timeZone,
      workingHours,
    };
  }

  if (draft.kind === 'interval') {
    const every = Number(draft.intervalEvery || '1');
    return {
      kind: 'interval',
      every: Number.isFinite(every) && every > 0 ? Math.floor(every) : 1,
      unit: draft.intervalUnit,
      timeZone: draft.timeZone,
      workingHours,
    };
  }

  return {
    kind: 'daily',
    times: draft.dailyTime ? [draft.dailyTime] : ['09:00'],
    timeZone: draft.timeZone,
    workingHours,
  };
}

function defaultHeartbeatDeliveryDraft(): AgentHeartbeatDeliveryDraft {
  return {
    deliveryMode: 'last_active',
    deliveryChannelId: 'last_active',
    deliverySessionMode: 'channel_active',
    deliverySessionId: '',
  };
}

function configToHeartbeatDeliveryDraft(config: AgentHeartbeatConfig | null): AgentHeartbeatDeliveryDraft {
  if (!config) return defaultHeartbeatDeliveryDraft();
  const deliveryMode = config.deliveryMode || 'web';
  return {
    deliveryMode,
    deliveryChannelId: deliveryMode === 'last_active' ? 'last_active' : config.deliveryChannelId || (deliveryMode === 'web' ? 'web' : ''),
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

function normalizeDeliveryChannels(channels: unknown[], telegramStatus: Record<string, unknown> | null): AgentHeartbeatDeliveryChannelOption[] {
  const telegramReady = Boolean(
    telegramStatus?.configured &&
    telegramStatus.enabled &&
    telegramStatus.linked,
  );

  return channels
    .map(normalizeDeliveryChannel)
    .filter((channel): channel is AgentHeartbeatDeliveryChannelOption => Boolean(channel))
    .map((channel) => {
      if (channel.id !== 'telegram' || !telegramStatus) return channel;
      return {
        ...channel,
        connected: channel.connected && telegramReady,
      };
    });
}
*/

export function AgentSettingsPanel({
  canManageAgentDefaults = false,
  currentUserId = '',
}: {
  canManageAgentDefaults?: boolean;
  currentUserId?: string;
}) {
  const t = useTranslations('settings');
  const tWorkflow = useTranslations('agentWorkflow');
  const tWorkflowManagement = useTranslations('agentWorkflowManagement');
  const searchParams = useSearchParams();
  const requestedPanel = searchParams.get('panel')
    ?? (searchParams.get('tab') === 'my-agent-runtime' ? 'runtime' : null);
  const shouldOpenCreateAgentDialog = searchParams.get('createAgent') === '1';
  const [agentSectionOpenById, setAgentSectionOpenById] = useState<AgentSettingsSectionOpenState>(() => getFallbackAgentSectionOpenState(requestedPanel));

  const [agents, setAgents] = useState<WorkflowAgentProfileItem[]>([]);
  const agentsRequestSeqRef = useRef(0);
  const [workflowDialogOpen, setWorkflowDialogOpen] = useState(false);
  const workflowTriggerRef = useRef<HTMLButtonElement>(null);
  const [workflowManagementOpen, setWorkflowManagementOpen] = useState(false);
  const [workflowManagementSelectionEpoch, setWorkflowManagementSelectionEpoch] = useState(0);
  const [workflowManagementSaving, setWorkflowManagementSaving] = useState(false);
  const workflowManagementTriggerRef = useRef<HTMLButtonElement>(null);
  const workflowSaveTokenRef = useRef<(AgentToolsSaveToken & { contextKey: string }) | null>(null);
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
  const sessionsRequestSeqRef = useRef(0);

  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [openToolRows, setOpenToolRows] = useState<Record<string, boolean>>({});
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsConfig, setToolsConfig] = useState<AgentToolsConfigData | null>(null);
  const selectedAgentIdRef = useRef(DEFAULT_AGENT_ID);
  const toolsSelectionEpochRef = useRef(0);
  const toolsRequestSeqRef = useRef(0);
  const toolsSnapshotRef = useRef<{ selectionEpoch: number; config: AgentToolsConfigData } | null>(null);
  const toolsSaveTokenRef = useRef<AgentToolsSaveToken | null>(null);
  const toolsMountedRef = useRef(true);
  const workspaceId = searchParams.get('workspaceId');
  const organizationId = searchParams.get('organizationId');
  const projectId = searchParams.get('projectId');
  const workflowContextKey = JSON.stringify([currentUserId, workspaceId, organizationId, projectId]);
  const workflowContextKeyRef = useRef(workflowContextKey);
  const workflowManagementContext = useMemo<AgentWorkflowManagementContext>(() => ({ agentId: selectedAgentId,
    workspaceId, organizationId, projectId, actorId: currentUserId || null }),
  [currentUserId, organizationId, projectId, selectedAgentId, workspaceId]);
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [activeToolGroups, setActiveToolGroups] = useState<Set<string>>(new Set());
  const [capabilitiesSaving, setCapabilitiesSaving] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [relevantSkillsDraft, setRelevantSkillsDraft] = useState<string[]>([]);
  const [relevantConnectionsDraft, setRelevantConnectionsDraft] = useState<string[]>([]);
  const [modelOverrideEnabled, setModelOverrideEnabled] = useState(false);
  const [modelOverrideSaving, setModelOverrideSaving] = useState(false);
  const [modelOverrideError, setModelOverrideError] = useState<string | null>(null);

  const isCurrentToolsSelection = useCallback((agentId: string, selectionEpoch: number) => (
    toolsMountedRef.current && selectedAgentIdRef.current === agentId && toolsSelectionEpochRef.current === selectionEpoch
  ), []);

  useEffect(() => {
    toolsMountedRef.current = true;
    return () => {
      toolsMountedRef.current = false;
      toolsSelectionEpochRef.current += 1;
      toolsRequestSeqRef.current += 1;
      toolsSnapshotRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setAgentSectionOpenById(getInitialAgentSectionOpenState(requestedPanel));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [requestedPanel]);

  const resetAgentScopedState = useCallback(() => {
    setWorkflowDialogOpen(false);
    setWorkflowManagementOpen(false);
    sessionsRequestSeqRef.current += 1;
    toolsSelectionEpochRef.current += 1;
    setWorkflowManagementSelectionEpoch(toolsSelectionEpochRef.current);
    toolsRequestSeqRef.current += 1;
    toolsSnapshotRef.current = null;
    setDoctorResult(null);
    setDoctorError(null);
    setFiles(null);
    setFilesError(null);
    setFilesSuccess(null);
    setResetDialogOpen(false);
    setResetTarget(null);
    setSessions([]);
    setSessionsLoading(true);
    setSessionError(null);
    setCreateTitle('');
    setSessionPendingId(null);
    setRenameDrafts({});
    setAvailableTools([]);
    setToolsConfig(null);
    setToolsLoading(true);
    setToolsError(null);
    setOpenToolRows({});
    setActiveToolGroups(new Set());
    setCapabilitiesError(null);
    setModelOverrideEnabled(false);
    setModelOverrideError(null);
  }, []);

  useLayoutEffect(() => {
    if (workflowContextKeyRef.current === workflowContextKey) return;
    workflowContextKeyRef.current = workflowContextKey;
    agentsRequestSeqRef.current += 1;
    resetAgentScopedState();
  }, [resetAgentScopedState, workflowContextKey]);

  const waitForPendingWorkflowSave = useCallback(async (agentId: string) => {
    while (true) {
      const tickets = [toolsSaveTokenRef.current, workflowSaveTokenRef.current].filter(ticket => ticket?.agentId === agentId);
      if (!tickets.length) return;
      await Promise.all(tickets.map(ticket => ticket!.settled));
    }
  }, []);

  const selectAgent = useCallback((agentId: string) => {
    if (agentId === selectedAgentIdRef.current) return;
    selectedAgentIdRef.current = agentId;
    resetAgentScopedState();
    setSelectedAgentId(agentId);
    if (agentId !== DEFAULT_AGENT_ID) {
      setAgentSectionOpenById((current) => {
        const nextState = { ...current, runtime: true };
        window.localStorage.setItem(AGENT_SETTINGS_SECTION_OPEN_STORAGE_KEY, JSON.stringify(nextState));
        return nextState;
      });
    }
  }, [resetAgentScopedState]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) || null,
    [agents, selectedAgentId],
  );
  const mergeAgent = useCallback((agent: AgentProfileItem) => {
    if (!toolsMountedRef.current || workflowContextKeyRef.current !== workflowContextKey) return;
    agentsRequestSeqRef.current += 1;
    setAgentsLoading(false);
    setAgents((current) => current.map((entry) => entry.agentId === agent.agentId && entry.revision <= agent.revision
      ? { ...entry, ...agent } : entry));
  }, [workflowContextKey]);
  const isMainAgent = selectedAgentId === DEFAULT_AGENT_ID || selectedAgent?.type === 'main';
  const hasWorkflowConfiguration = selectedAgent?.workflowVersion != null;
  const isWorkflowUseOnly = selectedAgent?.workflowVersion === 1 && selectedAgent.access?.canEdit === false;
  const toolsOverrideEnabled = isMainAgent || Array.isArray(selectedAgent?.enabledTools);
  const skillsOverrideEnabled = !isMainAgent && Array.isArray(selectedAgent?.relevantSkills);
  const connectionsOverrideEnabled = !isMainAgent && Array.isArray(selectedAgent?.relevantConnections);
  const hasStoredModelOverride = !isMainAgent && Boolean(
    selectedAgent?.defaultProviderInstallationId
    || selectedAgent?.defaultProvider
    || selectedAgent?.defaultModel
    || selectedAgent?.defaultThinking,
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setRelevantSkillsDraft(Array.isArray(selectedAgent?.relevantSkills) ? selectedAgent.relevantSkills : []);
      setRelevantConnectionsDraft(Array.isArray(selectedAgent?.relevantConnections) ? selectedAgent.relevantConnections : []);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedAgent?.agentId, selectedAgent?.relevantConnections, selectedAgent?.relevantSkills]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setModelOverrideEnabled(hasStoredModelOverride);
    });
    return () => {
      cancelled = true;
    };
  }, [hasStoredModelOverride, selectedAgent?.agentId]);

  const loadAgents = useCallback(async () => {
    const contextKey = workflowContextKey, requestSeq = ++agentsRequestSeqRef.current;
    const isCurrentRequest = () => toolsMountedRef.current && workflowContextKeyRef.current === contextKey
      && agentsRequestSeqRef.current === requestSeq;
    setAgentsLoading(true);
    setAgentsError(null);

    try {
      const query = new URLSearchParams({ purpose: 'configure' });
      for (const [name, value] of [['workspaceId', workspaceId], ['organizationId', organizationId], ['projectId', projectId]] as const) {
        if (value) query.set(name, value);
      }
      const payload = await fetchJson<{ agents: WorkflowAgentProfileItem[] }>(`/api/agents?${query}`);
      if (!isCurrentRequest()) return;
      const nextAgents = (payload.agents || []).filter((agent) => agent.access?.canEdit !== false || agent.workflowVersion === 1 && agent.access.canUse);
      setAgents(nextAgents);
      if (!nextAgents.some((agent) => agent.agentId === selectedAgentIdRef.current)) {
        const nextAgentId = nextAgents.find((agent) => agent.agentId === DEFAULT_AGENT_ID)?.agentId
          || nextAgents[0]?.agentId
          || DEFAULT_AGENT_ID;
        selectAgent(nextAgentId);
      }
    } catch (error) {
      if (isCurrentRequest()) setAgentsError(error instanceof Error ? error.message : t('agentPanel.selector.errors.load'));
    } finally {
      if (isCurrentRequest()) setAgentsLoading(false);
    }
  }, [organizationId, projectId, selectAgent, t, workflowContextKey, workspaceId]);

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

  const createAgent = async (input: CreateAgentInput): Promise<AgentProfileItem | null> => {
    const name = input.name.trim();
    if (!name) return null;

    setAgentCreating(true);
    setAgentsError(null);

    try {
      const payload = await fetchJson<{ agent: AgentProfileItem }>('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          iconId: input.iconId,
          scopeType: input.scopeType,
          defaultProviderInstallationId: input.defaultProviderInstallationId,
          defaultProvider: input.defaultProvider,
          defaultModel: input.defaultModel,
          defaultThinking: input.defaultThinking,
          expectedCatalogRevision: input.expectedCatalogRevision,
          files: input.files,
          enabledTools: input.enabledTools,
          relevantSkills: input.relevantSkills,
          relevantConnections: input.relevantConnections,
          capabilities: input.capabilities,
        }),
      });
      await loadAgents();
      selectAgent(payload.agent.agentId);
      return payload.agent;
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : t('agentPanel.selector.errors.create'));
      return null;
    } finally {
      setAgentCreating(false);
    }
  };

  const deleteAgent = async (agentId: string) => {
    setAgentDeletingId(agentId);
    setAgentsError(null);

    try {
      const preview = await fetchJson<{
        agent: AgentProfileItem;
        impacts: { sessions: number; members: number; grants: number; capabilityBindings: number; managedFiles: string[]; memoryCollections: number; memoryEntries: number; memoryPolicy: 'retained' };
        confirmationToken: string;
      }>('/api/agents/delete-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      const confirmed = window.confirm(t('agentPanel.selector.confirmDeleteImpact', {
        sessions: preview.impacts.sessions,
        grants: preview.impacts.grants + preview.impacts.members,
        capabilities: preview.impacts.capabilityBindings,
        files: preview.impacts.managedFiles.length,
        memoryEntries: preview.impacts.memoryEntries,
      }));
      if (!confirmed) return;
      const response = await fetch('/api/agents', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          expectedRevision: preview.agent.revision,
          confirmationToken: preview.confirmationToken,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.selector.errors.delete'));
      }
      if (selectedAgentIdRef.current === agentId) selectAgent(DEFAULT_AGENT_ID);
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
    const agentId = selectedAgentId;
    const contextKey = workflowContextKey;
    const selectionEpoch = toolsSelectionEpochRef.current;
    if (!isCurrentToolsSelection(agentId, selectionEpoch)) return;
    const requestSeq = ++toolsRequestSeqRef.current;
    const isCurrentRequest = () => isCurrentToolsSelection(agentId, selectionEpoch) && toolsRequestSeqRef.current === requestSeq
      && workflowContextKeyRef.current === contextKey;
    toolsSnapshotRef.current = null;
    setToolsLoading(true);
    setToolsError(null);

    try {
      await waitForPendingWorkflowSave(agentId);
      if (!isCurrentRequest()) return;
      const payload = await fetchJson<{ tools: ToolMetadata[]; config: AgentToolsConfigData }>(`/api/agents/tools?${buildAgentQuery(agentId)}`);
      if (!isCurrentRequest()) return;
      if (!Array.isArray(payload.tools) || payload.config?.agentId !== agentId || !Array.isArray(payload.config.enabledTools)
        || payload.config.enabledTools.some(name => typeof name !== 'string')) throw new Error(t('agentPanel.tools.saveError'));
      toolsSnapshotRef.current = { selectionEpoch, config: payload.config };
      setAvailableTools(payload.tools);
      setToolsConfig(payload.config);
    } catch (error) {
      if (!isCurrentRequest()) return;
      toolsSnapshotRef.current = null;
      setAvailableTools([]);
      setToolsConfig(null);
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.loading'));
    } finally {
      if (isCurrentRequest()) setToolsLoading(false);
    }
  }, [isCurrentToolsSelection, selectedAgentId, t, waitForPendingWorkflowSave, workflowContextKey]);

  const loadToolsConfig = useCallback(async () => {
    await loadTools();
  }, [loadTools]);

  const commitWorkflowManagement = useCallback(async (input: AgentWorkflowManagementSaveInput,
    captured: { context: AgentWorkflowManagementContext; selectionEpoch: number }) => {
    const capturedContextKey = JSON.stringify([captured.context.actorId ?? '', captured.context.workspaceId,
      captured.context.organizationId ?? null, captured.context.projectId ?? null]);
    if (input.agentId !== captured.context.agentId || !isCurrentToolsSelection(input.agentId, captured.selectionEpoch)
      || capturedContextKey !== workflowContextKeyRef.current || toolsSaveTokenRef.current || workflowSaveTokenRef.current) {
      throw new AgentWorkflowClientError(409, 'AGENT_WORKFLOW_REVISION_CONFLICT');
    }
    let settle!: () => void;
    const ticket = { agentId: input.agentId, selectionEpoch: captured.selectionEpoch, expectedRevision: input.expectedRevision,
      contextKey: capturedContextKey, settled: new Promise<void>(resolve => { settle = resolve; }), settle: () => settle() };
    workflowSaveTokenRef.current = ticket;
    setWorkflowManagementSaving(true);
    try {
      const result = await saveAgentWorkflowManagement(captured.context, input);
      if (toolsMountedRef.current && workflowContextKeyRef.current === ticket.contextKey) {
        mergeAgent(result.agent);
      }
      return result;
    } finally {
      if (workflowSaveTokenRef.current === ticket) {
        workflowSaveTokenRef.current = null;
        if (toolsMountedRef.current) setWorkflowManagementSaving(false);
      }
      ticket.settle();
      if (isCurrentToolsSelection(ticket.agentId, ticket.selectionEpoch) && workflowContextKeyRef.current === ticket.contextKey) {
        void loadToolsConfig();
      }
    }
  }, [isCurrentToolsSelection, loadToolsConfig, mergeAgent]);

  /* Retired legacy heartbeat settings.
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
        telegram?: Record<string, unknown>;
      };
      if (response.ok && payload.success && Array.isArray(payload.channels)) {
        setHeartbeatDeliveryChannels(normalizeDeliveryChannels(payload.channels, payload.telegram ?? null));
        return;
      }
    } catch {
      // ignore
    }

    setHeartbeatDeliveryChannels([
      { id: 'web', label: 'Web Chat', connected: true, running: true },
    ]);
  }, []);
  */

  const patchSelectedAgent = useCallback(async (payload: Record<string, unknown>, ticket?: AgentToolsMutationTicket) => {
    if (isMainAgent || !selectedAgent) return;
    const target = ticket ?? { agentId: selectedAgentId, selectionEpoch: toolsSelectionEpochRef.current, expectedRevision: selectedAgent.revision };
    if (selectedAgent.agentId !== target.agentId || !isCurrentToolsSelection(target.agentId, target.selectionEpoch)) return;
    const result = await fetchJson<{ agent: AgentProfileItem }>('/api/agents', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        agentId: target.agentId,
        expectedRevision: target.expectedRevision,
      }),
    });
    if (!isCurrentToolsSelection(target.agentId, target.selectionEpoch)) return;
    if (result.agent.agentId !== target.agentId) throw new Error(t('agentPanel.tools.saveError'));
    mergeAgent(result.agent);
    await loadAgents();
    if (!ticket && isCurrentToolsSelection(target.agentId, target.selectionEpoch)) await loadToolsConfig();
  }, [isCurrentToolsSelection, isMainAgent, loadAgents, loadToolsConfig, mergeAgent, selectedAgent, selectedAgentId, t]);

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
    });
  }, [loadAgents]);

  useEffect(() => {
    if (isWorkflowUseOnly) return;
    startTransition(() => {
      void loadFiles();
      void loadSessions();
      void loadTools();
    });
  }, [isWorkflowUseOnly, loadFiles, loadSessions, loadTools]);

  useEffect(() => {
    if (SHOW_AGENT_DOCTOR_SECTION && searchParams.get('panel') === 'doctor' && !doctorResult && !doctorRunning) {
      startTransition(() => { void runDoctor(); });
    }
  }, [searchParams, doctorResult, doctorRunning, runDoctor]);

  /* Retired legacy heartbeat settings.
  const saveHeartbeatConfig = async () => {
    setHeartbeatSaving(true);
    setHeartbeatError(null);
    setHeartbeatSuccess(null);

    try {
      const deliveryChannelId = heartbeatDeliveryDraft.deliveryMode === 'last_active'
        ? null
        : heartbeatDeliveryDraft.deliveryMode === 'web'
          ? 'web'
          : heartbeatDeliveryDraft.deliveryChannelId || 'web';
      const payload = await fetchJson<AgentHeartbeatConfig>('/api/automations/heartbeat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          enabled: heartbeatConfig?.enabled ?? false,
          schedule: heartbeatDraftToSchedule(heartbeatScheduleDraft),
          deliveryMode: heartbeatDeliveryDraft.deliveryMode === 'last_active'
            ? 'last_active'
            : deliveryChannelId === 'web' ? 'web' : heartbeatDeliveryDraft.deliveryMode,
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
  */

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

  const requestResetManagedFile = async (fileName: ManagedFileName) => fetchJson<{ fileName: ManagedFileName; content: string; agent?: AgentProfileItem }>('/api/agents/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: selectedAgentId,
      expectedRevision: selectedAgent?.revision,
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
      const payload = await fetchJson<{ fileName: ManagedFileName; content: string; agent?: AgentProfileItem }>('/api/agents/files', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          expectedRevision: selectedAgent?.revision,
          fileName,
          content,
        }),
      });

      applyManagedFileContent(payload.fileName, payload.content);
      if (payload.agent) mergeAgent(payload.agent);
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

  /* Retired legacy heartbeat settings.
  const saveHeartbeatFile = async () => {
    await saveManagedFile('HEARTBEAT.md', {
      setSaving: setHeartbeatFileSaving,
      setError: setHeartbeatFileError,
      setSuccess: setHeartbeatFileSuccess,
      successMessage: () => t('agentPanel.heartbeat.fileSaved'),
      errorMessage: t('agentPanel.heartbeat.errors.fileSave'),
    });
  };
  */

  const resetFile = async () => {
    if (!resetTarget) return;

    setFilesResetting(true);
    setFilesError(null);
    setFilesSuccess(null);

    try {
      if (resetTarget === 'current') {
        const payload = await requestResetManagedFile(activeFile);
        applyManagedFileContent(payload.fileName, payload.content);
        if (payload.agent) mergeAgent(payload.agent);
        setFilesSuccess(t('agentPanel.files.resetSuccess', { fileName: payload.fileName }));
      } else {
        const payload = await fetchJson<{ files: Array<{ fileName: ManagedFileName; content: string }>; agent?: AgentProfileItem }>('/api/agents/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: selectedAgentId,
            expectedRevision: selectedAgent?.revision,
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
        if (payload.agent) mergeAgent(payload.agent);
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

  /* Retired legacy heartbeat settings.
  const resetHeartbeatFile = async () => {
    setHeartbeatFileResetting(true);
    setHeartbeatFileError(null);
    setHeartbeatFileSuccess(null);

    try {
      const payload = await requestResetManagedFile('HEARTBEAT.md');
      applyManagedFileContent(payload.fileName, payload.content);
      if (payload.agent) mergeAgent(payload.agent);
      setHeartbeatFileSuccess(t('agentPanel.heartbeat.fileResetSuccess'));
    } catch (error) {
      setHeartbeatFileError(error instanceof Error ? error.message : t('agentPanel.heartbeat.errors.fileReset'));
    } finally {
      setHeartbeatFileResetting(false);
      setHeartbeatResetDialogOpen(false);
    }
  };
  */

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
    return toolsConfig?.agentId === selectedAgentId && !toolsLoading ? toolsConfig.enabledTools : [];
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

  const saveToolsSelection = async (newEnabledTools: string[] | null, fallback: string) => {
    const snapshot = toolsSnapshotRef.current;
    if (!snapshot || toolsConfig !== snapshot.config || toolsLoading || toolsSaveTokenRef.current || workflowSaveTokenRef.current
      || snapshot.config.agentId !== selectedAgentId || !isCurrentToolsSelection(selectedAgentId, snapshot.selectionEpoch)
      || !isMainAgent && selectedAgent?.agentId !== selectedAgentId || isMainAgent && newEnabledTools === null) return;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const ticket: AgentToolsSaveToken = { agentId: selectedAgentId, selectionEpoch: snapshot.selectionEpoch,
      expectedRevision: selectedAgent?.revision, settled, settle };
    toolsSaveTokenRef.current = ticket;
    toolsRequestSeqRef.current += 1;
    setToolsSaving(true);
    setToolsError(null);
    let saved = false;

    try {
      if (!isMainAgent) {
        await patchSelectedAgent({ enabledTools: newEnabledTools === null ? null : [...newEnabledTools] }, ticket);
      } else {
        const payload = await fetchJson<{ config: AgentToolsConfigData }>('/api/agents/tools', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: ticket.agentId, enabledTools: newEnabledTools === null ? null : [...newEnabledTools] }),
        });
        if (payload.config?.agentId !== ticket.agentId || !Array.isArray(payload.config.enabledTools)) throw new Error(fallback);
        if (isCurrentToolsSelection(ticket.agentId, ticket.selectionEpoch)) {
          toolsSnapshotRef.current = { selectionEpoch: ticket.selectionEpoch, config: payload.config };
          setToolsConfig(payload.config);
        }
      }
      saved = true;
    } catch (error) {
      if (isCurrentToolsSelection(ticket.agentId, ticket.selectionEpoch)) setToolsError(error instanceof Error ? error.message : fallback);
    } finally {
      if (toolsSaveTokenRef.current === ticket) {
        toolsSaveTokenRef.current = null;
        if (toolsMountedRef.current) setToolsSaving(false);
      }
      ticket.settle();
    }
    if (saved && isCurrentToolsSelection(ticket.agentId, ticket.selectionEpoch)) await loadToolsConfig();
  };

  const saveToolsConfig = async (newEnabledTools: string[]) => {
    await saveToolsSelection(newEnabledTools, t('agentPanel.tools.saveError'));
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
    let newEnabledTools = getActiveEnabledTools();
    for (const tool of filteredTools) {
      if (tool.availability?.available === false) continue;
      newEnabledTools = enableToolInConfig(tool.name, newEnabledTools, allNames);
    }
    void saveToolsConfig(newEnabledTools);
  };

  const handleDisableAll = () => {
    const allNames = availableTools.map((t) => t.name);
    let newEnabledTools = getActiveEnabledTools();
    for (const tool of filteredTools) {
      newEnabledTools = disableToolInConfig(tool.name, newEnabledTools, allNames);
    }
    void saveToolsConfig(newEnabledTools);
  };

  const setToolsOverrideEnabled = async (enabled: boolean) => {
    if (isMainAgent) return;
    await saveToolsSelection(enabled ? getActiveEnabledTools() : null, t('agentPanel.inheritance.errors.save'));
  };

  const setAgentModelOverrideEnabled = async (enabled: boolean) => {
    if (isMainAgent || !selectedAgent) return;
    setModelOverrideError(null);

    if (enabled) {
      setModelOverrideEnabled(true);
      setAgentSectionOpen('runtime', true);
      return;
    }

    if (!hasStoredModelOverride) {
      setModelOverrideEnabled(false);
      return;
    }

    setModelOverrideSaving(true);
    try {
      await patchSelectedAgent({
        defaultProviderInstallationId: null,
        defaultProvider: null,
        defaultModel: null,
        defaultThinking: null,
      });
      setModelOverrideEnabled(false);
    } catch (error) {
      setModelOverrideError(error instanceof Error ? error.message : t('agentPanel.inheritance.errors.save'));
    } finally {
      setModelOverrideSaving(false);
    }
  };

  const saveAgentCapabilityOverrides = async (payload: Record<string, unknown>) => {
    if (isMainAgent) return;
    setCapabilitiesSaving(true);
    setCapabilitiesError(null);
    try {
      await patchSelectedAgent(payload);
    } catch (error) {
      setCapabilitiesError(error instanceof Error ? error.message : t('agentPanel.capabilities.errors.save'));
    } finally {
      setCapabilitiesSaving(false);
    }
  };

  const setAgentSkillsOverrideEnabled = async (enabled: boolean) => {
    const nextSkills = enabled ? selectedAgent?.relevantSkills ?? [] : [];
    setRelevantSkillsDraft(nextSkills);
    await saveAgentCapabilityOverrides({
      relevantSkills: enabled ? nextSkills : null,
    });
  };

  const saveAgentRelevantSkills = async (skillNames: string[]) => {
    setRelevantSkillsDraft(skillNames);
    await saveAgentCapabilityOverrides({ relevantSkills: skillNames });
  };

  const setAgentConnectionsOverrideEnabled = async (enabled: boolean) => {
    const nextConnections = enabled ? selectedAgent?.relevantConnections ?? [] : [];
    setRelevantConnectionsDraft(nextConnections);
    await saveAgentCapabilityOverrides({
      relevantConnections: enabled ? nextConnections : null,
    });
  };

  const saveAgentRelevantConnections = async (connectionIds: string[]) => {
    setRelevantConnectionsDraft(connectionIds);
    await saveAgentCapabilityOverrides({ relevantConnections: connectionIds });
  };

  const toolGroups = useMemo(() => {
    const groups = [...new Set(availableTools.map(t => t.group).filter(Boolean))] as string[];
    return groups.sort();
  }, [availableTools]);

  const filteredTools = availableTools.filter((tool) => {
    if (activeToolGroups.size > 0 && (!tool.group || !activeToolGroups.has(tool.group))) {
      return false;
    }
    const query = toolSearchQuery.trim().toLowerCase();
    if (!query) return true;
    return tool.name.toLowerCase().includes(query) ||
      tool.label.toLowerCase().includes(query) ||
      tool.description.toLowerCase().includes(query) ||
      Boolean(tool.group?.toLowerCase().includes(query));
  });

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

  const effectiveEnabledToolCount = availableTools.filter((tool) => isToolEnabled(tool.name)).length;

  return (
    <div className="space-y-4">
      <MemoryReviewAgentCard />

      <AgentSelectorCard
        agents={agents}
        selectedAgentId={selectedAgentId}
        loading={agentsLoading}
        error={agentsError}
        creating={agentCreating}
        deletingAgentId={agentDeletingId}
        canManageAgentDefaults={canManageAgentDefaults}
        openCreateDialogOnMount={shouldOpenCreateAgentDialog}
        onSelectedAgentIdChange={selectAgent}
        onCreate={createAgent}
        onDelete={(agentId) => void deleteAgent(agentId)}
        onReload={() => void loadAgents()}
      />

      {selectedAgent?.workflowVersion === 1 && selectedAgent.access?.canUse ? <Card data-testid="agent-settings-workflow">
        <CardHeader><CardTitle className="flex items-center gap-2"><Route className="size-4" />{tWorkflow('title')}</CardTitle>
          <CardDescription>{tWorkflow('settingsDescription')}</CardDescription></CardHeader>
        <CardContent><Button ref={workflowTriggerRef} type="button" variant="outline" onClick={() => setWorkflowDialogOpen(true)}>{tWorkflow('open')}</Button></CardContent>
      </Card> : null}
      {selectedAgent ? <AgentWorkflowChoiceDialog key={selectedAgent.agentId} open={workflowDialogOpen} agentId={selectedAgent.agentId}
        agentName={selectedAgent.name} onOpenChange={setWorkflowDialogOpen} onRestoreFocus={() => workflowTriggerRef.current?.focus()} /> : null}

      {!isMainAgent && selectedAgent?.access?.canEdit ? <Card data-testid="agent-settings-workflow-management">
        <CardHeader><CardTitle className="flex items-center gap-2"><Route className="size-4" />{tWorkflowManagement('title')}</CardTitle>
          <CardDescription>{tWorkflowManagement('settingsDescription')}</CardDescription></CardHeader>
        <CardContent><Button ref={workflowManagementTriggerRef} data-testid="agent-settings-workflow-management-open" type="button" variant="outline"
          onClick={() => setWorkflowManagementOpen(true)}>{tWorkflowManagement('open')}</Button></CardContent>
      </Card> : null}
      {!isMainAgent && selectedAgent?.access?.canEdit ? <AgentWorkflowManagementDialog
        key={`${selectedAgent.agentId}:${workflowContextKey}:${workflowManagementSelectionEpoch}`} open={workflowManagementOpen}
        agentId={selectedAgent.agentId} agentName={selectedAgent.name} ownerUserId={currentUserId || null}
        context={workflowManagementContext} selectionEpoch={workflowManagementSelectionEpoch}
        saveBlocked={toolsSaving || workflowManagementSaving}
        onOpenChange={setWorkflowManagementOpen} waitForPendingSave={waitForPendingWorkflowSave} commit={commitWorkflowManagement}
        onOpenNativeTools={() => {
          setAgentSectionOpen('tools', true);
          window.requestAnimationFrame(() => {
            const card = document.getElementById('onboarding-settings-tools');
            const control = card?.querySelector<HTMLElement>('button') ?? [...document.querySelectorAll<HTMLElement>('[role="switch"]')]
              .find(element => element.getAttribute('aria-label') === t('agentPanel.inheritance.toolsOverride'));
            (card ?? control)?.scrollIntoView({ block: 'center' });
            control?.focus();
          });
        }}
        onRestoreFocus={() => workflowManagementTriggerRef.current?.focus()} /> : null}

      {!isWorkflowUseOnly ? <>

      {selectedAgent?.scopeType === 'organization' && selectedAgent.access?.canManage ? (
        <Card>
          <CardContent className="pt-6">
            <AgentGrantsEditor
              active
              agentId={selectedAgent.agentId}
              revision={selectedAgent.revision}
              onChanged={(updated) => mergeAgent({ ...selectedAgent, ...updated })}
            />
          </CardContent>
        </Card>
      ) : null}

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
                    ? t('agentPanel.inheritance.usesDedicatedModel')
                    : t('agentPanel.inheritance.inheritsAppDefault')}
                </p>
              </div>
              <Switch
                checked={modelOverrideEnabled}
                onCheckedChange={(checked) => void setAgentModelOverrideEnabled(checked)}
                disabled={modelOverrideSaving || !canManageAgentDefaults}
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
                disabled={toolsSaving || workflowManagementSaving || toolsLoading}
                aria-label={t('agentPanel.inheritance.toolsOverride')}
              />
            </div>
            {!hasWorkflowConfiguration ? <><div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('agentPanel.capabilities.skillsToggle')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {skillsOverrideEnabled
                    ? t('agentPanel.capabilities.skillsCustom', { count: selectedAgent?.relevantSkills?.length ?? 0 })
                    : t('agentPanel.capabilities.skillsInherited')}
                </p>
              </div>
              <Switch
                checked={skillsOverrideEnabled}
                onCheckedChange={(checked) => void setAgentSkillsOverrideEnabled(checked)}
                disabled={capabilitiesSaving}
                aria-label={t('agentPanel.capabilities.skillsToggle')}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('agentPanel.capabilities.connectionsToggle')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {connectionsOverrideEnabled
                    ? t('agentPanel.capabilities.connectionsCustom', { count: selectedAgent?.relevantConnections?.length ?? 0 })
                    : t('agentPanel.capabilities.connectionsInherited')}
                </p>
              </div>
              <Switch
                checked={connectionsOverrideEnabled}
                onCheckedChange={(checked) => void setAgentConnectionsOverrideEnabled(checked)}
                disabled={capabilitiesSaving}
                aria-label={t('agentPanel.capabilities.connectionsToggle')}
              />
            </div>
            </> : null}
            {modelOverrideError && <p className="text-sm text-destructive md:col-span-2">{modelOverrideError}</p>}
            {capabilitiesError && <p className="text-sm text-destructive md:col-span-2">{capabilitiesError}</p>}
          </CardContent>
        </Card>
      )}

      {isMainAgent && selectedAgent && (
        <AgentRuntimePreferenceCard
          agentId={selectedAgent.agentId}
          agentName={selectedAgent.name}
          canManageRuntimeCatalog={canManageAgentDefaults}
          isOpen={agentSectionOpenById.runtime}
          onOpenChange={(isOpen) => setAgentSectionOpen('runtime', isOpen)}
        />
      )}

      {!isMainAgent && selectedAgent && modelOverrideEnabled && (
        <AgentCatalogModelOverrideCard
          key={selectedAgent.agentId}
          agent={selectedAgent}
          canManage={canManageAgentDefaults}
          isOpen={agentSectionOpenById.runtime}
          onOpenChange={(isOpen) => setAgentSectionOpen('runtime', isOpen)}
          onSavingChange={setModelOverrideSaving}
          onSaved={async () => {
            await loadAgents();
            await loadToolsConfig();
          }}
        />
      )}

      {(isMainAgent || toolsOverrideEnabled) && (
        <AgentToolsCard
          availableTools={availableTools}
          filteredTools={filteredTools}
          toolGroups={toolGroups}
          activeToolGroups={activeToolGroups}
          openToolRows={openToolRows}
          toolsLoading={toolsLoading}
          toolsSaving={toolsSaving || workflowManagementSaving}
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

      {!hasWorkflowConfiguration && !isMainAgent && connectionsOverrideEnabled && (
        <AgentSettingsAccordionCard
          title={t('agentPanel.capabilities.connectionsTitle')}
          description={t('agentPanel.capabilities.connectionsDescription')}
          isOpen={agentSectionOpenById.connections}
          onOpenChange={(isOpen) => setAgentSectionOpen('connections', isOpen)}
          summaryItems={[t('agentPanel.capabilities.connectionsCustom', { count: relevantConnectionsDraft.length })]}
        >
          <AgentConnectionsPicker
            enabled
            selectedConnectionIds={relevantConnectionsDraft}
            onSelectedConnectionIdsChange={(connectionIds) => void saveAgentRelevantConnections(connectionIds)}
            pageSize={6}
          />
        </AgentSettingsAccordionCard>
      )}

      {!hasWorkflowConfiguration && !isMainAgent && skillsOverrideEnabled && (
        <AgentSettingsAccordionCard
          title={t('agentPanel.capabilities.skillsTitle')}
          description={t('agentPanel.capabilities.skillsDescription')}
          isOpen={agentSectionOpenById.skills}
          onOpenChange={(isOpen) => setAgentSectionOpen('skills', isOpen)}
          summaryItems={[t('agentPanel.capabilities.skillsCustom', { count: relevantSkillsDraft.length })]}
        >
          <AgentRelevantSkillsPicker
            enabled
            selectedSkillNames={relevantSkillsDraft}
            onSelectedSkillNamesChange={(skillNames) => void saveAgentRelevantSkills(skillNames)}
          />
        </AgentSettingsAccordionCard>
      )}

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">Agent Memory</p>
            <p className="mt-1 text-sm text-muted-foreground">Persistent agent context is managed centrally with review history and a scoped prompt budget.</p>
          </div>
          <Link className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90" href={`/settings?tab=memory&scope=agent&agentId=${encodeURIComponent(selectedAgentId)}`}>Manage Agent Memory</Link>
        </CardContent>
      </Card>

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
        visibleFileNames={['AGENTS.md', 'SOUL.md', 'TOOLS.md']}
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
      </> : null}
    </div>
  );
}
