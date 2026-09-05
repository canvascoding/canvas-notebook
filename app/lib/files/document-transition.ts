/** Editors register persistence checks for formats with their own save protocol. */
type DocumentTransitionGuard = {
  prepare: () => Promise<void>;
  hasPendingChanges: () => boolean;
};

const guards = new Map<string, DocumentTransitionGuard>();

export function registerDocumentTransitionGuard(
  workspaceId: string | null,
  path: string,
  guard: DocumentTransitionGuard,
) {
  const key = `${workspaceId ?? 'legacy'}\0${path}`;
  guards.set(key, guard);
  return () => {
    if (guards.get(key) === guard) guards.delete(key);
  };
}

export function getDocumentTransitionGuard(workspaceId: string | null, path: string) {
  return guards.get(`${workspaceId ?? 'legacy'}\0${path}`);
}
