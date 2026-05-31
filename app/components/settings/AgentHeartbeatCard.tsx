'use client';

import { Heart, Loader2, RefreshCw, Save } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { AgentSettingsAccordionCard } from './AgentSettingsAccordionCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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
  onOpenChange: (isOpen: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
  onScheduleDraftChange: (patch: Partial<AgentHeartbeatScheduleDraft>) => void;
  onDeliveryDraftChange: (patch: Partial<AgentHeartbeatDeliveryDraft>) => void;
  onSave: () => void;
  onReload: () => void;
  onEditHeartbeatFile: () => void;
};

const WEEKDAYS: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function formatDate(value: string | null, emptyLabel: string): string {
  if (!value) return emptyLabel;
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function deliverySessionModeLabel(mode: AutomationDeliverySessionMode, isGerman: boolean): string {
  if (mode === 'new_session') return isGerman ? 'Neue Session' : 'New session';
  if (mode === 'channel_active') return isGerman ? 'Aktive Session im gewaehlten Channel' : 'Active session in selected channel';
  return isGerman ? 'Bestimmte Session-ID' : 'Specific session ID';
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
  onOpenChange,
  onEnabledChange,
  onScheduleDraftChange,
  onDeliveryDraftChange,
  onSave,
  onReload,
  onEditHeartbeatFile,
}: AgentHeartbeatCardProps) {
  const t = useTranslations('settings');
  const locale = useLocale();
  const isGerman = locale.startsWith('de');
  const enabled = config?.enabled ?? false;
  const selectedDeliveryChannel = deliveryDraft.deliveryMode === 'web' ? 'web' : deliveryDraft.deliveryChannelId || 'web';
  const channelOptions = deliveryChannels.length > 0
    ? deliveryChannels
    : [{ id: 'web', label: isGerman ? 'Web-Chat' : 'Web chat', connected: true, running: true }];

  const summaryItems = [
    loading
      ? t('agentPanel.heartbeat.loadingSummary')
      : enabled
        ? t('agentPanel.heartbeat.enabledSummary')
        : t('agentPanel.heartbeat.disabledSummary'),
    config?.nextRunAt ? t('agentPanel.heartbeat.nextRunSummary', { value: formatDate(config.nextRunAt, t('agentPanel.heartbeat.never')) }) : null,
    error ? t('agentPanel.heartbeat.errorSummary') : null,
  ].filter((item): item is string => Boolean(item));

  return (
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

          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
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
                  disabled={saving}
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
                    disabled={saving}
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
                      disabled={saving}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.intervalUnitLabel')}</span>
                    <select
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={scheduleDraft.intervalUnit}
                      onChange={(event) => onScheduleDraftChange({ intervalUnit: event.target.value as AutomationIntervalUnit })}
                      disabled={saving}
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
                <Input
                  value={scheduleDraft.timeZone}
                  onChange={(event) => onScheduleDraftChange({ timeZone: event.target.value })}
                  disabled={saving}
                />
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
                        disabled={saving}
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
                    disabled={saving}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-3">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('agentPanel.heartbeat.deliveryChannel')}</span>
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={selectedDeliveryChannel}
                onChange={(event) => {
                  const channelId = event.target.value;
                  onDeliveryDraftChange({
                    deliveryMode: channelId === 'web' ? 'web' : 'channel_home',
                    deliveryChannelId: channelId,
                  });
                }}
                disabled={saving}
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
                disabled={saving}
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
                  disabled={saving}
                />
              </label>
            )}
          </div>

          <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <span>{t('agentPanel.heartbeat.nextRun')}: {formatDate(config?.nextRunAt ?? null, t('agentPanel.heartbeat.never'))}</span>
            <span>{t('agentPanel.heartbeat.lastRun')}: {formatDate(config?.lastRunAt ?? null, t('agentPanel.heartbeat.never'))}{config?.lastRunStatus ? ` (${config.lastRunStatus})` : ''}</span>
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
            <Button type="button" variant="outline" onClick={onEditHeartbeatFile}>
              {t('agentPanel.heartbeat.editHeartbeatFile')}
            </Button>
          </div>
        </>
      )}
    </AgentSettingsAccordionCard>
  );
}
