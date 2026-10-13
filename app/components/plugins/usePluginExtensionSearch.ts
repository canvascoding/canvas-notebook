'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import type { PluginExtensionItem, PluginExtensionSearchResponse } from '@/app/lib/plugins/plugin-extension-contracts';
import { PackageWorkspaceRequestError, workspaceRequest, type PackageWorkspaceQuery } from './plugin-workspace-client';

export type PluginExtensionSearchData = {
  key: string;
  status: 'loading' | 'ready' | 'error';
  updating: boolean;
  error: { code: string } | null;
  response: PluginExtensionSearchResponse | null;
  items: PluginExtensionItem[];
  selectedItem: PluginExtensionItem | null;
  retry: () => void;
};
type Loaded = Omit<PluginExtensionSearchData, 'updating' | 'retry'> & { requestKey: string };

/** One query covers all four kinds; neither detail navigation nor paging changes its context. */
export function usePluginExtensionSearch({ navigation, workspaceId, epoch }: { navigation: PluginNavigation; workspaceId: string | null; epoch: number }): PluginExtensionSearchData {
  const kind = navigation.kind ?? 'all', q = navigation.q ?? '', scope = navigation.scope;
  const audience = scope === 'user' ? navigation.audience : undefined, teamId = scope === 'team' ? navigation.teamId : undefined;
  const stock = navigation.stock ?? 'all', source = navigation.extensionSource ?? 'all', cursor = navigation.extensionCursor;
  const selected = navigation.extensionId;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([workspaceId, q, kind, scope, audience ?? null, teamId ?? null, stock, source, epoch]);
  const requestKey = JSON.stringify([key, cursor ?? null, selected ?? null, attempt]);
  const query: PackageWorkspaceQuery = useMemo(() => ({ q, types: kind === 'all' ? undefined : kind, scope, audience, teamId,
    stock, source, cursor, selected, limit: 20 }), [q, kind, scope, audience, teamId, stock, source, cursor, selected]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current;
    if (!workspaceId) return () => { generation.current += 1; controller.abort(); };
    void workspaceRequest<PluginExtensionSearchResponse>('/api/plugins/search', workspaceId, { signal: controller.signal }, query).then(response => {
      if (controller.signal.aborted || generation.current !== current) return;
      if (response.schemaVersion !== 1 || !Array.isArray(response.items) || !Array.isArray(response.coverage) || !response.pagination
        || !response.scopes || !Array.isArray(response.scopes.choices) || !Array.isArray(response.scopes.teams)) throw new PackageWorkspaceRequestError(502, 'PLUGIN_SEARCH_RESPONSE_INVALID');
      startTransition(() => setLoaded(previous => {
        const priorResponse = previous?.key === key && cursor ? previous.response : null;
        const prior = priorResponse ? previous!.items : [];
        const items = [...new Map([...prior, ...response.items].map(item => [item.id, item])).values()];
        const coverage = [...new Map([...(priorResponse?.coverage ?? []), ...response.coverage].map(source => [source.source, source])).values()];
        // A continuation response can describe only its current upstream batch. Never
        // promote its batch total to a total for all the previously appended sources.
        const totalItems = priorResponse ? priorResponse.pagination.totalItems !== undefined
          && priorResponse.pagination.totalItems === response.pagination.totalItems ? response.pagination.totalItems : undefined : response.pagination.totalItems;
        const pagination = { ...response.pagination, loadedItems: items.length, totalItems };
        return { key, requestKey, status: 'ready', error: null, response: { ...response, coverage, pagination }, items, selectedItem: response.selectedItem };
      }));
    }).catch(error => {
      if (controller.signal.aborted || generation.current !== current) return;
      const failure = error instanceof PackageWorkspaceRequestError ? error : new PackageWorkspaceRequestError(0, 'PLUGIN_SEARCH_UNAVAILABLE');
      startTransition(() => setLoaded(previous => previous?.key === key && cursor && previous.response && ![401, 403, 404].includes(failure.status)
        ? { ...previous, requestKey, error: { code: failure.code }, selectedItem: null }
        : { key, requestKey, status: 'error', error: { code: failure.code }, response: null, items: [], selectedItem: null }));
    });
    return () => { generation.current += 1; controller.abort(); };
  }, [key, requestKey, query, workspaceId, cursor, attempt]);
  if (loaded?.key !== key) return { key, status: 'loading', updating: false, error: null, response: null, items: [], selectedItem: null, retry };
  return { ...loaded, retry, updating: loaded.requestKey !== requestKey, selectedItem: loaded.requestKey === requestKey ? loaded.selectedItem : null };
}
