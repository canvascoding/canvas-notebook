import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { parseChatBody, projectChatBodyText, type ChatBodyV1 } from './chat-body-contracts';

const STORAGE_KEY = 'canvas.chat.composerDrafts.v1';
const MAX_DRAFTS = 30;

export interface ComposerDraftEntry {
  text: string;
  body?: ChatBodyV1;
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

export function saveComposerDraft(key: string, text: string, scope = composerDraftScope(), body?: ChatBodyV1) {
  if (!scope) return;
  const capturedBody = body === undefined ? undefined : parseChatBody(body);
  if (capturedBody && projectChatBodyText(capturedBody) !== text) throw new Error('The draft text does not match its inline body.');
  const map = loadDraftMap();
  map[JSON.stringify([scope, key])] = { text, ...(capturedBody === undefined ? {} : { body: capturedBody }), updatedAt: Date.now() };
  saveDraftMap(map);
}

export function loadComposerDraft(key: string, scope = composerDraftScope()): string | null {
  if (!scope) return null;
  const map = loadDraftMap();
  const entry = map[JSON.stringify([scope, key])];
  if (!entry || typeof entry.text !== 'string') return null;
  if (entry.body !== undefined && !loadComposerDraftBody(key, scope)) return null;
  return entry.text;
}

/** Plain legacy drafts have no body. An invalid structured draft never flattens into a valid one. */
export function loadComposerDraftBody(key: string, scope = composerDraftScope()): ChatBodyV1 | null {
  if (!scope) return null;
  const entry = loadDraftMap()[JSON.stringify([scope, key])];
  if (!entry || entry.body === undefined) return null;
  try {
    const body = parseChatBody(entry.body);
    return projectChatBodyText(body) === entry.text ? body : null;
  } catch { return null; }
}

export function removeComposerDraft(key: string, scope = composerDraftScope()) {
  if (!scope) return;
  const map = loadDraftMap();
  delete map[JSON.stringify([scope, key])];
  saveDraftMap(map);
}

/** An older ACK cannot erase a draft that another window saved meanwhile. */
export function removeComposerDraftIfUnchanged(key: string, expected: Pick<ComposerDraftEntry, 'text' | 'body'>,
  scope = composerDraftScope()): void {
  if (!scope) return;
  const map = loadDraftMap(), storageKey = JSON.stringify([scope, key]), current = map[storageKey];
  if (!current || current.text !== expected.text || JSON.stringify(current.body ?? null) !== JSON.stringify(expected.body ?? null)) return;
  delete map[storageKey]; saveDraftMap(map);
}

export function clearComposerDrafts() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}
