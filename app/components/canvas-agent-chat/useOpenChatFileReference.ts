'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { notifyChatFileReferenceOpened } from '@/app/lib/chat/file-reference-events';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { requestWorkspaceMarkdownLocation } from '@/app/lib/markdown/workspace-markdown-navigation';
import { requestChatFileOpen } from '@/app/lib/chat/chat-file-open-service';

export function useOpenChatFileReference() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  return useCallback(async (
    filePath: string,
    location: { blockId?: string | null; heading?: string | null } = {},
  ) => {
    const normalizedPath = normalizeChatFilePath(filePath);
    if (!normalizedPath) return;

    const request = requestChatFileOpen(normalizedPath, activeWorkspaceId);
    const result = await request.promise;
    if (result.status === 'opened') {
      if (request.started) {
        notifyChatFileReferenceOpened(normalizedPath);
      }
      if (location.blockId || location.heading) {
        requestWorkspaceMarkdownLocation({
          path: normalizedPath,
          blockId: location.blockId || null,
          heading: location.heading || null,
        });
      }
      return;
    }
    if (result.status !== 'superseded') {
      toast.error(result.error);
    }
  }, [activeWorkspaceId]);
}
