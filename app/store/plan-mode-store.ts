import { create } from 'zustand';

const STORAGE_KEY = 'canvas-planning-mode';

interface PlanModeState {
  planningMode: boolean;
  togglePlanningMode: () => void;
  setPlanningMode: (value: boolean) => void;
}

function readFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeToStorage(value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // ignore
  }
}

export const usePlanModeStore = create<PlanModeState>(() => ({
  planningMode: readFromStorage(),
  togglePlanningMode: () => {
    usePlanModeStore.setState((state) => {
      const next = !state.planningMode;
      writeToStorage(next);
      return { planningMode: next };
    });
  },
  setPlanningMode: (value: boolean) => {
    writeToStorage(value);
    usePlanModeStore.setState({ planningMode: value });
  },
}));
