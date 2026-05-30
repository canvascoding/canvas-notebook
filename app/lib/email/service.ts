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
import { isManagedEmailAvailable, managedEmailRequest } from '@/app/lib/email/managed-client';

type EmailSearchInput = {
  accountId?: string;
  query?: string;
  limit?: number;
};

type EmailAccountsResponse = {
  accounts?: unknown[];
  [key: string]: unknown;
};

type EmailOAuthStartResponse = {
  provider: string;
  authorizationUrl: string;
  expiresAt?: string;
  [key: string]: unknown;
};

function isLocalAccountId(accountId?: string): boolean {
  return Boolean(accountId?.startsWith('local_'));
}

function isConnectedEmailAccount(account: unknown): boolean {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return false;
  const status = (account as { status?: unknown }).status;
  if (typeof status !== 'string' || !status.trim()) return true;
  return ['active', 'connected'].includes(status.trim().toLowerCase());
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown email service error';
}

function emailAccountsResponse(payload: EmailAccountsResponse, mode: 'managed' | 'local') {
  return {
    ...payload,
    accounts: Array.isArray(payload.accounts) ? payload.accounts.filter(isConnectedEmailAccount) : [],
    mode,
  };
}

export async function startEmailOAuth(params: {
  provider?: string;
  requestOrigin?: string | null;
  returnUrl?: string;
}) {
  if (await hasLocalEmailOAuthCredentials(params.provider)) {
    return startLocalEmailOAuth(params);
  }

  if (isManagedEmailAvailable()) {
    return managedEmailRequest<EmailOAuthStartResponse>('/v1/managed/email/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ provider: params.provider || 'google', returnUrl: params.returnUrl }),
    });
  }

  return startLocalEmailOAuth(params);
}

export async function listEmailAccounts() {
  const localAccounts = await listLocalEmailAccounts();
  if (localAccounts.length > 0 || await hasLocalEmailOAuthCredentials()) {
    return emailAccountsResponse({ accounts: localAccounts }, 'local');
  }

  if (isManagedEmailAvailable()) {
    try {
      const managed = await managedEmailRequest<EmailAccountsResponse>('/v1/managed/email/accounts');
      return emailAccountsResponse(managed, 'managed');
    } catch (error) {
      return { accounts: localAccounts, mode: 'local', managedError: getErrorMessage(error) };
    }
  }

  return { accounts: localAccounts, mode: 'local' };
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
