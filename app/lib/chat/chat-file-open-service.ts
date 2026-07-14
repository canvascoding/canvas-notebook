import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import type { OpenWorkspaceFileResult } from '@/app/lib/files/types';
import { useFileStore } from '@/app/store/file-store';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';

type ActiveChatFileOpen = {
  key: string;
  promise: Promise<OpenWorkspaceFileResult>;
};

export type ChatFileOpenRequest = {
  promise: Promise<OpenWorkspaceFileResult>;
  started: boolean;
};

let activeChatFileOpen: ActiveChatFileOpen | null = null;

export function requestChatFileOpen(
  filePath: string,
  workspaceId: string | null,
): ChatFileOpenRequest {
  const normalizedPath = normalizeChatFilePath(filePath);
  if (!normalizedPath) {
    return {
      promise: Promise.resolve({
        status: 'failed',
        path: filePath,
        error: 'Invalid workspace file path',
      }),
      started: false,
    };
  }

  const key = `${workspaceId ?? LEGACY_PERSONAL_WORKSPACE_ID}\0${normalizedPath}`;
  if (activeChatFileOpen?.key === key) {
    return { promise: activeChatFileOpen.promise, started: false };
  }

  const promise = useFileStore.getState().revealAndLoadFile(normalizedPath, { workspaceId });
  const request = { key, promise };
  activeChatFileOpen = request;
  void promise.then(
    () => {
      if (activeChatFileOpen === request) activeChatFileOpen = null;
    },
    () => {
      if (activeChatFileOpen === request) activeChatFileOpen = null;
    },
  );

  return { promise, started: true };
}
