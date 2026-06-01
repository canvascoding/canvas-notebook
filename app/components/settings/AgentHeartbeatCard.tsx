'use client';

import { Clock3, FileText, Heart, Loader2, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { AgentSettingsAccordionCard } from './AgentSettingsAccordionCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditor';
import type {
  AutomationDeliveryMode,
  AutomationDeliverySessionMode,
  AutomationIntervalUnit,
  AutomationRunStatus,
  AutomationWeekday,
  FriendlySchedule,
} from '@/app/lib/automations/types';

export type AgentHeartbeatConfig = {
  configured: boolean;
  enabled: boolean;
  agentId: string;
  schedule: FriendlySchedule | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
  jobId: string | null;
  deliveryMode: AutomationDeliveryMode;
  deliveryChannelId: string | null;
  deliverySessionMode: AutomationDeliverySessionMode;
  deliverySessionId: string | null;
  deliveryChannelSessionKey: string | null;
};

export type AgentHeartbeatScheduleKind = 'daily' | 'weekly' | 'interval';

export type AgentHeartbeatScheduleDraft = {
  kind: AgentHeartbeatScheduleKind;
  timeZone: string;
  dailyTime: string;
  weeklyTime: string;
  weeklyDays: AutomationWeekday[];
  intervalEvery: string;
  intervalUnit: AutomationIntervalUnit;
  workingHoursEnabled: boolean;
  workingHoursDays: AutomationWeekday[];
  workingHoursStart: string;
  workingHoursEnd: string;
  workingHoursTimeZone: string;
};

export type AgentHeartbeatDeliveryDraft = {
  deliveryMode: AutomationDeliveryMode;
  deliveryChannelId: string;
  deliverySessionMode: AutomationDeliverySessionMode;
  deliverySessionId: string;
};

export type AgentHeartbeatDeliveryChannelOption = {
  id: string;
  label: string;
  connected: boolean;
  running: boolean;
};

type AgentHeartbeatCardProps = {
  config: AgentHeartbeatConfig | null;
  scheduleDraft: AgentHeartbeatScheduleDraft;
  deliveryDraft: AgentHeartbeatDeliveryDraft;
  deliveryChannels: AgentHeartbeatDeliveryChannelOption[];
  isOpen: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  heartbeatFileDraft: string;
  heartbeatFileLoading: boolean;
  heartbeatFileSaving: boolean;
  heartbeatFileResetting: boolean;
  heartbeatFileError: string | null;
  heartbeatFileSuccess: string | null;
  heartbeatResetDialogOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
  onScheduleDraftChange: (patch: Partial<AgentHeartbeatScheduleDraft>) => void;
  onDeliveryDraftChange: (patch: Partial<AgentHeartbeatDeliveryDraft>) => void;
  onSave: () => void;
  onReload: () => void;
  onHeartbeatFileDraftChange: (value: string) => void;
  onSaveHeartbeatFile: () => void;
  onReloadHeartbeatFile: () => void;
  onOpenHeartbeatResetDialog: () => void;
  onHeartbeatResetDialogOpenChange: (open: boolean) => void;
  onClearHeartbeatResetDialog: () => void;
  onResetHeartbeatFile: () => void;
};

const WEEKDAYS: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const RECOMMENDED_TIME_ZONES = [
  'Europe/Berlin',
  'Europe/Vienna',
  'Europe/Zurich',
  'Europe/Amsterdam',
  'Europe/Paris',
  'Europe/London',
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];
const FALLBACK_TIME_ZONES = [
  ...RECOMMENDED_TIME_ZONES,
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'America/Chicago',
  'America/Toronto',
  'America/Sao_Paulo',
  'Asia/Bangkok',
  'Asia/Hong_Kong',
  'Asia/Kolkata',
  'Pacific/Auckland',
];

type TimeZoneOptionGroups = {
  recommended: string[];
  all: string[];
};

function getSupportedTimeZones(currentTimeZone?: string): TimeZoneOptionGroups {
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  };
  const supportedValues = intlWithSupportedValues.supportedValuesOf?.('timeZone') ?? FALLBACK_TIME_ZONES;
  const allValues = new Set<string>([...supportedValues, ...FALLBACK_TIME_ZONES]);
  if (currentTimeZone) {
    allValues.add(currentTimeZone);
  }

  const recommended = RECOMMENDED_TIME_ZONES.filter((timeZone) => allValues.has(timeZone));
  const all = Array.from(allValues)
    .filter((timeZone) => !recommended.includes(timeZone))
    .sort((left, right) => left.localeCompare(right));

  return { recommended, all };
}

function formatTimeZoneOffset(timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value.replace('GMT', 'UTC') ?? null;
  } catch {
    return null;
  }
}

function formatTimeZoneLabel(timeZone: string, isGerman: boolean): string {
  const offset = formatTimeZoneOffset(timeZone);
  const city = timeZone.includes('/') ? timeZone.split('/').slice(1).join('/').replace(/_/g, ' ') : timeZone;
  const label = isGerman ? city.replace('Vienna', 'Wien') : city;
  return offset ? `${timeZone} (${offset}, ${label})` : timeZone;
}

function formatDate(value: string | null, locale: string, emptyLabel: string): string {
  if (!value) return emptyLabel;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
  } catch {
    return value;
  }
}

function deliverySessionModeLabel(mode: AutomationDeliverySessionMode, isGerman: boolean): string {
  if (mode === 'new_session') return isGerman ? 'Neue Sitzung' : 'New session';
  if (mode === 'channel_active') return isGerman ? 'Aktive Sitzung im gewählten Kanal' : 'Active session in selected channel';
  return isGerman ? 'Bestimmte Sitzungs-ID' : 'Specific session ID';
}

export function AgentHeartbeatCard({
  config,
  scheduleDraft,
  deliveryDraft,
  deliveryChannels,
  isOpen,
  loading,
  saving,
  error,
  success,
  heartbeatFileDraft,
  heartbeatFileLoading,
  heartbeatFileSaving,
  heartbeatFileResetting,
  heartbeatFileError,
  heartbeatFileSuccess,
  heartbeatResetDialogOpen,
  onOpenChange,
  onEnabledChange,
  onScheduleDraftChange,
  onDeliveryDraftChange,
  onSave,
  onReload,
  onHeartbeatFileDraftChange,
  onSaveHeartbeatFile,
  onReloadHeartbeatFile,
  onOpenHeartbeatResetDialog,
  onHeartbeatResetDialogOpenChange,
  onClearHeartbeatResetDialog,
  onResetHeartbeatFile,
}: AgentHeartbeatCardProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const isGerman = locale.startsWith('de');
  const enabled = config?.enabled ?? false;
  const controlsDisabled = saving || !enabled;
  const workingHoursControlsDisabled = controlsDisabled || !scheduleDraft.workingHoursEnabled;
  const selectedDeliveryChannel = deliveryDraft.deliveryMode === 'last_active'
    ? 'last_active'
    : deliveryDraft.deliveryMode === 'web' ? 'web' : deliveryDraft.deliveryChannelId || 'web';
  const connectedChannelOptions = deliveryChannels.length > 0
    ? deliveryChannels
    : [{ id: 'web', label: isGerman ? 'Web-Chat' : 'Web chat', connected: true, running: true }];
  const channelOptions = [
    {
      id: 'last_active',
      label: t('agentPanel.heartbeat.lastActiveChannel'),
      connected: true,
      running: true,
    },
    ...connectedChannelOptions.filter((channel) => channel.id !== 'last_active'),
  ];
  const scheduleTimeZoneOptions = getSupportedTimeZones(scheduleDraft.timeZone);
  const workingHoursTimeZoneOptions = getSupportedTimeZones(scheduleDraft.workingHoursTimeZone);

  const summaryItems = [
    loading
      ? t('agentPanel.heartbeat.loadingSummary')
      : enabled
        ? t('agentPanel.heartbeat.enabledSummary')
        : t('agentPanel.heartbeat.disabledSummary'),
    config?.nextRunAt ? t('agentPanel.heartbeat.nextRunSummary', { value: formatDate(config.nextRunAt, locale, t('agentPanel.heartbeat.never')) }) : null,
    error ? t('agentPanel.heartbeat.errorSummary') : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <>
      <AgentSettingsAccordionCard
        title={t('agentPanel.heartbeat.title')}
        description={t('agentPanel.heartbeat.description')}
        icon={Heart}
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        summaryItems={summaryItems}
        contentClassName="space-y-4"
      >
        {loading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('agentPanel.heartbeat.loading')}
          </div>
        ) : (
          <>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-primary">{success}</p>}

          <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('agentPanel.heartbeat.enableLabel')}</p>
              <p className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.enableDescription')}</p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={onEnabledChange}
              disabled={saving}
              aria-label={t('agentPanel.heartbeat.enableLabel')}
            />
          </div>
          {!enabled && (
            <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              {t('agentPanel.heartbeat.disabledSettingsHint')}
            </p>
          )}

          <div className={`space-y-3 rounded-md border bg-muted/20 p-3 ${controlsDisabled ? 'opacity-60' : ''}`} aria-disabled={controlsDisabled}>
            <div className="flex items-center gap-2">
              <Heart className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium">{t('agentPanel.heartbeat.scheduleTitle')}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.scheduleKindLabel')}</span>
                <select
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={scheduleDraft.kind}
                  onChange={(event) => onScheduleDraftChange({ kind: event.target.value as AgentHeartbeatScheduleKind })}
                  disabled={controlsDisabled}
                >
                  <option value="daily">{t('agentPanel.heartbeat.daily')}</option>
                  <option value="weekly">{t('agentPanel.heartbeat.weekly')}</option>
                  <option value="interval">{t('agentPanel.heartbeat.interval')}</option>
                </select>
              </label>

              {scheduleDraft.kind === 'daily' && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.timeLabel')}</span>
                  <Input
                    type="time"
                    value={scheduleDraft.dailyTime}
                    onChange={(event) => onScheduleDraftChange({ dailyTime: event.target.value })}
                    disabled={controlsDisabled}
                  />
                </label>
              )}

              {scheduleDraft.kind === 'interval' && (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.intervalEveryLabel')}</span>
                    <Input
                      type="number"
                      min={1}
                      value={scheduleDraft.intervalEvery}
                      onChange={(event) => onScheduleDraftChange({ intervalEvery: event.target.value })}
                      disabled={controlsDisabled}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.intervalUnitLabel')}</span>
                    <select
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={scheduleDraft.intervalUnit}
                      onChange={(event) => onScheduleDraftChange({ intervalUnit: event.target.value as AutomationIntervalUnit })}
                      disabled={controlsDisabled}
                    >
                      <option value="minutes">{t('agentPanel.heartbeat.minutes')}</option>
                      <option value="hours">{t('agentPanel.heartbeat.hours')}</option>
                      <option value="days">{t('agentPanel.heartbeat.days')}</option>
                    </select>
                  </label>
                </>
              )}

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.timezone')}</span>
                <select
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={scheduleDraft.timeZone}
                  onChange={(event) => onScheduleDraftChange({ timeZone: event.target.value })}
                  disabled={controlsDisabled}
                >
                  <optgroup label={t('agentPanel.heartbeat.recommendedTimeZones')}>
                    {scheduleTimeZoneOptions.recommended.map((timeZone) => (
                      <option key={timeZone} value={timeZone}>
                        {formatTimeZoneLabel(timeZone, isGerman)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('agentPanel.heartbeat.allTimeZones')}>
                    {scheduleTimeZoneOptions.all.map((timeZone) => (
                      <option key={timeZone} value={timeZone}>
                        {formatTimeZoneLabel(timeZone, isGerman)}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
            </div>

            {scheduleDraft.kind === 'weekly' && (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap">
                  {WEEKDAYS.map((day) => {
                    const selected = scheduleDraft.weeklyDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        className={`min-h-10 rounded-md border px-3 py-2 text-sm ${selected ? 'border-primary bg-primary/10' : 'border-border bg-background'}`}
                        onClick={() => onScheduleDraftChange({
                          weeklyDays: selected
                            ? scheduleDraft.weeklyDays.filter((entry) => entry !== day)
                            : [...scheduleDraft.weeklyDays, day],
                        })}
                        disabled={controlsDisabled}
                      >
                        {t(`agentPanel.heartbeat.weekdayLabels.${day}`)}
                      </button>
                    );
                  })}
                </div>
                <label className="flex max-w-xs flex-col gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.timeLabel')}</span>
                  <Input
                    type="time"
                    value={scheduleDraft.weeklyTime}
                    onChange={(event) => onScheduleDraftChange({ weeklyTime: event.target.value })}
                    disabled={controlsDisabled}
                  />
                </label>
              </div>
            )}
          </div>

          <div className={`space-y-3 rounded-md border bg-muted/20 p-3 ${controlsDisabled ? 'opacity-60' : ''}`} aria-disabled={controlsDisabled}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2">
                <Clock3 className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('agentPanel.heartbeat.workingHoursTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.workingHoursDescription')}</p>
                </div>
              </div>
              <Switch
                checked={scheduleDraft.workingHoursEnabled}
                onCheckedChange={(checked) => onScheduleDraftChange({ workingHoursEnabled: checked })}
                disabled={controlsDisabled}
                aria-label={t('agentPanel.heartbeat.workingHoursToggle')}
              />
            </div>

            <div className="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap">
              {WEEKDAYS.map((day) => {
                const selected = scheduleDraft.workingHoursDays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={`min-h-10 rounded-md border px-3 py-2 text-sm ${selected ? 'border-primary bg-primary/10' : 'border-border bg-background'}`}
                    onClick={() => onScheduleDraftChange({
                      workingHoursDays: selected
                        ? scheduleDraft.workingHoursDays.filter((entry) => entry !== day)
                        : [...scheduleDraft.workingHoursDays, day],
                    })}
                    disabled={workingHoursControlsDisabled}
                  >
                    {t(`agentPanel.heartbeat.weekdayLabels.${day}`)}
                  </button>
                );
              })}
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.workingHoursStart')}</span>
                <Input
                  type="time"
                  value={scheduleDraft.workingHoursStart}
                  onChange={(event) => onScheduleDraftChange({ workingHoursStart: event.target.value })}
                  disabled={workingHoursControlsDisabled}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.workingHoursEnd')}</span>
                <Input
                  type="time"
                  value={scheduleDraft.workingHoursEnd}
                  onChange={(event) => onScheduleDraftChange({ workingHoursEnd: event.target.value })}
                  disabled={workingHoursControlsDisabled}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.timezone')}</span>
                <select
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={scheduleDraft.workingHoursTimeZone}
                  onChange={(event) => onScheduleDraftChange({ workingHoursTimeZone: event.target.value })}
                  disabled={workingHoursControlsDisabled}
                >
                  <optgroup label={t('agentPanel.heartbeat.recommendedTimeZones')}>
                    {workingHoursTimeZoneOptions.recommended.map((timeZone) => (
                      <option key={timeZone} value={timeZone}>
                        {formatTimeZoneLabel(timeZone, isGerman)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('agentPanel.heartbeat.allTimeZones')}>
                    {workingHoursTimeZoneOptions.all.map((timeZone) => (
                      <option key={timeZone} value={timeZone}>
                        {formatTimeZoneLabel(timeZone, isGerman)}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
            </div>
          </div>

          <div className={`grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-3 ${controlsDisabled ? 'opacity-60' : ''}`} aria-disabled={controlsDisabled}>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.deliveryChannel')}</span>
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={selectedDeliveryChannel}
                onChange={(event) => {
                  const channelId = event.target.value;
                  if (channelId === 'last_active') {
                    onDeliveryDraftChange({
                      deliveryMode: 'last_active',
                      deliveryChannelId: 'last_active',
                      deliverySessionMode: 'channel_active',
                    });
                    return;
                  }
                  onDeliveryDraftChange({
                    deliveryMode: channelId === 'web' ? 'web' : 'channel_home',
                    deliveryChannelId: channelId,
                  });
                }}
                disabled={controlsDisabled}
              >
                {channelOptions.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.label}{channel.connected ? '' : ` - ${t('agentPanel.heartbeat.notConnected')}`}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.deliverySession')}</span>
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={deliveryDraft.deliverySessionMode}
                onChange={(event) => onDeliveryDraftChange({ deliverySessionMode: event.target.value as AutomationDeliverySessionMode })}
                disabled={controlsDisabled}
              >
                {(['new_session', 'channel_active', 'fixed_session'] as AutomationDeliverySessionMode[]).map((mode) => (
                  <option key={mode} value={mode}>{deliverySessionModeLabel(mode, isGerman)}</option>
                ))}
              </select>
            </label>

            {deliveryDraft.deliverySessionMode === 'fixed_session' && (
              <label className="flex min-w-0 flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.sessionId')}</span>
                <Input
                  className="font-mono text-xs"
                  value={deliveryDraft.deliverySessionId}
                  onChange={(event) => onDeliveryDraftChange({ deliverySessionId: event.target.value })}
                  placeholder="pi-..."
                  disabled={controlsDisabled}
                />
              </label>
            )}
          </div>

          <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <span>{t('agentPanel.heartbeat.nextRun')}: {formatDate(config?.nextRunAt ?? null, locale, t('agentPanel.heartbeat.never'))}</span>
            <span>{t('agentPanel.heartbeat.lastRun')}: {formatDate(config?.lastRunAt ?? null, locale, t('agentPanel.heartbeat.never'))}{config?.lastRunStatus ? ` (${config.lastRunStatus})` : ''}</span>
          </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={onSave} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {t('agentPanel.heartbeat.save')}
              </Button>
              <Button type="button" variant="outline" onClick={onReload} disabled={loading || saving}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('agentPanel.heartbeat.reload')}
              </Button>
            </div>

            <div className={`space-y-3 rounded-md border bg-muted/20 p-3 ${controlsDisabled ? 'opacity-60' : ''}`} aria-disabled={controlsDisabled}>
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('agentPanel.heartbeat.fileTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.fileDescription')}</p>
                </div>
              </div>

              {heartbeatFileLoading ? (
                <div className="flex items-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('agentPanel.heartbeat.fileLoading')}
                </div>
              ) : (
                <>
                  <div
                    data-testid="agent-heartbeat-file-editor"
                    className="relative h-[400px] overflow-hidden rounded-md border border-input bg-background"
                  >
                    <MarkdownEditor
                      value={heartbeatFileDraft}
                      onChange={onHeartbeatFileDraftChange}
                    />
                    {controlsDisabled && (
                      <div
                        className="absolute inset-0 cursor-not-allowed bg-background/55"
                        aria-label={t('agentPanel.heartbeat.disabledSettingsHint')}
                      />
                    )}
                  </div>

                  {heartbeatFileError && <p className="text-sm text-destructive">{heartbeatFileError}</p>}
                  {heartbeatFileSuccess && <p className="text-sm text-primary">{heartbeatFileSuccess}</p>}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={onSaveHeartbeatFile}
                      disabled={controlsDisabled || heartbeatFileSaving || heartbeatFileResetting}
                    >
                      {heartbeatFileSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      {t('agentPanel.heartbeat.fileSave')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onReloadHeartbeatFile}
                      disabled={controlsDisabled || heartbeatFileLoading || heartbeatFileSaving || heartbeatFileResetting}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {t('agentPanel.heartbeat.fileReload')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onOpenHeartbeatResetDialog}
                      disabled={controlsDisabled || heartbeatFileLoading || heartbeatFileSaving || heartbeatFileResetting}
                    >
                      {heartbeatFileResetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                      {t('agentPanel.heartbeat.fileReset')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </AgentSettingsAccordionCard>

      <AlertDialog open={heartbeatResetDialogOpen} onOpenChange={onHeartbeatResetDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('agentPanel.heartbeat.fileConfirmResetTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('agentPanel.heartbeat.fileConfirmReset')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onClearHeartbeatResetDialog}>
              {tCommon('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onResetHeartbeatFile}>
              {t('agentPanel.heartbeat.fileReset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
