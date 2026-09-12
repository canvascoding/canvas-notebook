import 'server-only';

import {
  archiveLocalEmailMessage,
  createLocalEmailAiReplyDraft,
  createLocalEmailDerivedDraft,
  createLocalEmailDraft,
  deleteLocalEmailMessagePermanently,
  disconnectLocalEmailAccount,
  downloadLocalEmailAttachment,
  generateLocalEmailComposeBody,
  generateLocalEmailAiReplyBody,
  getLocalEmailOAuthStatus,
  listLocalEmailFolders,
  listLocalEmailAccounts,
  listLocalEmailMessages,
  moveLocalEmailMessage,
  readLocalEmailMessage,
  resolveLocalEmailCacheAccount,
  searchLocalEmail,
  sendLocalEmailDerivedMessage,
  sendLocalEmailDraft,
  sendLocalEmailMessage,
  setLocalEmailMessageAnswered,
  setLocalEmailMessageRead,
  setPrimaryLocalEmailAccount,
  startLocalEmailOAuth,
  streamLocalEmailAiReplyBody,
  streamLocalEmailComposeBody,
  streamLocalEmailMessageSummary,
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
  emailMessageCacheRef,
  readThroughEmailDetail,
  readThroughEmailList,
  type EmailCacheBackgroundScheduler,
  type EmailCacheMode,
  type EmailDetailPayload,
  type EmailListPayload,
} from '@/app/lib/email/cache/read-through';
import {
  invalidateEmailMailboxCache,
  purgeEmailMailboxCache,
  reactivateEmailMailboxCache,
  runLocalEmailMessageReadMutation,
  runLocalEmailMailboxMutation,
} from '@/app/lib/email/cache/consistency';
import { getRuntimeEmailCacheStore, normalizeEmailCacheProvider } from '@/app/lib/email/cache/store';
import { resolveEmailAttachments } from '@/app/lib/email/attachments';
import { EmailMessageNotFoundError } from '@/app/lib/email/errors';
import {
  assertInboundEmailAttachmentSize,
  readableFromBuffer,
  sanitizeInboundEmailAttachmentFilename,
  type DownloadedEmailAttachment,
} from '@/app/lib/email/inbound-attachments';
import type { EmailDeliveryOrigin } from '@/app/lib/email/policy';
import { logEmailClientEvent } from '@/app/lib/email/logging';
import {
  getManagedEmailOAuthRedirectUri,
  isManagedEmailAvailable,
  managedEmailBinaryRequest,
  managedEmailRequest,
  ManagedEmailRequestError,
  type ManagedEmailRequestScope,
  type EmailDraftInput as ManagedEmailDraftInput,
  type ManagedEmailAccount,
} from '@/app/lib/email/managed-client';
import { saveSmtpEmailAccount, testSmtpConnection, testStoredSmtpEmailAccount, type SmtpAccountInput } from '@/app/lib/email/smtp-service';

type EmailSearchInput = {
  accountId?: string;
  folder?: string;
  filter?: string;
  query?: string;
  limit?: number;
  from?: string;
  hasAttachments?: boolean;
};

type EmailMessageListInput = EmailSearchInput & {
  offset?: number;
};

type EmailReadPolicyOptions = {
  enforceReadPolicy?: boolean;
  workspaceId?: string | null;
  cacheMode?: EmailCacheMode;
  scheduleBackgroundTask?: EmailCacheBackgroundScheduler;
};

export type EmailDeliveryOptions = {
  /** Defaults to tool so new programmatic callers remain allowlist-restricted. */
  deliveryOrigin?: EmailDeliveryOrigin;
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

function managedEmailScope(userId: string): ManagedEmailRequestScope {
  return { userId };
}

async function listManagedEmailAccounts(userId: string): Promise<ManagedEmailAccount[]> {
  if (!isManagedEmailAvailable()) return [];
  const payload = await managedEmailRequest<EmailAccountsResponse>('/v1/managed/email/accounts', undefined, managedEmailScope(userId));
  return Array.isArray(payload.accounts)
    ? payload.accounts
      .filter(isConnectedEmailAccount)
      .map((account, index) => normalizeManagedAccount(account, index === 0))
    : [];
}

function emailAccountId(account: unknown): string {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return '';
  const value = (account as { id?: unknown }).id;
  return typeof value === 'string' ? value.trim() : '';
}

function accountEmailAddress(account: unknown): string {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return '';
  const value = (account as { emailAddress?: unknown }).emailAddress;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isPrimaryAccount(account: unknown): boolean {
  return Boolean(account && typeof account === 'object' && !Array.isArray(account) && (account as { isPrimary?: unknown }).isPrimary);
}

async function findManagedEmailAccount(userId: string, accountId?: string): Promise<ManagedEmailAccount | null> {
  const localAccounts = await listLocalEmailAccounts(userId);
  const localDefault = localAccounts.find(isPrimaryAccount) || localAccounts[0];
  if (accountId ? localAccounts.some((account) => emailAccountId(account) === accountId) : localDefault) {
    return null;
  }

  const accounts = await listManagedEmailAccounts(userId);
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

async function managedDraftInput(input: EmailDraftInput): Promise<ManagedEmailDraftInput> {
  if (!input.accountId) {
    throw new Error('Managed email requires an accountId.');
  }
  const attachments = await resolveEmailAttachments(input.attachments);
  return {
    accountId: input.accountId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body,
    is_HTML: input.is_HTML,
    ...(attachments.length > 0 ? {
      attachments: attachments.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        contentBase64: attachment.content.toString('base64'),
        ...(attachment.disposition === 'inline' && attachment.contentId ? {
          contentId: attachment.contentId,
          disposition: 'inline' as const,
        } : {}),
      })),
    } : {}),
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
    }, managedEmailScope(userId));
  }
  return startLocalEmailOAuth({ ...params, userId });
}

export async function getEmailOAuthStatus(params: {
  userId?: string | null;
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
  return getLocalEmailOAuthStatus(params.requestOrigin, params.userId);
}

export async function listEmailAccounts(userId: string) {
  const localAccounts = await listLocalEmailAccounts(userId);
  if (isManagedEmailAvailable()) {
    let managedAccounts: ManagedEmailAccount[];
    try {
      managedAccounts = await listManagedEmailAccounts(userId);
    } catch (error) {
      logEmailClientEvent('warn', 'managed-accounts-fallback', {
        error,
        mode: 'local',
        operation: 'list-accounts',
        status: 'failed',
      });
      return emailAccountsResponse({ accounts: localAccounts }, 'local');
    }

    const localIds = new Set(localAccounts.map(emailAccountId).filter(Boolean));
    const localAddresses = new Set(localAccounts.map(accountEmailAddress).filter(Boolean));
    const distinctManagedAccounts = managedAccounts.filter((account) => {
      const id = emailAccountId(account);
      const emailAddress = accountEmailAddress(account);
      return (!id || !localIds.has(id)) && (!emailAddress || !localAddresses.has(emailAddress));
    });
    const hasLocalPrimary = localAccounts.some((account) => Boolean((account as { isPrimary?: unknown }).isPrimary));
    return {
      accounts: [
        ...(hasLocalPrimary ? localAccounts : []),
        ...distinctManagedAccounts.map((account, index) => ({ ...account, isPrimary: !hasLocalPrimary && index === 0 })),
        ...(!hasLocalPrimary ? localAccounts : []),
      ].filter(isConnectedEmailAccount),
      mode: 'managed' as const,
    };
  }
  return emailAccountsResponse({ accounts: localAccounts }, 'local');
}

export async function listEmailFolders(userId: string, accountId?: string) {
  const account = await findManagedEmailAccount(userId, accountId);
  if (account) {
    return { account, folders: [managedEmailFolder(account)] };
  }
  return listLocalEmailFolders(userId, accountId);
}

export async function updateEmailPolicy(userId: string, accountId: string, policy: Partial<EmailPolicy>) {
  if (await findManagedEmailAccount(userId, accountId)) {
    const payload = await managedEmailRequest<{ account: ManagedEmailAccount }>(`/v1/managed/email/accounts/${encodeURIComponent(accountId)}/policy`, {
      method: 'PATCH',
      body: JSON.stringify(policy),
    }, managedEmailScope(userId));
    return normalizeManagedAccount(payload.account);
  }
  return updateLocalEmailPolicy(userId, accountId, policy);
}

export async function setEmailMainAccount(userId: string, accountId: string) {
  const account = await findManagedEmailAccount(userId, accountId);
  if (account) {
    return account;
  }
  return setPrimaryLocalEmailAccount(userId, accountId);
}

export async function disconnectEmailAccount(userId: string, accountId: string) {
  const managedAccount = await findManagedEmailAccount(userId, accountId);
  if (managedAccount) {
    await managedEmailRequest<{ success: boolean }>(
      `/v1/managed/email/accounts/${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
      managedEmailScope(userId),
    );
    await purgeEmailMailboxCache({ userId, accountId: managedAccount.id, accountSource: 'managed' });
    return { success: true };
  }
  const localAccount = await resolveLocalEmailCacheAccount(userId, accountId);
  const result = await disconnectLocalEmailAccount(userId, localAccount.account.id);
  await purgeEmailMailboxCache({ userId, accountId: localAccount.account.id, accountSource: 'local' });
  return result;
}

export async function saveEmailSmtpAccount(userId: string, input: SmtpAccountInput, options?: { verify?: boolean }) {
  const account = await saveSmtpEmailAccount(userId, input, options);
  await reactivateEmailMailboxCache({ userId, accountId: account.id, accountSource: 'local' });
  return account;
}

export async function testEmailSmtpConnection(userId: string, input: SmtpAccountInput) {
  return testSmtpConnection(userId, input);
}

export async function testEmailAccount(userId: string, accountId: string) {
  return testStoredSmtpEmailAccount(userId, accountId);
}

function shouldUseEmailCache(options?: EmailReadPolicyOptions): boolean {
  return options?.cacheMode === 'swr' && options.enforceReadPolicy === false;
}

function effectiveListLimit(input: EmailMessageListInput, managed: boolean): number {
  const fallback = Number.isFinite(input.limit) ? Math.trunc(Number(input.limit)) : 10;
  return Math.min(Math.max(fallback || 10, 1), managed ? 25 : 50);
}

function effectiveListOffset(input: EmailMessageListInput, managed: boolean): number {
  if (managed) return 0;
  const fallback = Number.isFinite(input.offset) ? Math.trunc(Number(input.offset)) : 0;
  return Math.min(Math.max(fallback, 0), 10_000);
}

function effectiveListFolder(input: EmailMessageListInput, provider: string): string {
  const fallback = normalizeEmailCacheProvider(provider) === 'microsoft' ? 'inbox' : 'INBOX';
  const folder = (input.folder || fallback).trim().replace(/[\u0000\r\n]/gu, '').slice(0, 240);
  return folder || fallback;
}

function effectiveListQuery(input: EmailMessageListInput, provider: string): string {
  const query = (input.query || '').normalize('NFC').trim();
  return normalizeEmailCacheProvider(provider) === 'imap' ? query.replace(/\s+/gu, ' ').slice(0, 250) : query;
}

function effectiveListFilter(input: EmailMessageListInput) {
  return {
    filter: (input.filter || 'all').trim().toLowerCase() || 'all',
    from: (input.from || '').trim(),
    hasAttachments: Boolean(input.hasAttachments),
  };
}

function localMailboxAccountFromResult(result: unknown): { id: string; authType: string } | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const account = (result as { account?: unknown }).account;
  if (!account || typeof account !== 'object' || Array.isArray(account)) return null;
  const id = (account as { id?: unknown }).id;
  const authType = (account as { authType?: unknown }).authType;
  if (typeof id !== 'string' || !id.trim() || typeof authType !== 'string') return null;
  return { id: id.trim(), authType };
}

async function invalidateLocalOAuthMailboxResult<T>(userId: string, result: T): Promise<T> {
  const account = localMailboxAccountFromResult(result);
  if (account && account.authType !== 'smtp_imap') {
    await invalidateEmailMailboxCache({ userId, accountId: account.id, accountSource: 'local' });
  }
  return result;
}

export async function searchEmail(userId: string, input: EmailSearchInput, options?: EmailReadPolicyOptions) {
  const managedAccount = await findManagedEmailAccount(userId, input.accountId);
  if (managedAccount) {
    const payload = await managedEmailRequest<ManagedEmailSearchResponse>('/v1/managed/email/search', {
      method: 'POST',
      body: JSON.stringify({ ...input, accountId: managedAccount.id }),
    }, managedEmailScope(userId));
    return {
      ...payload,
      account: payload.account ? normalizeManagedAccount(payload.account) : undefined,
      messages: Array.isArray(payload.messages) ? payload.messages.map((message) => normalizeManagedMessage(message, input.folder || 'INBOX')) : [],
    };
  }
  return searchLocalEmail(userId, input, options);
}

export async function listEmailMessages(userId: string, input: EmailMessageListInput, options?: EmailReadPolicyOptions) {
  const managedAccount = await findManagedEmailAccount(userId, input.accountId);
  if (managedAccount) {
    const useCache = shouldUseEmailCache(options);
    const limit = useCache
      ? effectiveListLimit(input, true)
      : Math.min(Math.max(input.limit || 10, 1), 25);
    const folder = useCache
      ? effectiveListFolder(input, managedAccount.provider)
      : input.folder || 'INBOX';
    const load = async () => {
      const payload = await managedEmailRequest<ManagedEmailSearchResponse>('/v1/managed/email/search', {
        method: 'POST',
        body: JSON.stringify({
          accountId: managedAccount.id,
          query: input.query,
          limit,
        }),
      }, managedEmailScope(userId));
      const messages = Array.isArray(payload.messages)
        ? payload.messages.map((message) => normalizeManagedMessage(message, folder))
        : [];
      return {
        account: payload.account ? normalizeManagedAccount(payload.account) : undefined,
        folder,
        messages,
        total: null,
        offset: 0,
        limit,
      };
    };
    if (!useCache) return load();
    const store = await getRuntimeEmailCacheStore();
    return readThroughEmailList<EmailListPayload>({
      runtime: { store, scheduleBackgroundTask: options?.scheduleBackgroundTask },
      mailbox: {
        userId,
        accountId: managedAccount.id,
        accountSource: 'managed',
        provider: managedAccount.provider,
      },
      scope: {
        folder,
        filter: effectiveListFilter(input),
        query: effectiveListQuery(input, managedAccount.provider),
        offset: 0,
        limit,
      },
      load,
      fromCache: (messages, total) => ({
        account: managedAccount,
        folder,
        messages,
        total,
        offset: 0,
        limit,
      }),
    });
  }

  if (shouldUseEmailCache(options)) {
    const resolved = await resolveLocalEmailCacheAccount(userId, input.accountId);
    const limit = effectiveListLimit(input, false);
    const offset = effectiveListOffset(input, false);
    const folder = effectiveListFolder(input, resolved.provider);
    const store = await getRuntimeEmailCacheStore();
    return readThroughEmailList<EmailListPayload>({
      runtime: { store, scheduleBackgroundTask: options?.scheduleBackgroundTask },
      mailbox: {
        userId,
        accountId: resolved.account.id,
        accountSource: 'local',
        provider: resolved.provider,
      },
      scope: {
        folder,
        filter: effectiveListFilter(input),
        query: effectiveListQuery(input, resolved.provider),
        offset,
        limit,
      },
      load: () => listLocalEmailMessages(userId, input, options),
      fromCache: (messages, total) => ({
        account: resolved.account,
        folder,
        messages,
        total,
        offset,
        limit,
      }),
    });
  }
  return listLocalEmailMessages(userId, input, options);
}

export async function readEmailMessage(userId: string, accountId: string, messageId: string, folder?: string, options?: EmailReadPolicyOptions) {
  const managedAccount = await findManagedEmailAccount(userId, accountId);
  if (managedAccount) {
    const load = async () => {
      let payload: ManagedEmailReadResponse;
      try {
        payload = await managedEmailRequest<ManagedEmailReadResponse>(
          `/v1/managed/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}`,
          undefined,
          managedEmailScope(userId),
        );
      } catch (error) {
        if (error instanceof ManagedEmailRequestError && error.status === 404) throw new EmailMessageNotFoundError();
        throw error;
      }
      return {
        ...payload,
        account: payload.account ? normalizeManagedAccount(payload.account) : undefined,
        message: payload.message ? normalizeManagedMessage(payload.message, folder || 'INBOX') : undefined,
      };
    };
    if (!shouldUseEmailCache(options)) return load();
    const store = await getRuntimeEmailCacheStore();
    return readThroughEmailDetail<EmailDetailPayload>({
      runtime: { store, scheduleBackgroundTask: options?.scheduleBackgroundTask },
      mailbox: {
        userId,
        accountId: managedAccount.id,
        accountSource: 'managed',
        provider: managedAccount.provider,
      },
      messageId,
      folder,
      load,
      fromCache: (message) => ({ account: managedAccount, message }),
    });
  }

  if (shouldUseEmailCache(options)) {
    const resolved = await resolveLocalEmailCacheAccount(userId, accountId);
    const store = await getRuntimeEmailCacheStore();
    return readThroughEmailDetail<EmailDetailPayload>({
      runtime: { store, scheduleBackgroundTask: options?.scheduleBackgroundTask },
      mailbox: {
        userId,
        accountId: resolved.account.id,
        accountSource: 'local',
        provider: resolved.provider,
      },
      messageId,
      folder,
      load: () => readLocalEmailMessage(userId, accountId, messageId, folder, options),
      fromCache: (message) => ({ account: resolved.account, message }),
    });
  }
  return readLocalEmailMessage(userId, accountId, messageId, folder, options);
}

function filenameFromContentDisposition(value: string | null): string {
  if (!value) return 'attachment';
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return sanitizeInboundEmailAttachmentFilename(decodeURIComponent(encoded));
    } catch {
      return sanitizeInboundEmailAttachmentFilename(encoded);
    }
  }
  const quoted = value.match(/filename="([^"]*)"/iu)?.[1];
  return sanitizeInboundEmailAttachmentFilename(quoted || 'attachment');
}

export async function downloadEmailAttachment(
  userId: string,
  accountId: string,
  messageId: string,
  attachmentId: string,
  folder?: string,
  options?: EmailReadPolicyOptions,
): Promise<DownloadedEmailAttachment> {
  const managedAccount = await findManagedEmailAccount(userId, accountId);
  if (!managedAccount) {
    return downloadLocalEmailAttachment(userId, accountId, messageId, attachmentId, folder, options);
  }

  let response: Response;
  try {
    response = await managedEmailBinaryRequest(
      `/v1/managed/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      managedEmailScope(userId),
    );
  } catch (error) {
    if (error instanceof ManagedEmailRequestError && error.status === 404) throw new EmailMessageNotFoundError();
    throw error;
  }
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader) assertInboundEmailAttachmentSize(Number(lengthHeader));
  const content = Buffer.from(await response.arrayBuffer());
  assertInboundEmailAttachmentSize(content.length);
  return {
    attachment: {
      id: attachmentId,
      filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      size: content.length,
      inline: false,
      downloadable: true,
    },
    content: readableFromBuffer(content),
  };
}

export async function setEmailMessageRead(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  read: boolean,
) {
  const resolved = await resolveLocalEmailCacheAccount(userId, accountId);
  return runLocalEmailMessageReadMutation(
    {
      userId,
      accountId: resolved.account.id,
      read,
      ref: emailMessageCacheRef(resolved.provider, messageId, folder),
    },
    () => setLocalEmailMessageRead(userId, accountId, messageId, folder, read),
  );
}

export async function setEmailMessageAnswered(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  answered: boolean,
) {
  return runLocalEmailMailboxMutation(
    { userId, accountId },
    () => setLocalEmailMessageAnswered(userId, accountId, messageId, folder, answered),
  );
}

export async function archiveEmailMessage(userId: string, accountId: string, messageId: string, folder?: string) {
  return runLocalEmailMailboxMutation(
    { userId, accountId },
    () => archiveLocalEmailMessage(userId, accountId, messageId, folder),
  );
}

export async function moveEmailMessage(userId: string, accountId: string, messageId: string, folder: string | undefined, destination: string) {
  return runLocalEmailMailboxMutation(
    { userId, accountId },
    () => moveLocalEmailMessage(userId, accountId, messageId, folder, destination),
  );
}

export async function trashEmailMessage(userId: string, accountId: string, messageId: string, folder?: string) {
  return runLocalEmailMailboxMutation(
    { userId, accountId },
    () => trashLocalEmailMessage(userId, accountId, messageId, folder),
  );
}

export async function deleteEmailMessagePermanently(userId: string, accountId: string, messageId: string, folder?: string) {
  return runLocalEmailMailboxMutation(
    { userId, accountId },
    () => deleteLocalEmailMessagePermanently(userId, accountId, messageId, folder),
  );
}

export async function summarizeEmailMessage(userId: string, accountId: string, messageId: string, folder?: string, options?: EmailReadPolicyOptions) {
  return summarizeLocalEmailMessage(userId, accountId, messageId, folder, options);
}

export async function streamEmailMessageSummary(
  userId: string,
  accountId: string,
  messageId: string,
  folder?: string,
  options?: EmailReadPolicyOptions & { signal?: AbortSignal },
) {
  return streamLocalEmailMessageSummary(userId, accountId, messageId, folder, options);
}

export async function createEmailDerivedDraft(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  mode: EmailDerivedDraftMode,
  overrides?: EmailDerivedDraftOverrides,
  options?: EmailReadPolicyOptions & EmailDeliveryOptions,
) {
  const result = await createLocalEmailDerivedDraft(userId, accountId, messageId, folder, mode, overrides, options);
  return invalidateLocalOAuthMailboxResult(userId, result);
}

export async function sendEmailDerivedMessage(
  userId: string,
  accountId: string,
  messageId: string,
  folder: string | undefined,
  mode: EmailDerivedDraftMode,
  overrides?: EmailDerivedDraftOverrides,
  options?: EmailReadPolicyOptions & EmailDeliveryOptions,
) {
  const result = await sendLocalEmailDerivedMessage(userId, accountId, messageId, folder, mode, overrides, options);
  return invalidateLocalOAuthMailboxResult(userId, result);
}

export async function generateEmailAiReplyBody(userId: string, accountId: string, messageId: string, folder?: string, instruction?: string, options?: EmailReadPolicyOptions) {
  return generateLocalEmailAiReplyBody(userId, accountId, messageId, folder, instruction, options);
}

export async function streamEmailAiReplyBody(
  userId: string,
  accountId: string,
  messageId: string,
  folder?: string,
  instruction?: string,
  options?: EmailReadPolicyOptions & { signal?: AbortSignal },
) {
  return streamLocalEmailAiReplyBody(userId, accountId, messageId, folder, instruction, options);
}

export async function generateEmailComposeBody(userId: string, input: EmailComposeAiInput, options?: EmailReadPolicyOptions) {
  return generateLocalEmailComposeBody(userId, input, options);
}

export async function streamEmailComposeBody(
  userId: string,
  input: EmailComposeAiInput,
  options?: EmailReadPolicyOptions & { signal?: AbortSignal },
) {
  return streamLocalEmailComposeBody(userId, input, options);
}

export async function createEmailAiReplyDraft(userId: string, accountId: string, messageId: string, folder?: string, instruction?: string, options?: EmailReadPolicyOptions) {
  const result = await createLocalEmailAiReplyDraft(userId, accountId, messageId, folder, instruction, options);
  return invalidateLocalOAuthMailboxResult(userId, result);
}

export async function createEmailDraft(userId: string, input: EmailDraftInput, options?: EmailDeliveryOptions) {
  if (await findManagedEmailAccount(userId, input.accountId)) {
    return managedEmailRequest('/v1/managed/email/drafts', {
      method: 'POST',
      body: JSON.stringify(await managedDraftInput(input)),
    }, managedEmailScope(userId));
  }
  const result = await createLocalEmailDraft(userId, input, options?.deliveryOrigin);
  return invalidateLocalOAuthMailboxResult(userId, result);
}

export async function updateEmailDraft(userId: string, draftId: string, input: EmailDraftInput, options?: EmailDeliveryOptions) {
  if (await findManagedEmailAccount(userId, input.accountId)) {
    return managedEmailRequest(`/v1/managed/email/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PATCH',
      body: JSON.stringify(await managedDraftInput(input)),
    }, managedEmailScope(userId));
  }
  const result = await updateLocalEmailDraft(userId, draftId, input, options?.deliveryOrigin);
  return invalidateLocalOAuthMailboxResult(userId, result);
}

export async function sendEmailMessage(userId: string, input: EmailDraftInput, options?: EmailDeliveryOptions) {
  const managedAccount = await findManagedEmailAccount(userId, input.accountId);
  if (managedAccount) {
    const accountId = managedAccount.id;
    const created = await createEmailDraft(userId, { ...input, accountId }, options) as { draft?: { id?: unknown } };
    const draftId = typeof created.draft?.id === 'string' ? created.draft.id : '';
    if (!draftId) throw new Error('Managed email draft response did not include a draft ID.');
    return sendEmailDraft(userId, accountId, draftId, options);
  }
  const result = await sendLocalEmailMessage(userId, input, options?.deliveryOrigin);
  return invalidateLocalOAuthMailboxResult(userId, result);
}

export async function sendEmailDraft(userId: string, accountId: string, draftId: string, options?: EmailDeliveryOptions) {
  if (await findManagedEmailAccount(userId, accountId)) {
    return managedEmailRequest(`/v1/managed/email/drafts/${encodeURIComponent(draftId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }, managedEmailScope(userId));
  }
  const result = await sendLocalEmailDraft(userId, accountId, draftId, options?.deliveryOrigin);
  return invalidateLocalOAuthMailboxResult(userId, result);
}
