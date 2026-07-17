import 'server-only';

import type { FilePresenceEntry, WorkspacePresenceMessage, WorkspacePresenceSnapshot } from './types';

const PRESENCE_TTL_MS = 45_000;

type PresenceListener = (message: WorkspacePresenceMessage) => void;
type PresenceStore = {
  entries: Map<string, Map<string, FilePresenceEntry>>;
  versions: Map<string, number>;
  listeners: Map<string, Set<PresenceListener>>;
};

const globalPresence = globalThis as typeof globalThis & { __canvasFilePresence?: PresenceStore };
const store = globalPresence.__canvasFilePresence ??= {
  entries: new Map(),
  versions: new Map(),
  listeners: new Map(),
};

function entryKey(entry: Pick<FilePresenceEntry, 'documentId' | 'userId' | 'actorType'>): string {
  return `${entry.documentId}\0${entry.actorType}\0${entry.userId}`;
}

function prune(workspaceId: string, now = Date.now()): void {
  const entries = store.entries.get(workspaceId);
  if (!entries) return;
  let changed = false;
  for (const [key, entry] of entries) {
    if (now - entry.updatedAt > PRESENCE_TTL_MS) {
      entries.delete(key);
      changed = true;
    }
  }
  if (changed) store.versions.set(workspaceId, (store.versions.get(workspaceId) ?? 0) + 1);
}

export function getWorkspacePresenceSnapshot(workspaceId: string): WorkspacePresenceSnapshot {
  prune(workspaceId);
  return {
    workspaceId,
    version: store.versions.get(workspaceId) ?? 0,
    entries: [...(store.entries.get(workspaceId)?.values() ?? [])],
  };
}

function publish(workspaceId: string, documentId: string): void {
  const snapshot = getWorkspacePresenceSnapshot(workspaceId);
  const message: WorkspacePresenceMessage = {
    type: 'delta',
    workspaceId,
    version: snapshot.version,
    documentId,
    entries: snapshot.entries.filter((entry) => entry.documentId === documentId),
  };
  for (const listener of store.listeners.get(workspaceId) ?? []) listener(message);
}

/** Replaces one document's human awareness projection without deleting agent presence. */
export function replaceDocumentPresence(
  workspaceId: string,
  documentId: string,
  nextEntries: FilePresenceEntry[],
): void {
  const entries = store.entries.get(workspaceId) ?? new Map<string, FilePresenceEntry>();
  store.entries.set(workspaceId, entries);
  for (const [key, entry] of entries) {
    if (entry.documentId === documentId && entry.actorType === 'user') entries.delete(key);
  }
  for (const entry of nextEntries) {
    const key = entryKey(entry);
    const current = entries.get(key);
    if (!current || current.updatedAt <= entry.updatedAt) entries.set(key, entry);
  }
  store.versions.set(workspaceId, (store.versions.get(workspaceId) ?? 0) + 1);
  publish(workspaceId, documentId);
}

export function upsertDocumentPresenceEntry(entry: FilePresenceEntry): void {
  const entries = store.entries.get(entry.workspaceId) ?? new Map<string, FilePresenceEntry>();
  store.entries.set(entry.workspaceId, entries);
  entries.set(entryKey(entry), entry);
  store.versions.set(entry.workspaceId, (store.versions.get(entry.workspaceId) ?? 0) + 1);
  publish(entry.workspaceId, entry.documentId);
}

export function removeDocumentPresenceEntry(entry: Pick<FilePresenceEntry, 'workspaceId' | 'documentId' | 'userId' | 'actorType'>): void {
  const entries = store.entries.get(entry.workspaceId);
  if (!entries?.delete(entryKey(entry))) return;
  store.versions.set(entry.workspaceId, (store.versions.get(entry.workspaceId) ?? 0) + 1);
  publish(entry.workspaceId, entry.documentId);
}

export function subscribeWorkspacePresence(workspaceId: string, listener: PresenceListener): () => void {
  const listeners = store.listeners.get(workspaceId) ?? new Set<PresenceListener>();
  store.listeners.set(workspaceId, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) store.listeners.delete(workspaceId);
  };
}
