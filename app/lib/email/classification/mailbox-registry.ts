import 'server-only';

import { inArray } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { emailAccounts, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { EmailMailboxAccessError, listEmailMailboxes, resolveEmailMailboxAccess } from '@/app/lib/email/mailbox-access';
import { isEmailAddressAllowed, normalizeEmailPolicyList } from '@/app/lib/email/policy';
import { emailClassificationFingerprint, emailClassificationMailboxRef } from './identity';
import type { AuthorizedEmailClassificationMailbox, EmailMailboxScope } from './mailbox-types';
import { matchesEmailMailboxScope } from './mailbox-types';

type MailboxCatalog = Awaited<ReturnType<typeof listEmailMailboxes>>;
type MailboxAccess = Awaited<ReturnType<typeof resolveEmailMailboxAccess>>;
type RegistryLocalAccount = Pick<typeof emailAccounts.$inferSelect, 'id' | 'userId' | 'provider' | 'authType' | 'providerAccountId' | 'emailAddress' | 'status' | 'accountScope' | 'policyJson' | 'createdAt' | 'updatedAt'>;
type RegistryBinding = Pick<typeof workspaceEmailMailboxes.$inferSelect, 'id' | 'emailAccountId' | 'workspaceId' | 'status' | 'updatedAt'>;

export interface EmailMailboxRegistryDependencies {
  catalog(userId: string): Promise<MailboxCatalog>;
  access(input: Parameters<typeof resolveEmailMailboxAccess>[0]): Promise<MailboxAccess>;
  localAccounts(accountIds: string[]): Promise<RegistryLocalAccount[]>;
  bindings(mailboxIds: string[]): Promise<RegistryBinding[]>;
}

const runtimeDependencies: EmailMailboxRegistryDependencies = {
  catalog: listEmailMailboxes,
  access: resolveEmailMailboxAccess,
  localAccounts: ids => ids.length ? db.select().from(emailAccounts).where(inArray(emailAccounts.id, ids)) : Promise.resolve([]),
  bindings: ids => ids.length ? db.select().from(workspaceEmailMailboxes).where(inArray(workspaceEmailMailboxes.id, ids)) : Promise.resolve([]),
};

/** Resolve all origins from current server authorization, never from a client owner/source hint. */
export async function resolveAuthorizedEmailClassificationMailboxes(userId: string, scope: EmailMailboxScope = { kind: 'all' }, dependencies: EmailMailboxRegistryDependencies = runtimeDependencies): Promise<AuthorizedEmailClassificationMailbox[]> {
  const catalog = await dependencies.catalog(userId);
  const readable = catalog.accounts.filter(account => account.capabilities.canRead && account.connectionState === 'ready');
  const [localAccounts, bindings] = await Promise.all([
    dependencies.localAccounts(readable.map(account => account.id)),
    dependencies.bindings(readable.flatMap(account => account.mailboxId ? [account.mailboxId] : [])),
  ]);
  const resolved = await Promise.all(readable.map(async account => {
    try {
      const access = await dependencies.access({ userId, accountId: account.id, mailboxWorkspaceId: account.workspaceId, operation: 'read' });
      const local = localAccounts.find(candidate => candidate.id === account.id && candidate.userId === access.accountOwnerId);
      const binding = account.mailboxId ? bindings.find(candidate => candidate.id === account.mailboxId && candidate.emailAccountId === account.id && candidate.workspaceId === access.workspaceId && candidate.status === 'active') : null;
      if (local && local.status !== 'active') return null;
      if (access.workspaceId && (!local || !binding || local.accountScope !== 'workspace')) return null;
      const readFrom = normalizeEmailPolicyList(local ? (JSON.parse(local.policyJson) as { readFrom?: unknown }).readFrom : account.policy.readFrom);
      const descriptor = {
        ownerUserId: access.accountOwnerId, accountSource: local ? 'local' as const : 'managed' as const,
        accountId: access.accountId, workspaceId: access.workspaceId, mailboxId: access.mailboxId,
        provider: local?.authType === 'smtp_imap' ? 'imap' : local?.provider ?? account.provider,
        bindingRevision: emailClassificationFingerprint([access.accountOwnerId, local ? 'local' : 'managed', access.accountId, access.workspaceId, access.mailboxId,
          local?.provider ?? account.provider, local?.authType ?? account.authType, local?.status ?? account.status,
          local?.createdAt?.getTime() ?? account.createdAt ?? null, local?.providerAccountId ?? null, local?.emailAddress ?? account.emailAddress,
          account.imapHost ?? null, account.imapPort ?? null, account.imapUsername ?? null, account.imapSecure ?? null,
          binding?.updatedAt?.getTime() ?? null]),
        policyRevision: emailClassificationFingerprint([Boolean(access.workspaceId), [...readFrom].sort()]),
        active: true, readFrom,
        emailAddress: local?.emailAddress ?? account.emailAddress, displayName: account.displayName, workspaceName: account.workspaceName,
        capabilities: { ...account.capabilities },
      };
      const mailbox: AuthorizedEmailClassificationMailbox = { ...descriptor, mailboxRef: emailClassificationMailboxRef(descriptor) };
      return matchesEmailMailboxScope(mailbox, scope) ? mailbox : null;
    } catch (error) {
      // Access can disappear between catalogue and origin resolution. Do not reuse stale entries.
      if (error instanceof EmailMailboxAccessError) return null;
      throw error;
    }
  }));
  return resolved.filter((mailbox): mailbox is AuthorizedEmailClassificationMailbox => mailbox !== null);
}

/** Shared sender policies apply before every index/cache row and count is exposed. */
export function canReadIndexedEmail(mailbox: Pick<AuthorizedEmailClassificationMailbox, 'workspaceId' | 'readFrom'>, sender: string): boolean {
  return !mailbox.workspaceId || isEmailAddressAllowed(sender, mailbox.readFrom);
}

/** Background AI respects sender restrictions even when a human can browse their personal mailbox. */
export function canClassifyIndexedEmail(mailbox: Pick<AuthorizedEmailClassificationMailbox, 'readFrom'>, sender: string): boolean {
  return isEmailAddressAllowed(sender, mailbox.readFrom);
}

/** Owned active users are discovered by the server; no browser heartbeat is required. */
export async function listEmailClassificationDiscoveryUserIds(): Promise<string[]> {
  const { user } = await import('@/app/lib/db/schema');
  const users = await db.select({ id: user.id, banned: user.banned, banExpires: user.banExpires }).from(user);
  return users.filter(actor => !actor.banned || actor.banExpires && actor.banExpires.getTime() <= Date.now()).map(actor => actor.id);
}
