import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { canvasWorkspaces, emailAccounts, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { verifyImapSecret } from '@/app/lib/email/imap-service';
import { withEmailPolicyDefaultAddresses, type EmailPolicy } from '@/app/lib/email/policy';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import {
  deleteEmailAccountSecret,
  readEmailAccountSecret,
  workspaceEmailAccountSecretRef,
  writeEmailAccountSecret,
  type EmailAccountSmtpSecret,
} from '@/app/lib/email/secret-store';
import {
  normalizeSmtpAccountInput,
  verifySmtpAccountSecret,
  type SmtpAccountInput,
} from '@/app/lib/email/smtp-service';

const WORKSPACE_ACCOUNT_SCOPE = 'workspace';

type WorkspaceMailboxRow = {
  id: string;
  mailboxId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  status: string | null;
  pausedAt: Date | null;
  accountId: string;
  emailAddress: string;
  displayName: string | null;
  provider: string;
  authType: string;
  accountStatus: string;
  secretRef: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  smtpUsername: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  imapUsername: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicAdminWorkspaceMailbox = {
  id: string;
  mailboxId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  status: string | null;
  pausedAt: string | null;
  accountId: string;
  emailAddress: string;
  displayName: string | null;
  provider: string;
  authType: string;
  accountStatus: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  smtpUsername: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  imapUsername: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceMailboxSmtpInput = Omit<SmtpAccountInput, 'accountId'> & {
  workspaceId?: unknown;
  accountId?: unknown;
  mailboxId?: unknown;
};

function publicMailbox(row: WorkspaceMailboxRow): PublicAdminWorkspaceMailbox {
  const { secretRef: _secretRef, ...mailbox } = row;
  return {
    ...mailbox,
    pausedAt: mailbox.pausedAt?.toISOString() || null,
    createdAt: mailbox.createdAt.toISOString(),
    updatedAt: mailbox.updatedAt.toISOString(),
  };
}

function optionalWorkspaceId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('workspaceId must be a string when provided.');
  return value.trim();
}

function policyJson(policy: Partial<EmailPolicy> | undefined, emailAddress: string): string {
  return JSON.stringify(withEmailPolicyDefaultAddresses(policy || {}, [emailAddress]));
}

async function requireWorkspace(workspaceId: string, organizationId?: string | null): Promise<void> {
  const workspace = await db.query.canvasWorkspaces.findFirst({
    where: and(
      eq(canvasWorkspaces.id, workspaceId),
      eq(canvasWorkspaces.status, 'active'),
      organizationId ? eq(canvasWorkspaces.organizationId, organizationId) : undefined,
    ),
    columns: { id: true },
  });
  if (!workspace) throw new Error('Workspace not found or inactive.');
}

async function listWorkspaceMailboxRows(organizationId?: string | null): Promise<WorkspaceMailboxRow[]> {
  const accounts = await db.select({
    id: emailAccounts.id,
    accountId: emailAccounts.id,
    emailAddress: emailAccounts.emailAddress,
    displayName: emailAccounts.displayName,
    provider: emailAccounts.provider,
    authType: emailAccounts.authType,
    accountStatus: emailAccounts.status,
    secretRef: emailAccounts.secretRef,
    createdAt: emailAccounts.createdAt,
    updatedAt: emailAccounts.updatedAt,
  }).from(emailAccounts)
    .where(and(
      eq(emailAccounts.accountScope, WORKSPACE_ACCOUNT_SCOPE),
      eq(emailAccounts.status, 'active'),
      organizationId === undefined
        ? undefined
        : organizationId
          ? eq(emailAccounts.organizationId, organizationId)
          : isNull(emailAccounts.organizationId),
    ))
    .orderBy(asc(emailAccounts.emailAddress), desc(emailAccounts.updatedAt));
  return Promise.all(accounts.map(async (account) => {
    const assignment = await db.select({
      id: workspaceEmailMailboxes.id,
      workspaceId: workspaceEmailMailboxes.workspaceId,
      workspaceName: canvasWorkspaces.displayName,
      status: workspaceEmailMailboxes.status,
      pausedAt: workspaceEmailMailboxes.pausedAt,
    }).from(workspaceEmailMailboxes)
      .innerJoin(canvasWorkspaces, eq(canvasWorkspaces.id, workspaceEmailMailboxes.workspaceId))
      .where(and(
        eq(workspaceEmailMailboxes.emailAccountId, account.id),
        eq(workspaceEmailMailboxes.status, 'active'),
      ))
      .limit(1)
      .then((rows) => rows[0] || null);
    const secret = await readEmailAccountSecret(account.secretRef).catch(() => null);
    const smtp = secret?.authType === 'smtp_imap' ? secret.smtp : null;
    const imap = secret?.authType === 'smtp_imap' ? secret.imap : null;
    return {
      ...account,
      mailboxId: assignment?.id || null,
      workspaceId: assignment?.workspaceId || null,
      workspaceName: assignment?.workspaceName || null,
      status: assignment?.status || null,
      pausedAt: assignment?.pausedAt || null,
      smtpHost: smtp?.host || null,
      smtpPort: smtp?.port || null,
      smtpSecure: smtp?.secure ?? null,
      smtpUsername: smtp?.username || null,
      imapHost: imap?.host || null,
      imapPort: imap?.port || null,
      imapSecure: imap?.secure ?? null,
      imapUsername: imap?.username || null,
    };
  }));
}

async function requireAdminMailbox(mailboxId: string, organizationId?: string | null) {
  const [mailbox] = await db.select({
    id: workspaceEmailMailboxes.id,
    workspaceId: workspaceEmailMailboxes.workspaceId,
    emailAccountId: workspaceEmailMailboxes.emailAccountId,
    status: workspaceEmailMailboxes.status,
  }).from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(
      eq(workspaceEmailMailboxes.id, mailboxId),
      eq(emailAccounts.accountScope, WORKSPACE_ACCOUNT_SCOPE),
      organizationId === undefined
        ? undefined
        : organizationId
          ? eq(emailAccounts.organizationId, organizationId)
          : isNull(emailAccounts.organizationId),
    ))
    .limit(1);
  if (!mailbox) throw new Error('Workspace mailbox not found.');
  return mailbox;
}

async function requireAdminWorkspaceAccount(identifier: string, organizationId?: string | null) {
  const byAccount = await db.query.emailAccounts.findFirst({
    where: and(
      eq(emailAccounts.id, identifier),
      eq(emailAccounts.accountScope, WORKSPACE_ACCOUNT_SCOPE),
      organizationId === undefined
        ? undefined
        : organizationId
          ? eq(emailAccounts.organizationId, organizationId)
          : isNull(emailAccounts.organizationId),
    ),
  });
  if (byAccount) return byAccount;
  const mailbox = await requireAdminMailbox(identifier, organizationId).catch(() => null);
  if (!mailbox) throw new Error('Workspace mailbox not found.');
  const account = await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, mailbox.emailAccountId) });
  if (!account) throw new Error('Workspace mailbox account not found.');
  return account;
}

async function resolvePublicMailbox(mailboxId: string, organizationId?: string | null): Promise<PublicAdminWorkspaceMailbox> {
  const rows = await listWorkspaceMailboxRows(organizationId);
  const row = rows.find((item) => item.id === mailboxId || item.mailboxId === mailboxId);
  if (!row) throw new Error('Workspace mailbox not found.');
  return publicMailbox(row);
}

async function activateMailboxForWorkspace(input: {
  accountId: string;
  workspaceId: string;
  actorUserId: string;
  currentMailboxId?: string;
}): Promise<string> {
  const now = new Date();
  if (input.currentMailboxId) {
    const current = await requireAdminMailbox(input.currentMailboxId);
    if (current.workspaceId === input.workspaceId && current.status === 'active') {
      await db.update(workspaceEmailMailboxes)
        .set({ lastEditedByUserId: input.actorUserId, updatedAt: now })
        .where(eq(workspaceEmailMailboxes.id, current.id));
      return current.id;
    }
    await db.update(workspaceEmailMailboxes)
      .set({ status: 'archived', pausedAt: now, lastEditedByUserId: input.actorUserId, updatedAt: now })
      .where(eq(workspaceEmailMailboxes.id, current.id));
  }

  const archived = await db.query.workspaceEmailMailboxes.findFirst({
    where: and(
      eq(workspaceEmailMailboxes.emailAccountId, input.accountId),
      eq(workspaceEmailMailboxes.workspaceId, input.workspaceId),
      eq(workspaceEmailMailboxes.status, 'archived'),
    ),
    orderBy: [desc(workspaceEmailMailboxes.updatedAt)],
  });
  if (archived) {
    await db.update(workspaceEmailMailboxes)
      .set({ status: 'active', pausedAt: null, lastEditedByUserId: input.actorUserId, updatedAt: now })
      .where(eq(workspaceEmailMailboxes.id, archived.id));
    return archived.id;
  }

  const id = `workspace-mailbox-${randomUUID()}`;
  await db.insert(workspaceEmailMailboxes).values({
    id,
    workspaceId: input.workspaceId,
    emailAccountId: input.accountId,
    status: 'active',
    role: 'inbound_outbound',
    createdByUserId: input.actorUserId,
    lastEditedByUserId: input.actorUserId,
    pausedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Organization-admin orchestration for shared SMTP/IMAP mailboxes. */
export async function saveAdminWorkspaceMailbox(
  actorUserId: string,
  input: WorkspaceMailboxSmtpInput,
  options: { verify?: boolean; organizationId?: string | null } = {},
) {
  const organizationId = options.organizationId === undefined
    ? (await readOrganizationPermissionForUser(actorUserId)).organizationId
    : options.organizationId;
  const workspaceId = optionalWorkspaceId(input.workspaceId);
  if (workspaceId) await requireWorkspace(workspaceId, organizationId);
  const accountIdentifier = typeof input.accountId === 'string' && input.accountId.trim()
    ? input.accountId.trim()
    : typeof input.mailboxId === 'string' && input.mailboxId.trim()
      ? input.mailboxId.trim()
      : undefined;
  const existingAccount = accountIdentifier
    ? await requireAdminWorkspaceAccount(accountIdentifier, organizationId)
    : undefined;

  const existingSecret = existingAccount
    ? await readEmailAccountSecret(existingAccount.secretRef)
    : null;
  if (existingSecret && existingSecret.authType !== 'smtp_imap') {
    throw new Error('This workspace mailbox is not an SMTP/IMAP mailbox.');
  }
  const { accountId: _accountId, mailboxId: _mailboxId, workspaceId: _workspaceId, ...smtpInput } = input;
  const normalized = normalizeSmtpAccountInput(smtpInput, existingSecret as EmailAccountSmtpSecret | null);
  const sameUserAccountForAddress = await db.query.emailAccounts.findFirst({
    where: and(
      eq(emailAccounts.userId, actorUserId),
      eq(emailAccounts.provider, 'smtp_imap'),
      eq(emailAccounts.emailAddress, normalized.emailAddress),
    ),
  });
  const existingWorkspaceAccountForAddress = await db.query.emailAccounts.findFirst({
    where: and(
      eq(emailAccounts.provider, 'smtp_imap'),
      eq(emailAccounts.emailAddress, normalized.emailAddress),
      eq(emailAccounts.accountScope, WORKSPACE_ACCOUNT_SCOPE),
      organizationId ? eq(emailAccounts.organizationId, organizationId) : isNull(emailAccounts.organizationId),
    ),
  });
  if (existingAccount && existingWorkspaceAccountForAddress && existingWorkspaceAccountForAddress.id !== existingAccount.id) {
    throw new Error('A different System Email mailbox already uses this email address.');
  }
  const accountToSave = existingAccount || existingWorkspaceAccountForAddress;
  if (sameUserAccountForAddress && sameUserAccountForAddress.id !== accountToSave?.id && sameUserAccountForAddress.accountScope !== WORKSPACE_ACCOUNT_SCOPE) {
    throw new Error('An SMTP/IMAP account with this email address already exists as a personal account. Remove it from Email Accounts before connecting it as a System Email mailbox.');
  }
  if (accountToSave && accountToSave.organizationId !== organizationId) {
    throw new Error('This System Email mailbox belongs to a different organization.');
  }
  if (options.verify) {
    await verifySmtpAccountSecret(normalized.secret);
    await verifyImapSecret(normalized.secret);
  }

  const now = new Date();
  const accountId = accountToSave?.id || `workspace-smtp-${randomUUID()}`;
  const previousSecretRef = accountToSave?.secretRef || null;
  const secretRef = workspaceEmailAccountSecretRef(accountId);
  if (accountToSave) {
    await db.update(emailAccounts).set({
      provider: 'smtp_imap', authType: 'smtp_imap', emailAddress: normalized.emailAddress,
      displayName: normalized.displayName, providerAccountId: normalized.emailAddress,
      status: 'active', policyJson: policyJson(normalized.policy, normalized.emailAddress),
      secretRef, isPrimary: false, accountScope: WORKSPACE_ACCOUNT_SCOPE,
      organizationId, connectedByUserId: actorUserId, automationEnabledAt: workspaceId ? now : null,
      workspaceId: null, updatedAt: now,
    }).where(eq(emailAccounts.id, accountId));
  } else {
    await db.insert(emailAccounts).values({
      id: accountId, userId: actorUserId, provider: 'smtp_imap', authType: 'smtp_imap',
      emailAddress: normalized.emailAddress, displayName: normalized.displayName,
      providerAccountId: normalized.emailAddress, status: 'active',
      policyJson: policyJson(normalized.policy, normalized.emailAddress), secretRef,
      isPrimary: false, accountScope: WORKSPACE_ACCOUNT_SCOPE, organizationId,
      connectedByUserId: actorUserId, automationEnabledAt: workspaceId ? now : null, workspaceId: null,
      lastUsedAt: null, createdAt: now, updatedAt: now,
    });
  }
  await writeEmailAccountSecret(secretRef, normalized.secret);
  if (previousSecretRef && previousSecretRef !== secretRef) {
    await deleteEmailAccountSecret(previousSecretRef);
  }
  if (workspaceId) {
    const activeMailboxId = await activateMailboxForWorkspace({
      accountId,
      workspaceId,
      actorUserId,
    });
    return resolvePublicMailbox(activeMailboxId, organizationId);
  }
  return resolvePublicMailbox(accountId, organizationId);
}

/**
 * Workspace-admin operation: bind one centrally connected business mailbox to
 * one workspace. The connection itself remains owned by System Email.
 */
export async function assignAdminWorkspaceMailbox(input: {
  actorUserId: string;
  accountId: string;
  workspaceId: string | null;
}) {
  const account = await requireAdminWorkspaceAccount(input.accountId);
  if (account.status !== 'active') throw new Error('This business mailbox is disconnected.');
  const activeMailbox = await getActiveMailboxForAccount(account.id);
  const protectedWorkspaceIds = [activeMailbox?.workspaceId || null, input.workspaceId]
    .filter((value): value is string => Boolean(value));
  for (const workspaceId of new Set(protectedWorkspaceIds)) {
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: input.actorUserId,
      workspaceId,
      permissions: ['canManageWorkspace'],
    });
    if (account.organizationId && workspace.organizationId !== account.organizationId) {
      throw new Error('This business mailbox can only be assigned within its organization.');
    }
  }

  const now = new Date();
  if (activeMailbox && activeMailbox.workspaceId !== input.workspaceId) {
    await db.update(workspaceEmailMailboxes)
      .set({ status: 'archived', pausedAt: now, lastEditedByUserId: input.actorUserId, updatedAt: now })
      .where(eq(workspaceEmailMailboxes.id, activeMailbox.id));
  }
  if (input.workspaceId) {
    await activateMailboxForWorkspace({
      accountId: account.id,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      currentMailboxId: activeMailbox?.workspaceId === input.workspaceId ? activeMailbox.id : undefined,
    });
  }
  await db.update(emailAccounts)
    .set({ automationEnabledAt: input.workspaceId ? (account.automationEnabledAt || now) : null, updatedAt: now })
    .where(eq(emailAccounts.id, account.id));
  return resolvePublicMailbox(account.id);
}

export async function listAssignableBusinessMailboxes(input: { workspaceId: string; organizationId: string | null }) {
  const accounts = await db.query.emailAccounts.findMany({
    where: and(
      eq(emailAccounts.accountScope, WORKSPACE_ACCOUNT_SCOPE),
      eq(emailAccounts.status, 'active'),
      input.organizationId
        ? or(isNull(emailAccounts.organizationId), eq(emailAccounts.organizationId, input.organizationId))
        : isNull(emailAccounts.organizationId),
    ),
    columns: { id: true, emailAddress: true, displayName: true, provider: true },
    orderBy: [asc(emailAccounts.emailAddress)],
  });
  const visibleAccounts = new Set(accounts.map((account) => account.id));
  const mailboxRows = await listWorkspaceMailboxRows();
  return mailboxRows
    .filter((mailbox) => visibleAccounts.has(mailbox.id))
    .filter((mailbox) => !mailbox.workspaceId || mailbox.workspaceId === input.workspaceId)
    .map((mailbox) => ({
      id: mailbox.id,
      mailboxId: mailbox.mailboxId,
      emailAddress: mailbox.emailAddress,
      displayName: mailbox.displayName,
      provider: mailbox.provider,
      imapHost: mailbox.imapHost,
      assignedWorkspaceId: mailbox.workspaceId,
    }));
}

async function getActiveMailboxForAccount(accountId: string) {
  return db.query.workspaceEmailMailboxes.findFirst({
    where: and(eq(workspaceEmailMailboxes.emailAccountId, accountId), eq(workspaceEmailMailboxes.status, 'active')),
  });
}

export async function listAdminWorkspaceMailboxes(organizationId?: string | null) {
  return (await listWorkspaceMailboxRows(organizationId)).map(publicMailbox);
}

export async function listWorkspaceMailboxWorkspaceChoices(organizationId?: string | null) {
  const workspaces = await db.query.canvasWorkspaces.findMany({
    where: and(
      eq(canvasWorkspaces.status, 'active'),
      organizationId === undefined
        ? undefined
        : organizationId
          ? eq(canvasWorkspaces.organizationId, organizationId)
          : undefined,
    ),
    columns: { id: true, displayName: true, type: true },
    orderBy: [asc(canvasWorkspaces.displayName)],
  });
  return workspaces.map((workspace) => ({ id: workspace.id, name: workspace.displayName, type: workspace.type }));
}

export async function testAdminWorkspaceMailbox(mailboxId: string, organizationId?: string | null) {
  const account = await requireAdminWorkspaceAccount(mailboxId, organizationId);
  const secret = await readEmailAccountSecret(account.secretRef);
  if (secret.authType !== 'smtp_imap') throw new Error('Workspace mailbox is not an SMTP/IMAP mailbox.');

  await verifySmtpAccountSecret(secret);
  await verifyImapSecret(secret);
  return {
    ok: true,
    smtpHost: secret.smtp.host,
    smtpPort: secret.smtp.port,
    smtpSecure: secret.smtp.secure,
    imapHost: secret.imap?.host || null,
    imapPort: secret.imap?.port || null,
    imapSecure: secret.imap?.secure ?? null,
  };
}

/** Verifies a business-mailbox draft without persisting its credentials. */
export async function testAdminWorkspaceMailboxConnection(actorUserId: string, input: WorkspaceMailboxSmtpInput, options: { organizationId?: string | null } = {}) {
  const organizationId = options.organizationId === undefined ? (await readOrganizationPermissionForUser(actorUserId)).organizationId : options.organizationId;
  const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? input.accountId.trim() : undefined;
  const existingAccount = accountId ? await requireAdminWorkspaceAccount(accountId, organizationId) : undefined;
  const existingSecret = existingAccount ? await readEmailAccountSecret(existingAccount.secretRef) : null;
  if (existingSecret && existingSecret.authType !== 'smtp_imap') throw new Error('This workspace mailbox is not an SMTP/IMAP mailbox.');
  const { accountId: _accountId, mailboxId: _mailboxId, workspaceId: _workspaceId, ...smtpInput } = input;
  const normalized = normalizeSmtpAccountInput(smtpInput, existingSecret as EmailAccountSmtpSecret | null);
  await verifySmtpAccountSecret(normalized.secret);
  await verifyImapSecret(normalized.secret);
  return { ok: true, smtp: { ok: true, host: normalized.secret.smtp.host, port: normalized.secret.smtp.port, secure: normalized.secret.smtp.secure }, imap: { configured: Boolean(normalized.secret.imap), ok: true, host: normalized.secret.imap?.host || null, port: normalized.secret.imap?.port || null, secure: normalized.secret.imap?.secure ?? null } };
}

export async function removeAdminWorkspaceMailbox(actorUserId: string, mailboxId: string, organizationId?: string | null) {
  const account = await requireAdminWorkspaceAccount(mailboxId, organizationId);
  const now = new Date();
  await db.update(workspaceEmailMailboxes)
    .set({ status: 'archived', pausedAt: now, lastEditedByUserId: actorUserId, updatedAt: now })
    .where(and(eq(workspaceEmailMailboxes.emailAccountId, account.id), eq(workspaceEmailMailboxes.status, 'active')));
  const centrallyStored = account.secretRef.startsWith('workspace/');
  if (centrallyStored) {
    await db.update(emailAccounts)
      .set({ status: 'disconnected', automationEnabledAt: null, updatedAt: now })
      .where(eq(emailAccounts.id, account.id));
    await deleteEmailAccountSecret(account.secretRef);
  } else {
    // A legacy mailbox may still use the old user's credential location.
    // Removing its workspace binding must return that account to its owner,
    // rather than deleting a personal connection as a side effect.
    await db.update(emailAccounts)
      .set({ accountScope: 'personal', automationEnabledAt: null, updatedAt: now })
      .where(eq(emailAccounts.id, account.id));
  }
}
