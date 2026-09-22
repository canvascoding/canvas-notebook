import type { NotebookNavigationIntent } from '@/app/lib/chat/chat-navigation-intent';

export type NotebookEntry =
  | { kind: 'waiting' }
  | { kind: 'chat' }
  | { kind: 'document'; path: string; revealChat: boolean };

/** Explicit navigation owns the entry; saved tabs are only a fallback. */
export function resolveNotebookEntry(input: {
  intent: NotebookNavigationIntent;
  workspaceId: string | null;
  workspaceReady: boolean;
  hasInitialPrompt: boolean;
  restoredPath: string | null;
}): NotebookEntry {
  if (!input.workspaceReady || !input.workspaceId
    || (input.intent.workspaceId && input.intent.workspaceId !== input.workspaceId)) return { kind: 'waiting' };
  if (input.hasInitialPrompt) return { kind: 'chat' };
  if (input.intent.path) return { kind: 'document', path: input.intent.path, revealChat: input.intent.shouldOpenChat };
  if (input.intent.shouldOpenChat) return { kind: 'chat' };
  return input.restoredPath ? { kind: 'document', path: input.restoredPath, revealChat: false } : { kind: 'chat' };
}
