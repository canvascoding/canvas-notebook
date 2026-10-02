'use client';

import { useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';

import { workspaceScopedNavigationMatches } from '@/app/lib/workspaces/navigation-sync';
import { useStudioGenerationsCacheStore } from '@/app/store/studio-generations-cache-store';
import { useStudioGenerationStore } from '@/app/store/studio-generation-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

const subscribeToHydration = () => () => {};
const clientHydrationSnapshot = () => true;
const serverHydrationSnapshot = () => false;

export function StudioWorkspaceBoundary({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribeToHydration, clientHydrationSnapshot, serverHydrationSnapshot);
  const searchParams = useSearchParams();
  const requestedWorkspaceId = searchParams.get('workspaceId')?.trim() || null;
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const cacheWorkspaceId = useStudioGenerationsCacheStore((state) => state.workspaceId);

  useLayoutEffect(() => {
    useStudioGenerationsCacheStore.getState().resetForWorkspace(workspaceId);
    useStudioGenerationStore.getState().resetWorkspaceContext();
  }, [workspaceId]);

  if (
    !mounted
    || !workspaceScopedNavigationMatches(requestedWorkspaceId, workspaceId)
    || cacheWorkspaceId !== workspaceId
  ) return null;

  return <div key={workspaceId ?? 'loading'} className="contents">{children}</div>;
}
