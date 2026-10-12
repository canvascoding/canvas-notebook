'use client';

import { BookOpen, ChevronLeft, ChevronRight, LockKeyhole, Puzzle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { PluginWorkspaceCatalogItem, PluginWorkspaceCatalogResponse } from '@/app/lib/plugins/plugin-workspace-catalog-contracts';
import type { CapabilityPackageStoreListResponse, CapabilityPackageStoreSelection } from '@/app/lib/capabilities/packages/store-contracts';
import type { SafeActorSkillStoreResource } from '@/app/lib/skills/actor-skill-store-state';

export type PluginWorkspaceListsProps = {
  catalog: PluginWorkspaceCatalogResponse; store: CapabilityPackageStoreListResponse | null;
  view: 'installed' | 'store' | 'updates'; onOpenResource: (item: PluginWorkspaceCatalogItem) => void;
  onOpenOffering: (source: CapabilityPackageStoreSelection) => void; onPage: (page: number) => void;
};

/** Exact update rows can fall outside the catalog's separately paginated current page. */
export function pluginWorkspaceUpdateItem(resource: SafeActorSkillStoreResource, catalog: PluginWorkspaceCatalogResponse): PluginWorkspaceCatalogItem {
  const found = catalog.items.find(item => item.resourceRef === resource.metadata.resourceRef);
  const people: PluginWorkspaceCatalogItem['people'] = {};
  for (const role of ['owner', 'createdBy', 'updatedBy', 'responsible'] as const) {
    const person = resource.people?.[role];
    if (person) people[role] = { name: person.name };
  }
  return { resourceRef: resource.metadata.resourceRef, legacyResourceId: resource.artifact.resourceId,
    kind: resource.artifact.resourceType, name: resource.artifact.name,
    displayName: resource.metadata.displayName || found?.displayName || resource.artifact.name,
    description: resource.metadata.description ?? found?.description ?? '', version: resource.artifact.version, revision: resource.artifact.revision,
    ownership: resource.metadata.ownership, ownershipLabel: resource.ownershipLabel,
    access: resource.access, activation: resource.activation, ...(Object.keys(people).length ? { people } : {}),
    ...(found?.parentResourceRef ? { parentResourceRef: found.parentResourceRef } : {}) };
}

function PackageMark({ kind }: { kind: 'plugin' | 'skill' }) {
  const Icon = kind === 'plugin' ? Puzzle : BookOpen;
  return <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon className="size-4" aria-hidden="true" /></span>;
}
function StatusLabel({ children }: { children: ReactNode }) {
  return <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{children}</span>;
}

/** Readable management rows never imply runtime activation, readiness or connection-use rights. */
export function PluginWorkspaceLists({ catalog, store, view, onOpenResource, onOpenOffering, onPage }: PluginWorkspaceListsProps) {
  const t = useTranslations('skills.workspace');
  const updates = view === 'updates';
  const items = updates ? (store?.installed.resources ?? []).map(resource => pluginWorkspaceUpdateItem(resource, catalog)) : catalog.items;
  const pagination = updates ? store?.installed.pagination : catalog.pagination;
  const summary = store?.installed.summary;
  const unavailable = store?.stores.some(source => source.availability === 'unavailable') === true;
  const resourceRows = (rows: readonly PluginWorkspaceCatalogItem[]) => <ul className="divide-y rounded-lg border bg-background" data-testid="plugin-workspace-resources">
    {rows.map(item => {
      const builtIn = item.ownership.type === 'system';
      const blocked = item.activation?.effectivePolicy === 'blocked' || ['blocked', 'conflict'].includes(item.activation?.readiness ?? '');
      const scope = item.ownershipLabel || t(`lists.${item.ownership.type === 'user' ? 'personal' : item.ownership.type === 'organization' ? 'organization' : item.ownership.type === 'system' ? 'builtIn' : 'team'}`);
      return <li key={item.resourceRef} data-testid="plugin-workspace-resource" data-resource-ref={item.resourceRef}>
        <button type="button" onClick={() => onOpenResource(item)} aria-label={t('lists.openResource', { name: item.displayName })}
          className="group flex w-full min-w-0 items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:gap-4 sm:p-5">
          <PackageMark kind={item.kind} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><span className="min-w-0 max-w-full break-words font-medium">{item.displayName}</span><span className="max-w-full break-words text-xs text-muted-foreground">{t('lists.version', { version: item.version })}</span></div>
            {item.description && <p className="line-clamp-2 break-words text-sm text-muted-foreground">{item.description}</p>}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{t(`lists.${item.kind}`)}</span><span aria-hidden="true">·</span><span className="min-w-0 max-w-full break-words">{scope}</span>
              {item.people?.responsible?.name && <><span aria-hidden="true">·</span><span className="min-w-0 max-w-full break-words">{t('lists.responsible', { name: item.people.responsible.name })}</span></>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {builtIn ? <StatusLabel>{t('lists.readOnly')}</StatusLabel> : item.parentResourceRef ? <StatusLabel>{t('lists.contained')}</StatusLabel> : null}
              {blocked ? <StatusLabel>{t('lists.blocked')}</StatusLabel> : item.activation?.effectivePolicy === 'required' ? <StatusLabel>{t('lists.required')}</StatusLabel>
                : item.activation?.readiness === 'personal-connection-required' ? <StatusLabel>{t('lists.setup')}</StatusLabel>
                  : item.activation ? <StatusLabel>{t(item.activation.enabled ? 'lists.enabled' : 'lists.disabled')}</StatusLabel> : null}
              {!builtIn && item.access.canEdit && <StatusLabel>{t('lists.canEdit')}</StatusLabel>}
              {!builtIn && item.access.canManage && <StatusLabel>{t('lists.canManage')}</StatusLabel>}
              {!item.access.canUse && !builtIn && <StatusLabel>{t('lists.noUse')}</StatusLabel>}
            </div>
            {blocked && item.activation?.blockedReason && <p className="line-clamp-2 break-words text-xs text-muted-foreground">{item.activation.blockedReason}</p>}
          </div>
          <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </li>;
    })}
  </ul>;
  const pageControl = (page: number, totalPages: number, previous: boolean, next: boolean) => totalPages > 1 ? <nav aria-label={t('lists.pagination')} className="flex flex-wrap items-center justify-between gap-3 pt-2" data-testid="plugin-workspace-pagination">
    <span className="text-sm text-muted-foreground">{t('lists.page', { page, total: totalPages })}</span>
    <div className="flex gap-2"><Button variant="outline" size="sm" disabled={!previous} onClick={() => onPage(page - 1)}><ChevronLeft className="size-4" aria-hidden="true" />{t('lists.previous')}</Button>
      <Button variant="outline" size="sm" disabled={!next} onClick={() => onPage(page + 1)}>{t('lists.next')}<ChevronRight className="size-4" aria-hidden="true" /></Button></div>
  </nav> : null;
  const offeringStores = store?.stores ?? [];
  return <section className="min-w-0 space-y-4" data-testid="plugin-workspace-lists">
    {catalog.selection.selectionRequired === 'team' ? <InlineNotice size="compact">{t('lists.selectionRequired')}</InlineNotice> : <>
      {view !== 'installed' && unavailable && <InlineNotice size="compact" variant="warning">{t('lists.sourceUnavailable')}</InlineNotice>}
      {view !== 'installed' && summary && summary.comparison !== 'known' && summary.total > 0 && <InlineNotice size="compact" data-testid="plugin-workspace-comparison">
        {t('lists.partial', { observed: summary.observed, total: summary.total, unknown: summary.unknown })}
      </InlineNotice>}
      {updates && summary && <p className="text-sm text-muted-foreground" data-testid="plugin-workspace-update-summary">{t('lists.summary', summary)}</p>}
      {view === 'store' ? <>
        {offeringStores.every(source => source.offerings.length === 0) && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{t('lists.storeEmpty')}</p>}
        {offeringStores.filter(source => source.offerings.length > 0).map(source => <div key={source.kind} className="space-y-3" data-testid="plugin-workspace-store-kind">
          {offeringStores.length > 1 && <h2 className="text-sm font-medium">{t(`lists.${source.kind === 'plugin' ? 'plugins' : 'skills'}`)}</h2>}
          <ul className="divide-y rounded-lg border bg-background">
            {source.offerings.map(offering => {
              const version = offering.versions.find(value => value.version === offering.latestVersion && /^[a-f0-9]{64}$/u.test(value.checksum));
              return <li key={JSON.stringify([source.kind, offering.registryId, offering.entryKey])} data-testid="plugin-workspace-offering">
                <button type="button" disabled={!version} aria-label={t('lists.openOffering', { name: offering.displayName })}
                  onClick={() => version && onOpenOffering({ kind: source.kind, registryId: offering.registryId, entryKey: offering.entryKey, version: version.version, checksum: version.checksum })}
                  className="group flex w-full min-w-0 items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-60 sm:gap-4 sm:p-5">
                  <PackageMark kind={source.kind} /><div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="min-w-0 max-w-full break-words font-medium">{offering.displayName}</span><span className="max-w-full break-words text-xs text-muted-foreground">{t('lists.version', { version: offering.latestVersion })}</span></div>
                    {offering.description && <p className="line-clamp-2 break-words text-sm text-muted-foreground">{offering.description}</p>}
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t(`lists.${source.kind}`)}</span>{offering.publisher?.name && <span className="min-w-0 max-w-full break-words">{t('lists.publisher', { name: offering.publisher.name })}</span>}
                      {offering.installedResourceRefs.length > 0 && <span>{t('lists.installedConfirmed', { count: offering.installedResourceRefs.length })}{offering.installedRefsTruncated ? '+' : ''}</span>}
                    </div>
                  </div>{version ? <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <LockKeyhole className="mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                </button>
              </li>;
            })}
          </ul>
        </div>)}
        {(() => {
          const pagination = offeringStores.reduce<CapabilityPackageStoreListResponse['stores'][number]['pagination'] | null>((largest, source) =>
            !largest || source.pagination.totalPages > largest.totalPages ? source.pagination : largest, null);
          return pagination ? pageControl(pagination.page, pagination.totalPages, pagination.hasPreviousPage, pagination.hasNextPage) : null;
        })()}
      </> : <>
        {items.length > 0 ? resourceRows(items) : <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{t(updates
          ? summary?.comparison === 'known' ? 'lists.updatesEmptyKnown' : 'lists.updatesEmptyUnknown' : 'lists.installedEmpty')}</p>}
        {pagination && pageControl(pagination.page, pagination.totalPages, pagination.hasPreviousPage, pagination.hasNextPage)}
      </>}
    </>}
  </section>;
}
