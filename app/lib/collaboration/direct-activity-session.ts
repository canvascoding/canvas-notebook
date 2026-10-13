import 'server-only';

import type { AgentDirectConnectionInput } from './direct-connection';

/** A transport/idle pin for one user operation, never native mutation authority. */
export type CollaborationDirectActivitySessionInput = AgentDirectConnectionInput & {
  actorType: 'user';
  actorSessionId: string;
};

export interface CollaborationDirectActivitySession {
  /** Recheck identity, user access, admission and the still-live local activity. */
  assertOpen(): Promise<void>;
}

export type CollaborationDirectActivitySessionHandler = <T>(
  input: CollaborationDirectActivitySessionInput,
  operation: (session: CollaborationDirectActivitySession) => Promise<T>,
) => Promise<T>;

const bridge = globalThis as typeof globalThis & {
  __canvasCollaborationDirectActivitySession?: CollaborationDirectActivitySessionHandler;
};

export function installCollaborationDirectActivitySession(handler: CollaborationDirectActivitySessionHandler): () => void {
  bridge.__canvasCollaborationDirectActivitySession = handler;
  return () => {
    if (bridge.__canvasCollaborationDirectActivitySession === handler) {
      delete bridge.__canvasCollaborationDirectActivitySession;
    }
  };
}

/** Identity observation only; an installed handler still verifies all authority. */
export function isCollaborationDirectActivitySessionInstalled(handler: CollaborationDirectActivitySessionHandler): boolean {
  return bridge.__canvasCollaborationDirectActivitySession === handler;
}

export async function withCollaborationDirectActivitySession<T>(
  input: CollaborationDirectActivitySessionInput,
  operation: (session: CollaborationDirectActivitySession) => Promise<T>,
): Promise<T> {
  const handler = bridge.__canvasCollaborationDirectActivitySession;
  if (!handler) throw new Error('Collaboration activity server is unavailable.');
  return handler(input, operation);
}
