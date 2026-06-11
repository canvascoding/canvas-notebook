const STORAGE_KEY = 'canvas.chat.composerDrafts.v1';
const MAX_DRAFTS = 30;

export interface ComposerDraftEntry {
  text: string;
  updatedAt: number;
}

function loadDraftMap(): Record<string, ComposerDraftEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveDraftMap(map: Record<string, ComposerDraftEntry>) {
  if (typeof window === 'undefined') return;
  const keys = Object.keys(map);
  if (keys.length > MAX_DRAFTS) {
    const sorted = keys.sort((a, b) => (map[a]?.updatedAt ?? 0) - (map[b]?.updatedAt ?? 0));
    const trimmed: Record<string, ComposerDraftEntry> = {};
    sorted.slice(-MAX_DRAFTS).forEach((k) => {
      trimmed[k] = map[k];
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (error) {
    console.warn('[ComposerDraft] Failed to persist drafts to localStorage', error);
  }
}

export function saveComposerDraft(key: string, text: string) {
  const map = loadDraftMap();
  map[key] = { text, updatedAt: Date.now() };
  saveDraftMap(map);
}

export function loadComposerDraft(key: string): string | null {
  const map = loadDraftMap();
  return map[key]?.text ?? null;
}

export function removeComposerDraft(key: string) {
  const map = loadDraftMap();
  delete map[key];
  saveDraftMap(map);
}

export function clearComposerDrafts() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}
