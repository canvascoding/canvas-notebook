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

interface FileStoreState {
  // File tree
  fileTree: FileNode[];
  isLoadingTree: boolean;
  treeError: string | null;

  // Selection
  selectedNode: {
    path: string;
    type: 'file' | 'directory';
  } | null;

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

  // Actions
  loadFileTree: (path?: string, depth?: number) => Promise<void>;
  loadFile: (path: string) => Promise<void>;
  saveFile: (path: string, content: string) => Promise<void>;
  selectNode: (node: FileNode) => void;
  createPath: (path: string, type: 'file' | 'directory') => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  renamePath: (oldPath: string, newPath: string) => Promise<void>;
  uploadFile: (file: File | File[], targetDir: string) => Promise<void>;
  downloadFile: (path: string) => Promise<void>;
  toggleDirectory: (path: string) => void;
  collapseAllDirectories: () => void;
  clearCurrentFile: () => void;
  setSearchQuery: (query: string) => void;
  toggleAutoRefresh: () => void;
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

  // Actions
  loadFileTree: async (path = '.', depth?: number) => {
    set({ isLoadingTree: true, treeError: null });
    const activeDir = path === '.' ? get().currentDirectory : path;
    const depthTarget =
      typeof depth === 'number'
        ? depth
        : Math.max(
            6,
            (activeDir === '.' ? 0 : activeDir.split('/').filter(Boolean).length) + 2
          );

    try {
      const response = await fetch(
        `/api/files/tree?path=${encodeURIComponent(path)}&depth=${depthTarget}`,
        { credentials: 'include' }
      );

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

  loadFile: async (path: string) => {
    set({ isLoadingFile: true, fileError: null });

    try {
      const extension = getExtension(path);
      const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
      const useMetaOnly = !isText;

      const response = await fetch(
        `/api/files/read?path=${encodeURIComponent(path)}${useMetaOnly ? '&meta=1' : ''}`,
        { credentials: 'include' }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to load file');
      }

      const { data } = await response.json();
      set({
        selectedNode: { path, type: 'file' },
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

  selectNode: (node: FileNode) => {
    const nextDir =
      node.type === 'directory'
        ? node.path
        : node.path.includes('/')
          ? node.path.slice(0, node.path.lastIndexOf('/'))
          : '.';
    set({
      selectedNode: { path: node.path, type: node.type },
      currentDirectory: nextDir || '.',
    });
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

      await get().loadFileTree();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create path';
      set({
        treeError: message,
      });
      throw error;
    }
  },

  deletePath: async (path: string) => {
    set({ treeError: null });

    try {
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
        throw new Error(error.error || 'Failed to delete path');
      }

      const { selectedNode, currentFile } = get();
      if (selectedNode?.path === path) {
        set({ selectedNode: null });
      }
      if (currentFile?.path === path) {
        set({ currentFile: null });
      }

      await get().loadFileTree();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to delete path';
      set({
        treeError: message,
      });
      throw error;
    }
  },

  renamePath: async (oldPath: string, newPath: string) => {
    set({ treeError: null });

    try {
      const response = await fetch('/api/files/rename', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ oldPath, newPath }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to rename path');
      }

      const { selectedNode, currentFile } = get();
      if (selectedNode?.path === oldPath) {
        set({ selectedNode: { path: newPath, type: selectedNode.type } });
      }
      if (currentFile?.path === oldPath) {
        set({ currentFile: { ...currentFile, path: newPath } });
      }

      await get().loadFileTree();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to rename path';
      set({
        treeError: message,
      });
      throw error;
    }
  },

  uploadFile: async (file: File | File[], targetDir: string) => {
    set({ treeError: null });
    const files = Array.isArray(file) ? file : [file];

    try {
      set({ uploadProgress: 0 });
      for (let index = 0; index < files.length; index += 1) {
        const nextFile = files[index];
        await new Promise<void>((resolve, reject) => {
          const formData = new FormData();
          formData.append('file', nextFile);
          formData.append('path', targetDir);

          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/files/upload', true);
          xhr.withCredentials = true;

          xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;
            const percent = Math.round((event.loaded / event.total) * 100);
            const overall = Math.round(((index + percent / 100) / files.length) * 100);
            set({ uploadProgress: overall });
          };

          xhr.onload = async () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
              return;
            }
            try {
              const error = JSON.parse(xhr.responseText);
              reject(new Error(error.error || 'Failed to upload file'));
            } catch {
              reject(new Error('Failed to upload file'));
            }
          };

          xhr.onerror = () => {
            reject(new Error('Failed to upload file'));
          };

          xhr.send(formData);
        });
      }

      await get().loadFileTree();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to upload file';
      set({
        treeError: message,
        uploadProgress: null,
      });
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
    } else {
      newExpanded.add(path);
    }

    set({ expandedDirs: newExpanded });
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
  toggleAutoRefresh: () => {
    set((state) => ({ autoRefresh: !state.autoRefresh }));
  },
}));
