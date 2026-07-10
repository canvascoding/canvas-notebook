'use client';

import { useCallback } from 'react';
import { useLocale } from 'next-intl';
import { toast } from 'sonner';
import { getPathname, usePathname as useLocalePathname } from '@/i18n/navigation';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { notifyChatFileReferenceOpened } from '@/app/lib/chat/file-reference-events';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export function useOpenChatFileReference() {
  const pathname = useLocalePathname();
  const locale = useLocale();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  return useCallback(async (filePath: string) => {
    const normalizedPath = normalizeChatFilePath(filePath);
    if (!normalizedPath) return;

    if (pathname.includes('/chat')) {
      const notebookPath = getPathname({
        locale,
        href: { pathname: '/notebook', query: { path: normalizedPath } },
      });
      window.open(notebookPath, 'canvas-notebook');
      return;
    }

    const result = await useFileStore.getState().revealAndLoadFile(normalizedPath, {
      workspaceId: activeWorkspaceId,
    });
    if (result.status === 'opened') {
      notifyChatFileReferenceOpened(normalizedPath);
      return;
    }
    if (result.status !== 'superseded') {
      toast.error(result.error);
    }
  }, [activeWorkspaceId, locale, pathname]);
}
