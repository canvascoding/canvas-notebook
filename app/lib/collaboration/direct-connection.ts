import 'server-only';

import type * as Y from 'yjs';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export interface AgentDirectConnectionInput {
  documentId: string;
  workspace: WorkspaceContext;
  actorId: string;
  actorDisplayName: string;
  initiatedByUserId: string;
  operationId: string;
  actorType?: 'agent' | 'user';
  actorSessionId?: string;
}

type DirectConnectionHandler = <T>(
  input: AgentDirectConnectionInput,
  apply: (doc: Y.Doc) => T,
  onApplied?: (result: T) => Promise<void>,
) => Promise<T>;

const globalBridge = globalThis as typeof globalThis & { __canvasCollaborationDirectConnection?: DirectConnectionHandler };

export function installCollaborationDirectConnection(handler: DirectConnectionHandler): () => void {
  globalBridge.__canvasCollaborationDirectConnection = handler;
  return () => {
    if (globalBridge.__canvasCollaborationDirectConnection === handler) {
      delete globalBridge.__canvasCollaborationDirectConnection;
    }
  };
}

export async function runCollaborationDirectConnection<T>(
  input: AgentDirectConnectionInput,
  apply: (doc: Y.Doc) => T,
  onApplied?: (result: T) => Promise<void>,
): Promise<T> {
  const handler = globalBridge.__canvasCollaborationDirectConnection;
  if (!handler) throw new Error('Collaboration server is unavailable; create a review patch instead.');
  return handler(input, apply, onApplied);
}
