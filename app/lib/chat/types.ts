/**
 * Context fields attached to every chat message sent to the PI runtime.
 * Used uniformly across the SSE path (direct fetch → /api/stream)
 * and the WebSocket path (WS send_message → chat-event-bridge → /api/stream).
 */
export interface ChatRequestContext {
  userTimeZone?: string;
  currentTime?: string;
  activeFilePath?: string | null;
  workingDirectory?: string;
}
