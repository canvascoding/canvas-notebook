import { create } from 'zustand';
import type {
  BrowserMode,
  CurrentFile,
  FileLoadResult,
  FileNode,
  FileStats,
  OpenWorkspaceFileOptions,
  OpenWorkspaceFileResult,
  WorkspaceFileOpenCompletion,
} from '@/app/lib/files/types';
import {
  getExtension,
  getParentDirectories,
  getParentDirectory,
  isSameOrDescendantPath,
  normalizeWorkspacePathParam,
  remapDescendantPath,
} from '@/app/lib/files/path-utils';
import { runDirectoryTasksByDepth } from '@/app/lib/files/tree-refresh';
import {
  findNodeInTree,
  clearUnrefreshedDirectoryChildren,
  clearDirectoryChildren,
  getDirectoryDirectChildPaths,
  getExpandedDescendantDirectories,
  getSelectionRangePaths,
  getTreeSelectionRangePaths,
  getVisibleTreeRefreshDirectories,
  hasRefreshParentInTree,
  mergeRootNodesPreservingChildren,
  mergeSubtreeChildren,
  remapExpandedDirectories,
} from '@/app/lib/files/tree-utils';
import {
  type CopyWorkspacePathsResult,
  type DeleteWorkspacePathsResult,
  copyWorkspacePaths,
  createWorkspacePath,
  deleteWorkspacePaths,
  loadWorkspaceTree,
  readApiError,
  readWorkspaceFile,
  renameWorkspacePath,
  triggerWorkspaceDownload,
  uploadWorkspaceFiles,
  WorkspaceBatchUploadError,
  type WorkspaceUploadFileProgress,
  writeWorkspaceFile,
} from '@/app/lib/files/client';
import { compactWorkspaceSelection } from '@/app/lib/files/operation-flows';
import type { FileSortDirection, FileSortKey } from '@/app/lib/files/sort';
import { useEditorStore } from '@/app/store/editor-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { invalidateWorkspaceLinkIndexCache } from '@/app/lib/markdown/workspace-link-index-client';
import {
  notifyWorkspacePathRenamed,
  notifyWorkspacePathsDeleted,
} from '@/app/lib/files/workspace-file-events';
import { getDocumentTransitionGuard } from '@/app/lib/files/document-transition';
import { checkNotebookDocumentOpen } from '@/app/lib/notebook/document-tab-open-guard';

export type {
  BrowserMode,
  CurrentFile,
  FileLoadResult,
  FileNode,
  FileStats,
  OpenWorkspaceFileOptions,
  OpenWorkspaceFileResult,
  WorkspaceFileOpenCompletion,
} from '@/app/lib/files/types';
export { findPathInTree } from '@/app/lib/files/tree-utils';

export interface ContextMenuPosition {
  x: number;
  y: number;
}

const TEXT_EXTENSIONS = new Set([
  'txt',
  'log',
  'js',
  'jsx',
  'ts',
  'tsx',
  'json',
  'css',
  'scss',
  'html',
  'yml',
  'yaml',
  'md',
  'mdx',
  'markdown',
  'env',
  'gitignore',
  'sh',
  'bash',
  'zsh',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'php',
  'sql',
  'toml',
  'excalidraw',
]);

const EXPLORER_STATE_STORAGE_KEY = 'canvas.fileExplorerState';
const saveFileQueues = new Map<string, Promise<void>>();
let fileRefreshRequestId = 0;
const subdirectoryLoadPromises = new Map<string, { noCache: boolean; promise: Promise<void> }>();
const DEFAULT_TREE_DEPTH = 0;
const SUBDIRECTORY_TREE_DEPTH = 0;

interface StoredExplorerState {
  currentDirectory?: string;
  expandedDirs?: string[];
}

function explorerStateStorageKey(workspaceId?: string | null): string {
  return `${EXPLORER_STATE_STORAGE_KEY}:${workspaceId ?? 'legacy'}`;
}

function readStoredExplorerState(workspaceId?: string | null): StoredExplorerState {
  if (typeof window === 'undefined') return {};

  try {
    const stored = window.localStorage.getItem(explorerStateStorageKey(workspaceId))
      ?? window.localStorage.getItem(EXPLORER_STATE_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as StoredExplorerState;
    return {
      currentDirectory: typeof parsed.currentDirectory === 'string' && parsed.currentDirectory.trim()
        ? parsed.currentDirectory
        : undefined,
      expandedDirs: Array.isArray(parsed.expandedDirs)
        ? parsed.expandedDirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0)
        : undefined,
    };
  } catch {
    return {};
  }
}

function persistExplorerState(
  nextState: Pick<FileStoreState, 'currentDirectory' | 'expandedDirs'>,
  workspaceId: string | null = useWorkspaceStore.getState().activeWorkspaceId,
) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      explorerStateStorageKey(workspaceId),
      JSON.stringify({
        currentDirectory: nextState.currentDirectory,
        expandedDirs: Array.from(nextState.expandedDirs),
      })
    );
  } catch {
    // Non-critical: explorer state can fall back to in-memory Zustand state.
  }
}

function enqueueFileSave(workspaceId: string | null, path: string, operation: () => Promise<void>): Promise<void> {
  const queueKey = `${workspaceId ?? 'legacy'}\0${path}`;
  const previousSave = saveFileQueues.get(queueKey) ?? Promise.resolve();
  const currentSave = previousSave.catch(() => undefined).then(operation);
  const queueTail = currentSave.catch(() => undefined);

  saveFileQueues.set(queueKey, queueTail);
  void queueTail.finally(() => {
    if (saveFileQueues.get(queueKey) === queueTail) {
      saveFileQueues.delete(queueKey);
    }
  });

  return currentSave;
}

function readClientBrowserMode(): BrowserMode {
  if (typeof window === 'undefined') return 'tree';
  const stored = window.localStorage.getItem('canvas-browser-mode');
  if (stored === 'tree' || stored === 'list' || stored === 'grid') return stored;
  return window.innerWidth < 768 ? 'list' : 'tree';
}

function readClientFileSort(): { sortKey: FileSortKey; sortDirection: FileSortDirection } {
  if (typeof window === 'undefined') return { sortKey: 'name', sortDirection: 'asc' };
  const storedKey = window.localStorage.getItem('canvas-file-sort-key');
  const storedDirection = window.localStorage.getItem('canvas-file-sort-direction');
  const sortKey: FileSortKey = storedKey === 'title' || storedKey === 'type' || storedKey === 'created'
    || storedKey === 'modified' || storedKey === 'size' || storedKey === 'favorite' || storedKey === 'pinned'
    ? storedKey
    : 'name';
  const sortDirection: FileSortDirection = storedDirection === 'desc' ? 'desc' : 'asc';
  return { sortKey, sortDirection };
}

function areFileStatsEqual(left?: FileStats, right?: FileStats) {
  return (
    left?.size === right?.size &&
    left?.modified === right?.modified &&
    left?.permissions === right?.permissions &&
    left?.sha256 === right?.sha256
  );
}

function updateFileRevision(
  revisions: Record<string, string>,
  filePath: string,
  stats?: FileStats,
): Record<string, string> {
  if (!stats?.sha256 || revisions[filePath] === stats.sha256) return revisions;
  return {
    ...revisions,
    [filePath]: stats.sha256,
  };
}

function removeFileRevisions(
  revisions: Record<string, string>,
  paths: string[],
): Record<string, string> {
  const entries = Object.entries(revisions).filter(([filePath]) => (
    !paths.some((removedPath) => isSameOrDescendantPath(filePath, removedPath))
  ));
  return entries.length === Object.keys(revisions).length ? revisions : Object.fromEntries(entries);
}

function remapFileRevisions(
  revisions: Record<string, string>,
  oldPath: string,
  newPath: string,
): Record<string, string> {
  let changed = false;
  const remapped = Object.fromEntries(
    Object.entries(revisions).map(([filePath, sha256]) => {
      if (!isSameOrDescendantPath(filePath, oldPath)) return [filePath, sha256];
      changed = true;
      return [remapDescendantPath(filePath, oldPath, newPath), sha256];
    }),
  );
  return changed ? remapped : revisions;
}

interface FileStoreState {
  // File tree
  fileTree: FileNode[];
  fileTreeWorkspaceId: string | null;
  treeGeneration: number;
  rootTreeRequestId: number;
  isLoadingTree: boolean;
  treeError: string | null;
  directoryErrors: Record<string, string>;

  // Selection
  selectedNode: FileNode | null;

  // Current file
  currentFile: CurrentFile | null;
  currentFileWorkspaceId: string | null;
  isLoadingFile: boolean;
  loadingFilePath: string | null;
  fileLoadRequestId: number;
  openFileRequestId: number;
  fileError: string | null;
  fileErrorPath: string | null;
  missingFilePath: string | null;
  fileRevisions: Record<string, string>;

  // Browser mode
  browserMode: BrowserMode;
  setBrowserMode: (mode: BrowserMode) => void;
  fileSortKey: FileSortKey;
  fileSortDirection: FileSortDirection;
  setFileSort: (sortKey: FileSortKey) => void;
  clientPreferencesHydratedFor: string | null | undefined;
  hydrateClientPreferences: (workspaceId?: string | null, force?: boolean) => void;

  // Expanded directories
  expandedDirs: Set<string>;
  currentDirectory: string;
  setExpandedDirs: (dirs: Set<string>) => void;
  uploadProgress: number | null;
  uploadItems: WorkspaceUploadFileProgress[];
  searchQuery: string;
  loadingDirs: Set<string>;

  // Multi-select
  isMultiSelectMode: boolean;
  multiSelectPaths: Set<string>;
  lastSelectedPath: string | null;

  // Context menu
  contextMenuNode: FileNode | null;
  contextMenuPosition: ContextMenuPosition | null;
  isContextMenuOpen: boolean;
  contextMenuRequestId: number;
  openContextMenu: (node: FileNode, position: ContextMenuPosition) => void;
  closeContextMenu: () => void;

  // Background context menu (for empty space)
  backgroundContextMenuPosition: ContextMenuPosition | null;
  backgroundContextMenuDirectory: string;
  isBackgroundContextMenuOpen: boolean;
  backgroundContextMenuRequestId: number;
  openBackgroundContextMenu: (position: ContextMenuPosition, directory: string) => void;
  closeBackgroundContextMenu: () => void;

  // Mobile UI state
  mobileSurface: 'files' | 'editor' | null;
  mobileFileOpenedCount: number;
  lastMobileFileOpen: WorkspaceFileOpenCompletion | null;
  setMobileSurface: (surface: 'files' | 'editor' | null) => void;
  mobileFileOpened: (path: string, transitionId?: string) => void;

  // Bulk move dialog state
  bulkMoveOpen: boolean;
  setBulkMoveOpen: (open: boolean) => void;

  // Clipboard state for copy/paste
  clipboardPaths: Set<string>;
  clipboardMode: 'copy' | null;
  copyPaths: (paths?: Iterable<string>) => void;
  pastePaths: (destDir: string) => Promise<CopyWorkspacePathsResult | null>;
  duplicatePath: (path: string) => Promise<void>;

  // Actions
  ensureTreeWorkspace: (workspaceId: string | null) => number;
  loadFileTree: (path?: string, depth?: number, noCache?: boolean, workspaceId?: string | null) => Promise<void>;
  refreshRootTree: (noCache?: boolean, workspaceId?: string | null) => Promise<void>;
  refreshDirectory: (dirPath: string, noCache?: boolean, workspaceId?: string | null) => Promise<void>;
  refreshVisibleTree: () => Promise<void>;
  loadSubdirectory: (dirPath: string, noCache?: boolean, expand?: boolean, workspaceId?: string | null) => Promise<void>;
  loadFile: (path: string, noCache?: boolean, workspaceId?: string | null) => Promise<FileLoadResult>;
  refreshCurrentFileContent: (path: string) => Promise<CurrentFile | null>;
  revealAndLoadFile: (path: string, options?: OpenWorkspaceFileOptions) => Promise<OpenWorkspaceFileResult>;
  closeFile: (path: string) => Promise<boolean>;
  prepareCurrentFileForTransition: () => Promise<void>;
  saveFile: (path: string, content: string, workspaceId?: string | null) => Promise<void>;
  selectNode: (
    node: FileNode,
    ctrlOrMeta?: boolean,
    shiftKey?: boolean,
    selectionOrder?: string[],
    preserveCurrentDirectory?: boolean,
  ) => void;
  createPath: (path: string, type: 'file' | 'directory', options?: { template?: 'excalidraw' }) => Promise<void>;
  deletePath: (path: string | string[]) => Promise<DeleteWorkspacePathsResult>;
  renamePath: (oldPath: string, newPath: string, overwrite?: boolean, refreshTree?: boolean) => Promise<void>;
  uploadFile: (
    file: File | File[],
    targetDir: string,
    pathMap?: Map<File, string>,
    convertParams?: (import('@/app/components/shared/ImagePreprocessDialog').ConvertParams | null)[],
    options?: { refreshTree?: boolean },
  ) => Promise<void>;
  downloadFile: (path: string) => Promise<void>;
  toggleDirectory: (path: string) => void;
  collapseAllDirectories: () => void;
  clearCurrentFile: () => void;
  resetWorkspaceView: (workspaceId?: string | null) => void;
  setSearchQuery: (query: string) => void;
  setCurrentDirectory: (path: string) => void;
  markDirectoryStale: (path: string) => void;
  clearMultiSelect: () => void;
  toggleMultiSelectMode: () => void;
  setMultiSelectPaths: (paths: Iterable<string>, activateMode?: boolean) => void;
  toggleMultiSelectPath: (path: string) => void;
  setLastSelectedPath: (path: string | null) => void;
  selectRange: (startPath: string, endPath: string, currentTree: FileNode[]) => void;
  selectAllInDirectory: (dirPath: string) => void;
}

export const useFileStore = create<FileStoreState>((set, get) => ({
  // Initial state
  fileTree: [],
  fileTreeWorkspaceId: null,
  treeGeneration: 0,
  rootTreeRequestId: 0,
  isLoadingTree: false,
  treeError: null,
  directoryErrors: {},

  selectedNode: null,

  currentFile: null,
  currentFileWorkspaceId: null,
  fileRevisions: {},

  browserMode: 'tree',
  fileSortKey: 'name',
  fileSortDirection: 'asc',
  clientPreferencesHydratedFor: undefined,
  setBrowserMode: (mode: BrowserMode) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('canvas-browser-mode', mode);
    }
    set({ browserMode: mode });
  },
  setFileSort: (sortKey: FileSortKey) => {
    set((state) => {
      const fileSortDirection = state.fileSortKey === sortKey
        ? (state.fileSortDirection === 'asc' ? 'desc' : 'asc')
        : (sortKey === 'created' || sortKey === 'modified' || sortKey === 'pinned' ? 'desc' : 'asc');
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('canvas-file-sort-key', sortKey);
        window.localStorage.setItem('canvas-file-sort-direction', fileSortDirection);
      }
      return { fileSortKey: sortKey, fileSortDirection };
    });
  },
  hydrateClientPreferences: (workspaceId, force = false) => {
    const resolvedWorkspaceId = workspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : workspaceId;
    if (!force && get().clientPreferencesHydratedFor === resolvedWorkspaceId) return;

    const storedExplorerState = readStoredExplorerState(resolvedWorkspaceId);
    const storedSort = readClientFileSort();
    set({
      browserMode: readClientBrowserMode(),
      fileSortKey: storedSort.sortKey,
      fileSortDirection: storedSort.sortDirection,
      currentDirectory: storedExplorerState.currentDirectory ?? '.',
      expandedDirs: new Set<string>(storedExplorerState.expandedDirs ?? []),
      clientPreferencesHydratedFor: resolvedWorkspaceId,
    });
  },
  isLoadingFile: false,
  loadingFilePath: null,
  fileLoadRequestId: 0,
  openFileRequestId: 0,
  fileError: null,
  fileErrorPath: null,
  missingFilePath: null,

  expandedDirs: new Set<string>(),
  currentDirectory: '.',
  setExpandedDirs: (dirs: Set<string>) => {
    set((state) => {
      if (state.expandedDirs.size === dirs.size && [...state.expandedDirs].every(d => dirs.has(d))) {
        return {};
      }
      const next = new Set(dirs);
      const nextState = { ...state, expandedDirs: next };
      persistExplorerState(nextState);
      return { expandedDirs: next };
    });
  },
  uploadProgress: null,
  uploadItems: [],
  searchQuery: '',
  loadingDirs: new Set<string>(),

  // Multi-select state
  isMultiSelectMode: false,
  multiSelectPaths: new Set<string>(),
  lastSelectedPath: null,

  // Context menu state
  contextMenuNode: null,
  contextMenuPosition: null,
  isContextMenuOpen: false,
  contextMenuRequestId: 0,
  openContextMenu: (node: FileNode, position: ContextMenuPosition) => {
    set((state) => ({
      contextMenuNode: node,
      contextMenuPosition: position,
      isContextMenuOpen: true,
      contextMenuRequestId: state.contextMenuRequestId + 1,
    }));
  },
  closeContextMenu: () => {
    set({
      isContextMenuOpen: false,
    });
  },

  // Background context menu state
  backgroundContextMenuPosition: null,
  backgroundContextMenuDirectory: '.',
  isBackgroundContextMenuOpen: false,
  backgroundContextMenuRequestId: 0,
  openBackgroundContextMenu: (position: ContextMenuPosition, directory: string) => {
    set((state) => ({
      backgroundContextMenuPosition: position,
      backgroundContextMenuDirectory: directory,
      isBackgroundContextMenuOpen: true,
      backgroundContextMenuRequestId: state.backgroundContextMenuRequestId + 1,
    }));
  },
  closeBackgroundContextMenu: () => {
    set({
      isBackgroundContextMenuOpen: false,
    });
  },

  // Mobile UI state
  mobileSurface: null,
  mobileFileOpenedCount: 0,
  lastMobileFileOpen: null,
  setMobileSurface: (surface: 'files' | 'editor' | null) => {
    set({ mobileSurface: surface });
  },
  mobileFileOpened: (path: string, transitionId?: string) => {
    set((state) => {
      const sequence = state.mobileFileOpenedCount + 1;
      return {
        mobileSurface: 'editor',
        mobileFileOpenedCount: sequence,
        lastMobileFileOpen: {
          sequence,
          path,
          transitionId: transitionId || null,
        },
      };
    });
  },

  // Bulk move dialog state
  bulkMoveOpen: false,
  setBulkMoveOpen: (open: boolean) => {
    set({ bulkMoveOpen: open });
  },

  // Clipboard state
  clipboardPaths: new Set<string>(),
  clipboardMode: null,
  copyPaths: (paths?: Iterable<string>) => {
    if (paths) {
      set({ clipboardPaths: new Set(compactWorkspaceSelection(paths)), clipboardMode: 'copy' });
      return;
    }

    const { multiSelectPaths, selectedNode, isMultiSelectMode } = get();
    if (isMultiSelectMode && multiSelectPaths.size > 0) {
      set({ clipboardPaths: new Set(compactWorkspaceSelection(multiSelectPaths)), clipboardMode: 'copy' });
    } else if (selectedNode) {
      set({ clipboardPaths: new Set([selectedNode.path]), clipboardMode: 'copy' });
    }
  },
  pastePaths: async (destDir: string) => {
    const { clipboardPaths, clipboardMode } = get();
    if (clipboardMode !== 'copy' || clipboardPaths.size === 0) return null;
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;

    try {
      const result = await copyWorkspacePaths({
        sources: compactWorkspaceSelection(clipboardPaths),
        destDir,
        overwrite: false,
      }, 'Failed to paste files');

      if (result.copied.length > 0 && useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        await get().refreshDirectory(destDir, true);
      }
      return result;
    } catch (error) {
      throw error;
    }
  },
  duplicatePath: async (path: string) => {
    const parentDir = getParentDirectory(path);
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;

    try {
      await copyWorkspacePaths({
        sources: [path],
        destDir: parentDir,
        overwrite: false,
        renameOnCollision: true,
      }, 'Failed to duplicate file');

      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        await get().refreshDirectory(parentDir, true, workspaceId);
      }
    } catch (error) {
      throw error;
    }
  },

  // Actions
  ensureTreeWorkspace: (workspaceId) => {
    const state = get();
    if (state.fileTreeWorkspaceId === workspaceId) return state.treeGeneration;

    const treeGeneration = state.treeGeneration + 1;
    subdirectoryLoadPromises.clear();
    set({
      fileTree: [],
      fileTreeWorkspaceId: workspaceId,
      treeGeneration,
      rootTreeRequestId: state.rootTreeRequestId + 1,
      isLoadingTree: false,
      treeError: null,
      directoryErrors: {},
      loadingDirs: new Set<string>(),
    });
    return treeGeneration;
  },

  loadFileTree: async (path = '.', depth?: number, noCache = false, requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : requestedWorkspaceId;
    const treeGeneration = get().ensureTreeWorkspace(workspaceId);
    const requestId = get().rootTreeRequestId + 1;
    set({ rootTreeRequestId: requestId, isLoadingTree: true, treeError: null });

    const depthTarget = typeof depth === 'number' ? depth : DEFAULT_TREE_DEPTH;

    try {
      const data = await loadWorkspaceTree(path, depthTarget, noCache, 'Failed to load file tree', workspaceId, {
        includeStats: false,
      });
      const state = get();
      if (
        state.fileTreeWorkspaceId !== workspaceId ||
        state.treeGeneration !== treeGeneration ||
        state.rootTreeRequestId !== requestId
      ) {
        return;
      }

      const fileTree = path === '.' && depthTarget === 0
        ? mergeRootNodesPreservingChildren(data, state.fileTree)
        : data;
      set({ fileTree, isLoadingTree: false });
    } catch (error) {
      const state = get();
      if (
        state.fileTreeWorkspaceId !== workspaceId ||
        state.treeGeneration !== treeGeneration ||
        state.rootTreeRequestId !== requestId
      ) {
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Failed to load file tree';
      set({
        treeError: message,
        isLoadingTree: false,
      });
    }
  },

  refreshRootTree: async (noCache = false, requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : requestedWorkspaceId;
    const treeGeneration = get().ensureTreeWorkspace(workspaceId);
    const requestId = get().rootTreeRequestId + 1;
    set({ rootTreeRequestId: requestId, treeError: null });

    try {
      const data = await loadWorkspaceTree('.', 0, noCache, 'Failed to refresh root tree', workspaceId, {
        includeStats: false,
      });
      const state = get();
      if (
        state.fileTreeWorkspaceId !== workspaceId ||
        state.treeGeneration !== treeGeneration ||
        state.rootTreeRequestId !== requestId
      ) {
        return;
      }

      // Merge: preserve existing children from current tree so expanded
      // folders don't appear empty after a root-level refresh (depth=0).
      const mergedTree = mergeRootNodesPreservingChildren(data, state.fileTree);

      set({ fileTree: mergedTree, isLoadingTree: false });
    } catch (error) {
      const state = get();
      if (
        state.fileTreeWorkspaceId !== workspaceId ||
        state.treeGeneration !== treeGeneration ||
        state.rootTreeRequestId !== requestId
      ) {
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Failed to refresh root tree';
      set({ treeError: message, isLoadingTree: false });
    }
  },

  refreshDirectory: async (dirPath: string, noCache = false, workspaceId?: string | null) => {
    if (dirPath === '.') {
      await get().refreshRootTree(noCache, workspaceId);
      return;
    }

    await get().loadSubdirectory(dirPath, noCache, true, workspaceId);
  },

  refreshVisibleTree: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const { browserMode, currentDirectory, expandedDirs } = get();
    await get().refreshRootTree(true, workspaceId);
    if (get().fileTreeWorkspaceId !== workspaceId) return;

    const dirsToRefresh = getVisibleTreeRefreshDirectories(currentDirectory, expandedDirs, browserMode === 'tree');
    await runDirectoryTasksByDepth(dirsToRefresh, async (dirPath) => {
      if (hasRefreshParentInTree(get().fileTree, dirPath)) {
        await get().refreshDirectory(dirPath, true, workspaceId);
      }
    });

    if (get().fileTreeWorkspaceId !== workspaceId) return;

    const refreshedDirectories = new Set(dirsToRefresh);
    set((state) => ({
      fileTree: clearUnrefreshedDirectoryChildren(state.fileTree, refreshedDirectories),
    }));
  },

  loadSubdirectory: async (dirPath: string, noCache = false, expand = true, requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : requestedWorkspaceId;
    if (dirPath === '.') {
      await get().refreshRootTree(noCache, workspaceId);
      return;
    }

    const treeGeneration = get().ensureTreeWorkspace(workspaceId);
    const loadKey = `${workspaceId ?? 'legacy'}\0${dirPath}`;
    const inFlight = subdirectoryLoadPromises.get(loadKey);
    if (inFlight) {
      const { expandedDirs } = get();
      if (expand && !expandedDirs.has(dirPath)) {
        const newExpanded = new Set(expandedDirs);
        newExpanded.add(dirPath);
        get().setExpandedDirs(newExpanded);
      }
      await inFlight.promise;
      if (noCache && !inFlight.noCache && get().fileTreeWorkspaceId === workspaceId) {
        await get().loadSubdirectory(dirPath, true, expand, workspaceId);
      }
      return;
    }

    const { expandedDirs, fileTree } = get();
    const existingNode = findNodeInTree(dirPath, fileTree);
    if (!noCache && existingNode && Array.isArray(existingNode.children)) {
      if (expand && !expandedDirs.has(dirPath)) {
        const newExpanded = new Set(expandedDirs);
        newExpanded.add(dirPath);
        get().setExpandedDirs(newExpanded);
      }
      return;
    }

    if (expand && !expandedDirs.has(dirPath)) {
      const newExpanded = new Set(expandedDirs);
      newExpanded.add(dirPath);
      get().setExpandedDirs(newExpanded);
    }

    const newLoading = new Set(get().loadingDirs);
    newLoading.add(dirPath);
    const nextDirectoryErrors = { ...get().directoryErrors };
    delete nextDirectoryErrors[dirPath];
    set({ loadingDirs: newLoading, directoryErrors: nextDirectoryErrors });

    const promise = (async () => {
      try {
        const data = await loadWorkspaceTree(
          dirPath,
          SUBDIRECTORY_TREE_DEPTH,
          noCache,
          'Failed to load subdirectory',
          workspaceId,
          { includeStats: false },
        );

        const state = get();
        if (state.fileTreeWorkspaceId !== workspaceId || state.treeGeneration !== treeGeneration) return;

        const nextLoading = new Set(state.loadingDirs);
        nextLoading.delete(dirPath);
        const errors = { ...state.directoryErrors };
        delete errors[dirPath];
        set({
          fileTree: mergeSubtreeChildren(state.fileTree, dirPath, data),
          loadingDirs: nextLoading,
          directoryErrors: errors,
        });
      } catch (error) {
        const state = get();
        if (state.fileTreeWorkspaceId !== workspaceId || state.treeGeneration !== treeGeneration) return;

        const nextLoading = new Set(state.loadingDirs);
        nextLoading.delete(dirPath);
        const message = error instanceof Error ? error.message : 'Failed to load subdirectory';
        set({
          loadingDirs: nextLoading,
          directoryErrors: { ...state.directoryErrors, [dirPath]: message },
        });
        console.error('Failed to load subdirectory:', error);
      }
    })();

    subdirectoryLoadPromises.set(loadKey, { noCache, promise });
    try {
      await promise;
    } finally {
      if (subdirectoryLoadPromises.get(loadKey)?.promise === promise) {
        subdirectoryLoadPromises.delete(loadKey);
      }
    }
  },

  loadFile: async (path: string, noCache = false, requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : requestedWorkspaceId;
    const requestId = get().fileLoadRequestId + 1;
    set({
      fileLoadRequestId: requestId,
      isLoadingFile: true,
      loadingFilePath: path,
      fileError: null,
      fileErrorPath: null,
      missingFilePath: null,
    });

    try {
      const extension = getExtension(path);
      const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
      const useMetaOnly = !isText;

      const data = await readWorkspaceFile(path, { metaOnly: useMetaOnly, noCache, workspaceId });
      if (
        get().fileLoadRequestId !== requestId ||
        useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
      ) {
        return { status: 'superseded', path };
      }

      const latestEditor = useEditorStore.getState();
      if (latestEditor.isDirty && latestEditor.activePath && latestEditor.activePath !== path) {
        throw new Error('The current file changed while loading. Please save it and retry.');
      }
      const fileName = path.split('/').pop() || path;
      const loadedFile: CurrentFile = {
        path,
        content: data.content,
        stats: data.stats,
        revision: data.revision ?? data.collaboration?.latestRevision ?? null,
        collaboration: data.collaboration ?? null,
      };
      set((state) => ({
        selectedNode: { path, type: 'file', name: fileName },
        currentFile: loadedFile,
        currentFileWorkspaceId: workspaceId,
        isLoadingFile: false,
        loadingFilePath: null,
        fileError: null,
        fileErrorPath: null,
        fileRevisions: updateFileRevision(state.fileRevisions, path, data.stats),
      }));
      return { status: 'loaded', path, file: loadedFile };
    } catch (error) {
      if (
        get().fileLoadRequestId !== requestId ||
        useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
      ) {
        return { status: 'superseded', path };
      }

      if (error instanceof Response && error.status === 404) {
        const message = 'File not found';
        set((state) => {
          const shouldClearCurrentFile =
            !state.currentFile ||
            state.currentFile.path === path ||
            state.currentFileWorkspaceId !== workspaceId;
          return {
            ...(shouldClearCurrentFile
              ? {
                  currentFile: null,
                  currentFileWorkspaceId: null,
                  selectedNode: state.selectedNode?.path === path ? null : state.selectedNode,
                }
              : {}),
            isLoadingFile: false,
            loadingFilePath: null,
            fileError: null,
            fileErrorPath: null,
            missingFilePath: path,
          };
        });
        return { status: 'missing', path, error: message };
      }
      const message =
        error instanceof Response
          ? await readApiError(error, 'Failed to load file')
          : error instanceof Error ? error.message : 'Failed to load file';
      if (
        get().fileLoadRequestId !== requestId ||
        useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
      ) {
        return { status: 'superseded', path };
      }
      set({
        fileError: message,
        fileErrorPath: path,
        missingFilePath: null,
        isLoadingFile: false,
        loadingFilePath: null,
      });
      return { status: 'failed', path, error: message };
    }
  },

  refreshCurrentFileContent: async (path: string) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (get().currentFile?.path !== path || get().currentFileWorkspaceId !== workspaceId) {
      return null;
    }

    const extension = getExtension(path);
    const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
    if (!isText) {
      return null;
    }

    const requestId = ++fileRefreshRequestId;
    const originalFile = get().currentFile;
    const loadRequestId = get().fileLoadRequestId;
    const openRequestId = get().openFileRequestId;
    const isCurrent = () => (
      fileRefreshRequestId === requestId
      && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
      && get().currentFileWorkspaceId === workspaceId
      && get().currentFile === originalFile
      && get().fileLoadRequestId === loadRequestId
      && get().openFileRequestId === openRequestId
    );

    try {
      const data = await readWorkspaceFile(path, {
        noCache: true,
        fallbackMessage: 'Failed to refresh file',
        workspaceId,
      });
      if (!isCurrent()) {
        return null;
      }
      const currentFile = get().currentFile;
      if (currentFile?.path !== path) {
        return null;
      }

      const refreshedFile: CurrentFile = {
        ...currentFile,
        content: data.content,
        stats: data.stats,
        revision: data.revision ?? data.collaboration?.latestRevision ?? currentFile.revision ?? null,
        collaboration: data.collaboration ?? currentFile.collaboration ?? null,
      };
      const nextFileRevisions = updateFileRevision(get().fileRevisions, path, data.stats);

      if (
        currentFile.content !== refreshedFile.content ||
        !areFileStatsEqual(currentFile.stats, refreshedFile.stats) ||
        nextFileRevisions !== get().fileRevisions
      ) {
        set({
          currentFile: refreshedFile,
          fileError: null,
          fileErrorPath: null,
          missingFilePath: null,
          fileRevisions: nextFileRevisions,
        });
      }

      return refreshedFile;
    } catch (error) {
      if (!isCurrent()) return null;
      if (error instanceof Response && error.status === 404 && get().currentFile?.path === path) {
        set((state) => ({
          selectedNode: state.selectedNode?.path === path ? null : state.selectedNode,
          currentFile: null,
          currentFileWorkspaceId: null,
          fileError: null,
          fileErrorPath: null,
          missingFilePath: path,
        }));
        return null;
      }
      console.warn('[FileStore] Failed to refresh current file content:', error);
      return null;
    }
  },

  revealAndLoadFile: async (path: string, options = {}) => {
    const normalizedPath = normalizeWorkspacePathParam(path);
    if (!normalizedPath) {
      return { status: 'failed', path, error: 'Invalid workspace file path' };
    }

    const workspaceId = options.workspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : options.workspaceId;
    const documentOpenCheck = checkNotebookDocumentOpen({
      path: normalizedPath,
      workspaceId,
    });
    if (!documentOpenCheck.allowed) {
      return {
        status: 'failed',
        path: normalizedPath,
        error: documentOpenCheck.error,
      };
    }
    const openRequestId = get().openFileRequestId + 1;
    // Even selecting the already open file cancels an older in-flight load.
    set((state) => ({
      openFileRequestId: openRequestId,
      fileLoadRequestId: state.fileLoadRequestId + 1,
      isLoadingFile: false,
      loadingFilePath: null,
      searchQuery: '',
    }));

    const isLatestOpen = () => (
      get().openFileRequestId === openRequestId &&
      useWorkspaceStore.getState().activeWorkspaceId === workspaceId
    );

    if (!isLatestOpen()) {
      return { status: 'superseded', path: normalizedPath };
    }

    if (get().currentFile?.path !== normalizedPath) {
      try {
        await get().prepareCurrentFileForTransition();
      } catch (error) {
        if (!isLatestOpen()) return { status: 'superseded', path: normalizedPath };
        return { status: 'failed', path: normalizedPath,
          error: error instanceof Error ? error.message : 'Failed to save the current file' };
      }
      if (!isLatestOpen()) return { status: 'superseded', path: normalizedPath };
    }

    const parentDir = getParentDirectory(normalizedPath);
    const parentDirs = getParentDirectories(normalizedPath);

    const revealPromise = options.revealInTree === false
      ? Promise.resolve()
      : (async () => {
          get().ensureTreeWorkspace(workspaceId);
          if (get().fileTree.length === 0) {
            await get().loadFileTree('.', 0, false, workspaceId);
          }

          for (const dirPath of parentDirs) {
            if (!isLatestOpen()) return;

            let directoryNode = findNodeInTree(dirPath, get().fileTree);
            if (!directoryNode) {
              await get().refreshDirectory(getParentDirectory(dirPath), true, workspaceId);
              directoryNode = findNodeInTree(dirPath, get().fileTree);
            }
            if (directoryNode?.type === 'directory' && !Array.isArray(directoryNode.children)) {
              await get().loadSubdirectory(dirPath, false, false, workspaceId);
            }
          }

          if (isLatestOpen() && !findNodeInTree(normalizedPath, get().fileTree)) {
            await get().refreshDirectory(parentDir, true, workspaceId);
          }

          if (!isLatestOpen()) return;
          const nextExpandedDirs = new Set(get().expandedDirs);
          for (const dirPath of parentDirs) nextExpandedDirs.add(dirPath);
          get().setExpandedDirs(nextExpandedDirs);
        })();

    const alreadyOpen = (
      get().currentFile?.path === normalizedPath &&
      get().currentFileWorkspaceId === workspaceId
    );
    const loadPromise: Promise<FileLoadResult> = alreadyOpen
      ? Promise.resolve({ status: 'loaded', path: normalizedPath, file: get().currentFile as CurrentFile })
      : get().loadFile(normalizedPath, true, workspaceId);

    const [loadResult] = await Promise.all([loadPromise, revealPromise]);
    if (!isLatestOpen() || loadResult.status === 'superseded') {
      return { status: 'superseded', path: normalizedPath };
    }
    if (loadResult.status === 'missing' || loadResult.status === 'failed') {
      return loadResult;
    }

    const selectedNode = findNodeInTree(normalizedPath, get().fileTree) ?? {
      path: normalizedPath,
      type: 'file' as const,
      name: normalizedPath.split('/').pop() || normalizedPath,
    };
    get().selectNode(selectedNode);
    get().mobileFileOpened(normalizedPath, options.transitionId);
    return { status: 'opened', path: normalizedPath };
  },

  closeFile: async (path: string) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (get().currentFile && get().currentFile?.path !== path) return false;
    const requestId = get().openFileRequestId + 1;
    set((state) => ({ openFileRequestId: requestId,
      fileLoadRequestId: state.fileLoadRequestId + 1,
      isLoadingFile: false, loadingFilePath: null }));
    await get().prepareCurrentFileForTransition();
    if (get().openFileRequestId !== requestId
      || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return false;
    get().clearCurrentFile();
    useEditorStore.getState().clear();
    return true;
  },

  prepareCurrentFileForTransition: async () => {
    const { currentFile, currentFileWorkspaceId, fileLoadRequestId } = get();
    if (!currentFile) return;
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (currentFileWorkspaceId !== workspaceId) throw new Error('The workspace changed. Please retry.');
    const editor = useEditorStore.getState();
    const isCurrent = () => (
      useWorkspaceStore.getState().activeWorkspaceId === workspaceId
      && get().currentFile?.path === currentFile.path
      && get().fileLoadRequestId === fileLoadRequestId
      && useEditorStore.getState().sessionId === editor.sessionId
    );
    try {
      const guard = getDocumentTransitionGuard(workspaceId, currentFile.path);
      if (guard) await guard.prepare();
      else if (currentFile.collaboration?.crdtCapable || currentFile.collaboration?.sceneCapable) {
        throw new Error('The editor is still connecting. Please retry when the document is saved.');
      }
      if (!isCurrent()) throw new Error('The document changed. Please retry.');
      if (!currentFile.collaboration?.crdtCapable && !currentFile.collaboration?.sceneCapable
        && editor.activePath === currentFile.path && editor.isDirty) {
        editor.markSaving();
        await get().saveFile(currentFile.path, editor.draft, workspaceId);
        if (!isCurrent() || useEditorStore.getState().draft !== editor.draft) {
          throw new Error('The file changed while saving. Please retry.');
        }
        useEditorStore.getState().markSaved();
      }
    } catch (error) {
      if (isCurrent()) useEditorStore.getState().setSaveError(
        error instanceof Error ? error.message : 'Failed to save the current file',
      );
      throw error;
    }
  },

  saveFile: async (path: string, content: string, requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : requestedWorkspaceId;
    return enqueueFileSave(workspaceId, path, async () => {
    set({ fileError: null, fileErrorPath: null, missingFilePath: null });

    try {
      const { currentFile: currentFileBeforeSave, fileRevisions } = get();
      const expectedSha256 = fileRevisions[path]
        ?? (currentFileBeforeSave?.path === path ? currentFileBeforeSave.stats?.sha256 ?? null : null);
      const result = await writeWorkspaceFile(path, content, {
        expectedSha256,
        baseRevisionId: currentFileBeforeSave?.path === path
          ? currentFileBeforeSave.revision?.id ?? currentFileBeforeSave.collaboration?.latestRevision?.id ?? null
          : null,
        workspaceId,
      });

      if (/\.(?:md|markdown)$/i.test(path)) {
        invalidateWorkspaceLinkIndexCache(workspaceId);
      }

      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;

      // Update current file if it's the same path
      const { currentFile } = get();
      if (currentFile?.path === path) {
        set((state) => ({
          currentFile: {
            ...currentFile,
            content,
            stats: result.stats ?? currentFile.stats,
            revision: result.revision ?? result.collaboration?.latestRevision ?? currentFile.revision ?? null,
            collaboration: result.collaboration ?? currentFile.collaboration ?? null,
          },
          fileRevisions: updateFileRevision(state.fileRevisions, path, result.stats),
        }));
      } else if (result.stats?.sha256) {
        set((state) => ({
          fileRevisions: updateFileRevision(state.fileRevisions, path, result.stats),
        }));
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save file';
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        set({
          fileError: message,
          fileErrorPath: path,
        });
      }
      throw error;
    }
    });
  },

  selectNode: (
    node: FileNode,
    ctrlOrMeta = false,
    shiftKey = false,
    selectionOrder?: string[],
    preserveCurrentDirectory = false,
  ) => {
    const { isMultiSelectMode, lastSelectedPath } = get();

    if (shiftKey && lastSelectedPath) {
      // Shift+Click: Select range from last selected to current
      if (!isMultiSelectMode) {
        set({ isMultiSelectMode: true, multiSelectPaths: new Set([lastSelectedPath]) });
      }
      const hasExplicitSelectionOrder = Array.isArray(selectionOrder);
      const visibleRangePaths = selectionOrder && selectionOrder.length > 0
        ? getSelectionRangePaths(selectionOrder, lastSelectedPath, node.path)
        : [];
      if (visibleRangePaths.length > 0) {
        set((state) => {
          const newMultiSelectPaths = new Set(state.multiSelectPaths);
          for (const path of visibleRangePaths) newMultiSelectPaths.add(path);
          return { multiSelectPaths: newMultiSelectPaths };
        });
      } else if (hasExplicitSelectionOrder) {
        // The previous anchor belongs to another directory level or view.
        // Keep both explicit endpoints without sweeping through hidden descendants.
        set((state) => ({
          multiSelectPaths: new Set([...state.multiSelectPaths, node.path]),
        }));
      } else {
        get().selectRange(lastSelectedPath, node.path, get().fileTree);
      }
      set({ lastSelectedPath: node.path });
    } else if (ctrlOrMeta) {
      // Ctrl/Meta: Toggle selection
      if (!isMultiSelectMode) {
        set({ selectedNode: null, multiSelectPaths: new Set() });
        get().toggleMultiSelectMode();
      }
      get().toggleMultiSelectPath(node.path);
      set({ lastSelectedPath: node.path });
    } else if (isMultiSelectMode) {
      // In multi-select mode, regular click toggles
      get().toggleMultiSelectPath(node.path);
      set({ lastSelectedPath: node.path });
    } else {
      // Standard single selection
      const nextDir =
        node.type === 'directory'
          ? node.path
          : node.path.includes('/')
            ? node.path.slice(0, node.path.lastIndexOf('/'))
            : '.';
      const selectionState = {
        selectedNode: { path: node.path, type: node.type, name: node.name },
        multiSelectPaths: new Set<string>(),
        isMultiSelectMode: false,
        lastSelectedPath: node.path,
      };
      if (preserveCurrentDirectory) {
        set(selectionState);
      } else {
        set({ ...selectionState, currentDirectory: nextDir || '.' });
        persistExplorerState({
          currentDirectory: nextDir || '.',
          expandedDirs: get().expandedDirs,
        });
      }
    }
  },

  createPath: async (path: string, type: 'file' | 'directory', options = {}) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;

    try {
      await createWorkspacePath(path, type, options);

      // Refresh from parent directory
      const parentDir = getParentDirectory(path);
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        await get().refreshDirectory(parentDir, true, workspaceId);
      }
    } catch (error) {
      throw error;
    }
  },

  deletePath: async (paths: string | string[]) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;

    const pathsToDelete = Array.isArray(paths) ? paths : [paths];

    try {
      const result = await deleteWorkspacePaths(pathsToDelete);
      if (result.failed && result.failed.length > 0) {
        const failedPaths = result.failed.map((f: { path: string; error: string }) => f.path).join(', ');
        throw new Error(`Failed to delete: ${failedPaths}`);
      }
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return result;

      for (const deletedPath of pathsToDelete) {
        const { selectedNode, currentFile, currentDirectory, setCurrentDirectory } = get();

        if (currentDirectory === deletedPath || currentDirectory.startsWith(deletedPath + '/')) {
          const newDir = deletedPath.includes('/') ? deletedPath.substring(0, deletedPath.lastIndexOf('/')) : '.';
          setCurrentDirectory(newDir);
        }

        if (selectedNode?.path === deletedPath) {
          set({ selectedNode: null });
        }
        if (currentFile?.path === deletedPath) {
          set((state) => ({
            currentFile: null,
            currentFileWorkspaceId: null,
            isLoadingFile: false,
            loadingFilePath: null,
            fileLoadRequestId: state.fileLoadRequestId + 1,
            fileError: null,
            fileErrorPath: null,
            missingFilePath: null,
          }));
        }
      }

      set((state) => ({
        multiSelectPaths: new Set(),
        isMultiSelectMode: false,
        fileRevisions: removeFileRevisions(state.fileRevisions, pathsToDelete),
      }));

      const parentDirs = new Set(pathsToDelete.map((deletedPath) => getParentDirectory(deletedPath)));
      for (const parentDir of parentDirs) {
        await get().refreshDirectory(parentDir, true, workspaceId);
      }
      notifyWorkspacePathsDeleted(pathsToDelete);
      return result;
    } catch (error) {
      throw error;
    }
  },

  renamePath: async (oldPath: string, newPath: string, overwrite = false, refreshTree = true) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;

    try {
      await renameWorkspacePath(oldPath, newPath, overwrite);
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;

      const { expandedDirs, selectedNode, currentFile, currentDirectory, setCurrentDirectory } = get();

      let updatedExpandedDirs = expandedDirs;
      const remappedExpandedDirs = remapExpandedDirectories(expandedDirs, oldPath, newPath);
      if (remappedExpandedDirs !== expandedDirs) {
        updatedExpandedDirs = remappedExpandedDirs;
        get().setExpandedDirs(updatedExpandedDirs);
      }

      if (currentDirectory === oldPath || currentDirectory.startsWith(oldPath + '/')) {
        setCurrentDirectory(remapDescendantPath(currentDirectory, oldPath, newPath));
      }

      const updatedSelectedNode = selectedNode
        ? (isSameOrDescendantPath(selectedNode.path, oldPath) ? { ...selectedNode, path: remapDescendantPath(selectedNode.path, oldPath, newPath) } : selectedNode)
        : null;
      const updatedCurrentFile = currentFile && isSameOrDescendantPath(currentFile.path, oldPath)
        ? { ...currentFile, path: remapDescendantPath(currentFile.path, oldPath, newPath) }
        : currentFile;
      set((state) => ({
        selectedNode: updatedSelectedNode,
        ...(updatedCurrentFile !== currentFile ? {
          currentFile: updatedCurrentFile,
          fileError: null,
          fileErrorPath: null,
          missingFilePath: null,
        } : {}),
        fileRevisions: remapFileRevisions(state.fileRevisions, oldPath, newPath),
      }));

      if (refreshTree) {
        const parentDirs = new Set([
          getParentDirectory(oldPath),
          getParentDirectory(newPath),
        ]);
        for (const parentDir of parentDirs) {
          await get().refreshDirectory(parentDir, true, workspaceId);
        }

        for (const dir of getExpandedDescendantDirectories(updatedExpandedDirs, newPath)) {
          if (dir !== newPath) {
            await get().loadSubdirectory(dir, true);
          }
        }
      }
      notifyWorkspacePathRenamed(oldPath, newPath);
    } catch (error) {
      throw error;
    }
  },

  uploadFile: async (
    file: File | File[],
    targetDir: string,
    pathMap?: Map<File, string>,
    convertParams?: (import('@/app/components/shared/ImagePreprocessDialog').ConvertParams | null)[],
    options = {},
  ) => {
    const files = Array.isArray(file) ? file : [file];
    set({
      uploadProgress: 0,
      uploadItems: files.map((uploadFile, index) => ({
        index,
        path: pathMap?.get(uploadFile)
          || (uploadFile as { webkitRelativePath?: string }).webkitRelativePath
          || uploadFile.name,
        size: uploadFile.size,
        uploadedBytes: 0,
        status: 'pending',
        attempt: 0,
      })),
    });
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;

    const refreshUploadedDirectory = async () => {
      if (
        options.refreshTree !== false
        && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
      ) {
        await get().refreshDirectory(targetDir, true, workspaceId);
      }
    };

    try {
      const result = await uploadWorkspaceFiles({
        files,
        targetDir,
        pathMap,
        convertParams,
        onProgress: (progress) => set({ uploadProgress: progress }),
        onFileProgress: (progress) => set((state) => ({
          uploadItems: state.uploadItems.map((item) => (
            item.index === progress.index ? progress : item
          )),
        })),
      });
      if (result.completed.length > 0) await refreshUploadedDirectory();
    } catch (error) {
      if (error instanceof WorkspaceBatchUploadError && error.result.completed.length > 0) {
        await refreshUploadedDirectory();
      }
      throw error;
    } finally {
      set({ uploadProgress: null });
    }
  },

  downloadFile: async (path: string) => {
    set({ fileError: null, fileErrorPath: null, missingFilePath: null });

    try {
      triggerWorkspaceDownload(path);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to download file';
      set({
        fileError: message,
        fileErrorPath: path,
      });
      throw error;
    }
  },

  toggleDirectory: (path: string) => {
    const { expandedDirs } = get();
    const newExpanded = new Set(expandedDirs);

    if (newExpanded.has(path)) {
      newExpanded.delete(path);
      get().setExpandedDirs(newExpanded);
    } else {
      newExpanded.add(path);
      get().setExpandedDirs(newExpanded);
      get().loadSubdirectory(path, false, false);
    }
  },
  collapseAllDirectories: () => {
    get().setExpandedDirs(new Set<string>());
  },

  clearCurrentFile: () => {
    set((state) => ({
      currentFile: null,
      currentFileWorkspaceId: null,
      fileRevisions: {},
      isLoadingFile: false,
      loadingFilePath: null,
      fileError: null,
      fileErrorPath: null,
      missingFilePath: null,
      fileLoadRequestId: state.fileLoadRequestId + 1,
      openFileRequestId: state.openFileRequestId + 1,
    }));
  },
  resetWorkspaceView: (requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : requestedWorkspaceId;
    const nextExpandedDirs = new Set<string>();
    subdirectoryLoadPromises.clear();
    set((state) => ({
      fileTree: [],
      fileTreeWorkspaceId: workspaceId,
      treeGeneration: state.treeGeneration + 1,
      rootTreeRequestId: state.rootTreeRequestId + 1,
      isLoadingTree: false,
      treeError: null,
      directoryErrors: {},
      selectedNode: null,
      currentFile: null,
      currentFileWorkspaceId: null,
      fileRevisions: {},
      isLoadingFile: false,
      loadingFilePath: null,
      fileLoadRequestId: state.fileLoadRequestId + 1,
      openFileRequestId: state.openFileRequestId + 1,
      fileError: null,
      fileErrorPath: null,
      missingFilePath: null,
      expandedDirs: nextExpandedDirs,
      currentDirectory: '.',
      uploadProgress: null,
      uploadItems: [],
      searchQuery: '',
      loadingDirs: new Set<string>(),
      isMultiSelectMode: false,
      multiSelectPaths: new Set<string>(),
      lastSelectedPath: null,
      contextMenuNode: null,
      contextMenuPosition: null,
      isContextMenuOpen: false,
      backgroundContextMenuPosition: null,
      backgroundContextMenuDirectory: '.',
      isBackgroundContextMenuOpen: false,
      clipboardPaths: new Set<string>(),
      clipboardMode: null,
      bulkMoveOpen: false,
      clientPreferencesHydratedFor: undefined,
    }));
  },
  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },
  setCurrentDirectory: (path: string) => {
    set({ currentDirectory: path });
    persistExplorerState({
      currentDirectory: path,
      expandedDirs: get().expandedDirs,
    });
  },
  markDirectoryStale: (path: string) => {
    if (!path || path === '.') return;
    set((state) => ({
      fileTree: clearDirectoryChildren(state.fileTree, path),
    }));
  },
  // Multi-select actions
  toggleMultiSelectMode: () => {
    set((state) => ({ isMultiSelectMode: !state.isMultiSelectMode }));
  },

  setMultiSelectPaths: (paths: Iterable<string>, activateMode) => {
    const multiSelectPaths = new Set(paths);
    set({
      selectedNode: null,
      multiSelectPaths,
      isMultiSelectMode: activateMode ?? multiSelectPaths.size > 0,
      lastSelectedPath: null,
    });
  },

  toggleMultiSelectPath: (path: string) => {
    set((state) => {
      const newMultiSelectPaths = new Set(state.multiSelectPaths);
      if (newMultiSelectPaths.has(path)) {
        newMultiSelectPaths.delete(path);
      } else {
        newMultiSelectPaths.add(path);
      }
      return { multiSelectPaths: newMultiSelectPaths };
    });
  },

  clearMultiSelect: () => {
    set({ isMultiSelectMode: false, multiSelectPaths: new Set<string>(), lastSelectedPath: null });
  },

  setLastSelectedPath: (path: string | null) => {
    set({ lastSelectedPath: path });
  },

  selectRange: (startPath: string, endPath: string, currentTree: FileNode[]) => {
    const rangePaths = getTreeSelectionRangePaths(currentTree, startPath, endPath);
    if (rangePaths.length === 0) return;

    set((state) => {
      const newMultiSelectPaths = new Set(state.multiSelectPaths);
      for (const p of rangePaths) newMultiSelectPaths.add(p);
      return { multiSelectPaths: newMultiSelectPaths };
    });
  },

  selectAllInDirectory: (dirPath: string) => {
    const childPaths = getDirectoryDirectChildPaths(get().fileTree, dirPath);
    if (childPaths.length > 0) {
      set((state) => {
        const newMultiSelectPaths = new Set(state.multiSelectPaths);
        for (const p of childPaths) newMultiSelectPaths.add(p);
        return { 
          multiSelectPaths: newMultiSelectPaths,
          isMultiSelectMode: newMultiSelectPaths.size > 0,
        };
      });
    }
  },
}));
