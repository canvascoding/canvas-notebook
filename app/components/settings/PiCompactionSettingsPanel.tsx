'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

type Source = 'default' | 'persisted' | 'environment';
type CompactionSettings = {
  catalogRevision: number;
  settingsRevision: number;
  persisted: { configured: boolean; tailMode: 'legacy' | 'lean' | null; summaryModel: string | null; summaryModelUnavailable: boolean };
  editable: { tailMode: 'legacy' | 'lean'; summaryModel: string | null };
  configuration: {
    tailMode: 'legacy' | 'lean';
    summaryModel: string | null;
    summaryRoute: 'configured' | 'main';
    sources: { tailMode: Source; summaryModel: Source };
  };
  summaryModels: Array<{
    identity: string;
    providerInstallationId: string;
    providerName: string;
    modelId: string;
    modelName: string;
  }>;
  preview: {
    modelIdentity: string;
    contextWindowTokens: number;
    outputReserveTokens: number;
    triggerTokens: number;
    targetTailTokens: number;
  } | null;
};

type ApiResponse = { success?: boolean; data?: CompactionSettings; error?: string };

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function PiCompactionSettingsPanel(_props: { locale?: string }) {
  const t = useTranslations('settings.compaction');
  const [settings, setSettings] = useState<CompactionSettings | null>(null);
  const [tailMode, setTailMode] = useState<'legacy' | 'lean'>('legacy');
  const [summaryModel, setSummaryModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const copy = {
    title: t('title'), description: t('description'), loading: t('loading'), retry: t('retry'),
    mode: t('mode'), legacy: t('legacy'), lean: t('lean'), summaryModel: t('summaryModel'),
    main: t('main'), save: t('save'), saved: t('saved'), configuration: t('configuration'),
    source: t('source'), route: t('route'), configured: t('configured'), fallback: t('fallback'),
    preview: t('preview'), noPreview: t('noPreview'), trigger: t('trigger'), tailTarget: t('tailTarget'),
    outputReserve: t('outputReserve'), requestBoundary: t('requestBoundary'), previewHint: t('previewHint'),
    unavailable: t('unavailable'), overridden: t('overridden'),
  };
  const sourceLabel = (source: Source, environmentName: string) => t(
    source === 'environment' ? 'sourceEnvironment' : source === 'persisted' ? 'sourcePersisted' : 'sourceDefault',
    { environment: environmentName },
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/agent-runtime/compaction', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null) as ApiResponse | null;
      if (!response.ok || !payload?.success || !payload.data) throw new Error(payload?.error || 'Failed to load compaction settings.');
      setSettings(payload.data);
      setTailMode(payload.data.editable.tailMode);
      setSummaryModel(payload.data.editable.summaryModel ?? '');
      setNotice(null);
    } catch (loadError) {
      setSettings(null);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load compaction settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/agent-runtime/compaction', {
        method: 'PATCH',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tailMode,
          summaryModel: summaryModel || null,
          expectedCatalogRevision: settings.catalogRevision,
          expectedSettingsRevision: settings.settingsRevision,
        }),
      });
      const payload = await response.json().catch(() => null) as ApiResponse | null;
      if (!response.ok || !payload?.success || !payload.data) throw new Error(payload?.error || 'Failed to save compaction settings.');
      setSettings(payload.data);
      setTailMode(payload.data.editable.tailMode);
      setSummaryModel(payload.data.editable.summaryModel ?? '');
      setNotice(copy.saved);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save compaction settings.');
    } finally {
      setSaving(false);
    }
  };

  const tailLocked = settings?.configuration.sources.tailMode === 'environment';
  const summaryLocked = settings?.configuration.sources.summaryModel === 'environment';

  return (
    <Card className="overflow-hidden" data-testid="pi-compaction-settings">
      <CardHeader className="border-b bg-muted/20">
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-6">
        {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{copy.loading}</div>}
        {!loading && error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
        {!loading && !settings && <Button type="button" variant="outline" onClick={() => void load()}>{copy.retry}</Button>}
        {!loading && settings && (
          <>
            {notice && <div role="status" className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/8 p-3 text-sm text-emerald-800 dark:text-emerald-200"><Check className="mt-0.5 size-4 shrink-0" />{notice}</div>}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pi-compaction-tail-mode">{copy.mode}</Label>
                <select id="pi-compaction-tail-mode" data-testid="pi-compaction-tail-mode" value={tailMode} disabled={saving || tailLocked} onChange={(event) => setTailMode(event.target.value === 'lean' ? 'lean' : 'legacy')} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="legacy">{copy.legacy}</option>
                  <option value="lean">{copy.lean}</option>
                </select>
                <p className="text-xs text-muted-foreground">{sourceLabel(settings.configuration.sources.tailMode, 'CANVAS_PI_COMPACTION_TAIL_MODE')}</p>
                {tailLocked && <p className="flex gap-1 text-xs text-amber-700 dark:text-amber-300"><ShieldAlert className="size-3.5 shrink-0" />{copy.overridden}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="pi-compaction-summary-model">{copy.summaryModel}</Label>
                <select id="pi-compaction-summary-model" data-testid="pi-compaction-summary-model" value={summaryModel} disabled={saving || summaryLocked} onChange={(event) => setSummaryModel(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">{copy.main}</option>
                  {settings.summaryModels.map((model) => <option key={model.identity} value={model.identity}>{model.providerName} · {model.modelName}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">{sourceLabel(settings.configuration.sources.summaryModel, 'CANVAS_PI_COMPACTION_SUMMARY_MODEL')}</p>
                {summaryLocked && <p className="flex gap-1 text-xs text-amber-700 dark:text-amber-300"><ShieldAlert className="size-3.5 shrink-0" />{copy.overridden}</p>}
              </div>
            </div>
            <Button type="button" onClick={() => void save()} disabled={saving || (tailLocked && summaryLocked)}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {copy.save}
            </Button>

            {settings.persisted.summaryModelUnavailable && <div role="status" className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">{copy.unavailable}</div>}
            <div className="rounded-lg border bg-muted/20 p-4" data-testid="pi-compaction-configuration">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{copy.configuration}</h3><Badge variant="outline">{settings.configuration.tailMode === 'lean' ? copy.lean : copy.legacy}</Badge></div>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">{copy.route}</dt><dd className="mt-1 font-medium">{settings.configuration.summaryRoute === 'configured' ? copy.configured : copy.fallback}</dd>{settings.configuration.summaryModel && <p className="mt-1 break-all text-xs text-muted-foreground">{settings.configuration.summaryModel}</p>}</div>
                <div><dt className="text-xs text-muted-foreground">{copy.source}</dt><dd className="mt-1 text-sm">{sourceLabel(settings.configuration.sources.tailMode, 'CANVAS_PI_COMPACTION_TAIL_MODE')}</dd></div>
              </dl>
            </div>

            <div className="rounded-lg border p-4" data-testid="pi-compaction-runtime-preview">
              <h3 className="font-medium">{copy.preview}</h3>
              {settings.preview ? <><p className="mt-1 break-all text-xs text-muted-foreground">{settings.preview.modelIdentity} · {formatTokens(settings.preview.contextWindowTokens)} tokens</p><dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{copy.trigger}</dt><dd className="mt-1 font-medium">{formatTokens(settings.preview.triggerTokens)}</dd></div><div><dt className="text-xs text-muted-foreground">{copy.tailTarget}</dt><dd className="mt-1 font-medium">{formatTokens(settings.preview.targetTailTokens)}</dd></div><div><dt className="text-xs text-muted-foreground">{copy.outputReserve}</dt><dd className="mt-1 font-medium">{formatTokens(settings.preview.outputReserveTokens)}</dd></div></dl></> : <p className="mt-1 text-sm text-muted-foreground">{copy.noPreview}</p>}
              <p className="mt-3 text-xs text-muted-foreground">{copy.previewHint}</p>
            </div>
            <p className="flex gap-2 text-xs text-muted-foreground"><RefreshCw className="size-3.5 shrink-0" />{copy.requestBoundary}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
