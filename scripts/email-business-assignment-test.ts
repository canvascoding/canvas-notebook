import assert from 'node:assert/strict';
import Module from 'node:module';
import { and, eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
let writes = 0;
const allowed = new Set(['one', 'two']);
const checked: string[] = [];
const secrets = new Map<string, unknown>();
const secret = { authType: 'smtp_imap', smtp: { host: 'smtp.example.test', port: 587, secure: false, username: 'mail', password: 'fixture' } };
const internal = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const original = internal._load;
internal._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') return database;
  if (request === '@/app/lib/organization/permissions') return { readOrganizationPermissionForUser: async () => ({ organizationId: 'org' }) };
  if (request === '@/app/lib/pi/session-workspace-context') return { resolveAgentSessionWorkspaceForUser: async (input: { userId: string; workspaceId: string; permissions: string[] }) => {
    assert.equal(input.userId, 'admin'); assert.deepEqual(input.permissions, ['canManageWorkspace']); checked.push(input.workspaceId);
    if (!allowed.has(input.workspaceId)) throw new Error('Workspace management denied');
    return { workspaceId: input.workspaceId, organizationId: 'org' };
  } };
  if (request === '@/app/lib/email/secret-store') return {
    workspaceEmailAccountSecretRef: (id: string) => `secret-${id}`,
    readEmailAccountSecret: async (ref: string) => secrets.get(ref),
    writeEmailAccountSecret: async (ref: string, value: unknown) => { writes++; secrets.set(ref, value); },
    deleteEmailAccountSecret: async (ref: string) => { secrets.delete(ref); },
  };
  if (request === '@/app/lib/email/smtp-service') return {
    normalizeSmtpAccountInput: (input: { emailAddress: string }) => ({ emailAddress: input.emailAddress, displayName: null, secret }),
    verifySmtpAccountSecret: async () => {},
  };
  if (request === '@/app/lib/email/imap-service') return { verifyImapSecret: async () => {} };
  return original(request, parent, isMain);
};
async function main() {
  database = await createPiTestDatabase();
  const { user, canvasOrganizationSettings, canvasWorkspaces, workspaceEmailMailboxes, emailAccounts } = await import('../app/lib/db/schema');
  const store = await import('../app/lib/email/workspace-mailbox-store');
  const now = new Date();
  await database.db.insert(user).values({ id: 'admin', name: 'Admin', email: 'admin@example.test', emailVerified: true, createdAt: now, updatedAt: now });
  await database.db.insert(canvasOrganizationSettings).values({ organizationId: 'org', ownerUserId: 'admin', deploymentMode: 'managed-team', teamFeaturesEnabled: true, createdAt: now, updatedAt: now });
  await database.db.insert(canvasWorkspaces).values(['one', 'two', 'forbidden'].map(id => ({ id, organizationId: 'org', type: 'team', rootRelativePath: id, displayName: id, createdAt: now, updatedAt: now })));
  const draft = { emailAddress: 'shared@example.test' };
  const created = await store.saveAdminWorkspaceMailbox('admin', { ...draft, workspaceId: 'one' }, { organizationId: 'org' });
  assert.equal(created.workspaceId, 'one'); assert.equal(writes, 1);
  const active = () => database.db.query.workspaceEmailMailboxes.findMany({ where: and(eq(workspaceEmailMailboxes.emailAccountId, created.accountId), eq(workspaceEmailMailboxes.status, 'active')) });
  await database.db.update(emailAccounts).set({ policyJson: JSON.stringify({ readFrom: ['@allowed.test'], sendTo: ['@allowed.test'] }) }).where(eq(emailAccounts.id, created.accountId));
  await store.saveAdminWorkspaceMailbox('admin', { ...draft, accountId: created.accountId }, { organizationId: 'org' });
  assert.equal(JSON.parse((await database.db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, created.accountId) }))!.policyJson).sendTo[0], '@allowed.test', 'Connection edits preserve existing send policy');
  assert.equal((await active())[0].workspaceId, 'one', 'Omitted workspace preserves current assignment');
  assert.equal((await active()).length, 1, 'Editing does not duplicate active assignments');
  assert.ok((await database.db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, created.accountId) }))?.automationEnabledAt);
  let before = writes;
  allowed.delete('one');
  await assert.rejects(store.saveAdminWorkspaceMailbox('admin', { ...draft, accountId: created.accountId, workspaceId: 'two' }, { organizationId: 'org' }), /denied/);
  assert.equal(writes, before, 'Old workspace permission must be checked before credentials change');
  allowed.add('one');
  await assert.rejects(store.saveAdminWorkspaceMailbox('admin', { ...draft, accountId: created.accountId, workspaceId: 'forbidden' }, { organizationId: 'org' }), /denied/);
  assert.equal(writes, before, 'New workspace permission must be checked before credentials change');
  checked.length = 0;
  await store.saveAdminWorkspaceMailbox('admin', { ...draft, accountId: created.accountId, workspaceId: 'two' }, { organizationId: 'org' });
  assert.deepEqual(checked, ['one', 'two']); assert.equal((await active()).length, 1); assert.equal((await active())[0].workspaceId, 'two');
  await store.saveAdminWorkspaceMailbox('admin', { ...draft, accountId: created.accountId, workspaceId: null }, { organizationId: 'org' });
  assert.deepEqual(await active(), [], 'Explicit null unassigns the mailbox');
  assert.equal((await database.db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, created.accountId) }))?.automationEnabledAt, null);
  const choices = await store.listWorkspaceMailboxWorkspaceChoices('org', 'admin');
  assert.deepEqual(choices.map(choice => choice.id).sort(), ['one', 'two']);
  before = writes;
  await assert.rejects(store.saveAdminWorkspaceMailbox('admin', { ...draft, accountId: created.accountId, workspaceId: 'one' }, { organizationId: 'different-org' }));
  assert.equal(writes, before, 'Organization mismatch cannot change secrets');
  console.log('Business mailbox assignment passed: preserve/change/remove, old+new rights before secrets, filtered choices and org boundary.');
}
let failed = false;
main().catch(error => { console.error(error); failed = true; }).finally(async () => { internal._load = original; await database?.close(); if (failed) process.exitCode = 1; });
