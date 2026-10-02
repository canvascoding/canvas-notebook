'use client';

import { useSyncExternalStore } from 'react';
import type { WorkspaceOperationBatchPublic } from '@/app/lib/files/workspace-operation-batch-public';
import type { WorkspaceOperationCheckPublic } from '@/app/lib/files/workspace-operation-check-contract';
import { readWorkspaceOperationCheck, startWorkspaceOperationCheck, WorkspaceOperationReviewClientError } from '@/app/lib/files/workspace-operation-review-client';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation, type OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { useEditorStore } from '@/app/store/editor-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export type OperationCheckState = {
  workspaceId: string;
  reviewIds: string[];
  status: WorkspaceOperationCheckPublic['status'] | 'starting' | 'stale';
  check: WorkspaceOperationCheckPublic | null;
  batch: WorkspaceOperationBatchPublic | null;
  error: string | null;
};
type Entry = { value: OperationCheckState; scope: OpenedDocumentAuthScope; controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null; promise: Promise<void> | null; changed: boolean; polling: boolean };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let observing = false;
const sortedIds = (ids: string[]) => [...new Set(ids)].sort();
function keyFor(workspaceId: string, ids: string[], scope = openedDocumentAuthScope()): string | null {
  return scope ? JSON.stringify([scope.userId, scope.sessionId, workspaceId, sortedIds(ids)]) : null;
}
function storageKey(key: string): string { return `canvas:operation-check:${key}`; }
function publish(entry: Entry, patch: Partial<OperationCheckState>): void {
  entry.value = { ...entry.value, ...patch };
  for (const listener of listeners) listener();
}
function current(entry: Entry): boolean { return !entry.controller.signal.aborted && openedDocumentAuthScope() === entry.scope; }
function saveId(key: string, entry: Entry): void {
  try {
    if (entry.value.check) window.sessionStorage.setItem(storageKey(key), entry.value.check.checkId);
  } catch { /* Storage is optional; the in-memory controller still survives closing. */ }
}
function schedule(key: string, entry: Entry, delay: number): void {
  entry.timer = setTimeout(() => { entry.timer = null; void poll(key, entry); }, delay);
}
async function poll(key: string, entry: Entry): Promise<void> {
  if (!current(entry) || !entry.value.check || entry.polling) return;
  entry.polling = true;
  try {
    const result = await readWorkspaceOperationCheck(entry.value.check.checkId, entry.value.workspaceId, entry.controller.signal);
    if (!current(entry)) return;
    if (JSON.stringify(sortedIds(result.check.reviewIds)) !== JSON.stringify(entry.value.reviewIds)) {
      throw new Error('Check selection does not match the selected file actions.');
    }
    const status = entry.changed && ['ready', 'blocked'].includes(result.check.status) ? 'stale' : result.check.status;
    publish(entry, { check: result.check, status, batch: status === 'stale' ? null : result.batch ?? null, error: null });
    saveId(key, entry);
    if (['queued', 'checking'].includes(result.check.status)) schedule(key, entry, 1000);
    else window.dispatchEvent(new CustomEvent('notification_summary_updated'));
  } catch (error) {
    if (!current(entry)) return;
    const denied = error instanceof WorkspaceOperationReviewClientError && [401, 403, 404].includes(error.status);
    publish(entry, { error: error instanceof Error ? error.message : 'Check unavailable.', ...(denied ? { status: 'failed' as const, batch: null } : {}) });
    if (!denied) schedule(key, entry, 3000);
  } finally { entry.polling = false; }
}
function invalidateWorkspace(workspaceId: string | null): void {
  if (!workspaceId) return;
  for (const entry of entries.values()) {
    if (entry.value.workspaceId !== workspaceId || !current(entry)) continue;
    entry.changed = true;
    if (['ready', 'blocked'].includes(entry.value.status)) publish(entry, { status: 'stale', batch: null });
  }
}
function observe(): void {
  if (observing) return;
  observing = true;
  subscribeOpenedDocumentAuthInvalidation(() => {
    for (const entry of entries.values()) {
      entry.controller.abort();
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    entries.clear();
    for (const listener of listeners) listener();
  });
  getFileWatcherClient().addEventListener('filechange', ((event: CustomEvent<FileEvent>) => {
    invalidateWorkspace(event.detail.workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId);
  }) as EventListener);
  useEditorStore.subscribe((state, prior) => {
    if (state.activePath === prior.activePath && state.draft !== prior.draft) invalidateWorkspace(useWorkspaceStore.getState().activeWorkspaceId);
  });
}

/** The server check and this read-only poller continue after the dialog closes. */
export function ensureWorkspaceOperationCheck(workspaceId: string, reviewIds: string[], fresh = false): void {
  const scope = openedDocumentAuthScope();
  const ids = sortedIds(reviewIds);
  const key = keyFor(workspaceId, ids, scope);
  if (!key || !scope || ids.length === 0) return;
  observe();
  const existing = entries.get(key);
  if (!fresh && existing && current(existing)) {
    // Reopening validates terminal receipts; running jobs already have a poller.
    if (!existing.promise && !existing.polling && existing.timer === null && existing.value.check) {
      publish(existing, { status: 'starting', batch: null });
      void poll(key, existing);
    }
    return;
  }
  if (existing) {
    existing.controller.abort();
    if (existing.timer !== null) clearTimeout(existing.timer);
  }
  let savedId: string | null = null;
  if (!fresh) { try { savedId = window.sessionStorage.getItem(storageKey(key)); } catch { /* Optional storage. */ } }
  const entry: Entry = { value: { workspaceId, reviewIds: ids, status: 'starting', check: null, batch: null, error: null },
    scope, controller: new AbortController(), timer: null, promise: null, changed: false, polling: false };
  entries.set(key, entry);
  publish(entry, {});
  entry.promise = (async () => {
    try {
      if (savedId) {
        const result = await readWorkspaceOperationCheck(savedId, workspaceId, entry.controller.signal);
        if (!current(entry)) return;
        if (JSON.stringify(sortedIds(result.check.reviewIds)) !== JSON.stringify(ids)) throw new Error('Stored check selection mismatch.');
        publish(entry, { check: result.check, status: result.check.status, batch: result.batch ?? null });
      } else {
        const check = await startWorkspaceOperationCheck(ids, workspaceId);
        if (!current(entry)) return;
        publish(entry, { check, status: check.status });
      }
      saveId(key, entry);
      if (current(entry) && ['queued', 'checking'].includes(entry.value.status)) void poll(key, entry);
    } catch (error) {
      if (!current(entry)) return;
      publish(entry, { status: 'failed', error: error instanceof Error ? error.message : 'Check unavailable.' });
      if (savedId) { try { window.sessionStorage.removeItem(storageKey(key)); } catch { /* Optional storage. */ } }
    } finally { entry.promise = null; }
  })();
}

export function useWorkspaceOperationCheck(workspaceId: string, reviewIds: string[]): OperationCheckState | null {
  const key = keyFor(workspaceId, reviewIds);
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => key && reviewIds.length ? entries.get(key)?.value ?? null : null, () => null);
}

export function forgetWorkspaceOperationCheck(workspaceId: string, reviewIds: string[]): void {
  const key = keyFor(workspaceId, reviewIds);
  const entry = key ? entries.get(key) : null;
  if (!key || !entry) return;
  entry.controller.abort();
  if (entry.timer !== null) clearTimeout(entry.timer);
  entries.delete(key);
  try { window.sessionStorage.removeItem(storageKey(key)); } catch { /* Optional storage. */ }
  for (const listener of listeners) listener();
}
