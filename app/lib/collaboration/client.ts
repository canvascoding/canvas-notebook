'use client';

import { useEffect, useState } from 'react';

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

import { workspaceHeaders } from '@/app/lib/files/client';
import type {
  CollaborationConnectionStatus,
  TextCollaborationRepresentation,
  CollaborationSessionResponse,
} from './types';

type RegistryEntry = {
  key: string;
  refs: number;
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  persistence: IndexeddbPersistence | null;
  session: CollaborationSessionResponse | null;
  status: CollaborationConnectionStatus;
  error: string | null;
  listeners: Set<() => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  startPromise: Promise<void>;
};

export type CollaborationDocument = {
  registryKey: string;
  doc: Y.Doc;
  provider: HocuspocusProvider | null;
  session: CollaborationSessionResponse | null;
  status: CollaborationConnectionStatus;
  error: string | null;
  setComposition: (range: { textName: 'content' | 'body'; from: number; to: number } | null) => void;
};

const registry = new Map<string, RegistryEntry>();

function emit(entry: RegistryEntry): void {
  for (const listener of entry.listeners) listener();
}

async function requestSession(path: string, representation: TextCollaborationRepresentation): Promise<CollaborationSessionResponse> {
  const response = await fetch('/api/files/collaboration/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    body: JSON.stringify({ path, representation }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<CollaborationSessionResponse> & { error?: string };
  if (!response.ok || payload.success !== true) throw new Error(payload.error || 'Collaboration could not be started.');
  return payload as CollaborationSessionResponse;
}

function websocketUrl(relative: string): string {
  const url = new URL(relative, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function createEntry(key: string, path: string, representation: TextCollaborationRepresentation): RegistryEntry {
  const entry: RegistryEntry = {
    key,
    refs: 0,
    doc: null,
    provider: null,
    persistence: null,
    session: null,
    status: 'connecting',
    error: null,
    listeners: new Set(),
    startPromise: Promise.resolve(),
  };
  entry.startPromise = (async () => {
    try {
      const [{ HocuspocusProvider }, { IndexeddbPersistence }, Y] = await Promise.all([
        import('@hocuspocus/provider'),
        import('y-indexeddb'),
        import('yjs'),
      ]);
      if (entry.refs === 0 && !registry.has(key)) return;
      entry.doc = new Y.Doc({ gc: true });
      let session = await requestSession(path, representation);
      entry.session = session;
      const persistence = new IndexeddbPersistence(
        `canvas:${session.documentId}:${session.lifecycleGeneration}:${representation}`,
        entry.doc,
      );
      entry.persistence = persistence;
      const provider = new HocuspocusProvider({
        url: websocketUrl(session.websocketUrl),
        preserveTrailingSlash: true,
        name: session.documentName,
        document: entry.doc,
        token: async () => {
          if (Date.parse(session.expiresAt) - Date.now() < 30_000) {
            session = await requestSession(path, representation);
            entry.session = session;
          }
          return session.token;
        },
        flushDelay: 75,
        onStatus: ({ status }) => {
          entry.status = status === 'connected' ? 'live' : status === 'connecting' ? 'reconnecting' : 'offline';
          emit(entry);
        },
        onSynced: () => {
          entry.status = session.permission === 'write' ? 'saved' : 'read_only';
          emit(entry);
        },
        onUnsyncedChanges: ({ number }) => {
          if (entry.status === 'offline' || entry.status === 'reconnecting' || entry.status === 'degraded') return;
          entry.status = number > 0
            ? 'persisting'
            : session.permission === 'write' ? 'live' : 'read_only';
          emit(entry);
        },
        onAuthenticationFailed: ({ reason }) => {
          entry.status = 'degraded';
          entry.error = reason || 'Collaboration authentication failed.';
          emit(entry);
        },
        onStateless: ({ payload }) => {
          try {
            const message = JSON.parse(payload) as {
              type?: string;
              message?: string;
              sequence?: number;
            };
            entry.status = message.type === 'degraded' ? 'degraded' : 'saved';
            entry.error = message.type === 'degraded' ? message.message || 'Checkpoint failed.' : null;
            if (message.type === 'checkpointed' && Number.isSafeInteger(message.sequence)) {
              entry.provider?.sendStateless(JSON.stringify({
                type: 'checkpoint_ack',
                documentId: session.documentId,
                lifecycleGeneration: session.lifecycleGeneration,
                sequence: message.sequence,
              }));
            }
            emit(entry);
          } catch {}
        },
      });
      entry.provider = provider;
      provider.setAwarenessField('canvas', {
        userId: session.user.id,
        displayName: session.user.name,
        color: session.user.color,
        colorLight: session.user.colorLight,
        activity: session.permission === 'write' ? 'editing' : 'viewing',
      });
      emit(entry);
    } catch (error) {
      entry.status = 'degraded';
      entry.error = error instanceof Error ? error.message : 'Collaboration could not be started.';
      emit(entry);
    }
  })();
  return entry;
}

function snapshot(entry: RegistryEntry): CollaborationDocument {
  if (!entry.doc) throw new Error('Collaboration document is not initialized.');
  return {
    registryKey: entry.key,
    doc: entry.doc,
    provider: entry.provider,
    session: entry.session,
    status: entry.status,
    error: entry.error,
    setComposition: (range) => {
      const provider = entry.provider;
      if (!provider) return;
      const current = provider.awareness?.getLocalState()?.canvas as Record<string, unknown> | undefined;
      provider.setAwarenessField('canvas', { ...(current || {}), composition: range });
    },
  };
}

export function useCollaborationDocument(input: {
  enabled: boolean;
  workspaceId: string | null;
  path: string | undefined;
  representation: TextCollaborationRepresentation;
}): CollaborationDocument | null {
  const key = input.enabled && input.workspaceId && input.path
    ? `${input.workspaceId}\0${input.path}\0${input.representation}`
    : null;
  const [state, setState] = useState<CollaborationDocument | null>(null);
  useEffect(() => {
    if (!key || !input.path) {
      return;
    }
    let entry = registry.get(key);
    if (!entry) {
      entry = createEntry(key, input.path, input.representation);
      registry.set(key, entry);
    }
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.refs += 1;
    const update = () => setState(entry.doc ? snapshot(entry) : null);
    entry.listeners.add(update);
    update();
    return () => {
      entry.listeners.delete(update);
      entry.refs -= 1;
      if (entry.refs === 0) {
        entry.cleanupTimer = setTimeout(() => {
          if (entry.refs !== 0) return;
          entry.provider?.destroy();
          entry.persistence?.destroy();
          entry.doc?.destroy();
          registry.delete(key);
        }, 1_000);
      }
    };
  }, [input.path, input.representation, key]);
  return key && state?.registryKey === key ? state : null;
}
