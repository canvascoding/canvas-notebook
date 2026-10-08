'use client';

import type { EmailRecipientDiscoveryResult, EmailReplyRecipientSuggestions } from '@/app/lib/email/recipient-discovery-types';

type MailboxInput = { accountId: string; mailboxWorkspaceId?: string | null; exclude?: string[] };

async function requestRecipients<T>(input: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  const response = await fetch('/api/email/recipients', {
    method: 'POST', credentials: 'include', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true || !payload.data) throw new Error('Recipient lookup unavailable.');
  return payload.data as T;
}

export function findEmailRecipientSuggestions(input: MailboxInput & { query: string }, signal: AbortSignal) {
  return requestRecipients<EmailRecipientDiscoveryResult>({ ...input, mode: 'find' }, signal);
}

export function loadEmailReplyRecipientSuggestions(input: MailboxInput & { messageId: string; folder?: string; replyMode: 'reply' }, signal: AbortSignal) {
  return requestRecipients<EmailReplyRecipientSuggestions>({ ...input, mode: 'reply' }, signal);
}
