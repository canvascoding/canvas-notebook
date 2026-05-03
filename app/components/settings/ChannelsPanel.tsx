'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Heart,
  Link2,
  Loader2,
  RefreshCw,
  Terminal,
  Unlink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type TelegramStatus = {
  configured: boolean;
  enabled: boolean;
  linked: boolean;
  linkedUserName: string | null;
};

type HeartbeatSchedule =
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; days: string[]; time: string; timeZone: string }
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days'; timeZone: string };

type HeartbeatConfig = {
  configured: boolean;
  enabled: boolean;
  schedule: HeartbeatSchedule | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  jobId: string | null;
};

export function ChannelsPanel() {
  const t = useTranslations('settings');
  const router = useRouter();

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);

  const [botToken, setBotToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [channelEnabled, setChannelEnabled] = useState(false);

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [heartbeatConfig, setHeartbeatConfig] = useState<HeartbeatConfig | null>(null);
  const [heartbeatSaving, setHeartbeatSaving] = useState(false);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [heartbeatSuccess, setHeartbeatSuccess] = useState<string | null>(null);
  const [heartbeatScheduleKind, setHeartbeatScheduleKind] = useState<'daily' | 'weekly' | 'interval'>('daily');
  const [heartbeatTime, setHeartbeatTime] = useState('09:00');
  const [heartbeatTimezone, setHeartbeatTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [heartbeatWeekdays, setHeartbeatWeekdays] = useState<string[]>(['mon', 'tue', 'wed', 'thu', 'fri']);
  const [heartbeatIntervalEvery, setHeartbeatIntervalEvery] = useState(6);
  const [heartbeatIntervalUnit, setHeartbeatIntervalUnit] = useState<'minutes' | 'hours' | 'days'>('hours');

  const fullCommand = linkToken ? `/start ${linkToken}` : '';

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/channels/status', {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json();
      if (data.success) {
        setTelegramStatus(data.telegram);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const loadEnvValues = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/integrations/env?scope=integrations', {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json();
      if (data.success) {
        const byKey = new Map<
          string,
          string
        >(
          data.data.entries.map((e: { key: string; value: string }) => [
            e.key,
            e.value,
          ]),
        );
        setBotToken(byKey.get('TELEGRAM_BOT_TOKEN') ?? '');
        setChannelEnabled(
          (byKey.get('TELEGRAM_CHANNEL_ENABLED') ?? '').toLowerCase() ===
            'true',
        );
      }
    } catch {
      /* ignore */
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadHeartbeatConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/channels/heartbeat/config', { credentials: 'include', cache: 'no-store' });
      const data = await res.json();
      if (data.success) {
        const config: HeartbeatConfig = {
          configured: data.configured,
          enabled: data.enabled,
          schedule: data.schedule,
          nextRunAt: data.nextRunAt,
          lastRunAt: data.lastRunAt,
          lastRunStatus: data.lastRunStatus,
          jobId: data.jobId,
        };
        setHeartbeatConfig(config);
        if (data.schedule) {
          const sched = data.schedule as HeartbeatSchedule;
          setHeartbeatScheduleKind(sched.kind === 'weekly' ? 'weekly' : sched.kind === 'interval' ? 'interval' : 'daily');
          if (sched.kind === 'daily' || sched.kind === 'weekly') {
            setHeartbeatTime(sched.time);
            setHeartbeatTimezone(sched.timeZone);
            if (sched.kind === 'weekly') setHeartbeatWeekdays(sched.days);
          } else if (sched.kind === 'interval') {
            setHeartbeatIntervalEvery(sched.every);
            setHeartbeatIntervalUnit(sched.unit);
            setHeartbeatTimezone(sched.timeZone);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadEnvValues();
      void loadStatus();
      void loadHeartbeatConfig();
    });
  }, [loadEnvValues, loadStatus, loadHeartbeatConfig]);

  const saveEnv = async (key: string, value: string) => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/integrations/env?scope=integrations', {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to load env');

      const entries = data.data.entries.map(
        (e: { key: string; value: string }) => ({ key: e.key, value: e.value }),
      );
      const existingIdx = entries.findIndex(
        (e: { key: string }) => e.key === key,
      );
      if (existingIdx >= 0) {
        entries[existingIdx].value = value;
      } else {
        entries.push({ key, value });
      }

      const saveRes = await fetch('/api/integrations/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          scope: 'integrations',
          mode: 'kv',
          entries,
        }),
      });
      const saveData = await saveRes.json();
      if (!saveData.success) throw new Error(saveData.error || 'Failed to save');
      setSuccess(t('channels.telegram.saved'));
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    const newValue = !channelEnabled;
    setChannelEnabled(newValue);
    await saveEnv('TELEGRAM_CHANNEL_ENABLED', newValue ? 'true' : 'false');
    await restartBot();
  };

  const handleGenerateLinkToken = async () => {
    setIsGeneratingToken(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch('/api/channels/link-token', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        const token = data.token as string;
        setLinkToken(token);
        const cmd = `/start ${token}`;
        try {
          await navigator.clipboard.writeText(cmd);
          setCopied(true);
          setTimeout(() => setCopied(false), 3000);
        } catch {
          /* ignore if clipboard is blocked */
        }
      } else {
        setError(data.error || 'Failed to generate token');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setIsGeneratingToken(false);
    }
  };

  const handleManualCopy = async () => {
    if (!fullCommand) return;
    try {
      await navigator.clipboard.writeText(fullCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setError('Clipboard access denied');
    }
  };

  const handleUnlink = async () => {
    setIsUnlinking(true);
    setError(null);
    try {
      const res = await fetch('/api/channels/bind', {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(t('channels.telegram.unlinked'));
        await loadStatus();
      } else {
        setError(data.error || 'Failed to unlink');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setIsUnlinking(false);
    }
  };

  const restartBot = async () => {
    setIsRestarting(true);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch('/api/channels/restart', {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to restart bot');
      }
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error && err.name === 'AbortError' ? 'Restart timed out' : err instanceof Error ? err.message : 'Restart failed');
    } finally {
      clearTimeout(timeout);
      setIsRestarting(false);
    }
  };

  const handleRegisterCommands = async () => {
    setIsRegistering(true);
    setError(null);
    try {
      const res = await fetch('/api/channels/telegram/register-commands', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(t('channels.telegram.commandsRegistered'));
      } else {
        setError(data.error || 'Failed to register commands');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setIsRegistering(false);
    }
  };

  const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

  const buildScheduleFromForm = (): HeartbeatSchedule => {
    if (heartbeatScheduleKind === 'daily') {
      return { kind: 'daily', time: heartbeatTime, timeZone: heartbeatTimezone };
    }
    if (heartbeatScheduleKind === 'weekly') {
      return { kind: 'weekly', days: heartbeatWeekdays, time: heartbeatTime, timeZone: heartbeatTimezone };
    }
    return { kind: 'interval', every: heartbeatIntervalEvery, unit: heartbeatIntervalUnit, timeZone: heartbeatTimezone };
  };

  const saveHeartbeatConfig = async (enabled: boolean) => {
    setHeartbeatSaving(true);
    setHeartbeatError(null);
    setHeartbeatSuccess(null);
    try {
      const schedule = buildScheduleFromForm();
      const res = await fetch('/api/channels/heartbeat/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, schedule }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to save');
      setHeartbeatConfig({
        configured: data.configured,
        enabled: data.enabled,
        schedule: data.schedule,
        nextRunAt: data.nextRunAt,
        lastRunAt: data.lastRunAt,
        lastRunStatus: data.lastRunStatus,
        jobId: data.jobId,
      });
      setHeartbeatSuccess(t('channels.heartbeat.saved'));
      setTimeout(() => setHeartbeatSuccess(null), 3000);
    } catch (err) {
      setHeartbeatError(err instanceof Error ? err.message : t('channels.heartbeat.saveError'));
    } finally {
      setHeartbeatSaving(false);
    }
  };

  const handleHeartbeatToggle = async () => {
    const newEnabled = !heartbeatConfig?.enabled;
    setHeartbeatConfig((prev) => prev ? { ...prev, enabled: newEnabled } : null);
    await saveHeartbeatConfig(newEnabled);
  };

  const formatNextRun = (dateStr: string | null) => {
    if (!dateStr) return t('channels.heartbeat.never');
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  const statusEmoji = telegramStatus?.configured
    ? telegramStatus?.enabled
      ? telegramStatus?.linked
        ? '✅'
        : '🟡'
      : '⚪'
    : '🔴';

  const statusText = !telegramStatus?.configured
    ? t('channels.telegram.statusNotConfigured')
    : !telegramStatus?.enabled
      ? t('channels.telegram.statusDisabled')
      : telegramStatus?.linked
        ? telegramStatus.linkedUserName
          ? t('channels.telegram.statusLinked', {
              username: telegramStatus.linkedUserName,
            })
          : t('channels.telegram.linkedGeneric')
        : t('channels.telegram.statusNotLinked');

  return (
    <div className="space-y-4">
    <Card>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>{t('channels.telegram.title')}</CardTitle>
        <CardDescription>{t('channels.telegram.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('channels.telegram.loading')}
          </div>
        ) : (
          <>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-primary">{success}</p>}

            {/* Status */}
            <div className="text-sm">
              <span className="font-medium">{t('channels.telegram.statusLabel')}</span>{' '}
              <span>{statusEmoji} {statusText}</span>
            </div>

            {/* Enable/disable toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">
                  {t('channels.telegram.enableLabel')}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t('channels.telegram.enableDescription')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={channelEnabled}
                onClick={() => void handleToggleEnabled()}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${channelEnabled ? 'bg-primary' : 'bg-muted'}`}
                disabled={isSaving || isRestarting}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${channelEnabled ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>

            {/* Setup guide */}
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm space-y-2">
              <p className="font-medium">{t('channels.telegram.setupGuideTitle')}</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>
                  {t('channels.telegram.step1')}{' '}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline inline-flex items-center gap-0.5"
                  >
                    @BotFather <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  {t('channels.telegram.step1b')}
                </li>
                <li>{t('channels.telegram.step2')}</li>
                <li>{t('channels.telegram.step3')}</li>
                <li>{t('channels.telegram.step4')}</li>
              </ol>
            </div>

            {/* Everything below only shows when enabled */}
            {channelEnabled && (
              <>
                {/* Bot Token */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    {t('channels.telegram.botTokenLabel')}
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        type={showToken ? 'text' : 'password'}
                        value={botToken}
                        onChange={(e) => setBotToken(e.target.value)}
                        placeholder="123456:ABC-DEF..."
                        disabled={isSaving}
                        className={showToken ? undefined : 'pr-11'}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2"
                        onClick={() => setShowToken(!showToken)}
                        disabled={isSaving}
                      >
                        {showToken ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <Button
                      type="button"
                      disabled={isSaving || isRestarting}
                      onClick={async () => {
                        await saveEnv('TELEGRAM_BOT_TOKEN', botToken);
                        await restartBot();
                      }}
                    >
                      {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t('channels.telegram.save')}
                    </Button>
                  </div>
                </div>

                {/* Linking */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    {t('channels.telegram.linkLabel')}
                  </label>
                  {telegramStatus?.linked ? (
                    <div className="flex items-center gap-2 rounded-md border p-3">
                      <Link2 className="h-4 w-4 text-primary" />
                      <span className="text-sm">
                        {telegramStatus.linkedUserName
                          ? t('channels.telegram.linkedAs', {
                              username: telegramStatus.linkedUserName,
                            })
                          : t('channels.telegram.linkedGeneric')}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleUnlink()}
                        disabled={isUnlinking}
                        className="ml-auto"
                      >
                        {isUnlinking && (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        )}
                        <Unlink className="mr-1 h-3 w-3" />
                        {t('channels.telegram.unlink')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant="default"
                        onClick={() => void handleGenerateLinkToken()}
                        disabled={
                          isGeneratingToken || !telegramStatus?.configured
                        }
                      >
                        {isGeneratingToken && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        <Link2 className="mr-2 h-4 w-4" />
                        {t('channels.telegram.linkButton')}
                      </Button>

                      {linkToken && (
                        <div className="rounded-md border border-primary/30 bg-primary/5 p-4 text-sm space-y-2">
                          <p className="font-medium text-primary">
                            {copied
                              ? t('channels.telegram.copiedToClipboard')
                              : t('channels.telegram.tokenGenerated')}
                          </p>

                          {/* Kopierbarer Command-Bereich */}
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => void handleManualCopy()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                void handleManualCopy();
                              }
                            }}
                            className="cursor-pointer group"
                          >
                            <div className="flex items-center gap-3 rounded-md bg-background border p-3 transition-colors hover:border-primary/50 hover:bg-accent">
                              <code className="text-sm font-mono flex-1 break-all select-all">
                                /start {linkToken}
                              </code>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleManualCopy();
                                }}
                                className="shrink-0"
                              >
                                {copied ? (
                                  <Check className="h-4 w-4 text-green-500" />
                                ) : (
                                  <Copy className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
                                )}
                              </Button>
                            </div>
                          </div>

                          {!copied && (
                            <p className="text-xs text-muted-foreground">
                              {t('channels.telegram.clickToCopy')}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Register commands */}
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">
                    {t('channels.telegram.registerCommandsLabel')}
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRegisterCommands()}
                    disabled={
                      isRegistering || !telegramStatus?.configured
                    }
                  >
                    {isRegistering && (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    )}
                    <Terminal className="mr-1 h-3 w-3" />
                    {t('channels.telegram.registerCommandsButton')}
                  </Button>
                </div>
              </>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void loadStatus();
                  void loadEnvValues();
                }}
                disabled={isLoading}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('channels.telegram.refresh')}
              </Button>
              {channelEnabled && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void restartBot()}
                  disabled={isRestarting}
                >
                  {isRestarting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('channels.telegram.restart')}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>

    <Card>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2">
          <Heart className="h-5 w-5" />
          {t('channels.heartbeat.title')}
        </CardTitle>
        <CardDescription>{t('channels.heartbeat.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
        {heartbeatError && <p className="text-sm text-destructive">{heartbeatError}</p>}
        {heartbeatSuccess && <p className="text-sm text-primary">{heartbeatSuccess}</p>}

        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium">
              {t('channels.heartbeat.enableLabel')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('channels.heartbeat.enableDescription')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={heartbeatConfig?.enabled ?? false}
            onClick={() => void handleHeartbeatToggle()}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${heartbeatConfig?.enabled ? 'bg-primary' : 'bg-muted'}`}
            disabled={heartbeatSaving}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${heartbeatConfig?.enabled ? 'translate-x-6' : 'translate-x-1'}`}
            />
          </button>
        </div>

        {(heartbeatConfig?.enabled || heartbeatConfig?.configured) && (
          <div className="space-y-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('channels.heartbeat.scheduleKindLabel')}</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={heartbeatScheduleKind}
                onChange={(e) => setHeartbeatScheduleKind(e.target.value as 'daily' | 'weekly' | 'interval')}
                disabled={heartbeatSaving}
              >
                <option value="daily">{t('channels.heartbeat.daily')}</option>
                <option value="weekly">{t('channels.heartbeat.weekly')}</option>
                <option value="interval">{t('channels.heartbeat.interval')}</option>
              </select>
            </div>

            {(heartbeatScheduleKind === 'daily' || heartbeatScheduleKind === 'weekly') && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('channels.heartbeat.timeLabel')}</label>
                <Input
                  type="time"
                  value={heartbeatTime}
                  onChange={(e) => setHeartbeatTime(e.target.value)}
                  disabled={heartbeatSaving}
                  className="max-w-[200px]"
                />
              </div>
            )}

            {heartbeatScheduleKind === 'weekly' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('channels.heartbeat.weekdays')}</label>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((day) => (
                    <button
                      key={day}
                      type="button"
                      className={`px-2 py-1 text-xs rounded border transition-colors ${heartbeatWeekdays.includes(day) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border'}`}
                      onClick={() => {
                        setHeartbeatWeekdays((prev) =>
                          prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
                        );
                      }}
                      disabled={heartbeatSaving}
                    >
                      {t(`channels.heartbeat.weekdayLabels.${day}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {heartbeatScheduleKind === 'interval' && (
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">{t('channels.heartbeat.intervalEveryLabel')}</label>
                <Input
                  type="number"
                  min={1}
                  value={heartbeatIntervalEvery}
                  onChange={(e) => setHeartbeatIntervalEvery(parseInt(e.target.value) || 1)}
                  disabled={heartbeatSaving}
                  className="w-20"
                />
                <select
                  className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={heartbeatIntervalUnit}
                  onChange={(e) => setHeartbeatIntervalUnit(e.target.value as 'minutes' | 'hours' | 'days')}
                  disabled={heartbeatSaving}
                >
                  <option value="minutes">{t('channels.heartbeat.minutes')}</option>
                  <option value="hours">{t('channels.heartbeat.hours')}</option>
                  <option value="days">{t('channels.heartbeat.days')}</option>
                </select>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('channels.heartbeat.timezone')}</label>
              <Input
                value={heartbeatTimezone}
                onChange={(e) => setHeartbeatTimezone(e.target.value)}
                disabled={heartbeatSaving}
                className="max-w-[300px]"
              />
            </div>

            <Button
              type="button"
              disabled={heartbeatSaving}
              onClick={() => void saveHeartbeatConfig(heartbeatConfig?.enabled ?? true)}
            >
              {heartbeatSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('channels.telegram.save')}
            </Button>

            {heartbeatConfig?.nextRunAt && (
              <div className="text-sm text-muted-foreground">
                {t('channels.heartbeat.nextRun')}: {formatNextRun(heartbeatConfig.nextRunAt)}
              </div>
            )}
            {heartbeatConfig?.lastRunAt && (
              <div className="text-sm text-muted-foreground">
                {t('channels.heartbeat.lastRun')}: {formatNextRun(heartbeatConfig.lastRunAt)}
                {heartbeatConfig.lastRunStatus && ` (${heartbeatConfig.lastRunStatus})`}
              </div>
            )}
          </div>
        )}

        {!heartbeatConfig?.configured && !heartbeatConfig?.enabled && (
          <p className="text-sm text-muted-foreground">{t('channels.heartbeat.noSchedule')}</p>
        )}

        <Button
          type="button"
          variant="outline"
          onClick={() => router.push('/settings?tab=agent-settings')}
        >
          {t('channels.heartbeat.editHeartbeatFile')}
        </Button>
      </CardContent>
    </Card>
    </div>
  );
}
