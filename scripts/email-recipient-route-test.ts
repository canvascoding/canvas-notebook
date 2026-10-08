import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest } from 'next/server';

const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const original = loader._load;
let session: { user: { id: string } } | null = null;
const calls: Array<Record<string, unknown>> = [];
let failure: Error | null = null;
class DiscoveryError extends Error { constructor(public code: string, public status: number, message: string) { super(message); } }
loader._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => session } } };
  if (request === '@/app/lib/utils/rate-limit') return { rateLimit: () => ({ ok: true }) };
  if (request === '@/app/lib/email/recipient-discovery') return {
    EmailRecipientDiscoveryError: DiscoveryError,
    findEmailRecipients: async (input: Record<string, unknown>) => { calls.push(input); if (failure) throw failure; return { candidates: [] }; },
    suggestEmailReplyRecipients: async (input: Record<string, unknown>) => { calls.push(input); if (failure) throw failure; return { basis: 'current_message' }; },
  };
  return original(request, parent, isMain);
};

async function main() {
  const { POST } = await import('../app/api/email/recipients/route');
  const request = (body: unknown) => new NextRequest('https://canvas.test/api/email/recipients', { method: 'POST', body: JSON.stringify(body) });
  const check = async (body: unknown, status: number) => {
    const response = await POST(request(body));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    return response.json();
  };
  await check({ mode: 'find', accountId: 'a', query: 'Anna' }, 401);
  assert.equal(calls.length, 0);
  session = { user: { id: 'actor' } };
  await check({ mode: 'find', accountId: 'a', mailboxWorkspaceId: 'work', query: 'Anna', purpose: 'agent', actorUserId: 'victim', accountOwnerId: 'victim' }, 200);
  assert.deepEqual(calls[0], { actorUserId: 'actor', accountId: 'a', mailboxWorkspaceId: 'work', purpose: 'human', folder: undefined, exclude: undefined, query: 'Anna', offset: undefined });
  await check({ mode: 'find', query: 'Anna' }, 400);
  await check({ mode: 'find', accountId: 'a', query: 'Anna', offset: '25' }, 400);
  await check({ mode: 'find', accountId: 'a', query: 'Anna', exclude: [5] }, 400);
  assert.equal(calls.length, 1, 'Invalid requests do not reach discovery');
  await check({ mode: 'reply', accountId: 'a', messageId: 'm', replyMode: 'reply-all' }, 200);
  assert.equal(calls[1].mode, 'reply-all');
  failure = new DiscoveryError('MAILBOX_UNAVAILABLE', 403, 'Mailbox access was removed.');
  assert.equal((await check({ mode: 'find', accountId: 'a', query: 'Anna' }, 403)).code, 'MAILBOX_UNAVAILABLE');
  failure = new Error('private-provider-url and secret');
  const error = await check({ mode: 'find', accountId: 'a', query: 'Anna' }, 502);
  assert.doesNotMatch(JSON.stringify(error), /private-provider|secret/u);
  console.log('Email recipient route authentication, scope, validation and private responses passed.');
}
main().finally(() => { loader._load = original; }).catch(error => { console.error(error); process.exitCode = 1; });
