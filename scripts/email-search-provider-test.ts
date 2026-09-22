import assert from 'node:assert/strict';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const internals = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = internals._load;
const originalFetch = globalThis.fetch;
let provider = 'google';
const account = () => ({ id: 'test', userId: 'test', authType: 'oauth', provider, emailAddress: 'owner@example.test', policyJson: JSON.stringify({ readFrom: ['allowed@example.test'], sendTo: [] }) });
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request.endsWith('/email/account-store')) return {
    getEmailAccountForUser: async () => account(), readStoredEmailAccountSecret: async () => ({ authType: 'oauth', accessToken: 'test-token' }),
    publicStoredEmailAccount: (value: unknown) => value, listPublicEmailAccountsForUser: async () => [],
  };
  if (['/lib/db', '/lib/db/schema', '/email/ai-service', '/email/attachments', '/email/smtp-service', '/email/imap-service', '/integrations/env-config', '/email/cache/consistency'].some((suffix) => request.endsWith(suffix))) return {};
  return originalLoad(request, parent, isMain);
};
const calls: URL[] = [];
let scenario = 'google';
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
globalThis.fetch = async (input) => {
  const url = new URL(String(input)); calls.push(url);
  if (scenario === 'google') {
    if (url.pathname.endsWith('/messages')) {
      assert.ok(url.searchParams.get('q')?.includes('"needle"'));
      const second = url.searchParams.get('pageToken') === 'page-2';
      return response(second ? { messages: [{ id: 'good1' }, { id: 'good2' }] } : { messages: [{ id: 'blocked' }, { id: 'wrong-field' }], nextPageToken: 'page-2' });
    }
    const id = url.pathname.split('/').at(-1);
    if (id === 'body-data') return response({ data: Buffer.from('deep needle').toString('base64url') });
    return response({ id, snippet: 'does not include search term', labelIds: [], payload: {
      mimeType: id === 'wrong-field' ? 'multipart/mixed' : 'text/plain', ...(id === 'wrong-field' ? { parts: [{ filename: 'attachment.txt', mimeType: 'text/plain', body: { data: Buffer.from('needle').toString('base64url') } }] } : {}), headers: [
        { name: 'From', value: id === 'blocked' ? 'blocked@example.test' : 'allowed@example.test' },
        { name: 'To', value: 'Recipient <recipient@example.test>' }, { name: 'Cc', value: 'copy@example.test' },
        { name: 'Subject', value: id === 'wrong-field' ? 'needle' : 'Unrelated subject' },
      ], body: id === 'good2' ? { attachmentId: 'body-data', size: 12 } : { data: Buffer.from(id === 'wrong-field' ? 'no match' : `${'prefix '.repeat(12000)}needle`).toString('base64url') },
    } });
  }
  if (scenario === 'microsoft') {
    if (calls.filter((item) => item.hostname === 'graph.microsoft.com').length === 1) {
      assert.ok(url.pathname.endsWith('/mailFolders/inbox/messages'), 'inbox is not all-mail');
      assert.equal(url.searchParams.has('$skip'), false);
      assert.equal(url.searchParams.has('$filter'), false);
      assert.equal(url.searchParams.has('$orderby'), false);
      assert.ok(url.searchParams.get('$search')?.includes('to:'));
      return response({ value: [{ id: 'blocked', from: { emailAddress: { address: 'blocked@example.test' } } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next' });
    }
    assert.equal(url.searchParams.get('$skiptoken'), 'next');
    return response({ value: [0, 1, 2].map((index) => ({ id: `m${index}`, parentFolderId: 'actual-folder', from: { emailAddress: { address: 'allowed@example.test' } }, toRecipients: [{ emailAddress: { name: 'Recipient', address: 'recipient@example.test' } }], isRead: index === 0 })) });
  }
  assert.equal(url.searchParams.get('includeSpamTrash'), 'true');
  assert.equal(url.searchParams.has('labelIds'), false);
  return response({ messages: [] });
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'email-search-provider-'));
  process.env.DATA = root; process.env.CANVAS_DATA_ROOT = root;
  try {
    const { listLocalEmailMessages } = await import('../app/lib/email/local-service');
    const first = await listLocalEmailMessages('test', { query: 'body:needle', limit: 1 });
    assert.deepEqual(first.messages.map((message) => message.id), ['good1']);
    assert.ok(String(first.messages[0].snippet).includes('needle'));
    assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 1);
    assert.ok(calls.some((url) => url.searchParams.get('pageToken') === 'page-2'));
    calls.length = 0;
    const second = await listLocalEmailMessages('test', { query: 'body:needle', limit: 1, offset: 1 });
    assert.deepEqual(second.messages.map((message) => message.id), ['good2']); assert.equal(second.hasMore, false);
    assert.ok(calls.some((url) => url.pathname.endsWith('/attachments/body-data')));
    assert.deepEqual(second.messages[0].to, ['Recipient <recipient@example.test>']);
    provider = 'microsoft'; scenario = 'microsoft'; calls.length = 0;
    const microsoft = await listLocalEmailMessages('test', { query: 'recipient', filter: 'unread', limit: 1 });
    assert.deepEqual(microsoft.messages.map((message) => message.id), ['m1']); assert.equal(microsoft.hasMore, true);
    assert.deepEqual(microsoft.messages[0].to, ['Recipient <recipient@example.test>']);
    provider = 'google'; scenario = 'all'; calls.length = 0;
    await listLocalEmailMessages('test', { folder: 'all' });
    console.log('Provider search: Gmail full body/deferred MIME, policy-aware cursor paging, Graph scope/recipients/paging and all-mail scope passed.');
  } finally {
    internals._load = originalLoad; globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
