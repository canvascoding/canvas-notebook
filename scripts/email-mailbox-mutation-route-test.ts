import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest } from 'next/server';

const calls: Array<{ kind: string; args: unknown[] }> = [];
let denyAccess = false;
let denyMessage = false;
let denyDelete = false;
class EmailMailboxAccessError extends Error { status = 403; }
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: 'actor' } }) } } };
  if (request === '@/app/lib/email/ai-route-guard') return { requireEmailAiRouteSession: async () => ({ user: { id: 'actor' } }) };
  if (request === '@/app/lib/email/mailbox-ai' || request === '@/app/lib/email/mailbox-compose') return {};
  if (request === '@/app/lib/email/logging') return { logEmailClientEvent: () => {} };
  if (request === '@/app/lib/email/mailbox-access') return {
    EmailMailboxAccessError,
    resolveEmailMailboxAccess: async (input: { mailboxWorkspaceId?: string; operation: string }) => {
      calls.push({ kind: 'access', args: [input] });
      if (denyAccess || (denyDelete && input.operation === 'delete')) throw new EmailMailboxAccessError('Permission removed');
      return { accountOwnerId: 'owner', accountId: 'account', workspaceId: input.mailboxWorkspaceId || null, readOptions: { enforceReadPolicy: Boolean(input.mailboxWorkspaceId) } };
    },
  };
  if (request === '@/app/lib/email/imap-service') return { isImapMailboxChangedError: () => false };
  if (request === '@/app/lib/utils/rate-limit') return { rateLimit: () => ({ ok: true }) };
  if (request === '@/app/lib/email/service') return Object.fromEntries([
    'readEmailMessage', 'archiveEmailMessage', 'deleteEmailMessagePermanently', 'moveEmailMessage', 'setEmailMessageAnswered', 'setEmailMessageRead', 'trashEmailMessage',
  ].map(name => [name, async (...args: unknown[]) => {
    calls.push({ kind: name, args });
    if (name === 'readEmailMessage' && denyMessage) throw new Error('Sender blocked by read policy');
    return { ok: true };
  }]));
  return originalLoad(request, parent, isMain);
};
async function main() {
  const { POST } = await import('../app/api/email/accounts/[accountId]/messages/[messageId]/actions/route');
  const run = (action: string, shared = true) => POST(new NextRequest('http://localhost/api/email/accounts/account/messages/message/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, folder: 'INBOX', destination: 'Archive', ...(shared ? { mailboxWorkspaceId: 'work' } : {}) }) }), { params: Promise.resolve({ accountId: 'account', messageId: 'message' }) });
  for (const action of ['archive', 'trash', 'permanent-delete', 'mark-read', 'mark-unread', 'mark-answered', 'clear-answered', 'move']) {
    calls.length = 0;
    assert.equal((await run(action)).status, 200);
    assert.equal(calls[0].kind, 'access');
    assert.deepEqual(calls[0].args[0], { userId: 'actor', accountId: 'account', mailboxWorkspaceId: 'work', operation: ['trash', 'permanent-delete'].includes(action) ? 'delete' : 'write' });
    assert.equal(calls[1].kind, 'readEmailMessage');
    assert.deepEqual(calls[1].args, ['owner', 'account', 'message', 'INBOX', { enforceReadPolicy: true }]);
    assert.equal(calls.length, 3, 'Only authorized readable messages reach the mutation');
    assert.deepEqual(calls[2].args.slice(0, 4), ['owner', 'account', 'message', 'INBOX']);
  }
  calls.length = 0;
  denyAccess = true;
  assert.equal((await run('trash')).status, 403);
  assert.equal(calls.length, 1, 'Revoked permission blocks provider reads and writes');
  denyAccess = false;
  denyMessage = true;
  calls.length = 0;
  assert.equal((await run('trash')).status, 500);
  assert.deepEqual(calls.map(call => call.kind), ['access', 'readEmailMessage'], 'Blocked sender cannot be mutated by guessing a message ID');
  denyMessage = false;
  calls.length = 0;
  assert.equal((await run('mark-read', false)).status, 200);
  assert.deepEqual(calls.map(call => call.kind), ['access', 'setEmailMessageRead'], 'Personal mutation keeps its current direct flow');
  const mixed = await import('../app/api/email/accounts/[accountId]/messages/actions/route');
  denyDelete = true;
  for (const action of ['trash', 'permanent-delete']) {
    calls.length = 0;
    const request = new NextRequest('http://localhost/api/email/accounts/account/messages/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'action', action, folder: 'INBOX', messageId: 'message', mailboxWorkspaceId: 'work' }) });
    assert.equal((await mixed.POST(request, { params: Promise.resolve({ accountId: 'account' }) })).status, 403);
    assert.deepEqual(calls.map(call => call.kind), ['access'], 'Central mutation endpoint denies deleted messages before provider access');
    calls.length = 0;
    assert.equal((await run(action)).status, 403);
    assert.deepEqual(calls.map(call => call.kind), ['access']);
  }
  console.log('Mailbox mutation route passed: actor and owner separation, permissions, read-policy ordering, all eight operations.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { internals._load = originalLoad; });
