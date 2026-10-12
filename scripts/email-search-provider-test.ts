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
  if (request.endsWith('/email/secret-store')) return {
    mutateEmailAccountSecret: async (_secretRef: string, operation: (secret: unknown) => Promise<{ result: unknown }>) =>
      (await operation({ authType: 'oauth', accessToken: 'test-token' })).result,
  };
  if (['/lib/db', '/lib/db/schema', '/email/ai-service', '/email/attachments', '/email/smtp-service', '/email/imap-service', '/integrations/env-config', '/email/cache/consistency'].some((suffix) => request.endsWith(suffix))) return {};
  return originalLoad(request, parent, isMain);
};
const calls: URL[] = [];
let scenario = 'google';
let discoveryBlocked = false;
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
globalThis.fetch = async (input) => {
  const url = new URL(String(input)); calls.push(url);
  if (scenario === 'google-discovery') {
    assert.equal(url.pathname.includes('/attachments/'), false, 'recipient discovery never fetches deferred MIME bodies');
    if (url.pathname.endsWith('/messages')) {
      assert.ok(url.searchParams.get('q')?.includes('to:'));
      const start = Number(url.searchParams.get('pageToken') || 0);
      const count = Number(url.searchParams.get('maxResults'));
      assert.ok(count > 0 && count <= 50);
      return response({ messages: Array.from({ length: count }, (_, index) => ({ id: `discovery-${start + index}` })), nextPageToken: String(start + count) });
    }
    assert.equal(url.searchParams.get('format'), 'metadata', 'recipient discovery loads headers instead of full MIME');
    const headers = url.searchParams.getAll('metadataHeaders');
    assert.ok(headers.includes('From') && headers.includes('To') && headers.includes('Cc'));
    return response({ id: url.pathname.split('/').at(-1), snippet: 'Private body preview', payload: {
      mimeType: 'text/plain', headers: [
        { name: 'From', value: discoveryBlocked ? 'blocked@example.test' : 'Sender <allowed@example.test>' },
        { name: 'To', value: 'Recipient <recipient@example.test>' }, { name: 'Cc', value: 'Copy <copy@example.test>' },
        { name: 'Bcc', value: 'private@example.test' }, { name: 'Subject', value: 'Private subject' },
      ], body: { attachmentId: 'body-data', size: 12 },
    } });
  }
  if (scenario === 'google-detail') {
    return response({ id: 'g-detail', payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'Sender <allowed@example.test>' },
      { name: 'To', value: 'Recipient <recipient@example.test>' },
      { name: 'Reply-To', value: '"Support, Team" <support@example.test>, Other <other@example.test>' },
    ], body: { data: Buffer.from('Message body').toString('base64url') } } });
  }
  if (scenario === 'microsoft-detail') {
    if (url.pathname.endsWith('/attachments')) return response({ value: [] });
    assert.ok(url.searchParams.get('$select')?.split(',').includes('replyTo'));
    return response({ id: 'm-detail', from: { emailAddress: { name: 'Sender, Team', address: 'allowed@example.test' } },
      toRecipients: [{ emailAddress: { name: 'Recipient', address: 'recipient@example.test' } }],
      ccRecipients: [{ emailAddress: { name: 'Copy', address: 'copy@example.test' } }],
      replyTo: [{ emailAddress: { name: 'Support, Team', address: 'support@example.test' } }],
      body: { contentType: 'text', content: 'Message body' } });
  }
  if (scenario === 'microsoft-discovery') {
    const selected = url.searchParams.get('$select')?.split(',') || [];
    assert.ok(selected.includes('from') && selected.includes('toRecipients') && selected.includes('ccRecipients'));
    assert.ok(['body', 'bodyPreview', 'bccRecipients', 'subject'].every(field => !selected.includes(field)), 'Graph recipient lookup requests only compact address metadata');
    assert.ok(url.searchParams.get('$search')?.includes('from:'));
    return response({ value: [{ id: 'm-recipient', from: { emailAddress: { name: 'Sender, Team', address: 'allowed@example.test' } },
      toRecipients: [{ emailAddress: { name: 'Recipient', address: 'recipient@example.test' } }],
      ccRecipients: [{ emailAddress: { name: 'Copy', address: 'copy@example.test' } }],
      bccRecipients: [{ emailAddress: { address: 'private@example.test' } }], bodyPreview: 'Private body preview' }] });
  }
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
    return response({ value: [0, 1, 2].map((index) => ({ id: `m${index}`, parentFolderId: 'actual-folder', from: { emailAddress: { name: 'Sender, Team', address: 'allowed@example.test' } }, toRecipients: [{ emailAddress: { name: 'Recipient', address: 'recipient@example.test' } }], isRead: index === 0 })) });
  }
  assert.equal(url.searchParams.get('includeSpamTrash'), 'true');
  assert.equal(url.searchParams.has('labelIds'), false);
  return response({ messages: [] });
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'email-search-provider-'));
  process.env.DATA = root; process.env.CANVAS_DATA_ROOT = root;
  try {
    const { listLocalEmailMessages, readLocalEmailMessage } = await import('../app/lib/email/local-service');
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

    scenario = 'google-discovery'; calls.length = 0;
    const discovery = await listLocalEmailMessages('test', { query: 'to:recipient OR cc:copy', limit: 2 }, { recipientDiscovery: true });
    assert.deepEqual(discovery.messages.map((message) => message.id), ['discovery-0', 'discovery-1']);
    assert.deepEqual(discovery.messages[0].to, ['Recipient <recipient@example.test>']);
    assert.equal(discovery.messages[0].snippet, '', 'body previews are omitted from recipient results');
    assert.equal(Object.hasOwn(discovery.messages[0], 'bcc'), false, 'Bcc is never disclosed by recipient lookup');
    assert.equal(discovery.hasMore, true); assert.equal(discovery.nextOffset, 2);

    discoveryBlocked = true; calls.length = 0;
    const discoveryBounded = await listLocalEmailMessages('test', { query: 'to:recipient', limit: 2 }, { recipientDiscovery: true });
    assert.equal(discoveryBounded.messages.length, 0, 'mailbox read policy also applies to recipient discovery');
    assert.equal(discoveryBounded.total, null, 'a bounded empty scan does not claim the complete mailbox was searched');
    assert.match(discoveryBounded.searchNotice || '', /100 provider results/u);
    assert.equal(calls.filter(url => url.pathname.endsWith('/messages')).length, 2);
    assert.equal(calls.filter(url => url.searchParams.get('format') === 'metadata').length, 100, 'initial discovery scans no more than 100 header records');

    discoveryBlocked = false; calls.length = 0;
    const discoveryLater = await listLocalEmailMessages('test', { query: 'to:recipient', limit: 10, offset: 110 }, { recipientDiscovery: true });
    assert.deepEqual(discoveryLater.messages.map(message => message.id), Array.from({ length: 10 }, (_, index) => `discovery-${110 + index}`));
    assert.equal(discoveryLater.hasMore, true); assert.equal(discoveryLater.nextOffset, 120);
    assert.equal(calls.filter(url => url.searchParams.get('format') === 'metadata').length, 121, 'explicit pagination expands only the requested scan window');

    const beforeInvalidDiscovery = calls.length;
    for (const query of ['body:needle', 'needle', 'to:recipient OR body:needle', 'subject:recipient', 'bcc:recipient', '']) {
      await assert.rejects(listLocalEmailMessages('test', { query }, { recipientDiscovery: true }), /address-header search/u);
    }
    assert.equal(calls.length, beforeInvalidDiscovery, 'invalid recipient searches are rejected before provider reads');

    provider = 'microsoft'; scenario = 'microsoft'; calls.length = 0;
    const microsoft = await listLocalEmailMessages('test', { query: 'recipient', filter: 'unread', limit: 1 });
    assert.deepEqual(microsoft.messages.map((message) => message.id), ['m1']); assert.equal(microsoft.hasMore, true);
    assert.equal(microsoft.messages[0].from, '"Sender, Team" <allowed@example.test>');
    assert.deepEqual(microsoft.messages[0].to, ['Recipient <recipient@example.test>']);
    scenario = 'microsoft-discovery'; calls.length = 0;
    const microsoftDiscovery = await listLocalEmailMessages('test', { query: 'from:allowed', limit: 2 }, { recipientDiscovery: true });
    assert.deepEqual(microsoftDiscovery.messages.map(message => message.id), ['m-recipient']);
    assert.equal(microsoftDiscovery.messages[0].from, '"Sender, Team" <allowed@example.test>');
    assert.deepEqual(microsoftDiscovery.messages[0].cc, ['Copy <copy@example.test>']);
    assert.equal(microsoftDiscovery.messages[0].snippet, '');
    assert.equal(Object.hasOwn(microsoftDiscovery.messages[0], 'bcc'), false);
    scenario = 'microsoft-detail'; calls.length = 0;
    const microsoftDetail = await readLocalEmailMessage('test', 'test', 'm-detail');
    assert.equal(microsoftDetail.message.from, '"Sender, Team" <allowed@example.test>');
    assert.deepEqual(microsoftDetail.message.to, ['Recipient <recipient@example.test>']);
    assert.deepEqual(microsoftDetail.message.cc, ['Copy <copy@example.test>']);
    assert.deepEqual(microsoftDetail.message.replyTo, ['"Support, Team" <support@example.test>']);
    provider = 'google'; scenario = 'google-detail'; calls.length = 0;
    const googleDetail = await readLocalEmailMessage('test', 'test', 'g-detail');
    assert.equal(googleDetail.message.from, 'Sender <allowed@example.test>');
    assert.deepEqual(googleDetail.message.replyTo, ['"Support, Team" <support@example.test>', 'Other <other@example.test>']);
    provider = 'google'; scenario = 'all'; calls.length = 0;
    await listLocalEmailMessages('test', { folder: 'all' });
    console.log('Provider search: normal full-body/MIME search, metadata-only recipient lookup, read policy, bounded/explicit paging, query guards and provider normalization passed.');
  } finally {
    internals._load = originalLoad; globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
