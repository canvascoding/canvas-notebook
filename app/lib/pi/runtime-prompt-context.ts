import type { ChatRequestContext } from '@/app/lib/chat/types';

export type PiRuntimePromptContext = ChatRequestContext;

export type RuntimePromptContextTarget = {
  setChannelContext: (channelId: string | undefined) => void;
  setTimeZoneContext: (timeZone: string, currentTime: string) => void;
  setActiveFileContext: (path: string | null) => void;
  setPlanningMode: (enabled: boolean) => void;
  setPageContext: (page: string | undefined) => void;
  setStudioContext: (context: PiRuntimePromptContext['studioContext']) => void;
  setEmailContext: (context: PiRuntimePromptContext['emailContext']) => void;
  setWorkspaceContext: (context: PiRuntimePromptContext['workspace']) => void;
};

export function applyPiRuntimePromptContext(
  runtime: RuntimePromptContextTarget,
  context?: PiRuntimePromptContext,
): void {
  runtime.setChannelContext(context?.channelId);

  if (context?.userTimeZone && context.currentTime) {
    runtime.setTimeZoneContext(context.userTimeZone, context.currentTime);
  }

  runtime.setActiveFileContext(context?.activeFilePath ?? null);
  runtime.setPlanningMode(context?.planningMode ?? false);
  runtime.setPageContext(context?.currentPage);
  runtime.setStudioContext(context?.studioContext);
  runtime.setEmailContext(context?.emailContext);
  runtime.setWorkspaceContext(context?.workspace);
}
