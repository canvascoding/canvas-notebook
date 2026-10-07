'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Building2, CircleUserRound, Loader2, RefreshCw, Search, UsersRound } from 'lucide-react';
import type { PluginNavigation, PluginManagementScope } from '@/app/lib/plugins/plugin-navigation';
import type { PluginWorkspaceCatalogItem } from '@/app/lib/plugins/plugin-workspace-catalog-contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreSelection } from '@/app/lib/capabilities/packages/store-contracts';
import type { CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SearchablePolicyTargetPicker } from '@/app/components/organization/SearchablePolicyTargetPicker';
import { usePluginNavigation } from './usePluginNavigation';
import { confirmPluginNavigation } from './plugin-navigation-guard';
import { usePluginWorkspaceData } from './usePluginWorkspaceData';
import { useLegacyPluginWorkspaceSelection } from './useLegacyPluginWorkspaceSelection';
import { PluginWorkspaceLists } from './PluginWorkspaceLists';
import { PackageDetailWorkspace } from './PackageDetailWorkspace';
import { StorePackageWizard } from './StorePackageWizard';
import { PackageDraftsWorkspace } from './PackageDraftsWorkspace';
import { SharedConnectionsSection } from './SharedConnectionsSection';

const clearDetail = { plugin: undefined, skill: undefined, source: undefined, resourceId: undefined, resourceRef: undefined,
  draftRef: undefined, task: undefined, file: undefined, storeRegistryId: undefined, storeVersion: undefined, storeChecksum: undefined } satisfies Partial<PluginNavigation>;
const primaryScopes = ['user', 'team', 'organization'] as const;

export function PluginWorkspace(_props: { canManageOrganizationCapabilities: boolean }) {
  const { navigation } = usePluginNavigation();
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const initialized = useWorkspaceStore(state => state.initialized);
  const t = useTranslations('skills.workspace.shell');
  const workspaceId = navigation.workspaceId ?? activeWorkspaceId;
  if (!initialized || !workspaceId) return <p className="flex items-center gap-2 py-12 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t('loading')}</p>;
  return <PluginWorkspaceSession key={workspaceId} workspaceId={workspaceId} />;
}

/** Every read and action uses this explicit browsing workspace; URL selection grants no authority. */
function PluginWorkspaceSession({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('skills.workspace.shell');
  const { navigation, navigate } = usePluginNavigation();
  const organizationId = useWorkspaceStore(state => state.organizationId);
  const workspaceLabel = useWorkspaceStore(state => state.workspaces.find(workspace => workspace.id === workspaceId)?.name);
  const [epoch, setEpoch] = useState(0), [portal, setPortal] = useState<HTMLElement | null>(null);
  const [update, setUpdate] = useState<{ key: string; source: CapabilityPackageStoreSelection; resourceRef: string } | null>(null);
  const legacy = useLegacyPluginWorkspaceSelection(navigation, workspaceId);
  const resourceRef = navigation.resourceRef ?? legacy?.resourceRef ?? undefined;
  const data = usePluginWorkspaceData({ navigation: resourceRef && !navigation.resourceRef ? { ...navigation, resourceRef } : navigation, workspaceId, epoch });
  const kind = navigation.kind ?? (navigation.area === 'skills' ? 'skill' : 'all');
  const view = navigation.view === 'library' || navigation.view === 'discover' ? 'store' : navigation.view;
  const selectionKey = JSON.stringify([workspaceId, navigation.scope, navigation.teamId, navigation.audience, resourceRef]);
  const selection = useRef(selectionKey);
  useLayoutEffect(() => { selection.current = selectionKey; }, [selectionKey]);
  const refresh = useCallback(() => setEpoch(value => value + 1), []);
  const closeDetail = () => navigate(clearDetail);
  const sourceName = navigation.area === 'skills' ? navigation.skill : navigation.plugin;
  const sourceKind = navigation.area === 'skills' ? 'skill' : 'plugin';
  const group = data.store?.stores.find(store => store.kind === sourceKind);
  const offering = group?.offerings.find(item => item.entryKey === sourceName);
  const selectedVersion = offering?.versions.find(version => version.version === navigation.storeVersion)
    ?? offering?.versions.find(version => version.version === offering.latestVersion);
  const source: CapabilityPackageStoreSelection | null = navigation.source !== 'store' || !sourceName ? null
    : navigation.storeRegistryId && navigation.storeVersion && navigation.storeChecksum
      ? { kind: sourceKind, registryId: navigation.storeRegistryId, entryKey: sourceName, version: navigation.storeVersion, checksum: navigation.storeChecksum }
      : offering && selectedVersion ? { kind: sourceKind, registryId: offering.registryId, entryKey: offering.entryKey, version: selectedVersion.version, checksum: selectedVersion.checksum } : null;
  const activeUpdate = update?.key === selectionKey ? update : null;
  const initialOwnership = navigation.scope === 'organization' ? { type: 'organization' as const }
    : navigation.scope === 'team' && navigation.teamId ? { type: 'team' as const, workspaceId: navigation.teamId } : { type: 'user' as const };
  const sharedOwnership: CapabilityResourceOwnerScope | undefined = organizationId && navigation.scope === 'organization'
    ? { type: 'organization', organizationId } : organizationId && navigation.scope === 'team' && navigation.teamId
      ? { type: 'team', organizationId, workspaceId: navigation.teamId } : undefined;
  const openResource = (item: PluginWorkspaceCatalogItem) => navigate({ ...clearDetail,
    area: item.kind === 'plugin' ? 'plugins' : 'skills', kind, view: view === 'updates' ? 'updates' : 'installed',
    ...(item.kind === 'plugin' ? { plugin: item.name } : { skill: item.name }), source: 'installed', resourceRef: item.resourceRef, task: 'overview' });
  const openOffering = (value: CapabilityPackageStoreSelection) => navigate({ ...clearDetail,
    area: value.kind === 'plugin' ? 'plugins' : 'skills', kind, view: value.kind === 'plugin' ? 'discover' : 'library',
    ...(value.kind === 'plugin' ? { plugin: value.entryKey } : { skill: value.entryKey }), source: 'store',
    storeRegistryId: value.registryId, storeVersion: value.version, storeChecksum: value.checksum });
  const installed = (result: CapabilityPackageStoreApplicationResult) => {
    if (selection.current !== selectionKey) return;
    const owner = result.resource.ownership;
    navigate({ ...clearDetail, area: result.state.kind === 'plugin' ? 'plugins' : 'skills', kind: result.state.kind,
      view: 'installed', scope: owner.type === 'system' ? 'system' : owner.type,
      teamId: owner.type === 'team' ? owner.workspaceId : undefined, audience: owner.type === 'user' ? 'own' : undefined,
      resourceRef: result.resource.resourceRef, task: 'overview', q: undefined, page: undefined });
    refresh();
  };
  const tabs = ['installed', 'store', 'updates', 'drafts'] as const;
  const detailOpen = Boolean(resourceRef || legacy || navigation.source === 'store' && sourceName);
  const changeScope = (scope: PluginManagementScope) => navigate({ scope, ...clearDetail });
  const scopeChoices = data.catalog?.scopes.choices ?? [];
  const errorKey = data.error?.code.includes('ACCESS') || data.error?.code.includes('NOT_FOUND') ? 'accessError' : 'loadError';

  return <section className="min-w-0 space-y-6" data-testid="plugin-workspace">
    <header className="space-y-5 border-b pb-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
          {workspaceLabel ? <p className="mt-2 truncate text-xs text-muted-foreground">{t('workspace', { name: workspaceLabel })}</p> : null}</div>
        <Button variant="ghost" size="icon" onClick={() => { if (confirmPluginNavigation()) refresh(); }} aria-label={t('refresh')} disabled={data.status === 'loading'}><RefreshCw className="size-4" /></Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex max-w-full flex-wrap gap-1 rounded-lg bg-muted/60 p-1" aria-label={t('scope')}>
          {primaryScopes.filter(scope => scope === 'user' || scope === navigation.scope || scopeChoices.includes(scope)).map(scope => {
            const Icon = scope === 'user' ? CircleUserRound : scope === 'team' ? UsersRound : Building2;
            return <Button key={scope} type="button" size="sm" variant={navigation.scope === scope ? 'secondary' : 'ghost'} aria-pressed={navigation.scope === scope}
              data-testid={`plugin-workspace-scope-${scope}`} onClick={() => changeScope(scope)}><Icon className="size-4" aria-hidden="true" />{t(`scope_${scope}`)}</Button>;
          })}
        </div>
        <select className="h-8 max-w-full rounded-md border bg-background px-2 text-xs text-muted-foreground" aria-label={t('moreScopes')}
          value={navigation.scope === 'all' || navigation.scope === 'system' ? navigation.scope : ''}
          onChange={event => { if (event.target.value) changeScope(event.target.value as PluginManagementScope); }}>
          <option value="">{t('moreScopes')}</option><option value="all">{t('scope_all')}</option>
          {scopeChoices.includes('system') || navigation.scope === 'system' ? <option value="system">{t('scope_system')}</option> : null}
        </select>
        {navigation.scope === 'user' ? <div className="flex flex-wrap gap-1" aria-label={t('audience')}>
          {(['own', 'shared'] as const).map(audience => <Button key={audience} variant="ghost" size="sm" aria-pressed={(navigation.audience ?? 'own') === audience}
            className={(navigation.audience ?? 'own') === audience ? 'font-semibold underline underline-offset-4' : 'text-muted-foreground'}
            onClick={() => navigate({ audience })}>{t(`audience_${audience}`)}</Button>)}
        </div> : navigation.scope === 'team' ? <div className="w-full min-w-0 sm:w-72 [&_.font-mono]:hidden" ref={setPortal}>
          <SearchablePolicyTargetPicker id="plugin-workspace-team" value={navigation.teamId ?? ''} label={t('chooseTeam')}
            options={(data.catalog?.scopes.teams ?? []).map(team => ({ id: team.teamId, label: team.label, description: null }))}
            placeholder={t('chooseTeam')} searchPlaceholder={t('searchTeams')} emptyLabel={t('noTeams')} portalContainer={portal}
            testId="plugin-workspace-team-picker" disabled={data.status === 'loading'} onValueChange={teamId => navigate({ teamId })} />
        </div> : null}
      </div>
      <Tabs value={view === 'advanced' ? '' : view} onValueChange={value => navigate({ view: value === 'store' ? navigation.area === 'skills' ? 'library' : 'discover' : value as PluginNavigation['view'] })}>
        <TabsList className="h-auto max-w-full flex-wrap gap-1 bg-transparent p-0">
          {tabs.map(tab => <TabsTrigger key={tab} value={tab} className="rounded-md px-3 py-2 data-[state=active]:bg-muted" data-testid={`plugin-workspace-view-${tab}`}>
            {t(`view_${tab}`)}{tab === 'updates' && data.store && data.store.installed.summary.updates > 0 ? <span className="ml-2 text-xs tabular-nums">{data.store.installed.summary.updates}</span> : null}
          </TabsTrigger>)}
        </TabsList>
      </Tabs>
    </header>

    {view === 'drafts' ? <PackageDraftsWorkspace workspaceId={workspaceId} /> : activeUpdate && resourceRef ? <StorePackageWizard source={activeUpdate.source} workspaceId={workspaceId}
      initialOwnership={initialOwnership} resourceRef={activeUpdate.resourceRef} onInstalled={installed}
      onUpdated={() => { if (selection.current === selectionKey) { setUpdate(null); refresh(); navigate({ task: 'versions' }); } }}
      onClose={() => { if (confirmPluginNavigation()) setUpdate(null); }} />
      : resourceRef ? <PackageDetailWorkspace key={JSON.stringify([workspaceId, resourceRef, epoch])} resourceRef={resourceRef}
        workspaceId={workspaceId} task={navigation.task ?? 'overview'} file={navigation.file} store={data.store} onNavigate={navigate}
        onUpdated={refresh} onClose={closeDetail} onStoreUpdate={(value, canonicalRef) => { if (confirmPluginNavigation()) setUpdate({ key: selectionKey, source: value, resourceRef: canonicalRef }); }} />
        : source ? <div className="space-y-4">
          {offering && offering.registryId === source.registryId && offering.versions.some(version => version.version === source.version && version.checksum === source.checksum)
            && offering.versions.length > 1 ? <div className="flex flex-wrap items-center gap-3"><Label htmlFor="plugin-store-version">{t('version')}</Label>
            <select id="plugin-store-version" value={source.version} className="h-9 rounded-md border bg-background px-3 text-sm"
              onChange={event => { const version = offering.versions.find(item => item.version === event.target.value); if (version) navigate({ storeVersion: version.version, storeChecksum: version.checksum }); }}>
              {offering.versions.map(version => <option key={version.version} value={version.version}>{version.version}</option>)}
            </select></div> : null}
          <StorePackageWizard source={source} workspaceId={workspaceId} initialOwnership={initialOwnership}
            releaseNotes={selectedVersion?.version === source.version && selectedVersion.checksum === source.checksum && offering?.registryId === source.registryId ? selectedVersion.notes : undefined}
            onInstalled={installed} onUpdated={() => { refresh(); closeDetail(); }} onClose={closeDetail} />
        </div> : detailOpen ? <div className="space-y-4"><Button variant="ghost" onClick={closeDetail}><ArrowLeft className="size-4" />{t('back')}</Button>
          <InlineNotice size="compact">{legacy?.status === 'loading' || data.status === 'loading' ? t('loading') : legacy?.status === 'choose' ? t('chooseVariant') : legacy ? t('accessError') : t('sourceUnavailable')}</InlineNotice>
          {legacy && legacy.status !== 'loading' ? <Button variant="outline" onClick={() => navigate({ ...clearDetail, q: sourceName, kind: sourceKind })}>{t('showVariants')}</Button> : null}</div>
          : view === 'advanced' ? <div className="space-y-5"><Button variant="ghost" onClick={() => navigate({ view: 'installed' })}><ArrowLeft className="size-4" />{t('back')}</Button>
            <h2 className="text-lg font-semibold">{t('advanced')}</h2><p className="max-w-2xl text-sm text-muted-foreground">{t('connectionHint')}</p>
            {sharedOwnership ? <SharedConnectionsSection workspaceId={workspaceId} ownership={sharedOwnership} initiallyOpen />
              : <div className="flex flex-wrap gap-3"><Button variant="outline" asChild><Link href="/settings?tab=mcp">{t('manageMcp')}</Link></Button>
                <Button variant="outline" asChild><Link href="/settings?tab=integrations">{t('manageIntegrations')}</Link></Button></div>}
          </div> : <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <WorkspaceSearch key={JSON.stringify([navigation.scope, navigation.teamId, navigation.audience, navigation.q])} value={navigation.q ?? ''}
                label={t('search')} onSearch={q => navigate({ q: q || undefined })} />
              <select aria-label={t('kind')} value={kind} className="h-9 rounded-md border bg-background px-3 text-sm"
                onChange={event => navigate({ area: 'plugins', kind: event.target.value as PluginNavigation['kind'], view: view === 'store' ? 'discover' : view as PluginNavigation['view'] })}>
                <option value="all">{t('kind_all')}</option><option value="plugin">{t('kind_plugin')}</option><option value="skill">{t('kind_skill')}</option>
              </select>
            </div>
            {data.status === 'loading' ? <div className="space-y-3 py-5" role="status" aria-busy="true"><span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('loading')}</span>
              <div className="h-28 animate-pulse rounded-lg bg-muted/50" /></div> : data.status === 'error' ? <InlineNotice size="compact" variant="warning"
                actions={<Button size="sm" variant="outline" onClick={refresh}>{t('refresh')}</Button>}>{t(errorKey)}</InlineNotice> : data.catalog ? <>
                {data.error ? <InlineNotice size="compact" variant="warning">{t('limitedStore')}</InlineNotice> : null}
                <PluginWorkspaceLists catalog={data.catalog} store={data.store} view={view === 'store' || view === 'updates' ? view : 'installed'}
                  onOpenResource={openResource} onOpenOffering={openOffering} onPage={page => navigate({ page })} />
              </> : null}
          </>}
    {!detailOpen && view !== 'advanced' ? <footer className="border-t pt-4"><Button variant="link" className="h-auto p-0 text-xs text-muted-foreground" onClick={() => navigate({ view: 'advanced', area: 'plugins' })}>{t('advanced')}</Button></footer> : null}
  </section>;
}

function WorkspaceSearch({ value, label, onSearch }: { value: string; label: string; onSearch: (value: string) => void }) {
  const [query, setQuery] = useState(value);
  return <form className="relative w-full min-w-0 sm:max-w-md" role="search" onSubmit={event => { event.preventDefault(); onSearch(query.trim()); }}>
    <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
    <Input type="search" enterKeyHint="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={label} aria-label={label} className="pl-9" />
  </form>;
}
