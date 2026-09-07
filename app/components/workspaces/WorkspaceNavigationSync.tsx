'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import {
  clearWorkspaceScopedNavigationParams,
  getWorkspaceNavigationSyncAction,
} from '@/app/lib/workspaces/navigation-sync';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export function WorkspaceNavigationSync() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedWorkspaceId = searchParams.get('workspaceId')?.trim() || null;
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const search = searchParams.toString();
  const requestKey = requestedWorkspaceId ? `${pathname}?${search}` : null;
  const handledRequestKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const action = getWorkspaceNavigationSyncAction({
      requestedWorkspaceId,
      activeWorkspaceId,
      requestKey,
      handledRequestKey: handledRequestKeyRef.current,
    });
    if (action === 'ignore') {
      handledRequestKeyRef.current = null;
      return;
    }
    if (action === 'accept') {
      handledRequestKeyRef.current = requestKey;
      return;
    }
    if (action === 'clear') {
      const nextQuery = clearWorkspaceScopedNavigationParams(search);
      // Keep the request marked as handled until the URL update lands, so an
      // unrelated render cannot briefly re-apply the workspace being cleared.
      handledRequestKeyRef.current = requestKey;
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
      return;
    }
    if (!requestedWorkspaceId || !requestKey) return;
    const targetWorkspaceId = requestedWorkspaceId;
    const targetRequestKey = requestKey;

    let cancelled = false;
    void (async () => {
      await hydrateWorkspaces();
      if (cancelled) return;

      const workspaceState = useWorkspaceStore.getState();
      if (workspaceState.activeWorkspaceId === targetWorkspaceId) {
        handledRequestKeyRef.current = targetRequestKey;
        return;
      }
      if (await workspaceState.setActiveWorkspace(targetWorkspaceId, 'system')) {
        handledRequestKeyRef.current = targetRequestKey;
        return;
      }
      if (cancelled) return;

      // Do not open a workspace-scoped target in whichever workspace happens to
      // be active when the requested workspace is unavailable.
      const nextQuery = clearWorkspaceScopedNavigationParams(window.location.search);
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, hydrateWorkspaces, pathname, requestKey, requestedWorkspaceId, router, search]);

  return null;
}
