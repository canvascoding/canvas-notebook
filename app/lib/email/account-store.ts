import 'server-only';

import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { emailAccounts } from '@/app/lib/db/schema';
import { normalizeEmailPolicyList, type EmailPolicy } from '@/app/lib/email/policy';
import {
  deleteEmailAccountSecret,
  emailAccountSecretRef,
  readEmailAccountSecret,
  writeEmailAccountSecret,
  type EmailAccountOAuthSecret,
  type EmailAccountSecret,
} from '@/app/lib/email/secret-store';

export type StoredEmailProvider = 'google' | 'microsoft' | 'smtp_imap';
export type StoredEmailAuthType = 'oauth' | 'smtp_imap';
export type StoredEmailAccountStatus = 'active' | 'expired' | 'revoked' | 'disconnected' | 'legacy_unassigned';

export type StoredEmailAccount = typeof emailAccounts.$inferSelect;

export type PublicEmailAccount = {
  id: string;
  provider: string;
  authType: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  scope: string | null;
  expiresAt: string | null;
  policy: EmailPolicy;
  createdAt: string;
  updatedAt: string;
};

function normalizeEmailAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) throw new Error('Email account requires a valid email address.');
  return normalized;
}

function normalizePolicy(policy?: Partial<EmailPolicy> | null): EmailPolicy {
  return {
    readFrom: normalizeEmailPolicyList(policy?.readFrom),
    sendTo: normalizeEmailPolicyList(policy?.sendTo),
  };
}

function parsePolicyJson(value: string): EmailPolicy {
  try {
    const parsed = JSON.parse(value) as Partial<EmailPolicy>;
    return normalizePolicy(parsed);
  } catch {
    return { readFrom: [], sendTo: [] };
  }
}

function accountIdFor(userId: string, provider: StoredEmailProvider, emailAddress: string): string {
  const hash = crypto.createHash('sha256').update(`${userId}:${provider}:${emailAddress}`).digest('hex').slice(0, 16);
  return `local_${provider}_${hash}`;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function publicStoredEmailAccount(account: StoredEmailAccount, secret?: EmailAccountSecret | null): PublicEmailAccount {
  return {
    id: account.id,
    provider: account.provider,
    authType: account.authType,
    emailAddress: account.emailAddress,
    displayName: account.displayName || null,
    status: account.status,
    scope: secret?.authType === 'oauth' ? secret.scope || null : null,
    expiresAt: secret?.authType === 'oauth' ? secret.expiresAt || null : null,
    policy: parsePolicyJson(account.policyJson),
    createdAt: toIso(account.createdAt) || new Date(0).toISOString(),
    updatedAt: toIso(account.updatedAt) || new Date(0).toISOString(),
  };
}

export async function listEmailAccountRecordsForUser(userId: string): Promise<StoredEmailAccount[]> {
  return db.query.emailAccounts.findMany({
    where: and(eq(emailAccounts.userId, userId), eq(emailAccounts.status, 'active')),
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
  });
}

export async function listPublicEmailAccountsForUser(userId: string): Promise<PublicEmailAccount[]> {
  const accounts = await listEmailAccountRecordsForUser(userId);
  const publicAccounts: PublicEmailAccount[] = [];
  for (const account of accounts) {
    const secret = await readEmailAccountSecret(account.secretRef).catch(() => null);
    publicAccounts.push(publicStoredEmailAccount(account, secret));
  }
  return publicAccounts;
}

export async function getEmailAccountForUser(userId: string, accountId?: string): Promise<StoredEmailAccount> {
  const account = accountId
    ? await db.query.emailAccounts.findFirst({
        where: and(eq(emailAccounts.userId, userId), eq(emailAccounts.id, accountId), eq(emailAccounts.status, 'active')),
      })
    : await db.query.emailAccounts.findFirst({
        where: and(eq(emailAccounts.userId, userId), eq(emailAccounts.status, 'active')),
        orderBy: (table, { desc }) => [desc(table.updatedAt)],
      });

  if (!account) throw new Error(accountId ? 'Email account not found.' : 'No active email account is connected.');
  return account;
}

export async function readStoredEmailAccountSecret(account: StoredEmailAccount): Promise<EmailAccountSecret> {
  return readEmailAccountSecret(account.secretRef);
}

export async function saveStoredEmailAccountOAuthSecret(account: StoredEmailAccount, secret: EmailAccountOAuthSecret): Promise<void> {
  await writeEmailAccountSecret(account.secretRef, secret);
  await db.update(emailAccounts)
    .set({ updatedAt: new Date() })
    .where(and(eq(emailAccounts.userId, account.userId), eq(emailAccounts.id, account.id)));
}

export async function setStoredEmailAccountStatus(
  account: StoredEmailAccount,
  status: StoredEmailAccountStatus,
): Promise<void> {
  await db.update(emailAccounts)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(emailAccounts.userId, account.userId), eq(emailAccounts.id, account.id)));
}

export async function updateStoredEmailPolicy(
  userId: string,
  accountId: string,
  policy: Partial<EmailPolicy>,
): Promise<PublicEmailAccount> {
  const account = await getEmailAccountForUser(userId, accountId);
  const currentPolicy = parsePolicyJson(account.policyJson);
  const nextPolicy = normalizePolicy({
    readFrom: policy.readFrom === undefined ? currentPolicy.readFrom : policy.readFrom,
    sendTo: policy.sendTo === undefined ? currentPolicy.sendTo : policy.sendTo,
  });

  await db.update(emailAccounts)
    .set({ policyJson: JSON.stringify(nextPolicy), updatedAt: new Date() })
    .where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.id, accountId)));

  const updated = await getEmailAccountForUser(userId, accountId);
  const secret = await readEmailAccountSecret(updated.secretRef).catch(() => null);
  return publicStoredEmailAccount(updated, secret);
}

export async function disconnectStoredEmailAccount(userId: string, accountId: string): Promise<boolean> {
  const account = await getEmailAccountForUser(userId, accountId);
  await db.delete(emailAccounts).where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.id, accountId)));
  await deleteEmailAccountSecret(account.secretRef);
  return true;
}

export async function upsertOAuthEmailAccount(params: {
  userId: string;
  accountId?: string;
  provider: Exclude<StoredEmailProvider, 'smtp_imap'>;
  providerAccountId?: string;
  emailAddress: string;
  displayName?: string | null;
  policy?: Partial<EmailPolicy> | null;
  secret: EmailAccountOAuthSecret;
  createdAt?: Date;
}): Promise<StoredEmailAccount> {
  const emailAddress = normalizeEmailAddress(params.emailAddress);
  const existing = await db.query.emailAccounts.findFirst({
    where: and(
      eq(emailAccounts.userId, params.userId),
      eq(emailAccounts.provider, params.provider),
      eq(emailAccounts.emailAddress, emailAddress),
    ),
  });
  const now = new Date();
  const id = existing?.id || params.accountId || accountIdFor(params.userId, params.provider, emailAddress);
  const secretRef = existing?.secretRef || emailAccountSecretRef(params.userId, id);
  const policy = normalizePolicy(params.policy || (existing ? parsePolicyJson(existing.policyJson) : null));
  let nextSecret = params.secret;

  if (existing && !nextSecret.refreshToken) {
    const existingSecret = await readEmailAccountSecret(existing.secretRef).catch(() => null);
    if (existingSecret?.authType === 'oauth') {
      nextSecret = {
        ...existingSecret,
        ...nextSecret,
        refreshToken: existingSecret.refreshToken,
        expiresAt: nextSecret.expiresAt || existingSecret.expiresAt,
        scope: nextSecret.scope || existingSecret.scope,
      };
    }
  }

  await writeEmailAccountSecret(secretRef, nextSecret);

  if (existing) {
    await db.update(emailAccounts)
      .set({
        providerAccountId: params.providerAccountId || existing.providerAccountId,
        displayName: params.displayName ?? existing.displayName,
        authType: 'oauth',
        status: 'active',
        policyJson: JSON.stringify(policy),
        secretRef,
        updatedAt: now,
      })
      .where(and(eq(emailAccounts.userId, params.userId), eq(emailAccounts.id, existing.id)));
    return getEmailAccountForUser(params.userId, existing.id);
  }

  await db.insert(emailAccounts).values({
    id,
    userId: params.userId,
    provider: params.provider,
    authType: 'oauth',
    emailAddress,
    displayName: params.displayName ?? null,
    providerAccountId: params.providerAccountId ?? null,
    status: 'active',
    policyJson: JSON.stringify(policy),
    secretRef,
    lastUsedAt: null,
    createdAt: params.createdAt || now,
    updatedAt: now,
  });

  return getEmailAccountForUser(params.userId, id);
}
