'use client';

import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { getPathname, usePathname as useLocalePathname } from '@/i18n/navigation';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { notifyChatFileReferenceOpened } from '@/app/lib/chat/file-reference-events';
import {
  createNotebookFileReferenceRequest,
  openOrMessageNotebookWindow,
} from '@/app/lib/chat/notebook-file-reference-bridge';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { requestWorkspaceMarkdownLocation } from '@/app/lib/markdown/workspace-markdown-navigation';
import { requestChatFileOpen } from '@/app/lib/chat/chat-file-open-service';

export function useOpenChatFileReference() {
  const pathname = useLocalePathname();
  const locale = useLocale();
  const t = useTranslations('chat');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  return useCallback(async (
    filePath: string,
    location: { blockId?: string | null; heading?: string | null } = {},
  ) => {
    const normalizedPath = normalizeChatFilePath(filePath);
    if (!normalizedPath) return;

    if (pathname.includes('/chat')) {
      const request = createNotebookFileReferenceRequest(normalizedPath, location);
      if (!request) return;
      const notebookPath = getPathname({
        locale,
        href: { pathname: '/notebook', query: { path: normalizedPath } },
      });
      if (openOrMessageNotebookWindow(notebookPath, request) === 'blocked') {
        toast.error(t('notebookWindowBlocked'));
      }
      return;
    }

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
  }, [activeWorkspaceId, locale, pathname, t]);
}
