/**
 * Context fields attached to every chat message sent to the PI runtime.
 * Used by both the temporary HTTP compatibility routes and the WebSocket runtime protocol.
 */
export interface ChatRequestContext {
  channelId?: string;
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
    activeImagePath?: string | null;
  };
  emailContext?: {
    accountEmail?: string;
    accountId?: string;
    filter?: 'all' | 'unread';
    folder?: string;
    folderName?: string;
    query?: string;
    selectedMessageDate?: string | null;
    selectedMessageFolder?: string;
    selectedMessageFrom?: string | null;
    selectedMessageId?: string;
    selectedMessageIsRead?: boolean | null;
    selectedMessageSubject?: string | null;
  };
}
