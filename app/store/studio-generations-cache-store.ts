import { create } from 'zustand';
import type { StudioCreator, StudioGeneration } from '@/app/apps/studio/types/generation';

interface StudioGenerationsCacheState {
  workspaceId: string | null;
  generations: StudioGeneration[];
  currentGeneration: StudioGeneration | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  activeGenerationId: string | null;
  recentlyCompletedIds: Set<string>;
  hasMoreGenerations: boolean;
  loadedServerGenerationCount: number;
  creators: StudioCreator[];
  resetForWorkspace: (workspaceId: string | null) => void;
}

const emptyStudioGenerationsState = (workspaceId: string | null) => ({
  workspaceId,
  generations: [],
  currentGeneration: null,
  loading: false,
  loadingMore: false,
  error: null,
  activeGenerationId: null,
  recentlyCompletedIds: new Set<string>(),
  hasMoreGenerations: false,
  loadedServerGenerationCount: 0,
  creators: [],
});

export const useStudioGenerationsCacheStore = create<StudioGenerationsCacheState>((set, get) => ({
  ...emptyStudioGenerationsState(null),
  resetForWorkspace: (workspaceId) => {
    if (get().workspaceId === workspaceId) return;
    set(emptyStudioGenerationsState(workspaceId));
  },
}));
