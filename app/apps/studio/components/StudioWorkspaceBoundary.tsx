'use client';

import { useLayoutEffect, type ReactNode } from 'react';

import { useStudioGenerationsCacheStore } from '@/app/store/studio-generations-cache-store';
import { useStudioGenerationStore } from '@/app/store/studio-generation-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export function StudioWorkspaceBoundary({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const cacheWorkspaceId = useStudioGenerationsCacheStore((state) => state.workspaceId);

  useLayoutEffect(() => {
    useStudioGenerationsCacheStore.getState().resetForWorkspace(workspaceId);
    useStudioGenerationStore.getState().resetWorkspaceContext();
  }, [workspaceId]);

  if (cacheWorkspaceId !== workspaceId) return null;

  return <div key={workspaceId ?? 'loading'} className="contents">{children}</div>;
}
