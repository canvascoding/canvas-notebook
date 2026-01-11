import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface TerminalSession {
  id: string;
  title: string;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  hydrated: boolean;
  createSession: () => string;
  closeSession: (id: string) => void;
  clearSessions: () => void;
  setActiveSession: (id: string) => void;
  setHydrated: (hydrated: boolean) => void;
}

function generateId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeSessionId: null,
      hydrated: false,
      createSession: () => {
        const id = generateId();
        const title = `Terminal ${get().sessions.length + 1}`;
        set((state) => ({
          sessions: [...state.sessions, { id, title }],
          activeSessionId: id,
        }));
        return id;
      },
      closeSession: (id: string) => {
        set((state) => {
          const nextSessions = state.sessions.filter((session) => session.id !== id);
          const nextActive =
            state.activeSessionId === id
              ? nextSessions[0]?.id ?? null
              : state.activeSessionId;
          return { sessions: nextSessions, activeSessionId: nextActive };
        });
      },
      clearSessions: () => set({ sessions: [], activeSessionId: null }),
      setActiveSession: (id: string) => set({ activeSessionId: id }),
      setHydrated: (hydrated: boolean) => set({ hydrated }),
    }),
    {
      name: 'canvas.terminalSessions',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('[Terminal] Failed to rehydrate sessions', error);
        }
        state?.setHydrated(true);
      },
    }
  )
);
