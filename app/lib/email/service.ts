import 'server-only';

import {
  archiveLocalEmailMessage,
  createLocalEmailAiReplyDraft,
  createLocalEmailDerivedDraft,
  createLocalEmailDraft,
  deleteLocalEmailMessagePermanently,
  disconnectLocalEmailAccount,
  generateLocalEmailComposeBody,
  generateLocalEmailAiReplyBody,
  getLocalEmailOAuthStatus,
  listLocalEmailFolders,
  listLocalEmailAccounts,
  listLocalEmailMessages,
  moveLocalEmailMessage,
  readLocalEmailMessage,
  searchLocalEmail,
  sendLocalEmailDerivedMessage,
  sendLocalEmailDraft,
  sendLocalEmailMessage,
  setLocalEmailMessageAnswered,
  setLocalEmailMessageRead,
  setPrimaryLocalEmailAccount,
  startLocalEmailOAuth,
  summarizeLocalEmailMessage,
  trashLocalEmailMessage,
  updateLocalEmailDraft,
  updateLocalEmailPolicy,
  type EmailDerivedDraftOverrides,
  type EmailDerivedDraftMode,
  type EmailDraftInput,
  type EmailComposeAiInput,
  type EmailPolicy,
} from '@/app/lib/email/local-service';
import {
  getManagedEmailOAuthRedirectUri,
  isManagedEmailAvailable,
  managedEmailRequest,
  type EmailDraftInput as ManagedEmailDraftInput,
  type ManagedEmailAccount,
} from '@/app/lib/email/managed-client';
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

type EmailReadPolicyOptions = {
  enforceReadPolicy?: boolean;
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

type EmailOAuthStatusResponse = {
  mode: 'managed' | 'local';
  redirectUri: string | null;
  providers: {
    google: { configured: boolean };
    microsoft: { configured: boolean };
  };
  managedAvailable?: boolean;
};

type ManagedEmailSearchResponse = {
  account?: ManagedEmailAccount;
  messages?: unknown[];
  [key: string]: unknown;
};

type ManagedEmailReadResponse = {
  account?: ManagedEmailAccount;
  message?: Record<string, unknown>;
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
    accounts: Array.isArray(payload.accounts)
      ? payload.accounts.filter(isConnectedEmailAccount).map((account, index) => mode === 'managed' ? normalizeManagedAccount(account, index === 0) : account)
      : [],
    mode,
  };
}

function normalizeManagedPolicy(value: unknown): EmailPolicy {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<EmailPolicy>
    : {};
  return {
    readFrom: Array.isArray(record.readFrom) ? record.readFrom.filter((entry): entry is string => typeof entry === 'string') : [],
    sendTo: Array.isArray(record.sendTo) ? record.sendTo.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}

function normalizeManagedAccount(account: unknown, isPrimary = false): ManagedEmailAccount {
  const record = account && typeof account === 'object' && !Array.isArray(account)
    ? account as Partial<ManagedEmailAccount>
    : {};
  return {
    id: String(record.id || ''),
    provider: String(record.provider || 'managed'),
    authType: 'oauth',
    emailAddress: String(record.emailAddress || ''),
    displayName: typeof record.displayName === 'string' ? record.displayName : null,
    isPrimary: Boolean(record.isPrimary) || isPrimary,
    status: String(record.status || 'active'),
    scope: record.scope ?? null,
    expiresAt: record.expiresAt ?? null,
    policy: normalizeManagedPolicy(record.policy),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function listManagedEmailAccounts(): Promise<ManagedEmailAccount[]> {
  if (!isManagedEmailAvailable()) return [];
  const payload = await managedEmailRequest<EmailAccountsResponse>('/v1/managed/email/accounts');
  return Array.isArray(payload.accounts)
    ? payload.accounts
      .filter(isConnectedEmailAccount)
      .map((account, index) => normalizeManagedAccount(account, index === 0))
    : [];
}

async function findManagedEmailAccount(accountId?: string): Promise<ManagedEmailAccount | null> {
  const accounts = await listManagedEmailAccounts();
  if (!accountId) return accounts[0] || null;
  return accounts.find((account) => account.id === accountId) || null;
}

function managedEmailFolder(account?: ManagedEmailAccount) {
  return {
    id: 'INBOX',
    name: 'Inbox',
    path: 'INBOX',
    role: 'inbox',
    selectable: true,
    messageCount: null,
    unseenCount: null,
    account,
  };
}

function normalizeManagedMessage(message: unknown, folder = 'INBOX') {
  const record = message && typeof message === 'object' && !Array.isArray(message)
    ? message as Record<string, unknown>
    : {};
  return {
    ...record,
    id: String(record.id || ''),
    uid: String(record.uid || record.id || ''),
    folder: typeof record.folder === 'string' ? record.folder : folder,
    from: String(record.from || ''),
    subject: String(record.subject || ''),
    date: String(record.date || ''),
    snippet: String(record.snippet || ''),
    isRead: typeof record.isRead === 'boolean' ? record.isRead : true,
    isAnswered: typeof record.isAnswered === 'boolean' ? record.isAnswered : false,
    isFlagged: typeof record.isFlagged === 'boolean' ? record.isFlagged : false,
    hasAttachments: typeof record.hasAttachments === 'boolean' ? record.hasAttachments : false,
  };
}

function managedDraftInput(input: EmailDraftInput): ManagedEmailDraftInput {
  if (!input.accountId) {
    throw new Error('Managed email requires an accountId.');
  }
  return {
    accountId: input.accountId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body,
    is_HTML: input.is_HTML,
  };
}

export async function startEmailOAuth(userId: string, params: {
  provider?: string;
  requestOrigin?: string | null;
  returnUrl?: string;
}): Promise<EmailOAuthStartResponse> {
  if (isManagedEmailAvailable()) {
    return managedEmailRequest<EmailOAuthStartResponse>('/v1/managed/email/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ provider: params.provider || 'google', returnUrl: params.returnUrl }),
    });
  }
  return startLocalEmailOAuth({ ...params, userId });
}

export async function getEmailOAuthStatus(params: {
  requestOrigin?: string | null;
}): Promise<EmailOAuthStatusResponse> {
  if (isManagedEmailAvailable()) {
    return {
      mode: 'managed',
      redirectUri: getManagedEmailOAuthRedirectUri(),
      providers: {
        google: { configured: true },
        microsoft: { configured: true },
      },
      managedAvailable: true,
    };
  }
  return getLocalEmailOAuthStatus(params.requestOrigin);
}

export async function listEmailAccounts(userId: string) {
  if (isManagedEmailAvailable()) {
    const [managedAccounts, localAccounts] = await Promise.all([
      listManagedEmailAccounts(),
      listLocalEmailAccounts(userId).catch(() => []),
    ]);
    const hasLocalPrimary = localAccounts.some((account) => Boolean((account as { isPrimary?: unknown }).isPrimary));
    return {
      accounts: [
        ...managedAccounts.map((account, index) => ({ ...account, isPrimary: !hasLocalPrimary && index === 0 })),
        ...localAccounts,
      ].filter(isConnectedEmailAccount),
      mode: 'managed' as const,
    };
  }
  const localAccounts = await listLocalEmailAccounts(userId);
  return emailAccountsResponse({ accounts: localAccounts }, 'local');
}

export async function listEmailFolders(userId: string, accountId?: string) {
  const account = await findManagedEmailAccount(accountId);
  if (account) {
    return { account, folders: [managedEmailFolder(account)] };
  }
  return listLocalEmailFolders(userId, accountId);
}

export async function updateEmailPolicy(userId: string, accountId: string, policy: Partial<EmailPolicy>) {
  if (await findManagedEmailAccount(accountId)) {
    const payload = await managedEmailRequest<{ account: ManagedEmailAccount }>(`/v1/managed/email/accounts/${encodeURIComponent(accountId)}/policy`, {
      method: 'PATCH',
      body: JSON.stringify(policy),
    });
    return normalizeManagedAccount(payload.account);
  }
  return updateLocalEmailPolicy(userId, accountId, policy);
}

export async function setEmailMainAccount(userId: string, accountId: string) {
  const account = await findManagedEmailAccount(accountId);
  if (account) {
    return account;
  }
  return setPrimaryLocalEmailAccount(userId, accountId);
}

export async function disconnectEmailAccount(userId: string, accountId: string) {
  if (await findManagedEmailAccount(accountId)) {
    await managedEmailRequest<{ success: boolean }>(`/v1/managed/email/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    return { success: true };
  }
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

export async function searchEmail(userId: string, input: EmailSearchInput, options?: EmailReadPolicyOptions) {
  const managedAccount = await findManagedEmailAccount(input.accountId);
  if (managedAccount) {
    const payload = await managedEmailRequest<ManagedEmailSearchResponse>('/v1/managed/email/search', {
      method: 'POST',
      body: JSON.stringify({ ...input, accountId: managedAccount.id }),
    });
    return {
      ...payload,
      account: payload.account ? normalizeManagedAccount(payload.account) : undefined,
      messages: Array.isArray(payload.messages) ? payload.messages.map((message) => normalizeManagedMessage(message)) : [],
    };
  }
  return searchLocalEmail(userId, input, options);
}

export async function listEmailMessages(userId: string, input: EmailMessageListInput, options?: EmailReadPolicyOptions) {
  const managedAccount = await findManagedEmailAccount(input.accountId);
  if (managedAccount) {
    const limit = Math.min(Math.max(input.limit || 10, 1), 25);
    const payload = await managedEmailRequest<ManagedEmailSearchResponse>('/v1/managed/email/search', {
      method: 'POST',
      body: JSON.stringify({
        accountId: managedAccount.id,
        query: input.query,
        limit,
      }),
    });
    const messages = Array.isArray(payload.messages)
      ? payload.messages.map((message) => normalizeManagedMessage(message, input.folder || 'INBOX'))
      : [];
    return {
      account: payload.account ? normalizeManagedAccount(payload.account) : undefined,
      folder: input.folder || 'INBOX',
      messages,
      total: null,
      offset: 0,
      limit,
    };
  }
  return listLocalEmailMessages(userId, input, options);
}

export async function readEmailMessage(userId: string, accountId: string, messageId: string, folder?: string, options?: EmailReadPolicyOptions) {
  if (await findManagedEmailAccount(accountId)) {
    const payload = await managedEmailRequest<ManagedEmailReadResponse>(`/v1/managed/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}`);
    return {
      ...payload,
      account: payload.account ? normalizeManagedAccount(payload.account) : undefined,
      message: payload.message ? normalizeManagedMessage(payload.message, folder || 'INBOX') : undefined,
    };
  }
  return readLocalEmailMessage(userId, accountId, messageId, folder, options);
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

export async function summarizeEmailMessage(userId: string, accountId: string, messageId: string, folder?: string, options?: EmailReadPolicyOptions) {
  return summarizeLocalEmailMessage(userId, accountId, messageId, folder, options);
}

export async function createEmailDerivedDraft(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  mode: EmailDerivedDraftMode,
  overrides?: EmailDerivedDraftOverrides,
  options?: EmailReadPolicyOptions,
) {
  return createLocalEmailDerivedDraft(userId, accountId, messageId, folder, mode, overrides, options);
}

export async function sendEmailDerivedMessage(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  mode: EmailDerivedDraftMode,
  overrides?: EmailDerivedDraftOverrides,
  options?: EmailReadPolicyOptions,
) {
  return sendLocalEmailDerivedMessage(userId, accountId, messageId, folder, mode, overrides, options);
}

export async function generateEmailAiReplyBody(userId: string, accountId: string, messageId: string, folder?: string, instruction?: string, options?: EmailReadPolicyOptions) {
  return generateLocalEmailAiReplyBody(userId, accountId, messageId, folder, instruction, options);
}

export async function generateEmailComposeBody(userId: string, input: EmailComposeAiInput, options?: EmailReadPolicyOptions) {
  return generateLocalEmailComposeBody(userId, input, options);
}

export async function createEmailAiReplyDraft(userId: string, accountId: string, messageId: string, folder?: string, instruction?: string, options?: EmailReadPolicyOptions) {
  return createLocalEmailAiReplyDraft(userId, accountId, messageId, folder, instruction, options);
}

export async function createEmailDraft(userId: string, input: EmailDraftInput) {
  if (await findManagedEmailAccount(input.accountId)) {
    return managedEmailRequest('/v1/managed/email/drafts', {
      method: 'POST',
      body: JSON.stringify(managedDraftInput(input)),
    });
  }
  return createLocalEmailDraft(userId, input);
}

export async function updateEmailDraft(userId: string, draftId: string, input: EmailDraftInput) {
  if (await findManagedEmailAccount(input.accountId)) {
    return managedEmailRequest(`/v1/managed/email/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PATCH',
      body: JSON.stringify(managedDraftInput(input)),
    });
  }
  return updateLocalEmailDraft(userId, draftId, input);
}

export async function sendEmailMessage(userId: string, input: EmailDraftInput) {
  const managedAccount = await findManagedEmailAccount(input.accountId);
  if (managedAccount) {
    const accountId = managedAccount.id;
    const created = await createEmailDraft(userId, { ...input, accountId }) as { draft?: { id?: unknown } };
    const draftId = typeof created.draft?.id === 'string' ? created.draft.id : '';
    if (!draftId) throw new Error('Managed email draft response did not include a draft ID.');
    return sendEmailDraft(userId, accountId, draftId);
  }
  return sendLocalEmailMessage(userId, input);
}

export async function sendEmailDraft(userId: string, accountId: string, draftId: string) {
  if (await findManagedEmailAccount(accountId)) {
    return managedEmailRequest(`/v1/managed/email/drafts/${encodeURIComponent(draftId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    });
  }
  return sendLocalEmailDraft(userId, accountId, draftId);
}
