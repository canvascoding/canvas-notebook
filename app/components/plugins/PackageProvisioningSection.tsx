'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { authClient } from '@/app/lib/auth-client';
import type { ExtensionPackagePin } from '@/app/lib/capabilities/extensions/contracts';
import type { CapabilityPackageProvisioning, CapabilityPackageUseAudience } from '@/app/lib/capabilities/packages/provisioning-contracts';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { PackageWorkspaceRequestError, workspaceRequest } from './plugin-workspace-client';
import { usePluginEditorNavigationGuard, confirmPluginNavigation, hasPluginNavigationBlockers } from './plugin-navigation-guard';
import { startPublishedPackageChat } from './package-provisioning-client';
import { PackageAgentSetup } from './PackageAgentSetup';

type Props = { pin: ExtensionPackagePin; workspaceId: string | null; onUpdated?: () => void; onSelectVersion?: (pin: ExtensionPackagePin) => void };
const samePin = (left: ExtensionPackagePin, right: ExtensionPackagePin) => left.resourceRef === right.resourceRef
  && left.publishedRevisionRef === right.publishedRevisionRef && left.checksum === right.checksum;
const audienceKey = (value: CapabilityPackageUseAudience) => JSON.stringify(value.kind === 'users' ? { kind: 'users', userIds: [...value.userIds].sort() } : value);

/** Each session and immutable version owns its recovery, local audience draft and in-flight mutations. */
export function PackageProvisioningSection(props: Props) {
  const { data: session, isPending, error } = authClient.useSession();
  const pin = useMemo(() => ({ resourceRef: props.pin.resourceRef, publishedRevisionRef: props.pin.publishedRevisionRef, checksum: props.pin.checksum }),
    [props.pin.resourceRef, props.pin.publishedRevisionRef, props.pin.checksum]);
  if (isPending || error || !session?.user.id || !session.session.id) return null;
  return <ProvisioningSession key={JSON.stringify([session.user.id, session.session.id, props.workspaceId, props.pin])}
    {...props} pin={pin} actorId={session.user.id} sessionId={session.session.id} />;
}
function ProvisioningSession({ pin, workspaceId, onUpdated, onSelectVersion, actorId, sessionId }: Props & { actorId: string; sessionId: string }) {
  const t = useTranslations('skills.provisioning'), locale = useLocale(), router = useRouter();
  const [data, setData] = useState<CapabilityPackageProvisioning | null>(null);
  const [audience, setAudience] = useState<CapabilityPackageUseAudience>({ kind: 'users', userIds: [] });
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [retry, setRetry] = useState(0);
  const [error, setError] = useState<'conflict' | 'denied' | 'unavailable' | null>(null), [saved, setSaved] = useState<'audience' | 'activation' | 'personal_activation' | null>(null);
  const alive = useRef(false), busy = useRef(false), generation = useRef(0), changed = useRef(false);
  const nextPin = useRef<ExtensionPackagePin | null>(null);
  const [navigationGeneration, setNavigationGeneration] = useState(0);
  const dirty = Boolean(data && audienceKey(data.audience) !== audienceKey(audience));
  usePluginEditorNavigationGuard({ dirty, pending: () => busy.current });
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  useEffect(() => {
    if (!pending && changed.current) { changed.current = false; if (!hasPluginNavigationBlockers()) onUpdated?.(); }
  }, [pending, onUpdated]);
  useEffect(() => {
    if (pending || !nextPin.current) return;
    const selected = nextPin.current; nextPin.current = null; onSelectVersion?.(selected);
  }, [pending, navigationGeneration, onSelectVersion]);
  const path = `/api/capabilities/packages/${encodeURIComponent(pin.resourceRef)}/provisioning`;
  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current;
    queueMicrotask(() => { if (!controller.signal.aborted && generation.current === current) { setLoading(true); setError(null); setData(null); } });
    void workspaceRequest<CapabilityPackageProvisioning>(path, workspaceId, { signal: controller.signal },
      { publishedRevisionRef: pin.publishedRevisionRef, checksum: pin.checksum }).then(result => {
      if (controller.signal.aborted || generation.current !== current) return;
      if (!samePin(result.pin, pin)) throw new PackageWorkspaceRequestError(409, 'PACKAGE_REVISION_CONFLICT');
      setData(result); setAudience(result.audience);
    }).catch(failure => {
      if (!controller.signal.aborted && generation.current === current) setError(failure instanceof PackageWorkspaceRequestError && [401,403,404].includes(failure.status) ? 'denied' : 'unavailable');
    }).finally(() => { if (!controller.signal.aborted && generation.current === current) setLoading(false); });
    return () => { controller.abort(); generation.current += 1; };
  }, [path, workspaceId, pin, retry]);
  const mutation = async (operation: 'set_use_audience' | 'activate' | 'enable_for_me') => {
    if (!data || busy.current || !data.currentHead.matchesPin || error === 'conflict' || error === 'denied') return;
    busy.current = true; setPending(true); setError(null); setSaved(null);
    try {
      const auth = await authClient.getSession();
      if (!alive.current || auth.data?.user.id !== actorId || auth.data?.session.id !== sessionId) throw new PackageWorkspaceRequestError(403, 'PACKAGE_ACCESS_DENIED');
      const result = await workspaceRequest<{ provisioning: CapabilityPackageProvisioning; changed: boolean; completedStep: 'audience' | 'activation' | 'personal_activation' }>(path, workspaceId,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, pin, ...data.expected,
          ...(operation === 'set_use_audience' ? { audience } : {}),
          ...(operation === 'enable_for_me' ? { expectedPersonalActivationRevision: data.personalActivation.revision } : {}) }) });
      if (!alive.current) return;
      if (!samePin(result.provisioning.pin, pin)) throw new PackageWorkspaceRequestError(409, 'PACKAGE_REVISION_CONFLICT');
      setData(result.provisioning); setAudience(result.provisioning.audience); setSaved(result.completedStep); changed.current = result.changed;
    } catch (failure) {
      if (alive.current) setError(failure instanceof PackageWorkspaceRequestError && failure.status === 409 ? 'conflict'
        : failure instanceof PackageWorkspaceRequestError && [401,403,404].includes(failure.status) ? 'denied' : 'unavailable');
    } finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const currentVersion = async () => {
    if (!data || busy.current || !onSelectVersion || !confirmPluginNavigation()) return;
    setAudience(data.audience);
    busy.current = true; setPending(true); setError(null);
    try {
      const result = await workspaceRequest<{ versions: Array<{ revisionRef: string; checksum: string }> }>(`/api/capabilities/packages/${encodeURIComponent(pin.resourceRef)}/versions`, workspaceId);
      const selected = result.versions.find(value => value.revisionRef === data.currentHead.publishedRevisionRef);
      if (!selected || !/^[a-f0-9]{64}$/u.test(selected.checksum)) throw new Error('Unavailable version');
      if (alive.current) { nextPin.current = { resourceRef: pin.resourceRef, publishedRevisionRef: selected.revisionRef, checksum: selected.checksum }; setNavigationGeneration(value => value + 1); }
    } catch { if (alive.current) setError('unavailable'); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const chat = async () => {
    if (!workspaceId || busy.current || !confirmPluginNavigation()) return;
    busy.current = true; setPending(true); setError(null);
    try { await startPublishedPackageChat(workspaceId, pin, locale, href => router.push(href), () => alive.current); }
    catch { if (alive.current) setError('unavailable'); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const locked = loading || pending || !data?.currentHead.matchesPin || error === 'conflict' || error === 'denied';
  return <section className="min-w-0 space-y-5 rounded-xl border p-4 sm:p-5" data-testid="package-provisioning">
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-lg font-semibold">{t('title')}</h2>
      <p className="mt-1 break-words text-sm text-muted-foreground">{data ? t('publishedVersion', { name: data.name, version: data.version }) : t('loading')}</p></div>
      <Button type="button" variant="outline" size="sm" disabled={pending || loading} data-testid="provisioning-reload" onClick={() => { if (confirmPluginNavigation()) setRetry(value => value + 1); }}><RefreshCw className="size-4" />{t('reload')}</Button></header>
    {loading ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{t('loading')}</p> : null}
    {error ? <InlineNotice variant="warning" size="compact">{t(`errors.${error}`)}</InlineNotice> : null}
    {saved ? <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" />{t(`saved.${saved}`)}</p> : null}
    {data ? <>
      {!data.currentHead.matchesPin ? <InlineNotice variant="warning" actions={onSelectVersion ? <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void currentVersion()}>{t('openCurrent')}</Button> : undefined}>{t('headChanged')}</InlineNotice> : null}
      <fieldset disabled={locked} className="min-w-0 space-y-3"><legend className="mb-2 text-sm font-semibold">{t('audienceTitle')}</legend>
        <p className="text-sm text-muted-foreground">{t('audienceHint')}</p>
        {(['users','organization'] as const).map(kind => <label key={kind} className="flex min-h-10 items-center gap-3 text-sm"><input type="radio" name="package-audience" checked={audience.kind === kind}
          onChange={() => setAudience(kind === 'organization' ? { kind } : { kind, userIds: data.audience.kind === 'users' ? [...data.audience.userIds] : [] })} data-testid={`provisioning-audience-${kind}`} />{t(kind)}</label>)}
        {audience.kind === 'users' ? <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border p-3">{data.targets.users.map(user => <label key={user.userId} className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" checked={audience.userIds.includes(user.userId)}
          disabled={locked || !audience.userIds.includes(user.userId) && audience.userIds.length >= 100} onChange={event => setAudience({ kind: 'users', userIds: event.target.checked
            ? [...audience.userIds, user.userId] : audience.userIds.filter(id => id !== user.userId) })} /><span className="min-w-0 break-words">{user.name || user.email || t('unnamedUser')}{user.name && user.email ? <span className="block text-xs text-muted-foreground">{user.email}</span> : null}</span></label>)}
          {!data.targets.users.length ? <p className="text-sm text-muted-foreground">{t('noUsers')}</p> : null}</div> : null}
        {data.otherUseTargets.length ? <InlineNotice size="compact">{t('otherTargets')}</InlineNotice> : null}
        <Button type="button" variant="outline" disabled={locked || !dirty && !data.otherUseTargets.length} data-testid="provisioning-save-audience" onClick={() => void mutation('set_use_audience')}>{t('saveAudience')}</Button>
      </fieldset>
      <div className="space-y-2 border-t pt-4"><h3 className="text-sm font-semibold">{t('activationTitle')}</h3><p className="text-sm text-muted-foreground">{t(data.defaultEnabled ? 'active' : 'inactive')}</p>
        <Button type="button" className="h-auto min-h-10 max-w-full whitespace-normal" disabled={locked || dirty || data.defaultEnabled} data-testid="provisioning-activate" onClick={() => void mutation('activate')}>{pending ? <Loader2 className="size-4 animate-spin" /> : null}{t('activate')}</Button>
        <p className="text-xs text-muted-foreground">{t('activationHint')}</p>
        {data.policy.effectivePolicy === 'blocked' ? <InlineNotice variant="warning" size="compact">{t('policyBlocked')}</InlineNotice> : null}
        {!data.policy.canUse ? <InlineNotice size="compact">{t('useNotGranted')}</InlineNotice> : data.defaultEnabled && data.currentHead.matchesPin && data.policy.effectivePolicy !== 'blocked' && !data.policy.enabled ? <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">{t('personalHint')}</p><Button type="button" variant="outline" className="h-auto min-h-10 max-w-full whitespace-normal" disabled={locked || dirty}
            data-testid="provisioning-enable-for-me" onClick={() => void mutation('enable_for_me')}>{t('enableForMe')}</Button></div> : null}
      </div>
      <div className="space-y-3 border-t pt-4"><h3 className="text-sm font-semibold">{t('nextTitle')}</h3><p className="text-sm text-muted-foreground">{t('connectionsHint')}</p><p className="text-sm" data-testid="provisioning-readiness">{t(`readiness.${data.policy.readiness}`)}</p>
        <Button type="button" variant="outline" className="h-auto min-h-10 max-w-full whitespace-normal" disabled={!workspaceId || pending || dirty || !data.policy.enabled || !data.policy.canUse} data-testid="provisioning-chat" onClick={() => void chat()}><MessageSquare className="size-4" />{t('chat')}</Button>
        {workspaceId ? <PackageAgentSetup workspaceId={workspaceId} resourceRef={pin.resourceRef} packageName={data.name} suggestedPackage={pin} /> : <p className="text-sm text-muted-foreground">{t('chooseWorkspace')}</p>}
      </div>
      <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('exactVersion')}</summary><ul className="mt-2 space-y-2 text-xs [overflow-wrap:anywhere]">{[pin.resourceRef,pin.publishedRevisionRef,pin.checksum].map(value => <li key={value} className="font-mono">{value}</li>)}</ul></details>
    </> : null}
  </section>;
}
