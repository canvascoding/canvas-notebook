'use client';

import { useEffect, useRef, useState } from 'react';
import { useFileStore, type CurrentCollaborationLocationScope } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { isWorkspaceFileInvalidation } from '@/app/lib/files/file-events';
import { requestCollaborationDocumentLocation } from './document-location-request';
import { CollaborationDocumentLocationRequestError, createDocumentLocationRetryBudget, nextDocumentLocationRetryDelay } from './document-location-retry';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation } from './opened-document-registry';
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
  /** Parameterless request owned by the mounted collaboration registry entry. */
  requestAdmissionRejoin?: () => Promise<void>;
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
  const admissionRejoin = useRef(input.requestAdmissionRejoin);
  useEffect(() => { admissionRejoin.current = input.requestAdmissionRejoin; }, [input.requestAdmissionRejoin]);

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
    let retryBudget: ReturnType<typeof createDocumentLocationRetryBudget> | null = null;
    let retryAuthScope = openedDocumentAuthScope();
    const isCurrent = () => !disposed && isCurrentLocationScope(scope);
    const report = (value: CollaborationLocationIssue | null) => setIssue({ key, value });

    const schedule = (delay: number) => {
      if (!isCurrent() || !requested || !retryBudget || active || timer) return;
      // One request at a time, with a bounded rate even in busy workspaces.
      timer = setTimeout(() => { timer = null; void resolve(); }, Math.max(delay,
        retryBudget.nextAt - Date.now(), lastStarted + 1000 - Date.now()));
    };
    const invalidate = () => {
      if (!isCurrent()) return;
      // An elapsed idle window is finished. A later genuine hint may open a new
      // one; hints during an attempt or its backoff cannot replenish it.
      if (retryBudget && Date.now() >= retryBudget.deadline && !active) {
        retryBudget = null;
        if (timer) clearTimeout(timer);
        timer = null;
      }
      revision++;
      requested = true;
      if (!retryBudget) {
        retryBudget = createDocumentLocationRetryBudget();
        retryAuthScope = openedDocumentAuthScope();
      }
      schedule(150);
    };
    const resolve = async () => {
      if (!isCurrent() || !requested || !retryBudget) return;
      const budget = retryBudget, authScope = retryAuthScope;
      if (openedDocumentAuthScope() !== authScope || budget.attempts >= 6 || Date.now() >= budget.deadline) {
        requested = false; retryBudget = null; return;
      }
      requested = false;
      budget.attempts++;
      const requestRevision = revision;
      const controller = new AbortController();
      active = controller;
      lastStarted = Date.now();
      requestTimeout = setTimeout(() => controller.abort(new CollaborationDocumentLocationRequestError(
        'Location lookup timed out.', { code: 'LOCATION_TIMEOUT', retryable: true })), Math.min(10_000, budget.deadline - lastStarted));
      const canApply = () => isCurrent() && revision === requestRevision && retryBudget === budget
        && retryAuthScope === authScope && openedDocumentAuthScope() === authScope;
      try {
        const location = await requestCollaborationDocumentLocation(workspaceId, documentId, controller.signal);
        if (!canApply()) return;
        if (!location) { retryBudget = null; requested = false; report('unavailable'); return; }
        if ((lifecycleGeneration !== undefined && location.lifecycleGeneration !== lifecycleGeneration)
          || (representation !== undefined && location.representation !== representation)) {
          retryBudget = null; requested = false; report('generationChanged'); return;
        }
        report(null);
        if (requestTimeout) clearTimeout(requestTimeout);
        requestTimeout = null;
        if (location.path !== path) {
          retryBudget = null; requested = false;
          useFileStore.getState().adoptCurrentCollaborationLocation(scope, location.path);
        }
        else {
          // An unchanged Incoming path still needs a new ticket after its room
          // was drained. This hint is not a grant; the registry performs fresh
          // HTTP authorization and exact identity checks before reconnecting.
          // Its unchanged registry cancellation lasts at most 10s. Do not start
          // it unless that entire lifetime fits within this refresh deadline.
          if (admissionRejoin.current && Date.now() + 10_000 >= budget.deadline) throw new Error('Document refresh deadline exhausted.');
          await admissionRejoin.current?.();
          if (canApply()) { retryBudget = null; requested = false; }
        }
      } catch (error) {
        if (canApply()) {
          report('lookupFailed');
          const delay = nextDocumentLocationRetryDelay(budget, error);
          requested = delay !== null;
          if (delay === null) retryBudget = null;
        }
      } finally {
        if (requestTimeout) clearTimeout(requestTimeout);
        requestTimeout = null;
        if (active === controller) active = null;
        if (retryBudget === budget && openedDocumentAuthScope() !== authScope) { retryBudget = null; requested = false; }
        if (requested) schedule(150);
      }
    };
    const onAuthInvalidated = () => {
      revision++; requested = false; retryBudget = null;
      if (timer) clearTimeout(timer);
      timer = null;
      active?.abort(new Error('The signed-in session changed.'));
    };
    const removeAuthListener = subscribeOpenedDocumentAuthInvalidation(onAuthInvalidated);
    const onFileChange = (event: Event) => {
      const detail = (event as CustomEvent<FileEvent>).detail;
      if (!detail || (detail.workspaceId && detail.workspaceId !== workspaceId)) return;
      if (['add', 'unlink', 'addDir', 'unlinkDir'].includes(detail.type)) invalidate();
    };
    const onWorkspaceInvalidated = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (isCurrent() && isWorkspaceFileInvalidation(detail) && detail.workspaceId === workspaceId) invalidate();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') invalidate(); };
    watcher.addEventListener('connected', invalidate);
    watcher.addEventListener('filechange', onFileChange);
    watcher.addEventListener('workspace-invalidated', onWorkspaceInvalidated);
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
      removeAuthListener();
      watcher.removeEventListener('connected', invalidate);
      watcher.removeEventListener('filechange', onFileChange);
      watcher.removeEventListener('workspace-invalidated', onWorkspaceInvalidated);
      window.removeEventListener('online', invalidate);
      window.removeEventListener('focus', invalidate);
      document.removeEventListener('visibilitychange', onVisible);
      watcher.releaseConnection();
    };
  }, [workspaceId, documentId, documentKey, path, lifecycleGeneration, representation, key]);

  useEffect(() => { refresh.current?.(); }, [connection]);
  return issue?.key === key ? issue.value : null;
}
