import type { QuickAccessFile } from '@/app/lib/files/quick-access';

export type HomeChat = {
  sessionId: string;
  title: string | null;
  activityAt: number;
  hasUnread: boolean;
  agentIconId?: string | null;
};
export type HomeChatPage = { chats: HomeChat[]; hasMore: boolean };
export type ContinueFilter = 'all' | 'files' | 'chats';
export type ContinueItem =
  | { kind: 'file'; key: string; activityAt: number; file: QuickAccessFile }
  | { kind: 'chat'; key: string; activityAt: number; chat: HomeChat };

export function selectContinueItems(files: QuickAccessFile[], chats: HomeChat[], filter: ContinueFilter, limit: number): ContinueItem[] {
  const fileItems: ContinueItem[] = files.map(file => ({ kind: 'file', key: `file:${file.path}`, activityAt: file.openedAt ?? 0, file }));
  const chatItems: ContinueItem[] = chats.map(chat => ({ kind: 'chat', key: `chat:${chat.sessionId}`, activityAt: chat.activityAt, chat }));
  // File-only views retain the server's favorites/frequency/search ordering.
  if (filter === 'files') return fileItems.slice(0, limit);
  if (filter === 'chats') return chatItems.slice(0, limit);
  const sorted = [...fileItems, ...chatItems].sort((a, b) => b.activityAt - a.activityAt || a.key.localeCompare(b.key));
  if (limit < 2) return sorted.slice(0, limit);
  const firstFile = sorted.find(item => item.kind === 'file');
  const firstChat = sorted.find(item => item.kind === 'chat');
  const selected = new Set([firstFile?.key, firstChat?.key].filter(Boolean));
  for (const item of sorted) {
    if (selected.size >= limit) break;
    selected.add(item.key);
  }
  return sorted.filter(item => selected.has(item.key));
}
