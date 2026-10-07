'use client';

import { startTransition, useEffect, useRef, useState } from 'react';
import type { PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import type { PluginWorkspaceCatalogResponse } from '@/app/lib/plugins/plugin-workspace-catalog-contracts';
import type { CapabilityPackageStoreListResponse } from '@/app/lib/capabilities/packages/store-contracts';
import { PackageWorkspaceRequestError, workspaceRequest, type PackageWorkspaceQuery } from './plugin-workspace-client';

export type PluginWorkspaceData = {
  key: string; status: 'loading' | 'ready' | 'error'; error: { code: string; message: string } | null;
  catalog: PluginWorkspaceCatalogResponse | null; store: CapabilityPackageStoreListResponse | null;
};
export type PluginWorkspaceDataProps = { navigation: PluginNavigation; workspaceId: string | null; epoch: number };

/** No render may reuse rows from a previous selected actor workspace, scope or view. */
export function usePluginWorkspaceData({ navigation, workspaceId, epoch }: PluginWorkspaceDataProps): PluginWorkspaceData {
  const kind = navigation.kind ?? (navigation.area === 'skills' ? 'skill' : 'all');
  const scope = navigation.scope, audience = scope === 'user' ? navigation.audience ?? 'own' : undefined;
  const teamId = scope === 'team' ? navigation.teamId : undefined, q = navigation.q ?? '', page = navigation.page ?? 1;
  const storeRequired = ['discover', 'library', 'updates'].includes(navigation.view) || Boolean(navigation.resourceRef);
  const detailName = navigation.resourceRef ? navigation.plugin ?? navigation.skill : undefined;
  const detailKind = navigation.resourceRef && detailName ? navigation.plugin ? 'plugin' : 'skill' : kind;
  const key = JSON.stringify([workspaceId, scope, teamId ?? null, audience ?? null, kind, navigation.view, q, page,
    navigation.resourceRef ?? null, detailName ?? null, detailKind, epoch]);
  const view = navigation.view, resourceRef = navigation.resourceRef;
  const [loaded, setLoaded] = useState<PluginWorkspaceData | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current;
    const selection: PackageWorkspaceQuery = { scope, audience, teamId, kind: kind === 'all' ? undefined : kind, q, page, limit: 20 };
    const run = async () => {
      try {
        const [catalogResult, storeResult] = await Promise.allSettled([
          workspaceRequest<PluginWorkspaceCatalogResponse>('/api/plugins/catalog', workspaceId, { signal: controller.signal }, selection),
          storeRequired ? workspaceRequest<CapabilityPackageStoreListResponse>('/api/capabilities/packages/store', workspaceId, { signal: controller.signal }, {
            scope, audience, teamId, kind: detailKind === 'all' ? undefined : detailKind, q: resourceRef ? detailName ?? '' : q,
            page: view === 'updates' || resourceRef ? 1 : page, limit: 20,
            installedPage: view === 'updates' ? page : 1, installedLimit: 20, installedState: view === 'updates' ? 'updates' : 'all',
          }) : Promise.resolve(null),
        ]);
        if (controller.signal.aborted || generation.current !== current) return;
        if (catalogResult.status === 'rejected') throw catalogResult.reason;
        const storeFailure = storeResult.status === 'rejected' ? storeResult.reason : null;
        const failure = storeFailure ? storeFailure instanceof PackageWorkspaceRequestError ? storeFailure : new PackageWorkspaceRequestError(0, 'PACKAGE_WORKSPACE_UNAVAILABLE') : null;
        startTransition(() => setLoaded({ key, status: 'ready', error: failure ? { code: failure.code, message: failure.message } : null,
          catalog: catalogResult.value, store: storeResult.status === 'fulfilled' ? storeResult.value : null }));
      } catch (error) {
        if (controller.signal.aborted || generation.current !== current) return;
        const failure = error instanceof PackageWorkspaceRequestError ? error : new PackageWorkspaceRequestError(0, 'PACKAGE_WORKSPACE_UNAVAILABLE');
        startTransition(() => setLoaded({ key, status: 'error', error: { code: failure.code, message: failure.message }, catalog: null, store: null }));
      }
    };
    void run();
    return () => { generation.current += 1; controller.abort(); };
  }, [key, scope, audience, teamId, kind, q, page, view, resourceRef, workspaceId, storeRequired, detailName, detailKind]);
  return loaded?.key === key ? loaded : { key, status: 'loading', error: null, catalog: null, store: null };
}
