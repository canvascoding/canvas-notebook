import { create } from 'zustand';
import type { StudioGeneration } from '@/app/apps/studio/types/generation';

interface StudioGenerationsCacheState {
  generations: StudioGeneration[];
  currentGeneration: StudioGeneration | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  activeGenerationId: string | null;
  recentlyCompletedIds: Set<string>;
  hasMoreGenerations: boolean;
}

export const useStudioGenerationsCacheStore = create<StudioGenerationsCacheState>(() => ({
  generations: [],
  currentGeneration: null,
  loading: false,
  loadingMore: false,
  error: null,
  activeGenerationId: null,
  recentlyCompletedIds: new Set<string>(),
  hasMoreGenerations: false,
}));
