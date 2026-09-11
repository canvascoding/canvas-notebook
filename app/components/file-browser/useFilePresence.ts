'use client';

import { useEffect } from 'react';
import { LiveEventSource } from '@/app/lib/live-events/client';

import { useFilePresenceStore } from '@/app/store/file-presence-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export function useFilePresence(): void {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  useEffect(() => {
    useFilePresenceStore.getState().clear();
    if (!workspaceId) return;
    const url = `/api/files/presence?stream=1&workspaceId=${encodeURIComponent(workspaceId)}`;
    const source = new LiveEventSource(url);
    let disposed = false;
    source.onopen = () => { if (!disposed && useWorkspaceStore.getState().activeWorkspaceId === workspaceId) useFilePresenceStore.setState({ version: 0 }); };
    source.onmessage = (event) => {
      if (disposed || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
      try { useFilePresenceStore.getState().applyMessage(JSON.parse(event.data)); } catch {}
    };
    return () => { disposed = true; source.close(); };
  }, [workspaceId]);
}
