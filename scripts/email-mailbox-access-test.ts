import assert from 'node:assert/strict';
import Module from 'node:module';
import { and, eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
let workspaces: WorkspaceContext[] = [];
const missingSecrets = new Set<string>();
const smtpOnlySecrets = new Set<string>();
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') return database;
  if (request === '@/app/lib/workspaces/context') return { resolveWorkspaceActor: (actor: { id: string }) => ({ userId: actor.id }) };
  if (request === '@/app/lib/workspaces/listing-action') return { loadWorkspaceListingForActor: async () => ({ workspaces }) };
  if (request === '@/app/lib/organization/permissions') return { readOrganizationPermissionForUser: async () => ({ permission: { status: 'active', role: 'member' } }) };
  if (request === '@/app/lib/email/secret-store') return { readEmailAccountSecret: async (ref: string) => missingSecrets.has(ref) ? null : smtpOnlySecrets.has(ref) ? { authType: 'smtp_imap', smtp: { host: 'smtp.example.test', port: 465, username: 'fixture', password: 'fixture' } } : ({ authType: 'oauth', accessToken: 'private-fixture-token', refreshToken: 'private-refresh-token' }) };
  if (request === '@/app/lib/email/service') return {
    listEmailAccounts: async (userId: string) => {
      const { emailAccounts } = await import('../app/lib/db/schema');
      const { publicStoredEmailAccount } = await import('../app/lib/email/account-store');
      const accounts = await database.db.query.emailAccounts.findMany({ where: and(eq(emailAccounts.userId, userId), eq(emailAccounts.accountScope, 'personal'), eq(emailAccounts.status, 'active')) });
      return { accounts: accounts.map(account => publicStoredEmailAccount(account)), mode: 'local' };
    },
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  database = await createPiTestDatabase();
  const { user, emailAccounts, workspaceEmailMailboxes } = await import('../app/lib/db/schema');
  const { listEmailMailboxes, resolveEmailMailboxAccess, EmailMailboxAccessError } = await import('../app/lib/email/mailbox-access');
  const now = new Date();
  await database.db.insert(user).values(['owner', 'member'].map(id => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
  await database.db.insert(emailAccounts).values([
    { id: 'private', userId: 'owner', accountScope: 'personal', organizationId: null },
    { id: 'shared', userId: 'owner', accountScope: 'workspace', organizationId: 'org' },
    { id: 'wrong-org', userId: 'owner', accountScope: 'workspace', organizationId: 'different' },
  ].map(account => ({ ...account, provider: 'google', authType: 'oauth', emailAddress: `${account.id}@example.test`, secretRef: account.id, status: 'active', policyJson: '{}', createdAt: now, updatedAt: now })));
  await database.db.insert(workspaceEmailMailboxes).values(['shared', 'wrong-org'].map(id => ({ id: `mailbox-${id}`, workspaceId: 'work', emailAccountId: id, createdByUserId: 'owner', lastEditedByUserId: 'owner', createdAt: now, updatedAt: now })));
  const workspace: WorkspaceContext = { workspaceId: 'work', workspaceType: 'team', displayName: 'Work', rootPath: '/fixture', organizationId: 'org', status: 'active', legacy: false, permissions: { canRead: true, canWrite: false, canDelete: false, canManageWorkspace: false, canRunAgent: false, canCreatePublicLinks: false } };
  workspaces = [workspace];
  const request = { userId: 'member', accountId: 'shared', mailboxWorkspaceId: 'work', operation: 'read' as const };
  const denied = (operation: () => Promise<unknown>, status = 403) => assert.rejects(operation, error => error instanceof EmailMailboxAccessError && error.status === status);
  const catalog = await listEmailMailboxes('member');
  assert.deepEqual(catalog.accounts.map(account => account.id), ['shared'], 'A member with no personal account sees only authorized shared mailboxes');
  assert.equal(catalog.accounts[0].accountScope, 'workspace');
  assert.equal(catalog.accounts[0].workspaceId, 'work');
  assert.equal(catalog.accounts[0].workspaceName, 'Work');
  assert.equal(catalog.accounts[0].mailboxId, 'mailbox-shared');
  assert.equal(catalog.setup.canManageBusiness, false);
  assert.deepEqual(catalog.setup.manageableWorkspaces, []);
  const serialized = JSON.stringify(catalog);
  for (const sensitive of ['secretRef', 'accessToken', 'refreshToken', 'private-fixture-token', 'private-refresh-token', 'policyJson']) {
    assert.equal(serialized.includes(sensitive), false, `Catalogue must not disclose ${sensitive}`);
  }
  assert.equal(catalog.accounts[0].capabilities.canWrite, false);
  const access = await resolveEmailMailboxAccess(request);
  assert.equal(access.accountOwnerId, 'owner', 'Provider identity is the account owner');
  assert.equal(access.readOptions.enforceReadPolicy, true);
  assert.equal(access.readOptions.cacheMode, undefined, 'Shared reads cannot use personal SWR caches');
  await denied(() => resolveEmailMailboxAccess({ ...request, accountId: 'private', mailboxWorkspaceId: null }), 409);
  await denied(() => resolveEmailMailboxAccess({ ...request, accountId: 'private' }));
  await denied(() => resolveEmailMailboxAccess({ ...request, mailboxWorkspaceId: null }), 409);
  await denied(() => resolveEmailMailboxAccess({ ...request, accountId: 'wrong-org' }));
  await denied(() => resolveEmailMailboxAccess({ ...request, accountId: undefined }), 409);
  await denied(() => resolveEmailMailboxAccess({ ...request, mailboxWorkspaceId: {} }));
  await denied(() => resolveEmailMailboxAccess({ ...request, accountId: ['shared'] }));
  await denied(() => resolveEmailMailboxAccess({ ...request, operation: 'write' }));
  await denied(() => resolveEmailMailboxAccess({ ...request, operation: 'delete' }));
  workspace.permissions.canWrite = true;
  await denied(() => resolveEmailMailboxAccess({ ...request, operation: 'delete' }));
  await denied(() => resolveEmailMailboxAccess({ ...request, operation: 'ai' }));
  await resolveEmailMailboxAccess({ ...request, operation: 'write' });
  workspace.permissions.canDelete = true;
  workspace.permissions.canRunAgent = true;
  await resolveEmailMailboxAccess({ ...request, operation: 'delete' });
  await resolveEmailMailboxAccess({ ...request, operation: 'ai' });
  await database.db.update(emailAccounts).set({ status: 'revoked' }).where(eq(emailAccounts.id, 'shared'));
  await denied(() => resolveEmailMailboxAccess(request), 409);
  const disconnected = await listEmailMailboxes('member');
  assert.equal(disconnected.accounts[0].connectionState, 'reconnect_required');
  assert.equal(disconnected.accounts[0].capabilities.canRead, false, 'Reconnect-required accounts remain visible but cannot be read');
  await database.db.update(emailAccounts).set({ status: 'active' }).where(eq(emailAccounts.id, 'shared'));
  await database.db.update(workspaceEmailMailboxes).set({ status: 'paused' }).where(eq(workspaceEmailMailboxes.id, 'mailbox-shared'));
  await denied(() => resolveEmailMailboxAccess(request));
  assert.deepEqual((await listEmailMailboxes('member')).accounts, []);
  await database.db.update(workspaceEmailMailboxes).set({ status: 'active' }).where(eq(workspaceEmailMailboxes.id, 'mailbox-shared'));
  workspace.status = 'archived';
  await denied(() => resolveEmailMailboxAccess(request));
  assert.deepEqual((await listEmailMailboxes('member')).accounts, []);
  workspace.status = 'active';
  workspace.permissions.canRead = false;
  await denied(() => resolveEmailMailboxAccess(request));
  workspaces = [];
  await denied(() => resolveEmailMailboxAccess(request));
  assert.deepEqual((await listEmailMailboxes('member')).accounts, []);
  const ownerCatalog = await listEmailMailboxes('owner');
  assert.deepEqual(ownerCatalog.accounts.map(account => account.id), ['private'], 'Business ownership alone is not workspace membership');
  await denied(() => resolveEmailMailboxAccess({ ...request, userId: 'owner', mailboxWorkspaceId: null }), 409);
  const personal = await resolveEmailMailboxAccess({ userId: 'owner', accountId: 'private', operation: 'read' });
  assert.equal(personal.accountOwnerId, 'owner');
  assert.equal(personal.readOptions.enforceReadPolicy, false);
  assert.equal(personal.readOptions.cacheMode, 'swr');
  assert.equal(ownerCatalog.accounts[0].connectionState, 'ready');
  missingSecrets.add('private');
  const missing = (await listEmailMailboxes('owner')).accounts[0];
  assert.equal(missing.connectionState, 'reconnect_required'); assert.equal(missing.capabilities.canWrite, false);
  missingSecrets.delete('private');
  smtpOnlySecrets.add('private');
  await database.db.update(emailAccounts).set({ provider: 'smtp_imap', authType: 'smtp_imap' }).where(eq(emailAccounts.id, 'private'));
  const sendOnly = (await listEmailMailboxes('owner')).accounts[0];
  assert.equal(sendOnly.connectionState, 'send_only'); assert.equal(sendOnly.capabilities.canWrite, true); assert.equal(sendOnly.capabilities.canRead, false);
  await database.db.update(emailAccounts).set({ status: 'expired' }).where(eq(emailAccounts.id, 'private'));
  const expired = await listEmailMailboxes('owner');
  assert.equal(expired.accounts[0].status, 'expired');
  assert.deepEqual(expired.accounts[0].capabilities, { canRead: false, canWrite: false, canDelete: false, canRunAgent: false, canManage: true });
  await denied(() => resolveEmailMailboxAccess({ userId: 'owner', accountId: 'private', operation: 'read' }), 409);
  assert.deepEqual((await listEmailMailboxes('member')).accounts, [], 'Other users cannot see expired personal accounts');
  console.log('Email mailbox access passed: real isolated PostgreSQL joins, actor boundaries, revocation and capabilities; no provider calls.');
}
let failed = false;
main().catch(error => { console.error(error); failed = true; }).finally(async () => { internals._load = originalLoad; await database?.close(); if (failed) process.exitCode = 1; });
