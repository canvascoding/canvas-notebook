'use client';

/* eslint-disable @next/next/no-img-element */

import { useEffect, useEffectEvent, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Link2,
  ExternalLink,
  FileText,
  Folder,
  Loader2,
  MessageSquare,
  PauseCircle,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  WandSparkles,
  Webhook,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { WorkspaceDirectoryPickerDialog } from '@/app/apps/automationen/components/WorkspaceDirectoryPickerDialog';
import { getDefaultAutomationTargetOutputPath, getEffectiveAutomationTargetOutputPath } from '@/app/lib/automations/paths';
import type {
  AutomationJobRecord,
  AutomationRunRecord,
  AutomationRunStatus,
  AutomationTriggerType,
  AutomationWeekday,
  FriendlySchedule,
} from '@/app/lib/automations/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Link, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

type ScheduleKind = 'once' | 'daily' | 'weekly' | 'interval';
type ComposerMode = 'scheduled' | 'trigger';

type JobDraft = {
  id: string | null;
  name: string;
  prompt: string;
  preferredSkill: string;
  workspaceContextText: string;
  targetOutputPath: string;
  status: 'active' | 'paused';
  scheduleKind: ScheduleKind;
  timeZone: string;
  onceDate: string;
  onceTime: string;
  dailyTime: string;
  weeklyTime: string;
  weeklyDays: AutomationWeekday[];
  intervalEvery: string;
  intervalUnit: 'minutes' | 'hours' | 'days';
};

type PersistedAutomationSessionMessage = {
  id?: number | string;
  role: string;
  content?: unknown;
  errorMessage?: string;
};

type AutomationTemplate = {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  dailyTime?: string;
  weeklyTime?: string;
  weeklyDays?: AutomationWeekday[];
  targetOutputPath?: string;
};

type SkillOption = {
  name: string;
  description?: string;
  enabled?: boolean;
};

type ComposioToolkitInfo = {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  connected?: boolean;
  connectedAccountId?: string;
  connectedAccountStatus?: string;
};

type TriggerTypeInfo = {
  slug: string;
  name: string;
  description: string;
  configSchema: Record<string, unknown> | null;
  toolkitSlug: string;
};

type TriggerCapableApp = Omit<ComposioToolkitInfo, 'connected' | 'connectedAccountId' | 'connectedAccountStatus'> & {
  connected: boolean;
  connectedAccountId: string;
  connectedAccountStatus: string;
  triggerCount?: number;
};

type TriggerComposerDraft = {
  toolkitSlug: string;
  triggerSlug: string;
  name: string;
  prompt: string;
  preferredSkill: string;
  workspaceContextText: string;
  targetOutputPath: string;
  configValues: Record<string, string | boolean>;
};

type ComposioStatus = {
  configured: boolean;
  apiKeyValid?: boolean;
  mode?: string;
  connectedAccounts?: Array<{
    id: string;
    toolkit?: {
      slug?: string;
      name?: string;
    };
    status?: string;
  }>;
};

type AutomationsClientProps = {
  initialJobId?: string | null;
};

const WEEKDAY_OPTIONS: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function defaultDraft(): JobDraft {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';

  return {
    id: null,
    name: '',
    prompt: '',
    preferredSkill: 'auto',
    workspaceContextText: '',
    targetOutputPath: '',
    status: 'active',
    scheduleKind: 'daily',
    timeZone,
    onceDate: today,
    onceTime: '09:00',
    dailyTime: '09:00',
    weeklyTime: '09:00',
    weeklyDays: ['mon'],
    intervalEvery: '1',
    intervalUnit: 'days',
  };
}

function defaultTriggerDraft(): TriggerComposerDraft {
  return {
    toolkitSlug: '',
    triggerSlug: '',
    name: '',
    prompt: '',
    preferredSkill: 'auto',
    workspaceContextText: '',
    targetOutputPath: '',
    configValues: {},
  };
}

function getAutomationTemplates(locale: string): AutomationTemplate[] {
  const isGerman = locale.startsWith('de');

  return isGerman
    ? [
        {
          id: 'daily-workspace-briefing',
          name: 'Tägliches Workspace Briefing',
          prompt: 'Prüfe die wichtigsten Projektordner und erstelle eine kurze Tagesübersicht mit offenen Aufgaben, blockierten Punkten und nächsten Schritten.',
          scheduleKind: 'daily',
          dailyTime: '08:30',
          targetOutputPath: '00_dashboard/daily-briefings',
        },
        {
          id: 'marketing-content-plan',
          name: 'Wöchentlicher Marketing-Plan',
          prompt: 'Erstelle aus Strategie-, Brand- und Content-Unterlagen einen umsetzbaren Marketing-Plan für die kommende Woche mit Themen, Kanälen und konkreten To-dos.',
          scheduleKind: 'weekly',
          weeklyDays: ['mon'],
          weeklyTime: '09:00',
          targetOutputPath: '05_content-engine/weekly-plans',
        },
        {
          id: 'campaign-check',
          name: 'Kampagnen-Check',
          prompt: 'Prüfe die aktuellen Kampagnenunterlagen, fasse Risiken und Chancen zusammen und aktualisiere eine kurze Entscheidungsvorlage für Sales und Marketing.',
          scheduleKind: 'daily',
          dailyTime: '10:00',
          targetOutputPath: '03_offer-and-sales/campaign-checks',
        },
        {
          id: 'personal-assistant-summary',
          name: 'Persönliche Wochenassistenz',
          prompt: 'Fasse am Ende der Woche wichtige offene Punkte, Follow-ups, Termine und private/geschäftliche Erinnerungen aus dem Workspace zusammen.',
          scheduleKind: 'weekly',
          weeklyDays: ['fri'],
          weeklyTime: '16:00',
          targetOutputPath: '08_operations/personal-assistant',
        },
      ]
    : [
        {
          id: 'daily-workspace-briefing',
          name: 'Daily Workspace Briefing',
          prompt: 'Review the key project folders and create a short daily brief with open tasks, blockers, and recommended next steps.',
          scheduleKind: 'daily',
          dailyTime: '08:30',
          targetOutputPath: '00_dashboard/daily-briefings',
        },
        {
          id: 'marketing-content-plan',
          name: 'Weekly Marketing Plan',
          prompt: 'Use the strategy, brand, and content folders to create an actionable marketing plan for next week with topics, channels, and concrete tasks.',
          scheduleKind: 'weekly',
          weeklyDays: ['mon'],
          weeklyTime: '09:00',
          targetOutputPath: '05_content-engine/weekly-plans',
        },
        {
          id: 'campaign-check',
          name: 'Campaign Check',
          prompt: 'Review the current campaign materials, summarize risks and opportunities, and update a concise decision brief for sales and marketing.',
          scheduleKind: 'daily',
          dailyTime: '10:00',
          targetOutputPath: '03_offer-and-sales/campaign-checks',
        },
        {
          id: 'personal-assistant-summary',
          name: 'Personal Assistant Summary',
          prompt: 'At the end of the week, summarize important open items, follow-ups, appointments, and personal or business reminders from the workspace.',
          scheduleKind: 'weekly',
          weeklyDays: ['fri'],
          weeklyTime: '16:00',
          targetOutputPath: '08_operations/personal-assistant',
        },
      ];
}

function parseWorkspaceContext(text: string): string[] {
  return Array.from(new Set(text.split(/\n|,/).map((entry) => entry.trim()).filter(Boolean)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonResponse(response: Response, context: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${context} returned an invalid response.`);
  }
}

function normalizeToolkit(value: unknown): ComposioToolkitInfo | null {
  const record = asRecord(value);
  const slug = stringValue(record.slug);
  if (!slug) return null;
  return {
    slug,
    name: stringValue(record.name) || slug,
    logo: stringValue(record.logo),
    description: stringValue(record.description),
    connected: Boolean(record.connected),
    connectedAccountId: stringValue(record.connectedAccountId),
    connectedAccountStatus: stringValue(record.connectedAccountStatus),
  };
}

function normalizeTriggerApp(value: unknown): TriggerCapableApp | null {
  const record = asRecord(value);
  const toolkit = normalizeToolkit(value);
  if (!toolkit) return null;
  return {
    ...toolkit,
    connected: Boolean(record.connected),
    connectedAccountId: stringValue(record.connectedAccountId),
    connectedAccountStatus: stringValue(record.connectedAccountStatus),
    triggerCount: typeof record.triggerCount === 'number' ? record.triggerCount : undefined,
  };
}

function normalizeTriggerType(value: unknown, toolkitSlug: string): TriggerTypeInfo | null {
  const record = asRecord(value);
  const slug = stringValue(record.slug) || stringValue(record.name);
  if (!slug) return null;
  const configSchema = asRecord(record.configSchema ?? record.config_schema ?? record.config ?? record.inputParameters ?? record.input_parameters);
  return {
    slug,
    name: stringValue(record.displayName) || stringValue(record.name) || slug,
    description: stringValue(record.description),
    configSchema: Object.keys(configSchema).length > 0 ? configSchema : null,
    toolkitSlug,
  };
}

function getSchemaProperties(schema: Record<string, unknown> | null): Array<{
  key: string;
  label: string;
  description: string;
  type: string;
  enumValues: string[];
  required: boolean;
}> {
  if (!schema) return [];
  const properties = asRecord(schema.properties ?? schema);
  const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
  return Object.entries(properties).map(([key, value]) => {
    const property = asRecord(value);
    const enumValues = Array.isArray(property.enum) ? property.enum.map(String) : [];
    return {
      key,
      label: stringValue(property.title) || stringValue(property.display_name) || key,
      description: stringValue(property.description),
      type: stringValue(property.type) || (enumValues.length > 0 ? 'string' : 'string'),
      enumValues,
      required: required.includes(key),
    };
  });
}

function buildTriggerConfigFromSchema(schema: Record<string, unknown> | null, values: Record<string, string | boolean>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const property of getSchemaProperties(schema)) {
    const rawValue = values[property.key];
    if (rawValue === undefined || rawValue === '') continue;
    if (property.type === 'boolean') {
      config[property.key] = Boolean(rawValue);
    } else if (property.type === 'number' || property.type === 'integer') {
      const numeric = Number(rawValue);
      if (Number.isFinite(numeric)) config[property.key] = property.type === 'integer' ? Math.floor(numeric) : numeric;
    } else {
      config[property.key] = String(rawValue);
    }
  }
  return config;
}

function AppLogo({ app }: { app: TriggerCapableApp }) {
  const fallback = app.name.slice(0, 2).toUpperCase();
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background text-xs font-semibold text-muted-foreground">
      {app.logo ? (
        <img src={app.logo} alt="" className="h-full w-full object-contain p-1.5" loading="lazy" />
      ) : (
        fallback
      )}
    </span>
  );
}

function buildPayload(draft: JobDraft) {
  const schedule =
    draft.scheduleKind === 'once'
      ? { kind: 'once' as const, date: draft.onceDate, time: draft.onceTime, timeZone: draft.timeZone }
      : draft.scheduleKind === 'daily'
        ? { kind: 'daily' as const, times: draft.dailyTime ? [draft.dailyTime] : [], timeZone: draft.timeZone }
        : draft.scheduleKind === 'weekly'
          ? { kind: 'weekly' as const, days: draft.weeklyDays, times: draft.weeklyTime ? [draft.weeklyTime] : [], timeZone: draft.timeZone }
          : { kind: 'interval' as const, every: Number(draft.intervalEvery || '1'), unit: draft.intervalUnit, timeZone: draft.timeZone };

  return {
    name: draft.name,
    prompt: draft.prompt,
    preferredSkill: draft.preferredSkill || 'auto',
    workspaceContextPaths: parseWorkspaceContext(draft.workspaceContextText),
    targetOutputPath: draft.targetOutputPath.trim() || null,
    status: draft.status,
    schedule,
  };
}

function formatDateTime(value: string | null, locale: string, emptyLabel: string): string {
  if (!value) return emptyLabel;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}

function describeFriendlyScheduleLocalized(
  schedule: FriendlySchedule,
  translate: (key: string, values?: Record<string, string | number>) => string,
  weekdayLabels: Record<AutomationWeekday, string>,
): string {
  if (schedule.kind === 'once') return translate('scheduleSummary.once', { date: schedule.date, time: schedule.time });
  if (schedule.kind === 'daily') return translate('scheduleSummary.daily', { time: schedule.times.join(', ') });
  if (schedule.kind === 'weekly') {
    return translate('scheduleSummary.weekly', {
      days: schedule.days.map((day) => weekdayLabels[day]).join(', '),
      time: schedule.times.join(', '),
    });
  }
  if (schedule.kind === 'webhook') return 'Webhook';
  return translate('scheduleSummary.interval', { every: schedule.every, unit: translate(`intervalUnits.${schedule.unit}`) });
}

function formatRunStatus(status: AutomationRunStatus, translate: (key: string) => string): string {
  return translate(`runStatus.${status}`);
}

function formatTriggerType(triggerType: AutomationTriggerType, translate: (key: string) => string): string {
  return translate(`triggerType.${triggerType}`);
}

function toNotebookUrl(filePath: string) {
  return `/notebook?path=${encodeURIComponent(filePath)}`;
}

function toChatUrl(sessionId: string) {
  return `/chat?session=${encodeURIComponent(sessionId)}`;
}

function isTextContentPart(part: unknown): part is { type: 'text'; text: string } {
  return typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string';
}

function extractAutomationSessionMessageText(message: PersistedAutomationSessionMessage): string {
  if (typeof message.content === 'string') return message.content.trim();

  if (Array.isArray(message.content)) {
    const text = message.content.filter(isTextContentPart).map((part) => part.text).join('\n\n').trim();
    if (text) return text;
  }

  if (message.errorMessage?.trim()) return message.errorMessage.trim();
  if (message.role === 'toolResult') return '[Tool result]';
  if (message.role === 'compact-break') return '[Conversation compacted]';
  return '';
}

function formatAutomationSessionRole(role: string, translate: (key: string) => string): string {
  if (role === 'user' || role === 'assistant' || role === 'toolResult') return translate(`session.roles.${role}`);
  if (role === 'compact-break') return translate('session.roles.system');
  return role;
}

function getWebhookMetadata(run: AutomationRunRecord | null): Record<string, unknown> | null {
  const webhook = run?.metadataJson?.webhook;
  return webhook && typeof webhook === 'object' && !Array.isArray(webhook) ? webhook as Record<string, unknown> : null;
}

function mapJobToDraft(job: AutomationJobRecord): JobDraft {
  const draft = defaultDraft();
  draft.id = job.id;
  draft.name = job.name;
  draft.prompt = job.prompt;
  draft.preferredSkill = job.preferredSkill || 'auto';
  draft.workspaceContextText = job.workspaceContextPaths.join('\n');
  draft.targetOutputPath = job.targetOutputPath || '';
  draft.status = job.status;
  draft.scheduleKind = job.schedule.kind === 'webhook' ? 'interval' : job.schedule.kind;
  draft.timeZone = job.timeZone;

  if (job.schedule.kind === 'once') {
    draft.onceDate = job.schedule.date;
    draft.onceTime = job.schedule.time;
  } else if (job.schedule.kind === 'daily') {
    draft.dailyTime = job.schedule.times[0] || '';
  } else if (job.schedule.kind === 'weekly') {
    draft.weeklyTime = job.schedule.times[0] || '';
    draft.weeklyDays = job.schedule.days;
  } else if (job.schedule.kind === 'interval') {
    draft.intervalEvery = String(job.schedule.every);
    draft.intervalUnit = job.schedule.unit;
  }

  return draft;
}

export function AutomationsClient({ initialJobId = null }: AutomationsClientProps) {
  const t = useTranslations('automationen');
  const locale = useLocale();
  const router = useRouter();
  const [jobs, setJobs] = useState<AutomationJobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<JobDraft>(() => defaultDraft());
  const [triggerDraft, setTriggerDraft] = useState<TriggerComposerDraft>(() => defaultTriggerDraft());
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const [sessionMessages, setSessionMessages] = useState<PersistedAutomationSessionMessage[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [composerMode, setComposerMode] = useState<ComposerMode>('scheduled');
  const [triggerApps, setTriggerApps] = useState<TriggerCapableApp[]>([]);
  const [triggerTypesByToolkit, setTriggerTypesByToolkit] = useState<Record<string, TriggerTypeInfo[]>>({});
  const [appSearch, setAppSearch] = useState('');
  const [triggerSearch, setTriggerSearch] = useState('');
  const [composioStatus, setComposioStatus] = useState<ComposioStatus | null>(null);
  const [isLoadingTriggerApps, setIsLoadingTriggerApps] = useState(false);
  const [loadingTriggerToolkitSlug, setLoadingTriggerToolkitSlug] = useState<string | null>(null);
  const [triggerAppsError, setTriggerAppsError] = useState<string | null>(null);
  const [triggerTypesError, setTriggerTypesError] = useState<string | null>(null);
  const [triggerActionSlug, setTriggerActionSlug] = useState<string | null>(null);
  const [directoryPickerTarget, setDirectoryPickerTarget] = useState<'scheduled' | 'trigger'>('scheduled');
  const [isLoadingJobs, setIsLoadingJobs] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningNow, setIsRunningNow] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRefreshingRuns, setIsRefreshingRuns] = useState(false);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isDirectoryPickerOpen, setIsDirectoryPickerOpen] = useState(false);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [isRunSheetOpen, setIsRunSheetOpen] = useState(false);

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedJobId) || null, [jobs, selectedJobId]);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) || null, [runs, selectedRunId]);
  const templates = useMemo(() => getAutomationTemplates(locale), [locale]);
  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabled !== false), [skills]);
  const selectedTriggerApp = useMemo(
    () => triggerApps.find((app) => app.slug === triggerDraft.toolkitSlug) || null,
    [triggerApps, triggerDraft.toolkitSlug],
  );
  const selectedTriggerTypes = useMemo(
    () => triggerDraft.toolkitSlug ? triggerTypesByToolkit[triggerDraft.toolkitSlug] || [] : [],
    [triggerDraft.toolkitSlug, triggerTypesByToolkit],
  );
  const selectedTriggerType = useMemo(
    () => selectedTriggerTypes.find((trigger) => trigger.slug === triggerDraft.triggerSlug) || null,
    [selectedTriggerTypes, triggerDraft.triggerSlug],
  );
  const filteredTriggerApps = useMemo(() => {
    const query = appSearch.trim().toLowerCase();
    if (!query) return triggerApps;
    return triggerApps.filter((app) => (
      app.name.toLowerCase().includes(query) ||
      app.slug.toLowerCase().includes(query) ||
      (app.description || '').toLowerCase().includes(query)
    ));
  }, [appSearch, triggerApps]);
  const filteredTriggerTypes = useMemo(() => {
    const query = triggerSearch.trim().toLowerCase();
    if (!query) return selectedTriggerTypes;
    return selectedTriggerTypes.filter((trigger) => (
      trigger.name.toLowerCase().includes(query) ||
      trigger.slug.toLowerCase().includes(query) ||
      trigger.description.toLowerCase().includes(query)
    ));
  }, [selectedTriggerTypes, triggerSearch]);
  const isLoadingSelectedTriggerTypes = loadingTriggerToolkitSlug === triggerDraft.toolkitSlug;
  const selectedTriggerAppHasLoadedTypes = Boolean(triggerDraft.toolkitSlug && triggerTypesByToolkit[triggerDraft.toolkitSlug]);
  const visibleSelectedTriggerType = filteredTriggerTypes.find((trigger) => trigger.slug === triggerDraft.triggerSlug) || null;
  const selectedAppTriggerCountLabel = selectedTriggerApp?.triggerCount
    ? t('triggers.eventCount', { count: selectedTriggerApp.triggerCount })
    : null;

  const automationGroups = useMemo(() => {
    const running = jobs.filter((job) => job.lastRunStatus === 'running' || job.lastRunStatus === 'pending' || job.lastRunStatus === 'retry_scheduled');
    const needsAttention = jobs.filter((job) => job.lastRunStatus === 'failed');
    const integration = jobs.filter((job) => job.jobType === 'webhook' || job.schedule.kind === 'webhook');
    const active = jobs.filter((job) => job.status === 'active' && !running.includes(job) && !needsAttention.includes(job) && !integration.includes(job));
    const paused = jobs.filter((job) => job.status === 'paused' && !needsAttention.includes(job) && !integration.includes(job));

    return { active, integration, needsAttention, paused, running };
  }, [jobs]);

  const draftDefaultTargetOutputPath = useMemo(() => getDefaultAutomationTargetOutputPath(draft.name || 'automation'), [draft.name]);
  const draftEffectiveTargetOutputPath = useMemo(
    () => getEffectiveAutomationTargetOutputPath({ name: draft.name || 'automation', targetOutputPath: draft.targetOutputPath }),
    [draft.name, draft.targetOutputPath],
  );

  const weekdayLabels = useMemo<Record<AutomationWeekday, string>>(
    () => ({
      mon: t('weekdays.mon'),
      tue: t('weekdays.tue'),
      wed: t('weekdays.wed'),
      thu: t('weekdays.thu'),
      fri: t('weekdays.fri'),
      sat: t('weekdays.sat'),
      sun: t('weekdays.sun'),
    }),
    [t],
  );

  async function loadJobs(options?: { keepSelection?: boolean }) {
    setIsLoadingJobs(true);
    try {
      const response = await fetch('/api/automations/jobs', { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadJobs'));

      const nextJobs = payload.data as AutomationJobRecord[];
      setJobs(nextJobs);

      if (!options?.keepSelection) {
        const nextSelected = (initialJobId ? nextJobs.find((job) => job.id === initialJobId) : null) || nextJobs[0] || null;
        setSelectedJobId(nextSelected?.id || null);
        setDraft(nextSelected ? mapJobToDraft(nextSelected) : defaultDraft());
      } else if (selectedJobId) {
        const nextSelected = nextJobs.find((job) => job.id === selectedJobId);
        if (nextSelected) setDraft(mapJobToDraft(nextSelected));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.loadJobs'));
    } finally {
      setIsLoadingJobs(false);
    }
  }

  const loadJobsEvent = useEffectEvent((options?: { keepSelection?: boolean }) => {
    void loadJobs(options);
  });

  async function loadRuns(jobId: string, preferredRunId?: string | null) {
    setIsRefreshingRuns(true);
    try {
      const response = await fetch(`/api/automations/jobs/${jobId}/runs`, { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadRuns'));

      const nextRuns = payload.data as AutomationRunRecord[];
      setRuns(nextRuns);
      const runToSelect = nextRuns.find((run) => run.id === preferredRunId) || nextRuns[0] || null;
      setSelectedRunId(runToSelect?.id || null);
    } catch (error) {
      setRuns([]);
      setSelectedRunId(null);
      setLogContent('');
      toast.error(error instanceof Error ? error.message : t('errors.loadRuns'));
    } finally {
      setIsRefreshingRuns(false);
    }
  }

  async function loadLogs(runId: string) {
    try {
      const response = await fetch(`/api/automations/runs/${runId}/logs`, { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadLogs'));
      setLogContent(payload.data.content || '');
    } catch (error) {
      setLogContent('');
      toast.error(error instanceof Error ? error.message : t('errors.loadLogs'));
    }
  }

  async function loadSessionMessages(sessionId: string) {
    setIsLoadingSessionMessages(true);
    try {
      const response = await fetch(`/api/sessions/messages?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadSession'));
      setSessionMessages(Array.isArray(payload.messages) ? (payload.messages as PersistedAutomationSessionMessage[]) : []);
    } catch (error) {
      setSessionMessages([]);
      toast.error(error instanceof Error ? error.message : t('errors.loadSession'));
    } finally {
      setIsLoadingSessionMessages(false);
    }
  }

  async function loadSkills() {
    try {
      const response = await fetch('/api/skills', { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (response.ok && payload.success && Array.isArray(payload.skills)) {
        setSkills(payload.skills as SkillOption[]);
      }
    } catch {
      setSkills([]);
    }
  }

  async function loadTriggerApps() {
    setIsLoadingTriggerApps(true);
    setTriggerAppsError(null);
    try {
      const appsResponse = await fetch('/api/composio/trigger-apps', { cache: 'no-store', credentials: 'include' });
      const appsPayload = await readJsonResponse(appsResponse, 'Composio trigger apps');
      if (!appsResponse.ok) throw new Error(stringValue(appsPayload.error) || t('triggers.errors.loadApps'));

      const status = asRecord(appsPayload.status) as ComposioStatus;
      setComposioStatus(status);
      if (!status.configured || status.mode === 'disabled' || status.apiKeyValid === false) {
        setTriggerApps([]);
        return;
      }

      const rawApps = Array.isArray(appsPayload.apps) ? appsPayload.apps : [];
      const nextApps = rawApps
        .map(normalizeTriggerApp)
        .filter((entry): entry is TriggerCapableApp => Boolean(entry))
        .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
      setTriggerApps(nextApps);
      setTriggerDraft((current) => {
        const selectedApp = nextApps.find((app) => app.slug === current.toolkitSlug) || nextApps[0] || null;
        return {
          ...current,
          toolkitSlug: selectedApp?.slug || '',
          triggerSlug: selectedApp?.slug === current.toolkitSlug ? current.triggerSlug : '',
          name: current.name,
          configValues: selectedApp?.slug === current.toolkitSlug ? current.configValues : {},
        };
      });
    } catch (error) {
      setTriggerApps([]);
      setTriggerAppsError(error instanceof Error ? error.message : t('triggers.errors.loadApps'));
    } finally {
      setIsLoadingTriggerApps(false);
    }
  }

  async function loadTriggerTypesForApp(toolkitSlug: string) {
    if (!toolkitSlug || triggerTypesByToolkit[toolkitSlug] || loadingTriggerToolkitSlug === toolkitSlug) return;
    setLoadingTriggerToolkitSlug(toolkitSlug);
    setTriggerTypesError(null);
    try {
      const response = await fetch(`/api/composio/triggers?toolkit=${encodeURIComponent(toolkitSlug)}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      const payload = await readJsonResponse(response, `Trigger types for ${toolkitSlug}`);
      if (!response.ok || payload.success === false) {
        throw new Error(stringValue(payload.error) || t('triggers.errors.loadEvents'));
      }
      const data = asRecord(payload.data);
      const rawTriggers = Array.isArray(data.triggerTypes) ? data.triggerTypes : [];
      const triggers = rawTriggers
        .map((entry) => normalizeTriggerType(entry, toolkitSlug))
        .filter((entry): entry is TriggerTypeInfo => Boolean(entry))
        .sort((a, b) => a.name.localeCompare(b.name));
      setTriggerTypesByToolkit((current) => ({ ...current, [toolkitSlug]: triggers }));
    } catch (error) {
      setTriggerTypesError(error instanceof Error ? error.message : t('triggers.errors.loadEvents'));
      setTriggerTypesByToolkit((current) => ({ ...current, [toolkitSlug]: [] }));
    } finally {
      setLoadingTriggerToolkitSlug((current) => (current === toolkitSlug ? null : current));
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobsEvent();
    void loadSkills();
  }, []);

  useEffect(() => {
    if (!isComposerOpen || composerMode !== 'trigger' || triggerApps.length > 0 || isLoadingTriggerApps) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTriggerApps();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalog loading is only needed when opening the trigger tab
  }, [isComposerOpen, composerMode, triggerApps.length, isLoadingTriggerApps]);

  useEffect(() => {
    if (!isComposerOpen || composerMode !== 'trigger' || !triggerDraft.toolkitSlug) return;
    let cancelled = false;
    const toolkitSlug = triggerDraft.toolkitSlug;
    queueMicrotask(() => {
      if (cancelled) return;
      void loadTriggerTypesForApp(toolkitSlug);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selected toolkit drives lazy trigger loading
  }, [isComposerOpen, composerMode, triggerDraft.toolkitSlug]);

  useEffect(() => {
    if (!selectedTriggerApp || selectedTriggerTypes.length === 0) return;
    const currentTrigger = selectedTriggerTypes.find((trigger) => trigger.slug === triggerDraft.triggerSlug);
    if (currentTrigger) return;
    const nextTrigger = selectedTriggerTypes[0];
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setTriggerDraft((current) => ({
        ...current,
        triggerSlug: nextTrigger.slug,
        name: current.name || `${selectedTriggerApp.name}: ${nextTrigger.name}`,
        configValues: {},
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedTriggerApp, selectedTriggerTypes, triggerDraft.triggerSlug]);

  useEffect(() => {
    if (!selectedJobId) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setRuns([]);
      setSelectedRunId(null);
      setLogContent('');
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    void loadRuns(selectedJobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadRuns takes selectedJobId as argument
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedRunId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLogContent('');
      return;
    }
    void loadLogs(selectedRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadLogs takes the run id as an argument
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRun?.piSessionId || !selectedRun.hasPersistedSession) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setSessionMessages([]);
      setIsLoadingSessionMessages(false);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    void loadSessionMessages(selectedRun.piSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSessionMessages takes the session id as an argument
  }, [selectedRun?.piSessionId, selectedRun?.hasPersistedSession, selectedRun?.status, selectedRun?.finishedAt]);

  useEffect(() => {
    if (!selectedJobId) return undefined;
    const interval = window.setInterval(() => {
      loadJobsEvent({ keepSelection: true });
      void loadRuns(selectedJobId, selectedRunId);
    }, 10_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ids cover the polling data dependencies
  }, [selectedJobId, selectedRunId]);

  async function handleSave() {
    setIsSaving(true);
    try {
      const payload = selectedJob?.jobType === 'webhook'
        ? {
            name: draft.name,
            prompt: draft.prompt,
            preferredSkill: draft.preferredSkill || 'auto',
            workspaceContextPaths: parseWorkspaceContext(draft.workspaceContextText),
            targetOutputPath: draft.targetOutputPath.trim() || null,
            status: draft.status,
          }
        : buildPayload(draft);
      const response = await fetch(draft.id ? `/api/automations/jobs/${draft.id}` : '/api/automations/jobs', {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || t('errors.saveJob'));

      const savedJob = result.data as AutomationJobRecord;
      toast.success(draft.id ? t('toasts.jobUpdated') : t('toasts.jobCreated'));
      setIsComposerOpen(false);
      setSelectedJobId(savedJob.id);
      setDraft(mapJobToDraft(savedJob));
      await loadJobs({ keepSelection: true });
      router.push(`/automationen/${savedJob.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.saveJob'));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCreateTriggerAutomation() {
    if (!selectedTriggerApp || !selectedTriggerType) return;
    if (!selectedTriggerApp.connected) {
      toast.error(t('triggers.errors.connectFirst'));
      return;
    }
    setIsSaving(true);
    try {
      const triggerConfig = buildTriggerConfigFromSchema(selectedTriggerType.configSchema, triggerDraft.configValues);
      const response = await fetch('/api/composio/triggers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: triggerDraft.name.trim(),
          prompt: triggerDraft.prompt.trim(),
          preferredSkill: triggerDraft.preferredSkill || 'auto',
          toolkitSlug: selectedTriggerApp.slug,
          triggerSlug: selectedTriggerType.slug,
          connectedAccountId: selectedTriggerApp.connectedAccountId || undefined,
          triggerConfig,
          workspaceContextPaths: parseWorkspaceContext(triggerDraft.workspaceContextText),
          targetOutputPath: triggerDraft.targetOutputPath.trim() || null,
          status: 'active',
        }),
      });
      const result = await readJsonResponse(response, 'Create Composio trigger');
      if (!response.ok || result.success === false) throw new Error(stringValue(result.error) || t('triggers.errors.create'));
      const data = asRecord(result.data);
      const savedJob = data.job as AutomationJobRecord;
      if (!savedJob?.id) throw new Error(t('triggers.errors.create'));
      toast.success(t('toasts.jobCreated'));
      setIsComposerOpen(false);
      setComposerMode('scheduled');
      setTriggerDraft(defaultTriggerDraft());
      setSelectedJobId(savedJob.id);
      setDraft(mapJobToDraft(savedJob));
      await loadJobs({ keepSelection: true });
      router.push(`/automationen/${savedJob.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('triggers.errors.create'));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleConnectTriggerApp(app: TriggerCapableApp) {
    setTriggerActionSlug(app.slug);
    try {
      const response = await fetch(`/api/composio/connect/${encodeURIComponent(app.slug)}`, {
        method: 'POST',
        credentials: 'include',
      });
      const payload = await readJsonResponse(response, 'Connect Composio app');
      if (!response.ok) throw new Error(stringValue(payload.error) || t('triggers.errors.connect'));
      const redirectUrl = stringValue(payload.redirectUrl);
      if (redirectUrl) {
        window.location.href = redirectUrl;
        return;
      }
      await loadTriggerApps();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('triggers.errors.connect'));
    } finally {
      setTriggerActionSlug(null);
    }
  }

  async function handleRunNow() {
    if (!selectedJobId) return;
    setIsRunningNow(true);
    try {
      const response = await fetch(`/api/automations/jobs/${selectedJobId}/run-now`, { method: 'POST', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.runNow'));
      const run = payload.data as AutomationRunRecord;
      toast.success(t('toasts.runQueued'));
      await loadJobs({ keepSelection: true });
      await loadRuns(selectedJobId, run.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.runNow'));
    } finally {
      setIsRunningNow(false);
    }
  }

  async function handleDelete() {
    if (!selectedJobId || !window.confirm(t('confirmDelete'))) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/automations/jobs/${selectedJobId}`, { method: 'DELETE', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.deleteJob'));
      toast.success(t('toasts.jobDeleted'));
      setSelectedJobId(null);
      setDraft(defaultDraft());
      setRuns([]);
      setSelectedRunId(null);
      setLogContent('');
      await loadJobs();
      router.push('/automationen');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.deleteJob'));
    } finally {
      setIsDeleting(false);
    }
  }

  function handleSelectJob(job: AutomationJobRecord) {
    setSelectedJobId(job.id);
    setDraft(mapJobToDraft(job));
    router.push(`/automationen/${job.id}`);
  }

  function handleNewAutomation() {
    setSelectedJobId(null);
    setRuns([]);
    setSelectedRunId(null);
    setLogContent('');
    setDraft(defaultDraft());
    setTriggerDraft(defaultTriggerDraft());
    setComposerMode('scheduled');
    setAppSearch('');
    setTriggerSearch('');
    setIsComposerOpen(true);
  }

  function applyTemplate(template: AutomationTemplate) {
    setDraft((current) => ({
      ...current,
      name: template.name,
      prompt: template.prompt,
      scheduleKind: template.scheduleKind,
      dailyTime: template.dailyTime || current.dailyTime,
      weeklyTime: template.weeklyTime || current.weeklyTime,
      weeklyDays: template.weeklyDays || current.weeklyDays,
      targetOutputPath: template.targetOutputPath || current.targetOutputPath,
    }));
  }

  function renderSkillSelect(id: string) {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">{t('editor.fields.preferredSkill')}</span>
        <select
          id={id}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={draft.preferredSkill}
          onChange={(event) => setDraft((current) => ({ ...current, preferredSkill: event.target.value }))}
        >
          <option value="auto">{t('skills.auto')}</option>
          {enabledSkills.map((skill) => (
            <option key={skill.name} value={skill.name}>/{skill.name}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{t('skills.description')}</span>
      </label>
    );
  }

  function renderTriggerSkillSelect(id: string) {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">{t('editor.fields.preferredSkill')}</span>
        <select
          id={id}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={triggerDraft.preferredSkill}
          onChange={(event) => setTriggerDraft((current) => ({ ...current, preferredSkill: event.target.value }))}
        >
          <option value="auto">{t('skills.auto')}</option>
          {enabledSkills.map((skill) => (
            <option key={skill.name} value={skill.name}>/{skill.name}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{t('skills.description')}</span>
      </label>
    );
  }

  function handleTriggerAppChange(toolkitSlug: string) {
    const app = triggerApps.find((candidate) => candidate.slug === toolkitSlug) || null;
    setTriggerDraft((current) => ({
      ...current,
      toolkitSlug,
      triggerSlug: '',
      name: current.name,
      configValues: {},
    }));
    setTriggerSearch('');
    if (app) void loadTriggerTypesForApp(app.slug);
  }

  function handleTriggerTypeChange(triggerSlug: string) {
    const trigger = selectedTriggerTypes.find((candidate) => candidate.slug === triggerSlug) || null;
    setTriggerDraft((current) => ({
      ...current,
      triggerSlug,
      name: selectedTriggerApp && trigger ? `${selectedTriggerApp.name}: ${trigger.name}` : current.name,
      configValues: {},
    }));
  }

  function openDirectoryPicker(target: 'scheduled' | 'trigger') {
    setDirectoryPickerTarget(target);
    setIsDirectoryPickerOpen(true);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:px-4 md:px-6 md:py-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <WandSparkles className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">{t('title')}</h1>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            {t('intro.prefix')}
            <span className="font-mono">automationen/</span>
            {t('intro.suffix')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => void loadJobs({ keepSelection: true })} aria-label={t('overview.refresh')}>
            <RefreshCw className={`h-4 w-4 ${isLoadingJobs ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={handleNewAutomation} data-testid="automation-new">
            <Plus className="mr-2 h-4 w-4" />
            {t('overview.newAutomation')}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <Card className="min-w-0 overflow-hidden xl:h-[calc(100vh-170px)]">
          <CardContent className="flex h-full min-h-0 flex-col gap-4 p-3 sm:p-4">
            <div className="flex items-center justify-between gap-3 border-b pb-3">
              <div>
                <p className="text-sm font-medium">{t('overview.title')}</p>
                <p className="text-xs text-muted-foreground">{jobs.length} {t('overview.total').toLowerCase()}</p>
              </div>
              {isLoadingJobs ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>
            <ScrollArea className="min-h-0 flex-1" data-testid="automation-job-list-scroll">
              <div className="space-y-5 pr-2" data-testid="automation-job-list">
                {isLoadingJobs && jobs.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('overview.loading')}
                  </div>
                ) : jobs.length === 0 ? (
                  <div className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">{t('overview.empty')}</div>
                ) : (
                  [
                    { key: 'needsAttention', label: t('overview.groups.needsAttention'), jobs: automationGroups.needsAttention, icon: AlertTriangle },
                    { key: 'running', label: t('overview.groups.running'), jobs: automationGroups.running, icon: Play },
                    { key: 'integration', label: t('overview.groups.integration'), jobs: automationGroups.integration, icon: Webhook },
                    { key: 'active', label: t('jobStatus.active'), jobs: automationGroups.active, icon: CheckCircle2 },
                    { key: 'paused', label: t('jobStatus.paused'), jobs: automationGroups.paused, icon: PauseCircle },
                  ].map((group) => {
                    if (group.jobs.length === 0) return null;
                    const GroupIcon = group.icon;

                    return (
                      <section key={group.key} className="space-y-2">
                        <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase text-muted-foreground">
                          <GroupIcon className="h-3.5 w-3.5" />
                          {group.label}
                        </div>
                        {group.jobs.map((job) => (
                          <button
                            key={job.id}
                            type="button"
                            className={`w-full min-w-0 rounded-md border p-3 text-left transition ${
                              selectedJobId === job.id ? 'border-primary bg-primary/5' : 'border-border bg-background hover:border-primary/40'
                            }`}
                            onClick={() => handleSelectJob(job)}
                            data-testid={`automation-job-${job.id}`}
                          >
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{job.name}</p>
                                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{job.prompt}</p>
                              </div>
                              <Badge variant={job.status === 'active' ? 'default' : 'secondary'} className="shrink-0">
                                {t(`jobStatus.${job.status}`)}
                              </Badge>
                            </div>
                            <div className="mt-3 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span className="inline-flex min-w-0 items-center gap-1">
                                <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{describeFriendlyScheduleLocalized(job.schedule, t, weekdayLabels)}</span>
                              </span>
                              <span className="truncate">{formatDateTime(job.nextRunAt, locale, t('scheduleSummary.notScheduled'))}</span>
                            </div>
                          </button>
                        ))}
                      </section>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
          <Card className="min-w-0 overflow-hidden">
            {selectedJob ? (
              <>
                <CardHeader className="border-b">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-xl">{selectedJob.name}</CardTitle>
                      <CardDescription className="mt-2">{t('editor.description')}</CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => void handleRunNow()} disabled={isRunningNow}>
                        {isRunningNow ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                        {t('actions.runNow')}
                      </Button>
                      <Button onClick={() => void handleSave()} disabled={isSaving} data-testid="automation-save">
                        {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        {t('actions.save')}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 p-4 sm:p-6">
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs text-muted-foreground">{t('editor.fields.name')}</span>
                      <input data-testid="automation-name" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs text-muted-foreground">{t('editor.fields.status')}</span>
                      <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as JobDraft['status'] }))}>
                        <option value="active">{t('jobStatus.active')}</option>
                        <option value="paused">{t('jobStatus.paused')}</option>
                      </select>
                    </label>
                  </div>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('editor.fields.prompt')}</span>
                    <textarea data-testid="automation-prompt" className="min-h-48 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm" value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} />
                  </label>
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs text-muted-foreground">{t('editor.fields.workspaceContext')}</span>
                      <textarea data-testid="automation-context-paths" className="h-24 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" value={draft.workspaceContextText} onChange={(event) => setDraft((current) => ({ ...current, workspaceContextText: event.target.value }))} placeholder="00_dashboard&#10;03_offer-and-sales" />
                    </label>
                    {renderSkillSelect('automation-preferred-skill')}
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{t('output.title')}</p>
                          <p className="text-xs text-muted-foreground">{t('output.description')}</p>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => openDirectoryPicker('scheduled')} data-testid="automation-target-output-picker">
                          <Folder className="mr-2 h-4 w-4" />
                          {t('output.pickInWorkspace')}
                        </Button>
                      </div>
                      <input data-testid="automation-target-output-path" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" value={draft.targetOutputPath} onChange={(event) => setDraft((current) => ({ ...current, targetOutputPath: event.target.value }))} placeholder={draftDefaultTargetOutputPath} />
                      <p className="break-all text-xs text-muted-foreground">{t('output.effectivePath')}: <span className="font-mono">{draftEffectiveTargetOutputPath}</span></p>
                    </div>
                  </div>
                  {selectedJob.jobType === 'webhook' ? (
                    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                      <div className="flex items-center gap-2">
                        <Webhook className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm font-medium">{t('triggers.detailTitle')}</p>
                      </div>
                      <div className="grid gap-2 text-xs sm:grid-cols-2">
                        <span className="text-muted-foreground">{t('triggers.fields.app')}</span>
                        <span className="font-mono">{selectedJob.composioToolkitSlug || t('noneYet')}</span>
                        <span className="text-muted-foreground">{t('triggers.fields.event')}</span>
                        <span className="font-mono">{selectedJob.composioTriggerSlug || t('noneYet')}</span>
                        <span className="text-muted-foreground">{t('triggers.fields.triggerId')}</span>
                        <span className="break-all font-mono">{selectedJob.composioTriggerId || t('noneYet')}</span>
                      </div>
                    </div>
                  ) : (
                    <ScheduleEditor draft={draft} setDraft={setDraft} t={t} weekdayLabels={weekdayLabels} />
                  )}
                  <div className="flex flex-wrap gap-2 border-t pt-4">
                    <Button variant="outline" onClick={handleDelete} disabled={isDeleting}>
                      {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                      {t('actions.delete')}
                    </Button>
                  </div>
                </CardContent>
              </>
            ) : (
              <CardContent className="flex min-h-[30rem] flex-col items-center justify-center gap-4 p-8 text-center">
                <Sparkles className="h-8 w-8 text-muted-foreground" />
                <div>
                  <p className="font-medium">{t('overview.emptySelectionTitle')}</p>
                  <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('overview.emptySelectionDescription')}</p>
                </div>
                <Button onClick={handleNewAutomation}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t('overview.newAutomation')}
                </Button>
              </CardContent>
            )}
          </Card>

          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="border-b">
              <CardTitle className="text-base">{t('runs.title')}</CardTitle>
              <CardDescription>{t('runs.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
              {selectedJob ? (
                <div className="grid grid-cols-[1fr_auto] gap-2 text-sm">
                  <span className="text-muted-foreground">{t('editor.fields.status')}</span>
                  <Badge variant={selectedJob.status === 'active' ? 'default' : 'secondary'}>{t(`jobStatus.${selectedJob.status}`)}</Badge>
                  <span className="text-muted-foreground">{t('overview.nextRun')}</span>
                  <span className="text-right text-xs">{formatDateTime(selectedJob.nextRunAt, locale, t('scheduleSummary.notScheduled'))}</span>
                  <span className="text-muted-foreground">{t('schedule.fields.kind')}</span>
                  <span className="max-w-[12rem] truncate text-right text-xs">{describeFriendlyScheduleLocalized(selectedJob.schedule, t, weekdayLabels)}</span>
                  <span className="text-muted-foreground">{t('results.title')}</span>
                  <span className="max-w-[12rem] truncate text-right font-mono text-xs">{selectedJob.effectiveTargetOutputPath}</span>
                </div>
              ) : null}
              <div className="space-y-2" data-testid="automation-run-list">
                {isRefreshingRuns && runs.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('runs.loading')}
                  </div>
                ) : !selectedJob || runs.length === 0 ? (
                  <div className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">{t('runs.empty')}</div>
                ) : (
                  runs.slice(0, 10).map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className={`w-full rounded-md border p-3 text-left transition ${selectedRunId === run.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}
                      onClick={() => {
                        setSelectedRunId(run.id);
                        setIsRunSheetOpen(true);
                      }}
                      data-testid={`automation-run-${run.id}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">{formatRunStatus(run.status, t)}</span>
                        <span className="text-xs text-muted-foreground">{formatDateTime(run.finishedAt || run.scheduledFor, locale, t('scheduleSummary.notScheduled'))}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{formatTriggerType(run.triggerType, t)} · {t('runs.attempt', { count: run.attemptNumber })}</p>
                      {run.errorMessage ? <p className="mt-2 line-clamp-2 text-xs text-destructive">{run.errorMessage}</p> : null}
                    </button>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={isComposerOpen} onOpenChange={setIsComposerOpen}>
        <DialogContent layout="viewport" className="mx-auto max-w-5xl">
          <DialogHeader className="shrink-0 border-b px-4 pt-5 pb-4 sm:px-6">
            <DialogTitle>{t('editor.newTitle')}</DialogTitle>
            <DialogDescription>{t('editor.description')}</DialogDescription>
          </DialogHeader>
          <Tabs value={composerMode} onValueChange={(value) => setComposerMode(value as ComposerMode)} className="min-h-0 flex-1 gap-0 overflow-hidden">
            <div className="border-b px-4 py-3 sm:px-6">
              <TabsList className="grid w-full grid-cols-2 sm:w-auto">
                <TabsTrigger value="scheduled"><Clock3 className="mr-2 h-4 w-4" />{t('composer.tabs.scheduled')}</TabsTrigger>
                <TabsTrigger value="trigger"><Webhook className="mr-2 h-4 w-4" />{t('composer.tabs.trigger')}</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="scheduled" className="m-0 min-h-0 flex-1 overflow-y-auto">
              <div className="grid min-h-0 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <div className="space-y-4">
                  <input data-testid="automation-name" className="h-11 w-full rounded-md border border-input bg-background px-3 text-base font-medium" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t('editor.placeholders.name')} />
                  <textarea data-testid="automation-prompt" className="min-h-[18rem] w-full resize-y rounded-md border border-input bg-background px-3 py-3 text-sm" value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder={t('editor.placeholders.prompt')} />
                  <ScheduleEditor draft={draft} setDraft={setDraft} t={t} weekdayLabels={weekdayLabels} compact />
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                    {renderSkillSelect('automation-composer-preferred-skill')}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <Button type="button" variant="outline" className="justify-start" onClick={() => openDirectoryPicker('scheduled')}>
                        <Folder className="mr-2 h-4 w-4" />
                        {t('output.pickInWorkspace')}
                      </Button>
                      <Button onClick={() => void handleSave()} disabled={isSaving}>
                        {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        {t('actions.save')}
                      </Button>
                    </div>
                  </div>
                  <p className="break-all text-xs text-muted-foreground">{t('output.effectivePath')}: <span className="font-mono">{draftEffectiveTargetOutputPath}</span></p>
                </div>
                <aside className="space-y-2">
                  <p className="text-sm font-medium">{t('templates.title')}</p>
                  {templates.map((template) => (
                    <button key={template.id} type="button" className="w-full rounded-md border bg-background p-3 text-left transition hover:border-primary/40 hover:bg-primary/5" onClick={() => applyTemplate(template)}>
                      <p className="text-sm font-medium">{template.name}</p>
                      <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{template.prompt}</p>
                    </button>
                  ))}
                </aside>
              </div>
            </TabsContent>
            <TabsContent value="trigger" className="m-0 min-h-0 flex-1 overflow-y-auto">
              <div className="grid min-h-0 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <div className="space-y-4">
                  {isLoadingTriggerApps ? (
                    <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-8 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('triggers.loadingApps')}
                    </div>
                  ) : triggerAppsError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{triggerAppsError}</div>
                  ) : composioStatus && (!composioStatus.configured || composioStatus.mode === 'disabled' || composioStatus.apiKeyValid === false) ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">{t('triggers.setupRequiredTitle')}</p>
                      <p className="mt-1">{t('triggers.setupRequiredDescription')}</p>
                      <Link href="/settings?tab=integrations" className="mt-3 inline-flex items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
                        <ExternalLink className="mr-2 h-4 w-4" />
                        {t('triggers.openIntegrations')}
                      </Link>
                    </div>
                  ) : triggerApps.length === 0 ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t('triggers.noApps')}</div>
                  ) : (
                    <>
                      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                        <section className="min-w-0 space-y-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-xs font-medium text-muted-foreground">{t('triggers.fields.app')}</span>
                            <span className="text-xs text-muted-foreground">{t('triggers.appCount', { count: triggerApps.length })}</span>
                          </div>
                          <label className="relative block">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <input
                              className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm"
                              value={appSearch}
                              onChange={(event) => setAppSearch(event.target.value)}
                              placeholder={t('triggers.placeholders.searchApps')}
                            />
                          </label>
                          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                            {filteredTriggerApps.length === 0 ? (
                              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t('triggers.noAppSearchResults')}</div>
                            ) : filteredTriggerApps.map((app) => (
                              <button
                                key={app.slug}
                                type="button"
                                onClick={() => handleTriggerAppChange(app.slug)}
                                className={cn(
                                  'flex w-full min-w-0 items-start gap-3 rounded-md border bg-background p-3 text-left transition hover:border-primary/40 hover:bg-primary/5',
                                  triggerDraft.toolkitSlug === app.slug && 'border-primary/60 bg-primary/5',
                                )}
                              >
                                <AppLogo app={app} />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium">{app.name}</span>
                                    {app.connected ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : null}
                                  </span>
                                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                    {app.triggerCount ? t('triggers.eventCount', { count: app.triggerCount }) : app.slug}
                                    {!app.connected ? ` · ${t('triggers.notConnected')}` : ''}
                                  </span>
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>

                        <section className="min-w-0 space-y-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-xs font-medium text-muted-foreground">{t('triggers.fields.event')}</span>
                            {selectedAppTriggerCountLabel ? <span className="text-xs text-muted-foreground">{selectedAppTriggerCountLabel}</span> : null}
                          </div>
                          <label className="relative block">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <input
                              className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm"
                              value={triggerSearch}
                              onChange={(event) => setTriggerSearch(event.target.value)}
                              placeholder={t('triggers.placeholders.searchEvents')}
                              disabled={!selectedTriggerApp}
                            />
                          </label>
                          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                            {!selectedTriggerApp ? (
                              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t('triggers.selectAppFirst')}</div>
                            ) : isLoadingSelectedTriggerTypes && !selectedTriggerAppHasLoadedTypes ? (
                              <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                {t('triggers.loadingEvents')}
                              </div>
                            ) : triggerTypesError ? (
                              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{triggerTypesError}</div>
                            ) : filteredTriggerTypes.length === 0 ? (
                              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t('triggers.noEventSearchResults')}</div>
                            ) : filteredTriggerTypes.map((trigger) => (
                              <button
                                key={trigger.slug}
                                type="button"
                                onClick={() => handleTriggerTypeChange(trigger.slug)}
                                className={cn(
                                  'w-full rounded-md border bg-background p-3 text-left transition hover:border-primary/40 hover:bg-primary/5',
                                  triggerDraft.triggerSlug === trigger.slug && 'border-primary/60 bg-primary/5',
                                )}
                              >
                                <span className="block text-sm font-medium">{trigger.name}</span>
                                <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{trigger.description || trigger.slug}</span>
                              </button>
                            ))}
                          </div>
                        </section>
                      </div>
                      {selectedTriggerApp && !selectedTriggerApp.connected ? (
                        <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-medium">{t('triggers.connectTitle', { app: selectedTriggerApp.name })}</p>
                            <p className="text-xs text-muted-foreground">{t('triggers.connectDescription')}</p>
                          </div>
                          <Button type="button" onClick={() => void handleConnectTriggerApp(selectedTriggerApp)} disabled={triggerActionSlug === selectedTriggerApp.slug}>
                            {triggerActionSlug === selectedTriggerApp.slug ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plug className="mr-2 h-4 w-4" />}
                            {t('triggers.connect')}
                          </Button>
                        </div>
                      ) : null}
                      {visibleSelectedTriggerType?.description ? <p className="text-xs text-muted-foreground">{visibleSelectedTriggerType.description}</p> : null}
                      <input className="h-11 w-full rounded-md border border-input bg-background px-3 text-base font-medium" value={triggerDraft.name} onChange={(event) => setTriggerDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t('triggers.placeholders.name')} />
                      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">{t('triggers.promptHintTitle')}</p>
                        <p className="mt-1">{t('triggers.promptHintDescription')}</p>
                      </div>
                      <textarea className="min-h-[14rem] w-full resize-y rounded-md border border-input bg-background px-3 py-3 text-sm" value={triggerDraft.prompt} onChange={(event) => setTriggerDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder={t('triggers.placeholders.prompt')} />
                      <TriggerConfigFields
                        schema={selectedTriggerType?.configSchema || null}
                        values={triggerDraft.configValues}
                        onChange={(key, value) => setTriggerDraft((current) => ({ ...current, configValues: { ...current.configValues, [key]: value } }))}
                        emptyLabel={t('triggers.noConfig')}
                      />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-xs text-muted-foreground">{t('editor.fields.workspaceContext')}</span>
                          <textarea className="h-24 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" value={triggerDraft.workspaceContextText} onChange={(event) => setTriggerDraft((current) => ({ ...current, workspaceContextText: event.target.value }))} placeholder="00_dashboard&#10;03_offer-and-sales" />
                        </label>
                        {renderTriggerSkillSelect('automation-trigger-preferred-skill')}
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                          <span className="text-xs text-muted-foreground">{t('triggers.fields.targetOutputPath')}</span>
                          <input className="h-10 rounded-md border border-input bg-background px-3 font-mono text-xs" value={triggerDraft.targetOutputPath} onChange={(event) => setTriggerDraft((current) => ({ ...current, targetOutputPath: event.target.value }))} placeholder={t('triggers.optional')} />
                        </label>
                        <Button type="button" variant="outline" className="justify-start" onClick={() => openDirectoryPicker('trigger')}>
                          <Folder className="mr-2 h-4 w-4" />
                          {t('output.pickInWorkspace')}
                        </Button>
                        <Button onClick={() => void handleCreateTriggerAutomation()} disabled={isSaving || !selectedTriggerApp?.connected || !triggerDraft.name.trim() || !triggerDraft.prompt.trim() || !triggerDraft.triggerSlug}>
                          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                          {t('triggers.create')}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
                <aside className="space-y-3">
                  <p className="text-sm font-medium">{t('triggers.sidebarTitle')}</p>
                  <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">{t('triggers.sidebarWebhookTitle')}</p>
                    <p className="mt-1">{t('triggers.sidebarWebhookDescription')}</p>
                  </div>
                  <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">{t('triggers.sidebarModesTitle')}</p>
                    <p className="mt-1">{t('triggers.sidebarModesDescription')}</p>
                  </div>
                </aside>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Sheet open={isRunSheetOpen} onOpenChange={setIsRunSheetOpen}>
        <SheetContent className="w-full sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{selectedRun ? formatRunStatus(selectedRun.status, t) : t('runs.title')}</SheetTitle>
            <SheetDescription>{selectedRun ? formatDateTime(selectedRun.finishedAt || selectedRun.scheduledFor, locale, t('scheduleSummary.notScheduled')) : t('runs.description')}</SheetDescription>
          </SheetHeader>
          <Tabs defaultValue="summary" className="min-h-0 flex-1 px-4 pb-4">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="summary"><FileText className="mr-2 h-4 w-4" />{t('runDetails.summary')}</TabsTrigger>
              <TabsTrigger value="logs"><Clock3 className="mr-2 h-4 w-4" />{t('logs.title')}</TabsTrigger>
              <TabsTrigger value="session"><MessageSquare className="mr-2 h-4 w-4" />{t('session.title')}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="mt-4 space-y-4">
              {getWebhookMetadata(selectedRun) ? (
                <div className="rounded-md border bg-muted/20 p-3 text-sm">
                  <p className="font-medium">{t('triggers.eventSummary')}</p>
                  <div className="mt-2 grid gap-1 text-xs">
                    <span className="text-muted-foreground">{String(getWebhookMetadata(selectedRun)?.toolkitSlug || '')} · {String(getWebhookMetadata(selectedRun)?.triggerSlug || '')}</span>
                    <span className="break-all font-mono text-muted-foreground">{String(getWebhookMetadata(selectedRun)?.eventId || '')}</span>
                  </div>
                </div>
              ) : null}
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                <p className="font-medium">{t('results.title')}</p>
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{selectedRun?.effectiveTargetOutputPath || selectedJob?.effectiveTargetOutputPath || t('noneYet')}</p>
              </div>
              {selectedRun?.resultPath ? (
                <Link href={toNotebookUrl(selectedRun.resultPath)} className="inline-flex items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {t('artifacts.openResultFile')}
                </Link>
              ) : null}
              {selectedRun?.piSessionId ? (
                <Link href={toChatUrl(selectedRun.piSessionId)} className="inline-flex items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
                  <MessageSquare className="mr-2 h-4 w-4" />
                  {t('session.openChat')}
                </Link>
              ) : null}
              {selectedRun?.errorMessage ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{selectedRun.errorMessage}</p> : null}
            </TabsContent>
            <TabsContent value="logs" className="mt-4">
              <ScrollArea className="h-[calc(100dvh-15rem)] rounded-md border bg-background" data-testid="automation-log-scroll">
                <pre className="min-h-full whitespace-pre-wrap p-3 text-xs" data-testid="automation-log-content">{logContent || t('logs.empty')}</pre>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="session" className="mt-4">
              {!selectedRun?.piSessionId ? (
                <p className="text-sm text-muted-foreground">{t('session.noSession')}</p>
              ) : !selectedRun.hasPersistedSession ? (
                <p className="text-sm text-muted-foreground">{t('session.pending')}</p>
              ) : isLoadingSessionMessages ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('session.loading')}
                </div>
              ) : sessionMessages.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('session.empty')}</p>
              ) : (
                <ScrollArea className="h-[calc(100dvh-15rem)] rounded-md border bg-background" data-testid="automation-session-scroll">
                  <div className="space-y-3 p-3">
                    {sessionMessages.map((message, index) => {
                      const content = extractAutomationSessionMessageText(message);
                      return (
                        <div key={message.id?.toString() || `${message.role}-${index}`} className="rounded-md border bg-muted/30 px-3 py-2" data-testid="automation-session-message">
                          <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">{formatAutomationSessionRole(message.role, t)}</p>
                          <p className="whitespace-pre-wrap break-words text-xs">{content || t('session.emptyMessage')}</p>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>

      <WorkspaceDirectoryPickerDialog
        open={isDirectoryPickerOpen}
        onOpenChange={setIsDirectoryPickerOpen}
        selectedPath={directoryPickerTarget === 'trigger' ? triggerDraft.targetOutputPath : draft.targetOutputPath}
        onSelect={(path) => {
          if (directoryPickerTarget === 'trigger') {
            setTriggerDraft((current) => ({ ...current, targetOutputPath: path }));
          } else {
            setDraft((current) => ({ ...current, targetOutputPath: path }));
          }
        }}
      />
    </div>
  );
}

function ScheduleEditor({
  draft,
  setDraft,
  t,
  weekdayLabels,
  compact = false,
}: {
  draft: JobDraft;
  setDraft: Dispatch<SetStateAction<JobDraft>>;
  t: (key: string, values?: Record<string, string | number>) => string;
  weekdayLabels: Record<AutomationWeekday, string>;
  compact?: boolean;
}) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <Clock3 className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-medium">{t('schedule.title')}</p>
      </div>
      <div className={`grid gap-4 ${compact ? 'sm:grid-cols-3' : 'md:grid-cols-3'}`}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t('schedule.fields.kind')}</span>
          <select data-testid="automation-schedule-kind" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.scheduleKind} onChange={(event) => setDraft((current) => ({ ...current, scheduleKind: event.target.value as ScheduleKind }))}>
            <option value="once">{t('schedule.kind.once')}</option>
            <option value="daily">{t('schedule.kind.daily')}</option>
            <option value="weekly">{t('schedule.kind.weekly')}</option>
            <option value="interval">{t('schedule.kind.interval')}</option>
          </select>
        </label>
        {draft.scheduleKind === 'once' ? (
          <>
            <label className="flex flex-col gap-1 text-sm"><span className="text-xs text-muted-foreground">{t('schedule.fields.date')}</span><input type="date" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.onceDate} onChange={(event) => setDraft((current) => ({ ...current, onceDate: event.target.value }))} /></label>
            <label className="flex flex-col gap-1 text-sm"><span className="text-xs text-muted-foreground">{t('schedule.fields.time')}</span><input type="time" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.onceTime} onChange={(event) => setDraft((current) => ({ ...current, onceTime: event.target.value }))} /></label>
          </>
        ) : null}
        {draft.scheduleKind === 'daily' ? (
          <label className="flex flex-col gap-1 text-sm"><span className="text-xs text-muted-foreground">{t('schedule.fields.time')}</span><input type="time" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.dailyTime} onChange={(event) => setDraft((current) => ({ ...current, dailyTime: event.target.value }))} /></label>
        ) : null}
        {draft.scheduleKind === 'interval' ? (
          <>
            <label className="flex flex-col gap-1 text-sm"><span className="text-xs text-muted-foreground">{t('schedule.fields.intervalEvery')}</span><input type="number" min="1" data-testid="automation-interval-every" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.intervalEvery} onChange={(event) => setDraft((current) => ({ ...current, intervalEvery: event.target.value }))} /></label>
            <label className="flex flex-col gap-1 text-sm"><span className="text-xs text-muted-foreground">{t('schedule.fields.intervalUnit')}</span><select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.intervalUnit} onChange={(event) => setDraft((current) => ({ ...current, intervalUnit: event.target.value as JobDraft['intervalUnit'] }))}><option value="minutes">{t('intervalUnits.minutes')}</option><option value="hours">{t('intervalUnits.hours')}</option><option value="days">{t('intervalUnits.days')}</option></select></label>
          </>
        ) : null}
      </div>
      {draft.scheduleKind === 'weekly' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap">
            {WEEKDAY_OPTIONS.map((day) => {
              const selected = draft.weeklyDays.includes(day);
              return (
                <button key={day} type="button" className={`min-h-10 rounded-md border px-3 py-2 text-sm ${selected ? 'border-primary bg-primary/10' : 'border-border bg-background'}`} onClick={() => setDraft((current) => ({ ...current, weeklyDays: current.weeklyDays.includes(day) ? current.weeklyDays.filter((entry) => entry !== day) : [...current.weeklyDays, day] }))}>
                  {weekdayLabels[day]}
                </button>
              );
            })}
          </div>
          <label className="flex max-w-xs flex-col gap-1 text-sm"><span className="text-xs text-muted-foreground">{t('schedule.fields.time')}</span><input type="time" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.weeklyTime} onChange={(event) => setDraft((current) => ({ ...current, weeklyTime: event.target.value }))} /></label>
        </div>
      ) : null}
    </div>
  );
}

function TriggerConfigFields({
  schema,
  values,
  onChange,
  emptyLabel,
}: {
  schema: Record<string, unknown> | null;
  values: Record<string, string | boolean>;
  onChange: (key: string, value: string | boolean) => void;
  emptyLabel: string;
}) {
  const fields = getSchemaProperties(schema);
  if (fields.length === 0) {
    return <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const value = values[field.key];
          if (field.type === 'boolean') {
            return (
              <label key={field.key} className="flex min-h-10 items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(event) => onChange(field.key, event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block truncate">{field.label}{field.required ? ' *' : ''}</span>
                  {field.description ? <span className="block text-xs text-muted-foreground">{field.description}</span> : null}
                </span>
              </label>
            );
          }

          return (
            <label key={field.key} className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{field.label}{field.required ? ' *' : ''}</span>
              {field.enumValues.length > 0 ? (
                <select
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => onChange(field.key, event.target.value)}
                >
                  <option value="" />
                  {field.enumValues.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              ) : (
                <input
                  type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => onChange(field.key, event.target.value)}
                />
              )}
              {field.description ? <span className="text-xs text-muted-foreground">{field.description}</span> : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}
