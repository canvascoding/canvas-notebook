import 'server-only';

import { ImapFlow } from 'imapflow';
import type {
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ImapFlowOptions,
  ListResponse,
  MessageAddressObject,
  MessageEnvelopeObject,
  SearchObject,
  SequenceString,
} from 'imapflow';
import { simpleParser } from 'mailparser';

import {
  publicStoredEmailAccount,
  readStoredEmailAccountSecret,
  type StoredEmailAccount,
} from '@/app/lib/email/account-store';
import {
  assertEmailSenderAllowed,
  isEmailAddressAllowed,
  normalizeEmailPolicyList,
  type EmailPolicy,
} from '@/app/lib/email/policy';
import type { EmailAccountSmtpSecret } from '@/app/lib/email/secret-store';

type ImapLock = { release(): void };

type ImapClientLike = {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(options?: { statusQuery?: { messages?: boolean; unseen?: boolean } }): Promise<ListResponse[]>;
  getMailboxLock(path: string | string[]): Promise<ImapLock>;
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false>;
  fetch(range: SequenceString | number[] | SearchObject, query: FetchQueryObject, options?: FetchOptions): AsyncIterable<FetchMessageObject>;
  fetchOne(seq: SequenceString, query: FetchQueryObject, options?: FetchOptions): Promise<FetchMessageObject | false>;
  messageFlagsAdd(
    range: SequenceString | number[] | SearchObject,
    flags: string[],
    options?: { uid?: boolean; silent?: boolean },
  ): Promise<boolean>;
  messageFlagsRemove(
    range: SequenceString | number[] | SearchObject,
    flags: string[],
    options?: { uid?: boolean; silent?: boolean },
  ): Promise<boolean>;
  messageDelete(range: SequenceString | number[] | SearchObject, options?: { uid?: boolean }): Promise<boolean>;
  messageMove(
    range: SequenceString | number[] | SearchObject,
    destination: string,
    options?: { uid?: boolean },
  ): Promise<unknown | false>;
};

type ImapClientFactory = (secret: EmailAccountSmtpSecret) => ImapClientLike;

export type EmailFolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'custom';

export type EmailFolder = {
  id: string;
  name: string;
  path: string;
  role: EmailFolderRole;
  selectable: boolean;
  messageCount: number | null;
  unseenCount: number | null;
};

type ImapMessageFilter = 'all' | 'unread' | 'answered' | 'unanswered' | 'flagged' | 'attachments';

type ImapEmailListInput = {
  query?: string;
  folder?: string;
  filter?: string;
  limit?: number;
  offset?: number;
  from?: string;
  hasAttachments?: boolean;
};

const SEARCH_QUERY_MAX_LENGTH = 250;
const SEARCH_SOURCE_MAX_BYTES = 64 * 1024;
const READ_SOURCE_MAX_BYTES = 1024 * 1024;

let imapClientFactory: ImapClientFactory = (secret) => new ImapFlow(imapClientOptions(secret));

export function setImapClientFactoryForTests(factory: ImapClientFactory | null): void {
  imapClientFactory = factory || ((secret) => new ImapFlow(imapClientOptions(secret)));
}

function imapClientOptions(secret: EmailAccountSmtpSecret): ImapFlowOptions {
  const imap = requireImapSecret(secret);
  return {
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: {
      user: imap.username,
      pass: imap.password,
    },
    clientInfo: {
      name: 'Canvas Notebook',
      vendor: 'Canvas Studios',
    },
    disableAutoIdle: true,
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    maxLineLength: 256 * 1024,
    maxLiteralSize: READ_SOURCE_MAX_BYTES + 128 * 1024,
  };
}

function requireImapSecret(secret: EmailAccountSmtpSecret): NonNullable<EmailAccountSmtpSecret['imap']> {
  if (!secret.imap) throw new Error('IMAP is not configured for this email account.');
  return secret.imap;
}

async function closeImapClient(client: ImapClientLike): Promise<void> {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}

async function withImapClient<T>(secret: EmailAccountSmtpSecret, callback: (client: ImapClientLike) => Promise<T>): Promise<T> {
  requireImapSecret(secret);
  const client = imapClientFactory(secret);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await callback(client);
  } finally {
    if (connected) {
      await closeImapClient(client);
    } else {
      client.close();
    }
  }
}

async function withImapMailbox<T>(
  secret: EmailAccountSmtpSecret,
  folder: string | undefined,
  callback: (client: ImapClientLike, folder: string) => Promise<T>,
): Promise<T> {
  requireImapSecret(secret);
  const client = imapClientFactory(secret);
  let connected = false;
  let lock: ImapLock | null = null;
  const folderPath = normalizeFolderPath(folder);
  try {
    await client.connect();
    connected = true;
    lock = await client.getMailboxLock(folderPath);
    return await callback(client, folderPath);
  } finally {
    try {
      lock?.release();
    } finally {
      if (connected) {
        await closeImapClient(client);
      } else {
        client.close();
      }
    }
  }
}

export async function verifyImapSecret(secret: EmailAccountSmtpSecret): Promise<void> {
  if (!secret.imap) return;
  const client = imapClientFactory(secret);
  let connected = false;
  try {
    await client.connect();
    connected = true;
  } finally {
    if (connected) {
      await closeImapClient(client);
    } else {
      client.close();
    }
  }
}

function policyForAccount(account: StoredEmailAccount): EmailPolicy {
  try {
    const parsed = JSON.parse(account.policyJson) as Partial<EmailPolicy>;
    return {
      readFrom: normalizeEmailPolicyList(parsed.readFrom),
      sendTo: normalizeEmailPolicyList(parsed.sendTo),
    };
  } catch {
    return { readFrom: [], sendTo: [] };
  }
}

function normalizeSearchQuery(query: string | undefined): string {
  return (query || '').trim().replace(/\s+/gu, ' ').slice(0, SEARCH_QUERY_MAX_LENGTH);
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(Math.max(Number.isFinite(limit) ? Number(limit) : 10, 1), 50);
}

function normalizeOffset(offset: number | undefined): number {
  return Math.min(Math.max(Number.isFinite(offset) ? Number(offset) : 0, 0), 10_000);
}

function normalizeFolderPath(folder: string | undefined): string {
  const normalized = (folder || 'INBOX').trim().replace(/[\u0000\r\n]/gu, '').slice(0, 240);
  return normalized || 'INBOX';
}

function normalizeDestinationFolderPath(folder: string): string {
  const normalized = folder.trim().replace(/[\u0000\r\n]/gu, '').slice(0, 240);
  if (!normalized) throw new Error('A destination folder is required.');
  return normalized;
}

function parseUid(messageId: string): number {
  if (!/^[1-9]\d*$/u.test(messageId)) throw new Error('Invalid IMAP message ID.');
  const uid = Number.parseInt(messageId, 10);
  if (!Number.isSafeInteger(uid)) throw new Error('Invalid IMAP message ID.');
  return uid;
}

function formatAddress(address: MessageAddressObject | undefined): string {
  if (!address?.address) return '';
  const email = address.address.trim();
  const name = address.name?.trim();
  return name ? `${name} <${email}>` : email;
}

function formatAddressList(addresses: MessageAddressObject[] | undefined): string[] {
  return (addresses || []).map(formatAddress).filter(Boolean);
}

function firstAddress(envelope: MessageEnvelopeObject | undefined): string {
  return formatAddress(envelope?.from?.[0]);
}

function isoDate(value: Date | string | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function snippetFromText(value: string | undefined): string {
  return (value || '').replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function normalizeReferences(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry).split(/\s+/u))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function filterForInput(input: ImapEmailListInput): ImapMessageFilter {
  const value = String(input.filter || '').trim().toLowerCase();
  if (value === 'unread' || value === 'answered' || value === 'unanswered' || value === 'flagged' || value === 'attachments') {
    return value;
  }
  return input.hasAttachments ? 'attachments' : 'all';
}

function searchObjectForInput(input: ImapEmailListInput): SearchObject {
  const query = normalizeSearchQuery(input.query);
  const filter = filterForInput(input);
  const search: SearchObject = query ? { text: query } : {};

  if (filter === 'unread') search.seen = false;
  if (filter === 'answered') search.answered = true;
  if (filter === 'unanswered') search.answered = false;
  if (filter === 'flagged') search.flagged = true;

  const from = input.from?.trim();
  if (from) search.from = from.slice(0, SEARCH_QUERY_MAX_LENGTH);

  if (Object.keys(search).length === 0 || filter === 'attachments') search.all = true;
  return search;
}

function hasAttachmentBodyStructure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const node = value as {
    disposition?: string;
    dispositionParameters?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    childNodes?: unknown[];
  };
  if (String(node.disposition || '').toLowerCase() === 'attachment') return true;
  if (typeof node.dispositionParameters?.filename === 'string' || typeof node.parameters?.name === 'string') return true;
  return Array.isArray(node.childNodes) && node.childNodes.some(hasAttachmentBodyStructure);
}

function publicFlags(flags: unknown): string[] {
  if (flags instanceof Set) return Array.from(flags).map(String);
  if (Array.isArray(flags)) return flags.map(String);
  return [];
}

function hasFlag(flags: string[], flag: string): boolean {
  return flags.some((item) => item.toLowerCase() === flag.toLowerCase());
}

function folderRole(path: string, specialUse?: string): EmailFolderRole {
  const normalizedSpecialUse = String(specialUse || '').toLowerCase();
  if (normalizedSpecialUse.includes('inbox')) return 'inbox';
  if (normalizedSpecialUse.includes('sent')) return 'sent';
  if (normalizedSpecialUse.includes('draft')) return 'drafts';
  if (normalizedSpecialUse.includes('trash')) return 'trash';
  if (normalizedSpecialUse.includes('junk')) return 'junk';
  if (normalizedSpecialUse.includes('archive') || normalizedSpecialUse.includes('all')) return 'archive';

  const lowerPath = path.toLowerCase();
  if (lowerPath === 'inbox') return 'inbox';
  if (lowerPath.includes('sent')) return 'sent';
  if (lowerPath.includes('draft')) return 'drafts';
  if (lowerPath.includes('trash') || lowerPath.includes('bin') || lowerPath.includes('deleted')) return 'trash';
  if (lowerPath.includes('spam') || lowerPath.includes('junk')) return 'junk';
  if (lowerPath.includes('archive') || lowerPath.includes('all mail')) return 'archive';
  return 'custom';
}

function folderDisplayName(path: string, fallbackName?: string): string {
  if (fallbackName?.trim()) return fallbackName.trim();
  const parts = path.split(/[/.]/u).map((item) => item.trim()).filter(Boolean);
  return parts.at(-1) || path;
}

function normalizeFolder(folder: ListResponse): EmailFolder {
  const path = folder.path || folder.name || 'INBOX';
  const flags = folder.flags instanceof Set ? Array.from(folder.flags).map(String) : [];
  return {
    id: path,
    path,
    name: folderDisplayName(path, folder.name),
    role: folderRole(path, folder.specialUse),
    selectable: !flags.some((flag) => flag.toLowerCase() === '\\noselect'),
    messageCount: typeof folder.status?.messages === 'number' ? folder.status.messages : null,
    unseenCount: typeof folder.status?.unseen === 'number' ? folder.status.unseen : null,
  };
}

function sortFolders(folders: EmailFolder[]): EmailFolder[] {
  const weight: Record<EmailFolderRole, number> = {
    inbox: 0,
    sent: 1,
    drafts: 2,
    archive: 3,
    junk: 4,
    trash: 5,
    custom: 6,
  };
  return folders.toSorted((left, right) => {
    const roleDelta = weight[left.role] - weight[right.role];
    if (roleDelta !== 0) return roleDelta;
    return left.name.localeCompare(right.name);
  });
}

async function resolveFolderByRole(
  client: ImapClientLike,
  role: EmailFolderRole,
  fallbackNames: string[],
): Promise<string> {
  const folders = (await client.list({ statusQuery: {} })).map(normalizeFolder).filter((folder) => folder.selectable);
  const byRole = folders.find((folder) => folder.role === role);

  if (byRole) {
    return byRole.path;
  }

  const normalizedFallbacks = fallbackNames.map((name) => name.toLowerCase());
  const byName = folders.find((folder) => normalizedFallbacks.includes(folder.path.toLowerCase()));

  if (byName) {
    return byName.path;
  }

  return fallbackNames[0] || 'INBOX';
}

function mutationResult(
  account: StoredEmailAccount,
  secret: EmailAccountSmtpSecret,
  action: string,
  messageId: number,
  folder: string,
  destination?: string,
) {
  return {
    account: publicImapAccount(account, secret),
    action,
    destination,
    folder,
    messageId: String(messageId),
  };
}

async function updateImapMessageFlag(
  account: StoredEmailAccount,
  messageId: string,
  folder: string | undefined,
  flag: string,
  enabled: boolean,
  action: string,
) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const uid = parseUid(messageId);
  const result = await withImapMailbox(secret, folder, async (client, folderPath) => {
    const updated = enabled
      ? await client.messageFlagsAdd([uid], [flag], { uid: true })
      : await client.messageFlagsRemove([uid], [flag], { uid: true });

    if (!updated) {
      throw new Error('Email message could not be updated.');
    }

    return mutationResult(account, secret, action, uid, folderPath);
  });

  return result;
}

async function moveImapMessageToFolder(
  account: StoredEmailAccount,
  messageId: string,
  folder: string | undefined,
  destination: string,
  action: string,
) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const uid = parseUid(messageId);
  const destinationFolder = normalizeDestinationFolderPath(destination);
  const result = await withImapMailbox(secret, folder, async (client, folderPath) => {
    const moved = await client.messageMove([uid], destinationFolder, { uid: true });

    if (!moved) {
      throw new Error('Email message could not be moved.');
    }

    return mutationResult(account, secret, action, uid, folderPath, destinationFolder);
  });

  return result;
}

async function snippetFromSource(source: Buffer | undefined): Promise<string> {
  if (!source?.length) return '';
  try {
    const parsed = await simpleParser(source, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      maxHtmlLengthToParse: 128 * 1024,
    });
    const body = parsed.text || (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/gu, ' ') : '');
    return snippetFromText(body);
  } catch {
    return '';
  }
}

function publicImapAccount(account: StoredEmailAccount, secret: EmailAccountSmtpSecret) {
  return publicStoredEmailAccount(account, secret);
}

export async function listImapEmailFolders(account: StoredEmailAccount) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);

  const folders = await withImapClient(secret, async (client) => {
    const listed = await client.list({ statusQuery: { messages: true, unseen: true } });
    const normalized = listed.map(normalizeFolder).filter((folder) => folder.selectable);
    if (!normalized.some((folder) => folder.path.toLowerCase() === 'inbox')) {
      normalized.unshift({
        id: 'INBOX',
        name: 'Inbox',
        path: 'INBOX',
        role: 'inbox',
        selectable: true,
        messageCount: null,
        unseenCount: null,
      });
    }
    return sortFolders(normalized);
  });

  return {
    account: publicImapAccount(account, secret),
    folders,
  };
}

export async function listImapEmailMessages(account: StoredEmailAccount, input: ImapEmailListInput) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const query = normalizeSearchQuery(input.query);
  const limit = normalizeLimit(input.limit);
  const offset = normalizeOffset(input.offset);
  const filter = filterForInput(input);
  const policy = policyForAccount(account);

  const result = await withImapMailbox(secret, input.folder, async (client, folder) => {
    const found = await client.search(query ? searchObjectForInput({ ...input, query }) : searchObjectForInput(input), { uid: true });
    const ordered = (found || []).slice().reverse();
    const candidateLimit = filter === 'attachments' ? Math.max(limit * 8, 200) : limit;
    const uids = ordered.slice(offset, offset + candidateLimit);
    if (uids.length === 0) {
      return {
        folder,
        messages: [],
        total: ordered.length,
        offset,
        limit,
      };
    }

    const loaded: FetchMessageObject[] = [];
    for await (const message of client.fetch(uids, {
      uid: true,
      flags: true,
      envelope: true,
      internalDate: true,
      size: true,
      bodyStructure: true,
      source: { maxLength: SEARCH_SOURCE_MAX_BYTES },
      threadId: true,
    }, { uid: true })) {
      loaded.push(message);
    }

    const order = new Map(uids.map((uid, index) => [uid, index]));
    loaded.sort((left, right) => (order.get(left.uid) ?? 0) - (order.get(right.uid) ?? 0));

    const normalized = [];
    for (const message of loaded) {
      const from = firstAddress(message.envelope);
      if (!isEmailAddressAllowed(from, policy.readFrom)) continue;
      const hasAttachments = hasAttachmentBodyStructure(message.bodyStructure);
      if (filter === 'attachments' && !hasAttachments) continue;
      const flags = publicFlags(message.flags);
      normalized.push({
        id: String(message.uid),
        uid: String(message.uid),
        folder,
        threadId: message.threadId || String(message.uid),
        from,
        to: formatAddressList(message.envelope?.to),
        cc: formatAddressList(message.envelope?.cc),
        subject: message.envelope?.subject || '',
        date: isoDate(message.envelope?.date || message.internalDate),
        size: message.size || null,
        flags,
        isRead: hasFlag(flags, '\\Seen'),
        isAnswered: hasFlag(flags, '\\Answered'),
        isFlagged: hasFlag(flags, '\\Flagged'),
        hasAttachments,
        snippet: await snippetFromSource(message.source),
      });
    }
    return {
      folder,
      messages: normalized.slice(0, limit),
      total: ordered.length,
      offset,
      limit,
    };
  });

  return {
    account: publicImapAccount(account, secret),
    ...result,
  };
}

export async function searchImapEmail(account: StoredEmailAccount, input: ImapEmailListInput) {
  const result = await listImapEmailMessages(account, {
    ...input,
    folder: input.folder || 'INBOX',
  });

  return {
    account: result.account,
    messages: result.messages,
  };
}

export async function readImapEmailMessage(account: StoredEmailAccount, messageId: string, folder?: string) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const uid = parseUid(messageId);

  const message = await withImapMailbox(secret, folder, async (client, folderPath) => {
    const fetched = await client.fetchOne(uid, {
      uid: true,
      flags: true,
      envelope: true,
      internalDate: true,
      source: { maxLength: READ_SOURCE_MAX_BYTES },
      bodyStructure: true,
      threadId: true,
    }, { uid: true });
    if (!fetched) throw new Error('Email message not found.');

    const from = firstAddress(fetched.envelope);
    assertEmailSenderAllowed(from, policyForAccount(account).readFrom);
    const parsed = fetched.source ? await simpleParser(fetched.source, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      maxHtmlLengthToParse: 512 * 1024,
    }) : null;
    const body = parsed?.text || (typeof parsed?.html === 'string' ? parsed.html : '');
    const flags = publicFlags(fetched.flags);

    return {
      id: String(fetched.uid),
      uid: String(fetched.uid),
      folder: folderPath,
      threadId: fetched.threadId || String(fetched.uid),
      from,
      to: formatAddressList(fetched.envelope?.to),
      cc: formatAddressList(fetched.envelope?.cc),
      subject: fetched.envelope?.subject || parsed?.subject || '',
      date: isoDate(fetched.envelope?.date || fetched.internalDate || parsed?.date),
      messageId: parsed?.messageId || '',
      inReplyTo: parsed?.inReplyTo || '',
      references: normalizeReferences(parsed?.references),
      body,
      bodyHtml: typeof parsed?.html === 'string' ? parsed.html : '',
      attachments: (parsed?.attachments || []).map((attachment, index) => ({
        index,
        filename: attachment.filename || `attachment-${index + 1}`,
        contentType: attachment.contentType,
        size: attachment.size,
        contentId: attachment.contentId || null,
      })),
      flags,
      isRead: hasFlag(flags, '\\Seen'),
      isAnswered: hasFlag(flags, '\\Answered'),
      isFlagged: hasFlag(flags, '\\Flagged'),
      hasAttachments: hasAttachmentBodyStructure(fetched.bodyStructure),
      snippet: snippetFromText(body),
    };
  });

  return {
    account: publicImapAccount(account, secret),
    message,
  };
}

export async function setImapEmailMessageRead(account: StoredEmailAccount, messageId: string, folder: string | undefined, read: boolean) {
  return updateImapMessageFlag(account, messageId, folder, '\\Seen', read, read ? 'mark-read' : 'mark-unread');
}

export async function setImapEmailMessageAnswered(
  account: StoredEmailAccount,
  messageId: string,
  folder: string | undefined,
  answered: boolean,
) {
  return updateImapMessageFlag(account, messageId, folder, '\\Answered', answered, answered ? 'mark-answered' : 'clear-answered');
}

export async function moveImapEmailMessage(
  account: StoredEmailAccount,
  messageId: string,
  folder: string | undefined,
  destination: string,
) {
  return moveImapMessageToFolder(account, messageId, folder, destination, 'move');
}

export async function archiveImapEmailMessage(account: StoredEmailAccount, messageId: string, folder?: string) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const uid = parseUid(messageId);
  const result = await withImapMailbox(secret, folder, async (client, folderPath) => {
    const destination = await resolveFolderByRole(client, 'archive', ['Archive']);
    const moved = await client.messageMove([uid], destination, { uid: true });

    if (!moved) {
      throw new Error('Email message could not be archived.');
    }

    return mutationResult(account, secret, 'archive', uid, folderPath, destination);
  });

  return result;
}

export async function trashImapEmailMessage(account: StoredEmailAccount, messageId: string, folder?: string) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const uid = parseUid(messageId);
  const result = await withImapMailbox(secret, folder, async (client, folderPath) => {
    const destination = await resolveFolderByRole(client, 'trash', ['Trash', 'Deleted Items']);
    const moved = await client.messageMove([uid], destination, { uid: true });

    if (!moved) {
      throw new Error('Email message could not be moved to trash.');
    }

    return mutationResult(account, secret, 'trash', uid, folderPath, destination);
  });

  return result;
}

export async function deleteImapEmailMessagePermanently(account: StoredEmailAccount, messageId: string, folder?: string) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const uid = parseUid(messageId);
  const result = await withImapMailbox(secret, folder, async (client, folderPath) => {
    const deleted = await client.messageDelete([uid], { uid: true });

    if (!deleted) {
      throw new Error('Email message could not be deleted.');
    }

    return mutationResult(account, secret, 'permanent-delete', uid, folderPath);
  });

  return result;
}
