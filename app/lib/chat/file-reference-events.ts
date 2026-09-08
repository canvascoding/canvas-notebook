import { notifyWorkspaceFileOpened } from '@/app/lib/files/workspace-file-events';

export function notifyChatFileReferenceOpened(path: string, workspaceId?: string | null) {
  if (typeof window === 'undefined') return;

  notifyWorkspaceFileOpened(path, 'chat-reference', workspaceId);
}
