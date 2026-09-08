'use client';

import { useEffect, useRef, useState } from 'react';
import { useFileStore, type CurrentCollaborationLocationScope } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { workspaceHeaders } from '@/app/lib/files/client';
import { normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
import type { CollaborationDocumentLocation } from './document-location';
import type { TextCollaborationConnectionState, TextCollaborationRepresentation } from './types';

export type CollaborationLocationIssue = 'unavailable' | 'generationChanged' | 'lookupFailed';

type LocationInput = {
  workspaceId: string | null;
  documentId: string | null;
  documentKey?: string;
  path: string | null;
  lifecycleGeneration?: number;
  representation?: TextCollaborationRepresentation;
  connection?: TextCollaborationConnectionState;
};

function isCurrentLocationScope(scope: CurrentCollaborationLocationScope): boolean {
  const state = useFileStore.getState();
  return useWorkspaceStore.getState().activeWorkspaceId === scope.workspaceId
    && state.currentFileWorkspaceId === scope.workspaceId && state.treeGeneration === scope.treeGeneration
    && state.currentFile?.editorIdentity === scope.editorIdentity && state.currentFile.path === scope.path
    && state.currentFile.collaboration?.crdtCapable === true
    && state.currentFile.collaboration.document?.id === scope.documentId;
}

/** Watcher paths are invalidations only. Identity, never text or a reused name, resolves the new location. */
export function useCollaborationDocumentLocation(input: LocationInput): CollaborationLocationIssue | null {
  const { workspaceId, documentId, documentKey, path, lifecycleGeneration, representation, connection } = input;
  const key = JSON.stringify([workspaceId, documentId, documentKey, path, lifecycleGeneration, representation]);
  const [issue, setIssue] = useState<{ key: string; value: CollaborationLocationIssue | null } | null>(null);
  const refresh = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!workspaceId || !documentId || !documentKey || !path) return;
    const scope: CurrentCollaborationLocationScope = { workspaceId, documentId, editorIdentity: documentKey,
      path, treeGeneration: useFileStore.getState().treeGeneration };
    if (!isCurrentLocationScope(scope)) return;
    const watcher = getFileWatcherClient();
    let disposed = false;
    let revision = 0;
    let requested = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: AbortController | null = null;
    let requestTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastStarted = 0;
    let retryDelay = 0;
    const isCurrent = () => !disposed && isCurrentLocationScope(scope);
    const report = (value: CollaborationLocationIssue | null) => setIssue({ key, value });

    const schedule = (delay: number) => {
      if (!isCurrent() || active || timer) return;
      // One request at a time, with a bounded rate even in busy workspaces.
      timer = setTimeout(() => { timer = null; void resolve(); }, Math.max(delay, lastStarted + 1000 - Date.now()));
    };
    const invalidate = () => {
      revision++;
      requested = true;
      if (retryDelay) {
        retryDelay = 0;
        if (timer) clearTimeout(timer);
        timer = null;
      }
      schedule(150);
    };
    const resolve = async () => {
      if (!isCurrent()) return;
      requested = false;
      const requestRevision = revision;
      const controller = new AbortController();
      active = controller;
      lastStarted = Date.now();
      requestTimeout = setTimeout(() => controller.abort(), 10_000);
      const canApply = () => isCurrent() && revision === requestRevision;
      try {
        const query = new URLSearchParams({ workspaceId, documentId });
        const response = await fetch(`/api/files/collaboration/location?${query}`, {
          credentials: 'include', cache: 'no-store', headers: workspaceHeaders(workspaceId), signal: controller.signal,
        });
        if (!canApply()) return;
        if (controller.signal.aborted) throw new Error('Location lookup timed out.');
        if (response.status === 404) { retryDelay = 0; report('unavailable'); return; }
        if (!response.ok) throw new Error('Location lookup failed.');
        const location: Partial<CollaborationDocumentLocation> & { success?: boolean } = await response.json();
        if (!canApply()) return;
        if (controller.signal.aborted) throw new Error('Location lookup timed out.');
        if (location.success !== true || location.workspaceId !== workspaceId || location.documentId !== documentId
          || typeof location.path !== 'string' || normalizeWorkspacePathParam(location.path) !== location.path
          || !Number.isSafeInteger(location.lifecycleGeneration) || (location.lifecycleGeneration ?? 0) < 1
          || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(location.representation ?? '')) {
          throw new Error('Invalid document location.');
        }
        retryDelay = 0;
        if ((lifecycleGeneration !== undefined && location.lifecycleGeneration !== lifecycleGeneration)
          || (representation !== undefined && location.representation !== representation)) {
          report('generationChanged'); return;
        }
        report(null);
        if (location.path !== path) useFileStore.getState().adoptCurrentCollaborationLocation(scope, location.path);
      } catch {
        if (canApply()) {
          report('lookupFailed');
          retryDelay = Math.min(retryDelay ? retryDelay * 2 : 2000, 30_000);
          requested = true;
        }
      } finally {
        if (requestTimeout) clearTimeout(requestTimeout);
        requestTimeout = null;
        active = null;
        if (requested) schedule(retryDelay || 150);
      }
    };
    const onFileChange = (event: Event) => {
      const detail = (event as CustomEvent<FileEvent>).detail;
      if (!detail || (detail.workspaceId && detail.workspaceId !== workspaceId)) return;
      if (['add', 'unlink', 'addDir', 'unlinkDir'].includes(detail.type)) invalidate();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') invalidate(); };
    watcher.addEventListener('connected', invalidate);
    watcher.addEventListener('filechange', onFileChange);
    window.addEventListener('online', invalidate);
    window.addEventListener('focus', invalidate);
    document.addEventListener('visibilitychange', onVisible);
    refresh.current = invalidate;
    watcher.acquire();
    invalidate();
    return () => {
      disposed = true;
      if (refresh.current === invalidate) refresh.current = null;
      if (timer) clearTimeout(timer);
      active?.abort();
      if (requestTimeout) clearTimeout(requestTimeout);
      watcher.removeEventListener('connected', invalidate);
      watcher.removeEventListener('filechange', onFileChange);
      window.removeEventListener('online', invalidate);
      window.removeEventListener('focus', invalidate);
      document.removeEventListener('visibilitychange', onVisible);
      watcher.releaseConnection();
    };
  }, [workspaceId, documentId, documentKey, path, lifecycleGeneration, representation, key]);

  useEffect(() => { refresh.current?.(); }, [connection]);
  return issue?.key === key ? issue.value : null;
}
