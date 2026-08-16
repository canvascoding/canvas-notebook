import 'server-only';

import crypto from 'crypto';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { emailAccounts, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { withEmailPolicyDefaultAddresses, type EmailPolicy } from '@/app/lib/email/policy';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import {
  deleteEmailAccountSecret,
  emailAccountSecretRef,
  readEmailAccountSecret,
  writeEmailAccountSecret,
  type EmailAccountOAuthSecret,
  type EmailAccountSmtpSecret,
  type EmailAccountSecret,
} from '@/app/lib/email/secret-store';

export type StoredEmailProvider = 'google' | 'microsoft' | 'smtp_imap';
export type StoredEmailAuthType = 'oauth' | 'smtp_imap';
export type StoredEmailAccountStatus = 'active' | 'expired' | 'revoked' | 'disconnected' | 'legacy_unassigned';

export type StoredEmailAccount = typeof emailAccounts.$inferSelect;
export type StoredWorkspaceEmailMailbox = typeof workspaceEmailMailboxes.$inferSelect;

export type PublicEmailAccount = {
  id: string;
  provider: string;
  authType: string;
  emailAddress: string;
  displayName: string | null;
  isPrimary: boolean;
  status: string;
  workspaceId: string | null;
  scope: string | null;
  expiresAt: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  smtpUsername: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  imapUsername: string | null;
  policy: EmailPolicy;
  createdAt: string;
  updatedAt: string;
};

function normalizeEmailAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) throw new Error('Email account requires a valid email address.');
  return normalized;
}

type NormalizePolicyOptions = {
  defaultAddresses?: unknown[];
  seedDefaultsWhenEmpty?: boolean;
};

function normalizePolicy(policy?: Partial<EmailPolicy> | null, options: NormalizePolicyOptions = {}): EmailPolicy {
  return withEmailPolicyDefaultAddresses(policy, options.defaultAddresses || [], {
    seedWhenEmpty: options.seedDefaultsWhenEmpty,
  });
}

function parsePolicyJson(value: string, options: NormalizePolicyOptions = {}): EmailPolicy {
  try {
    const parsed = JSON.parse(value) as Partial<EmailPolicy>;
    return normalizePolicy(parsed, options);
  } catch {
    return normalizePolicy(null, options);
  }
}

function accountIdFor(userId: string, provider: StoredEmailProvider, emailAddress: string): string {
  const hash = crypto.createHash('sha256').update(`${userId}:${provider}:${emailAddress}`).digest('hex').slice(0, 16);
  return `local_${provider}_${hash}`;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function publicStoredEmailAccount(
  account: StoredEmailAccount,
  secret?: EmailAccountSecret | null,
  mailbox?: StoredWorkspaceEmailMailbox | null,
): PublicEmailAccount {
  return {
    id: account.id,
    provider: account.provider,
    authType: account.authType,
    emailAddress: account.emailAddress,
    displayName: account.displayName || null,
    isPrimary: Boolean(account.isPrimary),
    status: account.status,
    workspaceId: mailbox?.workspaceId || null,
    scope: secret?.authType === 'oauth' ? secret.scope || null : null,
    expiresAt: secret?.authType === 'oauth' ? secret.expiresAt || null : null,
    smtpHost: secret?.authType === 'smtp_imap' ? secret.smtp.host : null,
    smtpPort: secret?.authType === 'smtp_imap' ? secret.smtp.port : null,
    smtpSecure: secret?.authType === 'smtp_imap' ? secret.smtp.secure : null,
    smtpUsername: secret?.authType === 'smtp_imap' ? secret.smtp.username : null,
    imapHost: secret?.authType === 'smtp_imap' && secret.imap ? secret.imap.host : null,
    imapPort: secret?.authType === 'smtp_imap' && secret.imap ? secret.imap.port : null,
    imapSecure: secret?.authType === 'smtp_imap' && secret.imap ? secret.imap.secure : null,
    imapUsername: secret?.authType === 'smtp_imap' && secret.imap ? secret.imap.username : null,
    policy: parsePolicyJson(account.policyJson, { defaultAddresses: [account.emailAddress] }),
    createdAt: toIso(account.createdAt) || new Date(0).toISOString(),
    updatedAt: toIso(account.updatedAt) || new Date(0).toISOString(),
  };
}

export async function getActiveWorkspaceMailboxForEmailAccount(emailAccountId: string): Promise<StoredWorkspaceEmailMailbox | null> {
  return (await db.query.workspaceEmailMailboxes.findFirst({
    where: and(
      eq(workspaceEmailMailboxes.emailAccountId, emailAccountId),
      eq(workspaceEmailMailboxes.status, 'active'),
    ),
  })) || null;
}

/**
 * Automation-only guard. A mailbox is never inferred from a user's default
 * workspace; callers must provide the exact workspace of the automation job.
 */
export async function requireActiveWorkspaceMailboxForAutomation(input: {
  emailAccountId: string;
  workspaceId: string;
}): Promise<StoredWorkspaceEmailMailbox> {
  const mailbox = await getActiveWorkspaceMailboxForEmailAccount(input.emailAccountId);
  if (!mailbox || mailbox.workspaceId !== input.workspaceId) {
    throw new Error('Email account is not actively assigned to this automation workspace.');
  }
  const account = await db.query.emailAccounts.findFirst({
    where: and(eq(emailAccounts.id, input.emailAccountId), eq(emailAccounts.status, 'active')),
    columns: { id: true },
  });
  if (!account) throw new Error('Email account is not active for automation use.');
  return mailbox;
}

export async function listEmailAccountRecordsForUser(userId: string): Promise<StoredEmailAccount[]> {
  return db.query.emailAccounts.findMany({
    // The personal integrations UI must never expose a centrally configured
    // workspace mailbox merely because an administrator created its record.
    where: and(
      eq(emailAccounts.userId, userId),
      eq(emailAccounts.status, 'active'),
      eq(emailAccounts.accountScope, 'personal'),
    ),
    orderBy: (table, { desc }) => [desc(table.isPrimary), desc(table.updatedAt)],
  });
}

export async function listPublicEmailAccountsForUser(userId: string): Promise<PublicEmailAccount[]> {
  const accounts = await listEmailAccountRecordsForUser(userId);
  const publicAccounts: PublicEmailAccount[] = [];
  for (const account of accounts) {
    const [secret, mailbox] = await Promise.all([
      readEmailAccountSecret(account.secretRef).catch(() => null),
      getActiveWorkspaceMailboxForEmailAccount(account.id),
    ]);
    publicAccounts.push(publicStoredEmailAccount(account, secret, mailbox));
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
        orderBy: (table, { desc }) => [desc(table.isPrimary), desc(table.updatedAt)],
      });

  if (!account) throw new Error(accountId ? 'Email account not found.' : 'No active email account is connected.');
  return account;
}

async function hasActivePrimaryEmailAccount(userId: string): Promise<boolean> {
  const primaryAccount = await db.query.emailAccounts.findFirst({
    where: and(eq(emailAccounts.userId, userId), eq(emailAccounts.status, 'active'), eq(emailAccounts.isPrimary, true)),
    columns: { id: true },
  });
  return Boolean(primaryAccount);
}

async function shouldStoreAccountAsPrimary(userId: string, existing?: StoredEmailAccount | null): Promise<boolean> {
  if (existing?.isPrimary) return true;
  return !(await hasActivePrimaryEmailAccount(userId));
}

async function clearPrimaryEmailAccounts(userId: string): Promise<void> {
  await db.update(emailAccounts)
    .set({ isPrimary: false })
    .where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.isPrimary, true)));
}

async function ensurePrimaryEmailAccount(userId: string): Promise<void> {
  if (await hasActivePrimaryEmailAccount(userId)) return;
  const fallback = await db.query.emailAccounts.findFirst({
    where: and(eq(emailAccounts.userId, userId), eq(emailAccounts.status, 'active')),
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
  });
  if (!fallback) return;
  await db.update(emailAccounts)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.id, fallback.id)));
}

export async function setPrimaryStoredEmailAccount(userId: string, accountId: string): Promise<PublicEmailAccount> {
  await getEmailAccountForUser(userId, accountId);
  await clearPrimaryEmailAccounts(userId);
  await db.update(emailAccounts)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.id, accountId), eq(emailAccounts.status, 'active')));

  const updated = await getEmailAccountForUser(userId, accountId);
  const [secret, mailbox] = await Promise.all([
    readEmailAccountSecret(updated.secretRef).catch(() => null),
    getActiveWorkspaceMailboxForEmailAccount(updated.id),
  ]);
  return publicStoredEmailAccount(updated, secret, mailbox);
}

export async function assignStoredEmailAccountWorkspace(
  userId: string,
  accountId: string,
  workspaceId: string | null,
): Promise<PublicEmailAccount> {
  const account = await getEmailAccountForUser(userId, accountId);
  const normalizedWorkspaceId = workspaceId?.trim() || null;
  const activeMailbox = await getActiveWorkspaceMailboxForEmailAccount(account.id);
  const protectedWorkspaceIds = [activeMailbox?.workspaceId || null, normalizedWorkspaceId]
    .filter((value): value is string => Boolean(value));
  const authorizedWorkspaces = new Map<string, Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>>>();
  for (const protectedWorkspaceId of new Set(protectedWorkspaceIds)) {
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId,
      workspaceId: protectedWorkspaceId,
      permissions: ['canManageWorkspace'],
    });
    authorizedWorkspaces.set(protectedWorkspaceId, workspace);
  }

  if (normalizedWorkspaceId) {
    const workspace = authorizedWorkspaces.get(normalizedWorkspaceId);
    if (account.accountScope === 'organization' && account.organizationId && workspace?.organizationId !== account.organizationId) {
      throw new Error('Organization mailboxes can only be assigned to a workspace in the same organization.');
    }
  }

  const now = new Date();
  if (activeMailbox && activeMailbox.workspaceId !== normalizedWorkspaceId) {
    await db.update(workspaceEmailMailboxes)
      .set({ status: 'archived', pausedAt: now, lastEditedByUserId: userId, updatedAt: now })
      .where(eq(workspaceEmailMailboxes.id, activeMailbox.id));
  }

  let nextMailbox: StoredWorkspaceEmailMailbox | null = null;
  if (normalizedWorkspaceId) {
    if (activeMailbox?.workspaceId === normalizedWorkspaceId) {
      await db.update(workspaceEmailMailboxes)
        .set({ lastEditedByUserId: userId, updatedAt: now })
        .where(eq(workspaceEmailMailboxes.id, activeMailbox.id));
    } else {
      const archivedMailbox = await db.query.workspaceEmailMailboxes.findFirst({
        where: and(
          eq(workspaceEmailMailboxes.emailAccountId, account.id),
          eq(workspaceEmailMailboxes.workspaceId, normalizedWorkspaceId),
        ),
        orderBy: [desc(workspaceEmailMailboxes.updatedAt)],
      });
      if (archivedMailbox) {
        await db.update(workspaceEmailMailboxes)
          .set({ status: 'active', pausedAt: null, lastEditedByUserId: userId, updatedAt: now })
          .where(eq(workspaceEmailMailboxes.id, archivedMailbox.id));
      } else {
        await db.insert(workspaceEmailMailboxes).values({
          id: `mailbox-${crypto.randomUUID()}`,
          workspaceId: normalizedWorkspaceId,
          emailAccountId: account.id,
          status: 'active',
          role: 'inbound_outbound',
          createdByUserId: userId,
          lastEditedByUserId: userId,
          pausedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    nextMailbox = await getActiveWorkspaceMailboxForEmailAccount(account.id);
  }

  await db.update(emailAccounts)
    .set({
      workspaceId: null,
      automationEnabledAt: nextMailbox ? (account.automationEnabledAt || now) : null,
      connectedByUserId: account.connectedByUserId || userId,
      updatedAt: now,
    })
    .where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.id, account.id)));

  const updated = await getEmailAccountForUser(userId, account.id);
  const secret = await readEmailAccountSecret(updated.secretRef).catch(() => null);
  return publicStoredEmailAccount(updated, secret, nextMailbox);
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
  const currentPolicy = parsePolicyJson(account.policyJson, { defaultAddresses: [account.emailAddress] });
  const nextPolicy = normalizePolicy({
    readFrom: policy.readFrom === undefined ? currentPolicy.readFrom : policy.readFrom,
    sendTo: policy.sendTo === undefined ? currentPolicy.sendTo : policy.sendTo,
  }, { defaultAddresses: [account.emailAddress] });

  await db.update(emailAccounts)
    .set({ policyJson: JSON.stringify(nextPolicy), updatedAt: new Date() })
    .where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.id, accountId)));

  const updated = await getEmailAccountForUser(userId, accountId);
  const [secret, mailbox] = await Promise.all([
    readEmailAccountSecret(updated.secretRef).catch(() => null),
    getActiveWorkspaceMailboxForEmailAccount(updated.id),
  ]);
  return publicStoredEmailAccount(updated, secret, mailbox);
}

export async function disconnectStoredEmailAccount(userId: string, accountId: string): Promise<boolean> {
  const account = await getEmailAccountForUser(userId, accountId);
  await db.delete(emailAccounts).where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.id, accountId)));
  await deleteEmailAccountSecret(account.secretRef);
  if (account.isPrimary) await ensurePrimaryEmailAccount(userId);
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
  const policySource = params.policy === undefined && existing
    ? parsePolicyJson(existing.policyJson, { defaultAddresses: [emailAddress] })
    : params.policy ?? null;
  const policy = normalizePolicy(policySource, {
    defaultAddresses: [emailAddress],
    seedDefaultsWhenEmpty: !existing,
  });
  const isPrimary = await shouldStoreAccountAsPrimary(params.userId, existing);
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
  if (isPrimary) await clearPrimaryEmailAccounts(params.userId);

  if (existing) {
    await db.update(emailAccounts)
      .set({
        providerAccountId: params.providerAccountId || existing.providerAccountId,
        displayName: params.displayName ?? existing.displayName,
        authType: 'oauth',
        status: 'active',
        policyJson: JSON.stringify(policy),
        secretRef,
        isPrimary,
        accountScope: existing.accountScope || 'personal',
        connectedByUserId: existing.connectedByUserId || params.userId,
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
    isPrimary,
    accountScope: 'personal',
    organizationId: null,
    connectedByUserId: params.userId,
    automationEnabledAt: null,
    lastUsedAt: null,
    createdAt: params.createdAt || now,
    updatedAt: now,
  });

  return getEmailAccountForUser(params.userId, id);
}

export async function upsertSmtpEmailAccount(params: {
  userId: string;
  accountId?: string;
  emailAddress: string;
  displayName?: string | null;
  policy?: Partial<EmailPolicy> | null;
  secret: EmailAccountSmtpSecret;
  createdAt?: Date;
}): Promise<StoredEmailAccount> {
  const emailAddress = normalizeEmailAddress(params.emailAddress);
  const existingById = params.accountId
    ? await db.query.emailAccounts.findFirst({
        where: and(eq(emailAccounts.userId, params.userId), eq(emailAccounts.id, params.accountId), eq(emailAccounts.provider, 'smtp_imap')),
      })
    : null;
  const existing = existingById || await db.query.emailAccounts.findFirst({
    where: and(
      eq(emailAccounts.userId, params.userId),
      eq(emailAccounts.provider, 'smtp_imap'),
      eq(emailAccounts.emailAddress, emailAddress),
    ),
  });
  if (existingById && existingById.emailAddress !== emailAddress) {
    const emailCollision = await db.query.emailAccounts.findFirst({
      where: and(
        eq(emailAccounts.userId, params.userId),
        eq(emailAccounts.provider, 'smtp_imap'),
        eq(emailAccounts.emailAddress, emailAddress),
      ),
    });
    if (emailCollision && emailCollision.id !== existingById.id) {
      throw new Error('An SMTP/IMAP account with this email address already exists.');
    }
  }
  const now = new Date();
  const id = existing?.id || params.accountId || accountIdFor(params.userId, 'smtp_imap', emailAddress);
  const secretRef = existing?.secretRef || emailAccountSecretRef(params.userId, id);
  const policySource = params.policy === undefined && existing
    ? parsePolicyJson(existing.policyJson, { defaultAddresses: [emailAddress] })
    : params.policy ?? null;
  const policy = normalizePolicy(policySource, {
    defaultAddresses: [emailAddress],
    seedDefaultsWhenEmpty: !existing,
  });
  const isPrimary = await shouldStoreAccountAsPrimary(params.userId, existing);

  await writeEmailAccountSecret(secretRef, params.secret);
  if (isPrimary) await clearPrimaryEmailAccounts(params.userId);

  if (existing) {
    await db.update(emailAccounts)
      .set({
        emailAddress,
        providerAccountId: emailAddress,
        displayName: params.displayName === undefined ? existing.displayName : params.displayName,
        authType: 'smtp_imap',
        status: 'active',
        policyJson: JSON.stringify(policy),
        secretRef,
        isPrimary,
        accountScope: existing.accountScope || 'personal',
        connectedByUserId: existing.connectedByUserId || params.userId,
        updatedAt: now,
      })
      .where(and(eq(emailAccounts.userId, params.userId), eq(emailAccounts.id, existing.id)));
    return getEmailAccountForUser(params.userId, existing.id);
  }

  await db.insert(emailAccounts).values({
    id,
    userId: params.userId,
    provider: 'smtp_imap',
    authType: 'smtp_imap',
    emailAddress,
    displayName: params.displayName ?? null,
    providerAccountId: emailAddress,
    status: 'active',
    policyJson: JSON.stringify(policy),
    secretRef,
    isPrimary,
    accountScope: 'personal',
    organizationId: null,
    connectedByUserId: params.userId,
    automationEnabledAt: null,
    lastUsedAt: null,
    createdAt: params.createdAt || now,
    updatedAt: now,
  });

  return getEmailAccountForUser(params.userId, id);
}
