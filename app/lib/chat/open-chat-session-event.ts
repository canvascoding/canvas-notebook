export const OPEN_CHAT_SESSION_EVENT = 'canvas:open-chat-session';

export type OpenChatSessionEventDetail = {
  sessionId: string;
  source?: 'notification' | 'todo' | string;
  handled?: boolean;
};

export function dispatchOpenChatSession(sessionId: string, source?: OpenChatSessionEventDetail['source']): boolean {
  if (typeof window === 'undefined') return false;

  const detail: OpenChatSessionEventDetail = {
    sessionId,
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

export function markOpenChatSessionEventHandled(event: Event) {
  const detail = (event as CustomEvent<OpenChatSessionEventDetail>).detail;
  if (detail) {
    detail.handled = true;
  }
}
