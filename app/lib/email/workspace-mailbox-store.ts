import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { canvasWorkspaces, emailAccounts, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { verifyImapSecret } from '@/app/lib/email/imap-service';
import { withEmailPolicyDefaultAddresses, type EmailPolicy } from '@/app/lib/email/policy';
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
  workspaceId: string;
  workspaceName: string;
  status: string;
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
  workspaceId: string;
  workspaceName: string;
  status: string;
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

function requiredWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A workspace is required.');
  return value.trim();
}

function policyJson(policy: Partial<EmailPolicy> | undefined, emailAddress: string): string {
  return JSON.stringify(withEmailPolicyDefaultAddresses(policy || {}, [emailAddress]));
}

async function requireWorkspace(workspaceId: string): Promise<void> {
  const workspace = await db.query.canvasWorkspaces.findFirst({
    where: and(eq(canvasWorkspaces.id, workspaceId), eq(canvasWorkspaces.status, 'active')),
    columns: { id: true },
  });
  if (!workspace) throw new Error('Workspace not found or inactive.');
}

async function listWorkspaceMailboxRows(): Promise<WorkspaceMailboxRow[]> {
  const rows = await db.select({
    id: workspaceEmailMailboxes.id,
    workspaceId: workspaceEmailMailboxes.workspaceId,
    workspaceName: canvasWorkspaces.displayName,
    status: workspaceEmailMailboxes.status,
    pausedAt: workspaceEmailMailboxes.pausedAt,
    accountId: emailAccounts.id,
    emailAddress: emailAccounts.emailAddress,
    displayName: emailAccounts.displayName,
    provider: emailAccounts.provider,
    authType: emailAccounts.authType,
    accountStatus: emailAccounts.status,
    secretRef: emailAccounts.secretRef,
    createdAt: workspaceEmailMailboxes.createdAt,
    updatedAt: workspaceEmailMailboxes.updatedAt,
  }).from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .innerJoin(canvasWorkspaces, eq(canvasWorkspaces.id, workspaceEmailMailboxes.workspaceId))
    .where(and(
      eq(emailAccounts.accountScope, WORKSPACE_ACCOUNT_SCOPE),
      eq(workspaceEmailMailboxes.status, 'active'),
    ))
    .orderBy(asc(canvasWorkspaces.displayName), desc(workspaceEmailMailboxes.updatedAt));
  return Promise.all(rows.map(async (row) => {
    const secret = await readEmailAccountSecret(row.secretRef).catch(() => null);
    const smtp = secret?.authType === 'smtp_imap' ? secret.smtp : null;
    const imap = secret?.authType === 'smtp_imap' ? secret.imap : null;
    return {
      ...row,
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

async function requireAdminMailbox(mailboxId: string) {
  const [mailbox] = await db.select({
    id: workspaceEmailMailboxes.id,
    workspaceId: workspaceEmailMailboxes.workspaceId,
    emailAccountId: workspaceEmailMailboxes.emailAccountId,
    status: workspaceEmailMailboxes.status,
  }).from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(eq(workspaceEmailMailboxes.id, mailboxId), eq(emailAccounts.accountScope, WORKSPACE_ACCOUNT_SCOPE)))
    .limit(1);
  if (!mailbox) throw new Error('Workspace mailbox not found.');
  return mailbox;
}

async function resolvePublicMailbox(mailboxId: string): Promise<PublicAdminWorkspaceMailbox> {
  const rows = await listWorkspaceMailboxRows();
  const row = rows.find((item) => item.id === mailboxId);
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

/** Instance-admin orchestration for shared SMTP/IMAP mailboxes. */
export async function saveAdminWorkspaceMailbox(actorUserId: string, input: WorkspaceMailboxSmtpInput, options: { verify?: boolean } = {}) {
  const workspaceId = requiredWorkspaceId(input.workspaceId);
  await requireWorkspace(workspaceId);

  const mailboxId = typeof input.mailboxId === 'string' && input.mailboxId.startsWith('workspace-mailbox-')
    ? input.mailboxId
    : undefined;
  const existingMailbox = mailboxId ? await requireAdminMailbox(mailboxId) : null;
  const existingAccount = existingMailbox
    ? await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, existingMailbox.emailAccountId) })
    : null;
  if (existingMailbox && !existingAccount) throw new Error('Workspace mailbox account not found.');

  const existingSecret = existingAccount
    ? await readEmailAccountSecret(existingAccount.secretRef)
    : null;
  if (existingSecret && existingSecret.authType !== 'smtp_imap') {
    throw new Error('This workspace mailbox is not an SMTP/IMAP mailbox.');
  }
  const normalized = normalizeSmtpAccountInput(input, existingSecret as EmailAccountSmtpSecret | null);
  if (options.verify) {
    await verifySmtpAccountSecret(normalized.secret);
    await verifyImapSecret(normalized.secret);
  }

  const now = new Date();
  const accountId = existingAccount?.id || `workspace-smtp-${randomUUID()}`;
  const previousSecretRef = existingAccount?.secretRef || null;
  const secretRef = workspaceEmailAccountSecretRef(accountId);
  if (existingAccount) {
    await db.update(emailAccounts).set({
      provider: 'smtp_imap', authType: 'smtp_imap', emailAddress: normalized.emailAddress,
      displayName: normalized.displayName, providerAccountId: normalized.emailAddress,
      status: 'active', policyJson: policyJson(normalized.policy, normalized.emailAddress),
      secretRef, isPrimary: false, accountScope: WORKSPACE_ACCOUNT_SCOPE,
      organizationId: null, connectedByUserId: actorUserId, automationEnabledAt: now,
      workspaceId: null, updatedAt: now,
    }).where(eq(emailAccounts.id, accountId));
  } else {
    await db.insert(emailAccounts).values({
      id: accountId, userId: actorUserId, provider: 'smtp_imap', authType: 'smtp_imap',
      emailAddress: normalized.emailAddress, displayName: normalized.displayName,
      providerAccountId: normalized.emailAddress, status: 'active',
      policyJson: policyJson(normalized.policy, normalized.emailAddress), secretRef,
      isPrimary: false, accountScope: WORKSPACE_ACCOUNT_SCOPE, organizationId: null,
      connectedByUserId: actorUserId, automationEnabledAt: now, workspaceId: null,
      lastUsedAt: null, createdAt: now, updatedAt: now,
    });
  }
  await writeEmailAccountSecret(secretRef, normalized.secret);
  if (previousSecretRef && previousSecretRef !== secretRef) {
    await deleteEmailAccountSecret(previousSecretRef);
  }
  const activeMailboxId = await activateMailboxForWorkspace({
    accountId,
    workspaceId,
    actorUserId,
    currentMailboxId: existingMailbox?.id,
  });
  return resolvePublicMailbox(activeMailboxId);
}

export async function listAdminWorkspaceMailboxes() {
  return (await listWorkspaceMailboxRows()).map(publicMailbox);
}

export async function listWorkspaceMailboxWorkspaceChoices() {
  const workspaces = await db.query.canvasWorkspaces.findMany({
    where: eq(canvasWorkspaces.status, 'active'),
    columns: { id: true, displayName: true, type: true },
    orderBy: [asc(canvasWorkspaces.displayName)],
  });
  return workspaces.map((workspace) => ({ id: workspace.id, name: workspace.displayName, type: workspace.type }));
}

export async function testAdminWorkspaceMailbox(mailboxId: string) {
  const mailbox = await requireAdminMailbox(mailboxId);
  const account = await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, mailbox.emailAccountId) });
  if (!account) throw new Error('Workspace mailbox account not found.');
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

export async function removeAdminWorkspaceMailbox(actorUserId: string, mailboxId: string) {
  const mailbox = await requireAdminMailbox(mailboxId);
  const now = new Date();
  await db.update(workspaceEmailMailboxes)
    .set({ status: 'archived', pausedAt: now, lastEditedByUserId: actorUserId, updatedAt: now })
    .where(eq(workspaceEmailMailboxes.id, mailbox.id));
  const account = await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, mailbox.emailAccountId) });
  if (account) {
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
}
