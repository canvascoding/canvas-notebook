import { create } from 'zustand';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  permissions?: string;
  children?: FileNode[];
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
]);

function getExtension(path: string) {
  const parts = path.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}

export function findPathInTree(searchPath: string, tree: FileNode[]): boolean {
  if (searchPath === '.') return true;
  for (const node of tree) {
    if (node.path === searchPath) return true;
    if (node.children && findPathInTree(searchPath, node.children)) return true;
  }
  return false;
}

interface FileStoreState {
  // File tree
  fileTree: FileNode[];
  isLoadingTree: boolean;
  treeError: string | null;

  // Selection
  selectedNode: FileNode | null;

  // Current file
  currentFile: {
    path: string;
    content: string;
    stats?: {
      size: number;
      modified: number;
      permissions: string;
    };
  } | null;
  isLoadingFile: boolean;
  fileError: string | null;

  // Expanded directories
  expandedDirs: Set<string>;
  currentDirectory: string;
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
  openContextMenu: (node: FileNode) => void;
  closeContextMenu: () => void;

  // Mobile UI state
  mobileSurface: 'files' | 'editor' | null;
  setMobileSurface: (surface: 'files' | 'editor' | null) => void;
  mobileFileOpened: () => void;

  // Bulk move dialog state
  bulkMoveOpen: boolean;
  setBulkMoveOpen: (open: boolean) => void;

  // Clipboard state for copy/paste
  clipboardPaths: Set<string>;
  clipboardMode: 'copy' | null;
  copyPaths: () => void;
  pastePaths: (destDir: string) => Promise<void>;
  duplicatePath: (path: string) => Promise<void>;

  // Actions
  loadFileTree: (path?: string, depth?: number, noCache?: boolean) => Promise<void>;
  loadSubdirectory: (dirPath: string) => Promise<void>;
  loadFile: (path: string, noCache?: boolean) => Promise<void>;
  saveFile: (path: string, content: string) => Promise<void>;
  selectNode: (node: FileNode, ctrlOrMeta?: boolean, shiftKey?: boolean) => void;
  createPath: (path: string, type: 'file' | 'directory') => Promise<void>;
  deletePath: (path: string | string[]) => Promise<void>;
  renamePath: (oldPath: string, newPath: string, overwrite?: boolean) => Promise<void>;
  uploadFile: (file: File | File[], targetDir: string, pathMap?: Map<File, string>) => Promise<void>;
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
  isLoadingFile: false,
  fileError: null,

  expandedDirs: new Set<string>(),
  currentDirectory: '.',
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
  openContextMenu: (node: FileNode) => {
    set({ contextMenuNode: node });
  },
  closeContextMenu: () => {
    set({ contextMenuNode: null });
  },

  // Mobile UI state
  mobileSurface: null,
  setMobileSurface: (surface: 'files' | 'editor' | null) => {
    set({ mobileSurface: surface });
  },
  mobileFileOpened: () => {
    set({ mobileSurface: 'editor' });
  },

  // Bulk move dialog state
  bulkMoveOpen: false,
  setBulkMoveOpen: (open: boolean) => {
    set({ bulkMoveOpen: open });
  },

  // Clipboard state
  clipboardPaths: new Set<string>(),
  clipboardMode: null,
  copyPaths: () => {
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
        const error = await response.json();
        throw new Error(error.error || 'Failed to paste files');
      }

      await get().loadFileTree(destDir, undefined, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to paste files';
      set({ treeError: message });
      throw error;
    }
  },
  duplicatePath: async (path: string) => {
    const parentDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '.';

    try {
      const response = await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sources: [path],
          destDir: parentDir,
          overwrite: false,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to duplicate file');
      }

      await get().loadFileTree(parentDir, undefined, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to duplicate file';
      set({ treeError: message });
      throw error;
    }
  },

  // Actions
  loadFileTree: async (path = '.', depth?: number, noCache = false) => {
    const { fileTree, currentDirectory, setCurrentDirectory } = get();

    let activeDir = path === '.' ? currentDirectory : path;

    if (activeDir !== '.' && fileTree.length > 0 && !findPathInTree(activeDir, fileTree)) {
      console.warn(`Directory "${activeDir}" not found in current tree. Fetching from root.`);
      activeDir = '.';
      setCurrentDirectory('.');
    }

    set({ isLoadingTree: true, treeError: null });

    const depthTarget = typeof depth === 'number' ? depth : 4;

    try {
      const url = `/api/files/tree?path=${encodeURIComponent(activeDir)}&depth=${depthTarget}${noCache ? `&noCache=${Date.now()}` : ''}`;
      const response = await fetch(url, {
        credentials: 'include',
        cache: noCache ? 'no-store' : 'default',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to load file tree');
      }

      const { data } = await response.json();
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

  loadSubdirectory: async (dirPath: string) => {
    const { loadingDirs, expandedDirs, fileTree } = get();
    if (loadingDirs.has(dirPath)) return;

    const findNodeInTree = (searchPath: string, nodes: FileNode[]): FileNode | null => {
      for (const node of nodes) {
        if (node.path === searchPath) return node;
        if (node.children) {
          const found = findNodeInTree(searchPath, node.children);
          if (found) return found;
        }
      }
      return null;
    };

    const existingNode = findNodeInTree(dirPath, fileTree);
    if (existingNode && existingNode.children && existingNode.children.length > 0) {
      if (!expandedDirs.has(dirPath)) {
        const newExpanded = new Set(expandedDirs);
        newExpanded.add(dirPath);
        set({ expandedDirs: newExpanded });
      }
      return;
    }

    const newLoading = new Set(loadingDirs);
    newLoading.add(dirPath);
    set({ loadingDirs: newLoading });

    try {
      const url = `/api/files/tree?path=${encodeURIComponent(dirPath)}&depth=1`;
      const response = await fetch(url, { credentials: 'include' });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to load subdirectory');
      }

      const { data } = await response.json();

      const mergeSubtree = (nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] => {
        return nodes.map((node) => {
          if (node.path === targetPath) {
            return { ...node, children };
          }
          if (node.children) {
            return { ...node, children: mergeSubtree(node.children, targetPath, children) };
          }
          return node;
        });
      };

      const newTree = mergeSubtree(fileTree, dirPath, data);
      const newExpanded = new Set(expandedDirs);
      newExpanded.add(dirPath);

      const newLoading = new Set(loadingDirs);
      newLoading.delete(dirPath);

      set({ fileTree: newTree, expandedDirs: newExpanded, loadingDirs: newLoading });
    } catch (error) {
      const newLoading = new Set(loadingDirs);
      newLoading.delete(dirPath);
      set({ loadingDirs: newLoading });
      console.error('Failed to load subdirectory:', error);
    }
  },

  loadFile: async (path: string, noCache = false) => {
    set({ isLoadingFile: true, fileError: null });

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
          set({ currentFile: null, isLoadingFile: false, fileError: null });
          return;
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to load file');
      }

      const { data } = await response.json();
      const fileName = path.split('/').pop() || path;
      set({
        selectedNode: { path, type: 'file', name: fileName },
        currentFile: {
          path,
          content: data.content,
          stats: data.stats,
        },
        isLoadingFile: false,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load file';
      set({
        fileError: message,
        isLoadingFile: false,
      });
    }
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
        const error = await response.json();
        throw new Error(error.error || 'Failed to save file');
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
    }
  },

  createPath: async (path: string, type: 'file' | 'directory') => {
    set({ treeError: null });

    try {
      const response = await fetch('/api/files/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ path, type }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create path');
      }

      // Refresh from parent directory
      const parentDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '.';
      await get().loadFileTree(parentDir, undefined, true);
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
    let deepestCommonParent = '.';
    
    if (pathsToDelete.length > 0) {
      // Find parent of the first path as a starting point
      const firstPath = pathsToDelete[0];
      deepestCommonParent = firstPath.includes('/') ? firstPath.substring(0, firstPath.lastIndexOf('/')) : '.';
    }

    try {
      for (const path of pathsToDelete) {
        const response = await fetch('/api/files/delete', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ path }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || `Failed to delete path: ${path}`);
        }

        const { selectedNode, currentFile, currentDirectory, setCurrentDirectory } = get();
        
        // If we deleted the current directory or a parent of it, reset current directory
        if (currentDirectory === path || currentDirectory.startsWith(path + '/')) {
          const newDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '.';
          setCurrentDirectory(newDir);
        }

        if (selectedNode?.path === path) {
          set({ selectedNode: null });
        }
        if (currentFile?.path === path) {
          set({ currentFile: null });
        }
      }

      // Clear multi-select after successful deletion
      set({ multiSelectPaths: new Set(), isMultiSelectMode: false });

      // Refresh from the common parent to keep context
      await get().loadFileTree(deepestCommonParent, undefined, true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to delete path';
      set({
        treeError: message,
      });
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
        const error = await response.json();
        // Create a more detailed error with additional fields
        const err = new Error(error.error || 'Failed to rename path') as Error & {
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

      const { selectedNode, currentFile, currentDirectory, setCurrentDirectory } = get();
      
      if (currentDirectory === oldPath || currentDirectory.startsWith(oldPath + '/')) {
        const updatedDir = currentDirectory.replace(oldPath, newPath);
        setCurrentDirectory(updatedDir);
      }

      if (selectedNode?.path === oldPath) {
        set({ selectedNode: null });
      }
      if (currentFile?.path === oldPath) {
        set({ currentFile: null, fileError: null });
      }

      const parentDir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : '.';
      await get().loadFileTree(parentDir, undefined, true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to rename path';
      set({
        treeError: message,
      });
      throw error;
    }
  },

  uploadFile: async (file: File | File[], targetDir: string, pathMap?: Map<File, string>) => {
    set({ treeError: null, uploadProgress: 0 });
    const files = Array.isArray(file) ? file : [file];
    const total = files.length;

    try {
      for (let i = 0; i < total; i++) {
        const f = files[i];
        const filePath = pathMap?.get(f) || (f as { webkitRelativePath?: string }).webkitRelativePath || f.name;

        const formData = new FormData();
        formData.append('path', targetDir);
        formData.append('files', f, filePath);

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/files/upload', true);
          xhr.withCredentials = true;

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const filePercent = event.loaded / event.total;
              const overall = Math.round(((i + filePercent) / total) * 100);
              set({ uploadProgress: overall });
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              try {
                const error = JSON.parse(xhr.responseText);
                reject(new Error(error.error || `Upload failed with status ${xhr.status}`));
              } catch {
                reject(new Error(`Upload failed with status ${xhr.status}`));
              }
            }
          };

          xhr.onerror = () => reject(new Error('Network error during upload'));
          xhr.send(formData);
        });
      }

      await get().loadFileTree('.', undefined, true);
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
      set({ expandedDirs: newExpanded });
    } else {
      get().loadSubdirectory(path);
    }
  },
  collapseAllDirectories: () => {
    set({ expandedDirs: new Set<string>() });
  },

  clearCurrentFile: () => {
    set({ currentFile: null, fileError: null });
  },
  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },
  setCurrentDirectory: (path: string) => {
    set({ currentDirectory: path });
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
    const flattenTree = (nodes: FileNode[], result: string[] = []): string[] => {
      for (const node of nodes) {
        result.push(node.path);
        if (node.children) {
          flattenTree(node.children, result);
        }
      }
      return result;
    };

    const allPaths = flattenTree(currentTree);
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
