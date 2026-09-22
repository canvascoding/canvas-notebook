import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
const calls: Array<{ userId: string; accountId: string }> = [];
const checkedWorkspaces: string[] = [];
let allowMailboxWorkspace = true;
const internal = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internal._load;
internal._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/email/secret-store') return {};
  if (request === '@/app/lib/pi/tool-runtime-helpers') return { getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) };
  if (request === '@/app/lib/db') return database;
  if (request === '@/app/lib/pi/session-workspace-context') return { resolveAgentSessionWorkspaceForUser: async ({ userId, workspaceId }: { userId: string; workspaceId: string }) => {
    assert.equal(userId, 'viewer'); checkedWorkspaces.push(workspaceId);
    if (workspaceId !== 'mail-workspace' || !allowMailboxWorkspace) throw new Error('Workspace access denied.');
    return { workspaceId, permissions: { canRead: true } };
  } };
  if (request === '@/app/lib/email/service') return { readEmailMessage: async (userId: string, accountId: string) => { calls.push({ userId, accountId }); return { message: { id: 'message', subject: 'Fixture' } }; } };
  if (['@/app/lib/email/attachment-batch', '@/app/lib/email/attachment-workspace-save', '@/app/lib/email/attachments', '@/app/lib/email/workspace-inbox-outbox'].includes(request)) return {};
  return originalLoad(request, parent, isMain);
};
async function main() {
  database = await createPiTestDatabase();
  const { user, emailAccounts, workspaceEmailMailboxes } = await import('../app/lib/db/schema');
  const { createEmailAgentTools } = await import('../app/lib/pi/workspace-email-tools');
  const now = new Date();
  await database.db.insert(user).values(['owner', 'viewer'].map(id => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
  await database.db.insert(emailAccounts).values([
    { id: 'work', userId: 'owner', accountScope: 'workspace' },
    { id: 'personal', userId: 'viewer', accountScope: 'personal' },
  ].map(account => ({ ...account, provider: 'google', authType: 'oauth', emailAddress: `${account.id}@example.test`, secretRef: 'fixture', policyJson: '{}', status: 'active', createdAt: now, updatedAt: now })));
  await database.db.insert(workspaceEmailMailboxes).values({ id: 'mailbox-work', workspaceId: 'mail-workspace', emailAccountId: 'work', createdByUserId: 'owner', lastEditedByUserId: 'owner', createdAt: now, updatedAt: now });
  const tools = createEmailAgentTools({ userId: 'viewer', workspaceId: 'chat-workspace' });
  const invoke = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.find(tool => tool.name === name)!;
    return tool.execute('test', params as never);
  };
  const listed = await invoke('email_list_mailboxes', { mailboxWorkspaceId: 'mail-workspace' });
  assert.match(JSON.stringify(listed), /mailbox-work/);
  await invoke('email_read_message', { mailboxId: 'mailbox-work', mailboxWorkspaceId: 'mail-workspace', messageId: 'message' });
  assert.deepEqual(calls, [{ userId: 'owner', accountId: 'work' }], 'Explicit mailbox workspace wins over the unrelated chat workspace; provider owner stays server-resolved');
  const failedDefault = await invoke('email_read_message', { mailboxId: 'mailbox-work', messageId: 'message' });
  assert.match(JSON.stringify(failedDefault), /Workspace access denied/); assert.equal(calls.length, 1);
  await invoke('email_read_message', { mailboxId: 'account:personal', messageId: 'message' });
  assert.deepEqual(calls[1], { userId: 'viewer', accountId: 'personal' });
  const mismatched = await invoke('email_read_message', { mailboxId: 'account:personal', mailboxWorkspaceId: 'mail-workspace', messageId: 'message' });
  assert.match(JSON.stringify(mismatched), /Personal mailbox IDs cannot/); assert.equal(calls.length, 2);
  allowMailboxWorkspace = false;
  await invoke('email_read_message', { mailboxId: 'mailbox-work', mailboxWorkspaceId: 'mail-workspace', messageId: 'message' });
  assert.equal(calls.length, 2, 'Revoked access cannot fall back to another mailbox');
  allowMailboxWorkspace = true;
  const bound = createEmailAgentTools({ userId: 'viewer', workspaceId: 'mail-workspace', bindings: { mailboxId: 'mailbox-work', providerMessageId: 'message', providerThreadId: null, folder: 'INBOX' } });
  const before = checkedWorkspaces.length;
  await bound.find(tool => tool.name === 'email_list_mailboxes')!.execute('bound', { mailboxWorkspaceId: 'chat-workspace' } as never);
  assert.deepEqual(checkedWorkspaces.slice(before), ['mail-workspace'], 'Automation remains server-pinned despite client workspace arguments');
  await database.db.update(workspaceEmailMailboxes).set({ status: 'archived' }).where(eq(workspaceEmailMailboxes.id, 'mailbox-work'));
  await invoke('email_read_message', { mailboxId: 'mailbox-work', mailboxWorkspaceId: 'mail-workspace', messageId: 'message' });
  assert.equal(calls.length, 2, 'Archived assignment cannot reach provider');
  console.log('Email tool mailbox context passed: explicit workspace, personal scope, revocation and pinned automation.');
}
let failed = false;
main().catch(error => { console.error(error); failed = true; }).finally(async () => { internal._load = originalLoad; await database?.close(); if (failed) process.exitCode = 1; });
