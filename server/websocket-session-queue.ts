/**
 * Serializes state-changing chat WebSocket actions for one user/session pair.
 *
 * WebSocket frames are received in order, but their asynchronous handlers are
 * otherwise allowed to overlap. Runtime startup and queue controls must keep
 * that arrival order so a follow-up cannot overtake the prompt that starts it.
 */

const sessionActionTails = new Map<string, Promise<void>>();

function getSessionActionKey(userId: string, sessionId: string): string {
  return JSON.stringify([userId, sessionId]);
}

export async function runWebSocketSessionAction<T>(
  userId: string,
  sessionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = getSessionActionKey(userId, sessionId);
  const previousTail = sessionActionTails.get(key) ?? Promise.resolve();

  let releaseCurrent!: () => void;
  const currentAction = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const currentTail = previousTail
    .catch(() => undefined)
    .then(() => currentAction);

  sessionActionTails.set(key, currentTail);
  await previousTail.catch(() => undefined);

  try {
    return await action();
  } finally {
    releaseCurrent();
    if (sessionActionTails.get(key) === currentTail) {
      sessionActionTails.delete(key);
    }
  }
}
