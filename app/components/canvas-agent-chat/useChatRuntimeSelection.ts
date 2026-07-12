'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
  AiRuntimeSelectionSource,
} from '@/app/lib/agent-runtime-policy/types';

type EffectiveRuntimeResponse = {
  success?: boolean;
  resolution?: AiEffectiveRuntimeResolution;
  // Kept temporarily so the client can tolerate the preferences-route response
  // shape while every runtime consumer moves to the dedicated effective endpoint.
  data?: AiEffectiveRuntimeResolution;
  error?: string;
  code?: string;
};

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

function isRuntimeResolution(value: unknown): value is AiEffectiveRuntimeResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<AiEffectiveRuntimeResolution>;
  return Number.isSafeInteger(candidate.catalogRevision)
    && Number.isSafeInteger(candidate.policyRevision)
    && Array.isArray(candidate.providers)
    && Array.isArray(candidate.issues);
}

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
    const query = new URLSearchParams({ workspaceId, agentId });
    if (sessionId) query.set('sessionId', sessionId);

    Promise.resolve().then(() => {
      if (requestSequence !== requestSequenceRef.current) return;
      setRequestState((current) => ({
        contextKey,
        resolution: current.contextKey === contextKey ? current.resolution : null,
        loading: true,
        error: null,
      }));
    });

    void fetch(`/api/agent-runtime/effective?${query.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as EffectiveRuntimeResponse | null;
        if (!response.ok || payload?.success !== true) {
          throw new Error(payload?.error || `Runtime selection could not be loaded (HTTP ${response.status}).`);
        }
        const resolution = payload.resolution ?? payload.data;
        if (!isRuntimeResolution(resolution)) {
          throw new Error('The runtime service returned an invalid response.');
        }
        return resolution;
      })
      .then((resolution) => {
        if (requestSequence !== requestSequenceRef.current) return;
        setRequestState({
          contextKey,
          resolution,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
        setRequestState({
          contextKey,
          resolution: null,
          loading: false,
          error: error instanceof Error ? error.message : 'Runtime selection could not be loaded.',
        });
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
    setRequestState({
      contextKey,
      resolution: next,
      loading: false,
      error: null,
    });
    setLocalSelection((current) => (
      current?.contextKey === contextKey ? null : current
    ));
  }, [contextKey]);

  const refresh = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

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
