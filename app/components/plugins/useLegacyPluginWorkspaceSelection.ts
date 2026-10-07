'use client';

import { useEffect, useRef, useState } from 'react';
import { isPluginNavigationResourceRef, type PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import type { PluginWorkspaceCatalogResponse } from '@/app/lib/plugins/plugin-workspace-catalog-contracts';
import { workspaceRequest } from './plugin-workspace-client';

type LegacySelection = { key: string; status: 'loading' | 'resolved' | 'choose' | 'unavailable'; resourceRef: string | null };

/** Legacy names are resolved only to a unique currently readable exact instance in the selected scope. */
export function useLegacyPluginWorkspaceSelection(navigation: PluginNavigation, workspaceId: string): LegacySelection | null {
  const name = navigation.area === 'skills' ? navigation.skill : navigation.plugin;
  const kind = navigation.area === 'skills' ? 'skill' : 'plugin';
  const required = !navigation.resourceRef && navigation.source === 'installed' && Boolean(name);
  const key = JSON.stringify([workspaceId, navigation.scope, navigation.teamId, navigation.audience, kind, name, navigation.resourceId]);
  const [loaded, setLoaded] = useState<LegacySelection | null>(null), generation = useRef(0);
  const { scope, teamId, audience, resourceId } = navigation;
  useEffect(() => {
    if (!required || !name) return;
    const controller = new AbortController(), current = ++generation.current;
    const run = async () => {
      try {
        const catalog = await workspaceRequest<PluginWorkspaceCatalogResponse>('/api/plugins/catalog', workspaceId, { signal: controller.signal }, {
          scope, kind, q: name, audience: scope === 'user' ? audience ?? 'own' : undefined,
          teamId: scope === 'team' ? teamId : undefined, page: 1, limit: 50,
        });
        const matches = catalog.items.filter(item => item.kind === kind && item.name === name
          && (!resourceId || item.legacyResourceId === resourceId || item.resourceRef === resourceId));
        const reference = matches.length === 1 && !catalog.pagination.hasNextPage && isPluginNavigationResourceRef(matches[0].resourceRef) ? matches[0].resourceRef : null;
        if (!controller.signal.aborted && generation.current === current) setLoaded({ key,
          status: reference ? 'resolved' : matches.length || catalog.pagination.hasNextPage ? 'choose' : 'unavailable',
          resourceRef: reference });
      } catch {
        if (!controller.signal.aborted && generation.current === current) setLoaded({ key, status: 'unavailable', resourceRef: null });
      }
    };
    void run();
    return () => { generation.current += 1; controller.abort(); };
  }, [key, required, name, kind, workspaceId, scope, teamId, audience, resourceId]);
  return required ? loaded?.key === key ? loaded : { key, status: 'loading', resourceRef: null } : null;
}
