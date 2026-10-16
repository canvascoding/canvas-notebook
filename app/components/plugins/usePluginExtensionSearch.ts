'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import type { PluginExtensionCoverage, PluginExtensionItem, PluginExtensionSearchResponse } from '@/app/lib/plugins/plugin-extension-contracts';
import { authClient } from '@/app/lib/auth-client';
import { PackageWorkspaceRequestError, workspaceRequest, type PackageWorkspaceQuery } from './plugin-workspace-client';
import { pluginExtensionSearchPhaseRequests, pluginExtensionSearchPhaseCursor, type ExtensionSearchPhase, type ExtensionSearchPhaseRequest } from './plugin-extension-search-phases';

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
  /** Existing full refresh remains available; a coverage retry refreshes only its actual local/remote request group. */
  retry: (source?: PluginExtensionCoverage['source']) => void;
  pendingSources?: PluginExtensionCoverage['source'][];
};
type Loaded = Omit<PluginExtensionSearchData, 'updating' | 'retry'> & {
  pending?: boolean;
  requestKey: string; contextKey: string; chainKey: string; requestedSelection: string | undefined; receivedResponse: PluginExtensionSearchResponse | null;
  rowResponses: ReadonlyMap<string, {row: PluginExtensionItem; response: PluginExtensionSearchResponse}>;
};

/** One query covers all four kinds; neither detail navigation nor paging changes its context. */
export function usePluginExtensionSearch({ navigation, workspaceId, epoch, purpose = 'browse' }: { navigation: PluginNavigation; workspaceId: string | null; epoch: number; purpose?: 'browse' | 'authoring' }): PluginExtensionSearchData {
  const { data: session, isPending, error: sessionError } = authClient.useSession();
  const actorId = !isPending && !sessionError ? session?.user.id ?? null : null;
  const sessionId = !isPending && !sessionError ? session?.session.id ?? null : null;
  const kind = navigation.kind ?? 'all', q = navigation.q ?? '', scope = navigation.scope;
  const audience = scope === 'user' ? navigation.audience : undefined, teamId = scope === 'team' ? navigation.teamId : undefined;
  const stock = navigation.stock ?? 'all', source = navigation.extensionSource ?? 'all', cursor = navigation.extensionCursor;
  const selected = navigation.extensionId;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = JSON.stringify([actorId, sessionId, workspaceId, q, kind, scope, audience ?? null, teamId ?? null, stock, source, epoch, purpose]);
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
  const phaseRetry = useRef<{ requestKey: string; run: (source: PluginExtensionCoverage['source']) => void } | null>(null);
  const retry = useCallback((source?: PluginExtensionCoverage['source']) => {
    if (source) {
      if (phaseRetry.current?.requestKey === requestKey) phaseRetry.current.run(source);
      return;
    }
    setAttempt(value => value + 1);
  }, [requestKey]);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current;
    if (!workspaceId || !actorId || !sessionId) return () => { generation.current += 1; controller.abort(); };
    const isCurrent = () => {
      const currentSession = authClient.$store.atoms.session.get();
      return !controller.signal.aborted && generation.current === current && !currentSession.isPending && !currentSession.error
        && currentSession.data?.user.id === actorId && currentSession.data?.session.id === sessionId;
    };
    const phases = pluginExtensionSearchPhaseRequests(cursor), responses = new Map<ExtensionSearchPhase, PluginExtensionSearchResponse>();
    const failures = new Map<ExtensionSearchPhase, PackageWorkspaceRequestError>();
    const pendingPhases = new Set(phases.map(phase => phase.phase));
    // Freeze only the earlier cursor pages. Current phase responses are replaced
    // on retry, so withdrawn rows and their provenance must not become the base.
    let appendBaseline: Loaded | null | undefined;
    let remaining = phases.length;
    const phaseForSource = (source: PluginExtensionCoverage['source']): ExtensionSearchPhaseRequest => {
      // Composio's local inventory and remote catalogue share one public source label.
      // Prefer the actual failed response, then fall back to the source's normal request group.
      const failed = (['remote', 'local', 'all'] as const).find(phase => responses.get(phase)?.coverage.some(row => row.source === source
        && (row.status === 'partial' || row.status === 'unavailable')));
      const preferred = failed ?? (source === 'packages' || source === 'mcp' ? 'local' : 'remote');
      return phases.find(phase => phase.phase === preferred) ?? phases.find(phase => phase.phase === 'all') ?? { phase: preferred };
    };
    const publish = (received: PluginExtensionSearchResponse | null) => {
      if (!isCurrent()) return;
      const ordered = (['local', 'remote', 'all'] as const).flatMap(phase => responses.has(phase) ? [responses.get(phase)!] : []);
      const latestResponse = received ?? ordered.at(-1);
      startTransition(() => setLoaded(previous => {
        if (!isCurrent()) return previous;
        if (appendBaseline === undefined) appendBaseline = previous?.key === key && cursor ? previous : null;
        const priorResponse = appendBaseline?.response ?? null;
        const prior = priorResponse ? appendBaseline!.items : [];
        if (!latestResponse) {
          if (remaining) return previous?.key === key ? { ...previous, pending: true,
            pendingSources: (previous.response?.coverage ?? []).filter(source => pendingPhases.has(phaseForSource(source.source).phase)).map(source => source.source) } : previous;
          const failure = [...failures.values()][0] ?? new PackageWorkspaceRequestError(0, 'PLUGIN_SEARCH_UNAVAILABLE');
          return priorResponse ? { ...previous!, requestKey, contextKey, chainKey, requestedSelection, pending: false,
            receivedResponse: null, rowResponses: new Map(), error: { code: failure.code }, selectedItem: null, selectionMetadata: null }
            : { key, requestKey, contextKey, chainKey, requestedSelection, pending: false, receivedResponse: null, rowResponses: new Map(),
              status: 'error', error: { code: failure.code }, response: null, items: [], selectedItem: null };
        }
        const items = [...new Map([...prior, ...ordered.flatMap(response => response.items)].map(item => [item.id, item])).values()];
        // Every visible row retains the actual response that supplied it. Only
        // an uninterrupted successful append chain may retain older provenance.
        const rowResponses = new Map(appendBaseline?.chainKey === chainKey && priorResponse && !appendBaseline.error ? appendBaseline.rowResponses : []);
        for (const response of ordered) for (const row of response.items) rowResponses.set(row.id, {row, response});
        const failedCoverage = [...failures].flatMap(([phase, failure]) => (phase === 'local' ? ['packages', 'mcp'] as const : ['store', 'composio'] as const)
          .map(source => ({ source, status: 'unavailable' as const, error: { code: failure.code, message: 'Some extension metadata could not be loaded.', retryable: true } })));
        const coverage = [...new Map([...(priorResponse?.coverage ?? []), ...ordered.flatMap(response => response.coverage), ...failedCoverage].map(source => [source.source, source])).values()];
        const pendingSources = coverage.filter(source => pendingPhases.has(phaseForSource(source.source).phase)).map(source => source.source);
        // A continuation response can describe only its current upstream batch. Never
        // promote its batch total to a total for all the previously appended sources.
        const totalItems = !cursor && !remaining && !failures.size && ordered.every(response => response.pagination.totalItems !== undefined && !response.pagination.nextCursor)
          ? items.length : undefined;
        const nextCursor = remaining ? null : pluginExtensionSearchPhaseCursor(responses);
        const pagination = { nextCursor, hasNextPage: Boolean(nextCursor), loadedItems: items.length, totalItems };
        const selectedResponse = ordered.findLast(response => response.selectedItem?.id === requestedSelection);
        const selectedItem = selectedResponse?.selectedItem ?? null;
        return { key, requestKey, contextKey, chainKey, requestedSelection, pending: remaining > 0, pendingSources, receivedResponse: latestResponse, rowResponses,
          status: 'ready', error: null, response: { ...latestResponse, coverage, pagination }, items, selectedItem,
          selectionMetadata: selectedItem && selectedResponse ? { source: 'selected', response: selectedResponse, actorId, sessionId, workspaceId } : null };
      }));
    };
    const loadPhase = (phase: ExtensionSearchPhaseRequest, sourceRetry = false) => {
      if (!isCurrent() || sourceRetry && pendingPhases.has(phase.phase)) return;
      pendingPhases.add(phase.phase); remaining = pendingPhases.size;
      if (sourceRetry) publish(null);
      void workspaceRequest<PluginExtensionSearchResponse>(purpose === 'authoring' ? '/api/plugins/authoring-search' : '/api/plugins/search', workspaceId,
      { signal: controller.signal }, { ...query, phase: phase.phase, cursor: phase.cursor }).then(response => {
        if (!isCurrent()) return;
        if (response.schemaVersion !== 1 || !Array.isArray(response.items) || !Array.isArray(response.coverage) || !response.pagination
          || !response.scopes || !Array.isArray(response.scopes.choices) || !Array.isArray(response.scopes.teams)) throw new PackageWorkspaceRequestError(502, 'PLUGIN_SEARCH_RESPONSE_INVALID');
        responses.set(phase.phase, response); failures.delete(phase.phase); pendingPhases.delete(phase.phase);
        remaining = pendingPhases.size; publish(response);
      }).catch(error => {
        if (!isCurrent()) return;
        const failure = error instanceof PackageWorkspaceRequestError ? error : new PackageWorkspaceRequestError(0, 'PLUGIN_SEARCH_UNAVAILABLE');
        if ([401, 403, 404].includes(failure.status)) {
          startTransition(() => setLoaded({ key, requestKey, contextKey, chainKey, requestedSelection, pending: false, receivedResponse: null, rowResponses: new Map(),
            status: 'error', error: { code: failure.code }, response: null, items: [], selectedItem: null }));
          controller.abort(); return;
        }
        failures.set(phase.phase, failure); pendingPhases.delete(phase.phase); remaining = pendingPhases.size; publish(null);
      });
    };
    phaseRetry.current = { requestKey, run: source => loadPhase(phaseForSource(source), true) };
    for (const phase of phases) loadPhase(phase);
    return () => { generation.current += 1; controller.abort(); if (phaseRetry.current?.requestKey === requestKey) phaseRetry.current = null; };
  }, [key, requestKey, contextKey, chainKey, query, workspaceId, cursor, requestedSelection, actorId, sessionId, purpose]);
  if (loaded?.key !== key) return { key, status: 'loading', updating: false, error: null, response: null, items: [], selectedItem: null, retry };
  const selectedRow = loaded.requestKey === requestKey && !loaded.error && receivedRow?.row.access.canRead ? receivedRow : null;
  const selectedItem = selectedRow?.row ?? (selected && loaded.requestKey === requestKey && loaded.selectedItem?.id === selected ? loaded.selectedItem : null);
  const selectionMetadata: PluginExtensionSelectionMetadata | null = selectedRow && currentResponse && actorId && sessionId && workspaceId
    ? {source: 'row', response: selectedRow.response, row: selectedRow.row, selectionId: selected!, actorId, sessionId, workspaceId}
    : selectedItem ? loaded.selectionMetadata ?? null : null;
  return { ...loaded, retry, updating: loaded.requestKey !== requestKey || loaded.pending === true, selectedItem, selectionMetadata };
}
