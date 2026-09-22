import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '@/app/store/workspace-store';

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

export function composerDraftScope(workspaceId = useWorkspaceStore.getState().activeWorkspaceId): string | null {
  const auth = openedDocumentAuthScope();
  return auth && workspaceId ? JSON.stringify([auth.userId, workspaceId]) : null;
}

export function saveComposerDraft(key: string, text: string, scope = composerDraftScope()) {
  if (!scope) return;
  const map = loadDraftMap();
  map[JSON.stringify([scope, key])] = { text, updatedAt: Date.now() };
  saveDraftMap(map);
}

export function loadComposerDraft(key: string, scope = composerDraftScope()): string | null {
  if (!scope) return null;
  const map = loadDraftMap();
  return map[JSON.stringify([scope, key])]?.text ?? null;
}

export function removeComposerDraft(key: string, scope = composerDraftScope()) {
  if (!scope) return;
  const map = loadDraftMap();
  delete map[JSON.stringify([scope, key])];
  saveDraftMap(map);
}

export function clearComposerDrafts() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}
