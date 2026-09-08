'use client';

import { create } from 'zustand';
import { useWorkspaceStore } from './workspace-store';
import { isSameOrDescendantPath } from '@/app/lib/files/path-utils';
import { remapPath } from '@/app/lib/files/path-mutation-state';

import type { FilePresenceEntry, WorkspacePresenceMessage, WorkspacePresenceSnapshot } from '@/app/lib/collaboration/types';

type FilePresenceState = {
  workspaceId: string | null;
  version: number;
  byPath: Record<string, FilePresenceEntry[]>;
  removedPaths: Set<string>;
  removePaths: (paths: string[]) => void;
  restorePath: (path: string) => void;
  renamePath: (oldPath: string, newPath: string) => void;
  replaceSnapshot: (snapshot: WorkspacePresenceSnapshot) => void;
  applyMessage: (message: WorkspacePresenceMessage) => void;
  clear: () => void;
};

export const useFilePresenceStore = create<FilePresenceState>((set) => ({
  workspaceId: null,
  version: 0,
  byPath: {},
  removedPaths: new Set(),
  replaceSnapshot: (snapshot) => useFilePresenceStore.getState().applyMessage({ type: 'snapshot', ...snapshot }),
  applyMessage: (message) => set((state) => {
    if (message.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return state;
    if (message.workspaceId === state.workspaceId && message.version < state.version) return state;
    const remaining = message.type === 'snapshot' ? [] : Object.values(state.byPath).flat().filter((entry) => entry.documentId !== message.documentId);
    const byPath: Record<string, FilePresenceEntry[]> = {};
    for (const entry of [...remaining, ...message.entries]) {
      if ([...state.removedPaths].some((path) => isSameOrDescendantPath(entry.path, path))) continue;
      (byPath[entry.path] ??= []).push(entry);
    }
    return { workspaceId: message.workspaceId, version: message.version, byPath };
  }),
  removePaths: (paths) => set((state) => ({
    removedPaths: new Set([...state.removedPaths, ...paths]),
    byPath: Object.fromEntries(Object.entries(state.byPath).filter(([path]) => !paths.some((removed) => isSameOrDescendantPath(path, removed)))),
  })),
  restorePath: (path) => set((state) => ({ removedPaths: new Set([...state.removedPaths].filter((removed) => !isSameOrDescendantPath(path, removed) && !isSameOrDescendantPath(removed, path))) })),
  renamePath: (oldPath, newPath) => set((state) => {
    const byPath: Record<string, FilePresenceEntry[]> = {};
    for (const entry of Object.values(state.byPath).flat()) {
      const path = remapPath(entry.path, oldPath, newPath);
      (byPath[path] ??= []).push({ ...entry, path });
    }
    return { byPath };
  }),
  clear: () => set({ workspaceId: null, version: 0, byPath: {}, removedPaths: new Set() }),
}));
