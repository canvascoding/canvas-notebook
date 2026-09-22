'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
  AiRuntimeSelectionSource,
} from '@/app/lib/agent-runtime-policy/types';
import { getNotebookQueryClient } from '@/app/lib/queries/client';
import { fetchEffectiveRuntime, isRuntimeResolution, workspaceQueryKeys } from '@/app/lib/queries/workspace-queries';

type RuntimeRequestState = {
  contextKey: string;
  resolution: AiEffectiveRuntimeResolution | null;
  loading: boolean;
  error: string | null;
};

type LocalSelectionState = {
  contextKey: string;
  selection: AiRuntimeSelection;
};

type UseChatRuntimeSelectionParams = {
  workspaceId: string | null;
  agentId: string;
  sessionId: string | null;
};

function selectionForResolution(
  resolution: AiEffectiveRuntimeResolution | null,
): AiRuntimeSelection | null {
  return resolution?.effectiveSelection?.selection ?? null;
}

export function useChatRuntimeSelection({
  workspaceId,
  agentId,
  sessionId,
}: UseChatRuntimeSelectionParams) {
  const contextKey = `${workspaceId ?? ''}\0${agentId}\0${sessionId ?? '__new__'}`;
  const requestSequenceRef = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [requestState, setRequestState] = useState<RuntimeRequestState>({
    contextKey: '',
    resolution: null,
    loading: false,
    error: null,
  });
  const [localSelection, setLocalSelection] = useState<LocalSelectionState | null>(null);

  useEffect(() => {
    if (!workspaceId || !agentId) return;

    const requestSequence = ++requestSequenceRef.current;
    const controller = new AbortController();
    Promise.resolve().then(() => {
      if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
      setRequestState((current) => ({
        contextKey,
        resolution: current.contextKey === contextKey ? current.resolution : null,
        loading: true,
        error: null,
      }));
    });

    void fetchEffectiveRuntime({ workspaceId, agentId, sessionId }, controller.signal)
      .then((resolution) => {
        if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
        setRequestState({
          contextKey,
          resolution,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
        setRequestState((current) => ({
          contextKey,
          resolution: current.contextKey === contextKey ? current.resolution : null,
          loading: false,
          error: error instanceof Error ? error.message : 'Runtime selection could not be loaded.',
        }));
      });

    return () => {
      controller.abort();
    };
  }, [agentId, contextKey, reloadToken, sessionId, workspaceId]);

  const stateForContext = requestState.contextKey === contextKey ? requestState : null;
  const resolution = stateForContext?.resolution ?? null;
  const localSelectionForContext = localSelection?.contextKey === contextKey
    ? localSelection.selection
    : null;
  const selection = localSelectionForContext ?? selectionForResolution(resolution);
  const selectionSource: AiRuntimeSelectionSource | null = localSelectionForContext
    ? 'session'
    : resolution?.source ?? null;

  const setRequestedSelection = useCallback((next: AiRuntimeSelection) => {
    setLocalSelection({ contextKey, selection: next });
  }, [contextKey]);

  const applyResolution = useCallback((next: AiEffectiveRuntimeResolution) => {
    if (!isRuntimeResolution(next)) return;
    if (workspaceId) {
      const queryClient = getNotebookQueryClient();
      const queryKey = workspaceQueryKeys.runtime({ workspaceId, agentId, sessionId });
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData(queryKey, next);
    }
    requestSequenceRef.current += 1;
    setRequestState({
      contextKey,
      resolution: next,
      loading: false,
      error: null,
    });
    setLocalSelection((current) => (
      current?.contextKey === contextKey ? null : current
    ));
  }, [agentId, contextKey, sessionId, workspaceId]);

  const refresh = useCallback(() => {
    if (workspaceId) {
      void getNotebookQueryClient().invalidateQueries({
        queryKey: workspaceQueryKeys.runtime({ workspaceId, agentId, sessionId }),
        exact: true,
      });
    }
    setReloadToken((current) => current + 1);
  }, [agentId, sessionId, workspaceId]);

  return useMemo(() => ({
    resolution,
    selection,
    selectionSource,
    hasLocalSelection: Boolean(localSelectionForContext),
    loading: Boolean(agentId) && (!workspaceId || !stateForContext || stateForContext.loading),
    error: stateForContext?.error ?? null,
    setRequestedSelection,
    applyResolution,
    refresh,
  }), [
    agentId,
    applyResolution,
    localSelectionForContext,
    refresh,
    resolution,
    selection,
    selectionSource,
    setRequestedSelection,
    stateForContext,
    workspaceId,
  ]);
}
