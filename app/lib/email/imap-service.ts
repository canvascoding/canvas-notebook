import 'server-only';

import { ImapFlow } from 'imapflow';
import type {
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ImapFlowOptions,
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
  getMailboxLock(path: string | string[]): Promise<ImapLock>;
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false>;
  fetch(range: SequenceString | number[] | SearchObject, query: FetchQueryObject, options?: FetchOptions): AsyncIterable<FetchMessageObject>;
  fetchOne(seq: SequenceString, query: FetchQueryObject, options?: FetchOptions): Promise<FetchMessageObject | false>;
};

type ImapClientFactory = (secret: EmailAccountSmtpSecret) => ImapClientLike;

type ImapEmailSearchInput = {
  query?: string;
  limit?: number;
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

async function withImapInbox<T>(secret: EmailAccountSmtpSecret, callback: (client: ImapClientLike) => Promise<T>): Promise<T> {
  requireImapSecret(secret);
  const client = imapClientFactory(secret);
  let connected = false;
  let lock: ImapLock | null = null;
  try {
    await client.connect();
    connected = true;
    lock = await client.getMailboxLock('INBOX');
    return await callback(client);
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

function searchObjectForQuery(query: string): SearchObject {
  if (!query) return { all: true };
  return { text: query };
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(Math.max(Number.isFinite(limit) ? Number(limit) : 10, 1), 25);
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

export async function searchImapEmail(account: StoredEmailAccount, input: ImapEmailSearchInput) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const query = normalizeSearchQuery(input.query);
  const limit = normalizeLimit(input.limit);
  const policy = policyForAccount(account);

  const messages = await withImapInbox(secret, async (client) => {
    const found = await client.search(searchObjectForQuery(query), { uid: true });
    const uids = (found || []).slice(-limit).reverse();
    if (uids.length === 0) return [];

    const loaded: FetchMessageObject[] = [];
    for await (const message of client.fetch(uids, {
      uid: true,
      envelope: true,
      internalDate: true,
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
      normalized.push({
        id: String(message.uid),
        threadId: message.threadId || String(message.uid),
        from,
        subject: message.envelope?.subject || '',
        date: isoDate(message.envelope?.date || message.internalDate),
        snippet: await snippetFromSource(message.source),
      });
    }
    return normalized;
  });

  return {
    account: publicImapAccount(account, secret),
    messages,
  };
}

export async function readImapEmailMessage(account: StoredEmailAccount, messageId: string) {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  requireImapSecret(secret);
  const uid = parseUid(messageId);

  const message = await withImapInbox(secret, async (client) => {
    const fetched = await client.fetchOne(uid, {
      uid: true,
      envelope: true,
      internalDate: true,
      source: { maxLength: READ_SOURCE_MAX_BYTES },
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

    return {
      id: String(fetched.uid),
      threadId: fetched.threadId || String(fetched.uid),
      from,
      to: formatAddressList(fetched.envelope?.to),
      cc: formatAddressList(fetched.envelope?.cc),
      subject: fetched.envelope?.subject || parsed?.subject || '',
      date: isoDate(fetched.envelope?.date || fetched.internalDate || parsed?.date),
      body,
      snippet: snippetFromText(body),
    };
  });

  return {
    account: publicImapAccount(account, secret),
    message,
  };
}
