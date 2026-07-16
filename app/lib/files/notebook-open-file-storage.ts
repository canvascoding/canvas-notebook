const NOTEBOOK_OPEN_FILE_STORAGE_KEY = 'canvas.notebookOpenFilePath';

export function normalizeNotebookFilePath(path: string | null) {
  const normalized = path?.replace(/^\.\/|\/+$/g, '').trim();
  return normalized || null;
}

export function notebookOpenFileStorageKey(workspaceId: string) {
  return `${NOTEBOOK_OPEN_FILE_STORAGE_KEY}:${workspaceId}`;
}

export function readStoredNotebookOpenFilePath(storage: Storage, workspaceId: string) {
  return normalizeNotebookFilePath(storage.getItem(notebookOpenFileStorageKey(workspaceId)));
}

export function writeStoredNotebookOpenFilePath(storage: Storage, workspaceId: string, path: string) {
  const normalizedPath = normalizeNotebookFilePath(path);
  if (!normalizedPath) return;
  storage.setItem(notebookOpenFileStorageKey(workspaceId), normalizedPath);
}

export function clearStoredNotebookOpenFilePath(storage: Storage, workspaceId: string) {
  storage.removeItem(notebookOpenFileStorageKey(workspaceId));
}

export function clearLegacyStoredNotebookOpenFilePath(storage: Storage) {
  storage.removeItem(NOTEBOOK_OPEN_FILE_STORAGE_KEY);
}
