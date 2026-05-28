import 'server-only';

import {
  createLocalEmailDraft,
  disconnectLocalEmailAccount,
  hasLocalEmailOAuthCredentials,
  listLocalEmailAccounts,
  readLocalEmailMessage,
  searchLocalEmail,
  sendLocalEmailDraft,
  startLocalEmailOAuth,
  updateLocalEmailDraft,
  updateLocalEmailPolicy,
  type EmailDraftInput,
  type EmailPolicy,
} from '@/app/lib/email/local-service';
import { managedEmailRequest } from '@/app/lib/email/managed-client';

type EmailSearchInput = {
  accountId?: string;
  query?: string;
  limit?: number;
};

function isLocalAccountId(accountId?: string): boolean {
  return Boolean(accountId?.startsWith('local_'));
}

async function useLocalAccountListing(): Promise<boolean> {
  const localAccounts = await listLocalEmailAccounts();
  return localAccounts.length > 0 || await hasLocalEmailOAuthCredentials();
}

export async function startEmailOAuth(params: {
  provider?: string;
  requestOrigin?: string | null;
  returnUrl?: string;
}) {
  if (await hasLocalEmailOAuthCredentials(params.provider)) {
    return startLocalEmailOAuth(params);
  }

  return managedEmailRequest('/v1/managed/email/oauth/start', {
    method: 'POST',
    body: JSON.stringify({ provider: params.provider || 'google', returnUrl: params.returnUrl }),
  });
}

export async function listEmailAccounts() {
  if (await useLocalAccountListing()) {
    return { accounts: await listLocalEmailAccounts(), mode: 'local' };
  }

  return managedEmailRequest('/v1/managed/email/accounts');
}

export async function updateEmailPolicy(accountId: string, policy: Partial<EmailPolicy>) {
  if (isLocalAccountId(accountId)) {
    return updateLocalEmailPolicy(accountId, policy);
  }

  return managedEmailRequest(`/v1/managed/email/accounts/${encodeURIComponent(accountId)}/policy`, {
    method: 'PATCH',
    body: JSON.stringify(policy),
  });
}

export async function disconnectEmailAccount(accountId: string) {
  if (isLocalAccountId(accountId)) {
    return disconnectLocalEmailAccount(accountId);
  }

  return managedEmailRequest(`/v1/managed/email/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
}

export async function searchEmail(input: EmailSearchInput) {
  const localAccounts = await listLocalEmailAccounts();
  if (isLocalAccountId(input.accountId) || (!input.accountId && (localAccounts.length > 0 || await hasLocalEmailOAuthCredentials()))) {
    return searchLocalEmail(input);
  }

  return managedEmailRequest('/v1/managed/email/search', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function readEmailMessage(accountId: string, messageId: string) {
  if (isLocalAccountId(accountId)) {
    return readLocalEmailMessage(accountId, messageId);
  }

  return managedEmailRequest(`/v1/managed/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}`);
}

export async function createEmailDraft(input: EmailDraftInput) {
  if (isLocalAccountId(input.accountId)) {
    return createLocalEmailDraft(input);
  }

  return managedEmailRequest('/v1/managed/email/drafts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateEmailDraft(draftId: string, input: EmailDraftInput) {
  if (isLocalAccountId(input.accountId)) {
    return updateLocalEmailDraft(draftId, input);
  }

  return managedEmailRequest(`/v1/managed/email/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function sendEmailDraft(accountId: string, draftId: string) {
  if (isLocalAccountId(accountId)) {
    return sendLocalEmailDraft(accountId, draftId);
  }

  return managedEmailRequest(`/v1/managed/email/drafts/${encodeURIComponent(draftId)}/send`, {
    method: 'POST',
    body: JSON.stringify({ accountId }),
  });
}
