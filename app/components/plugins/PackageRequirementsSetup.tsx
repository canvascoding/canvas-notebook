'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { authClient } from '@/app/lib/auth-client';
import type { CapabilityPackageMcpTemplate, CapabilityPackagePresentation, CapabilityPackageRequirementSelector } from '@/app/lib/capabilities/packages/presentation-contracts';
import type { PluginExtensionConnection, PluginExtensionItem, PluginExtensionSearchResponse } from '@/app/lib/plugins/plugin-extension-contracts';
import { Button } from '@/components/ui/button';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';
import { Badge } from '@/components/ui/badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Link } from '@/i18n/navigation';
import { PackageAgentSetup } from './PackageAgentSetup';
import { PluginIntegrationDetail } from './PluginIntegrationDetail';
import { PluginMcpSetup } from './PluginMcpSetup';
import { pluginCatalogReturnPath, pluginIntegrationRequest } from './plugin-integration-client';
import { inspectSharedPluginConnection } from './plugin-connection-observation-client';
import { confirmPluginNavigation } from './plugin-navigation-guard';

type Extension = Extract<PluginExtensionItem, {kind: 'integration' | 'mcp'}>;
type Row = {id: string; label: string; required: boolean; selectors: CapabilityPackageRequirementSelector[]};
type Candidate = {item: Extension; connection: PluginExtensionConnection};
type CatalogObservation = {items: Extension[]; unavailable: boolean};
type Observation = {candidates: Candidate[]; integrations: Extension[]; unavailable: boolean};
export type PackageRequirementsSetupProps = {presentation: CapabilityPackagePresentation; workspaceId: string | null; returnPath: string; onUpdated: () => void};
const selectorKey = (selector: CapabilityPackageRequirementSelector) => selector.source === 'composio' ? `composio:${selector.toolkit}` : `mcp:${selector.connector}`;

/** Alternatives remain one requirement; canonical selectors, rather than titles, select setup targets. */
function setupRows(presentation: CapabilityPackagePresentation): Row[] {
  const declared = new Set<string>(), rows: Row[] = [];
  for (const value of presentation.capabilities) {
    const selectors = value.alternatives.flatMap(alternative => alternative.selector ? [alternative.selector] : []);
    for (const selector of selectors) declared.add(`${value.declaredBy.kind}:${value.declaredBy.name}:${selectorKey(selector)}:${value.required}`);
    rows.push({id: `${value.declaredBy.kind}:${value.declaredBy.name}:capability:${value.id}`, label: value.application, required: value.required, selectors});
  }
  for (const [index, value] of presentation.requirements.entries()) {
    if (value.selector && declared.has(`${value.declaredBy.kind}:${value.declaredBy.name}:${selectorKey(value.selector)}:${value.required}`)) continue;
    rows.push({id: `${value.declaredBy.kind}:${value.declaredBy.name}:requirement:${index}`, label: value.label, required: value.required, selectors: value.selector ? [value.selector] : []});
  }
  return rows.sort((a, b) => Number(b.required) - Number(a.required));
}
const usable = (value: PluginExtensionConnection) => value.enabled && value.access.canUse && (value.authorization === 'authorized' || value.authorization === 'not_required');

export function PackageRequirementsSetup(props: PackageRequirementsSetupProps) {
  const {data: session, isPending, error} = authClient.useSession();
  return <RequirementsSession key={JSON.stringify([session?.user.id, session?.session.id, props.workspaceId, props.presentation.resourceRef, props.presentation.version])} {...props}
    actorId={session?.user.id ?? null} sessionId={session?.session.id ?? null} enabled={Boolean(session && !isPending && !error)} />;
}
function RequirementsSession({presentation, workspaceId, returnPath, onUpdated, actorId, sessionId, enabled}: PackageRequirementsSetupProps & {
  actorId: string | null; sessionId: string | null; enabled: boolean;
}) {
  const t = useTranslations('skills.workspace.setup'), rawLocale = useLocale(), locale = rawLocale === 'de' ? 'de' : 'en';
  const rows = useMemo(() => setupRows(presentation), [presentation]);
  const [sharedObservations, setSharedObservations] = useState<Record<string, {connection: PluginExtensionConnection; loading: boolean; error: boolean}>>({});
  const sharedReads = useRef(new Map<string, AbortController>());
  const [observations, setObservations] = useState<Record<string, Observation>>({}), [chosen, setChosen] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true), [error, setError] = useState(false), [setup, setSetup] = useState<{row: Row; item?: Extension; template?: CapabilityPackageMcpTemplate} | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(false), alive = useRef(false), generation = useRef(0), read = useRef<AbortController | null>(null);
  const isCurrent = useCallback(() => { const current = authClient.$store.atoms.session.get(); return alive.current && enabled && !current.isPending && !current.error
    && current.data?.user.id === actorId && current.data?.session.id === sessionId; }, [actorId, sessionId, enabled]);
  const expectedChecksum = presentation.sourceStamp?.checksum;
  const sourceMatches = useCallback((source: CapabilityPackageMcpTemplate['source']) => {
    const expected = presentation.sourceStamp?.parent || (presentation.resourceRef && presentation.sourceStamp ? {resourceRef: presentation.resourceRef, ...presentation.sourceStamp} : null);
    return Boolean(expected && source.resourceRef === expected.resourceRef && source.checksum === expected.checksum && source.artifactRevision === expected.artifactRevision);
  }, [presentation.resourceRef, presentation.sourceStamp]);
  const exactReturn = presentation.resourceRef ? pluginCatalogReturnPath(returnPath, locale, workspaceId, {resourceRef: presentation.resourceRef}) : returnPath;
  const load = useCallback(async () => {
    if (!isCurrent()) return;
    read.current?.abort(); const controller = new AbortController(), attempt = ++generation.current; read.current = controller;
    for (const pending of sharedReads.current.values()) pending.abort(); sharedReads.current.clear(); setSharedObservations({});
    setLoading(true); setError(false);
    try {
      const selectors = new Map(rows.flatMap(row => row.selectors.map(selector => [selectorKey(selector), selector] as const)));
      const values = await Promise.all([...selectors].map(async ([key, selector]) => {
        const query = new URLSearchParams({types: selector.source === 'composio' ? 'integration' : 'mcp', source: selector.source === 'composio' ? 'composio' : 'mcp', scope: 'all', limit: '1'});
        if (selector.source === 'composio') query.set('selected', `composio:${selector.toolkit}`);
        try {
          if (selector.source === 'mcp') {
            if (!presentation.resourceRef || !expectedChecksum) return [key, {items: [] as Extension[], unavailable: true}] as const;
            const verified = await pluginIntegrationRequest<{matches: Array<{connectionRef: string; compatibility: 'endpoint' | 'stdio'}>; coverage: 'complete' | 'partial'; source: CapabilityPackageMcpTemplate['source']}>(
              `/api/capabilities/packages/${encodeURIComponent(presentation.resourceRef)}/mcp-matches?${new URLSearchParams({connector: selector.connector, expectedChecksum})}`, workspaceId, {signal: controller.signal});
            if (!sourceMatches(verified.source)) throw new Error('package_source_changed');
            const matches = await Promise.all(verified.matches.map(async match => {
              const selectedQuery = new URLSearchParams({types: 'mcp', source: 'mcp', scope: 'all', selected: match.connectionRef, limit: '1'});
              const response = await pluginIntegrationRequest<PluginExtensionSearchResponse>(`/api/plugins/search?${selectedQuery}`, workspaceId, {signal: controller.signal});
              return response.selectedItem?.kind === 'mcp' && response.selectedItem.id === match.connectionRef ? response.selectedItem : null;
            }));
            return [key, {items: matches.filter((item): item is Extract<PluginExtensionItem, {kind: 'mcp'}> => item !== null), unavailable: verified.coverage === 'partial' || matches.some(value => !value)}] as const;
          }
          const response = await pluginIntegrationRequest<PluginExtensionSearchResponse>(`/api/plugins/search?${query}`, workspaceId, {signal: controller.signal});
          const items = response.selectedItem?.kind === 'integration' && response.selectedItem.toolkit.slug === selector.toolkit ? [response.selectedItem] : [];
          return [key, {items, unavailable: response.coverage.some(value => value.source === 'composio' && value.status !== 'complete')}] as const;
        } catch { return [key, {items: [] as Extension[], unavailable: true}] as const; }
      }));
      if (!isCurrent() || attempt !== generation.current) return;
      const sources = new Map<string, CatalogObservation>(values), next: Record<string, Observation> = {};
      for (const row of rows) {
        const sourcesForRow = row.selectors.map(selector => sources.get(selectorKey(selector))), integrations = sourcesForRow.flatMap(value => value?.items || []);
        const candidates = new Map(integrations.flatMap(item => item.connections.filter(value => value.access.canRead).map(connection => [connection.connectionRef, {item, connection}] as const)));
        next[row.id] = {candidates: [...candidates.values()], integrations, unavailable: sourcesForRow.some(value => !value || value.unavailable)};
      }
      setObservations(next);
      setChosen(previous => Object.fromEntries(Object.entries(previous).filter(([id, ref]) => next[id]?.candidates.some(value => value.connection.connectionRef === ref))));
    } catch { if (isCurrent() && !controller.signal.aborted && attempt === generation.current) setError(true); }
    finally { if (isCurrent() && attempt === generation.current) setLoading(false); }
  }, [isCurrent, rows, workspaceId, presentation.resourceRef, expectedChecksum, sourceMatches]);
  useEffect(() => { alive.current = true; const pendingReads = sharedReads.current; queueMicrotask(() => void load()); return () => { alive.current = false; generation.current += 1; read.current?.abort(); for (const pending of pendingReads.values()) pending.abort(); pendingReads.clear(); }; }, [load]);
  const refresh = () => { void load(); onUpdated(); };
  const closeSetup = () => { if (confirmPluginNavigation()) setSetup(null); };
  async function openSetup(row: Row, selector: CapabilityPackageRequirementSelector, candidate?: Candidate) {
    if (!isCurrent() || loadingSetup || !confirmPluginNavigation()) return;
    if (candidate) { setSetup({row, item: candidate.item}); return; }
    if (selector.source === 'composio') {
      const item = observations[row.id]?.integrations.find(value => value.kind === 'integration' && value.toolkit.slug === selector.toolkit);
      if (item) setSetup({row, item}); else setError(true);
      return;
    }
    if (!presentation.resourceRef || !expectedChecksum) { setError(true); return; }
    setLoadingSetup(true); setError(false);
    try {
      const response = await pluginIntegrationRequest<{template: CapabilityPackageMcpTemplate}>(`/api/capabilities/packages/${encodeURIComponent(presentation.resourceRef)}/mcp-template?${new URLSearchParams({connector: selector.connector, expectedChecksum})}`, workspaceId);
      if (isCurrent() && response.template.resourceRef === presentation.resourceRef && response.template.connector.name === selector.connector && sourceMatches(response.template.source)) setSetup({row, template: response.template});
    } catch { if (isCurrent()) setError(true); } finally { if (isCurrent()) setLoadingSetup(false); }
  }
  async function chooseExisting(row: Row, reference: string) {
    if (!isCurrent()) return;
    setChosen(value => ({...value, [row.id]: reference}));
    const candidate = observations[row.id]?.candidates.find(value => value.connection.connectionRef === reference);
    if (!candidate || candidate.connection.ownership.type === 'user') return;
    sharedReads.current.get(reference)?.abort(); const controller = new AbortController(), attempt = generation.current; sharedReads.current.set(reference, controller);
    setSharedObservations(value => ({...value, [reference]: {connection: {...candidate.connection, authorization: 'unknown'}, loading: true, error: false}}));
    try {
      const connection = await inspectSharedPluginConnection(candidate.connection, candidate.item.kind === 'mcp' ? 'mcp' : 'composio', workspaceId,
        {signal: controller.signal, noAuth: candidate.item.kind === 'integration' && candidate.item.toolkit.noAuth, isCurrent});
      if (isCurrent() && !controller.signal.aborted && generation.current === attempt) setSharedObservations(value => ({...value, [reference]: {connection, loading: false, error: false}}));
    } catch { if (isCurrent() && !controller.signal.aborted && generation.current === attempt) setSharedObservations(value => ({...value, [reference]: {connection: {...candidate.connection, authorization: 'unknown'}, loading: false, error: true}})); }
  }
  const currentConnection = (value: Candidate) => sharedObservations[value.connection.connectionRef]?.connection || value.connection;
  const missing = rows.filter(row => row.required && !observations[row.id]?.candidates.some(value => value.connection.connectionRef === chosen[row.id] && usable(currentConnection(value)))).length;
  function renderRow(row: Row, index: number) {
    const observation = observations[row.id], selected = observation?.candidates.find(value => value.connection.connectionRef === chosen[row.id]);
    const connection = selected ? currentConnection(selected) : null, status = connection && sharedObservations[connection.connectionRef];
    const displayedItem = selected?.item || observation?.integrations.find(value => value.kind === 'integration') || observation?.integrations[0];
    return <article key={row.id} className="space-y-3 rounded-xl border p-4" data-testid={`package-requirement-${index}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-3"><PluginExtensionAvatar name={row.label} identity={JSON.stringify([presentation.resourceRef || presentation.name, row.id, workspaceId])} icon={displayedItem?.icon} size="md" /><h3 className="min-w-0 break-words text-sm font-semibold">{row.label}</h3></div><Badge variant="outline">{t(row.required ? 'required' : 'optional')}</Badge></div>
      {observation?.candidates.length ? <div className="space-y-2"><label className="block text-xs text-muted-foreground" htmlFor={`package-requirement-connection-${index}`}>{t('selectConnection')}</label>
        <select id={`package-requirement-connection-${index}`} data-testid={`package-requirement-connection-${index}`} className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={chosen[row.id] || ''}
          disabled={loadingSetup} onChange={event => void chooseExisting(row, event.target.value)}><option value="">{t('selectConnection')}</option>
          {observation.candidates.map(value => <option key={value.connection.connectionRef} value={value.connection.connectionRef} disabled={!value.connection.access.canUse || !value.connection.enabled}>
            {value.connection.displayName} · {value.connection.ownershipLabel || t(value.connection.ownership.type === 'user' ? 'personal' : 'shared')}
          </option>)}</select>
        {connection ? <div className="flex flex-wrap gap-2 text-xs"><Badge variant="secondary">{t(!connection.access.canUse ? 'restricted' : connection.authorization === 'required' ? 'authRequired' : usable(connection) ? 'connected' : 'authorizationUnknown')}</Badge>
          <Badge variant="outline">{t(connection.health === 'healthy' ? 'ready' : connection.health === 'unavailable' ? 'unavailable' : 'unknown')}</Badge></div> : null}
        {status?.loading ? <p className="text-xs text-muted-foreground" role="status">{t('loading')}</p> : status?.error ? <p className="text-xs text-muted-foreground">{t('metadataUnavailable')}</p> : null}
        {selected ? <Button variant="outline" size="sm" onClick={() => { if (confirmPluginNavigation()) setSetup({row, item: selected.item}); }}>{t('manage')}</Button> : null}
      </div> : <p className="text-sm text-muted-foreground">{t(observation?.unavailable ? 'unavailable' : 'missing')}</p>}
      {row.selectors.length ? <div className="flex flex-wrap gap-2">{row.selectors.map((selector, at) => <Button key={selectorKey(selector)} variant="outline" disabled={loadingSetup || loading}
        data-testid={at === 0 ? `package-requirement-connect-${index}` : `package-requirement-connect-${index}-${at}`} onClick={() => void openSetup(row, selector)}>
        {t('continueSetup')}{row.selectors.length > 1 ? ` · ${selector.source === 'composio' ? selector.toolkit : selector.connector}` : ''}</Button>)}</div>
        : <Link className="text-sm underline underline-offset-4" href="/settings?tab=integrations">{t('continueSetup')}</Link>}
      {observation?.unavailable && observation.candidates.length ? <p className="text-xs text-muted-foreground">{t('partialCoverage')}</p> : null}
    </article>;
  }
  return <section className="space-y-5" data-testid="package-requirements-setup">
    <header className="space-y-2"><h2 className="text-lg font-semibold">{t('requirementsTitle')}</h2><p className="text-sm leading-relaxed text-muted-foreground">{t('requirementsHint')}</p></header>
    {error ? <InlineNotice variant="warning" size="compact">{t('loadError')}</InlineNotice> : null}
    {setup ? <div className="space-y-3 rounded-xl border p-4">{setup.item ? <PluginIntegrationDetail item={setup.item} workspaceId={workspaceId} returnPath={exactReturn} onClose={closeSetup} onUpdated={refresh} />
      : setup.template ? <PluginMcpSetup workspaceId={workspaceId} template={setup.template} returnPath={exactReturn} onClose={closeSetup} onCreated={result => { setChosen(value => ({...value, [setup.row.id]: result.id})); setSetup(null); refresh(); }} /> : null}</div> : <>
      {loading ? <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p> : <InlineNotice size="compact">{t(missing ? 'setupIncomplete' : 'managementSeparate')}</InlineNotice>}
      <div className="space-y-3">{rows.map((row, index) => row.required ? renderRow(row, index) : null)}</div>
      {rows.some(row => !row.required) ? <details className="space-y-3" data-testid="package-optional-requirements"><summary className="cursor-pointer text-sm font-medium">{t('optional')}</summary><div className="mt-3 space-y-3">{rows.map((row, index) => !row.required ? renderRow(row, index) : null)}</div></details> : null}
    </>}
    {presentation.requiredEnv.length ? <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">{t('secretsHint')}</summary><p className="my-3 break-words font-mono text-xs">{presentation.requiredEnv.join(', ')}</p><Link className="text-sm underline underline-offset-4" href="/settings?tab=secrets">{t('openSecrets')}</Link></details> : null}
    {workspaceId && presentation.resourceRef ? <PackageAgentSetup workspaceId={workspaceId} resourceRef={presentation.resourceRef} packageName={presentation.title} /> : null}
  </section>;
}
