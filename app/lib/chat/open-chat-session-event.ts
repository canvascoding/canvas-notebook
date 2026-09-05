export const OPEN_CHAT_SESSION_EVENT = 'canvas:open-chat-session';

export type OpenChatSessionEventDetail = {
  sessionId: string;
  workspaceId?: string;
  source?: 'notification' | 'todo' | string;
  handled?: boolean;
};

export function dispatchOpenChatSession(
  sessionId: string,
  source?: OpenChatSessionEventDetail['source'],
  workspaceId?: string | null,
): boolean {
  if (typeof window === 'undefined') return false;

  const detail: OpenChatSessionEventDetail = {
    sessionId,
    ...(workspaceId?.trim() ? { workspaceId: workspaceId.trim() } : {}),
    source,
    handled: false,
  };

  window.dispatchEvent(new CustomEvent<OpenChatSessionEventDetail>(OPEN_CHAT_SESSION_EVENT, { detail }));
  return detail.handled === true;
}

export function getOpenChatSessionEventSessionId(event: Event): string | null {
  const sessionId = (event as CustomEvent<OpenChatSessionEventDetail>).detail?.sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : null;
}

export function getOpenChatSessionEventWorkspaceId(event: Event): string | null {
  const workspaceId = (event as CustomEvent<OpenChatSessionEventDetail>).detail?.workspaceId;
  return typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId : null;
}

export function handleOpenChatSessionEvent(
  event: Event,
  options: {
    activeWorkspaceId: string | null;
    switchWorkspace: (workspaceId: string) => boolean | Promise<boolean>;
    openSession: (sessionId: string) => void;
  },
): boolean {
  const sessionId = getOpenChatSessionEventSessionId(event);
  if (!sessionId) return false;

  const workspaceId = getOpenChatSessionEventWorkspaceId(event);
  if (workspaceId && workspaceId !== options.activeWorkspaceId) {
    const switched = options.switchWorkspace(workspaceId);
    if (typeof switched !== 'boolean') {
      // Claim synchronously so the dispatcher does not navigate around the save guard.
      markOpenChatSessionEventHandled(event);
      void switched.then((allowed) => {
        if (allowed) options.openSession(sessionId);
      }).catch(() => undefined);
      return true;
    }
    if (!switched) return false;
  }

  markOpenChatSessionEventHandled(event);
  options.openSession(sessionId);
  return true;
}

export function markOpenChatSessionEventHandled(event: Event) {
  const detail = (event as CustomEvent<OpenChatSessionEventDetail>).detail;
  if (detail) {
    detail.handled = true;
  }
}
