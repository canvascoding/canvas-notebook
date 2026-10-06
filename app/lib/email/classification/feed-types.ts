import type { EmailMailboxScope, EmailMessageOrigin } from './mailbox-types';
import type { EmailIndexedMessageList } from './store-types';
import type { EmailCategory, EmailClassification, EmailFocusGroup } from './types';

export type EmailFeedMode = 'focus' | 'classic';
export type EmailFeedView = 'focus' | 'all' | EmailFocusGroup;
export interface EmailClassificationFeedInput {
  userId: string; scope: EmailMailboxScope; mode?: EmailFeedMode; view?: EmailFeedView;
  category?: EmailCategory; search?: string; limit?: number; cursor?: string;
}
export interface EmailClassificationFeedItem {
  messageRef: string; selectionKey: string; origin: EmailMessageOrigin;
  message: EmailIndexedMessageList;
  classification: EmailClassification | null;
  personalFocus: { done: boolean; version: number };
}
export interface EmailClassificationFeedCoverage {
  mailboxRef: string; state: 'pending' | 'partial' | 'complete' | 'failed';
  lastSyncAt: number | null; indexed: number; pending: number; failed: number; stale: number;
}
export interface EmailClassificationFeed {
  scope: EmailMailboxScope; requestedMode: EmailFeedMode; mode: EmailFeedMode; view: EmailFeedView;
  items: EmailClassificationFeedItem[]; nextCursor: string | null;
  snapshot: { id: string; expiresAt: number }; hasUpdates: boolean;
  counts: { total: number; groups: Record<EmailFocusGroup, number>; categories: Partial<Record<EmailCategory, number>> };
  coverage: EmailClassificationFeedCoverage[];
  limits: { initialLookbackDays: number; maxHistoricalMessages: number };
}
export class EmailClassificationFeedError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = 'EmailClassificationFeedError'; }
}
