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
    const scopedKeyPrefix = `${CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY}:`;
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(scopedKeyPrefix)) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Session restore is a convenience only; ignore storage failures.
  }
}
