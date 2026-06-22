'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Cpu,
  Database,
  FileText,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type {
  KnowledgeOperationalLogEntry,
  KnowledgeFeatureGate,
  KnowledgeParsingSettings,
  KnowledgeSettingsResponse,
} from '@/app/lib/knowledge/settings-types';

const BOOLEAN_SETTING_KEYS = [
  'knowledgeAutoIngestionEnabled',
  'heavyDocumentParsingEnabled',
  'doclingEnabled',
  'ocrEnabled',
  'embeddingIndexingEnabled',
  'ragRetrievalEnabled',
  'knowledgeGraphEnabled',
  'liveCollaborationEnabled',
  'remoteParsingEnabled',
] as const;

const NUMBER_SETTING_KEYS = [
  'maxConcurrentHeavyJobs',
  'maxDocumentSizeMb',
  'maxPages',
  'maxOcrPages',
  'perFileTimeoutSeconds',
  'minimumFreeMemoryMb',
] as const;

type BooleanSettingKey = (typeof BOOLEAN_SETTING_KEYS)[number];
type NumberSettingKey = (typeof NUMBER_SETTING_KEYS)[number];

function cloneSettings(settings: KnowledgeParsingSettings): KnowledgeParsingSettings {
  return { ...settings };
}

function availabilityVariant(availability: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (availability === 'available') return 'default';
  if (availability === 'disabled') return 'destructive';
  return 'secondary';
}

function logLevelVariant(level: KnowledgeOperationalLogEntry['level']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (level === 'error') return 'destructive';
  if (level === 'warn') return 'secondary';
  return 'outline';
}

function gateVariant(status: KnowledgeFeatureGate['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'enabled') return 'default';
  if (status === 'blocked') return 'destructive';
  if (status === 'available') return 'secondary';
  return 'outline';
}

export function KnowledgeSettingsPanel() {
  const t = useTranslations('settings.knowledge');
  const [data, setData] = useState<KnowledgeSettingsResponse | null>(null);
  const [draft, setDraft] = useState<KnowledgeParsingSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const isDirty = useMemo(() => {
    if (!data || !draft) return false;
    return [...BOOLEAN_SETTING_KEYS, ...NUMBER_SETTING_KEYS].some((key) => data.settings[key] !== draft[key]);
  }, [data, draft]);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/knowledge-settings', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.load'));
      }
      const nextData = payload.data as KnowledgeSettingsResponse;
      setData(nextData);
      setDraft(cloneSettings(nextData.settings));
      setMessage(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadSettings();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadSettings]);

  const updateBoolean = (key: BooleanSettingKey, value: boolean) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };

  const updateNumber = (key: NumberSettingKey, value: string) => {
    const parsed = value.trim() === '' ? NaN : Number(value);
    setDraft((current) => current ? { ...current, [key]: Number.isFinite(parsed) ? parsed : current[key] } : current);
  };

  const saveSettings = async () => {
    if (!draft) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/knowledge-settings', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: draft }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.save'));
      }
      const nextData = payload.data as KnowledgeSettingsResponse;
      setData(nextData);
      setDraft(cloneSettings(nextData.settings));
      setMessage(t('saved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading && !data) {
    return (
      <div className="flex items-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (!draft || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error || t('errors.load')}
          </div>
        </CardContent>
      </Card>
    );
  }

  const status = data.resourceStatus;
  const canUpdate = data.permission.canUpdate && !isSaving;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <BookOpen className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('title')}</CardTitle>
            <Badge variant={availabilityVariant(status.availability)}>
              {t(`availability.${status.availability}`)}
            </Badge>
            <Badge variant="outline">{t(`profiles.${status.resourceProfile}`)}</Badge>
          </div>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
          {error && <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
          {message && <div className="border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{message}</div>}
          {!status.canEnableKnowledge && (
            <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">{t('preflightBlocked')}</p>
                <p>{t('preflightBlockedDescription')}</p>
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatusTile icon={Database} label={t('status.database')} value={status.databaseProvider} detail={status.pgvectorReady ? t('status.pgvectorReady') : t('status.pgvectorMissing')} />
            <StatusTile icon={MemoryStick} label={t('status.memory')} value={status.memory.totalMb === null ? t('unknown') : `${status.memory.totalMb} MB`} detail={t('status.freeMemory', { value: status.memory.freeMb ?? 0 })} />
            <StatusTile icon={Cpu} label={t('status.cpu')} value={status.cpu.count === null ? t('unknown') : String(status.cpu.count)} detail={t('status.activeJobs', { value: status.queue.activeHeavyJobs })} />
            <StatusTile icon={HardDrive} label={t('status.disk')} value={status.disk.freeGb === null ? t('unknown') : `${status.disk.freeGb} GB`} detail={t('status.diskThreshold', { value: status.disk.thresholdGb })} />
          </div>

          {(status.blockers.length > 0 || status.warnings.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              <StatusList title={t('blockers')} items={status.blockers} empty={t('none')} destructive />
              <StatusList title={t('warnings')} items={status.warnings} empty={t('none')} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('togglesTitle')}</CardTitle>
          </div>
          <CardDescription>{t('togglesDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
          <div className="grid gap-3 md:grid-cols-2">
            {BOOLEAN_SETTING_KEYS.map((key) => (
              <ToggleRow
                key={key}
                label={t(`fields.${key}.label`)}
                description={t(`fields.${key}.description`)}
                checked={draft[key]}
                disabled={!canUpdate}
                onCheckedChange={(checked) => updateBoolean(key, checked)}
              />
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {NUMBER_SETTING_KEYS.map((key) => (
              <label key={key} className="space-y-2 rounded-md border border-border p-3">
                <span className="text-sm font-medium">{t(`fields.${key}.label`)}</span>
                <Input
                  type="number"
                  value={draft[key]}
                  disabled={!canUpdate}
                  onChange={(event) => updateNumber(key, event.target.value)}
                />
                <span className="block text-xs text-muted-foreground">{t(`fields.${key}.description`)}</span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => void loadSettings()} disabled={isLoading || isSaving}>
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {t('reload')}
            </Button>
            <Button type="button" onClick={() => void saveSettings()} disabled={!canUpdate || !isDirty}>
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {t('save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('featureGatesTitle')}</CardTitle>
          </div>
          <CardDescription>{t('featureGatesDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
          {status.featureGates.map((gate) => (
            <div key={gate.key} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={gateVariant(gate.status)}>{t(`gateStatus.${gate.status}`)}</Badge>
                <span className="text-sm font-medium">{t(`featureGates.${gate.key}.label`)}</span>
                {gate.requiresPostgres && <Badge variant="outline">Postgres</Badge>}
                {gate.requiresPgvector && <Badge variant="outline">pgvector</Badge>}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {t(`featureGates.${gate.key}.description`)}
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <StatusList title={t('requirements')} items={gate.requirements} empty={t('none')} />
                <StatusList title={t('blockers')} items={gate.blockers} empty={t('none')} destructive />
                <StatusList title={t('warnings')} items={gate.warnings} empty={t('none')} />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('logsTitle')}</CardTitle>
          </div>
          <CardDescription>{t('logsDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
          {data.logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('logsEmpty')}</p>
          ) : (
            data.logs.map((entry, index) => (
              <div key={`${entry.timestamp}:${entry.action}:${index}`} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={logLevelVariant(entry.level)}>{entry.level}</Badge>
                  <span className="text-sm font-medium">{entry.action}</span>
                  <span className="text-xs text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{entry.message}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{t('reasonCode')}: {entry.reasonCode}</span>
                  <span>{t('changedKeys')}: {entry.changedKeys.length ? entry.changedKeys.join(', ') : t('none')}</span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusTile({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Database;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="mt-2 text-lg font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function StatusList({
  title,
  items,
  empty,
  destructive = false,
}: {
  title: string;
  items: string[];
  empty: string;
  destructive?: boolean;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.length === 0 ? (
          <Badge variant="outline">{empty}</Badge>
        ) : items.map((item) => (
          <Badge key={item} variant={destructive ? 'destructive' : 'secondary'}>{item}</Badge>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}
