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
  planningMode?: boolean;
  currentPage?: string;
  studioContext?: {
    generationId?: string;
    currentOutputId?: string;
    generationPrompt?: string | null;
    generationPresetId?: string | null;
    generationProductIds?: string[];
    generationPersonaIds?: string[];
    outputFilePath?: string | null;
    outputMediaUrl?: string | null;
  };
}
