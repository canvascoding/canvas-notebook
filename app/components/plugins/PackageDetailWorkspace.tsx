'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Loader2, RefreshCw } from 'lucide-react';
import type { CapabilityResourceDescriptor } from '@/app/lib/capabilities/resources/contracts';
import type { CapabilityPackagePresentation } from '@/app/lib/capabilities/packages/presentation-contracts';
import type { CapabilityPackageStoreListResponse, CapabilityPackageStoreSelection } from '@/app/lib/capabilities/packages/store-contracts';
import { isPluginNavigationResourceRef, PLUGIN_DETAIL_TASKS, type PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ResourceManagementSection } from './ResourceManagementSection';
import { PackageEditorSection } from './PackageEditorSection';
import { PackageRequirementsSetup } from './PackageRequirementsSetup';
import { PackageDetailPresentation } from './PackageDetailPresentation';
import { PackageDetailVersions } from './PackageDetailVersions';
import { PackageWorkspaceRequestError, workspaceRequest } from './plugin-workspace-client';
import { confirmPluginNavigation } from './plugin-navigation-guard';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';

export type PackageDetailWorkspaceProps = {
  resourceRef: string;
  workspaceId: string | null;
  task: typeof PLUGIN_DETAIL_TASKS[number];
  file?: string;
  store?: CapabilityPackageStoreListResponse | null;
  /** The shell owns the existing navigation guard, including Back and task changes. */
  onNavigate: (patch: Partial<PluginNavigation>) => void;
  onUpdated: () => void;
  onClose: () => void;
  onStoreUpdate: (source: CapabilityPackageStoreSelection, resourceRef: string) => void;
};

/** One exact reference and workspace own all lazy state; a selection change cannot render old rows. */
export function PackageDetailWorkspace(props: PackageDetailWorkspaceProps) {
  return <PackageDetailSession key={JSON.stringify([props.resourceRef, props.workspaceId])} {...props} />;
}

function exactStoreUpdate(resource: CapabilityResourceDescriptor, presentation: CapabilityPackagePresentation | null,
  store: CapabilityPackageStoreListResponse | null | undefined): CapabilityPackageStoreSelection | null {
  if (!presentation || presentation.readOnly || !resource.access.canManage || !resource.access.canEdit || !store) return null;
  const ref = resource.metadata.resourceRef;
  const variants = [...store.installed.resources, ...store.stores.filter(group => group.kind === resource.artifact.resourceType).flatMap(group => group.installedResources)];
  const installed = variants.find(value => value.metadata.resourceRef === ref && value.storeState?.origin === 'verified' && value.storeState.upstream === 'update-available'
    && value.metadata.metadataRevision === resource.metadata.metadataRevision && value.metadata.grantsRevision === resource.metadata.grantsRevision
    && value.artifact.version === resource.artifact.version && value.artifact.revision === resource.artifact.revision
    && value.artifact.resourceId === resource.artifact.resourceId);
  if (!installed) return null;
  const sources = store.stores.flatMap(group => group.availability !== 'available' || group.kind !== resource.artifact.resourceType ? []
    : group.offerings.filter(offer => offer.installedResourceRefs.includes(ref)).flatMap(offer => {
      const version = offer.versions.find(value => value.version === offer.latestVersion);
      return version ? [{ kind: group.kind, registryId: offer.registryId, entryKey: offer.entryKey, version: version.version, checksum: version.checksum }] : [];
    }));
  return sources.length === 1 ? sources[0] : null;
}

function PackageDetailSession({ resourceRef, workspaceId, task, file, store, onNavigate, onUpdated, onClose, onStoreUpdate }: PackageDetailWorkspaceProps) {
  const t = useTranslations('skills.workspace.detail'), locale = useLocale();
  const [resource, setResource] = useState<CapabilityResourceDescriptor | null>(null);
  const [presentation, setPresentation] = useState<CapabilityPackagePresentation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'accessError' | 'loadError' | null>(null);
  const [presentationError, setPresentationError] = useState(false);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), alive = useRef(true);
  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController(), current = ++generation.current;
    controller.current = request;
    setLoading(true); setResource(null); setPresentation(null); setError(null); setPresentationError(false);
    try {
      const selected = encodeURIComponent(resourceRef);
      const [metadata, content] = await Promise.allSettled([
        workspaceRequest<{ resource: CapabilityResourceDescriptor }>(`/api/capabilities/resources/${selected}`, workspaceId, { signal: request.signal }),
        workspaceRequest<{ presentation: CapabilityPackagePresentation }>(`/api/capabilities/packages/${selected}/presentation`, workspaceId, { signal: request.signal }),
      ]);
      if (!alive.current || request.signal.aborted || current !== generation.current) return;
      if (metadata.status === 'rejected') throw metadata.reason;
      const value = metadata.value.resource;
      if (!value?.access.canRead || value.metadata.status !== 'active' || !['plugin', 'skill'].includes(value.artifact.resourceType)
        || ![value.metadata.resourceRef, value.metadata.legacyResourceId].includes(resourceRef)) throw new PackageWorkspaceRequestError(403, 'PACKAGE_ACCESS_DENIED');
      if (content.status === 'rejected' && content.reason instanceof PackageWorkspaceRequestError && [401, 403, 404].includes(content.reason.status)) throw content.reason;
      if (content.status === 'fulfilled') {
        const next = content.value.presentation;
        if (!next || next.resourceRef !== value.metadata.resourceRef || next.name !== value.artifact.name || next.kind !== value.artifact.resourceType) {
          throw new PackageWorkspaceRequestError(403, 'PACKAGE_ACCESS_DENIED');
        }
        setPresentation(next);
      } else setPresentationError(true);
      setResource(value);
    } catch (failure) {
      if (alive.current && !request.signal.aborted && current === generation.current) {
        setResource(null); setPresentation(null);
        setError(failure instanceof PackageWorkspaceRequestError && [401, 403, 404].includes(failure.status) ? 'accessError' : 'loadError');
      }
    } finally { if (alive.current && !request.signal.aborted && current === generation.current) setLoading(false); }
  }, [resourceRef, workspaceId]);
  useEffect(() => {
    alive.current = true;
    startTransition(() => void load());
    return () => { alive.current = false; controller.current?.abort(); generation.current += 1; };
  }, [load]);
  const refresh = () => { if (alive.current) { void load(); onUpdated(); } };
  const navigateTask = (next: string) => onNavigate({ task: next as PackageDetailWorkspaceProps['task'], file: next === 'content' ? file : undefined });
  const advanced = () => onNavigate({ area: 'plugins', view: 'advanced', resourceRef: undefined, task: undefined, file: undefined, plugin: undefined, skill: undefined, source: undefined, resourceId: undefined });
  const source = useMemo(() => resource ? exactStoreUpdate(resource, presentation, store) : null, [resource, presentation, store]);
  const title = resource?.metadata.displayName || presentation?.title || resource?.artifact.name || t('title');
  const description = resource?.metadata.description ?? presentation?.description ?? resource?.description ?? '';
  const displayVersion = presentation?.version || resource?.artifact.version || '';
  const ownership = resource?.metadata.ownership;
  const scope = ownership ? t(`scopes.${ownership.type}`) : '';
  const ownerLabel = resource?.ownershipLabel || (ownership?.type === 'user' ? resource?.people?.owner?.name : '') || scope;
  const parentRef = resource?.metadata.sourcePluginId && isPluginNavigationResourceRef(resource.metadata.sourcePluginId) ? resource.metadata.sourcePluginId : null;
  const readOnly = presentation?.readOnly ?? (resource?.artifact.sourceType === 'core' || resource?.artifact.sourceType === 'plugin');
  const formatDate = (value: number | null) => value && Number.isFinite(value)
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value) : t('unknown');
  const nextTask = resource?.activation?.effectivePolicy === 'blocked' ? 'sharing'
    : presentation && (presentation.capabilities.length || presentation.requirements.length) ? 'connections'
      : resource?.access.canEdit && !readOnly ? 'content' : 'versions';
  return <section className="min-w-0 space-y-6" data-testid="package-detail-workspace">
    <header className="space-y-5 border-b pb-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onClose} data-testid="package-detail-back"><ArrowLeft className="size-4" />{t('back')}</Button>
        <Button variant="outline" size="sm" onClick={() => { if (confirmPluginNavigation()) void load(); }} disabled={loading} data-testid="package-detail-reload"><RefreshCw className="size-4" />{t('reload')}</Button>
      </div>
      {resource ? <div className="flex min-w-0 items-start gap-4">
        <PluginExtensionAvatar name={title} identity={JSON.stringify([resource.metadata.resourceRef, workspaceId])} icon={presentation?.icon} size="lg" />
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{t(resource.artifact.resourceType)}</span><span aria-hidden="true">/</span><span className="break-words">{scope}{ownerLabel && ownerLabel !== scope ? ` · ${ownerLabel}` : ''}</span></div>
          <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight sm:text-3xl" data-testid="package-detail-title">{title}</h1>
          {description ? <p className="mt-2 max-w-3xl whitespace-pre-line break-words text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2"><Badge variant="outline">{displayVersion}</Badge>
            {resource.activation ? <Badge variant="secondary">{t(resource.activation.effectivePolicy === 'blocked' ? 'blocked' : resource.activation.enabled ? 'enabled' : 'disabled')}</Badge> : null}
            {readOnly ? <Badge variant="outline">{t('readOnly')}</Badge> : null}
          </div>
        </div>
      </div> : <h1 className="text-xl font-semibold">{t('title')}</h1>}
    </header>
    {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t('loading')}</p>
      : error ? <InlineNotice variant="destructive" size="compact">{t(error)}</InlineNotice>
        : resource ? <>
          {presentationError ? <InlineNotice variant="warning" size="compact">{t('presentationUnavailable')}</InlineNotice> : null}
          <Tabs value={task} onValueChange={navigateTask} className="min-w-0 gap-5">
            <div className="max-w-full overflow-x-auto pb-1"><TabsList className="h-auto min-w-max gap-1 rounded-none border-b bg-transparent p-0">
              {PLUGIN_DETAIL_TASKS.map(value => <TabsTrigger key={value} value={value} data-testid={`package-detail-tab-${value}`}
                className="min-h-11 shrink-0 rounded-none border-0 border-b-2 border-transparent px-3 py-2 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">{t(`tasks.${value}`)}</TabsTrigger>)}
            </TabsList></div>
            {task === 'overview' ? <TabsContent value="overview" className="space-y-6" data-testid="package-detail-overview">
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,0.42fr)]">
                <section className="space-y-4"><h2 className="text-lg font-semibold">{t('overviewTitle')}</h2>
                  <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                    <div><dt className="text-xs text-muted-foreground">{t('responsible')}</dt><dd className="mt-1 break-words text-sm">{resource.people?.responsible?.name || t(resource.metadata.responsibleUserId ? 'unknownPerson' : 'notAssigned')}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t('version')}</dt><dd className="mt-1 break-words text-sm">{displayVersion}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t('createdBy')}</dt><dd className="mt-1 break-words text-sm">{resource.people?.createdBy?.name || t('unknownPerson')}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t('updatedBy')}</dt><dd className="mt-1 break-words text-sm">{resource.people?.updatedBy?.name || t('unknownPerson')}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t('updatedAt')}</dt><dd className="mt-1 text-sm">{formatDate(resource.metadata.updatedAt)}</dd></div>
                    {presentation?.license ? <div><dt className="text-xs text-muted-foreground">{t('license')}</dt><dd className="mt-1 break-words text-sm">{presentation.license}</dd></div> : null}
                  </dl>
                  {!resource.access.canUse ? <InlineNotice size="compact">{t('useNotGranted')}</InlineNotice> : null}
                  {readOnly ? <InlineNotice size="compact" actions={parentRef ? <Button variant="outline" size="sm" onClick={() => onNavigate({ resourceRef: parentRef, area: 'plugins', source: 'installed', skill: undefined, task: 'content', file: undefined })} data-testid="package-detail-parent">{t('openParent')}</Button> : undefined}>{t(resource.artifact.sourceType === 'plugin' ? 'childReadOnlyHint' : 'coreReadOnlyHint')}</InlineNotice> : null}
                </section>
                <aside className="space-y-3 rounded-xl border bg-muted/20 p-5">
                  <h2 className="text-sm font-semibold">{t('nextAction')}</h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t(`nextHints.${nextTask}`)}</p>
                  <Button variant="outline" className="h-auto min-h-11 w-full whitespace-normal text-left" onClick={() => navigateTask(nextTask)}><span className="flex-1">{t(`tasks.${nextTask}`)}</span><ArrowRight className="size-4 shrink-0" /></Button>
                  {source ? <Button className="h-auto min-h-11 w-full whitespace-normal" onClick={() => onStoreUpdate(source, resource.metadata.resourceRef)} data-testid="package-detail-store-update">{t('reviewUpdate', { version: source.version })}</Button> : null}
                </aside>
              </div>
              {presentation?.children.length ? <section className="space-y-3"><h2 className="text-lg font-semibold">{t('containedSkills', { count: presentation.children.length })}</h2>
                <div className="grid gap-3 sm:grid-cols-2">{presentation.children.map(child => <article key={child.name} className="flex min-w-0 items-start gap-3 rounded-xl border p-4">
                  <PluginExtensionAvatar name={child.title} identity={JSON.stringify([resource.metadata.resourceRef, workspaceId, 'child', child.name])} icon={child.icon} size="sm" />
                  <div className="min-w-0"><h3 className="break-words text-sm font-semibold">{child.title}</h3><p className="mt-1 break-words text-sm leading-relaxed text-muted-foreground">{child.description}</p></div></article>)}</div>
              </section> : null}
              {presentation?.scripts.length ? <details className="space-y-3"><summary className="cursor-pointer text-sm font-semibold">{t('declaredScripts')}</summary><p className="text-sm text-muted-foreground">{t('scriptsHint')}</p>
                <ul className="divide-y rounded-xl border">{presentation.scripts.map(script => <li key={`${script.skillName}:${script.id}`} className="min-w-0 p-4"><p className="break-words text-sm font-medium">{script.title}</p>
                  {script.description ? <p className="mt-1 break-words text-sm text-muted-foreground">{script.description}</p> : null}
                  <p className="mt-2 text-xs text-muted-foreground">{script.runtime.kind === 'node' ? 'Node.js' : 'Python'}{script.runtime.minimumVersion ? ` ≥ ${script.runtime.minimumVersion}` : ''}</p></li>)}</ul>
              </details> : null}
              {presentation && (presentation.compatibility.length || presentation.minCanvasVersion) ? <section className="space-y-2"><h2 className="text-lg font-semibold">{t('compatibility')}</h2>
                {presentation.minCanvasVersion ? <p className="text-sm text-muted-foreground">{t('minimumCanvasVersion', { version: presentation.minCanvasVersion })}</p> : null}
                {presentation.compatibility.map(value => <p key={value} className="break-words text-sm text-muted-foreground">{value}</p>)}
              </section> : null}
            </TabsContent> : null}
            {task === 'connections' ? <TabsContent value="connections" className="space-y-6" data-testid="package-detail-connections">
              <InlineNotice size="compact">{t('accountRightsHint')}</InlineNotice>
              {presentation ? <PackageRequirementsSetup presentation={presentation} workspaceId={workspaceId}
                returnPath={typeof window !== 'undefined' ? window.location.pathname + window.location.search : `/${locale}/plugins?view=browse&resourceRef=${encodeURIComponent(resource.metadata.resourceRef)}&task=connections`}
                onUpdated={onUpdated} /> : null}
              {presentation ? <details><summary className="cursor-pointer text-sm font-medium">{t('advancedTitle')}</summary><div className="mt-4"><PackageDetailPresentation presentation={presentation}
                identity={JSON.stringify([resource.metadata.resourceRef, workspaceId, resource.artifact.revision])} /></div></details> : null}
            </TabsContent> : null}
            {task === 'sharing' ? <TabsContent value="sharing"><ResourceManagementSection resourceRef={resource.metadata.resourceRef} workspaceId={workspaceId} onUpdated={refresh} /></TabsContent> : null}
            {task === 'content' ? <TabsContent value="content"><PackageEditorSection resourceRef={resource.metadata.resourceRef} workspaceId={workspaceId} initialFile={file} initiallyOpen onUpdated={refresh} /></TabsContent> : null}
            {task === 'versions' ? <TabsContent value="versions"><PackageDetailVersions resourceRef={resource.metadata.resourceRef} workspaceId={workspaceId} /></TabsContent> : null}
            {task === 'advanced' ? <TabsContent value="advanced" className="space-y-4" data-testid="package-detail-advanced"><h2 className="text-lg font-semibold">{t('advancedTitle')}</h2><p className="text-sm text-muted-foreground">{t('advancedHint')}</p>
              <dl className="space-y-4 rounded-xl border p-4">{[[t('resourceRef'),resource.metadata.resourceRef],[t('version'),resource.artifact.version],[t('checksum'),resource.artifact.checksum]].map(([label,value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-xs [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
              <Button variant="outline" className="h-auto min-h-11 whitespace-normal" onClick={advanced}>{t('personalConnections')}</Button>
            </TabsContent> : null}
          </Tabs>
        </> : null}
  </section>;
}
