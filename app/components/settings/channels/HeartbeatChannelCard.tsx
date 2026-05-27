'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Heart, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export type HeartbeatMode = 'pulse' | 'fixedTimes';
export type HeartbeatFixedKind = 'daily' | 'weekly';

export type HeartbeatSchedule =
  | { kind: 'daily'; times: string[]; timeZone: string }
  | { kind: 'weekly'; days: string[]; times: string[]; timeZone: string }
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days'; timeZone: string };

export type HeartbeatConfig = {
  configured: boolean;
  enabled: boolean;
  schedule: HeartbeatSchedule | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  jobId: string | null;
};

type HeartbeatChannelCardProps = {
  config: HeartbeatConfig | null;
  saving: boolean;
  error: string | null;
  success: string | null;
  mode: HeartbeatMode;
  fixedKind: HeartbeatFixedKind;
  times: string[];
  timezone: string;
  weekdays: string[];
  intervalEvery: number;
  intervalUnit: 'minutes' | 'hours' | 'days';
  setMode: Dispatch<SetStateAction<HeartbeatMode>>;
  setFixedKind: Dispatch<SetStateAction<HeartbeatFixedKind>>;
  setTimes: Dispatch<SetStateAction<string[]>>;
  setTimezone: Dispatch<SetStateAction<string>>;
  setWeekdays: Dispatch<SetStateAction<string[]>>;
  setIntervalEvery: Dispatch<SetStateAction<number>>;
  setIntervalUnit: Dispatch<SetStateAction<'minutes' | 'hours' | 'days'>>;
  onToggle: () => void;
  onSave: () => void;
  onEditHeartbeatFile: () => void;
  formatDate: (dateStr: string | null) => string;
};

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export function HeartbeatChannelCard({
  config,
  saving,
  error,
  success,
  mode,
  fixedKind,
  times,
  timezone,
  weekdays,
  intervalEvery,
  intervalUnit,
  setMode,
  setFixedKind,
  setTimes,
  setTimezone,
  setWeekdays,
  setIntervalEvery,
  setIntervalUnit,
  onToggle,
  onSave,
  onEditHeartbeatFile,
  formatDate,
}: HeartbeatChannelCardProps) {
  const t = useTranslations('settings');

  return (
    <Card>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2">
          <Heart className="h-5 w-5" />
          {t('channels.heartbeat.title')}
        </CardTitle>
        <CardDescription>{t('channels.heartbeat.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-primary">{success}</p>}

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
            aria-checked={config?.enabled ?? false}
            onClick={onToggle}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${config?.enabled ? 'bg-primary' : 'bg-muted'}`}
            disabled={saving}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${config?.enabled ? 'translate-x-6' : 'translate-x-1'}`}
            />
          </button>
        </div>

        {(config?.enabled || config?.configured) && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('channels.heartbeat.modeLabel')}</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${mode === 'pulse' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}
                  onClick={() => setMode('pulse')}
                  disabled={saving}
                >
                  {t('channels.heartbeat.pulseMode')}
                </button>
                <button
                  type="button"
                  className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${mode === 'fixedTimes' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}
                  onClick={() => setMode('fixedTimes')}
                  disabled={saving}
                >
                  {t('channels.heartbeat.fixedTimesMode')}
                </button>
              </div>
            </div>

            {mode === 'pulse' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('channels.heartbeat.pulseIntervalLabel')}</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={intervalEvery}
                    onChange={(e) => setIntervalEvery(parseInt(e.target.value) || 1)}
                    disabled={saving}
                    className="w-20"
                  />
                  <select
                    className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={intervalUnit}
                    onChange={(e) => setIntervalUnit(e.target.value as 'minutes' | 'hours' | 'days')}
                    disabled={saving}
                  >
                    <option value="minutes">{t('channels.heartbeat.minutes')}</option>
                    <option value="hours">{t('channels.heartbeat.hours')}</option>
                    <option value="days">{t('channels.heartbeat.days')}</option>
                  </select>
                </div>
                <p className="text-xs text-muted-foreground">{t('channels.heartbeat.pulseDescription')}</p>
              </div>
            )}

            {mode === 'fixedTimes' && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${fixedKind === 'daily' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}
                    onClick={() => setFixedKind('daily')}
                    disabled={saving}
                  >
                    {t('channels.heartbeat.daily')}
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${fixedKind === 'weekly' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}
                    onClick={() => setFixedKind('weekly')}
                    disabled={saving}
                  >
                    {t('channels.heartbeat.weekly')}
                  </button>
                </div>

                {fixedKind === 'weekly' && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('channels.heartbeat.weekdays')}</label>
                    <div className="flex flex-wrap gap-2">
                      {WEEKDAYS.map((day) => (
                        <button
                          key={day}
                          type="button"
                          className={`rounded border px-2 py-1 text-xs transition-colors ${weekdays.includes(day) ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background'}`}
                          onClick={() => {
                            setWeekdays((prev) =>
                              prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
                            );
                          }}
                          disabled={saving}
                        >
                          {t(`channels.heartbeat.weekdayLabels.${day}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <label className="text-sm font-medium">{t('channels.heartbeat.timesLabel')}</label>
                  <div className="space-y-2">
                    {times.map((time, index) => (
                      <div key={`${time}-${index}`} className="flex items-center gap-2">
                        <Input
                          type="time"
                          value={time}
                          onChange={(e) => {
                            setTimes((prev) => {
                              const next = [...prev];
                              next[index] = e.target.value;
                              return next;
                            });
                          }}
                          disabled={saving}
                          className="max-w-[200px]"
                        />
                        {times.length > 1 && (
                          <button
                            type="button"
                            className="px-1 text-sm text-muted-foreground transition-colors hover:text-destructive"
                            onClick={() => setTimes((prev) => prev.filter((_, i) => i !== index))}
                            disabled={saving}
                          >
                            {t('channels.heartbeat.removeTime')}
                          </button>
                        )}
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setTimes((prev) => [...prev, '09:00'])}
                      disabled={saving}
                    >
                      {t('channels.heartbeat.addTime')}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('channels.heartbeat.timezone')}</label>
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={saving}
                className="max-w-[300px]"
              />
            </div>

            <Button type="button" disabled={saving} onClick={onSave}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('channels.telegram.save')}
            </Button>

            {config?.nextRunAt && (
              <div className="text-sm text-muted-foreground">
                {t('channels.heartbeat.nextRun')}: {formatDate(config.nextRunAt)}
              </div>
            )}
            {config?.lastRunAt && (
              <div className="text-sm text-muted-foreground">
                {t('channels.heartbeat.lastRun')}: {formatDate(config.lastRunAt)}
                {config.lastRunStatus && ` (${config.lastRunStatus})`}
              </div>
            )}
          </div>
        )}

        {!config?.configured && !config?.enabled && (
          <p className="text-sm text-muted-foreground">{t('channels.heartbeat.noSchedule')}</p>
        )}

        <Button type="button" variant="outline" onClick={onEditHeartbeatFile}>
          {t('channels.heartbeat.editHeartbeatFile')}
        </Button>
      </CardContent>
    </Card>
  );
}
