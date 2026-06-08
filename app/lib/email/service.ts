import 'server-only';

import {
  archiveLocalEmailMessage,
  createLocalEmailAiReplyDraft,
  createLocalEmailDerivedDraft,
  createLocalEmailDraft,
  deleteLocalEmailMessagePermanently,
  disconnectLocalEmailAccount,
  getLocalEmailOAuthStatus,
  listLocalEmailFolders,
  listLocalEmailAccounts,
  listLocalEmailMessages,
  moveLocalEmailMessage,
  readLocalEmailMessage,
  searchLocalEmail,
  sendLocalEmailDraft,
  setLocalEmailMessageAnswered,
  setLocalEmailMessageRead,
  setPrimaryLocalEmailAccount,
  startLocalEmailOAuth,
  summarizeLocalEmailMessage,
  trashLocalEmailMessage,
  updateLocalEmailDraft,
  updateLocalEmailPolicy,
  type EmailDerivedDraftMode,
  type EmailDraftInput,
  type EmailPolicy,
} from '@/app/lib/email/local-service';
import { saveSmtpEmailAccount, testSmtpConnection, testStoredSmtpEmailAccount, type SmtpAccountInput } from '@/app/lib/email/smtp-service';

type EmailSearchInput = {
  accountId?: string;
  query?: string;
  limit?: number;
};

type EmailMessageListInput = EmailSearchInput & {
  folder?: string;
  filter?: string;
  offset?: number;
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

export async function getEmailOAuthStatus(params: {
  requestOrigin?: string | null;
}) {
  return getLocalEmailOAuthStatus(params.requestOrigin);
}

export async function listEmailAccounts(userId: string) {
  const localAccounts = await listLocalEmailAccounts(userId);
  return emailAccountsResponse({ accounts: localAccounts }, 'local');
}

export async function listEmailFolders(userId: string, accountId?: string) {
  return listLocalEmailFolders(userId, accountId);
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

export async function testEmailSmtpConnection(userId: string, input: SmtpAccountInput) {
  return testSmtpConnection(userId, input);
}

export async function testEmailAccount(userId: string, accountId: string) {
  return testStoredSmtpEmailAccount(userId, accountId);
}

export async function searchEmail(userId: string, input: EmailSearchInput) {
  return searchLocalEmail(userId, input);
}

export async function listEmailMessages(userId: string, input: EmailMessageListInput) {
  return listLocalEmailMessages(userId, input);
}

export async function readEmailMessage(userId: string, accountId: string, messageId: string, folder?: string) {
  return readLocalEmailMessage(userId, accountId, messageId, folder);
}

export async function setEmailMessageRead(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  read: boolean,
) {
  return setLocalEmailMessageRead(userId, accountId, messageId, folder, read);
}

export async function setEmailMessageAnswered(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  answered: boolean,
) {
  return setLocalEmailMessageAnswered(userId, accountId, messageId, folder, answered);
}

export async function archiveEmailMessage(userId: string, accountId: string, messageId: string, folder?: string) {
  return archiveLocalEmailMessage(userId, accountId, messageId, folder);
}

export async function moveEmailMessage(userId: string, accountId: string, messageId: string, folder: string | undefined, destination: string) {
  return moveLocalEmailMessage(userId, accountId, messageId, folder, destination);
}

export async function trashEmailMessage(userId: string, accountId: string, messageId: string, folder?: string) {
  return trashLocalEmailMessage(userId, accountId, messageId, folder);
}

export async function deleteEmailMessagePermanently(userId: string, accountId: string, messageId: string, folder?: string) {
  return deleteLocalEmailMessagePermanently(userId, accountId, messageId, folder);
}

export async function summarizeEmailMessage(userId: string, accountId: string, messageId: string, folder?: string) {
  return summarizeLocalEmailMessage(userId, accountId, messageId, folder);
}

export async function createEmailDerivedDraft(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  mode: EmailDerivedDraftMode,
) {
  return createLocalEmailDerivedDraft(userId, accountId, messageId, folder, mode);
}

export async function createEmailAiReplyDraft(userId: string, accountId: string, messageId: string, folder?: string) {
  return createLocalEmailAiReplyDraft(userId, accountId, messageId, folder);
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
