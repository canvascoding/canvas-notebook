import { create } from 'zustand';

interface EditorState {
  activePath: string | null;
  draft: string;
  baseContent: string;
  isDirty: boolean;
  isSaving: boolean;
  lastSavedAt: number | null;
  saveError: string | null;
  setActiveFile: (path: string, content: string) => void;
  updateDraft: (content: string) => void;
  syncCollaborativeDraft: (content: string) => void;
  markSaving: () => void;
  markSaved: () => void;
  setSaveError: (error: string | null) => void;
  clear: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  activePath: null,
  draft: '',
  baseContent: '',
  isDirty: false,
  isSaving: false,
  lastSavedAt: null,
  saveError: null,
  setActiveFile: (path: string, content: string) =>
    set({
      activePath: path,
      draft: content,
      baseContent: content,
      isDirty: false,
      isSaving: false,
      saveError: null,
      lastSavedAt: null,
    }),
  updateDraft: (content: string) => {
    if (content === get().draft) return;
    set({ draft: content, isDirty: true, saveError: null });
  },
  syncCollaborativeDraft: (content: string) => {
    if (content === get().draft) return;
    set({
      draft: content,
      baseContent: content,
      isDirty: false,
      isSaving: false,
      saveError: null,
    });
  },
  markSaving: () => set({ isSaving: true, saveError: null }),
  markSaved: () =>
    set((state) => ({
      baseContent: state.draft,
      isSaving: false,
      isDirty: false,
      saveError: null,
      lastSavedAt: Date.now(),
    })),
  setSaveError: (error: string | null) =>
    set({ saveError: error, isSaving: false }),
  clear: () =>
    set({
      activePath: null,
      draft: '',
      baseContent: '',
      isDirty: false,
      isSaving: false,
      saveError: null,
      lastSavedAt: null,
    }),
}));
