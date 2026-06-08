import 'server-only';

import {
  createLocalEmailDraft,
  disconnectLocalEmailAccount,
  listLocalEmailAccounts,
  readLocalEmailMessage,
  searchLocalEmail,
  sendLocalEmailDraft,
  setPrimaryLocalEmailAccount,
  startLocalEmailOAuth,
  updateLocalEmailDraft,
  updateLocalEmailPolicy,
  type EmailDraftInput,
  type EmailPolicy,
} from '@/app/lib/email/local-service';
import { saveSmtpEmailAccount, testSmtpConnection, type SmtpAccountInput } from '@/app/lib/email/smtp-service';

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

function isConnectedEmailAccount(account: unknown): boolean {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return false;
  const status = (account as { status?: unknown }).status;
  if (typeof status !== 'string' || !status.trim()) return true;
  return ['active', 'connected'].includes(status.trim().toLowerCase());
}

function emailAccountsResponse(payload: EmailAccountsResponse, mode: 'managed' | 'local') {
  return {
    ...payload,
    accounts: Array.isArray(payload.accounts) ? payload.accounts.filter(isConnectedEmailAccount) : [],
    mode,
  };
}

export async function startEmailOAuth(userId: string, params: {
  provider?: string;
  requestOrigin?: string | null;
  returnUrl?: string;
}): Promise<EmailOAuthStartResponse> {
  return startLocalEmailOAuth({ ...params, userId });
}

export async function listEmailAccounts(userId: string) {
  const localAccounts = await listLocalEmailAccounts(userId);
  return emailAccountsResponse({ accounts: localAccounts }, 'local');
}

export async function updateEmailPolicy(userId: string, accountId: string, policy: Partial<EmailPolicy>) {
  return updateLocalEmailPolicy(userId, accountId, policy);
}

export async function setEmailMainAccount(userId: string, accountId: string) {
  return setPrimaryLocalEmailAccount(userId, accountId);
}

export async function disconnectEmailAccount(userId: string, accountId: string) {
  return disconnectLocalEmailAccount(userId, accountId);
}

export async function saveEmailSmtpAccount(userId: string, input: SmtpAccountInput, options?: { verify?: boolean }) {
  return saveSmtpEmailAccount(userId, input, options);
}

export async function testEmailSmtpConnection(input: SmtpAccountInput) {
  return testSmtpConnection(input);
}

export async function searchEmail(userId: string, input: EmailSearchInput) {
  return searchLocalEmail(userId, input);
}

export async function readEmailMessage(userId: string, accountId: string, messageId: string) {
  return readLocalEmailMessage(userId, accountId, messageId);
}

export async function createEmailDraft(userId: string, input: EmailDraftInput) {
  return createLocalEmailDraft(userId, input);
}

export async function updateEmailDraft(userId: string, draftId: string, input: EmailDraftInput) {
  return updateLocalEmailDraft(userId, draftId, input);
}

export async function sendEmailDraft(userId: string, accountId: string, draftId: string) {
  return sendLocalEmailDraft(userId, accountId, draftId);
}
