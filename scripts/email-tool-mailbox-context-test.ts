import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
const calls: Array<{ userId: string; accountId: string }> = [];
const outboxCalls: Array<Record<string, unknown>> = [];
let outboxDraftVersion = 1;
let workspaceDraftMailboxId = 'mailbox-work';
const checkedWorkspaces: string[] = [];
let allowMailboxWorkspace = true;
let canRunMailboxAgent = true;
const internal = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internal._load;
internal._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/email/secret-store') return {};
  if (request === '@/app/lib/pi/tool-runtime-helpers') return { getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) };
  if (request === '@/app/lib/db') return database;
  if (request === '@/app/lib/pi/session-workspace-context') return { resolveAgentSessionWorkspaceForUser: async ({ userId, workspaceId, permissions }: { userId: string; workspaceId: string; permissions: string[] }) => {
    assert.equal(userId, 'viewer'); checkedWorkspaces.push(workspaceId);
    if (workspaceId !== 'mail-workspace' || !allowMailboxWorkspace) throw new Error('Workspace access denied.');
    assert.deepEqual(permissions, ['canRead', 'canRunAgent']);
    if (permissions.includes('canRunAgent') && !canRunMailboxAgent) throw new Error('Workspace agent access denied.');
    return { workspaceId, permissions: { canRead: true, canRunAgent: canRunMailboxAgent } };
  } };
  if (request === '@/app/lib/email/service') return { readEmailMessage: async (userId: string, accountId: string) => { calls.push({ userId, accountId }); return { message: { id: 'message', subject: 'Fixture' } }; } };
  if (request === '@/app/lib/email/attachments') return { snapshotAgentWorkspaceEmailAttachments: async () => [] };
  if (request === '@/app/lib/email/workspace-inbox-outbox') {
    const capture = async (input: Record<string, unknown>) => { outboxCalls.push(input); return { id: 'draft-test', subject: input.subject, version: 1 }; };
    const current = (accountId: string, mailboxId: string | null) => ({ id: 'draft-test', accountId, mailboxId, version: outboxDraftVersion, subject: 'Original', body: '<p><strong>Original</strong></p>', isHtml: true, to: ['original@example.test'], cc: ['copy@example.test'], bcc: ['blind@example.test'] });
    return { createPersonalOutboxDraft: capture, createWorkspaceOutboxDraft: capture, updatePersonalOutboxDraft: capture, updateWorkspaceOutboxDraft: capture,
      findPersonalOutboxDraft: async () => current('personal', null),
      findWorkspaceOutboxDraft: async () => current('work', workspaceDraftMailboxId),
    };
  }
  if (['@/app/lib/email/attachment-batch', '@/app/lib/email/attachment-workspace-save'].includes(request)) return {};
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
  canRunMailboxAgent = false;
  const forbiddenRead = await invoke('email_read_message', { mailboxId: 'mailbox-work', mailboxWorkspaceId: 'mail-workspace', messageId: 'message' });
  const forbiddenList = await invoke('email_list_mailboxes', { mailboxWorkspaceId: 'mail-workspace' });
  assert.match(JSON.stringify(forbiddenRead), /Workspace agent access denied/);
  assert.match(JSON.stringify(forbiddenList), /Workspace agent access denied/);
  assert.doesNotMatch(JSON.stringify(forbiddenList), /mailbox-work/);
  assert.equal(calls.length, 1, 'Read permission alone cannot grant a cross-workspace agent provider access');
  canRunMailboxAgent = true;
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
  canRunMailboxAgent = false;
  const boundDenied = await bound.find(tool => tool.name === 'email_read_message')!.execute('bound', { messageId: 'message' } as never);
  assert.match(JSON.stringify(boundDenied), /Workspace agent access denied/);
  assert.equal(calls.length, 2, 'Bound automation also respects revoked agent permissions');
  canRunMailboxAgent = true;
  await invoke('email_create_outbox_draft', { mailboxId: 'account:personal', to: ['recipient@example.test'], subject: 'Formatted', bodyMarkdown: 'Hallo **Frank**' });
  assert.match(String(outboxCalls.at(-1)?.bodyHtml), /<strong>Frank<\/strong>/u);
  assert.doesNotMatch(String(outboxCalls.at(-1)?.bodyHtml), /\*\*Frank\*\*/u);
  const updateBoundDraft = async (params: Record<string, unknown>) => bound.find(tool => tool.name === 'email_update_outbox_draft')!.execute('bound', { draftId: 'draft-test', expectedVersion: 1, ...params } as never);
  await updateBoundDraft({ bodyMarkdown: '- Eins\n- Zwei' });
  assert.match(String(outboxCalls.at(-1)?.bodyHtml), /<li>Eins<\/li>/u);
  assert.equal(outboxCalls.at(-1)?.actor, 'agent');
  assert.deepEqual(outboxCalls.at(-1)?.to, ['original@example.test']);
  assert.deepEqual(outboxCalls.at(-1)?.cc, ['copy@example.test']);
  assert.equal(outboxCalls.at(-1)?.subject, 'Original');
  await invoke('email_update_outbox_draft', { mailboxId: 'account:personal', draftId: 'draft-test', expectedVersion: 1, subject: 'New subject' });
  assert.equal(outboxCalls.at(-1)?.subject, 'New subject');
  assert.equal(outboxCalls.at(-1)?.bodyHtml, '<p><strong>Original</strong></p>', 'Subject-only edits preserve existing HTML');
  await updateBoundDraft({ cc: [] });
  assert.deepEqual(outboxCalls.at(-1)?.cc, [], 'An explicit empty array clears CC');
  outboxDraftVersion = 2;
  const stale = await updateBoundDraft({ subject: 'Stale' });
  assert.match(JSON.stringify(stale), /changed.*Reload/u);
  outboxDraftVersion = 1;
  workspaceDraftMailboxId = 'another-mailbox';
  const wrongMailbox = await updateBoundDraft({ subject: 'Wrong mailbox' });
  assert.match(JSON.stringify(wrongMailbox), /not found in the selected mailbox/u);
  workspaceDraftMailboxId = 'mailbox-work';
  await invoke('email_create_outbox_draft', { mailboxId: 'account:personal', to: ['recipient@example.test'], subject: 'Plain', body: 'Price is *5*' });
  assert.equal(outboxCalls.at(-1)?.body, 'Price is *5*', 'Legacy plain text remains plain text');
  const ambiguous = await invoke('email_create_outbox_draft', { mailboxId: 'account:personal', to: ['recipient@example.test'], subject: 'Invalid', body: 'plain', bodyMarkdown: '**bold**' });
  assert.match(JSON.stringify(ambiguous), /Provide bodyMarkdown or the legacy/u);
  await database.db.update(workspaceEmailMailboxes).set({ status: 'archived' }).where(eq(workspaceEmailMailboxes.id, 'mailbox-work'));
  await invoke('email_read_message', { mailboxId: 'mailbox-work', mailboxWorkspaceId: 'mail-workspace', messageId: 'message' });
  assert.equal(calls.length, 2, 'Archived assignment cannot reach provider');
  console.log('Email tool mailbox context passed: explicit workspace, personal scope, revocation and pinned automation.');
}
let failed = false;
main().catch(error => { console.error(error); failed = true; }).finally(async () => { internal._load = originalLoad; await database?.close(); if (failed) process.exitCode = 1; });
