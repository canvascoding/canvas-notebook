import 'server-only';

import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import {
  getEmailAccountForUser,
  publicStoredEmailAccount,
  readStoredEmailAccountSecret,
  upsertSmtpEmailAccount,
} from '@/app/lib/email/account-store';
import {
  createStoredEmailDraft,
  getStoredEmailDraft,
  markStoredEmailDraftSent,
  publicEmailDraft,
  updateStoredEmailDraft,
  type LocalEmailDraftInput,
} from '@/app/lib/email/draft-store';
import { resolveEmailAttachments } from '@/app/lib/email/attachments';
import {
  assertEmailRecipientsAllowed,
  normalizeEmailPolicyList,
  withEmailPolicyDefaultAddresses,
  type EmailPolicy,
} from '@/app/lib/email/policy';
import { normalizeEmailCustomHeaders, type EmailCustomHeaders } from '@/app/lib/email/headers';
import { verifyImapSecret } from '@/app/lib/email/imap-service';
import type { EmailAccountSmtpSecret } from '@/app/lib/email/secret-store';

export type SmtpAccountInput = {
  accountId?: string;
  emailAddress?: string;
  displayName?: string | null;
  smtpHost?: string;
  smtpPort?: number | string;
  smtpSecure?: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  imapHost?: string;
  imapPort?: number | string;
  imapSecure?: boolean;
  imapUsername?: string;
  imapPassword?: string;
  policy?: Partial<EmailPolicy>;
};

type SmtpEmailInput = LocalEmailDraftInput & {
  headers?: EmailCustomHeaders;
};

type SmtpTransportFactory = (options: SMTPTransport.Options) => nodemailer.Transporter;

let smtpTransportFactory: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

export function setSmtpTransportFactoryForTests(factory: SmtpTransportFactory | null): void {
  smtpTransportFactory = factory || ((options) => nodemailer.createTransport(options));
}

function normalizeHost(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(normalized) || /[/?#\\]/u.test(normalized)) {
    throw new Error(`${label} must be a host name or IP address, not a URL.`);
  }
  return normalized;
}

function normalizeOptionalHost(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeHost(value, label);
}

function normalizePort(value: unknown, label: string): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    throw new Error(`${label} must be a port between 1 and 65535.`);
  }
  return numeric;
}

function normalizeOptionalPort(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizePort(value, label);
}

function normalizeEmailAddress(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Email address is required.');
  const normalized = value.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) throw new Error('Email address is required.');
  return normalized;
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function normalizePassword(value: unknown, fallback: string | undefined, label: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (fallback) return fallback;
  throw new Error(`${label} is required.`);
}

function normalizeSmtpInput(input: SmtpAccountInput, existingSecret?: EmailAccountSmtpSecret | null): {
  emailAddress: string;
  displayName: string | null;
  policy?: Partial<EmailPolicy>;
  secret: EmailAccountSmtpSecret;
} {
  const emailAddress = normalizeEmailAddress(input.emailAddress);
  const smtpHost = normalizeHost(input.smtpHost, 'SMTP host');
  const smtpPort = normalizePort(input.smtpPort, 'SMTP port');
  const smtpUsername = normalizeRequiredString(input.smtpUsername, 'SMTP username');
  const smtpPassword = normalizePassword(input.smtpPassword, existingSecret?.smtp.password, 'SMTP password');
  const imapHost = normalizeOptionalHost(input.imapHost, 'IMAP host');
  const imapPort = normalizeOptionalPort(input.imapPort, 'IMAP port');
  const imapUsername = input.imapUsername ? normalizeRequiredString(input.imapUsername, 'IMAP username') : undefined;
  const imapPassword = input.imapPassword ? normalizeRequiredString(input.imapPassword, 'IMAP password') : existingSecret?.imap?.password;

  if ((imapHost || imapPort || imapUsername || imapPassword) && (!imapHost || !imapPort || !imapUsername || !imapPassword)) {
    throw new Error('IMAP host, port, username, and password are all required when IMAP is configured.');
  }

  return {
    emailAddress,
    displayName: typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : null,
    policy: input.policy === undefined || input.policy === null ? undefined : {
      readFrom: normalizeEmailPolicyList(input.policy?.readFrom),
      sendTo: normalizeEmailPolicyList(input.policy?.sendTo),
    },
    secret: {
      authType: 'smtp_imap',
      smtp: {
        host: smtpHost,
        port: smtpPort,
        secure: Boolean(input.smtpSecure),
        username: smtpUsername,
        password: smtpPassword,
      },
      imap: imapHost && imapPort && imapUsername && imapPassword ? {
        host: imapHost,
        port: imapPort,
        secure: Boolean(input.imapSecure),
        username: imapUsername,
        password: imapPassword,
      } : undefined,
    },
  };
}

function smtpTransportOptions(secret: EmailAccountSmtpSecret): SMTPTransport.Options {
  return {
    host: secret.smtp.host,
    port: secret.smtp.port,
    secure: secret.smtp.secure,
    auth: {
      user: secret.smtp.username,
      pass: secret.smtp.password,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

async function verifySmtpSecret(secret: EmailAccountSmtpSecret): Promise<void> {
  const transporter = smtpTransportFactory(smtpTransportOptions(secret));
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}

function policyForAccount(account: Awaited<ReturnType<typeof getEmailAccountForUser>>): EmailPolicy {
  try {
    const parsed = JSON.parse(account.policyJson) as Partial<EmailPolicy>;
    return withEmailPolicyDefaultAddresses(parsed, [account.emailAddress]);
  } catch {
    return { readFrom: [], sendTo: [] };
  }
}

function draftInputFromStored(draft: Awaited<ReturnType<typeof getStoredEmailDraft>>): LocalEmailDraftInput {
  if (!draft) throw new Error('Email draft not found.');
  return publicEmailDraft(draft) as LocalEmailDraftInput;
}

async function readExistingSmtpSecretForInput(userId: string, input: SmtpAccountInput): Promise<EmailAccountSmtpSecret | null> {
  if (!input.accountId) return null;
  const existingAccount = await getEmailAccountForUser(userId, input.accountId);
  const secret = await readStoredEmailAccountSecret(existingAccount);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');
  return secret;
}

export async function saveSmtpEmailAccount(userId: string, input: SmtpAccountInput, options?: { verify?: boolean }) {
  const existingSecret = await readExistingSmtpSecretForInput(userId, input);
  const normalized = normalizeSmtpInput(input, existingSecret);
  if (options?.verify) {
    await verifySmtpSecret(normalized.secret);
    await verifyImapSecret(normalized.secret);
  }
  const account = await upsertSmtpEmailAccount({
    userId,
    accountId: input.accountId,
    emailAddress: normalized.emailAddress,
    displayName: normalized.displayName,
    policy: normalized.policy,
    secret: normalized.secret,
  });
  return publicStoredEmailAccount(account, normalized.secret);
}

export async function testSmtpConnection(userId: string, input: SmtpAccountInput) {
  const existingSecret = await readExistingSmtpSecretForInput(userId, input);
  const normalized = normalizeSmtpInput(input, existingSecret);
  await verifySmtpSecret(normalized.secret);
  await verifyImapSecret(normalized.secret);
  return {
    ok: true,
    smtpHost: normalized.secret.smtp.host,
    smtpPort: normalized.secret.smtp.port,
    smtpSecure: normalized.secret.smtp.secure,
    imapHost: normalized.secret.imap?.host || null,
    imapPort: normalized.secret.imap?.port || null,
    imapSecure: normalized.secret.imap?.secure ?? null,
  };
}

export async function testStoredSmtpEmailAccount(userId: string, accountId: string) {
  const account = await getEmailAccountForUser(userId, accountId);
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP/IMAP account.');

  const smtp = { ok: false, host: secret.smtp.host, port: secret.smtp.port, secure: secret.smtp.secure, error: null as string | null };
  const imap = {
    ok: false,
    configured: Boolean(secret.imap),
    host: secret.imap?.host || null,
    port: secret.imap?.port || null,
    secure: secret.imap?.secure ?? null,
    error: null as string | null,
  };

  try {
    await verifySmtpSecret(secret);
    smtp.ok = true;
  } catch (error) {
    smtp.error = error instanceof Error ? error.message : 'SMTP connection failed.';
  }

  if (secret.imap) {
    try {
      await verifyImapSecret(secret);
      imap.ok = true;
    } catch (error) {
      imap.error = error instanceof Error ? error.message : 'IMAP connection failed.';
    }
  }

  return {
    ok: smtp.ok && (!imap.configured || imap.ok),
    account: publicStoredEmailAccount(account, secret),
    smtp,
    imap,
  };
}

export async function createSmtpEmailDraft(userId: string, input: LocalEmailDraftInput) {
  const account = await getEmailAccountForUser(userId, input.accountId);
  const policy = policyForAccount(account);
  const recipients = [...input.to, ...(input.cc || []), ...(input.bcc || [])];
  assertEmailRecipientsAllowed(recipients, policy.sendTo);
  const draft = await createStoredEmailDraft(userId, input);
  return { account: await publicStoredEmailAccount(account, await readStoredEmailAccountSecret(account)), draft: publicEmailDraft(draft) };
}

export async function updateSmtpEmailDraft(userId: string, draftId: string, input: LocalEmailDraftInput) {
  const account = await getEmailAccountForUser(userId, input.accountId);
  const policy = policyForAccount(account);
  const recipients = [...input.to, ...(input.cc || []), ...(input.bcc || [])];
  assertEmailRecipientsAllowed(recipients, policy.sendTo);
  const draft = await updateStoredEmailDraft(userId, draftId, input);
  return { account: await publicStoredEmailAccount(account, await readStoredEmailAccountSecret(account)), draft: publicEmailDraft(draft) };
}

async function sendSmtpMessage(secret: EmailAccountSmtpSecret, from: { name?: string | null; address: string }, input: SmtpEmailInput) {
  const transporter = smtpTransportFactory(smtpTransportOptions(secret));
  try {
    const attachments = await resolveEmailAttachments(input.attachments);
    return await transporter.sendMail({
      from: from.name ? { name: from.name, address: from.address } : from.address,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      headers: normalizeEmailCustomHeaders(input.headers),
      ...(input.is_HTML ? { html: input.body } : { text: input.body }),
      ...(attachments.length > 0 ? {
        attachments: attachments.map((attachment) => ({
          ...(attachment.disposition === 'inline' && attachment.contentId ? {
            cid: attachment.contentId,
            contentDisposition: 'inline' as const,
          } : {}),
          content: attachment.content,
          contentType: attachment.mimeType,
          filename: attachment.name,
        })),
      } : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } finally {
    transporter.close();
  }
}

export async function sendSmtpEmail(userId: string, input: LocalEmailDraftInput) {
  const account = await getEmailAccountForUser(userId, input.accountId);
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP account.');
  const policy = policyForAccount(account);
  const recipients = [...input.to, ...(input.cc || []), ...(input.bcc || [])];
  assertEmailRecipientsAllowed(recipients, policy.sendTo);

  const result = await sendSmtpMessage(secret, { name: account.displayName, address: account.emailAddress }, input);
  return {
    account: publicStoredEmailAccount(account, secret),
    sent: true,
    messageId: typeof result.messageId === 'string' ? result.messageId : null,
  };
}

export async function sendSmtpEmailDraft(userId: string, accountId: string, draftId: string) {
  const account = await getEmailAccountForUser(userId, accountId);
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'smtp_imap') throw new Error('Email account is not an SMTP account.');
  const draft = await getStoredEmailDraft(userId, draftId);
  if (!draft || draft.accountId !== accountId || draft.status !== 'draft') throw new Error('Email draft not found.');
  const input = draftInputFromStored(draft);
  const policy = policyForAccount(account);
  const recipients = [...input.to, ...(input.cc || []), ...(input.bcc || [])];
  assertEmailRecipientsAllowed(recipients, policy.sendTo);

  await sendSmtpMessage(secret, { name: account.displayName, address: account.emailAddress }, input);

  const sentDraft = await markStoredEmailDraftSent(userId, draftId);
  return {
    account: publicStoredEmailAccount(account, secret),
    sent: true,
    draftId,
    draft: publicEmailDraft(sentDraft),
  };
}
