'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { createScopedShareRequester } from '@/app/lib/public-sharing/client-request';

export function isCancelledShareRequest(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** A mounted panel owns a fixed workspace. Neither requests nor results may drift. */
export function useScopedShareRequest(workspaceId: string) {
  const mounted = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    mounted.current = true;
    const pending = controllers.current;
    return () => {
      mounted.current = false;
      pending.forEach((controller) => controller.abort());
      pending.clear();
    };
  }, [workspaceId]);
  return useCallback(<T,>(url: string, options: { method?: string; body?: unknown } = {}) => createScopedShareRequester({
    workspaceId,
    controllers: controllers.current,
    isCurrent: () => mounted.current && useWorkspaceStore.getState().activeWorkspaceId === workspaceId,
  })<T>(url, options), [workspaceId]);
}

export function localExpiryInput(iso: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function expiryFromInput(value: string) {
  return value ? new Date(value).toISOString() : null;
}
