export const CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY = 'canvas.chat.initialPrompt';
export const CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY = 'canvas.chat.activeSessionId';

export function getCanvasChatActiveSessionStorageKey(workspaceId?: string | null): string {
  const normalizedWorkspaceId = workspaceId?.trim();
  return normalizedWorkspaceId
    ? `${CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY}:${normalizedWorkspaceId}`
    : CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY;
}

export function readCanvasChatActiveSessionStorage(workspaceId?: string | null): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const sessionId = window.sessionStorage.getItem(getCanvasChatActiveSessionStorageKey(workspaceId));
    return sessionId?.trim() || null;
  } catch {
    // Session restore is a convenience only; ignore storage failures.
    return null;
  }
}

export function writeCanvasChatActiveSessionStorage(
  workspaceId: string | null | undefined,
  sessionId: string,
): void {
  if (typeof window === 'undefined') return;

  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return;

  try {
    window.sessionStorage.setItem(
      getCanvasChatActiveSessionStorageKey(workspaceId),
      normalizedSessionId,
    );
  } catch {
    // Session restore is a convenience only; ignore storage failures.
  }
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
