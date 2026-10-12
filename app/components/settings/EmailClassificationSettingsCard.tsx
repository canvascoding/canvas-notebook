'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown, FlaskConical, Inbox, Loader2, RefreshCw, Save } from 'lucide-react';

import type { EmailClassificationAdminSettings, EmailClassificationProviderTestResult } from '@/app/lib/email/classification/admin-service';
import type { EmailClassificationConfiguration } from '@/app/lib/email/classification/settings-types';
import { EMAIL_CATEGORY_IDS, type EmailClassificationPolicy } from '@/app/lib/email/classification/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

type FailureKey = 'load' | 'save' | 'test' | 'conflict' | 'access' | 'invalid' | 'credentialMissing' | 'credentialUnavailable' | 'authentication' | 'timeout' | 'rateLimited' | 'endpoint' | 'invalidResponse' | 'refused' | 'unavailable' | 'managedConnection' | 'managedAccess' | 'managedModel' | 'managedBudget' | 'managedReview';
class RequestFailure extends Error {
  constructor(readonly key: FailureKey) { super(key); }
}

function requestFailure(response: Response, payload: { code?: string }, fallback: FailureKey): RequestFailure {
  if (response.status === 401 || response.status === 403) return new RequestFailure('access');
  const codes: Record<string, FailureKey> = {
    EMAIL_CLASSIFICATION_VERSION_CONFLICT: 'conflict', INVALID_CONFIGURATION: 'invalid', INVALID_TEST_CONFIGURATION: 'invalid',
    EMAIL_CLASSIFICATION_INVALID_CONFIGURATION: 'invalid', EMAIL_CLASSIFICATION_CREDENTIAL_MISSING: 'credentialMissing',
    EMAIL_CLASSIFICATION_CREDENTIAL_UNAVAILABLE: 'credentialUnavailable', EMAIL_CLASSIFICATION_AUTHENTICATION_FAILED: 'authentication',
    EMAIL_CLASSIFICATION_TIMEOUT: 'timeout', EMAIL_CLASSIFICATION_RATE_LIMITED: 'rateLimited',
    EMAIL_CLASSIFICATION_ENDPOINT_REJECTED: 'endpoint', EMAIL_CLASSIFICATION_INVALID_RESPONSE: 'invalidResponse',
    EMAIL_CLASSIFICATION_REFUSED: 'refused',
    EMAIL_CLASSIFICATION_UNAVAILABLE: 'unavailable',
    EMAIL_CLASSIFICATION_MANAGED_MISSING_CONNECTION: 'managedConnection', EMAIL_CLASSIFICATION_MANAGED_AUTHENTICATION_FAILED: 'managedConnection',
    EMAIL_CLASSIFICATION_MANAGED_SCOPE_DENIED: 'managedAccess', EMAIL_CLASSIFICATION_MANAGED_ENTITLEMENT_DENIED: 'managedAccess',
    EMAIL_CLASSIFICATION_MANAGED_BUDGET_EXHAUSTED: 'managedBudget', EMAIL_CLASSIFICATION_MANAGED_MODEL_CHANGED: 'managedModel',
    EMAIL_CLASSIFICATION_MANAGED_MISSING_CONFIGURATION: 'managedModel', EMAIL_CLASSIFICATION_MANAGED_MISSING_CREDENTIALS: 'managedModel',
    EMAIL_CLASSIFICATION_MANAGED_MISSING_PRICING: 'managedModel', EMAIL_CLASSIFICATION_MANAGED_CONFIGURATION_UNAVAILABLE: 'managedModel',
    EMAIL_CLASSIFICATION_MANAGED_OUTCOME_UNKNOWN: 'managedReview', EMAIL_CLASSIFICATION_MANAGED_PROVIDER_UNAVAILABLE: 'unavailable',
    EMAIL_CLASSIFICATION_MANAGED_RATE_LIMITED: 'rateLimited', EMAIL_CLASSIFICATION_MANAGED_IN_PROGRESS: 'rateLimited',
    EMAIL_CLASSIFICATION_MANAGED_INVALID_RESPONSE: 'invalidResponse', EMAIL_CLASSIFICATION_MANAGED_REFUSED: 'refused',
    EMAIL_CLASSIFICATION_MANAGED_UNSUPPORTED_CAPABILITY: 'managedModel',
  };
  return new RequestFailure(codes[payload.code ?? ''] ?? (response.status === 429 ? 'rateLimited' : fallback));
}

type LimitKey = 'concurrency' | 'timeoutMs' | 'maxEmailsPerDay' | 'initialLookbackDays' | 'maxHistoricalMessages' | 'syncIntervalSeconds';
const LIMITS: Array<{ key: LimitKey; min: number; max: number }> = [
  { key: 'maxEmailsPerDay', min: 1, max: 100_000 }, { key: 'concurrency', min: 1, max: 8 },
  { key: 'initialLookbackDays', min: 1, max: 30 }, { key: 'maxHistoricalMessages', min: 1, max: 100_000 },
  { key: 'timeoutMs', min: 1_000, max: 120_000 }, { key: 'syncIntervalSeconds', min: 15, max: 3_600 },
];
type ThresholdKey = { [K in keyof EmailClassificationPolicy]: EmailClassificationPolicy[K] extends number ? K : never }[keyof EmailClassificationPolicy];
const THRESHOLDS: ThresholdKey[] = ['choiceMinimumProbability', 'choiceMinimumMargin', 'spamPositiveThreshold', 'spamNegativeThreshold', 'replyPositiveThreshold', 'replyNegativeThreshold'];
const SETTINGS_URL = '/api/admin/email-classification/settings';

export function EmailClassificationSettingsCard() {
  const t = useTranslations('emailClassificationSettings');
  const [snapshot, setSnapshot] = useState<EmailClassificationAdminSettings | null>(null);
  const [draft, setDraft] = useState<EmailClassificationConfiguration | null>(null);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<'save' | 'test' | null>(null);
  const [loadError, setLoadError] = useState<FailureKey | null>(null);
  const [error, setError] = useState<FailureKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [probe, setProbe] = useState<EmailClassificationProviderTestResult | null>(null);
  const draftRef = useRef(draft);
  const readGeneration = useRef(0);
  const mounted = useRef(true);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(snapshot?.settings.configuration);
  const serverChanged = baseRevision !== null && snapshot !== null && baseRevision !== snapshot.settings.revision;

  const refresh = useCallback(async (replaceDraft = false) => {
    const generation = ++readGeneration.current;
    const initial = draftRef.current === null;
    if (initial) setLoading(true);
    setRefreshing(true);
    try {
      const response = await fetch(SETTINGS_URL, { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw requestFailure(response, payload, 'load');
      if (!payload.data?.settings?.configuration || !Number.isSafeInteger(payload.data.settings.revision)) throw new RequestFailure('load');
      if (!mounted.current || generation !== readGeneration.current) return;
      const next = payload.data as EmailClassificationAdminSettings;
      setSnapshot(next); setLoadError(null);
      if (replaceDraft || draftRef.current === null) {
        const configuration = structuredClone(next.settings.configuration);
        draftRef.current = configuration; setDraft(configuration); setBaseRevision(next.settings.revision);
        setError(null); setSaved(false); setProbe(null);
      }
    } catch (failure) {
      if (mounted.current && generation === readGeneration.current) setLoadError(failure instanceof RequestFailure ? failure.key : 'load');
    } finally {
      if (mounted.current && generation === readGeneration.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);
  const invalidateReads = useCallback(() => { readGeneration.current++; }, []);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    queueMicrotask(() => { if (active) void refresh(); });
    // A Secrets edit refreshes safe status without replacing an unsaved configuration.
    const onSecretsChanged = () => { void refresh(); };
    window.addEventListener('canvas_secrets_updated', onSecretsChanged);
    return () => { active = false; mounted.current = false; invalidateReads(); window.removeEventListener('canvas_secrets_updated', onSecretsChanged); };
  }, [refresh, invalidateReads]);

  function edit(change: (current: EmailClassificationConfiguration) => EmailClassificationConfiguration) {
    setError(current => current === 'conflict' ? current : null); setSaved(false); setProbe(null);
    setDraft(current => {
      if (!current) return current;
      const next = change(current); draftRef.current = next; return next;
    });
  }

  async function save() {
    if (!draft || baseRevision === null || action) return;
    readGeneration.current++; setRefreshing(false); setAction('save'); setError(null); setSaved(false);
    try {
      const response = await fetch(SETTINGS_URL, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: baseRevision, configuration: draft }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw requestFailure(response, payload, 'save');
      if (!payload.data?.settings?.configuration) throw new RequestFailure('save');
      if (!mounted.current) return;
      readGeneration.current++;
      const next = payload.data as EmailClassificationAdminSettings;
      const configuration = structuredClone(next.settings.configuration);
      setSnapshot(next); draftRef.current = configuration; setDraft(configuration); setBaseRevision(next.settings.revision);
      setLoadError(null); setSaved(true); setProbe(null);
      window.dispatchEvent(new CustomEvent('canvas-email-classification-settings-updated', { detail: { enabled: next.availability.enabled, revision: next.settings.revision } }));
    } catch (failure) { if (mounted.current) setError(failure instanceof RequestFailure ? failure.key : 'save'); }
    finally { if (mounted.current) setAction(null); }
  }

  async function test() {
    if (!draft || action) return;
    setAction('test'); setError(null); setProbe(null);
    try {
      const response = await fetch('/api/admin/email-classification/test', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configuration: draft }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw requestFailure(response, payload, 'test');
      if (payload.data?.success !== true) throw new RequestFailure('invalidResponse');
      if (mounted.current) setProbe(payload.data as EmailClassificationProviderTestResult);
    } catch (failure) { if (mounted.current) setError(failure instanceof RequestFailure ? failure.key : 'test'); }
    finally { if (mounted.current) setAction(null); }
  }

  const provider = snapshot?.providerOptions.find(option => option.id === draft?.providerId);
  const providerDraftChanged = draft !== null && snapshot !== null && ['executionMode', 'managedModelRef', 'providerId', 'model', 'endpoint', 'credentialKey', 'allowPrivateNetwork']
    .some(key => draft[key as keyof EmailClassificationConfiguration] !== snapshot.settings.configuration[key as keyof EmailClassificationConfiguration]);
  const busy = action !== null;
  const status = !snapshot || loadError ? 'unknown' : snapshot.availability.enabled ? 'enabled' : 'disabled';
  const credentials = providerDraftChanged ? 'draft' : snapshot?.credentials.anonymous ? 'anonymous' : snapshot?.credentials.status ?? 'unknown';
  const managed = draft?.executionMode === 'managed';
  const managedCatalog = snapshot?.execution?.managed;
  const managedModels = managedCatalog?.catalog?.models ?? [];
  const managedRef = draft?.managedModelRef ?? managedCatalog?.catalog?.defaultModelRef;
  const managedModel = managedModels.find(model => model.ref === managedRef);
  const managedReason = managedCatalog?.status !== 'ready' ? managedCatalog?.code ?? 'provider_unavailable'
    : managedModel?.available ? snapshot?.execution?.mode === 'managed' ? snapshot.execution.reason : null : managedModel?.status ?? 'missing_configuration';
  const reasonKeys: Record<string, string> = { missing_connection: 'connection', authentication_failed: 'connection', scope_denied: 'access', entitlement_denied: 'access', budget_exhausted: 'budget', missing_configuration: 'model', missing_credentials: 'model', missing_pricing: 'pricing', configuration_unavailable: 'model', model_changed: 'changed', unsupported_capability: 'version', invalid_response: 'version', in_progress: 'waiting', rate_limited: 'waiting' };
  const errorActions = error === 'conflict' || serverChanged
    ? <Button type="button" variant="outline" size="sm" disabled={busy || refreshing} onClick={() => void refresh(true)}>{t('reloadDraft')}</Button>
    : error === 'credentialMissing' || error === 'credentialUnavailable' || error === 'authentication'
      ? <Button variant="outline" size="sm" asChild><Link href="/settings?tab=secrets">{t('secretsLink')}</Link></Button> : undefined;

  return (
    <Card data-testid="email-classification-settings" className="gap-0 py-0">
      <CardHeader className="px-4 py-5 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <CardTitle className="flex items-center gap-2 text-base"><Inbox className="h-4 w-4 shrink-0" aria-hidden="true" />{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
          <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t('refresh')} disabled={busy || refreshing} onClick={() => void refresh()}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-5 sm:px-6">
        <div className="flex items-start justify-between gap-4 rounded-md border bg-muted/20 p-4">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="email-classification-enabled" className="text-sm font-medium">{t('enable')}</Label>
            <p id="email-classification-scope" className="text-xs leading-relaxed text-muted-foreground">{t('scope')}</p>
            <p id="email-classification-selection" className="text-xs leading-relaxed text-muted-foreground">{t('selectionHint')}</p>
          </div>
          <Switch id="email-classification-enabled" aria-describedby="email-classification-scope email-classification-selection" checked={draft?.enabled ?? false}
            disabled={loading || !draft || busy} onCheckedChange={enabled => edit(current => ({ ...current, enabled }))} />
        </div>
        <div className="space-y-2 text-sm" role="status" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t(`status.${status}`)}</Badge>
            {dirty && <span className="text-xs text-muted-foreground">{t('unsaved')}</span>}
          </div>
          {loading ? <p className="text-muted-foreground">{t('loading')}</p> : snapshot && !loadError && (
            <>
              <p className="text-muted-foreground">{managed ? managedReason ? t(`managed.reasons.${reasonKeys[managedReason] ?? 'unavailable'}`) : t(`processing.${snapshot.execution?.mode === 'managed' ? snapshot.health.state : 'idle'}`) : snapshot.availability.reason && snapshot.availability.reason !== 'disabled'
                ? t(`availability.${snapshot.availability.reason}`) : t(`processing.${snapshot.health.state}`)}</p>
              {snapshot.health.counts && snapshot.availability.enabled && <p className="text-xs text-muted-foreground">{t('progress', snapshot.health.counts)}</p>}
            </>
          )}
        </div>
        {loadError && <InlineNotice variant="warning" actions={<Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}>{t('refresh')}</Button>}>{t(`errors.${loadError}`)}</InlineNotice>}
        {(error || serverChanged) && <InlineNotice variant={error === 'conflict' || serverChanged ? 'warning' : 'destructive'} actions={errorActions}>
          {t(`errors.${error ?? 'conflict'}`)}{(error === 'conflict' || serverChanged) && <p className="mt-1">{t('conflictHint')}</p>}
        </InlineNotice>}
        {saved && <InlineNotice variant="success">{t('saved')}</InlineNotice>}

        {draft && managed && <div className="space-y-3 rounded-md border p-4" data-testid="email-classification-managed">
          <div className="space-y-1"><p className="text-sm font-medium">{t('managed.title')}</p><p className="text-xs text-muted-foreground">{t('managed.hint')}</p></div>
          <div className="space-y-2"><Label htmlFor="email-classification-managed-model">{t('managed.model')}</Label>
            <select id="email-classification-managed-model" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-ring disabled:opacity-50" value={draft.managedModelRef ?? ''} disabled={busy || managedCatalog?.status !== 'ready'}
              onChange={event => edit(current => ({ ...current, managedModelRef: event.target.value || null, managedModel: null }))}>
              <option value="">{managedCatalog?.catalog?.defaultModelRef ? t('managed.default', { model: managedModels.find(model => model.ref === managedCatalog.catalog?.defaultModelRef)?.name ?? managedCatalog.catalog.defaultModelRef }) : t('managed.noDefault')}</option>
              {managedModels.map(model => <option key={model.ref} value={model.ref} disabled={!model.available}>{model.name}{model.available ? '' : ` · ${t('managed.notReady')}`}</option>)}
              {draft.managedModelRef && !managedModels.some(model => model.ref === draft.managedModelRef) && <option value={draft.managedModelRef}>{draft.managedModel?.model ?? draft.managedModelRef} · {t('managed.notReady')}</option>}
            </select>
          </div>
        </div>}

        {draft && snapshot && <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" className="h-auto min-h-10 w-full justify-between px-0 text-left" aria-label={t('configuration')}>
              <span>{t('configuration')}</span><ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-5 pt-2">
            <div className="space-y-2"><Label htmlFor="email-classification-execution-mode">{t('deliveryMode')}</Label>
              <select id="email-classification-execution-mode" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-ring disabled:opacity-50" value={draft.executionMode} disabled={busy}
                onChange={event => edit(current => ({ ...current, executionMode: event.target.value as 'direct' | 'managed' }))}>
                <option value="managed">{t('managed.title')}</option><option value="direct">{t('directMode')}</option>
              </select>
            </div>
            {managed ? <dl className="grid gap-3 rounded-md border p-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">{t('provider')}</dt><dd>{managedModel?.providerId ?? draft.managedModel?.providerId ?? t('unknown')}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('model')}</dt><dd className="break-all">{managedModel?.model ?? draft.managedModel?.model ?? t('unknown')}</dd></div>
            </dl> : <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="email-classification-provider">{t('provider')}</Label>
                <select id="email-classification-provider" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-ring disabled:opacity-50" value={draft.providerId} disabled={busy}
                  onChange={event => { const next = snapshot.providerOptions.find(option => option.id === event.target.value); if (next) edit(current => ({ ...current, providerId: next.id, model: next.defaultModel,
                    credentialKey: next.credentialKeyDefault, endpoint: next.requiresEndpoint ? current.endpoint : null, allowPrivateNetwork: false })); }}>
                  {snapshot.providerOptions.map(option => <option key={option.id} value={option.id}>{option.id === 'typesafe' || option.id === 'systemone' ? t(`providers.${option.id}`) : option.label}</option>)}
                </select>
              </div>
              <div className="space-y-2"><Label htmlFor="email-classification-model">{t('model')}</Label><Input id="email-classification-model" value={draft.model} disabled={busy}
                onChange={event => edit(current => ({ ...current, model: event.target.value }))} /></div>
              {provider?.requiresEndpoint && <div className="space-y-2 sm:col-span-2"><Label htmlFor="email-classification-endpoint">{t('endpoint')}</Label>
                <Input id="email-classification-endpoint" type="url" value={draft.endpoint ?? ''} placeholder="https://model.example.com/v1/systemone" disabled={busy}
                  onChange={event => edit(current => ({ ...current, endpoint: event.target.value || null }))} /></div>}
              <div className="space-y-2 sm:col-span-2"><Label htmlFor="email-classification-credential">{t('credential')}</Label>
                <Input id="email-classification-credential" value={draft.credentialKey ?? ''} className="font-mono text-xs" autoComplete="off" spellCheck={false} disabled={busy}
                  onChange={event => edit(current => ({ ...current, credentialKey: event.target.value || null }))} />
                <p className="text-xs text-muted-foreground">{t('credentialHint')}</p>
                <div className="flex flex-wrap items-center gap-3 text-xs"><span>{t(`credentials.${credentials}`)}</span><Link href="/settings?tab=secrets" className="font-medium text-primary underline underline-offset-4">{t('secretsLink')}</Link></div>
              </div>
            </div>}
            <div className="space-y-3 rounded-md border p-4">
              <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
                <div className="space-y-1"><p className="text-sm font-medium">{t('testTitle')}</p><p className="text-xs leading-relaxed text-muted-foreground">{t('testHint')}</p></div>
                <Button type="button" variant="outline" className="shrink-0" disabled={busy || managed && (managedCatalog?.status !== 'ready' || !managedModel?.available)} onClick={() => void test()}>
                  {action === 'test' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}{t('testAction')}
                </Button>
              </div>
              {probe && <InlineNotice variant="success" title={t('testPassed', { latency: probe.latencyMs })}>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-4">
                  <div><dt className="text-muted-foreground">{t('category')}</dt><dd>{probe.classification.category ? t(`categories.${probe.classification.category}`) : t('unknown')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('priority')}</dt><dd>{probe.classification.priority ? t(`priorities.${probe.classification.priority}`) : t('unknown')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('spam')}</dt><dd>{Math.round(probe.ratings.spamProbability * 100)}%</dd></div>
                  <div><dt className="text-muted-foreground">{t('reply')}</dt><dd>{Math.round(probe.ratings.replyProbability * 100)}%</dd></div>
                </dl>
              </InlineNotice>}
            </div>
            <details className="rounded-md border" data-testid="email-classification-advanced">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium focus-visible:outline-ring">{t('advanced')}</summary>
              <div className="space-y-5 px-4 pb-4">
                <p className="text-xs leading-relaxed text-muted-foreground">{t('limitsHint')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {LIMITS.map(field => <div key={field.key} className="space-y-2"><Label htmlFor={`email-classification-${field.key}`}>{t(`limits.${field.key}`)}</Label>
                    <Input id={`email-classification-${field.key}`} type="number" min={field.min} max={field.max} step={1} value={draft[field.key]} disabled={busy}
                      onChange={event => edit(current => ({ ...current, [field.key]: Number(event.target.value) }))} /></div>)}
                </div>
                {!managed && provider?.requiresEndpoint && <div className="flex items-start justify-between gap-4 rounded-md bg-muted/30 p-3"><div className="space-y-1">
                  <Label htmlFor="email-classification-private-network">{t('privateNetwork')}</Label><p className="text-xs text-muted-foreground">{t('privateNetworkHint')}</p>
                </div><Switch id="email-classification-private-network" checked={draft.allowPrivateNetwork} disabled={busy} onCheckedChange={allowPrivateNetwork => edit(current => ({ ...current, allowPrivateNetwork }))} /></div>}
                <details className="rounded-md border"><summary className="cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-ring">{t('contextAndCriteria')}</summary>
                  <div className="space-y-4 px-3 pb-3">
                    {(['personalPurpose', 'workPurpose'] as const).map(key => <div key={key} className="space-y-2"><Label htmlFor={`email-classification-${key}`}>{t(key)}</Label>
                      <Textarea id={`email-classification-${key}`} value={draft.questionProfile[key]} maxLength={2000} disabled={busy}
                        onChange={event => edit(current => ({ ...current, questionProfile: { ...current.questionProfile, [key]: event.target.value } }))} /></div>)}
                    <p className="text-xs text-muted-foreground">{t('criteriaHint')}</p>
                    {EMAIL_CATEGORY_IDS.map(category => <div key={category} className="space-y-2"><Label htmlFor={`email-classification-category-${category}`}>{t(`categories.${category}`)}</Label>
                      <Textarea id={`email-classification-category-${category}`} value={draft.questionProfile.categoryCriteria[category]} maxLength={2000} disabled={busy}
                        onChange={event => edit(current => ({ ...current, questionProfile: { ...current.questionProfile, categoryCriteria: { ...current.questionProfile.categoryCriteria, [category]: event.target.value } } }))} /></div>)}
                  </div>
                </details>
                <details className="rounded-md border"><summary className="cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-ring">{t('thresholdsTitle')}</summary>
                  <div className="space-y-4 px-3 pb-3"><p className="text-xs text-muted-foreground">{t('thresholdsHint')}</p>
                    <div className="grid gap-4 sm:grid-cols-2">{THRESHOLDS.map(key => <div key={key} className="space-y-2"><Label htmlFor={`email-classification-${key}`}>{t(`thresholds.${key}`)}</Label>
                      <Input id={`email-classification-${key}`} type="number" min={0} max={100} step={1} value={Number((draft.policy[key] * 100).toFixed(4))} disabled={busy}
                        onChange={event => edit(current => ({ ...current, policy: { ...current.policy, [key]: Number(event.target.value) / 100 } }))} /></div>)}</div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{t('spamValidationHint')}</p>
                  </div>
                </details>
                <details className="rounded-md border"><summary className="cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-ring">{t('processingDetails')}</summary>
                  <div className="space-y-2 px-3 pb-3 text-xs text-muted-foreground">
                    <p>{snapshot.health.counts ? t('progress', snapshot.health.counts) : t('processing.unavailable')}</p>
                    <p>{snapshot.health.budget.remaining === null ? t('budgetUnknown') : t('budget', { remaining: snapshot.health.budget.remaining, limit: snapshot.health.budget.limit })}</p>
                    {snapshot.health.mailboxes && <p>{t('mailboxProgress', { active: snapshot.health.mailboxes.active, complete: snapshot.health.mailboxes.complete, failed: snapshot.health.mailboxes.failed })}</p>}
                  </div>
                </details>
              </div>
            </details>
          </CollapsibleContent>
        </Collapsible>}
        {draft && <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-xs text-muted-foreground">{dirty ? t('saveHint') : t('savedScope')}</p>
          <Button type="button" disabled={!dirty || busy || serverChanged || baseRevision === null} onClick={() => void save()}>
            {action === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t('save')}
          </Button>
        </div>}
      </CardContent>
    </Card>
  );
}
