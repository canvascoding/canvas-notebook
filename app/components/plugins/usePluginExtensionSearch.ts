'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import type { PluginExtensionItem, PluginExtensionSearchResponse } from '@/app/lib/plugins/plugin-extension-contracts';
import { authClient } from '@/app/lib/auth-client';
import { PackageWorkspaceRequestError, workspaceRequest, type PackageWorkspaceQuery } from './plugin-workspace-client';

/** A received metadata response and its actual request context, never runtime authority. */
export type PluginExtensionSelectionMetadata = {
  response: PluginExtensionSearchResponse; actorId: string; sessionId: string; workspaceId: string;
} & ({source: 'selected'} | {source: 'row'; selectionId: string; row: PluginExtensionItem});
export type PluginExtensionSearchData = {
  key: string;
  status: 'loading' | 'ready' | 'error';
  updating: boolean;
  error: { code: string } | null;
  response: PluginExtensionSearchResponse | null;
  items: PluginExtensionItem[];
  selectedItem: PluginExtensionItem | null;
  selectionMetadata?: PluginExtensionSelectionMetadata | null;
  retry: () => void;
};
type Loaded = Omit<PluginExtensionSearchData, 'updating' | 'retry'> & {
  requestKey: string; contextKey: string; chainKey: string; requestedSelection: string | undefined; receivedResponse: PluginExtensionSearchResponse | null;
  rowResponses: ReadonlyMap<string, {row: PluginExtensionItem; response: PluginExtensionSearchResponse}>;
};

/** One query covers all four kinds; neither detail navigation nor paging changes its context. */
export function usePluginExtensionSearch({ navigation, workspaceId, epoch }: { navigation: PluginNavigation; workspaceId: string | null; epoch: number }): PluginExtensionSearchData {
  const { data: session, isPending, error: sessionError } = authClient.useSession();
  const actorId = !isPending && !sessionError ? session?.user.id ?? null : null;
  const sessionId = !isPending && !sessionError ? session?.session.id ?? null : null;
  const kind = navigation.kind ?? 'all', q = navigation.q ?? '', scope = navigation.scope;
  const audience = scope === 'user' ? navigation.audience : undefined, teamId = scope === 'team' ? navigation.teamId : undefined;
  const stock = navigation.stock ?? 'all', source = navigation.extensionSource ?? 'all', cursor = navigation.extensionCursor;
  const selected = navigation.extensionId;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = JSON.stringify([actorId, sessionId, workspaceId, q, kind, scope, audience ?? null, teamId ?? null, stock, source, epoch]);
  const chainKey = JSON.stringify([key, attempt]);
  const contextKey = JSON.stringify([key, cursor ?? null, attempt]);
  const currentResponse = loaded?.contextKey === contextKey && loaded.status === 'ready' && !loaded.error ? loaded.receivedResponse : null;
  const receivedRow = selected && currentResponse ? loaded?.rowResponses.get(selected) : undefined;
  // Opening a row is presentation of a response already received in this exact
  // query/cursor context. It must not start another traversal of every source.
  // Unknown links, pagination, refresh and context changes still request fresh metadata.
  const requestedSelection = currentResponse && (!selected || selected === loaded?.requestedSelection || receivedRow)
    ? loaded?.requestedSelection : selected;
  const requestKey = JSON.stringify([contextKey, requestedSelection ?? null]);
  const query: PackageWorkspaceQuery = useMemo(() => ({ q, types: kind === 'all' ? undefined : kind, scope, audience, teamId,
    stock, source, cursor, selected: requestedSelection, limit: 20 }), [q, kind, scope, audience, teamId, stock, source, cursor, requestedSelection]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current;
    if (!workspaceId || !actorId || !sessionId) return () => { generation.current += 1; controller.abort(); };
    const isCurrent = () => {
      const currentSession = authClient.$store.atoms.session.get();
      return !controller.signal.aborted && generation.current === current && !currentSession.isPending && !currentSession.error
        && currentSession.data?.user.id === actorId && currentSession.data?.session.id === sessionId;
    };
    void workspaceRequest<PluginExtensionSearchResponse>('/api/plugins/search', workspaceId, { signal: controller.signal }, query).then(response => {
      if (!isCurrent()) return;
      if (response.schemaVersion !== 1 || !Array.isArray(response.items) || !Array.isArray(response.coverage) || !response.pagination
        || !response.scopes || !Array.isArray(response.scopes.choices) || !Array.isArray(response.scopes.teams)) throw new PackageWorkspaceRequestError(502, 'PLUGIN_SEARCH_RESPONSE_INVALID');
      startTransition(() => setLoaded(previous => {
        if (!isCurrent()) return previous;
        const priorResponse = previous?.key === key && cursor ? previous.response : null;
        const prior = priorResponse ? previous!.items : [];
        const items = [...new Map([...prior, ...response.items].map(item => [item.id, item])).values()];
        // Every visible row retains the actual response that supplied it. Only
        // an uninterrupted successful append chain may retain older provenance.
        const rowResponses = new Map(previous?.chainKey === chainKey && priorResponse && !previous.error ? previous.rowResponses : []);
        for (const row of response.items) rowResponses.set(row.id, {row, response});
        const coverage = [...new Map([...(priorResponse?.coverage ?? []), ...response.coverage].map(source => [source.source, source])).values()];
        // A continuation response can describe only its current upstream batch. Never
        // promote its batch total to a total for all the previously appended sources.
        const totalItems = priorResponse ? priorResponse.pagination.totalItems !== undefined
          && priorResponse.pagination.totalItems === response.pagination.totalItems ? response.pagination.totalItems : undefined : response.pagination.totalItems;
        const pagination = { ...response.pagination, loadedItems: items.length, totalItems };
        return { key, requestKey, contextKey, chainKey, requestedSelection, receivedResponse: response, rowResponses,
          status: 'ready', error: null, response: { ...response, coverage, pagination }, items, selectedItem: response.selectedItem,
          selectionMetadata: response.selectedItem ? { source: 'selected', response, actorId, sessionId, workspaceId } : null };
      }));
    }).catch(error => {
      if (!isCurrent()) return;
      const failure = error instanceof PackageWorkspaceRequestError ? error : new PackageWorkspaceRequestError(0, 'PLUGIN_SEARCH_UNAVAILABLE');
      startTransition(() => setLoaded(previous => {
        if (!isCurrent()) return previous;
        return previous?.key === key && cursor && previous.response && ![401, 403, 404].includes(failure.status)
          ? { ...previous, requestKey, contextKey, chainKey, requestedSelection, receivedResponse: null, rowResponses: new Map(),
            error: { code: failure.code }, selectedItem: null, selectionMetadata: null }
          : { key, requestKey, contextKey, chainKey, requestedSelection, receivedResponse: null, rowResponses: new Map(),
            status: 'error', error: { code: failure.code }, response: null, items: [], selectedItem: null };
      }));
    });
    return () => { generation.current += 1; controller.abort(); };
  }, [key, requestKey, contextKey, chainKey, query, workspaceId, cursor, requestedSelection, actorId, sessionId]);
  if (loaded?.key !== key) return { key, status: 'loading', updating: false, error: null, response: null, items: [], selectedItem: null, retry };
  const selectedRow = loaded.requestKey === requestKey && !loaded.error && receivedRow?.row.access.canRead ? receivedRow : null;
  const selectedItem = selectedRow?.row ?? (selected && loaded.requestKey === requestKey && loaded.selectedItem?.id === selected ? loaded.selectedItem : null);
  const selectionMetadata: PluginExtensionSelectionMetadata | null = selectedRow && currentResponse && actorId && sessionId && workspaceId
    ? {source: 'row', response: selectedRow.response, row: selectedRow.row, selectionId: selected!, actorId, sessionId, workspaceId}
    : selectedItem ? loaded.selectionMetadata ?? null : null;
  return { ...loaded, retry, updating: loaded.requestKey !== requestKey, selectedItem, selectionMetadata };
}
