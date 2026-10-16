'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronDown, Loader2, Plus, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import type { PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import { updatePluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import type { PluginExtensionItem } from '@/app/lib/plugins/plugin-extension-contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreSelection } from '@/app/lib/capabilities/packages/store-contracts';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InlineNotice } from '@/components/ui/inline-notice';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { usePluginNavigation } from './usePluginNavigation';
import { confirmPluginNavigation } from './plugin-navigation-guard';
import { usePluginExtensionSearch } from './usePluginExtensionSearch';
import { usePluginWorkspaceData } from './usePluginWorkspaceData';
import { PluginExtensionSearchResults } from './PluginExtensionSearchResults';
import { PackageDetailWorkspace } from './PackageDetailWorkspace';
import { StorePackageWizard } from './StorePackageWizard';
import { PluginIntegrationDetail } from './PluginIntegrationDetail';
import { PluginMcpSetup } from './PluginMcpSetup';
import { PluginCreatorMenu } from './PluginCreatorMenu';

const clearDetail = { plugin: undefined, skill: undefined, source: undefined, resourceId: undefined, resourceRef: undefined,
  draftRef: undefined, task: undefined, file: undefined, storeRegistryId: undefined, storeVersion: undefined, storeChecksum: undefined,
  extensionId: undefined, setup: undefined, connectionRef: undefined, sharedOAuth: undefined } satisfies Partial<PluginNavigation>;
const kinds = ['all', 'plugin', 'skill', 'integration', 'mcp'] as const;

export function PluginExtensionWorkspace({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('skills.workspace.catalog'), shell = useTranslations('skills.workspace.shell');
  const { navigation, navigate } = usePluginNavigation();
  const workspaceLabel = useWorkspaceStore(state => state.workspaces.find(workspace => workspace.id === workspaceId)?.name);
  const [epoch, setEpoch] = useState(0), [filtersOpen, setFiltersOpen] = useState(false);
  const [update, setUpdate] = useState<{ selection: string; source: CapabilityPackageStoreSelection; resourceRef: string } | null>(null);
  const data = usePluginExtensionSearch({ navigation, workspaceId, epoch });
  const retryCatalog = data.retry;
  const packageData = usePluginWorkspaceData({ navigation, workspaceId, epoch });
  const detailOpen = Boolean(navigation.resourceRef || navigation.source === 'store' || navigation.extensionId || navigation.setup);
  const listContext = JSON.stringify([workspaceId, navigation.q ?? '', navigation.kind ?? 'all', navigation.scope,
    navigation.audience ?? null, navigation.teamId ?? null, navigation.stock ?? 'all', navigation.extensionSource ?? 'all']);
  const root = useRef<HTMLElement | null>(null);
  const lastRow = useRef<{ id: string; scrollY: number; context: string } | null>(null);
  const pendingRestore = useRef<{ id: string | null; scrollY: number; context: string } | null>(null);
  const wasDetail = useRef({ open: detailOpen, context: listContext });
  const selectionKey = JSON.stringify([workspaceId, navigation.scope, navigation.teamId, navigation.audience, navigation.resourceRef, navigation.extensionId]);
  const selection = useRef(selectionKey);
  const pendingConnectionRefresh = useRef(false);
  useLayoutEffect(() => { selection.current = selectionKey; pendingConnectionRefresh.current = false; return () => { selection.current = ''; }; }, [selectionKey]);
  useEffect(() => {
    const returning = wasDetail.current.open && !detailOpen && wasDetail.current.context === listContext;
    wasDetail.current = { open: detailOpen, context: listContext };
    if (detailOpen || pendingRestore.current?.context !== listContext) pendingRestore.current = null;
    if (returning) pendingRestore.current = lastRow.current?.context === listContext
      ? lastRow.current : { id: null, scrollY: 0, context: listContext };
    if (!pendingRestore.current || data.status === 'loading' || data.updating) return;
    const saved = pendingRestore.current;
    pendingRestore.current = null;
    const row = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-testid="plugin-extension-row-open"]') ?? [])].find(button => button.dataset.extensionId === saved.id);
    const target = row ?? root.current?.querySelector<HTMLInputElement>('[data-testid="plugin-extension-search-input"]');
    target?.focus({ preventScroll: true });
    window.scrollTo({ top: row ? saved.scrollY : 0, behavior: 'instant' });
  }, [detailOpen, listContext, data.status, data.updating, data.items]);
  const refresh = useCallback(() => {
    if (selection.current !== selectionKey) return;
    if (navigation.extensionCursor ? !navigate({ extensionCursor: undefined }) : !confirmPluginNavigation()) return;
    setEpoch(value => value + 1);
  }, [navigate, navigation.extensionCursor, selectionKey]);
  const connectionsUpdated = useCallback(() => { if (selection.current === selectionKey) retryCatalog(); }, [retryCatalog, selectionKey]);
  const standaloneConnectionsUpdated = useCallback(() => { if (selection.current === selectionKey) pendingConnectionRefresh.current = true; }, [selectionKey]);
  const close = () => {
    const reloadConnections = pendingConnectionRefresh.current;
    if (selection.current !== selectionKey || !navigate({ ...clearDetail, ...(reloadConnections ? { extensionCursor: undefined } : {}) })) return;
    setUpdate(null);
    if (reloadConnections) { pendingConnectionRefresh.current = false; setEpoch(value => value + 1); }
  };
  const search = useCallback((q: string) => navigate({ ...clearDetail, q: q || undefined, extensionCursor: undefined }, { replace: true }), [navigate]);
  const open = (item: PluginExtensionItem, _button: HTMLButtonElement) => {
    const current = { id: item.id, scrollY: window.scrollY, context: listContext };
    let accepted = false;
    if ((item.kind === 'plugin' || item.kind === 'skill') && item.package) {
      accepted = navigate({ ...clearDetail, view: 'browse', area: item.kind === 'plugin' ? 'plugins' : 'skills', source: 'installed',
        resourceRef: item.package.resourceRef, ...(item.kind === 'plugin' ? { plugin: item.name } : { skill: item.name }), task: 'overview' });
    } else if ((item.kind === 'plugin' || item.kind === 'skill') && item.offering) {
      const offer = item.offering, version = offer.versions.find(value => value.version === offer.latestVersion && /^[a-f0-9]{64}$/u.test(value.checksum));
      if (version) accepted = navigate({ ...clearDetail, view: 'browse', area: item.kind === 'plugin' ? 'plugins' : 'skills', source: 'store',
        extensionId: item.id, ...(item.kind === 'plugin' ? { plugin: offer.entryKey } : { skill: offer.entryKey }), storeRegistryId: offer.registryId, storeVersion: version.version, storeChecksum: version.checksum });
    } else accepted = navigate({ ...clearDetail, view: 'browse', extensionId: item.id });
    if (accepted) lastRow.current = current;
  };
  const installed = (result: CapabilityPackageStoreApplicationResult) => {
    if (selection.current !== selectionKey) return;
    setEpoch(value => value + 1);
    navigate({ ...clearDetail, view: 'browse', area: result.state.kind === 'plugin' ? 'plugins' : 'skills',
      resourceRef: result.resource.resourceRef, source: 'installed', task: 'connections', extensionCursor: undefined });
  };
  const activeUpdate = update?.selection === selectionKey ? update : null;
  const sourceKind = navigation.area === 'skills' ? 'skill' : 'plugin', sourceName = navigation.area === 'skills' ? navigation.skill : navigation.plugin;
  const source: CapabilityPackageStoreSelection | null = navigation.source === 'store' && sourceName && navigation.storeRegistryId && navigation.storeVersion && navigation.storeChecksum
    ? { kind: sourceKind, registryId: navigation.storeRegistryId, entryKey: sourceName, version: navigation.storeVersion, checksum: navigation.storeChecksum } : null;
  const initialOwnership = navigation.scope === 'organization' ? { type: 'organization' as const }
    : navigation.scope === 'team' && navigation.teamId ? { type: 'team' as const, workspaceId: navigation.teamId } : { type: 'user' as const };
  const selectedItem = data.selectedItem;
  const offering = selectedItem && (selectedItem.kind === 'plugin' || selectedItem.kind === 'skill') ? selectedItem.offering : undefined;
  const returnPath = updatePluginNavigation(typeof window === 'undefined' ? '' : window.location.search, { workspaceId, view: 'browse' });
  const filterOptions = [
    ...(navigation.stock && navigation.stock !== 'all' ? [{ name: t(`stock_${navigation.stock}`), clear: { stock: undefined } }] : []),
    ...(navigation.extensionSource && navigation.extensionSource !== 'all' ? [{ name: t(`source_${navigation.extensionSource}`), clear: { extensionSource: undefined } }] : []),
    ...(navigation.scope !== 'all' ? [{ name: shell(`scope_${navigation.scope}`), clear: { scope: 'all' as const, audience: undefined, teamId: undefined } }] : []),
    ...(navigation.audience ? [{ name: shell(`audience_${navigation.audience}`), clear: { audience: undefined } }] : []),
    ...(navigation.teamId ? [{ name: data.response?.scopes.teams.find(team => team.teamId === navigation.teamId)?.label ?? shell('scope_team'), clear: { teamId: undefined } }] : []),
  ];

  return <section ref={root} className="min-w-0 space-y-5" data-testid="plugin-workspace">
    <header className="space-y-4 border-b pb-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1><p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
          {workspaceLabel ? <p className="mt-2 truncate text-xs text-muted-foreground">{shell('workspace', { name: workspaceLabel })}</p> : null}</div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1"><PluginCreatorMenu workspaceId={workspaceId} /><Button variant="ghost" size="icon" onClick={refresh} aria-label={t('refresh')} disabled={data.status === 'loading' || data.updating}><RefreshCw className="size-4" aria-hidden="true" /></Button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm">{t('manage')}<ChevronDown className="size-3.5" aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">{(['updates', 'drafts', 'advanced'] as const).map(view => <DropdownMenuItem key={view} onSelect={() => navigate({ ...clearDetail, area: 'plugins', view })}>{shell(view === 'advanced' ? 'advanced' : `view_${view}`)}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu></div>
      </div>
      <ExtensionSearch value={navigation.q ?? ''} label={t('search')} onSearch={search} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex max-w-full flex-wrap gap-1" aria-label={shell('kind')}>{kinds.map(kind => <Button key={kind} type="button" size="sm"
          variant={(navigation.kind ?? 'all') === kind ? 'secondary' : 'ghost'} aria-pressed={(navigation.kind ?? 'all') === kind}
          data-testid={`plugin-extension-kind-${kind}`} onClick={() => navigate({ kind, view: 'browse' })}>{t(`kind_${kind}`)}</Button>)}</div>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" aria-expanded={filtersOpen} aria-controls="plugin-extension-filters"
          data-testid="plugin-extension-filter-toggle" onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal className="size-3.5" aria-hidden="true" />{t(filtersOpen ? 'filterHide' : 'filter')}{filterOptions.length ? <span className="tabular-nums">{filterOptions.length}</span> : null}</Button>
          <Button type="button" size="sm" variant="outline" data-testid="plugin-extension-add-mcp" onClick={() => navigate({ ...clearDetail, setup: 'mcp' })}><Plus className="size-3.5" aria-hidden="true" />{t('addMcp')}</Button></div>
      </div>
      {filtersOpen ? <div id="plugin-extension-filters" className="grid min-w-0 gap-4 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <ExtensionSelect id="plugin-extension-stock-filter" label={t('stock')} value={navigation.stock ?? 'all'} options={(['all', 'installed', 'available'] as const).map(value => ({ value, label: t(`stock_${value}`) }))}
          onChange={stock => navigate({ stock: stock as PluginNavigation['stock'] })} />
        <ExtensionSelect id="plugin-extension-source-filter" label={t('source')} value={navigation.extensionSource ?? 'all'} options={(['all', 'store', 'composio', 'mcp'] as const).map(value => ({ value, label: t(`source_${value}`) }))}
          onChange={extensionSource => navigate({ extensionSource: extensionSource as PluginNavigation['extensionSource'] })} />
        <ExtensionSelect id="plugin-extension-scope-filter" label={shell('scope')} value={navigation.scope} options={([...new Set(['all', 'user', ...(data.response?.scopes.choices ?? []), navigation.scope])] as PluginNavigation['scope'][]).map(value => ({ value, label: shell(`scope_${value}`) }))}
          onChange={scope => navigate({ scope: scope as PluginNavigation['scope'], audience: undefined, teamId: undefined })} />
        {navigation.scope === 'user' ? <ExtensionSelect id="plugin-extension-audience-filter" label={shell('audience')} value={navigation.audience ?? 'all'}
          options={[{ value: 'all', label: t('audience_all') }, ...(['own', 'shared'] as const).map(value => ({ value, label: shell(`audience_${value}`) }))]}
          onChange={audience => navigate({ audience: audience === 'all' ? undefined : audience as 'own' | 'shared' })} /> : null}
        {navigation.scope === 'team' ? <ExtensionSelect id="plugin-extension-team-filter" label={shell('chooseTeam')} value={navigation.teamId ?? ''}
          options={[{ value: '', label: shell('chooseTeam') }, ...(data.response?.scopes.teams ?? []).map(team => ({ value: team.teamId, label: team.label }))]}
          onChange={teamId => navigate({ teamId: teamId || undefined })} /> : null}
      </div> : null}
      {filterOptions.length ? <div className="flex flex-wrap items-center gap-2" aria-label={t('activeFilters')}>{filterOptions.map((filter, index) => <Button key={`${index}:${filter.name}`} variant="secondary" size="sm"
        className="h-7 max-w-full text-xs" aria-label={t('removeFilter', { name: filter.name })} onClick={() => navigate(filter.clear)}><span className="truncate">{filter.name}</span><X className="size-3" aria-hidden="true" /></Button>)}
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => navigate({ scope: 'all', audience: undefined, teamId: undefined, stock: undefined, extensionSource: undefined })}>{t('resetFilters')}</Button></div> : null}
    </header>

    {detailOpen ? <Button type="button" variant="ghost" size="sm" className="-ml-3" data-testid="plugin-extension-back" onClick={close}><ArrowLeft className="size-4" aria-hidden="true" />{t('back')}</Button> : null}
    {navigation.setup === 'mcp' ? <PluginMcpSetup workspaceId={workspaceId} returnPath={returnPath} onClose={close} onCreated={result => {
      if (selection.current !== selectionKey) return;
      setEpoch(value => value + 1); navigate({ ...clearDetail, extensionId: result.id, extensionCursor: undefined });
    }} /> : activeUpdate && navigation.resourceRef ? <StorePackageWizard source={activeUpdate.source} workspaceId={workspaceId} initialOwnership={initialOwnership}
      resourceRef={activeUpdate.resourceRef} onInstalled={installed} onUpdated={() => { if (selection.current === selectionKey) { setUpdate(null); refresh(); navigate({ task: 'versions' }); } }}
      onClose={() => { if (confirmPluginNavigation()) setUpdate(null); }} />
      : navigation.resourceRef ? <PackageDetailWorkspace key={JSON.stringify([workspaceId, navigation.resourceRef, epoch])} resourceRef={navigation.resourceRef}
        workspaceId={workspaceId} publishedPin={navigation.publishedRevisionRef && navigation.publishedChecksum && navigation.resourceRef
          ? { resourceRef: navigation.resourceRef, publishedRevisionRef: navigation.publishedRevisionRef, checksum: navigation.publishedChecksum } : undefined} task={navigation.task ?? 'overview'} file={navigation.file} store={packageData.store} onNavigate={navigate} onUpdated={refresh} onConnectionsUpdated={connectionsUpdated} onClose={close}
        onStoreUpdate={(value, resourceRef) => { if (selection.current === selectionKey && confirmPluginNavigation()) setUpdate({ selection: selectionKey, source: value, resourceRef }); }} />
        : source ? <StorePackageWizard source={source} workspaceId={workspaceId} initialOwnership={initialOwnership}
          releaseNotes={offering?.versions.find(value => value.version === source.version && value.checksum === source.checksum)?.notes}
          onInstalled={installed} onUpdated={() => { refresh(); close(); }} onClose={close} />
          : navigation.extensionId ? selectedItem && (selectedItem.kind === 'integration' || selectedItem.kind === 'mcp')
            ? <PluginIntegrationDetail key={JSON.stringify([workspaceId, selectedItem.id])} item={selectedItem} selectionMetadata={data.selectionMetadata}
              workspaceId={workspaceId} onUpdated={standaloneConnectionsUpdated} onClose={close} returnPath={returnPath} />
            : <InlineNotice size="compact">{data.status === 'loading' || data.updating ? <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{t('loading')}</span> : shell('accessError')}</InlineNotice>
            : <PluginExtensionSearchResults data={data} workspaceId={workspaceId} onOpen={open} onMore={extensionCursor => {
              if (extensionCursor === navigation.extensionCursor) { if (confirmPluginNavigation()) data.retry(); }
              else navigate({ extensionCursor });
            }}
              onRetry={() => { if (confirmPluginNavigation()) data.retry(); }} />}
  </section>;
}

function ExtensionSelect({ id, label, value, options, onChange }: { id: string; label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <div className="min-w-0 space-y-1.5"><Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
    <select id={id} data-testid={id} value={value} className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm" onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></div>;
}

function ExtensionSearch({ value, label, onSearch }: { value: string; label: string; onSearch: (value: string) => boolean }) {
  const [draft, setDraft] = useState({ base: value, query: value });
  if (draft.base !== value) setDraft({ base: value, query: value });
  const query = draft.base === value ? draft.query : value;
  useEffect(() => {
    if (query.trim() === value) return;
    const timer = setTimeout(() => { if (!onSearch(query.trim())) setDraft({ base: value, query: value }); }, 250);
    return () => clearTimeout(timer);
  }, [query, value, onSearch]);
  return <form role="search" className="relative w-full min-w-0" onSubmit={event => { event.preventDefault(); if (query.trim() !== value && !onSearch(query.trim())) setDraft({ base: value, query: value }); }}>
    <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true" />
    <Input data-testid="plugin-extension-search-input" type="search" maxLength={512} value={query} enterKeyHint="search" aria-label={label} placeholder={label}
      className="h-10 pl-9" onChange={event => setDraft({ base: value, query: event.target.value })} />
  </form>;
}
