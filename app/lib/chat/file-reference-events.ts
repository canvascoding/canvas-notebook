import { notifyWorkspaceFileOpened } from '@/app/lib/files/workspace-file-events';

export function notifyChatFileReferenceOpened(path: string) {
  if (typeof window === 'undefined') return;

  notifyWorkspaceFileOpened(path, 'chat-reference');
}
