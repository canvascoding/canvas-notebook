import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { emailAccounts, user, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { publicStoredEmailAccount, readStoredEmailAccountSecret, type PublicEmailAccount } from '@/app/lib/email/account-store';
import { listEmailAccounts } from '@/app/lib/email/service';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { loadWorkspaceListingForActor } from '@/app/lib/workspaces/listing-action';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export class EmailMailboxAccessError extends Error {
  constructor(message: string, public readonly status: 403 | 409 = 403) { super(message); this.name = 'EmailMailboxAccessError'; }
}

function contextId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new EmailMailboxAccessError('Invalid mailbox context.');
  return value.trim();
}

async function workspaceListing(userId: string) {
  const actor = await db.query.user.findFirst({ where: eq(user.id, userId) });
  if (!actor) throw new EmailMailboxAccessError('Email user not found.');
  return loadWorkspaceListingForActor(resolveWorkspaceActor(actor));
}

function usableWorkspace(workspace: WorkspaceContext) {
  return (!workspace.status || workspace.status === 'active') && workspace.permissions.canRead;
}

function sameOrganization(account: typeof emailAccounts.$inferSelect, workspace: WorkspaceContext) {
  return account.accountScope === 'personal' || Boolean(account.organizationId && account.organizationId === workspace.organizationId);
}

export async function listEmailMailboxes(userId: string) {
  const [personal, listing, permission] = await Promise.all([
    listEmailAccounts(userId), workspaceListing(userId), readOrganizationPermissionForUser(userId),
  ]);
  const workspaces = listing.workspaces.filter(usableWorkspace);
  const workspaceIds = workspaces.map(workspace => workspace.workspaceId);
  const shared = workspaceIds.length ? await db.select({ account: emailAccounts, mailbox: workspaceEmailMailboxes })
    .from(workspaceEmailMailboxes).innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(inArray(workspaceEmailMailboxes.workspaceId, workspaceIds), eq(workspaceEmailMailboxes.status, 'active'))) : [];
  const sharedAccounts = [];
  for (const { account, mailbox } of shared) {
    const workspace = workspaces.find(item => item.workspaceId === mailbox.workspaceId)!;
    if (!sameOrganization(account, workspace)) continue;
    const secret = await readStoredEmailAccountSecret(account).catch(() => null);
    const base = publicStoredEmailAccount(account, secret, mailbox);
    const active = account.status === 'active' && Boolean(secret);
    const connectionState = !active ? 'reconnect_required' as const : account.authType === 'smtp_imap' && !(secret?.authType === 'smtp_imap' && secret.imap) ? 'send_only' as const : 'ready' as const;
    sharedAccounts.push({ ...base, connectionState, accountScope: 'workspace' as const, mailboxId: mailbox.id, workspaceId: workspace.workspaceId,
      workspaceName: workspace.displayName || workspace.workspaceId,
      capabilities: { canRead: active && (account.authType !== 'smtp_imap' || Boolean(secret?.authType === 'smtp_imap' && secret.imap)), canWrite: active && workspace.permissions.canWrite, canManage: workspace.permissions.canManageWorkspace, canDelete: active && workspace.permissions.canDelete, canRunAgent: active && workspace.permissions.canRunAgent },
    });
  }
  const represented = new Set(sharedAccounts.map(account => account.id));
  const localPersonal = await db.query.emailAccounts.findMany({ where: and(eq(emailAccounts.userId, userId), eq(emailAccounts.accountScope, 'personal')) });
  const localSecrets = new Map(await Promise.all(localPersonal.map(async account => [account.id, await readStoredEmailAccountSecret(account).catch(() => null)] as const)));
  const inactive = localPersonal.filter(account => ['expired', 'revoked', 'disconnected'].includes(account.status));
  const personalAccounts = [...personal.accounts as PublicEmailAccount[], ...await Promise.all(inactive.map(async account => publicStoredEmailAccount(account, await readStoredEmailAccountSecret(account).catch(() => null))))]
    .filter(account => !represented.has(account.id))
    .map(account => {
      const local = localSecrets.has(account.id);
      const secret = localSecrets.get(account.id);
      const active = account.status === 'active' && (!local || Boolean(secret));
      const hasInbox = account.authType !== 'smtp_imap' || (local ? Boolean(secret?.authType === 'smtp_imap' && secret.imap) : Boolean(account.imapHost));
      const connectionState = !active ? 'reconnect_required' as const : hasInbox ? 'ready' as const : 'send_only' as const;
      return { ...account, connectionState, accountScope: 'personal' as const, mailboxId: null, workspaceId: null, workspaceName: null,
        capabilities: { canRead: active && hasInbox, canWrite: active, canManage: true, canDelete: active && hasInbox, canRunAgent: active },
      };
    });
  return { accounts: [...personalAccounts, ...sharedAccounts], setup: {
    canManageBusiness: Boolean(permission.permission?.status === 'active' && ['owner', 'admin'].includes(permission.permission.role)),
    manageableWorkspaces: workspaces.filter(workspace => workspace.permissions.canManageWorkspace).map(workspace => ({ id: workspace.workspaceId, name: workspace.displayName || workspace.workspaceId })),
  } };
}

export async function resolveEmailMailboxAccess(input: {
  userId: string; accountId?: unknown; mailboxWorkspaceId?: unknown; operation: 'read' | 'write' | 'delete' | 'ai';
}) {
  const accountId = contextId(input.accountId);
  const workspaceId = contextId(input.mailboxWorkspaceId);
  if (!workspaceId) {
    // Personal list is owner-scoped and deliberately excludes Business accounts.
    const accounts = (await listEmailAccounts(input.userId)).accounts as PublicEmailAccount[];
    const account = accountId ? accounts.find(item => item.id === accountId) : accounts.find(item => item.isPrimary) || accounts[0];
    if (!account) throw new EmailMailboxAccessError('Personal mailbox is unavailable. Select its current workspace or reconnect it.', 409);
    if (account.status !== 'active') throw new EmailMailboxAccessError('Reconnect this mailbox before using it.', 409);
    const readOptions = { enforceReadPolicy: false, cacheMode: 'swr' as const };
    return { accountId: account.id, accountOwnerId: input.userId, workspaceId: null, mailboxId: null, readOptions, readPolicy: readOptions };
  }
  if (!accountId) throw new EmailMailboxAccessError('Select a mailbox for this workspace.', 409);
  const listing = await workspaceListing(input.userId);
  const workspace = listing.workspaces.find(item => item.workspaceId === workspaceId && usableWorkspace(item));
  if (!workspace) throw new EmailMailboxAccessError('Workspace mailbox access was removed.');
  if (input.operation !== 'read' && !workspace.permissions.canWrite) throw new EmailMailboxAccessError('This workspace mailbox is read-only.');
  if (input.operation === 'delete' && !workspace.permissions.canDelete) throw new EmailMailboxAccessError('Deleting workspace messages is not permitted.');
  if (input.operation === 'ai' && !workspace.permissions.canRunAgent) throw new EmailMailboxAccessError('Email agents are not permitted in this workspace.');
  const [match] = await db.select({ account: emailAccounts, mailbox: workspaceEmailMailboxes })
    .from(workspaceEmailMailboxes).innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(eq(workspaceEmailMailboxes.workspaceId, workspaceId), eq(workspaceEmailMailboxes.emailAccountId, accountId), eq(workspaceEmailMailboxes.status, 'active'))).limit(1);
  if (!match || !sameOrganization(match.account, workspace)) throw new EmailMailboxAccessError('This mailbox is no longer assigned to this workspace.');
  if (match.account.status !== 'active') throw new EmailMailboxAccessError('This shared mailbox needs to be reconnected by its administrator.', 409);
  const readOptions = { enforceReadPolicy: true, cacheMode: undefined };
  return { accountId, accountOwnerId: match.account.userId, workspaceId, mailboxId: match.mailbox.id, readOptions, readPolicy: readOptions };
}
