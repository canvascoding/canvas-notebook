'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Check, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SearchablePolicyTargetPicker, type PolicyTargetOption } from '@/app/components/organization/SearchablePolicyTargetPicker';
import type { CapabilityPackagePresentation } from '@/app/lib/capabilities/packages/presentation-contracts';
import type { CapabilityPackageStoreInstallOptions } from '@/app/lib/capabilities/packages/store-install-options-contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreInstallRequest, CapabilityPackageStoreSelection,
  CapabilityPackageStoreUpdateReview } from '@/app/lib/capabilities/packages/store-contracts';
import { PackageWorkspaceRequestError, workspaceRequest } from './plugin-workspace-client';
import { usePluginEditorNavigationGuard } from './plugin-navigation-guard';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';

type Ownership = CapabilityPackageStoreInstallRequest['ownership'];
type ScopeChoice = { type: 'user' | 'organization' | 'team'; workspaceId?: string; label: string };
type UserGrant = CapabilityPackageStoreInstallRequest['grants'][number] & { targetType: 'user' };
type Failure = 'conflict' | 'accessError' | 'requestError';
export type StorePackageWizardProps = {
  source: CapabilityPackageStoreSelection;
  workspaceId: string | null;
  initialOwnership: Ownership;
  resourceRef?: string;
  releaseNotes?: string | null;
  onInstalled: (result: CapabilityPackageStoreApplicationResult) => void;
  onUpdated: (result: CapabilityPackageStoreApplicationResult) => void;
  onClose: () => void;
};

function scopeKey(value: Ownership | ScopeChoice): string {
  return value.type === 'team' ? `team:${value.workspaceId}` : value.type;
}
function scopeOwnership(value: ScopeChoice): Ownership | null {
  return value.type === 'team' ? value.workspaceId ? { type: 'team', workspaceId: value.workspaceId } : null : { type: value.type };
}
function sameSelection(a: CapabilityPackageStoreSelection, b: CapabilityPackageStoreSelection): boolean {
  return a.kind === b.kind && a.registryId === b.registryId && a.entryKey === b.entryKey && a.version === b.version && a.checksum === b.checksum;
}
function presentationChanges(before: CapabilityPackagePresentation, after: CapabilityPackagePresentation) {
  const compare = <T,>(oldItems: T[], newItems: T[], key: (item: T) => string, label: (item: T) => string) => {
    const oldByKey = new Map(oldItems.map(item => [key(item), item])), newByKey = new Map(newItems.map(item => [key(item), item]));
    const rows: Array<{ key: string; label: string; change: 'added' | 'removed' | 'changed' }> = [];
    for (const [id, item] of newByKey) {
      if (!oldByKey.has(id)) rows.push({ key: id, label: label(item), change: 'added' });
      else if (JSON.stringify(oldByKey.get(id)) !== JSON.stringify(item)) rows.push({ key: id, label: label(item), change: 'changed' });
    }
    for (const [id, item] of oldByKey) if (!newByKey.has(id)) rows.push({ key: id, label: label(item), change: 'removed' });
    return rows;
  };
  return {
    children: compare(before.children, after.children, item => item.name, item => item.title),
    scripts: compare(before.scripts, after.scripts, item => `${item.skillName}:${item.id}`, item => item.title),
    requirements: compare([...before.requirements.map(item => ({ key: `${item.declaredBy.kind}:${item.declaredBy.name}:${item.source}:${item.label}`, label: item.label, value: JSON.stringify(item) })),
      ...before.capabilities.map(item => ({ key: `${item.declaredBy.kind}:${item.declaredBy.name}:capability:${item.id}`, label: item.application, value: JSON.stringify(item) }))],
    [...after.requirements.map(item => ({ key: `${item.declaredBy.kind}:${item.declaredBy.name}:${item.source}:${item.label}`, label: item.label, value: JSON.stringify(item) })),
      ...after.capabilities.map(item => ({ key: `${item.declaredBy.kind}:${item.declaredBy.name}:capability:${item.id}`, label: item.application, value: JSON.stringify(item) }))], item => item.key, item => item.label),
  };
}

/** Each exact Store selection and installed-resource context owns a separate request lifecycle. */
export function StorePackageWizard(props: StorePackageWizardProps) {
  return <StorePackageWizardSession key={JSON.stringify([props.source.kind, props.source.registryId, props.source.entryKey, props.source.version,
    props.source.checksum, props.workspaceId, scopeKey(props.initialOwnership), props.resourceRef ?? ''])} {...props} />;
}

function StorePackageWizardSession({ source, workspaceId, initialOwnership, resourceRef, releaseNotes, onInstalled, onUpdated, onClose }: StorePackageWizardProps) {
  const t = useTranslations('skills.workspace');
  const [selection] = useState(() => ({ ...source }));
  const [preview, setPreview] = useState<CapabilityPackagePresentation | null>(null);
  const [current, setCurrent] = useState<CapabilityPackagePresentation | null>(null);
  const [review, setReview] = useState<CapabilityPackageStoreUpdateReview | null>(null);
  const [scopes, setScopes] = useState<ScopeChoice[]>([]);
  const [selectedScope, setSelectedScope] = useState(scopeKey(initialOwnership));
  const [options, setOptions] = useState<CapabilityPackageStoreInstallOptions | null>(null);
  const [grants, setGrants] = useState<UserGrant[]>([]);
  const [responsible, setResponsible] = useState('');
  const [replaceLocalChanges, setReplaceLocalChanges] = useState(false);
  const [step, setStep] = useState<'preview' | 'sharing' | 'complete'>('preview');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<CapabilityPackageStoreApplicationResult | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const generation = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const callbacks = useRef({ onInstalled, onUpdated });
  const delivered = useRef<CapabilityPackageStoreApplicationResult | null>(null);
  useEffect(() => { callbacks.current = { onInstalled, onUpdated }; }, [onInstalled, onUpdated]);
  usePluginEditorNavigationGuard({ dirty: false, pending });
  const update = Boolean(resourceRef);
  const json = (value: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal });
  const classify = (error: unknown): Failure => error instanceof PackageWorkspaceRequestError
    ? error.status === 409 ? 'conflict' : error.status === 403 || error.status === 404 ? 'accessError' : 'requestError' : 'requestError';
  const applyFailure = (error: unknown) => {
    const next = classify(error);
    setFailure(next); setOptions(null); setReview(null);
    if (next === 'accessError') { setPreview(null); setCurrent(null); setScopes([]); setGrants([]); setResponsible(''); }
  };
  const beginRead = () => {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    return { controller, attempt: ++generation.current };
  };
  const isCurrent = (attempt: number, controller: AbortController) => alive.current && attempt === generation.current && !controller.signal.aborted;

  const load = useCallback(async () => {
    const { controller, attempt } = beginRead(); setLoading(true); setFailure(null); setReview(null); setOptions(null); setReplaceLocalChanges(false);
    try {
      const next = await workspaceRequest<{ presentation: CapabilityPackagePresentation }>('/api/capabilities/packages/store/preview', workspaceId, json({ source: selection }, controller.signal));
      if (!isCurrent(attempt, controller)) return;
      if (!next.presentation.source || !sameSelection(next.presentation.source, selection)) throw new PackageWorkspaceRequestError(409, 'PACKAGE_SOURCE_CHANGED', '');
      if (resourceRef) {
        const installed = await workspaceRequest<{ presentation: CapabilityPackagePresentation }>(`/api/capabilities/packages/${encodeURIComponent(resourceRef)}/presentation`, workspaceId, { signal: controller.signal });
        const nextReview = await workspaceRequest<CapabilityPackageStoreUpdateReview>(`/api/capabilities/packages/${encodeURIComponent(resourceRef)}/store-update/review`, workspaceId, json({ source: selection }, controller.signal));
        if (!isCurrent(attempt, controller)) return;
        if (installed.presentation.resourceRef !== resourceRef || nextReview.resourceRef !== resourceRef || !sameSelection(nextReview.source, selection)) throw new PackageWorkspaceRequestError(409, 'PACKAGE_SOURCE_CHANGED', '');
        setCurrent(installed.presentation); setReview(nextReview);
      } else {
        const available = await workspaceRequest<{ scopes: ScopeChoice[] }>('/api/capabilities/packages/scopes', workspaceId, { signal: controller.signal });
        if (!isCurrent(attempt, controller)) return;
        setScopes(available.scopes);
      }
      setPreview(next.presentation);
    } catch (error) { if (isCurrent(attempt, controller)) applyFailure(error); }
    finally { if (isCurrent(attempt, controller)) setLoading(false); }
    // Selection is captured by the keyed session; callbacks and mutable form state do not restart reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, workspaceId, resourceRef]);

  useEffect(() => {
    alive.current = true;
    const initialGeneration = generation.current;
    void Promise.resolve().then(() => { if (alive.current && generation.current === initialGeneration) void load(); });
    return () => { alive.current = false; generation.current += 1; readController.current?.abort(); mutationController.current?.abort(); };
  }, [load]);

  useEffect(() => {
    if (!alive.current || pending || step !== 'complete' || !result || delivered.current === result) return;
    delivered.current = result;
    (resourceRef ? callbacks.current.onUpdated : callbacks.current.onInstalled)(result);
  }, [pending, result, resourceRef, step]);

  const loadOptions = async () => {
    const chosen = scopes.find(scope => scopeKey(scope) === selectedScope), owner = chosen ? scopeOwnership(chosen) : null;
    if (!owner) return;
    const { controller, attempt } = beginRead(); setLoading(true); setFailure(null); setOptions(null);
    try {
      const next = await workspaceRequest<CapabilityPackageStoreInstallOptions>('/api/capabilities/packages/store/install-options', workspaceId, json({ source: selection, ownership: owner }, controller.signal));
      if (!isCurrent(attempt, controller)) return;
      if (!sameSelection(next.source, selection) || scopeKey(next.ownership) !== scopeKey(owner)) throw new PackageWorkspaceRequestError(409, 'PACKAGE_SOURCE_CHANGED', '');
      const allowed = new Set(next.targets.users.map(user => user.userId));
      setGrants(existing => existing.filter(grant => allowed.has(grant.targetId))); setResponsible(existing => allowed.has(existing) ? existing : '');
      setOptions(next); setStep('sharing');
    } catch (error) { if (isCurrent(attempt, controller)) applyFailure(error); }
    finally { if (isCurrent(attempt, controller)) setLoading(false); }
  };

  const submit = async () => {
    if (mutationController.current || pending || loading || failure || !preview || update && (!review?.canUpdate || review.requiresLocalChangesConfirmation && !replaceLocalChanges) || !update && !options) return;
    const chosen = scopes.find(scope => scopeKey(scope) === selectedScope), owner = chosen ? scopeOwnership(chosen) : null;
    if (!update && (!owner || !options || scopeKey(options.ownership) !== selectedScope)) return;
    const controller = new AbortController(); mutationController.current = controller;
    const attempt = generation.current; setPending(true); setFailure(null);
    let completed: CapabilityPackageStoreApplicationResult | null = null;
    try {
      const body = resourceRef && review ? { source: selection, expectedMetadataRevision: review.expectedMetadataRevision,
        expectedGrantsRevision: review.expectedGrantsRevision, expectedPackageRevision: review.expectedPackageRevision,
        expectedPublishedRevisionRef: review.expectedPublishedRevisionRef, expectedLocalChecksum: review.expectedLocalChecksum, replaceLocalChanges }
        : { source: selection, ownership: owner, grants, responsibleUserId: responsible || null };
      completed = await workspaceRequest<CapabilityPackageStoreApplicationResult>(resourceRef ? `/api/capabilities/packages/${encodeURIComponent(resourceRef)}/store-update`
        : '/api/capabilities/packages/store/install', workspaceId, json(body, controller.signal));
      if (!isCurrent(attempt, controller)) return;
      if (resourceRef && completed.resource.resourceRef !== resourceRef) throw new PackageWorkspaceRequestError(409, 'PACKAGE_SOURCE_CHANGED', '');
      setResult(completed); setStep('complete');
    } catch (error) { if (isCurrent(attempt, controller)) applyFailure(error); completed = null; }
    finally {
      if (mutationController.current === controller) mutationController.current = null;
      if (alive.current && attempt === generation.current) setPending(false);
    }
  };

  const users: PolicyTargetOption[] = options?.targets.users.map(user => ({ id: user.userId, label: user.name || user.email || t('storeWizard.unnamedUser'), description: user.name ? user.email : null })) || [];
  const remainingUsers = users.filter(user => !grants.some(grant => grant.targetId === user.id));
  const changes = preview && current ? presentationChanges(current, preview) : null;
  const flagLabels = { canUse: t('storeWizard.use'), canEdit: t('storeWizard.edit'), canManage: t('storeWizard.manage') };
  const busy = loading || pending;
  const close = () => { if (!pending) { readController.current?.abort(); onClose(); } };
  const reload = () => { if (step === 'sharing' && !update) void loadOptions(); else void load(); };

  return <section ref={setPortalContainer} data-testid="store-package-wizard" aria-busy={busy} className="min-w-0 space-y-5 [&_[data-slot=popover-content]_.font-mono]:hidden">
    <header className="flex min-w-0 items-start gap-4">
      <PluginExtensionAvatar name={preview?.title || selection.entryKey} identity={JSON.stringify([selection.kind, selection.registryId, selection.entryKey, selection.version, selection.checksum, workspaceId])} icon={preview?.icon} size="lg" />
      <div className="min-w-0 space-y-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground">{t(update ? 'storeWizard.titleUpdate' : 'storeWizard.titleInstall')}</p>
      <h2 className="break-words text-xl font-semibold tracking-tight">{preview?.title || selection.entryKey}</h2>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {current ? <><span>{t('storeWizard.installedVersion', { version: current.version })}</span><ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></> : null}
        <span>{t('storeWizard.selectedVersion', { version: selection.version })}</span>
      </div>
      </div>
    </header>
    {!update && step !== 'complete' ? <ol aria-label={t('storeWizard.steps')} className="flex flex-wrap gap-x-5 gap-y-2 border-y py-3 text-xs">
      {(['preview', 'sharing'] as const).map((item, index) => <li key={item} aria-current={step === item ? 'step' : undefined} className={step === item ? 'font-medium text-foreground' : 'text-muted-foreground'}>
        <span className="mr-1.5 tabular-nums">{index + 1}.</span>{t(`storeWizard.step${item === 'preview' ? 'Preview' : 'Sharing'}`)}
      </li>)}
    </ol> : null}
    {failure ? <InlineNotice variant={failure === 'conflict' ? 'warning' : 'destructive'} data-testid="store-wizard-error"
      actions={<Button type="button" variant="outline" size="sm" disabled={busy} onClick={reload}><RefreshCw className="h-3.5 w-3.5" />{t('storeWizard.reviewAgain')}</Button>}>
      {t(`storeWizard.${failure}`)}
    </InlineNotice> : null}
    {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{t('storeWizard.loading')}</p> : null}
    {step === 'complete' && result ? <div className="space-y-3" data-testid="store-wizard-complete">
      <InlineNotice variant="success" title={t(update ? 'storeWizard.updated' : 'storeWizard.installed')}>
        {t('storeWizard.completedVersion', { version: result.published.version })}
      </InlineNotice>
      <p className="text-sm text-muted-foreground">{t('storeWizard.remainingSetup')}</p>
    </div> : preview && step === 'preview' ? <div className="space-y-5">
      <p className="break-words text-sm leading-relaxed text-muted-foreground">{preview.description}</p>
      <details className="rounded-lg border px-3 py-2" data-testid="store-wizard-package-details"><summary className="cursor-pointer text-sm font-medium">{t('storeWizard.packageDetails')}</summary>
        <div className="mt-3 space-y-4 text-sm">
          {preview.children.length ? <div><h3 className="mb-1 font-medium">{t('storeWizard.children')}</h3><ul className="space-y-2">{preview.children.map(child => <li key={child.name} className="flex min-w-0 items-start gap-3">
            <PluginExtensionAvatar name={child.title} identity={JSON.stringify([selection, workspaceId, 'child', child.name])} icon={child.icon} size="sm" />
            <div className="min-w-0 break-words"><span>{child.title}</span>{child.version ? <span className="ml-2 text-xs text-muted-foreground">{child.version}</span> : null}<p className="text-xs text-muted-foreground">{child.description}</p></div></li>)}</ul></div> : null}
          {preview.scripts.length ? <div><h3 className="mb-1 font-medium">{t('storeWizard.scripts')}</h3><ul className="space-y-1">{preview.scripts.map(script => <li key={`${script.skillName}:${script.id}`} className="break-words">{script.title}<span className="ml-2 text-xs text-muted-foreground">{script.runtime.kind}{script.runtime.minimumVersion ? ` ≥ ${script.runtime.minimumVersion}` : ''}</span></li>)}</ul></div> : null}
          {preview.requirements.length || preview.capabilities.length ? <div><h3 className="mb-1 font-medium">{t('storeWizard.requirements')}</h3><ul className="space-y-2">
            {preview.capabilities.map((capability, index) => <li key={`${capability.declaredBy.name}:${capability.id}:${index}`} className="flex min-w-0 items-start gap-3">
              <PluginExtensionAvatar name={capability.application} identity={JSON.stringify([selection, workspaceId, capability.declaredBy, 'capability', capability.id, index])} size="sm" />
              <div className="min-w-0 break-words">{capability.application}<span className="ml-2 text-xs text-muted-foreground">{t(capability.required ? 'storeWizard.required' : 'storeWizard.optional')} · {capability.alternatives.map(alternative => alternative.label).join(' / ')}</span></div></li>)}
            {preview.requirements.map((requirement, index) => <li key={`${requirement.declaredBy.name}:${requirement.source}:${index}`} className="flex min-w-0 items-start gap-3">
              <PluginExtensionAvatar name={requirement.label} identity={JSON.stringify([selection, workspaceId, requirement.declaredBy, 'requirement', requirement.source, requirement.selector, index])} size="sm" />
              <div className="min-w-0 break-words">{requirement.label}<span className="ml-2 text-xs text-muted-foreground">{t(requirement.required ? 'storeWizard.required' : 'storeWizard.optional')}</span></div></li>)}
            </ul><p className="mt-2 text-xs text-muted-foreground">{t('storeWizard.connectionSeparation')}</p></div> : null}
          {preview.compatibility.length || preview.minCanvasVersion ? <div><h3 className="mb-1 font-medium">{t('storeWizard.compatibility')}</h3>{preview.minCanvasVersion ? <p>{t('storeWizard.minimumCanvas', { version: preview.minCanvasVersion })}</p> : null}<ul>{preview.compatibility.map(value => <li key={value} className="break-words">{value}</li>)}</ul></div> : null}
          {preview.requiredEnv.length ? <div><h3 className="mb-1 font-medium">{t('storeWizard.configuration')}</h3><p className="break-words font-mono text-xs">{preview.requiredEnv.join(', ')}</p><p className="mt-1 text-xs text-muted-foreground">{t('storeWizard.configurationHint')}</p></div> : null}
          {preview.license ? <p className="break-words text-xs text-muted-foreground">{t('storeWizard.license', { license: preview.license })}</p> : null}
        </div>
      </details>
      {update && changes ? <div className="space-y-3" data-testid="store-wizard-changes"><h3 className="text-sm font-medium">{t('storeWizard.changes')}</h3>
        {(['children', 'scripts', 'requirements'] as const).map(kind => changes[kind].length ? <div key={kind}><p className="text-xs font-medium text-muted-foreground">{t(`storeWizard.${kind}`)}</p><ul className="mt-1 space-y-1 text-sm">{changes[kind].map(item => <li key={item.key} className="flex min-w-0 flex-wrap gap-x-2"><span className="break-words">{item.label}</span><span className="text-xs text-muted-foreground">{t(`storeWizard.${item.change}`)}</span></li>)}</ul></div> : null)}
        {!Object.values(changes).some(rows => rows.length) ? <p className="text-sm text-muted-foreground">{t('storeWizard.noDeclaredChanges')}</p> : null}
        <p className="text-xs text-muted-foreground">{t('storeWizard.updatePreserves')}</p>
      </div> : null}
      {releaseNotes ? <details className="rounded-lg border px-3 py-2"><summary className="cursor-pointer text-sm font-medium">{t('storeWizard.releaseNotes')}</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{releaseNotes}</p></details> : null}
      {update ? <>
        {review && !review.canUpdate ? <InlineNotice variant="warning">{t('storeWizard.updateUnavailable')}</InlineNotice> : null}
        {review?.requiresLocalChangesConfirmation ? <label className="flex items-start gap-3 rounded-lg border p-3 text-sm"><input data-testid="store-wizard-replace-local" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={replaceLocalChanges} disabled={busy} onChange={event => setReplaceLocalChanges(event.target.checked)} /><span>{t('storeWizard.replaceLocal')}</span></label> : null}
      </> : <div className="space-y-2"><Label htmlFor="store-wizard-target">{t('storeWizard.target')}</Label><select id="store-wizard-target" data-testid="store-wizard-target" className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" value={scopes.some(scope => scopeKey(scope) === selectedScope) ? selectedScope : ''} disabled={busy} onChange={event => { setSelectedScope(event.target.value); setOptions(null); setGrants([]); setResponsible(''); }}>
        <option value="" disabled>{t('storeWizard.chooseTarget')}</option>{scopes.map(scope => <option key={scopeKey(scope)} value={scopeKey(scope)}>{scope.label}</option>)}
      </select><p className="text-xs text-muted-foreground">{t('storeWizard.targetHint')}</p>{!loading && !scopes.length ? <p className="text-sm text-muted-foreground">{t('storeWizard.noTargets')}</p> : null}</div>}
    </div> : options && step === 'sharing' ? <div className="space-y-5" data-testid="store-wizard-sharing">
      <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t('storeWizard.target')}</p><p className="mt-1 break-words text-sm font-medium">{options.ownershipLabel}</p><p className="mt-2 text-xs text-muted-foreground">{t('storeWizard.disabledRestricted')}</p></div>
      <div className="space-y-2 [&_span.font-mono]:hidden"><Label htmlFor="store-wizard-responsible">{t('storeWizard.responsible')}</Label><div className="flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1"><SearchablePolicyTargetPicker id="store-wizard-responsible" testId="store-wizard-responsible" label={t('storeWizard.responsible')} value={responsible} options={users} placeholder={t('storeWizard.noResponsible')} searchPlaceholder={t('storeWizard.searchPeople')} emptyLabel={t('storeWizard.noPeople')} portalContainer={portalContainer} disabled={busy} onValueChange={setResponsible} /></div>{responsible ? <Button type="button" variant="ghost" size="sm" className="shrink-0" disabled={busy} onClick={() => setResponsible('')}>{t('storeWizard.clear')}</Button> : null}</div></div>
      <div className="space-y-3"><div><h3 className="text-sm font-medium">{t('storeWizard.access')}</h3><p className="mt-1 text-xs text-muted-foreground">{t('storeWizard.accessHint')}</p></div>
        <div className="[&_span.font-mono]:hidden"><SearchablePolicyTargetPicker id="store-wizard-add-user" testId="store-wizard-add-user" label={t('storeWizard.addPerson')} value="" options={remainingUsers} placeholder={t('storeWizard.addPerson')} searchPlaceholder={t('storeWizard.searchPeople')} emptyLabel={t('storeWizard.noPeople')} portalContainer={portalContainer} disabled={busy || !remainingUsers.length} onValueChange={userId => { if (users.some(user => user.id === userId)) setGrants(existing => existing.some(grant => grant.targetId === userId) ? existing : [...existing, { targetType: 'user', targetId: userId, canUse: false, canEdit: false, canManage: false }]); }} /></div>
        {grants.map(grant => <div key={grant.targetId} data-testid="store-wizard-grant" className="min-w-0 space-y-3 rounded-lg border p-3"><div className="flex min-w-0 items-center justify-between gap-2"><p className="min-w-0 break-words text-sm font-medium">{users.find(user => user.id === grant.targetId)?.label}</p><Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={busy} aria-label={t('storeWizard.removePerson', { name: users.find(user => user.id === grant.targetId)?.label || '' })} onClick={() => setGrants(existing => existing.filter(item => item.targetId !== grant.targetId))}><Trash2 className="h-3.5 w-3.5" /></Button></div>
          <div className="flex flex-wrap gap-x-5 gap-y-3">{(['canUse', 'canEdit', 'canManage'] as const).map(flag => <label key={flag} className="flex items-center gap-2 text-xs"><Switch aria-label={`${users.find(user => user.id === grant.targetId)?.label}: ${flagLabels[flag]}`} checked={grant[flag]} disabled={busy} onCheckedChange={checked => setGrants(existing => existing.map(item => item.targetId === grant.targetId ? { ...item, [flag]: checked } : item))} />{flagLabels[flag]}</label>)}</div>
        </div>)}
      </div><p className="text-xs text-muted-foreground">{t('storeWizard.connectionSeparation')}</p>
    </div> : null}
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
      {step === 'sharing' && !failure ? <Button type="button" variant="ghost" disabled={busy} onClick={() => { setStep('preview'); setOptions(null); }}><ArrowLeft className="h-3.5 w-3.5" />{t('storeWizard.back')}</Button> : <span />}
      <div className="flex min-w-0 flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={close}>{t(step === 'complete' ? 'storeWizard.close' : 'storeWizard.cancel')}</Button>
        {step === 'preview' && !update ? <Button type="button" disabled={busy || Boolean(failure) || !preview || !scopes.some(scope => scopeKey(scope) === selectedScope)} onClick={() => void loadOptions()}>{t('storeWizard.confirmTarget')}<ArrowRight className="h-3.5 w-3.5" /></Button> : step !== 'complete' ? <Button type="button" disabled={busy || Boolean(failure) || !preview || update && (!review?.canUpdate || review.requiresLocalChangesConfirmation && !replaceLocalChanges) || !update && !options} onClick={() => void submit()}>{pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{t(update ? 'storeWizard.applyUpdate' : 'storeWizard.install')}</Button> : null}
      </div>
    </footer>
  </section>;
}
