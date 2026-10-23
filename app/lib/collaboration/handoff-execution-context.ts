import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

// Server and Next bundles share only this negative entry constraint. It grants
// no connection, lock, principal or mutation authority; those remain private to
// the actual handoff. Retained continuations remain marked after completion.
const shared = globalThis as typeof globalThis & {
  __canvasCollaborationHandoffExecutionV1?: AsyncLocalStorage<Readonly<object>>;
};
const context = shared.__canvasCollaborationHandoffExecutionV1 ??=
  new AsyncLocalStorage<Readonly<object>>();

export function hasCollaborationHandoffExecutionContext(): boolean {
  return context.getStore() !== undefined;
}

/** Internal execution marker, exclusively a reason to reject a nested entry. */
export function withCollaborationHandoffExecutionContext<T>(operation: () => Promise<T>): Promise<T> {
  return context.run(Object.freeze({}), operation);
}
