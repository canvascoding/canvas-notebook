'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { isCancelledError, QueryObserver } from '@tanstack/react-query';
import { authClient } from '@/app/lib/auth-client';
import { fetchChatAgents } from '@/app/lib/chat/agent-api';
import type { AgentProfile } from '@/app/lib/chat/types';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient, invalidateNotebookQueries } from '@/app/lib/queries/client';
import { workspaceQueryKeys } from '@/app/lib/queries/workspace-queries';

const EMPTY_AGENTS: AgentProfile[] = [];
type AgentListScope = { token: symbol; sequence: number };

/** Shared acknowledged list membership; metadata in this cache grants no runtime access. */
export function useChatAgentList(workspaceId: string | null): {
  availableAgents: AgentProfile[];
  scopeKey: string;
  refreshAgents: (fresh?: boolean) => Promise<void>;
  acceptCreatedAgent: (agent: AgentProfile) => boolean;
} {
  const { data: session } = authClient.useSession();
  const actorId = session?.user?.id ?? null, authScope = openedDocumentAuthScope();
  const scopeKey = JSON.stringify([actorId, workspaceId]);
  const source = useMemo(() => actorId && workspaceId && (!authScope || authScope.userId === actorId)
    ? { client: getNotebookQueryClient(), key: workspaceQueryKeys.agents(workspaceId), authScope } : null, [actorId, workspaceId, authScope]);
  const token = useMemo(() => Symbol(source ? `${scopeKey}:${JSON.stringify(source.key)}` : scopeKey), [scopeKey, source]);
  const active = useRef<AgentListScope | null>(null);
  useLayoutEffect(() => {
    const scope: AgentListScope = { token, sequence: 0 };
    active.current = scope;
    // Leaving a consumer does not cancel a read still needed by another surface.
    return () => { scope.sequence += 1; if (active.current === scope) active.current = null; };
  }, [token]);

  const subscribe = useCallback((listener: () => void) => {
    if (!source) return () => {};
    // Observe the existing cache entry without a second/nested query function.
    // An active consumer also prevents GC from silently dropping its selected agent.
    const observer = new QueryObserver<AgentProfile[]>(source.client, { queryKey: source.key, enabled: false, notifyOnChangeProps: ['data'] });
    return observer.subscribe(() => listener());
  }, [source]);
  const getSnapshot = useCallback(() => source && openedDocumentAuthScope() === source.authScope
    ? source.client.getQueryData<AgentProfile[]>(source.key) ?? EMPTY_AGENTS : EMPTY_AGENTS, [source]);
  const availableAgents = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_AGENTS);

  const refreshAgents = useCallback(async (fresh = true) => {
    const scope = active.current;
    if (!scope || scope.token !== token || !source || !workspaceId || openedDocumentAuthScope() !== source.authScope) return;
    const sequence = ++scope.sequence;
    const isCurrent = () => active.current === scope && scope.sequence === sequence && openedDocumentAuthScope() === source.authScope;
    try {
      if (fresh) {
        // Invalidation alone can rejoin an older observer-less fetchQuery promise.
        await source.client.cancelQueries({ queryKey: source.key, exact: true });
        if (!isCurrent()) return;
        await invalidateNotebookQueries(workspaceId, 'agents');
        if (!isCurrent()) return;
      }
      // All consumers observe the same actual result; no private list can lag behind.
      await fetchChatAgents(workspaceId);
    } catch (error) {
      // Another surface may supersede this shared read. Its result arrives through
      // the cache subscription; cancellation is not a failed server response.
      if (isCurrent() && !isCancelledError(error)) throw error;
    }
  }, [token, source, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshAgents(false).catch(error => {
        if (!cancelled) console.error('Failed to load chat agents', error);
      });
    });
    return () => { cancelled = true; };
  }, [refreshAgents]);

  const acceptCreatedAgent = useCallback((agent: AgentProfile) => {
    const scope = active.current;
    if (!scope || scope.token !== token || !source || openedDocumentAuthScope() !== source.authScope) return false;
    scope.sequence += 1;
    // QueryClient cancels the retryer synchronously before returning its promise.
    // Seed after that cancellation so an earlier HTTP result cannot undo the ACK.
    void source.client.cancelQueries({ queryKey: source.key, exact: true });
    source.client.setQueryData<AgentProfile[]>(source.key, previous => [...(previous ?? []).filter(row => row.agentId !== agent.agentId), agent]);
    return true;
  }, [token, source]);

  return { availableAgents, scopeKey, refreshAgents, acceptCreatedAgent };
}
