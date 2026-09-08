import { useFilePresenceStore } from '@/app/store/file-presence-store';
import { LocalFileWriteTracker } from '@/app/lib/files/local-write-tracker';
import { documentCapabilities } from '@/app/lib/files/document-capabilities';
import { create } from 'zustand';
import { recordOpenedWorkspaceFile } from '@/app/lib/files/quick-access-client';
import type {
  BrowserFileReveal,
  WorkspaceFileRevealResult,
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
  getParentDirectories,
  getParentDirectory,
  isSameOrDescendantPath,
  normalizeWorkspacePathParam,
} from '@/app/lib/files/path-utils';
import { runDirectoryTasksByDepth } from '@/app/lib/files/tree-refresh';
import { DirectoryRefreshQueue } from '@/app/lib/files/directory-refresh-queue';
import { beginUploadJob, createUploadProgressReporter, finishUploadJob, isUploadActive, updateUploadJob, updateUploadItem, useUploadStore, type UploadOptions, type UploadJobHandle } from './upload-store';
import { UploadTreeBatch, uploadVersionGuard } from '@/app/lib/files/upload-tree-batch';
import { uploadWorkspaceDirectories } from '@/app/lib/files/upload-directory-client';
import {
  findNodeInTree,
  flattenDirectoryChildren,
  getDirectoryDirectChildPaths,
  getExpandedDescendantDirectories,
  getSelectionRangePaths,
  getTreeSelectionRangePaths,
  getVisibleTreeRefreshDirectories,
  hasRefreshParentInTree,
  mergeRootNodesPreservingChildren,
  mergeSubtreeChildren,
  mergeUploadedFileNodes,
  remapExpandedDirectories,
} from '@/app/lib/files/tree-utils';
import {
  type CopyWorkspacePathsResult,
  type DeleteWorkspacePathsResult,
  WorkspaceDeletePartialError,
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
import type { WorkspacePathRenameMutation } from '@/app/lib/files/file-events';
import { remapNode, remapPath, renameTreePath, removeTreePaths } from '@/app/lib/files/path-mutation-state';
import { prunePathRecord, prunePathSet, remapPathRecord, remapPathSet } from '@/app/lib/files/path-state-collections';

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


const EXPLORER_STATE_STORAGE_KEY = 'canvas.fileExplorerState';
const fileSaveBaselines = new Map<string, { expectedSha256: string | null; baseRevisionId: string | null }>();
const saveFileQueues = new Map<string, Promise<void>>();
const localFileWrites = new LocalFileWriteTracker();
let fileRefreshRequestId = 0;
const subdirectoryLoadPromises = new Map<string, { noCache: boolean; promise: Promise<void> }>();
const directoryRefreshQueue = new DirectoryRefreshQueue();
const DEFAULT_TREE_DEPTH = 0;
const SUBDIRECTORY_TREE_DEPTH = 0;
type DirectoryLoadState = 'unloaded' | 'loading' | 'ready' | 'refreshing' | 'error';
const appliedPathMutations = new Set<string>();
const pathMutationVersions = new Map<string, number>();
const uploadTreeBatches = new Map<string, { batch: UploadTreeBatch; isCurrent: () => boolean }>();

function pathMutationVersion(workspaceId: string | null, path: string, versions = pathMutationVersions): number {
  return getParentDirectories(`${path}/_`).reduce((version, parent) => (
    version + (versions.get(`${workspaceId}\0${parent}`) ?? 0)
  ), 0);
}

function invalidatePathOperations(workspaceId: string | null, path: string) {
  const key = `${workspaceId}\0${path}`;
  pathMutationVersions.set(key, (pathMutationVersions.get(key) ?? 0) + 1);
}

function getUploadTreeBatch(job: UploadJobHandle) {
  for (const [id, pending] of uploadTreeBatches) {
    const state = useUploadStore.getState().jobs[id];
    if (!state || !isUploadActive(state)) { pending.batch.flush(); uploadTreeBatches.delete(id); }
  }
  const existing = uploadTreeBatches.get(job.id);
  if (existing) return existing;
  const { workspaceId } = job;
  const get = useFileStore.getState;
  const generation = get().treeGeneration;
  const since = uploadVersionGuard.snapshot();
  const mutations = new Map(pathMutationVersions);
  const isCurrent = () => useWorkspaceStore.getState().activeWorkspaceId === workspaceId
    && get().fileTreeWorkspaceId === workspaceId && get().treeGeneration === generation;
  const batch = new UploadTreeBatch(
    (result) => isCurrent()
      && pathMutationVersion(workspaceId, result.targetPath, mutations) === pathMutationVersion(workspaceId, result.targetPath)
      && uploadVersionGuard.accepts(workspaceId, result, since),
    (nodes, directories) => {
      if (!isCurrent()) return;
      useFileStore.setState((state) => ({ fileTree: mergeUploadedFileNodes(state.fileTree, nodes) }));
      for (const dir of directories) {
        if (dir === '.' || Array.isArray(findNodeInTree(dir, get().fileTree)?.children)) get().markDirectoryStale(dir);
      }
    },
  );
  const pending = { batch, isCurrent };
  uploadTreeBatches.set(job.id, pending);
  return pending;
}

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
      fileSaveBaselines.delete(queueKey);
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
    left?.fileVersion === right?.fileVersion &&
    left?.sha256 === right?.sha256
  );
}

function updateFileRevision(
  revisions: Record<string, string>,
  filePath: string,
  stats?: FileStats,
): Record<string, string> {
  const revision = stats?.sha256 ?? stats?.fileVersion;
  if (!revision || revisions[filePath] === revision) return revisions;
  return {
    ...revisions,
    [filePath]: revision,
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
  return remapPathRecord(revisions, oldPath, newPath);
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
  directoryLoadStates: Record<string, DirectoryLoadState>;
  directoryChangeVersions: Record<string, number>;
  staleDirs: Set<string>;

  // Selection
  selectedNode: FileNode | null;
  browserReveal: BrowserFileReveal | null;

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
  pendingExternalFile: CurrentFile | null;
  documentSyncStatus: 'idle' | 'updating' | 'updated' | 'conflict' | 'error';
  workspaceFileVersion: number;
  previewDependencyVersion: number;

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
  revalidateDirectory: (dirPath: string, workspaceId?: string | null, immediate?: boolean) => Promise<void>;
  refreshVisibleTree: () => Promise<void>;
  loadSubdirectory: (dirPath: string, noCache?: boolean, expand?: boolean, workspaceId?: string | null) => Promise<void>;
  loadFile: (path: string, noCache?: boolean, workspaceId?: string | null) => Promise<FileLoadResult>;
  refreshCurrentFileContent: (path: string, options?: { allowDirty?: boolean }) => Promise<CurrentFile | null>;
  revealAndLoadFile: (path: string, options?: OpenWorkspaceFileOptions) => Promise<OpenWorkspaceFileResult>;
  closeFile: (path: string, options?: {
    canClose?: () => boolean;
    onClosed?: () => void;
  }) => Promise<boolean>;
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
  deletePath: (path: string | string[], workspaceId?: string | null) => Promise<DeleteWorkspacePathsResult>;
  renamePath: (oldPath: string, newPath: string, overwrite?: boolean, refreshTree?: boolean, workspaceId?: string | null) => Promise<void>;
  applyPathRename: (mutation: WorkspacePathRenameMutation) => boolean;
  applyPathsDeleted: (paths: string[], workspaceId: string | null, local?: boolean) => void;
  uploadFile: (
    file: File | File[],
    targetDir: string,
    pathMap?: Map<File, string>,
    convertParams?: (import('@/app/components/shared/ImagePreprocessDialog').ConvertParams | null)[],
    options?: UploadOptions,
  ) => Promise<void>;
  reconcileUpload: (job: UploadJobHandle) => Promise<void>;
  uploadDirectories: (paths: string[], job: UploadJobHandle) => Promise<number>;
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
  directoryLoadStates: {},
  directoryChangeVersions: {},
  staleDirs: new Set<string>(),

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
  pendingExternalFile: null, documentSyncStatus: 'idle',
  workspaceFileVersion: 0, previewDependencyVersion: 0,
  browserReveal: null,
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
      directoryLoadStates: {},
      directoryChangeVersions: {},
      staleDirs: new Set<string>(),
      loadingDirs: new Set<string>(),
    });
    return treeGeneration;
  },

  loadFileTree: async (path = '.', depth = DEFAULT_TREE_DEPTH, noCache = false, workspaceId) => {
    await loadDirectorySnapshot(path, depth, noCache, workspaceId, true);
  },

  refreshRootTree: async (noCache = false, workspaceId) => {
    await loadDirectorySnapshot('.', 0, noCache, workspaceId, true);
  },

  refreshDirectory: async (dirPath: string, noCache = false, workspaceId?: string | null) => {
    if (dirPath === '.') {
      await get().refreshRootTree(noCache, workspaceId);
      return;
    }
    await get().loadSubdirectory(dirPath, noCache, false, workspaceId);
  },

  revalidateDirectory: async (dirPath, requestedWorkspaceId, immediate = false) => {
    const workspaceId = requestedWorkspaceId === undefined ? useWorkspaceStore.getState().activeWorkspaceId : requestedWorkspaceId;
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
    const generation = get().ensureTreeWorkspace(workspaceId);
    await directoryRefreshQueue.request(`${workspaceId}\0${generation}\0${dirPath}`, async () => {
      if (get().treeGeneration !== generation || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
      if (get().directoryLoadStates[dirPath] === 'ready' && !get().staleDirs.has(dirPath)) return;
      await loadDirectorySnapshot(dirPath, 0, true, workspaceId, dirPath === '.', true);
    }, immediate);
  },

  refreshVisibleTree: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const { browserMode, currentDirectory, expandedDirs, treeGeneration } = get();
    const isCurrent = () => get().treeGeneration === treeGeneration && useWorkspaceStore.getState().activeWorkspaceId === workspaceId;
    // Retain cached content, but revalidate collapsed folders when next opened.
    const markLoaded = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.type === 'directory') get().markDirectoryStale(node.path);
        if (node.children) markLoaded(node.children);
      }
    };
    markLoaded(get().fileTree);
    get().markDirectoryStale('.');
    await get().revalidateDirectory('.', workspaceId, true);
    if (!isCurrent()) return;
    const dirsToRefresh = getVisibleTreeRefreshDirectories(currentDirectory, expandedDirs, browserMode === 'tree');
    await runDirectoryTasksByDepth(dirsToRefresh, async (dirPath) => {
      if (isCurrent() && hasRefreshParentInTree(get().fileTree, dirPath)) {
        await get().revalidateDirectory(dirPath, workspaceId, true);
      }
    });
  },

  loadSubdirectory: async (dirPath: string, noCache = false, expand = true, requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : requestedWorkspaceId;
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
    if (dirPath === '.') {
      await get().refreshRootTree(noCache, workspaceId);
      return;
    }
    get().ensureTreeWorkspace(workspaceId);
    const { expandedDirs, fileTree, staleDirs } = get();
    if (expand && !expandedDirs.has(dirPath)) get().setExpandedDirs(new Set([...expandedDirs, dirPath]));
    const existingNode = findNodeInTree(dirPath, fileTree);
    if (!noCache && !staleDirs.has(dirPath) && Array.isArray(existingNode?.children)) return;
    await loadDirectorySnapshot(dirPath, SUBDIRECTORY_TREE_DEPTH, noCache, workspaceId, false);
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
      const isText = documentCapabilities(path).text;
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
        viewId: crypto.randomUUID(),
        path,
        content: data.content,
        stats: data.stats,
        revision: data.revision ?? data.collaboration?.latestRevision ?? null,
        collaboration: data.collaboration ?? null,
      };
      set((state) => ({
        selectedNode: { path, type: 'file', name: fileName },
        currentFile: loadedFile,
        pendingExternalFile: null, documentSyncStatus: 'idle',
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

  refreshCurrentFileContent: async (path: string, options = {}) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (get().currentFile?.path !== path || get().currentFileWorkspaceId !== workspaceId) {
      return null;
    }
    if (get().currentFile?.unavailable) return null;

    const originalEditor = useEditorStore.getState();
    const originalLocalVersion = getDocumentTransitionGuard(workspaceId, path)?.localChangeVersion?.();
    const collaborative = Boolean(get().currentFile?.collaboration?.crdtCapable || get().currentFile?.collaboration?.sceneCapable);
    const metaOnly = !documentCapabilities(path).text || collaborative;
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
      set({ documentSyncStatus: 'updating' });
      const data = await readWorkspaceFile(path, {
        metaOnly,
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
        content: metaOnly ? currentFile.content : data.content,
        stats: data.stats,
        revision: data.revision ?? data.collaboration?.latestRevision ?? currentFile.revision ?? null,
        collaboration: data.collaboration ?? currentFile.collaboration ?? null,
      };
      const latestEditor = useEditorStore.getState();
      const dirty = latestEditor.isDirty || Boolean(getDocumentTransitionGuard(workspaceId, path)?.hasPendingChanges());
      const ownWrite = !metaOnly && localFileWrites.consumeMatchingWrite(`${workspaceId ?? 'legacy'}\0${path}`, data.content);
      const changed = !ownWrite && (metaOnly
        ? (data.stats?.sha256 ? data.stats.sha256 !== currentFile.stats?.sha256 : !areFileStatsEqual(currentFile.stats, data.stats))
        : data.content !== currentFile.content && data.content !== latestEditor.draft);
      if (!collaborative && dirty && !options.allowDirty) {
        set(changed ? { pendingExternalFile: refreshedFile, documentSyncStatus: 'conflict' } : {
          documentSyncStatus: get().pendingExternalFile ? 'conflict' : 'idle',
        });
        return null;
      }
      // An explicit reload still cannot discard edits made after the click.
      if (options.allowDirty && (latestEditor.draft !== originalEditor.draft
        || getDocumentTransitionGuard(workspaceId, path)?.localChangeVersion?.() !== originalLocalVersion)) {
        set({ pendingExternalFile: refreshedFile, documentSyncStatus: 'conflict' });
        return null;
      }
      // A filesystem checkpoint is not the authoritative live document.
      set({ pendingExternalFile: null, documentSyncStatus: changed && !collaborative ? 'updated' : 'idle' });
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
        get().applyPathsDeleted([path], workspaceId);
        set({ documentSyncStatus: 'idle' });
        return null;
      }
      set({ documentSyncStatus: 'error' });
      console.warn('[FileStore] Failed to refresh current file content:', error);
      return null;
    } finally {
      if (fileRefreshRequestId === requestId && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
        && get().documentSyncStatus === 'updating') set({ documentSyncStatus: get().pendingExternalFile ? 'conflict' : 'idle' });
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
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return { status: 'superseded', path: normalizedPath };
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
      browserReveal: options.revealInTree === false ? null : { path: normalizedPath, workspaceId, requestId: openRequestId, status: 'loading' },
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
        set({ browserReveal: null });
        return { status: 'failed', path: normalizedPath,
          error: error instanceof Error ? error.message : 'Failed to save the current file' };
      }
      if (!isLatestOpen()) return { status: 'superseded', path: normalizedPath };
    }

    const parentDir = getParentDirectory(normalizedPath);
    const parentDirs = getParentDirectories(normalizedPath);

    const revealPromise: Promise<WorkspaceFileRevealResult> = options.revealInTree === false
      ? Promise.resolve({ status: 'skipped' })
      : (async (): Promise<WorkspaceFileRevealResult> => {
          try {
            get().ensureTreeWorkspace(workspaceId);
            if (get().fileTree.length === 0 || get().staleDirs.has('.')) {
              await get().refreshDirectory('.', true, workspaceId);
              if (get().directoryErrors['.']) throw new Error(get().directoryErrors['.']);
            }
            for (const dirPath of parentDirs) {
              if (!isLatestOpen()) return { status: 'skipped' };
              let directoryNode = findNodeInTree(dirPath, get().fileTree);
              if (!directoryNode) {
                await get().refreshDirectory(getParentDirectory(dirPath), true, workspaceId);
                directoryNode = findNodeInTree(dirPath, get().fileTree);
              }
              if (directoryNode?.type !== 'directory') throw new Error('The parent folder could not be found.');
              if (!Array.isArray(directoryNode.children) || get().staleDirs.has(dirPath)) {
                await get().loadSubdirectory(dirPath, true, false, workspaceId);
                if (get().directoryErrors[dirPath]) throw new Error(get().directoryErrors[dirPath]);
              }
            }
            if (isLatestOpen() && !findNodeInTree(normalizedPath, get().fileTree)) {
              await get().refreshDirectory(parentDir, true, workspaceId);
            }
            if (!isLatestOpen()) return { status: 'skipped' };
            if (get().directoryErrors[parentDir]) throw new Error(get().directoryErrors[parentDir]);
            if (!findNodeInTree(normalizedPath, get().fileTree)) throw new Error('The file is missing from the folder listing.');
            const nextExpandedDirs = new Set(get().expandedDirs);
            for (const dirPath of parentDirs) nextExpandedDirs.add(dirPath);
            get().setExpandedDirs(nextExpandedDirs);
            return { status: 'ready' };
          } catch (error) {
            return { status: 'failed', error: error instanceof Error ? error.message : 'Could not show the file in the browser.' };
          }
        })();

    const alreadyOpen = (
      get().currentFile?.path === normalizedPath &&
      get().currentFileWorkspaceId === workspaceId
    );
    const loadPromise: Promise<FileLoadResult> = alreadyOpen
      ? Promise.resolve({ status: 'loaded', path: normalizedPath, file: get().currentFile as CurrentFile })
      : get().loadFile(normalizedPath, true, workspaceId);

    const [loadResult, reveal] = await Promise.all([loadPromise, revealPromise]);
    if (!isLatestOpen() || loadResult.status === 'superseded') {
      return { status: 'superseded', path: normalizedPath };
    }
    if (loadResult.status === 'missing' || loadResult.status === 'failed') {
      set({ browserReveal: null });
      return loadResult;
    }

    const selectedNode = findNodeInTree(normalizedPath, get().fileTree) ?? {
      path: normalizedPath,
      type: 'file' as const,
      name: normalizedPath.split('/').pop() || normalizedPath,
    };
    set({ selectedNode, currentDirectory: parentDir, lastSelectedPath: normalizedPath,
      isMultiSelectMode: false, multiSelectPaths: new Set<string>(),
      browserReveal: reveal.status === 'skipped' ? null : {
        path: normalizedPath, workspaceId, requestId: openRequestId,
        status: reveal.status, ...(reveal.status === 'failed' ? { error: reveal.error } : {}),
      },
    });
    persistExplorerState({ currentDirectory: parentDir, expandedDirs: get().expandedDirs }, workspaceId);
    get().mobileFileOpened(normalizedPath, options.transitionId);
    if (workspaceId) void recordOpenedWorkspaceFile(workspaceId, normalizedPath);
    return { status: 'opened', path: normalizedPath, reveal };
  },

  closeFile: async (path: string, options) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (options?.canClose && !options.canClose()) return false;
    if (get().currentFile && get().currentFile?.path !== path) return false;
    const requestId = get().openFileRequestId + 1;
    set((state) => ({ openFileRequestId: requestId,
      fileLoadRequestId: state.fileLoadRequestId + 1,
      isLoadingFile: false, loadingFilePath: null }));
    await get().prepareCurrentFileForTransition();
    if (get().openFileRequestId !== requestId
      || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
      || (options?.canClose && !options.canClose())) return false;
    get().clearCurrentFile();
    useEditorStore.getState().clear();
    // Commit related tab state in the same turn, before a newer file open can intervene.
    options?.onClosed?.();
    return true;
  },

  prepareCurrentFileForTransition: async () => {
    const { currentFile, currentFileWorkspaceId, fileLoadRequestId } = get();
    if (!currentFile) return;
    if (currentFile.unavailable) throw new Error('This file is no longer available. Download your local changes or explicitly discard them before leaving.');
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
      else if (/\.docx$/i.test(currentFile.path) || currentFile.collaboration?.crdtCapable || currentFile.collaboration?.sceneCapable) {
        throw new Error('The editor is still connecting. Please retry when the document is saved.');
      }
      if (!isCurrent()) throw new Error('The document changed. Please retry.');
      if (!/\.docx$/i.test(currentFile.path) && !currentFile.collaboration?.crdtCapable && !currentFile.collaboration?.sceneCapable
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
    const snapshot = get();
    if (snapshot.pendingExternalFile?.path === path && snapshot.currentFileWorkspaceId === workspaceId) throw new Error('This file changed externally. Resolve the conflict before saving.');
    const mutationVersion = pathMutationVersion(workspaceId, path);
    const queueKey = `${workspaceId ?? 'legacy'}\0${path}`;
    const isCurrentScope = () => (
      useWorkspaceStore.getState().activeWorkspaceId === workspaceId
      && get().treeGeneration === snapshot.treeGeneration
    );
    if (!saveFileQueues.has(queueKey)) {
      const file = snapshot.currentFileWorkspaceId === workspaceId && snapshot.currentFile?.path === path
        ? snapshot.currentFile : null;
      fileSaveBaselines.set(queueKey, {
        expectedSha256: (isCurrentScope() ? snapshot.fileRevisions[path] : null) ?? file?.stats?.sha256 ?? null,
        baseRevisionId: file?.revision?.id ?? file?.collaboration?.latestRevision?.id ?? null,
      });
    }
    return enqueueFileSave(workspaceId, path, async () => {
    if (isCurrentScope() && get().pendingExternalFile?.path === path) throw new Error('Resolve the external change before saving.');
    if (pathMutationVersion(workspaceId, path) !== mutationVersion
      || (get().currentFileWorkspaceId === workspaceId && get().currentFile?.path === path && get().currentFile?.unavailable)) {
      throw new Error('The file was moved or deleted. Keep your local changes and reload its current location.');
    }
    if (isCurrentScope() && get().fileLoadRequestId === snapshot.fileLoadRequestId) set({ fileError: null, fileErrorPath: null, missingFilePath: null });

    try {
      localFileWrites.record(queueKey, content);
      const result = await writeWorkspaceFile(path, content, {
        ...fileSaveBaselines.get(queueKey), workspaceId,
      });
      // A queued save belongs to its original workspace even after navigation.
      fileSaveBaselines.set(queueKey, {
        expectedSha256: result.stats?.sha256 ?? null,
        baseRevisionId: result.revision?.id ?? result.collaboration?.latestRevision?.id ?? null,
      });

      if (/\.(?:md|markdown)$/i.test(path)) {
        invalidateWorkspaceLinkIndexCache(workspaceId);
      }

      if (!isCurrentScope() || pathMutationVersion(workspaceId, path) !== mutationVersion) return;

      // Update current file if it's the same path
      const { currentFile } = get();
      if (currentFile?.path === path && get().currentFileWorkspaceId === workspaceId
        && get().fileLoadRequestId === snapshot.fileLoadRequestId) {
        set((state) => ({
          currentFile: {
            ...currentFile,
            content,
            stats: result.stats ?? currentFile.stats,
            revision: result.revision ?? result.collaboration?.latestRevision ?? currentFile.revision ?? null,
            collaboration: result.collaboration ?? currentFile.collaboration ?? null,
          },
          ...(result.stats?.sha256 && state.pendingExternalFile?.path === path
            && state.pendingExternalFile.stats?.sha256 === result.stats.sha256
            ? { pendingExternalFile: null, documentSyncStatus: 'idle' as const } : {}),
          fileRevisions: updateFileRevision(state.fileRevisions, path, result.stats),
        }));
      } else if (result.stats?.sha256) {
        set((state) => ({
          fileRevisions: updateFileRevision(state.fileRevisions, path, result.stats),
        }));
      }
    } catch (error) {
      localFileWrites.discard(queueKey, content);
      const message =
        error instanceof Error ? error.message : 'Failed to save file';
      if (isCurrentScope() && get().fileLoadRequestId === snapshot.fileLoadRequestId) {
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

  applyPathsDeleted: (paths, workspaceId, local = false) => {
    if (paths.length === 0 || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
    const affected = (path: string) => paths.some((root) => isSameOrDescendantPath(path, root));
    for (const path of paths) {
      invalidatePathOperations(workspaceId, path);
      get().markDirectoryStale(getParentDirectory(path));
    }
    const state = get();
    const currentFile = state.currentFile;
    const currentAffected = Boolean(currentFile && affected(currentFile.path));
    const guard = currentFile ? getDocumentTransitionGuard(workspaceId, currentFile.path) : null;
    const pending = useEditorStore.getState().isDirty || Boolean(guard?.hasPendingChanges());
    const preserveCurrent = currentAffected && (!local || pending);
    let currentDirectory = state.currentDirectory;
    while (currentDirectory !== '.' && affected(currentDirectory)) currentDirectory = getParentDirectory(currentDirectory);
    const expandedDirs = new Set([...state.expandedDirs].filter((path) => !affected(path)));
    const multiSelectPaths = prunePathSet(state.multiSelectPaths, paths);
    const clipboardPaths = prunePathSet(state.clipboardPaths, paths);
    let backgroundContextMenuDirectory = state.backgroundContextMenuDirectory;
    while (backgroundContextMenuDirectory !== '.' && affected(backgroundContextMenuDirectory)) backgroundContextMenuDirectory = getParentDirectory(backgroundContextMenuDirectory);
    set({
      fileTree: removeTreePaths(state.fileTree, paths),
      pendingExternalFile: state.pendingExternalFile && affected(state.pendingExternalFile.path) ? null : state.pendingExternalFile,
      browserReveal: state.browserReveal && affected(state.browserReveal.path) ? null : state.browserReveal,
      selectedNode: state.selectedNode && affected(state.selectedNode.path) ? null : state.selectedNode,
      currentDirectory, expandedDirs,
      multiSelectPaths, isMultiSelectMode: state.isMultiSelectMode && multiSelectPaths.size > 0,
      lastSelectedPath: state.lastSelectedPath && affected(state.lastSelectedPath) ? null : state.lastSelectedPath,
      clipboardPaths, clipboardMode: clipboardPaths.size > 0 ? state.clipboardMode : null,
      contextMenuNode: state.contextMenuNode && affected(state.contextMenuNode.path) ? null : state.contextMenuNode,
      isContextMenuOpen: state.isContextMenuOpen && !(state.contextMenuNode && affected(state.contextMenuNode.path)),
      backgroundContextMenuDirectory,
      isBackgroundContextMenuOpen: state.isBackgroundContextMenuOpen && !affected(state.backgroundContextMenuDirectory),
      loadingDirs: prunePathSet(state.loadingDirs, paths),
      staleDirs: prunePathSet(state.staleDirs, paths),
      directoryErrors: prunePathRecord(state.directoryErrors, paths),
      directoryLoadStates: prunePathRecord(state.directoryLoadStates, paths),
      directoryChangeVersions: prunePathRecord(state.directoryChangeVersions, paths),
      lastMobileFileOpen: state.lastMobileFileOpen && affected(state.lastMobileFileOpen.path) ? null : state.lastMobileFileOpen,
      ...(state.fileErrorPath && affected(state.fileErrorPath) ? { fileError: null, fileErrorPath: null } : {}),
      ...(state.missingFilePath && affected(state.missingFilePath) ? { missingFilePath: null } : {}),
      ...(currentAffected ? {
        currentFile: preserveCurrent ? { ...currentFile!, unavailable: 'deleted' as const } : null,
        currentFileWorkspaceId: preserveCurrent ? workspaceId : null,
        fileError: null, fileErrorPath: null, missingFilePath: preserveCurrent ? currentFile!.path : null,
      } : {}),
      ...(currentAffected || (state.loadingFilePath && affected(state.loadingFilePath)) ? {
        fileLoadRequestId: state.fileLoadRequestId + 1, openFileRequestId: state.openFileRequestId + 1,
        isLoadingFile: false, loadingFilePath: null,
      } : {}),
      fileRevisions: removeFileRevisions(state.fileRevisions, paths),
    });
    persistExplorerState({ currentDirectory, expandedDirs }, workspaceId);
    useFilePresenceStore.getState().removePaths(paths);
    notifyWorkspacePathsDeleted(paths, workspaceId);
  },

  applyPathRename: (mutation) => {
    const { oldPath, newPath, workspaceId, operationId } = mutation;
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return false;
    const mutationKey = `${workspaceId}\0${operationId}`;
    if (appliedPathMutations.has(mutationKey)) return false;
    appliedPathMutations.add(mutationKey);
    if (appliedPathMutations.size > 2048) appliedPathMutations.delete(appliedPathMutations.values().next().value!);
    invalidatePathOperations(workspaceId, oldPath);
    invalidatePathOperations(workspaceId, newPath);
    get().markDirectoryStale(getParentDirectory(oldPath));
    get().markDirectoryStale(getParentDirectory(newPath));
    const state = get();
    const mapPath = (path: string) => remapPath(path, oldPath, newPath);
    const currentFile = state.currentFile;
    const sourceIsCurrent = Boolean(currentFile && isSameOrDescendantPath(currentFile.path, oldPath));
    const destinationIsCurrent = Boolean(currentFile && !sourceIsCurrent && isSameOrDescendantPath(currentFile.path, newPath));
    const editor = useEditorStore.getState();
    if (editor.activePath && isSameOrDescendantPath(editor.activePath, oldPath)) {
      useEditorStore.setState({ activePath: mapPath(editor.activePath), sessionId: editor.sessionId + 1, isSaving: false });
    }
    const expandedDirs = remapExpandedDirectories(state.expandedDirs, oldPath, newPath);
    const currentDirectory = mapPath(state.currentDirectory);
    const loadingAffected = state.loadingFilePath && [oldPath, newPath].some((path) => isSameOrDescendantPath(state.loadingFilePath!, path));
    const movedDirectoryStates = remapPathRecord(state.directoryLoadStates, oldPath, newPath);
    for (const path of Object.keys(movedDirectoryStates)) {
      if (isSameOrDescendantPath(path, newPath) && ['loading', 'refreshing'].includes(movedDirectoryStates[path])) movedDirectoryStates[path] = 'unloaded';
    }
    set({
      fileTree: renameTreePath(state.fileTree, oldPath, newPath),
      documentSyncStatus: state.pendingExternalFile ? 'conflict' : 'idle',
      pendingExternalFile: state.pendingExternalFile ? { ...state.pendingExternalFile, path: mapPath(state.pendingExternalFile.path) } : null,
      browserReveal: state.browserReveal ? { ...state.browserReveal, path: mapPath(state.browserReveal.path) } : null,
      expandedDirs, currentDirectory,
      selectedNode: state.selectedNode ? remapNode(state.selectedNode, oldPath, newPath) : null,
      multiSelectPaths: remapPathSet(state.multiSelectPaths, oldPath, newPath),
      lastSelectedPath: state.lastSelectedPath ? mapPath(state.lastSelectedPath) : null,
      clipboardPaths: remapPathSet(state.clipboardPaths, oldPath, newPath),
      contextMenuNode: state.contextMenuNode ? remapNode(state.contextMenuNode, oldPath, newPath) : null,
      backgroundContextMenuDirectory: mapPath(state.backgroundContextMenuDirectory),
      loadingDirs: prunePathSet(state.loadingDirs, [oldPath, newPath]),
      directoryErrors: remapPathRecord(state.directoryErrors, oldPath, newPath),
      directoryLoadStates: movedDirectoryStates,
      directoryChangeVersions: remapPathRecord(state.directoryChangeVersions, oldPath, newPath),
      staleDirs: remapPathSet(new Set([...state.staleDirs, ...state.loadingDirs]), oldPath, newPath),
      lastMobileFileOpen: state.lastMobileFileOpen ? { ...state.lastMobileFileOpen, path: mapPath(state.lastMobileFileOpen.path) } : null,
      fileErrorPath: state.fileErrorPath ? mapPath(state.fileErrorPath) : null,
      missingFilePath: state.missingFilePath ? mapPath(state.missingFilePath) : null,
      ...(sourceIsCurrent ? {
        currentFile: { ...currentFile!, path: mapPath(currentFile!.path), unavailable: undefined,
          collaboration: currentFile!.collaboration ? { ...currentFile!.collaboration, path: mapPath(currentFile!.path) } : null },
        fileError: null, fileErrorPath: null, missingFilePath: null,
      } : destinationIsCurrent ? {
        currentFile: { ...currentFile!, unavailable: 'replaced' as const },
      } : {}),
      ...(sourceIsCurrent || destinationIsCurrent || loadingAffected ? {
        fileLoadRequestId: state.fileLoadRequestId + 1, openFileRequestId: state.openFileRequestId + 1,
        isLoadingFile: false, loadingFilePath: null,
      } : {}),
      fileRevisions: remapFileRevisions(state.fileRevisions, oldPath, newPath),
    });
    persistExplorerState({ currentDirectory, expandedDirs }, workspaceId);
    useFilePresenceStore.getState().renamePath(oldPath, newPath);
    notifyWorkspacePathRenamed(oldPath, newPath, workspaceId);
    return true;
  },

  deletePath: async (paths: string | string[], requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined ? useWorkspaceStore.getState().activeWorkspaceId : requestedWorkspaceId;
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) throw new Error('The workspace changed. Please retry.');
    const treeGeneration = get().treeGeneration;
    const isCurrent = () => useWorkspaceStore.getState().activeWorkspaceId === workspaceId && get().treeGeneration === treeGeneration;
    const pathsToDelete = Array.isArray(paths) ? paths : [paths];
    const currentPath = get().currentFile?.path;
    if (currentPath && pathsToDelete.some((path) => isSameOrDescendantPath(currentPath, path))) {
      await get().prepareCurrentFileForTransition();
    }
    if (!isCurrent()) return {};
    const result = await deleteWorkspacePaths(pathsToDelete, workspaceId);
    if (!isCurrent()) return result;
    const deleted = result.deleted ?? (result.failed?.length ? [] : pathsToDelete);
    get().applyPathsDeleted(deleted, workspaceId, true);
    for (const parent of new Set(deleted.map(getParentDirectory))) {
      if (!isCurrent()) return result;
      await get().refreshDirectory(parent, true, workspaceId);
    }
    if (result.failed?.length) {
      throw new WorkspaceDeletePartialError(result);
    }
    if (isCurrent()) get().clearMultiSelect();
    return result;
  },

  renamePath: async (oldPath: string, newPath: string, overwrite = false, refreshTree = true, requestedWorkspaceId?: string | null) => {
    const workspaceId = requestedWorkspaceId === undefined ? useWorkspaceStore.getState().activeWorkspaceId : requestedWorkspaceId;
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) throw new Error('The workspace changed. Please retry.');
    const treeGeneration = get().treeGeneration;
    if (get().currentFile && isSameOrDescendantPath(get().currentFile!.path, oldPath)) {
      await get().prepareCurrentFileForTransition();
    }
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId || get().treeGeneration !== treeGeneration) return;
    const result = await renameWorkspacePath(oldPath, newPath, overwrite, workspaceId);
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId || get().treeGeneration !== treeGeneration) return;
    get().applyPathRename(result.mutation ?? {
      type: 'rename', workspaceId: workspaceId!, oldPath, newPath, operationId: crypto.randomUUID(),
    });
    if (refreshTree) {
      for (const parent of new Set([getParentDirectory(oldPath), getParentDirectory(newPath)])) {
        if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
        await get().refreshDirectory(parent, true, workspaceId);
      }
      for (const dir of getExpandedDescendantDirectories(get().expandedDirs, newPath)) {
        if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
        await get().loadSubdirectory(dir, true, false, workspaceId);
      }
    }
  },

  reconcileUpload: async (job) => {
    const pending = uploadTreeBatches.get(job.id);
    pending?.batch.flush();
    uploadTreeBatches.delete(job.id);
    if (useWorkspaceStore.getState().activeWorkspaceId !== job.workspaceId || (pending && !pending.isCurrent())) return;
    const directories = new Set([job.targetDir, ...(pending?.batch.directories ?? [])]);
    for (const dir of directories) {
      if (dir !== '.' && !Array.isArray(findNodeInTree(dir, get().fileTree)?.children)) continue;
      get().markDirectoryStale(dir);
    }
    await Promise.all([...directories].filter((dir) => dir === '.' || Array.isArray(findNodeInTree(dir, get().fileTree)?.children))
      .map((dir) => get().revalidateDirectory(dir, job.workspaceId, true)));
  },

  uploadDirectories: async (paths, job) => {
    const pending = getUploadTreeBatch(job);
    const result = await uploadWorkspaceDirectories(paths, job.targetDir, job.workspaceId);
    for (const entry of result.completed) {
      pending.batch.add(entry.committed);
      const item = useUploadStore.getState().jobs[job.id]?.items.find((item) => item.kind === 'directory' && item.path === entry.sourcePath);
      if (item) updateUploadItem(job, { ...item, path: entry.committed.targetPath, status: 'completed' });
    }
    for (const entry of result.failed) {
      const item = useUploadStore.getState().jobs[job.id]?.items.find((item) => item.kind === 'directory' && item.path === entry.sourcePath);
      if (item) updateUploadItem(job, { ...item, status: 'failed', error: entry.error });
    }
    return result.failed.length;
  },

  uploadFile: async (
    file: File | File[],
    targetDir: string,
    pathMap?: Map<File, string>,
    convertParams?: (import('@/app/components/shared/ImagePreprocessDialog').ConvertParams | null)[],
    options = {},
  ) => {
    const files = Array.isArray(file) ? file : [file];
    const workspaceId = options.job ? options.job.workspaceId : (options.workspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId : options.workspaceId);
    const job = options.job ?? beginUploadJob(files, targetDir, workspaceId, pathMap);
    const pending = getUploadTreeBatch(job);
    const reporter = createUploadProgressReporter(job, options.fileIndices);
    let failure: unknown;
    updateUploadJob(job, { phase: 'uploading' });
    const refreshUploadedDirectory = async () => {
      if (
        options.refreshTree !== false
        && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
      ) {
        updateUploadJob(job, { phase: 'reconciling' });
        await get().reconcileUpload(job);
      }
    };

    try {
      const result = await uploadWorkspaceFiles({
        files,
        targetDir: job.targetDir,
        workspaceId,
        pathMap,
        convertParams,
        onFileProgress: reporter.report,
        onFileCompleted: (result) => pending.batch.add(result),
      });
      if (result.completed.length > 0) await refreshUploadedDirectory();
    } catch (error) {
      failure = error;
      if (error instanceof WorkspaceBatchUploadError && error.result.completed.length > 0) {
        await refreshUploadedDirectory();
      }
      throw error;
    } finally {
      reporter.flush();
      if (!options.job) {
        pending.batch.flush();
        uploadTreeBatches.delete(job.id);
        finishUploadJob(job, failure);
      }
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
    useEditorStore.getState().clear();
    useFilePresenceStore.getState().clear();
    const workspaceId = requestedWorkspaceId === undefined
      ? useWorkspaceStore.getState().activeWorkspaceId
      : requestedWorkspaceId;
    const nextExpandedDirs = new Set<string>();
    subdirectoryLoadPromises.clear();
    set((state) => ({
      fileTree: [],
      fileTreeWorkspaceId: workspaceId,
      treeGeneration: state.treeGeneration + 1,
      pendingExternalFile: null, documentSyncStatus: 'idle',
      workspaceFileVersion: 0, previewDependencyVersion: 0,
      browserReveal: null,
      rootTreeRequestId: state.rootTreeRequestId + 1,
      isLoadingTree: false,
      treeError: null,
      directoryErrors: {},
      directoryLoadStates: {},
      directoryChangeVersions: {},
      staleDirs: new Set<string>(),
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
    if (!path) return;
    set((state) => ({
      staleDirs: new Set([...state.staleDirs, path]),
      directoryChangeVersions: { ...state.directoryChangeVersions, [path]: (state.directoryChangeVersions[path] ?? 0) + 1 },
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

/** Only publish snapshots read after the most recent mutation of this directory. */
async function loadDirectorySnapshot(
  dirPath: string,
  depth: number,
  noCache: boolean,
  requestedWorkspaceId: string | null | undefined,
  replaceTree: boolean,
  joinFreshRead = false,
): Promise<void> {
  const get = useFileStore.getState;
  const set = useFileStore.setState;
  const workspaceId = requestedWorkspaceId === undefined ? useWorkspaceStore.getState().activeWorkspaceId : requestedWorkspaceId;
  if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
  const treeGeneration = get().ensureTreeWorkspace(workspaceId);
  const loadKey = `${workspaceId}\0${dirPath}\0${depth}\0${replaceTree}`;
  const inFlight = subdirectoryLoadPromises.get(loadKey);
  if (inFlight) {
    if (noCache && (!joinFreshRead || !inFlight.noCache)) {
      get().markDirectoryStale(dirPath);
      inFlight.noCache = true;
    }
    return inFlight.promise;
  }

  const state = get();
  const requestId = replaceTree ? state.rootTreeRequestId + 1 : state.rootTreeRequestId;
  const pathVersion = pathMutationVersion(workspaceId, dirPath);
  const hasSnapshot = replaceTree
    ? state.fileTree.length > 0 || state.directoryLoadStates[dirPath] === 'ready'
    : Array.isArray(findNodeInTree(dirPath, state.fileTree)?.children);
  const errors = { ...state.directoryErrors };
  delete errors[dirPath];
  set({
    ...(replaceTree ? { rootTreeRequestId: requestId, isLoadingTree: !hasSnapshot, treeError: null } : {}),
    loadingDirs: new Set([...state.loadingDirs, dirPath]),
    directoryErrors: errors,
    directoryLoadStates: { ...state.directoryLoadStates, [dirPath]: hasSnapshot ? 'refreshing' : 'loading' },
  });
  const isCurrent = () => get().treeGeneration === treeGeneration
    && get().fileTreeWorkspaceId === workspaceId
    && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
    && pathMutationVersion(workspaceId, dirPath) === pathVersion
    && (!replaceTree || get().rootTreeRequestId === requestId);
  const finish = (error?: unknown, data?: FileNode[]) => {
    // A synchronous store subscriber may request another read during publication.
    // It must see a completed flight, not join the already-finished promise.
    if (subdirectoryLoadPromises.get(loadKey)?.promise === promise) subdirectoryLoadPromises.delete(loadKey);
    const latest = get();
    const loadingDirs = new Set(latest.loadingDirs);
    loadingDirs.delete(dirPath);
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : 'Failed to load directory';
      set({ loadingDirs, ...(replaceTree ? { isLoadingTree: false, treeError: message } : {}),
        directoryErrors: { ...latest.directoryErrors, [dirPath]: message },
        directoryLoadStates: { ...latest.directoryLoadStates, [dirPath]: 'error' } });
      return;
    }
    const staleDirs = new Set(latest.staleDirs);
    staleDirs.delete(dirPath);
    const directoryErrors = { ...latest.directoryErrors };
    delete directoryErrors[dirPath];
    const fileTree = replaceTree
      ? depth === 0 ? mergeRootNodesPreservingChildren(data!, latest.fileTree) : data!
      : mergeSubtreeChildren(latest.fileTree, dirPath, data!);
    set({ fileTree, loadingDirs, staleDirs, directoryErrors,
      ...(replaceTree ? { isLoadingTree: false, treeError: null } : {}),
      directoryLoadStates: { ...latest.directoryLoadStates, [dirPath]: 'ready' } });
  };
  let force = noCache || get().staleDirs.has(dirPath);
  const promise = (async () => {
    while (isCurrent()) {
      if (joinFreshRead) {
        await directoryRefreshQueue.waitForRead(`${workspaceId}\0${treeGeneration}\0${dirPath}`);
        if (!isCurrent()) return;
      }
      const version = get().directoryChangeVersions[dirPath] ?? 0;
      try {
        const includeStats = (flattenDirectoryChildren(get().fileTree, dirPath) ?? []).some((node) => node.size !== undefined);
        const data = await loadWorkspaceTree(dirPath, depth, force, 'Failed to load directory', workspaceId, { includeStats });
        if (!isCurrent()) return;
        if ((get().directoryChangeVersions[dirPath] ?? 0) !== version) {
          force = true;
          continue;
        }
        finish(undefined, data);
      } catch (error) {
        if (!isCurrent()) return;
        if ((get().directoryChangeVersions[dirPath] ?? 0) !== version) {
          force = true;
          continue;
        }
        finish(error);
      }
      return;
    }
  })();
  subdirectoryLoadPromises.set(loadKey, { noCache, promise });
  try {
    await promise;
  } finally {
    if (subdirectoryLoadPromises.get(loadKey)?.promise === promise) subdirectoryLoadPromises.delete(loadKey);
  }
}
