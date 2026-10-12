'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';

function isPersonalAgentWorkspace(workspace: ClientWorkspaceSummary | undefined): boolean {
  return Boolean(workspace?.type === 'personal'
    && workspace.status === 'active'
    && workspace.permissions.canRead
    && workspace.permissions.canRunAgent);
}

export function useOnboardingProfileSession({ locale, errorMessage, onAlreadyComplete }: {
  locale: string;
  errorMessage: string;
  onAlreadyComplete: () => void;
}) {
  const [binding, setBinding] = useState<{ sessionId: string; workspaceId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspaceError = useWorkspaceStore((state) => state.error);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const completeRef = useRef(onAlreadyComplete);
  useEffect(() => { completeRef.current = onAlreadyComplete; }, [onAlreadyComplete]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setBinding(null);
    setLoading(false);
  }, []);

  const retry = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    const generation = ++generationRef.current;
    requestRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && generationRef.current === generation;
    setBinding(null);
    setError(null);
    setLoading(true);
    try {
      const response = await fetch('/api/onboarding/profile-session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
        signal: controller.signal,
      });
      const data = await response.json() as {
        success?: boolean; complete?: boolean; sessionId?: string; workspaceId?: string; error?: string;
      };
      if (!isCurrent()) return;
      if (!response.ok || !data.success) throw new Error(data.error || errorMessage);
      if (data.complete) {
        completeRef.current();
        return;
      }
      if (!data.sessionId?.trim() || !data.workspaceId?.trim()) throw new Error(errorMessage);

      await useWorkspaceStore.getState().hydrateWorkspaces({ force: true });
      if (!isCurrent()) return;
      const hydrated = useWorkspaceStore.getState();
      if (hydrated.error || !isPersonalAgentWorkspace(hydrated.workspaces.find((workspace) => workspace.id === data.workspaceId))) {
        throw new Error(hydrated.error || errorMessage);
      }
      await hydrated.setActiveWorkspace(data.workspaceId, 'system', { signal: controller.signal });
      if (!isCurrent()) return;
      const current = useWorkspaceStore.getState();
      if (current.activeWorkspaceId !== data.workspaceId
        || !isPersonalAgentWorkspace(current.workspaces.find((workspace) => workspace.id === data.workspaceId))) {
        throw new Error(current.error || errorMessage);
      }
      setBinding({ sessionId: data.sessionId, workspaceId: data.workspaceId });
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : errorMessage);
    } finally {
      if (isCurrent()) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [errorMessage, locale]);

  useEffect(() => {
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      if (generationRef.current === generation) void retry();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      generationRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [retry]);

  const ready = Boolean(binding && !workspaceError && activeWorkspaceId === binding.workspaceId
    && isPersonalAgentWorkspace(workspaces.find((workspace) => workspace.id === binding.workspaceId)));

  return {
    sessionId: binding?.sessionId ?? null,
    workspaceId: binding?.workspaceId ?? null,
    ready,
    loading,
    error: error || (binding && !ready ? workspaceError || errorMessage : null),
    retry,
    cancel,
  };
}
