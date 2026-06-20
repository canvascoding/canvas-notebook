'use client';

/* eslint-disable @next/next/no-img-element */

import { useEffect, useEffectEvent, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Clock3,
  Bot,
  Copy,
  KeyRound,
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
  Send,
  Search,
  Sparkles,
  Trash2,
  WandSparkles,
  Webhook,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { WorkspaceDirectoryPickerDialog } from '@/app/apps/automations/components/WorkspaceDirectoryPickerDialog';
import { AgentAvatar, AgentIcon } from '@/app/components/agents/AgentAvatar';
import { getEffectiveAutomationTargetOutputPath } from '@/app/lib/automations/paths';
import { formatTimeZoneLabel, getSupportedTimeZones, normalizeTimeZone } from '@/app/lib/time-zones';
import { CanvasSkillIcon, type CanvasSkillIconSource } from '@/app/lib/skills/skill-icons';
import type {
  AutomationJobRecord,
  AutomationDeliveryMode,
  AutomationDeliverySessionMode,
  AutomationRunRecord,
  AutomationRunStatus,
  AutomationTriggerType,
  AutomationWeekday,
  FriendlySchedule,
} from '@/app/lib/automations/types';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownRenderer } from '@/app/components/shared/MarkdownRenderer';
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditor';
import { Link, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

type ScheduleKind = 'once' | 'daily' | 'weekly' | 'interval';
type ComposerMode = 'scheduled' | 'trigger';
type TriggerSource = 'custom' | 'composio';

type JobDraft = {
  id: string | null;
  workspaceId: string;
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
  agentId: string;
  deliveryMode: AutomationDeliveryMode;
  deliveryChannelId: string;
  deliverySessionMode: AutomationDeliverySessionMode;
  deliverySessionId: string;
  deliveryChannelSessionKey: string;
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

type SkillOption = CanvasSkillIconSource & {
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
  workspaceId: string;
  toolkitSlug: string;
  triggerSlug: string;
  name: string;
  prompt: string;
  preferredSkill: string;
  workspaceContextText: string;
  targetOutputPath: string;
  configValues: Record<string, string | boolean>;
  agentId: string;
  deliveryMode: AutomationDeliveryMode;
  deliveryChannelId: string;
  deliverySessionMode: AutomationDeliverySessionMode;
  deliverySessionId: string;
  deliveryChannelSessionKey: string;
};

type CustomWebhookDraft = {
  workspaceId: string;
  name: string;
  prompt: string;
  preferredSkill: string;
  workspaceContextText: string;
  targetOutputPath: string;
  agentId: string;
  deliveryMode: AutomationDeliveryMode;
  deliveryChannelId: string;
  deliverySessionMode: AutomationDeliverySessionMode;
  deliverySessionId: string;
  deliveryChannelSessionKey: string;
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
  initialTimeZone?: string;
};

type AgentOption = {
  agentId: string;
  name: string;
  iconId?: string;
  type: string;
  removable: boolean;
};

type DeliveryChannelOption = {
  id: string;
  label: string;
  connected: boolean;
  running: boolean;
};

type TelegramDeliveryStatus = {
  configured?: boolean;
  enabled?: boolean;
  linked?: boolean;
};

const WEEKDAY_OPTIONS: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_AGENT_ID = 'canvas-agent';

type AutomationPromptEditorProps = {
  value: string;
  onChange: (value: string) => void;
  heightClassName: string;
  testId?: string;
};

function AutomationPromptEditor({ value, onChange, heightClassName, testId }: AutomationPromptEditorProps) {
  return (
    <div
      data-testid={testId}
      className={cn('min-w-0 overflow-hidden rounded-md border border-input bg-background', heightClassName)}
    >
      <MarkdownEditor value={value} onChange={onChange} externalValueSync="when-blurred" />
    </div>
  );
}

function skillDisplayName(skill: Pick<SkillOption, 'name' | 'title' | 'interface'>): string {
  const displayName = skill.interface?.displayName || skill.title;
  if (displayName?.trim()) return displayName.trim();
  return skill.name
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function SkillPicker({
  description,
  emptyLabel,
  id,
  label,
  onChange,
  placeholder,
  searchPlaceholder,
  skills,
  value,
}: {
  description: string;
  emptyLabel: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  skills: SkillOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedSkill = value === 'auto' ? null : skills.find((skill) => skill.name === value) || { name: value };
  const selectedLabel = selectedSkill ? skillDisplayName(selectedSkill) : placeholder;

  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-10 w-full justify-between gap-2 px-3 font-normal"
          >
            <span className="flex min-w-0 items-center gap-2">
              {selectedSkill ? (
                <CanvasSkillIcon skill={selectedSkill} className="h-6 w-6 rounded-md text-[10px]" />
              ) : (
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                  <Bot className="h-3.5 w-3.5" />
                </span>
              )}
              <span className="min-w-0 truncate text-left">{selectedLabel}</span>
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-72 p-0">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyLabel}</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value={placeholder}
                  onSelect={() => {
                    onChange('auto');
                    setOpen(false);
                  }}
                  className="gap-2"
                >
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                    <Bot className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{placeholder}</span>
                  {value === 'auto' ? <Check className="h-4 w-4 shrink-0" /> : null}
                </CommandItem>
              </CommandGroup>
              {skills.length > 0 ? <CommandSeparator /> : null}
              <CommandGroup>
                {skills.map((skill) => {
                  const displayName = skillDisplayName(skill);
                  const selected = skill.name === value;
                  return (
                    <CommandItem
                      key={skill.name}
                      value={`${displayName} ${skill.name} ${skill.description || ''}`}
                      onSelect={() => {
                        onChange(skill.name);
                        setOpen(false);
                      }}
                      className="gap-2"
                    >
                      <CanvasSkillIcon skill={skill} className="h-8 w-8 rounded-md text-[11px]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{displayName}</span>
                        <span className="block truncate text-xs text-muted-foreground">{skill.description || skill.name}</span>
                      </span>
                      {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <span className="text-xs text-muted-foreground">{description}</span>
    </div>
  );
}

function defaultDraft(defaultTimeZone?: string, workspaceId = ''): JobDraft {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const timeZone = normalizeTimeZone(defaultTimeZone);

  return {
    id: null,
    workspaceId,
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
    agentId: DEFAULT_AGENT_ID,
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
    deliverySessionId: '',
    deliveryChannelSessionKey: '',
  };
}

function defaultTriggerDraft(workspaceId = ''): TriggerComposerDraft {
  return {
    workspaceId,
    toolkitSlug: '',
    triggerSlug: '',
    name: '',
    prompt: '',
    preferredSkill: 'auto',
    workspaceContextText: '',
    targetOutputPath: '',
    configValues: {},
    agentId: DEFAULT_AGENT_ID,
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
    deliverySessionId: '',
    deliveryChannelSessionKey: '',
  };
}

function defaultCustomWebhookDraft(workspaceId = ''): CustomWebhookDraft {
  return {
    workspaceId,
    name: '',
    prompt: '',
    preferredSkill: 'auto',
    workspaceContextText: '',
    targetOutputPath: '',
    agentId: DEFAULT_AGENT_ID,
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
    deliverySessionId: '',
    deliveryChannelSessionKey: '',
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

function normalizeDeliveryChannel(value: unknown): DeliveryChannelOption | null {
  const record = asRecord(value);
  const id = stringValue(record.id);
  if (!id) return null;
  return {
    id,
    label: id === 'web' ? 'Web Chat' : id.charAt(0).toUpperCase() + id.slice(1),
    connected: Boolean(record.connected),
    running: Boolean(record.running),
  };
}

function normalizeDeliveryChannels(channels: unknown[], telegramStatus: TelegramDeliveryStatus | null): DeliveryChannelOption[] {
  const telegramReady = Boolean(telegramStatus?.configured && telegramStatus.enabled && telegramStatus.linked);

  return channels
    .map(normalizeDeliveryChannel)
    .filter((channel: DeliveryChannelOption | null): channel is DeliveryChannelOption => Boolean(channel))
    .map((channel) => {
      if (channel.id !== 'telegram' || !telegramStatus) return channel;
      return {
        ...channel,
        connected: channel.connected && telegramReady,
      };
    });
}

function mergeDeliveryChannelOptions(
  channels: DeliveryChannelOption[],
  currentChannelIds: string[],
): DeliveryChannelOption[] {
  const byId = new Map<string, DeliveryChannelOption>();
  byId.set('web', { id: 'web', label: 'Web Chat', connected: true, running: true });

  for (const channel of channels) {
    byId.set(channel.id, channel);
  }

  for (const id of currentChannelIds.map((entry) => entry.trim()).filter(Boolean)) {
    if (!byId.has(id)) {
      byId.set(id, { id, label: id, connected: false, running: false });
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.id === 'web') return -1;
    if (b.id === 'web') return 1;
    return a.label.localeCompare(b.label);
  });
}

function getVisibleDeliveryChannelOptions(channels: DeliveryChannelOption[], selectedChannelId: string): DeliveryChannelOption[] {
  return channels.filter((channel) => channel.id === 'web' || channel.connected || channel.id === selectedChannelId);
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
  const deliveryChannelId = normalizeDeliveryChannelIdForPayload(draft.deliveryMode, draft.deliveryChannelId);

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
    workspaceId: draft.workspaceId || null,
    preferredSkill: draft.preferredSkill || 'auto',
    workspaceContextPaths: parseWorkspaceContext(draft.workspaceContextText),
    targetOutputPath: draft.targetOutputPath.trim() || null,
    status: draft.status,
    agentId: draft.agentId,
    deliveryMode: draft.deliveryMode,
    deliveryChannelId,
    deliverySessionMode: draft.deliverySessionMode,
    deliverySessionId: draft.deliverySessionId.trim() || null,
    deliveryChannelSessionKey: normalizeDeliveryChannelSessionKeyForPayload(deliveryChannelId, draft.deliveryChannelSessionKey),
    schedule,
  };
}

function normalizeDeliveryChannelIdForPayload(mode: AutomationDeliveryMode, channelId: string): string | null {
  if (mode === 'silent') return 'web';
  if (mode === 'web') return 'web';
  return channelId.trim() || 'web';
}

function normalizeDeliveryChannelSessionKeyForPayload(channelId: string | null, channelSessionKey: string): string | null {
  const normalized = channelSessionKey.trim();
  if (!normalized) return null;
  if (channelId && channelId !== 'web' && normalized.startsWith('web:')) return null;
  return normalized;
}

function getDeliveryChannelSelection(
  state:
    | Pick<JobDraft, 'deliveryMode' | 'deliveryChannelId'>
    | Pick<TriggerComposerDraft, 'deliveryMode' | 'deliveryChannelId'>
    | Pick<CustomWebhookDraft, 'deliveryMode' | 'deliveryChannelId'>,
): string {
  if (state.deliveryMode === 'silent') return 'web';
  if (state.deliveryMode === 'web') return 'web';
  return state.deliveryChannelId || 'web';
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
  let summary: string;
  if (schedule.kind === 'once') {
    summary = translate('scheduleSummary.once', { date: schedule.date, time: schedule.time });
  } else if (schedule.kind === 'daily') {
    summary = translate('scheduleSummary.daily', { time: schedule.times.join(', ') });
  } else if (schedule.kind === 'weekly') {
    summary = translate('scheduleSummary.weekly', {
      days: schedule.days.map((day) => weekdayLabels[day]).join(', '),
      time: schedule.times.join(', '),
    });
  } else if (schedule.kind === 'webhook') {
    summary = 'Webhook';
  } else {
    summary = translate('scheduleSummary.interval', { every: schedule.every, unit: translate(`intervalUnits.${schedule.unit}`) });
  }

  return translate('scheduleSummary.withTimeZone', { schedule: summary, timeZone: schedule.timeZone });
}

function formatRunStatus(status: AutomationRunStatus, translate: (key: string) => string): string {
  return translate(`runStatus.${status}`);
}

function formatTriggerType(triggerType: AutomationTriggerType, translate: (key: string) => string): string {
  return translate(`triggerType.${triggerType}`);
}

function workspaceScopeLabel(workspace: Pick<ClientWorkspaceSummary, 'type'> | null | undefined, locale: string): string {
  const isGerman = locale.startsWith('de');
  if (workspace?.type === 'team') return isGerman ? 'Organisation' : 'Organization';
  if (workspace?.type === 'project') return isGerman ? 'Projekt' : 'Project';
  return isGerman ? 'Persönlich' : 'Personal';
}

function workspaceOptionLabel(workspace: ClientWorkspaceSummary, locale: string): string {
  return `${workspace.name} · ${workspaceScopeLabel(workspace, locale)}`;
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
  const jobTimeZone = normalizeTimeZone(job.schedule.timeZone || job.timeZone);
  const draft = defaultDraft(jobTimeZone);
  draft.id = job.id;
  draft.workspaceId = job.workspaceId || '';
  draft.name = job.name;
  draft.prompt = job.prompt;
  draft.preferredSkill = job.preferredSkill || 'auto';
  draft.workspaceContextText = job.workspaceContextPaths.join('\n');
  draft.targetOutputPath = job.targetOutputPath || '';
  draft.status = job.status;
  draft.agentId = job.agentId || DEFAULT_AGENT_ID;
  draft.deliveryMode = job.deliveryMode === 'silent' ? 'web' : job.deliveryMode || 'web';
  draft.deliveryChannelId = job.deliveryMode === 'silent' ? 'web' : job.deliveryChannelId || (job.deliveryMode === 'web' ? 'web' : '');
  draft.deliverySessionMode = job.deliverySessionMode || 'new_session';
  draft.deliverySessionId = job.deliverySessionId || '';
  draft.deliveryChannelSessionKey = job.deliveryChannelSessionKey || '';
  draft.scheduleKind = job.schedule.kind === 'webhook' ? 'interval' : job.schedule.kind;
  draft.timeZone = jobTimeZone;

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

export function AutomationsClient({ initialJobId = null, initialTimeZone }: AutomationsClientProps) {
  const t = useTranslations('automationen');
  const locale = useLocale();
  const router = useRouter();
  const isDetailPage = Boolean(initialJobId);
  const defaultTimeZone = normalizeTimeZone(initialTimeZone);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const workspaceInitialized = useWorkspaceStore((state) => state.initialized);
  const automationWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.status === 'active' && workspace.permissions.canRead && workspace.permissions.canWrite && workspace.permissions.canRunAgent),
    [workspaces],
  );
  const defaultAutomationWorkspaceId = useMemo(() => {
    if (activeWorkspace && automationWorkspaces.some((workspace) => workspace.id === activeWorkspace.id)) {
      return activeWorkspace.id;
    }
    return automationWorkspaces[0]?.id || '';
  }, [activeWorkspace, automationWorkspaces]);
  const [jobs, setJobs] = useState<AutomationJobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<JobDraft>(() => defaultDraft(defaultTimeZone));
  const [triggerDraft, setTriggerDraft] = useState<TriggerComposerDraft>(() => defaultTriggerDraft());
  const [customWebhookDraft, setCustomWebhookDraft] = useState<CustomWebhookDraft>(() => defaultCustomWebhookDraft());
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [runDetailsById, setRunDetailsById] = useState<Record<string, AutomationRunRecord>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const [sessionMessages, setSessionMessages] = useState<PersistedAutomationSessionMessage[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [deliveryChannels, setDeliveryChannels] = useState<DeliveryChannelOption[]>([]);
  const [composerMode, setComposerMode] = useState<ComposerMode>('scheduled');
  const [triggerSource, setTriggerSource] = useState<TriggerSource>('custom');
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
  const [directoryPickerTarget, setDirectoryPickerTarget] = useState<'scheduled' | 'trigger' | 'customWebhook'>('scheduled');
  const [webhookSecretsByJobId, setWebhookSecretsByJobId] = useState<Record<string, string>>({});
  const [rotatingWebhookId, setRotatingWebhookId] = useState<string | null>(null);
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
  const workspaceById = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const selectedDraftWorkspace = draft.workspaceId ? workspaceById.get(draft.workspaceId) || null : null;
  const selectedTriggerWorkspace = triggerDraft.workspaceId ? workspaceById.get(triggerDraft.workspaceId) || null : null;
  const selectedCustomWebhookWorkspace = customWebhookDraft.workspaceId ? workspaceById.get(customWebhookDraft.workspaceId) || null : null;
  const selectedJobWorkspace = selectedJob?.workspaceId ? workspaceById.get(selectedJob.workspaceId) || null : null;
  const selectedRunSummary = useMemo(() => runs.find((run) => run.id === selectedRunId) || null, [runs, selectedRunId]);
  const selectedRun = useMemo(
    () => (selectedRunId ? runDetailsById[selectedRunId] || selectedRunSummary : null),
    [runDetailsById, selectedRunId, selectedRunSummary],
  );
  const templates = useMemo(() => getAutomationTemplates(locale), [locale]);
  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabled !== false), [skills]);
  const agentOptions = agents.length > 0
    ? agents
    : [{ agentId: DEFAULT_AGENT_ID, name: 'Canvas Agent', iconId: 'bot', type: 'main', removable: false }];
  const deliveryChannelOptions = useMemo(
    () => mergeDeliveryChannelOptions(deliveryChannels, [draft.deliveryChannelId, triggerDraft.deliveryChannelId, customWebhookDraft.deliveryChannelId]),
    [deliveryChannels, draft.deliveryChannelId, triggerDraft.deliveryChannelId, customWebhookDraft.deliveryChannelId],
  );
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
  const overviewStats = useMemo(() => ({
    total: jobs.length,
    active: jobs.filter((job) => job.status === 'active').length,
    paused: jobs.filter((job) => job.status === 'paused').length,
    running: automationGroups.running.length,
    failed: automationGroups.needsAttention.length,
  }), [automationGroups.needsAttention.length, automationGroups.running.length, jobs]);

  const draftEffectiveTargetOutputPath = useMemo(
    () => getEffectiveAutomationTargetOutputPath({ name: draft.name || 'automation', targetOutputPath: draft.targetOutputPath }),
    [draft.name, draft.targetOutputPath],
  );
  const selectedJobWebhookSecret = selectedJob?.id ? webhookSecretsByJobId[selectedJob.id] : '';
  const selectedJobWebhookUrl = selectedJob?.customWebhookId
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/api/automations/webhooks/${encodeURIComponent(selectedJob.customWebhookId)}`
    : '';

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
        const nextSelected = initialJobId ? nextJobs.find((job) => job.id === initialJobId) || null : null;
        setSelectedJobId(nextSelected?.id || null);
        setDraft(nextSelected ? mapJobToDraft(nextSelected) : defaultDraft(defaultTimeZone, defaultAutomationWorkspaceId));
      } else if (selectedJobId) {
        const nextSelected = nextJobs.find((job) => job.id === selectedJobId);
        if (!nextSelected) {
          setSelectedJobId(null);
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
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadRuns'));

      const nextRuns = payload.data as AutomationRunRecord[];
      setRuns(nextRuns);
      setRunDetailsById((current) => {
        const nextIds = new Set(nextRuns.map((run) => run.id));
        return Object.fromEntries(Object.entries(current).filter(([runId]) => nextIds.has(runId)));
      });
      const runToSelect = nextRuns.find((run) => run.id === preferredRunId) || nextRuns[0] || null;
      setSelectedRunId(runToSelect?.id || null);
    } catch (error) {
      setRuns([]);
      setRunDetailsById({});
      setSelectedRunId(null);
      setLogContent('');
      toast.error(error instanceof Error ? error.message : t('errors.loadRuns'));
    } finally {
      setIsRefreshingRuns(false);
    }
  }

  async function loadRunDetails(runId: string) {
    try {
      const response = await fetch(`/api/automations/runs/${runId}`, { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadRuns'));
      const run = payload.data as AutomationRunRecord;
      setRunDetailsById((current) => ({ ...current, [run.id]: run }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.loadRuns'));
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

  async function loadAgents() {
    try {
      const response = await fetch('/api/agents', { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (response.ok && payload.success && Array.isArray(payload.data?.agents)) {
        setAgents(payload.data.agents as AgentOption[]);
      }
    } catch {
      setAgents([]);
    }
  }

  async function loadDeliveryChannels() {
    try {
      const response = await fetch('/api/channels/status', { cache: 'no-store', credentials: 'include' });
      const payload = await response.json();
      if (response.ok && payload.success && Array.isArray(payload.channels)) {
        const telegramStatus = payload.telegram === undefined ? null : asRecord(payload.telegram) as TelegramDeliveryStatus;
        setDeliveryChannels(normalizeDeliveryChannels(payload.channels, telegramStatus));
      }
    } catch {
      setDeliveryChannels([]);
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
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  useEffect(() => {
    if (!workspaceInitialized || !defaultAutomationWorkspaceId || selectedJobId) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setDraft((current) => current.workspaceId ? current : { ...current, workspaceId: defaultAutomationWorkspaceId });
    setTriggerDraft((current) => current.workspaceId ? current : { ...current, workspaceId: defaultAutomationWorkspaceId });
    setCustomWebhookDraft((current) => current.workspaceId ? current : { ...current, workspaceId: defaultAutomationWorkspaceId });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [defaultAutomationWorkspaceId, selectedJobId, workspaceInitialized]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobsEvent();
    void loadSkills();
    void loadAgents();
    void loadDeliveryChannels();
  }, []);

  useEffect(() => {
    if (!isComposerOpen || composerMode !== 'trigger' || triggerSource !== 'composio' || triggerApps.length > 0 || isLoadingTriggerApps) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTriggerApps();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalog loading is only needed when opening the trigger tab
  }, [isComposerOpen, composerMode, triggerSource, triggerApps.length, isLoadingTriggerApps]);

  useEffect(() => {
    if (!isComposerOpen || composerMode !== 'trigger' || triggerSource !== 'composio' || !triggerDraft.toolkitSlug) return;
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
  }, [isComposerOpen, composerMode, triggerSource, triggerDraft.toolkitSlug]);

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
      setRunDetailsById({});
      setSelectedRunId(null);
      setLogContent('');
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    void loadRuns(selectedJobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadRuns takes selectedJobId as argument
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedRunId || !isRunSheetOpen) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setLogContent('');
      setSessionMessages([]);
      setIsLoadingSessionMessages(false);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    void loadRunDetails(selectedRunId);
    void loadLogs(selectedRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaders take the run id as an argument
  }, [selectedRunId, isRunSheetOpen]);

  useEffect(() => {
    if (!isRunSheetOpen || !selectedRun?.piSessionId || !selectedRun.hasPersistedSession) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setSessionMessages([]);
      setIsLoadingSessionMessages(false);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    void loadSessionMessages(selectedRun.piSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSessionMessages takes the session id as an argument
  }, [isRunSheetOpen, selectedRun?.piSessionId, selectedRun?.hasPersistedSession, selectedRun?.status, selectedRun?.finishedAt]);

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
        ? (() => {
            const deliveryChannelId = normalizeDeliveryChannelIdForPayload(draft.deliveryMode, draft.deliveryChannelId);
            return {
              name: draft.name,
              prompt: draft.prompt,
              preferredSkill: draft.preferredSkill || 'auto',
              workspaceContextPaths: parseWorkspaceContext(draft.workspaceContextText),
              targetOutputPath: draft.targetOutputPath.trim() || null,
              status: draft.status,
              agentId: draft.agentId,
              deliveryMode: draft.deliveryMode,
              deliveryChannelId,
              deliverySessionMode: draft.deliverySessionMode,
              deliverySessionId: draft.deliverySessionId.trim() || null,
              deliveryChannelSessionKey: normalizeDeliveryChannelSessionKeyForPayload(deliveryChannelId, draft.deliveryChannelSessionKey),
            };
          })()
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
      router.push(`/automations/${savedJob.id}`);
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
      const deliveryChannelId = normalizeDeliveryChannelIdForPayload(triggerDraft.deliveryMode, triggerDraft.deliveryChannelId);
      const triggerConfig = buildTriggerConfigFromSchema(selectedTriggerType.configSchema, triggerDraft.configValues);
      const response = await fetch('/api/composio/triggers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: triggerDraft.name.trim(),
          prompt: triggerDraft.prompt.trim(),
          workspaceId: triggerDraft.workspaceId || null,
          preferredSkill: triggerDraft.preferredSkill || 'auto',
          toolkitSlug: selectedTriggerApp.slug,
          triggerSlug: selectedTriggerType.slug,
          connectedAccountId: selectedTriggerApp.connectedAccountId || undefined,
          triggerConfig,
          workspaceContextPaths: parseWorkspaceContext(triggerDraft.workspaceContextText),
          targetOutputPath: triggerDraft.targetOutputPath.trim() || null,
          agentId: triggerDraft.agentId,
          deliveryMode: triggerDraft.deliveryMode,
          deliveryChannelId,
          deliverySessionMode: triggerDraft.deliverySessionMode,
          deliverySessionId: triggerDraft.deliverySessionId.trim() || null,
          deliveryChannelSessionKey: normalizeDeliveryChannelSessionKeyForPayload(deliveryChannelId, triggerDraft.deliveryChannelSessionKey),
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
      setTriggerDraft(defaultTriggerDraft(defaultAutomationWorkspaceId));
      setSelectedJobId(savedJob.id);
      setDraft(mapJobToDraft(savedJob));
      await loadJobs({ keepSelection: true });
      router.push(`/automations/${savedJob.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('triggers.errors.create'));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCreateCustomWebhookAutomation() {
    setIsSaving(true);
    try {
      const deliveryChannelId = normalizeDeliveryChannelIdForPayload(customWebhookDraft.deliveryMode, customWebhookDraft.deliveryChannelId);
      const response = await fetch('/api/automations/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: customWebhookDraft.name.trim(),
          prompt: customWebhookDraft.prompt.trim(),
          workspaceId: customWebhookDraft.workspaceId || null,
          preferredSkill: customWebhookDraft.preferredSkill || 'auto',
          workspaceContextPaths: parseWorkspaceContext(customWebhookDraft.workspaceContextText),
          targetOutputPath: customWebhookDraft.targetOutputPath.trim() || null,
          agentId: customWebhookDraft.agentId,
          deliveryMode: customWebhookDraft.deliveryMode,
          deliveryChannelId,
          deliverySessionMode: customWebhookDraft.deliverySessionMode,
          deliverySessionId: customWebhookDraft.deliverySessionId.trim() || null,
          deliveryChannelSessionKey: normalizeDeliveryChannelSessionKeyForPayload(deliveryChannelId, customWebhookDraft.deliveryChannelSessionKey),
          status: 'active',
        }),
      });
      const result = await readJsonResponse(response, 'Create webhook automation');
      if (!response.ok || result.success === false) throw new Error(stringValue(result.error) || t('triggers.custom.errors.create'));
      const data = asRecord(result.data);
      const savedJob = data.job as AutomationJobRecord;
      const secret = stringValue(data.secret);
      if (!savedJob?.id || !secret) throw new Error(t('triggers.custom.errors.create'));
      setWebhookSecretsByJobId((current) => ({ ...current, [savedJob.id]: secret }));
      toast.success(t('toasts.jobCreated'));
      setIsComposerOpen(false);
      setComposerMode('scheduled');
      setTriggerSource('custom');
      setCustomWebhookDraft(defaultCustomWebhookDraft(defaultAutomationWorkspaceId));
      setSelectedJobId(savedJob.id);
      setDraft(mapJobToDraft(savedJob));
      await loadJobs({ keepSelection: true });
      router.push(`/automations/${savedJob.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('triggers.custom.errors.create'));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRotateWebhookSecret() {
    if (!selectedJob?.customWebhookId) return;
    setRotatingWebhookId(selectedJob.customWebhookId);
    try {
      const response = await fetch(`/api/automations/webhooks/${encodeURIComponent(selectedJob.customWebhookId)}/secret`, {
        method: 'POST',
        credentials: 'include',
      });
      const result = await readJsonResponse(response, 'Rotate webhook secret');
      if (!response.ok || result.success === false) throw new Error(stringValue(result.error) || t('triggers.custom.errors.rotate'));
      const data = asRecord(result.data);
      const savedJob = data.job as AutomationJobRecord;
      const secret = stringValue(data.secret);
      if (!savedJob?.id || !secret) throw new Error(t('triggers.custom.errors.rotate'));
      setWebhookSecretsByJobId((current) => ({ ...current, [savedJob.id]: secret }));
      setSelectedJobId(savedJob.id);
      setDraft(mapJobToDraft(savedJob));
      await loadJobs({ keepSelection: true });
      toast.success(t('triggers.custom.secretRotated'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('triggers.custom.errors.rotate'));
    } finally {
      setRotatingWebhookId(null);
    }
  }

  async function copyText(value: string, successMessage: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error(t('triggers.custom.errors.copy'));
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
      setDraft(defaultDraft(defaultTimeZone, defaultAutomationWorkspaceId));
      setRuns([]);
      setSelectedRunId(null);
      setLogContent('');
      await loadJobs();
      router.push('/automations');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.deleteJob'));
    } finally {
      setIsDeleting(false);
    }
  }

  function handleNewAutomation() {
    setSelectedJobId(null);
    setRuns([]);
    setSelectedRunId(null);
    setLogContent('');
    setDraft(defaultDraft(defaultTimeZone, defaultAutomationWorkspaceId));
    setTriggerDraft(defaultTriggerDraft(defaultAutomationWorkspaceId));
    setCustomWebhookDraft(defaultCustomWebhookDraft(defaultAutomationWorkspaceId));
    setComposerMode('scheduled');
    setTriggerSource('custom');
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
      <SkillPicker
        id={id}
        label={t('editor.fields.preferredSkill')}
        value={draft.preferredSkill}
        onChange={(preferredSkill) => setDraft((current) => ({ ...current, preferredSkill }))}
        skills={enabledSkills}
        placeholder={t('skills.auto')}
        searchPlaceholder={t('skills.searchPlaceholder')}
        emptyLabel={t('skills.empty')}
        description={t('skills.description')}
      />
    );
  }

  function renderTriggerSkillSelect(id: string) {
    return (
      <SkillPicker
        id={id}
        label={t('editor.fields.preferredSkill')}
        value={triggerDraft.preferredSkill}
        onChange={(preferredSkill) => setTriggerDraft((current) => ({ ...current, preferredSkill }))}
        skills={enabledSkills}
        placeholder={t('skills.auto')}
        searchPlaceholder={t('skills.searchPlaceholder')}
        emptyLabel={t('skills.empty')}
        description={t('skills.description')}
      />
    );
  }

  function renderCustomWebhookSkillSelect(id: string) {
    return (
      <SkillPicker
        id={id}
        label={t('editor.fields.preferredSkill')}
        value={customWebhookDraft.preferredSkill}
        onChange={(preferredSkill) => setCustomWebhookDraft((current) => ({ ...current, preferredSkill }))}
        skills={enabledSkills}
        placeholder={t('skills.auto')}
        searchPlaceholder={t('skills.searchPlaceholder')}
        emptyLabel={t('skills.empty')}
        description={t('skills.description')}
      />
    );
  }

  function renderWorkspaceSelector(target: 'scheduled' | 'trigger' | 'customWebhook') {
    const state = target === 'trigger'
      ? triggerDraft
      : target === 'customWebhook'
        ? customWebhookDraft
        : draft;
    const selectedWorkspace = target === 'trigger'
      ? selectedTriggerWorkspace
      : target === 'customWebhook'
        ? selectedCustomWebhookWorkspace
        : selectedDraftWorkspace;
    const isExistingScheduledJob = target === 'scheduled' && Boolean(draft.id);
    const isGerman = locale.startsWith('de');
    const label = isGerman ? 'Workspace' : 'Workspace';
    const scopeLabel = workspaceScopeLabel(selectedWorkspace, locale);
    const updateWorkspaceId = (workspaceId: string) => {
      if (target === 'trigger') {
        setTriggerDraft((current) => ({ ...current, workspaceId }));
      } else if (target === 'customWebhook') {
        setCustomWebhookDraft((current) => ({ ...current, workspaceId }));
      } else {
        setDraft((current) => ({ ...current, workspaceId }));
      }
    };

    return (
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Folder className="h-3.5 w-3.5" />
          {label}
        </span>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <select
            data-testid={`automation-${target}-workspace`}
            className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm"
            value={state.workspaceId || defaultAutomationWorkspaceId}
            onChange={(event) => updateWorkspaceId(event.target.value)}
            disabled={isExistingScheduledJob || automationWorkspaces.length === 0}
          >
            {automationWorkspaces.length === 0 ? (
              <option value="">{isGerman ? 'Kein Workspace verfügbar' : 'No workspace available'}</option>
            ) : automationWorkspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspaceOptionLabel(workspace, locale)}
              </option>
            ))}
          </select>
          <Badge variant={selectedWorkspace?.type === 'team' ? 'default' : 'secondary'} className="h-10 justify-center px-3">
            {scopeLabel}
          </Badge>
        </div>
      </label>
    );
  }

  function deliverySessionModeLabel(mode: AutomationDeliverySessionMode): string {
    const isGerman = locale.startsWith('de');
    if (mode === 'new_session') return isGerman ? 'Neue Sitzung' : 'New session';
    if (mode === 'channel_active') return isGerman ? 'Aktive Sitzung im gewählten Kanal' : 'Active session in selected channel';
    return isGerman ? 'Bestimmte Sitzungs-ID' : 'Specific session ID';
  }

  function deliveryChannelDisplayLabel(channelId: string): string {
    if (channelId === 'web') return locale.startsWith('de') ? 'Web-Chat' : 'Web chat';
    const channel = deliveryChannelOptions.find((candidate) => candidate.id === channelId);
    return channel?.label || channelId;
  }

  function deliveryTargetSummary(job: AutomationJobRecord): string {
    const channelId = job.deliveryMode === 'web' || job.deliveryMode === 'silent' ? 'web' : job.deliveryChannelId || 'web';
    return `${deliveryChannelDisplayLabel(channelId)} · ${deliverySessionModeLabel(job.deliverySessionMode)}`;
  }

  function renderAgentDeliveryControls(target: 'scheduled' | 'trigger' | 'customWebhook') {
    const state = target === 'trigger'
      ? triggerDraft
      : target === 'customWebhook'
        ? customWebhookDraft
        : draft;
    const isGerman = locale.startsWith('de');
    const selectedDeliveryChannel = getDeliveryChannelSelection(state);
    const visibleDeliveryChannelOptions = getVisibleDeliveryChannelOptions(deliveryChannelOptions, selectedDeliveryChannel);
    const selectedAgent = agentOptions.find((agent) => agent.agentId === state.agentId)
      || agentOptions.find((agent) => agent.agentId === DEFAULT_AGENT_ID)
      || agentOptions[0];
    const updateState = (patch: Partial<JobDraft & TriggerComposerDraft & CustomWebhookDraft>) => {
      if (target === 'trigger') {
        setTriggerDraft((current) => ({ ...current, ...patch }));
      } else if (target === 'customWebhook') {
        setCustomWebhookDraft((current) => ({ ...current, ...patch }));
      } else {
        setDraft((current) => ({ ...current, ...patch }));
      }
    };
    const updateDeliveryChannel = (value: string) => {
      updateState({
        deliveryMode: value === 'web' ? 'web' : 'channel_home',
        deliveryChannelId: value,
        deliveryChannelSessionKey: '',
      });
    };

    return (
      <div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-3">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Bot className="h-3.5 w-3.5" />
            {isGerman ? 'Agent' : 'Agent'}
          </span>
          <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-background px-2">
            <AgentAvatar iconId={selectedAgent?.iconId} className="h-6 w-6 rounded-sm border-0 bg-muted" iconClassName="h-3.5 w-3.5" />
            <select
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={state.agentId}
              onChange={(event) => updateState({ agentId: event.target.value })}
            >
              {agentOptions.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}{agent.removable ? '' : ' · System'}
                </option>
              ))}
            </select>
          </div>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Send className="h-3.5 w-3.5" />
            {isGerman ? 'Zielkanal' : 'Delivery channel'}
          </span>
          <select
            data-testid={`automation-${target}-delivery-channel`}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            value={selectedDeliveryChannel}
            onChange={(event) => {
              updateDeliveryChannel(event.target.value);
            }}
          >
            {visibleDeliveryChannelOptions.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {deliveryChannelDisplayLabel(channel.id)}{channel.connected ? '' : ` · ${isGerman ? 'nicht verbunden' : 'not connected'}`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{isGerman ? 'Session' : 'Session'}</span>
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            value={state.deliverySessionMode}
            onChange={(event) => updateState({ deliverySessionMode: event.target.value as AutomationDeliverySessionMode })}
          >
            {(['new_session', 'channel_active', 'fixed_session'] as AutomationDeliverySessionMode[]).map((mode) => (
              <option key={mode} value={mode}>{deliverySessionModeLabel(mode)}</option>
            ))}
          </select>
        </label>
        {state.deliverySessionMode === 'fixed_session' ? (
          <label className="flex min-w-0 flex-col gap-1 text-sm md:col-span-2">
            <span className="text-xs text-muted-foreground">{isGerman ? 'Sitzungs-ID' : 'Session ID'}</span>
            <input
              className="h-10 rounded-md border border-input bg-background px-3 font-mono text-xs"
              value={state.deliverySessionId}
              onChange={(event) => updateState({ deliverySessionId: event.target.value })}
              placeholder="pi-..."
            />
          </label>
        ) : null}
      </div>
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

  function openDirectoryPicker(target: 'scheduled' | 'trigger' | 'customWebhook') {
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

      {isDetailPage ? (
        selectedJob ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="outline" size="sm" asChild className="w-fit">
                <Link href="/automations">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t('overview.title')}
                </Link>
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void handleRunNow()} disabled={isRunningNow} data-testid="automation-run-now">
                  {isRunningNow ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                  {t('actions.runNow')}
                </Button>
                <Button onClick={() => void handleSave()} disabled={isSaving} data-testid="automation-save">
                  {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {t('actions.save')}
                </Button>
              </div>
            </div>

            <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
              <Card className="min-w-0 overflow-hidden">
                <CardHeader className="border-b">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-xl">{selectedJob.name}</CardTitle>
                    <CardDescription className="mt-2">{t('editor.description')}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 p-4 sm:p-6">
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                      <span className="text-xs text-muted-foreground">{t('editor.fields.name')}</span>
                      <input data-testid="automation-name" className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                      <span className="text-xs text-muted-foreground">{t('editor.fields.status')}</span>
                      <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as JobDraft['status'] }))}>
                        <option value="active">{t('jobStatus.active')}</option>
                        <option value="paused">{t('jobStatus.paused')}</option>
                      </select>
                    </label>
                  </div>
                  {renderWorkspaceSelector('scheduled')}
                  <label className="flex min-w-0 flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('editor.fields.prompt')}</span>
                    <AutomationPromptEditor
                      testId="automation-prompt"
                      heightClassName="h-48"
                      value={draft.prompt}
                      onChange={(value) => setDraft((current) => ({ ...current, prompt: value }))}
                    />
                  </label>
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                      <span className="text-xs text-muted-foreground">{t('editor.fields.workspaceContext')}</span>
                      <textarea data-testid="automation-context-paths" className="h-24 min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" value={draft.workspaceContextText} onChange={(event) => setDraft((current) => ({ ...current, workspaceContextText: event.target.value }))} placeholder="00_dashboard&#10;03_offer-and-sales" />
                    </label>
                    {renderSkillSelect('automation-preferred-skill')}
                  </div>
                  {renderAgentDeliveryControls('scheduled')}
                  <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{t('output.title')}</p>
                        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t('output.description')}</p>
                      </div>
                      <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => openDirectoryPicker('scheduled')} data-testid="automation-target-output-picker">
                        <Folder className="mr-2 h-4 w-4" />
                        {t('output.pickInWorkspace')}
                      </Button>
                    </div>
                    <input data-testid="automation-target-output-path" className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 font-mono text-xs" value={draft.targetOutputPath} onChange={(event) => setDraft((current) => ({ ...current, targetOutputPath: event.target.value }))} placeholder={t('output.placeholder')} />
                    <p className="break-all text-xs text-muted-foreground">{t('output.effectivePath')}: <span className="font-mono">{draftEffectiveTargetOutputPath || t('output.none')}</span></p>
                  </div>
                  {selectedJob.customWebhookId ? (
                    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 items-center gap-2">
                          <Webhook className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{t('triggers.custom.detailTitle')}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{t('triggers.custom.detailDescription')}</p>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRotateWebhookSecret()}
                          disabled={rotatingWebhookId === selectedJob.customWebhookId}
                        >
                          {rotatingWebhookId === selectedJob.customWebhookId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                          {t('triggers.custom.rotateSecret')}
                        </Button>
                      </div>
                      <div className="grid gap-2 text-xs sm:grid-cols-[8rem_minmax(0,1fr)_auto]">
                        <span className="text-muted-foreground">{t('triggers.custom.url')}</span>
                        <span className="min-w-0 break-all font-mono">{selectedJobWebhookUrl}</span>
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => void copyText(selectedJobWebhookUrl, t('triggers.custom.copiedUrl'))} aria-label={t('triggers.custom.copyUrl')}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <span className="text-muted-foreground">{t('triggers.custom.secret')}</span>
                        <span className="min-w-0 break-all font-mono">{selectedJobWebhookSecret || selectedJob.customWebhookSecretPreview || t('noneYet')}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => void copyText(selectedJobWebhookSecret, t('triggers.custom.copiedSecret'))}
                          disabled={!selectedJobWebhookSecret}
                          aria-label={t('triggers.custom.copySecret')}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {selectedJobWebhookSecret ? (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
                          {t('triggers.custom.secretOnce')}
                        </div>
                      ) : null}
                      <pre className="max-h-48 overflow-x-auto rounded-md border bg-background p-3 text-xs"><code>{`curl -X POST '${selectedJobWebhookUrl}' \\
  -H 'Authorization: Bearer ${selectedJobWebhookSecret || '<secret>'}' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: event-001' \\
  -d '{"event":"example","status":"ok"}'`}</code></pre>
                    </div>
                  ) : selectedJob.jobType === 'webhook' ? (
                    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                      <div className="flex items-center gap-2">
                        <Webhook className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm font-medium">{t('triggers.detailTitle')}</p>
                      </div>
                      <div className="grid gap-2 text-xs sm:grid-cols-2">
                        <span className="text-muted-foreground">{t('triggers.fields.app')}</span>
                        <span className="min-w-0 break-all font-mono">{selectedJob.composioToolkitSlug || t('noneYet')}</span>
                        <span className="text-muted-foreground">{t('triggers.fields.event')}</span>
                        <span className="min-w-0 break-all font-mono">{selectedJob.composioTriggerSlug || t('noneYet')}</span>
                        <span className="text-muted-foreground">{t('triggers.fields.triggerId')}</span>
                        <span className="min-w-0 break-all font-mono">{selectedJob.composioTriggerId || t('noneYet')}</span>
                      </div>
                    </div>
                  ) : (
                    <ScheduleEditor draft={draft} setDraft={setDraft} t={t} weekdayLabels={weekdayLabels} locale={locale} />
                  )}
                  <div className="flex flex-wrap gap-2 border-t pt-4">
                    <Button variant="outline" onClick={handleDelete} disabled={isDeleting}>
                      {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                      {t('actions.delete')}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="min-w-0 overflow-hidden">
                <CardHeader className="border-b">
                  <CardTitle className="text-base">{t('runs.title')}</CardTitle>
                  <CardDescription>{t('runs.description')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 p-4">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-sm">
                    <span className="text-muted-foreground">{t('editor.fields.status')}</span>
                    <Badge variant={selectedJob.status === 'active' ? 'default' : 'secondary'}>{t(`jobStatus.${selectedJob.status}`)}</Badge>
                    <span className="text-muted-foreground">{locale.startsWith('de') ? 'Workspace' : 'Workspace'}</span>
                    <span className="inline-flex min-w-0 max-w-[12rem] justify-end">
                      <Badge variant={selectedJob.workspaceType === 'team' ? 'default' : 'secondary'} className="truncate">
                        {selectedJobWorkspace?.name || selectedJob.workspaceId || workspaceScopeLabel(selectedJobWorkspace || { type: selectedJob.workspaceType }, locale)}
                      </Badge>
                    </span>
                    <span className="text-muted-foreground">{t('overview.nextRun')}</span>
                    <span className="text-right text-xs">{formatDateTime(selectedJob.nextRunAt, locale, t('scheduleSummary.notScheduled'))}</span>
                    <span className="text-muted-foreground">{t('schedule.fields.kind')}</span>
                    <span className="min-w-0 max-w-[12rem] truncate text-right text-xs">{describeFriendlyScheduleLocalized(selectedJob.schedule, t, weekdayLabels)}</span>
                    <span className="text-muted-foreground">{t('schedule.fields.timeZone')}</span>
                    <span className="min-w-0 max-w-[12rem] truncate text-right font-mono text-xs">{selectedJob.schedule.timeZone}</span>
                    <span className="text-muted-foreground">{t('results.title')}</span>
                    <span className="min-w-0 max-w-[12rem] truncate text-right font-mono text-xs">{selectedJob.effectiveTargetOutputPath || t('output.none')}</span>
                    <span className="text-muted-foreground">{locale.startsWith('de') ? 'Agent' : 'Agent'}</span>
                    <span className="inline-flex min-w-0 max-w-[12rem] items-center justify-end gap-1 truncate text-right text-xs">
                      <AgentIcon iconId={agentOptions.find((agent) => agent.agentId === selectedJob.agentId)?.iconId} className="h-3 w-3 shrink-0" />
                      <span className="truncate">{agentOptions.find((agent) => agent.agentId === selectedJob.agentId)?.name || selectedJob.agentId}</span>
                    </span>
                    <span className="text-muted-foreground">{locale.startsWith('de') ? 'Ziel' : 'Target'}</span>
                    <span className="min-w-0 max-w-[12rem] truncate text-right text-xs">{deliveryTargetSummary(selectedJob)}</span>
                  </div>
                  <div className="space-y-2" data-testid="automation-run-list">
                    {isRefreshingRuns && runs.length === 0 ? (
                      <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('runs.loading')}
                      </div>
                    ) : runs.length === 0 ? (
                      <div className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">{t('runs.empty')}</div>
                    ) : (
                      runs.slice(0, 10).map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          className={`w-full min-w-0 rounded-md border p-3 text-left transition ${selectedRunId === run.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}
                          onClick={() => {
                            setSelectedRunId(run.id);
                            setIsRunSheetOpen(true);
                          }}
                          data-testid={`automation-run-${run.id}`}
                        >
                          <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-sm font-medium">{formatRunStatus(run.status, t)}</span>
                            <span className="text-xs text-muted-foreground">{formatDateTime(run.finishedAt || run.scheduledFor, locale, t('scheduleSummary.notScheduled'))}</span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{formatTriggerType(run.triggerType, t)} · {t('runs.attempt', { count: run.attemptNumber })}</p>
                          {run.resultText ? <p className="mt-2 line-clamp-2 break-words text-xs text-muted-foreground">{run.resultText}</p> : null}
                          {run.errorMessage ? <p className="mt-2 line-clamp-2 break-words text-xs text-destructive">{run.errorMessage}</p> : null}
                        </button>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : (
          <Card>
            <CardContent className="flex min-h-[24rem] flex-col items-center justify-center gap-4 p-8 text-center">
              {isLoadingJobs ? <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /> : <Sparkles className="h-8 w-8 text-muted-foreground" />}
              <div>
                <p className="font-medium">{isLoadingJobs ? t('overview.loading') : t('overview.emptySelectionTitle')}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('overview.emptySelectionDescription')}</p>
              </div>
              <Button asChild variant="outline">
                <Link href="/automations">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t('overview.title')}
                </Link>
              </Button>
            </CardContent>
          </Card>
        )
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              { label: t('overview.total'), value: overviewStats.total, icon: CalendarClock },
              { label: t('jobStatus.active'), value: overviewStats.active, icon: CheckCircle2 },
              { label: t('jobStatus.paused'), value: overviewStats.paused, icon: PauseCircle },
              { label: t('overview.groups.running'), value: overviewStats.running, icon: Play },
              { label: t('overview.groups.needsAttention'), value: overviewStats.failed, icon: AlertTriangle },
            ].map((stat) => {
              const StatIcon = stat.icon;
              return (
                <Card key={stat.label} className="min-w-0">
                  <CardContent className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="truncate text-xs text-muted-foreground">{stat.label}</p>
                      <p className="mt-1 text-2xl font-semibold">{stat.value}</p>
                    </div>
                    <StatIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="border-b">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{t('overview.title')}</CardTitle>
                  <CardDescription>{jobs.length} {t('overview.total').toLowerCase()}</CardDescription>
                </div>
                {isLoadingJobs ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
              </div>
            </CardHeader>
            <CardContent className="p-3 sm:p-4">
              <div className="space-y-4" data-testid="automation-job-list">
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
                        <div className="space-y-2">
                          {group.jobs.map((job) => (
                            <article key={job.id} className="min-w-0 rounded-md border bg-background p-3" data-testid={`automation-job-${job.id}`}>
                              <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                <div className="min-w-0">
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <p className="min-w-0 truncate text-sm font-medium">{job.name}</p>
                                    <Badge variant={job.status === 'active' ? 'default' : 'secondary'} className="shrink-0">{t(`jobStatus.${job.status}`)}</Badge>
                                    <Badge variant={job.workspaceType === 'team' ? 'default' : 'outline'} className="shrink-0">
                                      {workspaceById.get(job.workspaceId || '')?.name || workspaceScopeLabel({ type: job.workspaceType }, locale)}
                                    </Badge>
                                  </div>
                                  <div className="mt-1 max-h-[2.5em] overflow-hidden text-xs text-muted-foreground">
                                    <MarkdownRenderer content={job.prompt} variant="muted" />
                                  </div>
                                  <div className="mt-3 grid min-w-0 gap-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                                    <span className="min-w-0 truncate">{describeFriendlyScheduleLocalized(job.schedule, t, weekdayLabels)}</span>
                                    <span className="min-w-0 truncate">{t('overview.nextRun')}: {formatDateTime(job.nextRunAt, locale, t('scheduleSummary.notScheduled'))}</span>
                                    <span className="min-w-0 truncate">{t('runs.finishedAt')}: {formatDateTime(job.lastRunAt, locale, t('scheduleSummary.notScheduled'))}</span>
                                    <span className="min-w-0 truncate">{t('results.title')}: {job.effectiveTargetOutputPath || t('output.none')}</span>
                                  </div>
                                </div>
                                <Button asChild size="sm" className="w-full md:w-auto">
                                  <Link href={`/automations/${job.id}`}>{t('runDetails.details')}</Link>
                                </Button>
                              </div>
                            </article>
                          ))}
                        </div>
                      </section>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

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
                  {renderWorkspaceSelector('scheduled')}
                  <input data-testid="automation-name" className="h-11 w-full rounded-md border border-input bg-background px-3 text-base font-medium" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t('editor.placeholders.name')} />
                  <AutomationPromptEditor
                    testId="automation-prompt"
                    heightClassName="h-[18rem] w-full"
                    value={draft.prompt}
                    onChange={(value) => setDraft((current) => ({ ...current, prompt: value }))}
                  />
                  <ScheduleEditor draft={draft} setDraft={setDraft} t={t} weekdayLabels={weekdayLabels} locale={locale} compact />
                  {renderAgentDeliveryControls('scheduled')}
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
                  <p className="break-all text-xs text-muted-foreground">{t('output.effectivePath')}: <span className="font-mono">{draftEffectiveTargetOutputPath || t('output.none')}</span></p>
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
                  <div className="grid grid-cols-2 rounded-md border bg-muted/20 p-1">
                    <button
                      type="button"
                      className={cn(
                        'flex min-h-10 items-center justify-center gap-2 rounded-sm px-3 text-sm font-medium transition',
                        triggerSource === 'custom' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => setTriggerSource('custom')}
                    >
                      <Webhook className="h-4 w-4" />
                      {t('triggers.custom.tab')}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'flex min-h-10 items-center justify-center gap-2 rounded-sm px-3 text-sm font-medium transition',
                        triggerSource === 'composio' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => setTriggerSource('composio')}
                    >
                      <Plug className="h-4 w-4" />
                      {t('triggers.composioTab')}
                    </button>
                  </div>
                  {triggerSource === 'custom' ? (
                    <>
                      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">{t('triggers.custom.hintTitle')}</p>
                        <p className="mt-1">{t('triggers.custom.hintDescription')}</p>
                      </div>
                      <input
                        className="h-11 w-full rounded-md border border-input bg-background px-3 text-base font-medium"
                        value={customWebhookDraft.name}
                        onChange={(event) => setCustomWebhookDraft((current) => ({ ...current, name: event.target.value }))}
                        placeholder={t('triggers.custom.placeholders.name')}
                      />
                      {renderWorkspaceSelector('customWebhook')}
                      <AutomationPromptEditor
                        heightClassName="h-[14rem] w-full"
                        value={customWebhookDraft.prompt}
                        onChange={(value) => setCustomWebhookDraft((current) => ({ ...current, prompt: value }))}
                      />
                      {renderAgentDeliveryControls('customWebhook')}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-xs text-muted-foreground">{t('editor.fields.workspaceContext')}</span>
                          <textarea
                            className="h-24 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                            value={customWebhookDraft.workspaceContextText}
                            onChange={(event) => setCustomWebhookDraft((current) => ({ ...current, workspaceContextText: event.target.value }))}
                            placeholder="00_dashboard&#10;03_offer-and-sales"
                          />
                        </label>
                        {renderCustomWebhookSkillSelect('automation-custom-webhook-preferred-skill')}
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                          <span className="text-xs text-muted-foreground">{t('triggers.fields.targetOutputPath')}</span>
                          <input
                            className="h-10 rounded-md border border-input bg-background px-3 font-mono text-xs"
                            value={customWebhookDraft.targetOutputPath}
                            onChange={(event) => setCustomWebhookDraft((current) => ({ ...current, targetOutputPath: event.target.value }))}
                            placeholder={t('triggers.optional')}
                          />
                        </label>
                        <Button type="button" variant="outline" className="justify-start" onClick={() => openDirectoryPicker('customWebhook')}>
                          <Folder className="mr-2 h-4 w-4" />
                          {t('output.pickInWorkspace')}
                        </Button>
                        <Button onClick={() => void handleCreateCustomWebhookAutomation()} disabled={isSaving || !customWebhookDraft.name.trim() || !customWebhookDraft.prompt.trim()}>
                          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                          {t('triggers.custom.create')}
                        </Button>
                      </div>
                    </>
                  ) : isLoadingTriggerApps ? (
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
                      {renderWorkspaceSelector('trigger')}
                      <input className="h-11 w-full rounded-md border border-input bg-background px-3 text-base font-medium" value={triggerDraft.name} onChange={(event) => setTriggerDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t('triggers.placeholders.name')} />
                      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">{t('triggers.promptHintTitle')}</p>
                        <p className="mt-1">{t('triggers.promptHintDescription')}</p>
                      </div>
                      <AutomationPromptEditor
                        heightClassName="h-[14rem] w-full"
                        value={triggerDraft.prompt}
                        onChange={(value) => setTriggerDraft((current) => ({ ...current, prompt: value }))}
                      />
                      <TriggerConfigFields
                        schema={selectedTriggerType?.configSchema || null}
                        values={triggerDraft.configValues}
                        onChange={(key, value) => setTriggerDraft((current) => ({ ...current, configValues: { ...current.configValues, [key]: value } }))}
                        emptyLabel={t('triggers.noConfig')}
                      />
                      {renderAgentDeliveryControls('trigger')}
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
                    <p className="font-medium text-foreground">{triggerSource === 'custom' ? t('triggers.custom.sidebarTitle') : t('triggers.sidebarWebhookTitle')}</p>
                    <p className="mt-1">{triggerSource === 'custom' ? t('triggers.custom.sidebarDescription') : t('triggers.sidebarWebhookDescription')}</p>
                  </div>
                  <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">{triggerSource === 'custom' ? t('triggers.custom.sidebarSecretTitle') : t('triggers.sidebarModesTitle')}</p>
                    <p className="mt-1">{triggerSource === 'custom' ? t('triggers.custom.sidebarSecretDescription') : t('triggers.sidebarModesDescription')}</p>
                  </div>
                </aside>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Sheet open={isRunSheetOpen} onOpenChange={setIsRunSheetOpen}>
        <SheetContent className="w-full overflow-hidden sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{selectedRun ? formatRunStatus(selectedRun.status, t) : t('runs.title')}</SheetTitle>
            <SheetDescription>{selectedRun ? formatDateTime(selectedRun.finishedAt || selectedRun.scheduledFor, locale, t('scheduleSummary.notScheduled')) : t('runs.description')}</SheetDescription>
          </SheetHeader>
          <Tabs defaultValue="summary" className="min-h-0 flex-1 overflow-hidden px-4 pb-4">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="summary"><FileText className="mr-2 h-4 w-4" />{t('runDetails.summary')}</TabsTrigger>
              <TabsTrigger value="logs"><Clock3 className="mr-2 h-4 w-4" />{t('logs.title')}</TabsTrigger>
              <TabsTrigger value="session"><MessageSquare className="mr-2 h-4 w-4" />{t('session.title')}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="mt-4 min-w-0 space-y-4 overflow-y-auto pb-2">
              {selectedRun ? (
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-md border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t('editor.fields.status')}</p>
                    <Badge className="mt-2" variant={selectedRun.status === 'success' ? 'default' : selectedRun.status === 'failed' ? 'destructive' : 'secondary'}>{formatRunStatus(selectedRun.status, t)}</Badge>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t('runs.triggeredBy')}</p>
                    <p className="mt-2 text-sm font-medium">{formatTriggerType(selectedRun.triggerType, t)} · {t('runs.attempt', { count: selectedRun.attemptNumber })}</p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t('runs.scheduledFor')}</p>
                    <p className="mt-2 text-sm font-medium">{formatDateTime(selectedRun.scheduledFor, locale, t('scheduleSummary.notScheduled'))}</p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t('runs.finishedAt')}</p>
                    <p className="mt-2 text-sm font-medium">{formatDateTime(selectedRun.finishedAt, locale, t('scheduleSummary.notScheduled'))}</p>
                  </div>
                </div>
              ) : null}
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
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground" data-testid="automation-workspace-target">{selectedRun?.effectiveTargetOutputPath || selectedJob?.effectiveTargetOutputPath || t('output.none')}</p>
              </div>
              <div className="rounded-md border bg-background p-3 text-sm">
                <p className="font-medium">{t('runDetails.result')}</p>
                <div data-testid="automation-result-text">
                  <MarkdownRenderer content={selectedRun?.resultText || t('runDetails.noResult')} variant="muted" className="mt-2 min-w-0 overflow-x-auto" />
                </div>
              </div>
              {selectedRun?.piSessionId ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={toChatUrl(selectedRun.piSessionId)} data-testid="automation-open-chat-session">
                    <MessageSquare className="mr-2 h-4 w-4" />
                    {t('session.openChat')}
                  </Link>
                </Button>
              ) : null}
              {selectedRun?.errorMessage ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{selectedRun.errorMessage}</p> : null}
            </TabsContent>
            <TabsContent value="logs" className="mt-4 min-w-0">
              <ScrollArea className="h-[calc(100dvh-15rem)] rounded-md border bg-background" data-testid="automation-log-scroll">
                <pre className="min-h-full min-w-0 whitespace-pre-wrap break-words p-3 text-xs" data-testid="automation-log-content">{logContent || t('logs.empty')}</pre>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="session" className="mt-4 min-w-0">
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
                  <div className="min-w-0 space-y-3 p-3">
                    {sessionMessages.map((message, index) => {
                      const content = extractAutomationSessionMessageText(message);
                      return (
                        <div key={message.id?.toString() || `${message.role}-${index}`} className="min-w-0 rounded-md border bg-muted/30 px-3 py-2" data-testid="automation-session-message">
                          <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">{formatAutomationSessionRole(message.role, t)}</p>
                          <MarkdownRenderer content={content || t('session.emptyMessage')} variant="muted" className="min-w-0 overflow-x-auto" />
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
        workspaceId={
          directoryPickerTarget === 'trigger'
            ? triggerDraft.workspaceId || defaultAutomationWorkspaceId
            : directoryPickerTarget === 'customWebhook'
              ? customWebhookDraft.workspaceId || defaultAutomationWorkspaceId
              : draft.workspaceId || defaultAutomationWorkspaceId
        }
        selectedPath={
          directoryPickerTarget === 'trigger'
            ? triggerDraft.targetOutputPath
            : directoryPickerTarget === 'customWebhook'
              ? customWebhookDraft.targetOutputPath
              : draft.targetOutputPath
        }
        onSelect={(path) => {
          if (directoryPickerTarget === 'trigger') {
            setTriggerDraft((current) => ({ ...current, targetOutputPath: path }));
          } else if (directoryPickerTarget === 'customWebhook') {
            setCustomWebhookDraft((current) => ({ ...current, targetOutputPath: path }));
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
  locale,
  setDraft,
  t,
  weekdayLabels,
  compact = false,
}: {
  draft: JobDraft;
  locale: string;
  setDraft: Dispatch<SetStateAction<JobDraft>>;
  t: (key: string, values?: Record<string, string | number>) => string;
  weekdayLabels: Record<AutomationWeekday, string>;
  compact?: boolean;
}) {
  const isGerman = locale.startsWith('de');
  const timeZoneOptions = useMemo(() => getSupportedTimeZones(draft.timeZone), [draft.timeZone]);

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <Clock3 className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-medium">{t('schedule.title')}</p>
      </div>
      <div className={`grid gap-4 ${compact ? 'sm:grid-cols-3' : 'md:grid-cols-4'}`}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t('schedule.fields.kind')}</span>
          <select data-testid="automation-schedule-kind" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draft.scheduleKind} onChange={(event) => setDraft((current) => ({ ...current, scheduleKind: event.target.value as ScheduleKind }))}>
            <option value="once">{t('schedule.kind.once')}</option>
            <option value="daily">{t('schedule.kind.daily')}</option>
            <option value="weekly">{t('schedule.kind.weekly')}</option>
            <option value="interval">{t('schedule.kind.interval')}</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t('schedule.fields.timeZone')}</span>
          <select
            data-testid="automation-time-zone"
            className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm"
            value={draft.timeZone}
            onChange={(event) => setDraft((current) => ({ ...current, timeZone: event.target.value }))}
          >
            {timeZoneOptions.map((timeZone) => (
              <option key={timeZone} value={timeZone}>
                {formatTimeZoneLabel(timeZone, { isGerman })}
              </option>
            ))}
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
