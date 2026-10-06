import type { EmailClassificationMailboxInput } from './store-types';

export type EmailMailboxScope = { kind: 'all' | 'personal' | 'work' } | { kind: 'mailbox'; mailboxRef: string };

export interface EmailMailboxCapabilities {
  canRead: boolean; canWrite: boolean; canDelete: boolean; canRunAgent: boolean; canManage: boolean;
}

export interface AuthorizedEmailClassificationMailbox extends EmailClassificationMailboxInput {
  emailAddress: string;
  displayName: string | null;
  workspaceName: string | null;
  capabilities: EmailMailboxCapabilities;
}

export interface EmailMessageOrigin {
  mailboxRef: string;
  accountSource: 'local' | 'managed';
  accountId: string;
  accountScope: 'personal' | 'workspace';
  accountOwnerId: string;
  mailboxId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  emailAddress: string;
  displayName: string | null;
  folder: string;
  canonicalId: string;
  capabilities: EmailMailboxCapabilities;
}

export function parseEmailMailboxScope(value: unknown, mailboxRef?: unknown): EmailMailboxScope {
  if (value === undefined || value === null || value === 'all') return { kind: 'all' };
  if (value === 'personal' || value === 'work') return { kind: value };
  if (value === 'mailbox' && typeof mailboxRef === 'string' && /^emb:[a-f0-9]{64}$/u.test(mailboxRef)) return { kind: 'mailbox', mailboxRef };
  throw new Error('Invalid mailbox scope.');
}

export function matchesEmailMailboxScope(mailbox: Pick<AuthorizedEmailClassificationMailbox, 'mailboxRef' | 'workspaceId'>, scope: EmailMailboxScope): boolean {
  return scope.kind === 'all' || scope.kind === 'personal' && !mailbox.workspaceId || scope.kind === 'work' && Boolean(mailbox.workspaceId) || scope.kind === 'mailbox' && mailbox.mailboxRef === scope.mailboxRef;
}

export function emailOriginSelectionKey(origin: Pick<EmailMessageOrigin, 'accountSource' | 'accountOwnerId' | 'accountId' | 'workspaceId' | 'folder' | 'canonicalId'>): string {
  return JSON.stringify([origin.accountSource, origin.accountOwnerId, origin.accountId, origin.workspaceId, origin.folder, origin.canonicalId]);
}
