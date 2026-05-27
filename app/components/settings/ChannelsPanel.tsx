'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ChannelOverviewSection } from './channels/ChannelOverviewSection';
import {
  HeartbeatChannelCard,
  type HeartbeatConfig,
  type HeartbeatFixedKind,
  type HeartbeatMode,
  type HeartbeatSchedule,
} from './channels/HeartbeatChannelCard';
import { TelegramChannelCard, type TelegramStatus } from './channels/TelegramChannelCard';

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
  const [heartbeatMode, setHeartbeatMode] = useState<HeartbeatMode>('pulse');
  const [heartbeatFixedKind, setHeartbeatFixedKind] = useState<HeartbeatFixedKind>('daily');
  const [heartbeatTimes, setHeartbeatTimes] = useState<string[]>(['09:00']);
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
          if (sched.kind === 'interval') {
            setHeartbeatMode('pulse');
            setHeartbeatIntervalEvery(sched.every);
            setHeartbeatIntervalUnit(sched.unit);
            setHeartbeatTimezone(sched.timeZone);
          } else {
            setHeartbeatMode('fixedTimes');
            setHeartbeatFixedKind(sched.kind === 'weekly' ? 'weekly' : 'daily');
            setHeartbeatTimes(sched.times);
            setHeartbeatTimezone(sched.timeZone);
            if (sched.kind === 'weekly') setHeartbeatWeekdays(sched.days);
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

  const buildScheduleFromForm = (): HeartbeatSchedule => {
    if (heartbeatMode === 'pulse') {
      return { kind: 'interval', every: heartbeatIntervalEvery, unit: heartbeatIntervalUnit, timeZone: heartbeatTimezone };
    }
    if (heartbeatFixedKind === 'weekly') {
      return { kind: 'weekly', days: heartbeatWeekdays, times: heartbeatTimes, timeZone: heartbeatTimezone };
    }
    return { kind: 'daily', times: heartbeatTimes, timeZone: heartbeatTimezone };
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

  return (
    <div className="space-y-4">
    <ChannelOverviewSection telegramLinked={telegramStatus?.linked === true} />

    <TelegramChannelCard
      status={telegramStatus}
      isLoading={isLoading}
      error={error}
      success={success}
      channelEnabled={channelEnabled}
      botToken={botToken}
      showToken={showToken}
      linkToken={linkToken}
      copied={copied}
      isSaving={isSaving}
      isRestarting={isRestarting}
      isGeneratingToken={isGeneratingToken}
      isUnlinking={isUnlinking}
      isRegistering={isRegistering}
      onToggleEnabled={() => void handleToggleEnabled()}
      onBotTokenChange={setBotToken}
      onShowTokenChange={setShowToken}
      onSaveBotToken={() => void Promise.resolve().then(async () => {
        await saveEnv('TELEGRAM_BOT_TOKEN', botToken);
        await restartBot();
      })}
      onGenerateLinkToken={() => void handleGenerateLinkToken()}
      onCopyLinkCommand={() => void handleManualCopy()}
      onUnlink={() => void handleUnlink()}
      onRegisterCommands={() => void handleRegisterCommands()}
      onRefresh={() => {
        void loadStatus();
        void loadEnvValues();
      }}
      onRestart={() => void restartBot()}
    />

    <HeartbeatChannelCard
      config={heartbeatConfig}
      saving={heartbeatSaving}
      error={heartbeatError}
      success={heartbeatSuccess}
      mode={heartbeatMode}
      fixedKind={heartbeatFixedKind}
      times={heartbeatTimes}
      timezone={heartbeatTimezone}
      weekdays={heartbeatWeekdays}
      intervalEvery={heartbeatIntervalEvery}
      intervalUnit={heartbeatIntervalUnit}
      setMode={setHeartbeatMode}
      setFixedKind={setHeartbeatFixedKind}
      setTimes={setHeartbeatTimes}
      setTimezone={setHeartbeatTimezone}
      setWeekdays={setHeartbeatWeekdays}
      setIntervalEvery={setHeartbeatIntervalEvery}
      setIntervalUnit={setHeartbeatIntervalUnit}
      onToggle={() => void handleHeartbeatToggle()}
      onSave={() => void saveHeartbeatConfig(heartbeatConfig?.enabled ?? true)}
      onEditHeartbeatFile={() => router.push('/settings?tab=agent-settings')}
      formatDate={formatNextRun}
    />
    </div>
  );
}
