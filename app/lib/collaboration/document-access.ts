import 'server-only';

import type * as YTypes from 'yjs';

import { loadCollaborationState } from './persistence';
import { Y } from './server-runtime';

type CollaborationDocumentReader = <T>(
  documentId: string,
  workspaceId: string,
  read: (doc: YTypes.Doc) => T,
) => Promise<T>;

const globalBridge = globalThis as typeof globalThis & {
  __canvasCollaborationDocumentReader?: CollaborationDocumentReader;
};

export function installCollaborationDocumentReader(handler: CollaborationDocumentReader): () => void {
  globalBridge.__canvasCollaborationDocumentReader = handler;
  return () => {
    if (globalBridge.__canvasCollaborationDocumentReader === handler) {
      delete globalBridge.__canvasCollaborationDocumentReader;
    }
  };
}

/**
 * Reads the currently authoritative Y.Doc when the collaboration server is in
 * this process. Test workers and maintenance commands fall back to the latest
 * persisted Yjs state instead of the materialized file checkpoint.
 */
export async function readCurrentCollaborationDocument<T>(input: {
  documentId: string;
  workspaceId: string;
  read: (doc: YTypes.Doc) => T;
}): Promise<T> {
  const handler = globalBridge.__canvasCollaborationDocumentReader;
  if (handler) return handler(input.documentId, input.workspaceId, input.read);

  const state = await loadCollaborationState(input.documentId);
  if (!state || state.status !== 'active' || state.workspaceId !== input.workspaceId) {
    throw new Error('The collaborative document state is unavailable or stale.');
  }
  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, state.yjsState);
    return input.read(doc);
  } finally {
    doc.destroy();
  }
}
