import type { EmailAccount, EmailMessageSummary } from './email-client-types';
import type { EmailClassificationFeedItem } from '@/app/lib/email/classification/feed-types';

export function emailAccountSelectionKey(account: Pick<EmailAccount, 'id' | 'workspaceId'>): string {
  return account.workspaceId ? `${account.id}:${account.workspaceId}` : account.id;
}

export function emailAccountContextKey(account: Pick<EmailAccount, 'id' | 'workspaceId'>): string {
  return `${account.id}:${account.workspaceId || 'personal'}`;
}

export function emailFeedMessageSummary(item: EmailClassificationFeedItem): EmailMessageSummary {
  return { ...item.message, id: item.origin.canonicalId, folder: item.origin.folder,
    messageRef: item.messageRef, selectionKey: item.selectionKey, origin: item.origin,
    classification: item.classification, personalFocus: item.personalFocus };
}

export function sameEmailSelection(left: EmailMessageSummary | null, right: EmailMessageSummary): boolean {
  if (!left) return false;
  if (left.selectionKey || right.selectionKey) return Boolean(left.selectionKey && left.selectionKey === right.selectionKey);
  return left.id === right.id && (left.folder || 'INBOX') === (right.folder || 'INBOX');
}
