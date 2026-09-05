import {
  normalizeNotebookFilePath,
  readStoredNotebookOpenFilePath,
} from '@/app/lib/files/notebook-open-file-storage';

export const NOTEBOOK_MAX_OPEN_DOCUMENTS = 100;
export const NOTEBOOK_DOCUMENT_TABS_STORAGE_VERSION = 1;

const NOTEBOOK_DOCUMENT_TABS_STORAGE_KEY = 'canvas.notebookDocumentTabs.v1';

export type NotebookDocumentTabsState = {
  activePath: string | null;
  openPaths: string[];
};

export type OpenNotebookDocumentTabResult = {
  state: NotebookDocumentTabsState;
  status: 'activated' | 'limit-reached' | 'opened';
};

type StoredNotebookDocumentTabs = {
  activePath: string | null;
  openPaths: string[];
  version: typeof NOTEBOOK_DOCUMENT_TABS_STORAGE_VERSION;
};

export function emptyNotebookDocumentTabsState(): NotebookDocumentTabsState {
  return {
    activePath: null,
    openPaths: [],
  };
}

export function notebookDocumentTabsStorageKey(workspaceId: string) {
  return `${NOTEBOOK_DOCUMENT_TABS_STORAGE_KEY}:${workspaceId}`;
}

function normalizeOpenPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];

  const normalizedPaths: string[] = [];
  for (const candidate of paths) {
    if (typeof candidate !== 'string') continue;
    const path = normalizeNotebookFilePath(candidate);
    if (!path || normalizedPaths.includes(path)) continue;
    normalizedPaths.push(path);
    if (normalizedPaths.length === NOTEBOOK_MAX_OPEN_DOCUMENTS) break;
  }
  return normalizedPaths;
}

export function normalizeNotebookDocumentTabsState(input: {
  activePath?: unknown;
  openPaths?: unknown;
}): NotebookDocumentTabsState {
  const openPaths = normalizeOpenPaths(input.openPaths);
  const requestedActivePath = typeof input.activePath === 'string'
    ? normalizeNotebookFilePath(input.activePath)
    : null;

  return {
    openPaths,
    activePath: requestedActivePath && openPaths.includes(requestedActivePath)
      ? requestedActivePath
      : openPaths.at(-1) ?? null,
  };
}

export function openNotebookDocumentTab(
  state: NotebookDocumentTabsState,
  path: string,
): OpenNotebookDocumentTabResult {
  const normalizedPath = normalizeNotebookFilePath(path);
  if (!normalizedPath) {
    return { state, status: 'limit-reached' };
  }

  if (state.openPaths.includes(normalizedPath)) {
    return {
      status: 'activated',
      state: state.activePath === normalizedPath
        ? state
        : { ...state, activePath: normalizedPath },
    };
  }

  if (state.openPaths.length >= NOTEBOOK_MAX_OPEN_DOCUMENTS) {
    return { status: 'limit-reached', state };
  }

  return {
    status: 'opened',
    state: {
      activePath: normalizedPath,
      openPaths: [...state.openPaths, normalizedPath],
    },
  };
}

export function activateNotebookDocumentTab(
  state: NotebookDocumentTabsState,
  path: string,
): NotebookDocumentTabsState {
  const normalizedPath = normalizeNotebookFilePath(path);
  if (!normalizedPath || !state.openPaths.includes(normalizedPath)) return state;
  return state.activePath === normalizedPath
    ? state
    : { ...state, activePath: normalizedPath };
}

export function closeNotebookDocumentTab(
  state: NotebookDocumentTabsState,
  path: string,
): NotebookDocumentTabsState {
  const normalizedPath = normalizeNotebookFilePath(path);
  if (!normalizedPath) return state;
  const closedIndex = state.openPaths.indexOf(normalizedPath);
  if (closedIndex < 0) return state;

  const openPaths = state.openPaths.filter((openPath) => openPath !== normalizedPath);
  if (state.activePath !== normalizedPath) {
    return { ...state, openPaths };
  }

  return {
    openPaths,
    // Prefer the former right-hand neighbor, then the left-hand neighbor.
    activePath: openPaths[closedIndex] ?? openPaths[closedIndex - 1] ?? null,
  };
}

export function closeNotebookDocumentTabsAtPaths(
  state: NotebookDocumentTabsState,
  paths: Iterable<string>,
): NotebookDocumentTabsState {
  const closedPaths = new Set(normalizeOpenPaths(Array.from(paths)));
  if (closedPaths.size === 0) return state;

  const shouldClose = (openPath: string) => Array.from(closedPaths).some((closedPath) => (
    openPath === closedPath || openPath.startsWith(`${closedPath}/`)
  ));

  let nextState = state;
  for (const openPath of state.openPaths.filter(shouldClose)) {
    nextState = closeNotebookDocumentTab(nextState, openPath);
  }
  return nextState;
}

export function renameNotebookDocumentTabs(
  state: NotebookDocumentTabsState,
  oldPath: string,
  newPath: string,
): NotebookDocumentTabsState {
  const normalizedOldPath = normalizeNotebookFilePath(oldPath);
  const normalizedNewPath = normalizeNotebookFilePath(newPath);
  if (!normalizedOldPath || !normalizedNewPath) return state;

  const remapPath = (path: string) => {
    if (path === normalizedOldPath) return normalizedNewPath;
    if (path.startsWith(`${normalizedOldPath}/`)) {
      return `${normalizedNewPath}${path.slice(normalizedOldPath.length)}`;
    }
    return path;
  };
  const openPaths = normalizeOpenPaths(state.openPaths.map(remapPath));
  const activePath = state.activePath ? remapPath(state.activePath) : null;
  return normalizeNotebookDocumentTabsState({ activePath, openPaths });
}

export function readNotebookDocumentTabs(
  storage: Storage,
  workspaceId: string,
): NotebookDocumentTabsState {
  const stored = storage.getItem(notebookDocumentTabsStorageKey(workspaceId));
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<StoredNotebookDocumentTabs>;
      if (parsed.version === NOTEBOOK_DOCUMENT_TABS_STORAGE_VERSION) {
        return normalizeNotebookDocumentTabsState(parsed);
      }
    } catch {
      // Fall back to the legacy single-document preference below.
    }
  }

  const legacyActivePath = readStoredNotebookOpenFilePath(storage, workspaceId);
  return legacyActivePath
    ? { activePath: legacyActivePath, openPaths: [legacyActivePath] }
    : emptyNotebookDocumentTabsState();
}

export function writeNotebookDocumentTabs(
  storage: Storage,
  workspaceId: string,
  state: NotebookDocumentTabsState,
) {
  const normalizedState = normalizeNotebookDocumentTabsState(state);
  storage.setItem(notebookDocumentTabsStorageKey(workspaceId), JSON.stringify({
    ...normalizedState,
    version: NOTEBOOK_DOCUMENT_TABS_STORAGE_VERSION,
  } satisfies StoredNotebookDocumentTabs));
}

/** The strip stays compact; the menu retains every document, including the active one. */
export function visibleNotebookDocumentPaths(state: NotebookDocumentTabsState, limit = 8): string[] {
  const visible = state.openPaths.slice(0, limit);
  if (state.activePath && !visible.includes(state.activePath)) {
    return [...visible.slice(0, limit - 1), state.activePath];
  }
  return visible;
}

export function notebookDocumentLabel(path: string, openPaths: string[]): string {
  const name = path.split('/').pop() || path;
  return openPaths.some((other) => other !== path && other.split('/').pop() === name)
    ? path : name;
}
