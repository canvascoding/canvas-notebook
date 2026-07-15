'use client';

import { create } from 'zustand';

import type { FilePresenceEntry, WorkspacePresenceMessage, WorkspacePresenceSnapshot } from '@/app/lib/collaboration/types';

type FilePresenceState = {
  workspaceId: string | null;
  version: number;
  byPath: Record<string, FilePresenceEntry[]>;
  replaceSnapshot: (snapshot: WorkspacePresenceSnapshot) => void;
  applyMessage: (message: WorkspacePresenceMessage) => void;
  clear: () => void;
};

export const useFilePresenceStore = create<FilePresenceState>((set) => ({
  workspaceId: null,
  version: 0,
  byPath: {},
  replaceSnapshot: (snapshot) => set(() => {
    const byPath: Record<string, FilePresenceEntry[]> = {};
    for (const entry of snapshot.entries) (byPath[entry.path] ??= []).push(entry);
    return { workspaceId: snapshot.workspaceId, version: snapshot.version, byPath };
  }),
  applyMessage: (message) => set((state) => {
    if (message.type === 'snapshot') {
      const byPath: Record<string, FilePresenceEntry[]> = {};
      for (const entry of message.entries) (byPath[entry.path] ??= []).push(entry);
      return { workspaceId: message.workspaceId, version: message.version, byPath };
    }
    const remaining = Object.values(state.byPath).flat().filter((entry) => entry.documentId !== message.documentId);
    const byPath: Record<string, FilePresenceEntry[]> = {};
    for (const entry of [...remaining, ...message.entries]) (byPath[entry.path] ??= []).push(entry);
    return { workspaceId: message.workspaceId, version: message.version, byPath };
  }),
  clear: () => set({ workspaceId: null, version: 0, byPath: {} }),
}));
