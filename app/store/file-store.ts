import { create } from 'zustand';
import type { BrowserMode, CurrentFile, FileNode, FileStats } from '@/app/lib/files/types';
import {
  getExtension,
  getParentDirectories,
  getParentDirectory,
  isSameOrDescendantPath,
  remapDescendantPath,
} from '@/app/lib/files/path-utils';
import {
  findNodeInTree,
  getDirectoryDirectChildPaths,
  getExpandedDescendantDirectories,
  getTreeSelectionRangePaths,
  getVisibleTreeRefreshDirectories,
  hasRefreshParentInTree,
  mergeRootNodesPreservingChildren,
  mergeSubtreeChildren,
  remapExpandedDirectories,
} from '@/app/lib/files/tree-utils';
import {
  copyWorkspacePaths,
  createWorkspacePath,
  deleteWorkspacePaths,
  loadWorkspaceTree,
  readApiError,
  readWorkspaceFile,
  renameWorkspacePath,
  triggerWorkspaceDownload,
  uploadWorkspaceFiles,
  writeWorkspaceFile,
} from '@/app/lib/files/client';

export type { BrowserMode, CurrentFile, FileNode, FileStats } from '@/app/lib/files/types';
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

interface StoredExplorerState {
  currentDirectory?: string;
  expandedDirs?: string[];
}

function readStoredExplorerState(): StoredExplorerState {
  if (typeof window === 'undefined') return {};

  try {
    const stored = window.localStorage.getItem(EXPLORER_STATE_STORAGE_KEY);
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

function persistExplorerState(nextState: Pick<FileStoreState, 'currentDirectory' | 'expandedDirs'>) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      EXPLORER_STATE_STORAGE_KEY,
      JSON.stringify({
        currentDirectory: nextState.currentDirectory,
        expandedDirs: Array.from(nextState.expandedDirs),
      })
    );
  } catch {
    // Non-critical: explorer state can fall back to in-memory Zustand state.
  }
}

function enqueueFileSave(path: string, operation: () => Promise<void>): Promise<void> {
  const previousSave = saveFileQueues.get(path) ?? Promise.resolve();
  const currentSave = previousSave.catch(() => undefined).then(operation);
  const queueTail = currentSave.catch(() => undefined);

  saveFileQueues.set(path, queueTail);
  void queueTail.finally(() => {
    if (saveFileQueues.get(path) === queueTail) {
      saveFileQueues.delete(path);
    }
  });

  return currentSave;
}

const initialExplorerState: StoredExplorerState = {};

function readClientBrowserMode(): BrowserMode {
  if (typeof window === 'undefined') return 'tree';
  const stored = window.localStorage.getItem('canvas-browser-mode');
  if (stored === 'tree' || stored === 'list' || stored === 'grid') return stored;
  return window.innerWidth < 768 ? 'list' : 'tree';
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
  isLoadingTree: boolean;
  treeError: string | null;

  // Selection
  selectedNode: FileNode | null;

  // Current file
  currentFile: CurrentFile | null;
  isLoadingFile: boolean;
  loadingFilePath: string | null;
  fileLoadRequestId: number;
  fileError: string | null;
  fileRevisions: Record<string, string>;

  // Browser mode
  browserMode: BrowserMode;
  setBrowserMode: (mode: BrowserMode) => void;
  hydrateClientPreferences: () => void;

  // Expanded directories
  expandedDirs: Set<string>;
  currentDirectory: string;
  setExpandedDirs: (dirs: Set<string>) => void;
  uploadProgress: number | null;
  searchQuery: string;
  autoRefresh: boolean;
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
  setMobileSurface: (surface: 'files' | 'editor' | null) => void;
  mobileFileOpened: () => void;

  // Bulk move dialog state
  bulkMoveOpen: boolean;
  setBulkMoveOpen: (open: boolean) => void;

  // Clipboard state for copy/paste
  clipboardPaths: Set<string>;
  clipboardMode: 'copy' | null;
  copyPaths: (paths?: Iterable<string>) => void;
  pastePaths: (destDir: string) => Promise<void>;
  duplicatePath: (path: string) => Promise<void>;

  // Actions
  loadFileTree: (path?: string, depth?: number, noCache?: boolean) => Promise<void>;
  refreshRootTree: (noCache?: boolean) => Promise<void>;
  refreshDirectory: (dirPath: string, noCache?: boolean) => Promise<void>;
  refreshVisibleTree: () => Promise<void>;
  loadSubdirectory: (dirPath: string, noCache?: boolean, expand?: boolean) => Promise<void>;
  loadFile: (path: string, noCache?: boolean) => Promise<void>;
  refreshCurrentFileContent: (path: string) => Promise<CurrentFile | null>;
  revealAndLoadFile: (path: string) => Promise<void>;
  saveFile: (path: string, content: string) => Promise<void>;
  selectNode: (node: FileNode, ctrlOrMeta?: boolean, shiftKey?: boolean) => void;
  createPath: (path: string, type: 'file' | 'directory', options?: { template?: 'excalidraw' }) => Promise<void>;
  deletePath: (path: string | string[]) => Promise<void>;
  renamePath: (oldPath: string, newPath: string, overwrite?: boolean) => Promise<void>;
  uploadFile: (file: File | File[], targetDir: string, pathMap?: Map<File, string>, convertParams?: (import('@/app/components/shared/ImagePreprocessDialog').ConvertParams | null)[]) => Promise<void>;
  downloadFile: (path: string) => Promise<void>;
  toggleDirectory: (path: string) => void;
  collapseAllDirectories: () => void;
  clearCurrentFile: () => void;
  resetWorkspaceView: () => void;
  setSearchQuery: (query: string) => void;
  setCurrentDirectory: (path: string) => void;
  toggleAutoRefresh: () => void;
  clearMultiSelect: () => void;
  toggleMultiSelectMode: () => void;
  toggleMultiSelectPath: (path: string) => void;
  setLastSelectedPath: (path: string | null) => void;
  selectRange: (startPath: string, endPath: string, currentTree: FileNode[]) => void;
  selectAllInDirectory: (dirPath: string) => void;
}

export const useFileStore = create<FileStoreState>((set, get) => ({
  // Initial state
  fileTree: [],
  isLoadingTree: false,
  treeError: null,

  selectedNode: null,

  currentFile: null,
  fileRevisions: {},

  browserMode: 'tree',
  setBrowserMode: (mode: BrowserMode) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('canvas-browser-mode', mode);
    }
    set({ browserMode: mode });
  },
  hydrateClientPreferences: () => {
    const storedExplorerState = readStoredExplorerState();
    set({
      browserMode: readClientBrowserMode(),
      currentDirectory: storedExplorerState.currentDirectory ?? get().currentDirectory,
      expandedDirs: new Set<string>(storedExplorerState.expandedDirs ?? Array.from(get().expandedDirs)),
    });
  },
  isLoadingFile: false,
  loadingFilePath: null,
  fileLoadRequestId: 0,
  fileError: null,

  expandedDirs: new Set<string>(initialExplorerState.expandedDirs ?? []),
  currentDirectory: initialExplorerState.currentDirectory ?? '.',
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
  searchQuery: '',
  autoRefresh: false,
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
  setMobileSurface: (surface: 'files' | 'editor' | null) => {
    set({ mobileSurface: surface });
  },
  mobileFileOpened: () => {
    set((state) => ({ mobileSurface: 'editor', mobileFileOpenedCount: state.mobileFileOpenedCount + 1 }));
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
      set({ clipboardPaths: new Set(paths), clipboardMode: 'copy' });
      return;
    }

    const { multiSelectPaths, selectedNode, isMultiSelectMode } = get();
    if (isMultiSelectMode && multiSelectPaths.size > 0) {
      set({ clipboardPaths: new Set(multiSelectPaths), clipboardMode: 'copy' });
    } else if (selectedNode) {
      set({ clipboardPaths: new Set([selectedNode.path]), clipboardMode: 'copy' });
    }
  },
  pastePaths: async (destDir: string) => {
    const { clipboardPaths, clipboardMode } = get();
    if (clipboardMode !== 'copy' || clipboardPaths.size === 0) return;

    try {
      await copyWorkspacePaths({
        sources: Array.from(clipboardPaths),
        destDir,
        overwrite: false,
      }, 'Failed to paste files');

      await get().refreshDirectory(destDir, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to paste files';
      set({ treeError: message });
      throw error;
    }
  },
  duplicatePath: async (path: string) => {
    const parentDir = getParentDirectory(path);

    try {
      await copyWorkspacePaths({
        sources: [path],
        destDir: parentDir,
        overwrite: false,
        renameOnCollision: true,
      }, 'Failed to duplicate file');

      await get().refreshDirectory(parentDir, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to duplicate file';
      set({ treeError: message });
      throw error;
    }
  },

  // Actions
  loadFileTree: async (path = '.', depth?: number, noCache = false) => {
    set({ isLoadingTree: true, treeError: null });

    const depthTarget = typeof depth === 'number' ? depth : 4;

    try {
      const data = await loadWorkspaceTree(path, depthTarget, noCache);
      set({ fileTree: data, isLoadingTree: false });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load file tree';
      set({
        treeError: message,
        isLoadingTree: false,
      });
    }
  },

  refreshRootTree: async (noCache = false) => {
    set({ treeError: null });

    try {
      const data = await loadWorkspaceTree('.', 0, noCache, 'Failed to refresh root tree');

      // Merge: preserve existing children from current tree so expanded
      // folders don't appear empty after a root-level refresh (depth=0).
      const mergedTree = mergeRootNodesPreservingChildren(data, get().fileTree);

      set({ fileTree: mergedTree });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to refresh root tree';
      set({ treeError: message });
    }
  },

  refreshDirectory: async (dirPath: string, noCache = false) => {
    if (dirPath === '.') {
      await get().refreshRootTree(noCache);
      return;
    }

    await get().loadSubdirectory(dirPath, noCache);
  },

  refreshVisibleTree: async () => {
    const { browserMode, currentDirectory, expandedDirs } = get();
    await get().refreshRootTree(true);

    const dirsToRefresh = getVisibleTreeRefreshDirectories(currentDirectory, expandedDirs, browserMode === 'tree');
    for (const dirPath of dirsToRefresh) {
      if (hasRefreshParentInTree(get().fileTree, dirPath)) {
        await get().loadSubdirectory(dirPath, true);
      }
    }
  },

  loadSubdirectory: async (dirPath: string, noCache = false, expand = true) => {
    if (dirPath === '.') {
      await get().refreshRootTree(noCache);
      return;
    }

    const { loadingDirs, expandedDirs, fileTree } = get();
    if (loadingDirs.has(dirPath)) {
      if (expand && !expandedDirs.has(dirPath)) {
        const newExpanded = new Set(expandedDirs);
        newExpanded.add(dirPath);
        get().setExpandedDirs(newExpanded);
      }
      return;
    }

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

    const newLoading = new Set(loadingDirs);
    newLoading.add(dirPath);
    set({ loadingDirs: newLoading });

    try {
      const data = await loadWorkspaceTree(dirPath, 1, noCache, 'Failed to load subdirectory');

      // Use fresh state references after the async gap to avoid
      // overwriting concurrent tree updates (race condition).
      const newTree = mergeSubtreeChildren(get().fileTree, dirPath, data);

      const newLoading = new Set(get().loadingDirs);
      newLoading.delete(dirPath);

      set({ fileTree: newTree, loadingDirs: newLoading });
      if (expand) {
        const newExpanded = new Set(get().expandedDirs);
        newExpanded.add(dirPath);
        get().setExpandedDirs(newExpanded);
      }
    } catch (error) {
      const newLoading = new Set(get().loadingDirs);
      newLoading.delete(dirPath);
      set({ loadingDirs: newLoading });
      console.error('Failed to load subdirectory:', error);
    }
  },

  loadFile: async (path: string, noCache = false) => {
    const requestId = get().fileLoadRequestId + 1;
    set({
      fileLoadRequestId: requestId,
      isLoadingFile: true,
      loadingFilePath: path,
      fileError: null,
    });

    try {
      const extension = getExtension(path);
      const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
      const useMetaOnly = !isText;

      const data = await readWorkspaceFile(path, { metaOnly: useMetaOnly, noCache });
      if (get().fileLoadRequestId !== requestId) return;

      const fileName = path.split('/').pop() || path;
      set((state) => ({
        selectedNode: { path, type: 'file', name: fileName },
        currentFile: {
          path,
          content: data.content,
          stats: data.stats,
          revision: data.revision ?? data.collaboration?.latestRevision ?? null,
          collaboration: data.collaboration ?? null,
        },
        isLoadingFile: false,
        loadingFilePath: null,
        fileRevisions: updateFileRevision(state.fileRevisions, path, data.stats),
      }));
    } catch (error) {
      if (error instanceof Response && error.status === 404) {
        if (get().fileLoadRequestId === requestId) {
          set({
            currentFile: null,
            isLoadingFile: false,
            loadingFilePath: null,
            fileError: null,
          });
        }
        return;
      }
      if (get().fileLoadRequestId !== requestId) return;
      const message =
        error instanceof Response
          ? await readApiError(error, 'Failed to load file')
          : error instanceof Error ? error.message : 'Failed to load file';
      set({
        fileError: message,
        isLoadingFile: false,
        loadingFilePath: null,
      });
    }
  },

  refreshCurrentFileContent: async (path: string) => {
    if (get().currentFile?.path !== path) {
      return null;
    }

    const extension = getExtension(path);
    const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
    if (!isText) {
      return null;
    }

    try {
      const data = await readWorkspaceFile(path, { noCache: true, fallbackMessage: 'Failed to refresh file' });
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
          fileRevisions: nextFileRevisions,
        });
      }

      return refreshedFile;
    } catch (error) {
      if (error instanceof Response && error.status === 404 && get().currentFile?.path === path) {
        set({
          currentFile: null,
          fileError: null,
        });
        return null;
      }
      console.warn('[FileStore] Failed to refresh current file content:', error);
      return null;
    }
  },

  revealAndLoadFile: async (path: string) => {
    const normalizedPath = path.replace(/^\.\/|\/$/g, '');
    if (!normalizedPath) return;

    const parentDir = getParentDirectory(normalizedPath);
    const parentDirs = getParentDirectories(normalizedPath);

    set({ searchQuery: '' });

    await get().refreshRootTree(true);

    for (const dirPath of parentDirs) {
      await get().loadSubdirectory(dirPath, true);
    }

    const node = findNodeInTree(normalizedPath, get().fileTree);
    const fileName = normalizedPath.split('/').pop() || normalizedPath;

    const nextExpandedDirs = new Set(get().expandedDirs);
    for (const dirPath of parentDirs) {
      nextExpandedDirs.add(dirPath);
    }
    get().setExpandedDirs(nextExpandedDirs);

    if (node) {
      get().selectNode(node);
    } else {
      set({
        selectedNode: { path: normalizedPath, type: 'file', name: fileName },
        currentDirectory: parentDir,
        multiSelectPaths: new Set<string>(),
        isMultiSelectMode: false,
        lastSelectedPath: normalizedPath,
      });
      persistExplorerState({
        currentDirectory: parentDir,
        expandedDirs: nextExpandedDirs,
      });
    }

    await get().loadFile(normalizedPath, true);
    get().mobileFileOpened();
  },

  saveFile: async (path: string, content: string) => enqueueFileSave(path, async () => {
    set({ fileError: null });

    try {
      const { currentFile: currentFileBeforeSave, fileRevisions } = get();
      const expectedSha256 = fileRevisions[path]
        ?? (currentFileBeforeSave?.path === path ? currentFileBeforeSave.stats?.sha256 ?? null : null);
      const result = await writeWorkspaceFile(path, content, {
        expectedSha256,
        baseRevisionId: currentFileBeforeSave?.path === path
          ? currentFileBeforeSave.revision?.id ?? currentFileBeforeSave.collaboration?.latestRevision?.id ?? null
          : null,
      });

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
      set({
        fileError: message,
      });
      throw error;
    }
  }),

  selectNode: (node: FileNode, ctrlOrMeta = false, shiftKey = false) => {
    const { isMultiSelectMode, lastSelectedPath } = get();

    if (shiftKey && lastSelectedPath) {
      // Shift+Click: Select range from last selected to current
      if (!isMultiSelectMode) {
        set({ isMultiSelectMode: true, multiSelectPaths: new Set([lastSelectedPath]) });
      }
      get().selectRange(lastSelectedPath, node.path, get().fileTree);
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
      set({
        selectedNode: { path: node.path, type: node.type, name: node.name },
        currentDirectory: nextDir || '.',
        multiSelectPaths: new Set<string>(),
        isMultiSelectMode: false,
        lastSelectedPath: node.path,
      });
      persistExplorerState({
        currentDirectory: nextDir || '.',
        expandedDirs: get().expandedDirs,
      });
    }
  },

  createPath: async (path: string, type: 'file' | 'directory', options = {}) => {
    set({ treeError: null });

    try {
      await createWorkspacePath(path, type, options);

      // Refresh from parent directory
      const parentDir = getParentDirectory(path);
      await get().refreshDirectory(parentDir, true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create path';
      set({
        treeError: message,
      });
      throw error;
    }
  },

  deletePath: async (paths: string | string[]) => {
    set({ treeError: null });

    const pathsToDelete = Array.isArray(paths) ? paths : [paths];

    try {
      const result = await deleteWorkspacePaths(pathsToDelete);
      if (result.failed && result.failed.length > 0) {
        const failedPaths = result.failed.map((f: { path: string; error: string }) => f.path).join(', ');
        throw new Error(`Failed to delete: ${failedPaths}`);
      }

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
            isLoadingFile: false,
            loadingFilePath: null,
            fileLoadRequestId: state.fileLoadRequestId + 1,
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
        await get().refreshDirectory(parentDir, true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete path';
      set({ treeError: message });
      throw error;
    }
  },

  renamePath: async (oldPath: string, newPath: string, overwrite = false) => {
    set({ treeError: null });

    try {
      await renameWorkspacePath(oldPath, newPath, overwrite);

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
        ...(updatedCurrentFile !== currentFile ? { currentFile: updatedCurrentFile, fileError: null } : {}),
        fileRevisions: remapFileRevisions(state.fileRevisions, oldPath, newPath),
      }));

      const parentDirs = new Set([
        getParentDirectory(oldPath),
        getParentDirectory(newPath),
      ]);
      for (const parentDir of parentDirs) {
        await get().refreshDirectory(parentDir, true);
      }

      for (const dir of getExpandedDescendantDirectories(updatedExpandedDirs, newPath)) {
        if (dir !== newPath) {
          await get().loadSubdirectory(dir, true);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to rename path';
      set({
        treeError: message,
      });
      throw error;
    }
  },

  uploadFile: async (file: File | File[], targetDir: string, pathMap?: Map<File, string>, convertParams?: (import('@/app/components/shared/ImagePreprocessDialog').ConvertParams | null)[]) => {
    set({ treeError: null, uploadProgress: 0 });
    const files = Array.isArray(file) ? file : [file];

    try {
      await uploadWorkspaceFiles({
        files,
        targetDir,
        pathMap,
        convertParams,
        onProgress: (progress) => set({ uploadProgress: progress }),
      });

      await get().refreshDirectory(targetDir, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upload files';
      set({ treeError: message });
      throw error;
    } finally {
      set({ uploadProgress: null });
    }
  },

  downloadFile: async (path: string) => {
    set({ fileError: null });

    try {
      triggerWorkspaceDownload(path);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to download file';
      set({
        fileError: message,
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
      fileRevisions: {},
      isLoadingFile: false,
      loadingFilePath: null,
      fileError: null,
      fileLoadRequestId: state.fileLoadRequestId + 1,
    }));
  },
  resetWorkspaceView: () => {
    const nextExpandedDirs = new Set<string>();
    set((state) => ({
      fileTree: [],
      isLoadingTree: false,
      treeError: null,
      selectedNode: null,
      currentFile: null,
      fileRevisions: {},
      isLoadingFile: false,
      loadingFilePath: null,
      fileLoadRequestId: state.fileLoadRequestId + 1,
      fileError: null,
      expandedDirs: nextExpandedDirs,
      currentDirectory: '.',
      uploadProgress: null,
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
    }));
    persistExplorerState({
      currentDirectory: '.',
      expandedDirs: nextExpandedDirs,
    });
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
  toggleAutoRefresh: () => {
    set((state) => ({ autoRefresh: !state.autoRefresh }));
  },

  // Multi-select actions
  toggleMultiSelectMode: () => {
    set((state) => ({ isMultiSelectMode: !state.isMultiSelectMode }));
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
