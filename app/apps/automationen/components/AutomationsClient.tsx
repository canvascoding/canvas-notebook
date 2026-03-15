'use client';

import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Clock3, Loader2, Play, Plus, RefreshCw, Save, Trash2, WandSparkles } from 'lucide-react';
import { toast } from 'sonner';

import { getDefaultAutomationTargetOutputPath, getEffectiveAutomationTargetOutputPath } from '@/app/lib/automations/paths';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import type { AutomationJobRecord, AutomationRunRecord, AutomationPreferredSkill, AutomationWeekday } from '@/app/lib/automations/types';
import { describeFriendlySchedule } from '@/app/lib/automations/schedule';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkspaceDirectoryPickerDialog } from '@/app/apps/automationen/components/WorkspaceDirectoryPickerDialog';

type ScheduleKind = 'once' | 'daily' | 'weekly' | 'interval';

type JobDraft = {
  id: string | null;
  name: string;
  prompt: string;
  preferredSkill: AutomationPreferredSkill;
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

const WEEKDAY_OPTIONS: Array<{ value: AutomationWeekday; label: string }> = [
  { value: 'mon', label: 'Mo' },
  { value: 'tue', label: 'Di' },
  { value: 'wed', label: 'Mi' },
  { value: 'thu', label: 'Do' },
  { value: 'fri', label: 'Fr' },
  { value: 'sat', label: 'Sa' },
  { value: 'sun', label: 'So' },
];

const PREFERRED_SKILLS: Array<{ value: AutomationPreferredSkill; label: string; hint: string }> = [
  { value: 'auto', label: 'Automatisch', hint: 'Der Agent entscheidet selbst, welche Tools sinnvoll sind.' },
  { value: 'image_generation', label: 'Bild erstellen', hint: 'Fokus auf Bild-Generierung.' },
  { value: 'video_generation', label: 'Video erstellen', hint: 'Fokus auf Video-Generierung.' },
  { value: 'ad_localization', label: 'Anzeige lokalisieren', hint: 'Fokus auf Ad-Lokalisierung.' },
  { value: 'qmd_search', label: 'Notizen durchsuchen', hint: 'Fokus auf Markdown- und Wissenssuche.' },
];

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
    preferredSkill: draft.preferredSkill,
    workspaceContextPaths: parseWorkspaceContext(draft.workspaceContextText),
    targetOutputPath: draft.targetOutputPath.trim() || null,
    status: draft.status,
    schedule,
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Noch nicht geplant';
  try {
    return new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function mapJobToDraft(job: AutomationJobRecord): JobDraft {
  const draft = defaultDraft();
  draft.id = job.id;
  draft.name = job.name;
  draft.prompt = job.prompt;
  draft.preferredSkill = job.preferredSkill;
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
  const [jobs, setJobs] = useState<AutomationJobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<JobDraft>(() => defaultDraft());
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const [isLoadingJobs, setIsLoadingJobs] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningNow, setIsRunningNow] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRefreshingRuns, setIsRefreshingRuns] = useState(false);
  const [isDirectoryPickerOpen, setIsDirectoryPickerOpen] = useState(false);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) || null,
    [jobs, selectedJobId],
  );

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) || null,
    [runs, selectedRunId],
  );

  const draftDefaultTargetOutputPath = useMemo(
    () => getDefaultAutomationTargetOutputPath(draft.name || 'automation'),
    [draft.name],
  );

  const draftEffectiveTargetOutputPath = useMemo(
    () => getEffectiveAutomationTargetOutputPath({ name: draft.name || 'automation', targetOutputPath: draft.targetOutputPath }),
    [draft.name, draft.targetOutputPath],
  );

  async function loadJobs(options?: { keepSelection?: boolean }) {
    setIsLoadingJobs(true);
    try {
      const response = await fetch('/api/automations/jobs', { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Automationen konnten nicht geladen werden.');
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
      toast.error(error instanceof Error ? error.message : 'Automationen konnten nicht geladen werden.');
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
        throw new Error(payload.error || 'Läufe konnten nicht geladen werden.');
      }

      const nextRuns = payload.data as AutomationRunRecord[];
      setRuns(nextRuns);
      const runToSelect = nextRuns.find((run) => run.id === preferredRunId) || nextRuns[0] || null;
      setSelectedRunId(runToSelect?.id || null);
    } catch (error) {
      setRuns([]);
      setSelectedRunId(null);
      setLogContent('');
      toast.error(error instanceof Error ? error.message : 'Läufe konnten nicht geladen werden.');
    } finally {
      setIsRefreshingRuns(false);
    }
  }

  async function loadLogs(runId: string) {
    try {
      const response = await fetch(`/api/automations/runs/${runId}/logs`, { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Logs konnten nicht geladen werden.');
      }
      setLogContent(payload.data.content || '');
    } catch (error) {
      setLogContent('');
      toast.error(error instanceof Error ? error.message : 'Logs konnten nicht geladen werden.');
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
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedRunId) {
      setLogContent('');
      return;
    }
    void loadLogs(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedJobId) return undefined;
    // Poll the currently selected automation and its runs.
    const interval = window.setInterval(() => {
      loadJobsEvent({ keepSelection: true });
      void loadRuns(selectedJobId, selectedRunId);
    }, 10_000);
    return () => window.clearInterval(interval);
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
        throw new Error(result.error || 'Automation konnte nicht gespeichert werden.');
      }

      const savedJob = result.data as AutomationJobRecord;
      toast.success(draft.id ? 'Automation aktualisiert.' : 'Automation erstellt.');
      setSelectedJobId(savedJob.id);
      setDraft(mapJobToDraft(savedJob));
      await loadJobs({ keepSelection: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Automation konnte nicht gespeichert werden.');
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
        throw new Error(payload.error || 'Lauf konnte nicht gestartet werden.');
      }
      const run = payload.data as AutomationRunRecord;
      toast.success('Lauf eingeplant.');
      await loadJobs({ keepSelection: true });
      await loadRuns(selectedJobId, run.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Lauf konnte nicht gestartet werden.');
    } finally {
      setIsRunningNow(false);
    }
  }

  async function handleDelete() {
    if (!selectedJobId || !window.confirm('Diese Automation wirklich löschen?')) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/automations/jobs/${selectedJobId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Automation konnte nicht gelöscht werden.');
      }
      toast.success('Automation gelöscht.');
      setSelectedJobId(null);
      setDraft(defaultDraft());
      setRuns([]);
      setSelectedRunId(null);
      setLogContent('');
      await loadJobs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Automation konnte nicht gelöscht werden.');
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 md:px-6">
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <WandSparkles className="h-5 w-5" />
            Automationen
          </CardTitle>
          <CardDescription>
            Plane wiederkehrende Agent-Aufträge für denselben Workspace. Run-Artefakte landen unter
            <span className="ml-1 font-mono">automationen/</span>, fachliche Ergebnisse optional in einem eigenen Zielordner.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)_minmax(0,380px)]">
        <Card className="min-h-[620px] min-w-0 overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle className="text-base">Übersicht</CardTitle>
            <CardDescription>Alle aktiven und pausierten Automationen.</CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
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
                Neue Automation
              </Button>
              <Button variant="outline" size="icon" onClick={() => void loadJobs({ keepSelection: true })}>
                <RefreshCw className={`h-4 w-4 ${isLoadingJobs ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            <div className="min-w-0 space-y-2 overflow-x-hidden" data-testid="automation-job-list">
              {isLoadingJobs && jobs.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Lade Automationen...
                </div>
              ) : jobs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                  Noch keine Automation angelegt.
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
                        className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase ${
                          job.status === 'active' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {job.status === 'active' ? 'aktiv' : 'pausiert'}
                      </span>
                    </div>
                    <div className="mt-3 min-w-0 space-y-1 text-xs text-muted-foreground">
                      <p className="break-words">{describeFriendlySchedule(job.schedule)}</p>
                      <p className="break-words">Nächster Lauf: {formatDateTime(job.nextRunAt)}</p>
                      <p>Letzter Status: {job.lastRunStatus || 'noch keiner'}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-[620px] min-w-0 overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle className="text-base">{draft.id ? 'Automation bearbeiten' : 'Neue Automation'}</CardTitle>
            <CardDescription>Nicht technisch formulieren. Der Agent führt den Auftrag später im Workspace aus.</CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 space-y-4 overflow-hidden">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">Name</span>
                <input
                  data-testid="automation-name"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Täglicher Markt-Check"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">Status</span>
                <select
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.status}
                  onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as JobDraft['status'] }))}
                >
                  <option value="active">Aktiv</option>
                  <option value="paused">Pausiert</option>
                </select>
              </label>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Was soll erledigt werden?</span>
              <textarea
                data-testid="automation-prompt"
                className="min-h-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={draft.prompt}
                onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
                placeholder="Beschreibe den Agent-Auftrag in normaler Sprache..."
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">Bevorzugte Aktion</span>
                <select
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.preferredSkill}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, preferredSkill: event.target.value as AutomationPreferredSkill }))
                  }
                >
                  {PREFERRED_SKILLS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">Zeitzone</span>
                <input
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.timeZone}
                  onChange={(event) => setDraft((current) => ({ ...current, timeZone: event.target.value }))}
                />
              </label>
            </div>
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {PREFERRED_SKILLS.find((option) => option.value === draft.preferredSkill)?.hint}
            </p>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Relevante Dateien oder Ordner</span>
              <textarea
                data-testid="automation-context-paths"
                className="min-h-[100px] rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                value={draft.workspaceContextText}
                onChange={(event) => setDraft((current) => ({ ...current, workspaceContextText: event.target.value }))}
                placeholder={'notizen/weekly.md\nbriefings/launch/'}
              />
            </label>

            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Wo sollen die Ergebnisse gespeichert werden?</p>
                  <p className="text-xs text-muted-foreground">
                    Optional. Leer gelassen nutzt die Automation automatisch einen Zielordner pro Job.
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsDirectoryPickerOpen(true)}
                    data-testid="automation-target-output-picker"
                  >
                    Im Workspace wählen
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft((current) => ({ ...current, targetOutputPath: '' }))}
                  >
                    Standard
                  </Button>
                </div>
              </div>

              <textarea
                data-testid="automation-target-output-path"
                className="min-h-[112px] w-full rounded-md border border-input bg-background px-3 py-3 font-mono text-sm"
                value={draft.targetOutputPath}
                onChange={(event) => setDraft((current) => ({ ...current, targetOutputPath: event.target.value }))}
                placeholder={draftDefaultTargetOutputPath}
              />
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-md border border-dashed border-border bg-background/70 p-3">
                  <p className="text-xs font-medium text-foreground">Vorschlag</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{draftDefaultTargetOutputPath}</p>
                </div>
                <div className="rounded-md border border-dashed border-border bg-background/70 p-3">
                  <p className="text-xs font-medium text-foreground">Effektiver Zielordner</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{draftEffectiveTargetOutputPath}</p>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Wann soll das laufen?</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">Rhythmus</span>
                  <select
                    data-testid="automation-schedule-kind"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={draft.scheduleKind}
                    onChange={(event) => setDraft((current) => ({ ...current, scheduleKind: event.target.value as ScheduleKind }))}
                  >
                    <option value="once">Einmalig</option>
                    <option value="daily">Täglich</option>
                    <option value="weekly">Wöchentlich</option>
                    <option value="interval">Alle X</option>
                  </select>
                </label>
              </div>

              {draft.scheduleKind === 'once' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">Datum</span>
                    <input
                      type="date"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={draft.onceDate}
                      onChange={(event) => setDraft((current) => ({ ...current, onceDate: event.target.value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">Uhrzeit</span>
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
                  <span className="text-xs text-muted-foreground">Uhrzeit</span>
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
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAY_OPTIONS.map((day) => {
                      const selected = draft.weeklyDays.includes(day.value);
                      return (
                        <button
                          key={day.value}
                          type="button"
                          className={`rounded-md border px-3 py-2 text-sm ${selected ? 'border-primary bg-primary/10' : 'border-border bg-background'}`}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              weeklyDays: current.weeklyDays.includes(day.value)
                                ? current.weeklyDays.filter((entry) => entry !== day.value)
                                : [...current.weeklyDays, day.value],
                            }))
                          }
                        >
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                  <label className="flex flex-col gap-1 text-sm md:max-w-xs">
                    <span className="text-xs text-muted-foreground">Uhrzeit</span>
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
                    <span className="text-xs text-muted-foreground">Wiederholen alle</span>
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
                    <span className="text-xs text-muted-foreground">Einheit</span>
                    <select
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={draft.intervalUnit}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, intervalUnit: event.target.value as JobDraft['intervalUnit'] }))
                      }
                    >
                      <option value="minutes">Minuten</option>
                      <option value="hours">Stunden</option>
                      <option value="days">Tage</option>
                    </select>
                  </label>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void handleSave()} disabled={isSaving} data-testid="automation-save">
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Speichern
              </Button>
              <Button variant="secondary" onClick={() => void handleRunNow()} disabled={!selectedJobId || isRunningNow} data-testid="automation-run-now">
                {isRunningNow ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                Jetzt ausführen
              </Button>
              <Button variant="outline" onClick={handleDelete} disabled={!selectedJobId || isDeleting}>
                {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Löschen
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-[620px] min-w-0 overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle className="text-base">Laufhistorie</CardTitle>
            <CardDescription>Status, Ergebnisse und Logs der ausgewählten Automation.</CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 space-y-4 overflow-hidden">
            <div className="space-y-2" data-testid="automation-run-list">
              {isRefreshingRuns && runs.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Lade Läufe...
                </div>
              ) : runs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                  Noch keine Läufe vorhanden.
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
                      <span className="font-medium">{run.status}</span>
                      <span className="text-xs text-muted-foreground">Versuch {run.attemptNumber}</span>
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      <p>Ausgelöst: {run.triggerType}</p>
                      <p>Geplant für: {formatDateTime(run.scheduledFor)}</p>
                      <p>Beendet: {formatDateTime(run.finishedAt)}</p>
                      {run.errorMessage ? <p className="text-destructive">{run.errorMessage}</p> : null}
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Logs</p>
                  <p className="text-xs text-muted-foreground">Rohes Event-Log der ausgewählten Ausführung.</p>
                </div>
                {selectedRun?.logPath ? (
                  <a
                    href={toMediaUrl(selectedRun.logPath)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Log-Datei öffnen
                  </a>
                ) : null}
              </div>
              <pre
                className="max-h-[260px] overflow-auto rounded-md border border-border bg-background p-3 text-xs text-foreground"
                data-testid="automation-log-content"
              >
                {logContent || 'Noch kein Log vorhanden.'}
              </pre>
            </div>

            <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-4 text-sm">
              <p className="font-medium">Ergebnisordner</p>
              <p className="break-all font-mono text-xs text-muted-foreground" data-testid="automation-result-folder">
                {selectedRun?.effectiveTargetOutputPath || selectedJob?.effectiveTargetOutputPath || 'Noch keiner vorhanden.'}
              </p>
              {selectedRun?.targetOutputPath ? (
                <p className="text-xs text-muted-foreground">
                  Konfiguriert: <span className="font-mono">{selectedRun.targetOutputPath}</span>
                </p>
              ) : selectedJob ? (
                <p className="text-xs text-muted-foreground">
                  Standard: <span className="font-mono">{selectedJob.effectiveTargetOutputPath}</span>
                </p>
              ) : null}
            </div>

            <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-4 text-sm">
              <p className="font-medium">Run-Artefakte</p>
              <p className="break-all font-mono text-xs text-muted-foreground" data-testid="automation-artifact-folder">
                {selectedRun?.outputDir || 'Noch keiner vorhanden.'}
              </p>
              {selectedRun?.resultPath ? (
                <a
                  href={toMediaUrl(selectedRun.resultPath)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Ergebnisdatei öffnen
                </a>
              ) : null}
              {selectedRun?.piSessionId ? (
                <p className="text-xs text-muted-foreground">PI Session: {selectedRun.piSessionId}</p>
              ) : null}
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
