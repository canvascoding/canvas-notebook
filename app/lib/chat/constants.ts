export const CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY = 'canvas.chat.initialPrompt';
export const CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY = 'canvas.chat.activeSessionId';

export function getCanvasChatActiveSessionStorageKey(workspaceId?: string | null): string {
  const normalizedWorkspaceId = workspaceId?.trim();
  return normalizedWorkspaceId
    ? `${CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY}:${normalizedWorkspaceId}`
    : CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY;
}

export function clearCanvasChatActiveSessionStorage(workspaceId?: string | null): void {
  if (typeof window === 'undefined') return;

  try {
    if (workspaceId?.trim()) {
      window.sessionStorage.removeItem(getCanvasChatActiveSessionStorageKey(workspaceId));
      return;
    }

    window.sessionStorage.removeItem(CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    // Session restore is a convenience only; ignore storage failures.
  }
}
