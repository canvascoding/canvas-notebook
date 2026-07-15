'use client';

import { useEffect } from 'react';

import { useFilePresenceStore } from '@/app/store/file-presence-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export function useFilePresence(): void {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  useEffect(() => {
    useFilePresenceStore.getState().clear();
    if (!workspaceId) return;
    const url = `/api/files/presence?stream=1&workspaceId=${encodeURIComponent(workspaceId)}`;
    const source = new EventSource(url);
    source.onmessage = (event) => {
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
      try { useFilePresenceStore.getState().applyMessage(JSON.parse(event.data)); } catch {}
    };
    return () => source.close();
  }, [workspaceId]);
}
