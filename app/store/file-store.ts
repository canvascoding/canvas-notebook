import { create } from 'zustand';
import type { BrowserMode, CurrentFile, FileNode, FileStats } from '@/app/lib/files/types';
import { getExtension, getParentDirectories, getParentDirectory } from '@/app/lib/files/path-utils';
import {
  findNodeInTree,
  findPathInTree,
  flattenTreePaths,
  mergeSubtreeChildren,
} from '@/app/lib/files/tree-utils';

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
    left?.permissions === right?.permissions
  );
}

interface ApiErrorPayload {
  error?: unknown;
  message?: unknown;
}

function formatResponseStatus(response: Response) {
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  return response.status ? ` (${response.status}${statusText})` : '';
}

function describeNonJsonResponse(response: Response, fallbackMessage: string, body: string) {
  const trimmed = body.trimStart().toLowerCase();
  const responseKind = trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')
    ? 'HTML'
    : 'a non-JSON response';
  return `${fallbackMessage}${formatResponseStatus(response)}: server returned ${responseKind} instead of JSON. Please retry when the server is responsive.`;
}

async function readApiJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`${fallbackMessage}${formatResponseStatus(response)}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(describeNonJsonResponse(response, fallbackMessage, body));
  }
}

async function readApiError(response: Response, fallbackMessage: string) {
  try {
    const payload = await readApiJson<ApiErrorPayload>(response, fallbackMessage);
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message;
    }
  } catch (error) {
    if (error instanceof Error) return error.message;
  }

  return `${fallbackMessage}${formatResponseStatus(response)}`;
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
      const response = await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sources: Array.from(clipboardPaths),
          destDir,
          overwrite: false,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to paste files'));
      }

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
      const response = await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sources: [path],
          destDir: parentDir,
          overwrite: false,
          renameOnCollision: true,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to duplicate file'));
      }

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
      const url = `/api/files/tree?path=${encodeURIComponent(path)}&depth=${depthTarget}${noCache ? `&noCache=${Date.now()}` : ''}`;
      const response = await fetch(url, {
        credentials: 'include',
        cache: noCache ? 'no-store' : 'default',
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to load file tree'));
      }

      const { data } = await readApiJson<{ data: FileNode[] }>(response, 'Failed to load file tree');
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
      const url = `/api/files/tree?path=.&depth=0${noCache ? `&noCache=${Date.now()}` : ''}`;
      const response = await fetch(url, {
        credentials: 'include',
        cache: noCache ? 'no-store' : 'default',
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to refresh root tree'));
      }

      const { data } = await readApiJson<{ data: FileNode[] }>(response, 'Failed to refresh root tree');

      // Merge: preserve existing children from current tree so expanded
      // folders don't appear empty after a root-level refresh (depth=0).
      const currentTree = get().fileTree;
      const oldNodesByPath = new Map<string, FileNode>();
      for (const node of currentTree) {
        oldNodesByPath.set(node.path, node);
      }
      const mergedTree = data.map((newNode: FileNode) => {
        if (newNode.type === 'directory') {
          const existing = oldNodesByPath.get(newNode.path);
          if (existing?.children) {
            return { ...newNode, children: existing.children };
          }
        }
        return newNode;
      });

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

    const dirsToRefresh = new Set<string>();
    if (currentDirectory !== '.') {
      for (const dirPath of getParentDirectories(`${currentDirectory}/_`)) {
        dirsToRefresh.add(dirPath);
      }
      dirsToRefresh.add(currentDirectory);
    }

    if (browserMode === 'tree') {
      for (const dirPath of expandedDirs) {
        if (dirPath !== '.') dirsToRefresh.add(dirPath);
      }
    }

    const sortedDirs = Array.from(dirsToRefresh).sort((a, b) => {
      const depthDiff = a.split('/').length - b.split('/').length;
      return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
    });

    for (const dirPath of sortedDirs) {
      const parentDir = getParentDirectory(dirPath);
      const tree = get().fileTree;
      const parentExists = parentDir === '.'
        ? tree.some((node) => node.path === dirPath.split('/')[0] && node.type === 'directory')
        : findPathInTree(parentDir, tree);

      if (parentExists) {
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
      const url = `/api/files/tree?path=${encodeURIComponent(dirPath)}&depth=1${noCache ? `&noCache=${Date.now()}` : ''}`;
      const response = await fetch(url, {
        credentials: 'include',
        cache: noCache ? 'no-store' : 'default',
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to load subdirectory'));
      }

      const { data } = await readApiJson<{ data: FileNode[] }>(response, 'Failed to load subdirectory');

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

      let url = `/api/files/read?path=${encodeURIComponent(path)}${useMetaOnly ? '&meta=1' : ''}`;
      if (noCache) {
        url += `&t=${Date.now()}`; // Cache-busting parameter
      }
      
      const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store', // Aggressively disable browser caching
      });

      if (!response.ok) {
        // If the file is not found (404), clear the editor instead of showing an error.
        if (response.status === 404) {
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
        throw new Error(await readApiError(response, 'Failed to load file'));
      }

      const { data } = await readApiJson<{ data: CurrentFile }>(response, 'Failed to load file');
      if (get().fileLoadRequestId !== requestId) return;

      const fileName = path.split('/').pop() || path;
      set({
        selectedNode: { path, type: 'file', name: fileName },
        currentFile: {
          path,
          content: data.content,
          stats: data.stats,
        },
        isLoadingFile: false,
        loadingFilePath: null,
      });
    } catch (error) {
      if (get().fileLoadRequestId !== requestId) return;
      const message =
        error instanceof Error ? error.message : 'Failed to load file';
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
      const response = await fetch(`/api/files/read?path=${encodeURIComponent(path)}&t=${Date.now()}`, {
        credentials: 'include',
        cache: 'no-store',
      });

      if (!response.ok) {
        if (response.status === 404 && get().currentFile?.path === path) {
          set({
            currentFile: null,
            fileError: null,
          });
          return null;
        }

        throw new Error(await readApiError(response, 'Failed to refresh file'));
      }

      const { data } = await readApiJson<{ data: CurrentFile }>(response, 'Failed to refresh file');
      const currentFile = get().currentFile;
      if (currentFile?.path !== path) {
        return null;
      }

      const refreshedFile: CurrentFile = {
        ...currentFile,
        content: data.content,
        stats: data.stats,
      };

      if (
        currentFile.content !== refreshedFile.content ||
        !areFileStatsEqual(currentFile.stats, refreshedFile.stats)
      ) {
        set({
          currentFile: refreshedFile,
          fileError: null,
        });
      }

      return refreshedFile;
    } catch (error) {
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

  saveFile: async (path: string, content: string) => {
    set({ fileError: null });

    try {
      const response = await fetch('/api/files/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ path, content }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to save file'));
      }

      // Update current file if it's the same path
      const { currentFile } = get();
      if (currentFile?.path === path) {
        set({
          currentFile: {
            ...currentFile,
            content,
          },
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save file';
      set({
        fileError: message,
      });
      throw error;
    }
  },

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
      const response = await fetch('/api/files/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ path, type, ...options }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to create path'));
      }

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
      const response = await fetch('/api/files/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path: pathsToDelete }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to delete paths'));
      }

      const result = await readApiJson<{ failed?: Array<{ path: string; error: string }> }>(response, 'Failed to delete paths');
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

      set({ multiSelectPaths: new Set(), isMultiSelectMode: false });

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
      const response = await fetch('/api/files/rename', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ oldPath, newPath, overwrite }),
      });

      if (!response.ok) {
        const error = await readApiJson<ApiErrorPayload & {
          code?: string;
          type?: string;
          sourcePath?: string;
          destPath?: string;
        }>(response, 'Failed to rename path');
        // Create a more detailed error with additional fields
        const message = typeof error.error === 'string' && error.error.trim()
          ? error.error
          : 'Failed to rename path';
        const err = new Error(message) as Error & {
          code?: string;
          type?: string;
          sourcePath?: string;
          destPath?: string;
        };
        err.code = error.code;
        err.type = error.type;
        err.sourcePath = error.sourcePath;
        err.destPath = error.destPath;
        throw err;
      }

      const { expandedDirs, selectedNode, currentFile, currentDirectory, setCurrentDirectory } = get();

      const isDescendant = (p: string) =>
        p === oldPath || p.startsWith(oldPath + '/');
      const remapPath = (p: string) =>
        p === oldPath ? newPath : p.replace(oldPath + '/', newPath + '/');

      let updatedExpandedDirs = expandedDirs;
      if (expandedDirs.has(oldPath) || [...expandedDirs].some(isDescendant)) {
        const remapped = new Set<string>();
        for (const dir of expandedDirs) {
          remapped.add(isDescendant(dir) ? remapPath(dir) : dir);
        }
        updatedExpandedDirs = remapped;
        get().setExpandedDirs(updatedExpandedDirs);
      }

      if (currentDirectory === oldPath || currentDirectory.startsWith(oldPath + '/')) {
        setCurrentDirectory(remapPath(currentDirectory));
      }

      const updatedSelectedNode = selectedNode
        ? (isDescendant(selectedNode.path) ? { ...selectedNode, path: remapPath(selectedNode.path) } : selectedNode)
        : null;
      const updatedCurrentFile = currentFile && isDescendant(currentFile.path)
        ? { ...currentFile, path: remapPath(currentFile.path) }
        : currentFile;
      set({
        selectedNode: updatedSelectedNode,
        ...(updatedCurrentFile !== currentFile ? { currentFile: updatedCurrentFile, fileError: null } : {}),
      });

      const parentDirs = new Set([
        getParentDirectory(oldPath),
        getParentDirectory(newPath),
      ]);
      for (const parentDir of parentDirs) {
        await get().refreshDirectory(parentDir, true);
      }

      const childExpandedDirs = [...updatedExpandedDirs]
        .filter(d => d === newPath || d.startsWith(newPath + '/'))
        .sort((a, b) => a.split('/').length - b.split('/').length);

      for (const dir of childExpandedDirs) {
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
    const totalUploadBytes = files.reduce((total, currentFile) => total + currentFile.size, 0);

    try {
      const formData = new FormData();
      formData.append('path', targetDir);

      for (const f of files) {
        const filePath = pathMap?.get(f) || (f as { webkitRelativePath?: string }).webkitRelativePath || f.name;
        formData.append('files', f, filePath);
      }

      if (convertParams && convertParams.length === files.length) {
        const paramsForAll: ({ format: string; quality: number; maxDimension?: number } | null)[] = convertParams.map((p) =>
          p ? { format: p.format, quality: p.quality, maxDimension: p.maxDimension } : null
        );
        formData.append('convertParams', JSON.stringify(paramsForAll));
      }

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/files/upload', true);
        xhr.withCredentials = true;

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const overall = Math.round((event.loaded / event.total) * 100);
            set({ uploadProgress: overall });
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            try {
              const error = JSON.parse(xhr.responseText) as { error?: unknown; code?: unknown };
              if (error.code === 'FORMDATA_PARSE_ERROR') {
                console.warn('[FileStore] Upload FormData parse error', {
                  endpoint: '/api/files/upload',
                  status: xhr.status,
                  fileCount: files.length,
                  totalBytes: totalUploadBytes,
                  hasPathMap: Boolean(pathMap),
                  hasConvertParams: Boolean(convertParams?.length),
                });
              }
              reject(new Error(typeof error.error === 'string' ? error.error : `Upload failed with status ${xhr.status}`));
            } catch {
              reject(new Error(`Upload failed with status ${xhr.status}`));
            }
          }
        };

        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(formData);
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
      const url = `/api/files/download?path=${encodeURIComponent(path)}&download=1`;
      const anchor = document.createElement('a');
      const name = path.split('/').pop() || 'download';
      anchor.href = url;
      anchor.download = name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
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
      isLoadingFile: false,
      loadingFilePath: null,
      fileError: null,
      fileLoadRequestId: state.fileLoadRequestId + 1,
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
    const allPaths = flattenTreePaths(currentTree);
    const startIndex = allPaths.indexOf(startPath);
    const endIndex = allPaths.indexOf(endPath);

    if (startIndex === -1 || endIndex === -1) return;

    const start = Math.min(startIndex, endIndex);
    const end = Math.max(startIndex, endIndex);
    const rangePaths = allPaths.slice(start, end + 1);

    set((state) => {
      const newMultiSelectPaths = new Set(state.multiSelectPaths);
      for (const p of rangePaths) newMultiSelectPaths.add(p);
      return { multiSelectPaths: newMultiSelectPaths };
    });
  },

  selectAllInDirectory: (dirPath: string) => {
    const { fileTree } = get();
    
    const findDirectory = (nodes: FileNode[], path: string): FileNode | null => {
      for (const node of nodes) {
        if (node.path === path) return node;
        if (node.children) {
          const found = findDirectory(node.children, path);
          if (found) return found;
        }
      }
      return null;
    };

    const dir = dirPath === '.' ? { children: fileTree } : findDirectory(fileTree, dirPath);
    if (dir && dir.children) {
      const childPaths = dir.children.map((child) => child.path);
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
