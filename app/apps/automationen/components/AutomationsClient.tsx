'use client';

import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Clock3, Loader2, PauseCircle, Play, Plus, RefreshCw, Save, Trash2, WandSparkles } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { getDefaultAutomationTargetOutputPath, getEffectiveAutomationTargetOutputPath } from '@/app/lib/automations/paths';
import type {
  AutomationJobRecord,
  AutomationRunRecord,
  AutomationRunStatus,
  AutomationTriggerType,
  AutomationWeekday,
  FriendlySchedule,
} from '@/app/lib/automations/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { WorkspaceDirectoryPickerDialog } from '@/app/apps/automationen/components/WorkspaceDirectoryPickerDialog';

type ScheduleKind = 'once' | 'daily' | 'weekly' | 'interval';

type JobDraft = {
  id: string | null;
  name: string;
  prompt: string;
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

const WEEKDAY_OPTIONS: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function defaultDraft(): JobDraft {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  return {
    id: null,
    name: '',
    prompt: '',
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

function parseWorkspaceContext(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function buildPayload(draft: JobDraft) {
  const schedule =
    draft.scheduleKind === 'once'
      ? { kind: 'once' as const, date: draft.onceDate, time: draft.onceTime, timeZone: draft.timeZone }
      : draft.scheduleKind === 'daily'
        ? { kind: 'daily' as const, time: draft.dailyTime, timeZone: draft.timeZone }
        : draft.scheduleKind === 'weekly'
          ? { kind: 'weekly' as const, days: draft.weeklyDays, time: draft.weeklyTime, timeZone: draft.timeZone }
          : {
              kind: 'interval' as const,
              every: Number(draft.intervalEvery || '1'),
              unit: draft.intervalUnit,
              timeZone: draft.timeZone,
            };

  return {
    name: draft.name,
    prompt: draft.prompt,
    workspaceContextPaths: parseWorkspaceContext(draft.workspaceContextText),
    targetOutputPath: draft.targetOutputPath.trim() || null,
    status: draft.status,
    schedule,
  };
}

function formatDateTime(value: string | null, locale: string, emptyLabel: string): string {
  if (!value) return emptyLabel;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function describeFriendlyScheduleLocalized(
  schedule: FriendlySchedule,
  translate: (key: string, values?: Record<string, string | number>) => string,
  weekdayLabels: Record<AutomationWeekday, string>,
): string {
  if (schedule.kind === 'once') {
    return translate('scheduleSummary.once', { date: schedule.date, time: schedule.time });
  }

  if (schedule.kind === 'daily') {
    return translate('scheduleSummary.daily', { time: schedule.time });
  }

  if (schedule.kind === 'weekly') {
    return translate('scheduleSummary.weekly', {
      days: schedule.days.map((day) => weekdayLabels[day]).join(', '),
      time: schedule.time,
    });
  }

  return translate('scheduleSummary.interval', {
    every: schedule.every,
    unit: translate(`intervalUnits.${schedule.unit}`),
  });
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
  if (typeof message.content === 'string') {
    return message.content.trim();
  }

  if (Array.isArray(message.content)) {
    const text = message.content
      .filter(isTextContentPart)
      .map((part) => part.text)
      .join('\n\n')
      .trim();

    if (text) {
      return text;
    }
  }

  if (message.errorMessage?.trim()) {
    return message.errorMessage.trim();
  }

  if (message.role === 'toolResult') {
    return '[Tool result]';
  }

  if (message.role === 'compact-break') {
    return '[Conversation compacted]';
  }

  return '';
}

function formatAutomationSessionRole(
  role: string,
  translate: (key: string) => string,
): string {
  if (role === 'user' || role === 'assistant' || role === 'toolResult') {
    return translate(`session.roles.${role}`);
  }

  if (role === 'compact-break') {
    return translate('session.roles.system');
  }

  return role;
}

function mapJobToDraft(job: AutomationJobRecord): JobDraft {
  const draft = defaultDraft();
  draft.id = job.id;
  draft.name = job.name;
  draft.prompt = job.prompt;
  draft.workspaceContextText = job.workspaceContextPaths.join('\n');
  draft.targetOutputPath = job.targetOutputPath || '';
  draft.status = job.status;
  draft.scheduleKind = job.schedule.kind;
  draft.timeZone = job.timeZone;

  if (job.schedule.kind === 'once') {
    draft.onceDate = job.schedule.date;
    draft.onceTime = job.schedule.time;
  } else if (job.schedule.kind === 'daily') {
    draft.dailyTime = job.schedule.time;
  } else if (job.schedule.kind === 'weekly') {
    draft.weeklyTime = job.schedule.time;
    draft.weeklyDays = job.schedule.days;
  } else {
    draft.intervalEvery = String(job.schedule.every);
    draft.intervalUnit = job.schedule.unit;
  }

  return draft;
}

export function AutomationsClient() {
  const t = useTranslations('automationen');
  const locale = useLocale();
  const [jobs, setJobs] = useState<AutomationJobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<JobDraft>(() => defaultDraft());
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const [sessionMessages, setSessionMessages] = useState<PersistedAutomationSessionMessage[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningNow, setIsRunningNow] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRefreshingRuns, setIsRefreshingRuns] = useState(false);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isDirectoryPickerOpen, setIsDirectoryPickerOpen] = useState(false);
  const [isLogSectionOpen, setIsLogSectionOpen] = useState(false);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) || null,
    [jobs, selectedJobId],
  );

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) || null,
    [runs, selectedRunId],
  );

  const automationStats = useMemo(
    () => {
      const activeCount = jobs.filter((job) => job.status === 'active').length;
      const pausedCount = jobs.length - activeCount;
      const successfulCount = jobs.filter((job) => job.lastRunStatus === 'success').length;

      return { activeCount, pausedCount, successfulCount, totalCount: jobs.length };
    },
    [jobs],
  );

  const draftDefaultTargetOutputPath = useMemo(
    () => getDefaultAutomationTargetOutputPath(draft.name || 'automation'),
    [draft.name],
  );

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
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.loadJobs'));
      }

      const nextJobs = payload.data as AutomationJobRecord[];
      setJobs(nextJobs);

      if (!options?.keepSelection) {
        const nextSelected = nextJobs[0] || null;
        setSelectedJobId(nextSelected?.id || null);
        setDraft((current) => {
          if (nextSelected) {
            return mapJobToDraft(nextSelected);
          }

          if (current.name || current.prompt || current.workspaceContextText) {
            return current;
          }

          return defaultDraft();
        });
      } else if (selectedJobId) {
        const nextSelected = nextJobs.find((job) => job.id === selectedJobId);
        if (nextSelected) {
          setDraft(mapJobToDraft(nextSelected));
        }
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
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.loadRuns'));
      }

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
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.loadLogs'));
      }
      setLogContent(payload.data.content || '');
    } catch (error) {
      setLogContent('');
      toast.error(error instanceof Error ? error.message : t('errors.loadLogs'));
    }
  }

  async function loadSessionMessages(sessionId: string) {
    setIsLoadingSessionMessages(true);
    try {
      const response = await fetch(`/api/sessions/messages?sessionId=${encodeURIComponent(sessionId)}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.loadSession'));
      }

      setSessionMessages(Array.isArray(payload.messages) ? (payload.messages as PersistedAutomationSessionMessage[]) : []);
    } catch (error) {
      setSessionMessages([]);
      toast.error(error instanceof Error ? error.message : t('errors.loadSession'));
    } finally {
      setIsLoadingSessionMessages(false);
    }
  }

  useEffect(() => {
    loadJobsEvent();
  }, []);

  useEffect(() => {
    if (!selectedJobId) {
      setRuns([]);
      setSelectedRunId(null);
      setLogContent('');
      return;
    }
    void loadRuns(selectedJobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadRuns takes selectedJobId as argument
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedRunId) {
      setLogContent('');
      return;
    }
    void loadLogs(selectedRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadLogs takes selectedRunId as argument
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRun?.piSessionId || !selectedRun.hasPersistedSession) {
      setSessionMessages([]);
      setIsLoadingSessionMessages(false);
      return;
    }

    void loadSessionMessages(selectedRun.piSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSessionMessages takes the session id as an argument
  }, [selectedRun?.piSessionId, selectedRun?.hasPersistedSession, selectedRun?.status, selectedRun?.finishedAt]);

  useEffect(() => {
    if (!selectedJobId) return undefined;
    // Poll the currently selected automation and its runs.
    const interval = window.setInterval(() => {
      loadJobsEvent({ keepSelection: true });
      void loadRuns(selectedJobId, selectedRunId);
    }, 10_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load fns are plain functions; ids cover the data deps
  }, [selectedJobId, selectedRunId]);

  async function handleSave() {
    setIsSaving(true);
    try {
      const payload = buildPayload(draft);
      const response = await fetch(
        draft.id ? `/api/automations/jobs/${draft.id}` : '/api/automations/jobs',
        {
          method: draft.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        },
      );
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || t('errors.saveJob'));
      }

      const savedJob = result.data as AutomationJobRecord;
      toast.success(draft.id ? t('toasts.jobUpdated') : t('toasts.jobCreated'));
      setSelectedJobId(savedJob.id);
      setDraft(mapJobToDraft(savedJob));
      await loadJobs({ keepSelection: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.saveJob'));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRunNow() {
    if (!selectedJobId) return;
    setIsRunningNow(true);
    try {
      const response = await fetch(`/api/automations/jobs/${selectedJobId}/run-now`, {
        method: 'POST',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.runNow'));
      }
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
      const response = await fetch(`/api/automations/jobs/${selectedJobId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.deleteJob'));
      }
      toast.success(t('toasts.jobDeleted'));
      setSelectedJobId(null);
      setDraft(defaultDraft());
      setRuns([]);
      setSelectedRunId(null);
      setLogContent('');
      await loadJobs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.deleteJob'));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:px-4 md:px-6 md:py-6">
      <Card className="overflow-hidden">
        <CardHeader className="gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-xl">
                <WandSparkles className="h-5 w-5 shrink-0" />
                {t('title')}
              </CardTitle>
              <CardDescription className="mt-2 max-w-3xl">
                {t('intro.prefix')}
                <span className="font-mono">automationen/</span>
                {t('intro.suffix')}
              </CardDescription>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[420px]">
              <div className="rounded-md border bg-muted/20 px-3 py-2">
                <p className="text-[11px] font-medium uppercase text-muted-foreground">{t('overview.total')}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{automationStats.totalCount}</p>
              </div>
              <div className="rounded-md border bg-emerald-500/5 px-3 py-2">
                <p className="text-[11px] font-medium uppercase text-emerald-700">{t('jobStatus.active')}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{automationStats.activeCount}</p>
              </div>
              <div className="rounded-md border bg-muted/20 px-3 py-2">
                <p className="text-[11px] font-medium uppercase text-muted-foreground">{t('jobStatus.paused')}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{automationStats.pausedCount}</p>
              </div>
              <div className="rounded-md border bg-primary/5 px-3 py-2">
                <p className="text-[11px] font-medium uppercase text-primary">{t('overview.successful')}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{automationStats.successfulCount}</p>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)_minmax(0,380px)]">
        <Card className="min-w-0 overflow-hidden xl:flex xl:h-[calc(100vh-220px)] xl:max-h-[calc(100vh-220px)] xl:flex-col">
          <CardHeader className="border-b pb-4">
            <CardTitle className="text-base">{t('overview.title')}</CardTitle>
            <CardDescription>{t('overview.description')}</CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-[34rem] min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden p-3 sm:max-h-[38rem] sm:p-6 xl:max-h-none">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setSelectedJobId(null);
                  setDraft(defaultDraft());
                  setRuns([]);
                  setSelectedRunId(null);
                  setLogContent('');
                }}
                data-testid="automation-new"
              >
                <Plus className="mr-2 h-4 w-4" />
                {t('overview.newAutomation')}
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void loadJobs({ keepSelection: true })}
                aria-label={t('overview.refresh')}
                title={t('overview.refresh')}
              >
                <RefreshCw className={`h-4 w-4 ${isLoadingJobs ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            <div
              className="flex-1 overflow-y-auto pr-1 xl:pr-2"
              data-testid="automation-job-list-scroll"
            >
              <div className="min-w-0 space-y-2 overflow-x-hidden pr-1" data-testid="automation-job-list">
                {isLoadingJobs && jobs.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('overview.loading')}
                  </div>
                ) : jobs.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                    {t('overview.empty')}
                  </div>
                ) : (
                  jobs.map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      className={`w-full min-w-0 overflow-hidden rounded-lg border p-3 text-left transition ${
                        selectedJobId === job.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                      }`}
                      onClick={() => {
                        setSelectedJobId(job.id);
                        setDraft(mapJobToDraft(job));
                      }}
                      data-testid={`automation-job-${job.id}`}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="break-words font-medium">{job.name}</p>
                          <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{job.prompt}</p>
                        </div>
                        <span
                          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold uppercase ${
                            job.status === 'active' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {job.status === 'active' ? <CheckCircle2 className="h-3 w-3" /> : <PauseCircle className="h-3 w-3" />}
                          {t(`jobStatus.${job.status}`)}
                        </span>
                      </div>
                      <div className="mt-3 min-w-0 space-y-1 text-xs text-muted-foreground">
                        <p className="break-words">{describeFriendlyScheduleLocalized(job.schedule, t, weekdayLabels)}</p>
                        <p className="break-words">{t('overview.nextRun')}: {formatDateTime(job.nextRunAt, locale, t('scheduleSummary.notScheduled'))}</p>
                        <p>{t('overview.lastStatus')}: {job.lastRunStatus ? formatRunStatus(job.lastRunStatus, t) : t('noneYet')}</p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden xl:flex xl:h-[calc(100vh-220px)] xl:max-h-[calc(100vh-220px)] xl:flex-col">
          <CardHeader className="border-b pb-4">
            <CardTitle className="text-base">{draft.id ? t('editor.editTitle') : t('editor.newTitle')}</CardTitle>
            <CardDescription>{t('editor.description')}</CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 flex-1 space-y-4 overflow-y-auto p-3 sm:p-6">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('editor.fields.name')}</span>
                <input
                  data-testid="automation-name"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder={t('editor.placeholders.name')}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('editor.fields.status')}</span>
                <select
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.status}
                  onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as JobDraft['status'] }))}
                >
                  <option value="active">{t('jobStatus.active')}</option>
                  <option value="paused">{t('jobStatus.paused')}</option>
                </select>
              </label>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('editor.fields.prompt')}</span>
              <textarea
                data-testid="automation-prompt"
                className="h-40 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm sm:h-44"
                value={draft.prompt}
                onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
                placeholder={t('editor.placeholders.prompt')}
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('editor.fields.timeZone')}</span>
                <input
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.timeZone}
                  onChange={(event) => setDraft((current) => ({ ...current, timeZone: event.target.value }))}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('editor.fields.workspaceContext')}</span>
              <textarea
                data-testid="automation-context-paths"
                className="h-28 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                value={draft.workspaceContextText}
                onChange={(event) => setDraft((current) => ({ ...current, workspaceContextText: event.target.value }))}
                placeholder={'notizen/weekly.md\nbriefings/launch/'}
              />
            </label>

            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3 sm:p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('output.title')}</p>
                  <p className="text-xs text-muted-foreground">{t('output.description')}</p>
                </div>
                <div className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:flex">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsDirectoryPickerOpen(true)}
                    data-testid="automation-target-output-picker"
                  >
                    {t('output.pickInWorkspace')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft((current) => ({ ...current, targetOutputPath: '' }))}
                  >
                    {t('output.useDefault')}
                  </Button>
                </div>
              </div>

              <textarea
                data-testid="automation-target-output-path"
                className="h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-3 font-mono text-sm"
                value={draft.targetOutputPath}
                onChange={(event) => setDraft((current) => ({ ...current, targetOutputPath: event.target.value }))}
                placeholder={draftDefaultTargetOutputPath}
              />
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-md border border-dashed border-border bg-background/70 p-3">
                  <p className="text-xs font-medium text-foreground">{t('output.suggestedPath')}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{draftDefaultTargetOutputPath}</p>
                </div>
                <div className="rounded-md border border-dashed border-border bg-background/70 p-3">
                  <p className="text-xs font-medium text-foreground">{t('output.effectivePath')}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{draftEffectiveTargetOutputPath}</p>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3 sm:p-4">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">{t('schedule.title')}</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">{t('schedule.fields.kind')}</span>
                  <select
                    data-testid="automation-schedule-kind"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={draft.scheduleKind}
                    onChange={(event) => setDraft((current) => ({ ...current, scheduleKind: event.target.value as ScheduleKind }))}
                  >
                    <option value="once">{t('schedule.kind.once')}</option>
                    <option value="daily">{t('schedule.kind.daily')}</option>
                    <option value="weekly">{t('schedule.kind.weekly')}</option>
                    <option value="interval">{t('schedule.kind.interval')}</option>
                  </select>
                </label>
              </div>

              {draft.scheduleKind === 'once' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('schedule.fields.date')}</span>
                    <input
                      type="date"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={draft.onceDate}
                      onChange={(event) => setDraft((current) => ({ ...current, onceDate: event.target.value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('schedule.fields.time')}</span>
                    <input
                      type="time"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={draft.onceTime}
                      onChange={(event) => setDraft((current) => ({ ...current, onceTime: event.target.value }))}
                    />
                  </label>
                </div>
              )}

              {draft.scheduleKind === 'daily' && (
                <label className="flex flex-col gap-1 text-sm md:max-w-xs">
                  <span className="text-xs text-muted-foreground">{t('schedule.fields.time')}</span>
                  <input
                    type="time"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={draft.dailyTime}
                    onChange={(event) => setDraft((current) => ({ ...current, dailyTime: event.target.value }))}
                  />
                </label>
              )}

              {draft.scheduleKind === 'weekly' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap">
                    {WEEKDAY_OPTIONS.map((day) => {
                      const selected = draft.weeklyDays.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          className={`min-h-10 rounded-md border px-2 py-2 text-sm ${selected ? 'border-primary bg-primary/10' : 'border-border bg-background'}`}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              weeklyDays: current.weeklyDays.includes(day)
                                ? current.weeklyDays.filter((entry) => entry !== day)
                                : [...current.weeklyDays, day],
                            }))
                          }
                        >
                          {weekdayLabels[day]}
                        </button>
                      );
                    })}
                  </div>
                  <label className="flex flex-col gap-1 text-sm md:max-w-xs">
                    <span className="text-xs text-muted-foreground">{t('schedule.fields.time')}</span>
                    <input
                      type="time"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={draft.weeklyTime}
                      onChange={(event) => setDraft((current) => ({ ...current, weeklyTime: event.target.value }))}
                    />
                  </label>
                </div>
              )}

              {draft.scheduleKind === 'interval' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('schedule.fields.intervalEvery')}</span>
                    <input
                      type="number"
                      min="1"
                      data-testid="automation-interval-every"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={draft.intervalEvery}
                      onChange={(event) => setDraft((current) => ({ ...current, intervalEvery: event.target.value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('schedule.fields.intervalUnit')}</span>
                    <select
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={draft.intervalUnit}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, intervalUnit: event.target.value as JobDraft['intervalUnit'] }))
                      }
                    >
                      <option value="minutes">{t('intervalUnits.minutes')}</option>
                      <option value="hours">{t('intervalUnits.hours')}</option>
                      <option value="days">{t('intervalUnits.days')}</option>
                    </select>
                  </label>
                </div>
              )}
            </div>

            <div className="sticky bottom-0 z-20 -mx-3 grid grid-cols-3 gap-2 border-t bg-background/95 p-3 shadow-lg backdrop-blur sm:static sm:mx-0 sm:flex sm:flex-wrap sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-0">
              <Button className="min-w-0" onClick={() => void handleSave()} disabled={isSaving} data-testid="automation-save">
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                <span className="truncate">{t('actions.save')}</span>
              </Button>
              <Button className="min-w-0" variant="secondary" onClick={() => void handleRunNow()} disabled={!selectedJobId || isRunningNow} data-testid="automation-run-now">
                {isRunningNow ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                <span className="truncate">{t('actions.runNow')}</span>
              </Button>
              <Button className="min-w-0" variant="outline" onClick={handleDelete} disabled={!selectedJobId || isDeleting}>
                {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                <span className="truncate">{t('actions.delete')}</span>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden xl:flex xl:h-[calc(100vh-220px)] xl:max-h-[calc(100vh-220px)] xl:flex-col">
          <CardHeader className="border-b pb-4">
            <CardTitle className="text-base">{t('runs.title')}</CardTitle>
            <CardDescription>{t('runs.description')}</CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 flex-1 space-y-4 overflow-y-auto p-3 sm:p-6">
            <div className="max-h-80 space-y-2 overflow-y-auto pr-1 xl:max-h-64" data-testid="automation-run-list">
              {isRefreshingRuns && runs.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('runs.loading')}
                </div>
              ) : runs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                  {t('runs.empty')}
                </div>
              ) : (
                runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      selectedRunId === run.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                    }`}
                    onClick={() => setSelectedRunId(run.id)}
                    data-testid={`automation-run-${run.id}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="break-words font-medium">{formatRunStatus(run.status, t)}</span>
                      <span className="text-xs text-muted-foreground">{t('runs.attempt', { count: run.attemptNumber })}</span>
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      <p className="break-words">{t('runs.triggeredBy')}: {formatTriggerType(run.triggerType, t)}</p>
                      <p className="break-words">{t('runs.scheduledFor')}: {formatDateTime(run.scheduledFor, locale, t('scheduleSummary.notScheduled'))}</p>
                      <p className="break-words">{t('runs.finishedAt')}: {formatDateTime(run.finishedAt, locale, t('scheduleSummary.notScheduled'))}</p>
                      {run.errorMessage ? <p className="line-clamp-3 break-words text-destructive">{run.errorMessage}</p> : null}
                    </div>
                  </button>
                ))
              )}
            </div>

            <Collapsible
              open={isLogSectionOpen}
              onOpenChange={setIsLogSectionOpen}
              className="rounded-md border border-border bg-muted/20 p-3 sm:p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{t('logs.title')}</p>
                  <p className="text-xs text-muted-foreground">{t('logs.description')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {selectedRun?.logPath ? (
                    <Link
                      href={toNotebookUrl(selectedRun.logPath)}
                      data-testid="automation-log-open"
                      className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t('logs.openLogFile')}
                    </Link>
                  ) : null}
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      data-testid="automation-log-toggle"
                    >
                      {isLogSectionOpen ? t('logs.collapse') : t('logs.expand')}
                      <ChevronDown className={`ml-1 h-4 w-4 transition-transform ${isLogSectionOpen ? 'rotate-180' : ''}`} />
                    </Button>
                  </CollapsibleTrigger>
                </div>
              </div>
              <CollapsibleContent className="pt-3" data-testid="automation-log-collapsible">
                <ScrollArea className="h-[260px] rounded-md border border-border bg-background" data-testid="automation-log-scroll">
                  <pre
                    className="min-h-full p-3 text-xs text-foreground"
                    data-testid="automation-log-content"
                  >
                    {logContent || t('logs.empty')}
                  </pre>
                </ScrollArea>
              </CollapsibleContent>
            </Collapsible>

            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-sm sm:p-4">
              <p className="font-medium">{t('results.title')}</p>
              <p className="break-all font-mono text-xs text-muted-foreground" data-testid="automation-result-folder">
                {selectedRun?.effectiveTargetOutputPath || selectedJob?.effectiveTargetOutputPath || t('noneYet')}
              </p>
              {selectedRun?.targetOutputPath ? (
                <p className="text-xs text-muted-foreground">
                  {t('results.configured')}: <span className="font-mono">{selectedRun.targetOutputPath}</span>
                </p>
              ) : selectedJob ? (
                <p className="text-xs text-muted-foreground">
                  {t('results.default')}: <span className="font-mono">{selectedJob.effectiveTargetOutputPath}</span>
                </p>
              ) : null}
            </div>

            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-sm sm:p-4">
              <p className="font-medium">{t('artifacts.title')}</p>
              <p className="break-all font-mono text-xs text-muted-foreground" data-testid="automation-artifact-folder">
                {selectedRun?.outputDir || t('noneYet')}
              </p>
              {selectedRun?.resultPath ? (
                <Link
                  href={toNotebookUrl(selectedRun.resultPath)}
                  data-testid="automation-result-open"
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  {t('artifacts.openResultFile')}
                </Link>
              ) : null}
              {selectedRun?.piSessionId ? (
                <div className="space-y-2">
                  <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                    {t('artifacts.piSession')}: {selectedRun.piSessionTitle || selectedRun.piSessionId}
                  </p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{selectedRun.piSessionId}</p>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={toChatUrl(selectedRun.piSessionId)}
                      data-testid="automation-open-chat-session"
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t('session.openChat')}
                    </Link>
                    <Link
                      href={toChatUrl(selectedRun.piSessionId)}
                      data-testid="automation-continue-chat-session"
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t('session.continueChat')}
                    </Link>
                  </div>
                  {!selectedRun.hasPersistedSession ? (
                    <p className="text-xs text-muted-foreground" data-testid="automation-session-pending">
                      {t('session.pending')}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3 text-sm sm:p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-medium">{t('session.title')}</p>
                  <p className="text-xs text-muted-foreground">{t('session.description')}</p>
                </div>
                {selectedRun?.piSessionId ? (
                  <Link
                    href={toChatUrl(selectedRun.piSessionId)}
                    className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('session.openChat')}
                  </Link>
                ) : null}
              </div>

              {!selectedRun?.piSessionId ? (
                <p className="text-xs text-muted-foreground" data-testid="automation-session-empty">
                  {t('session.noSession')}
                </p>
              ) : !selectedRun.hasPersistedSession ? (
                <p className="text-xs text-muted-foreground" data-testid="automation-session-not-persisted">
                  {t('session.pending')}
                </p>
              ) : isLoadingSessionMessages ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('session.loading')}
                </div>
              ) : sessionMessages.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="automation-session-no-messages">
                  {t('session.empty')}
                </p>
              ) : (
                <ScrollArea className="h-[260px] rounded-md border border-border bg-background" data-testid="automation-session-scroll">
                  <div className="space-y-3 p-3">
                    {sessionMessages.map((message, index) => {
                      const content = extractAutomationSessionMessageText(message);

                      return (
                        <div
                          key={message.id?.toString() || `${message.role}-${index}`}
                          className={`rounded-md border px-3 py-2 ${
                            message.role === 'user'
                              ? 'border-primary/30 bg-primary/5'
                              : message.role === 'assistant'
                                ? 'border-border bg-muted/40'
                                : 'border-dashed border-border bg-background'
                          }`}
                          data-testid="automation-session-message"
                        >
                          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                            {formatAutomationSessionRole(message.role, t)}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                            {content || t('session.emptyMessage')}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <WorkspaceDirectoryPickerDialog
        open={isDirectoryPickerOpen}
        onOpenChange={setIsDirectoryPickerOpen}
        selectedPath={draft.targetOutputPath}
        onSelect={(path) => setDraft((current) => ({ ...current, targetOutputPath: path }))}
      />
    </div>
  );
}
