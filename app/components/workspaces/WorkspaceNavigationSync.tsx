'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { useWorkspaceStore } from '@/app/store/workspace-store';

export function WorkspaceNavigationSync() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedWorkspaceId = searchParams.get('workspaceId')?.trim() || null;
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);

  useEffect(() => {
    if (!requestedWorkspaceId || requestedWorkspaceId === activeWorkspaceId) return;

    let cancelled = false;
    void (async () => {
      await hydrateWorkspaces();
      if (cancelled) return;

      const workspaceState = useWorkspaceStore.getState();
      if (workspaceState.activeWorkspaceId === requestedWorkspaceId) return;
      if (await workspaceState.setActiveWorkspace(requestedWorkspaceId, 'system')) return;
      if (cancelled) return;

      // Do not open a workspace-scoped target in whichever workspace happens to
      // be active when the requested workspace is unavailable.
      const nextParams = new URLSearchParams(window.location.search);
      nextParams.delete('workspaceId');
      nextParams.delete('session');
      nextParams.delete('path');
      const nextQuery = nextParams.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, hydrateWorkspaces, pathname, requestedWorkspaceId, router]);

  return null;
}
