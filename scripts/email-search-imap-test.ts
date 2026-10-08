import assert from 'node:assert/strict';
import Module from 'node:module';
import type { StoredEmailAccount } from '../app/lib/email/account-store';
import type { ImapClientLike } from '../app/lib/email/imap-service';

const internals = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request.endsWith('/email/account-store')) return { publicStoredEmailAccount: (value: unknown) => value, readStoredEmailAccountSecret: async () => ({ authType: 'smtp_imap', smtp: {}, imap: { host: 'example.test', port: 993, secure: true, username: 'test', password: 'test' } }) };
  return originalLoad(request, parent, isMain);
};
const account = { id: 'test', emailAddress: 'owner@example.test', authType: 'smtp_imap', policyJson: JSON.stringify({ readFrom: ['allowed@example.test'], sendTo: [] }) } as StoredEmailAccount;
const searches: Array<{ folder: string; query: unknown }> = [];
async function main() {
  const { listImapEmailMessages, setImapClientFactoryForTests, parseImapMessageReference } = await import('../app/lib/email/imap-service');
  let large = false;
  let shuffledDates = false;
  let manyAllowed = false;
  let fetchCalls = 0;
  const fetches: Array<{ uids: number[]; query: Record<string, unknown> }> = [];
  setImapClientFactoryForTests(() => {
    let folder = 'INBOX';
    return {
      mailbox: { uidValidity: BigInt(123) }, connect: async () => undefined, logout: async () => undefined, close: () => undefined,
      list: async () => [{ path: 'INBOX', name: 'Inbox', flags: new Set() }, { path: 'Archive', name: 'Archive', flags: new Set() }],
      getMailboxLock: async (value: string) => { folder = value; return { release: () => undefined }; },
      search: async (query: unknown) => {
        searches.push({ folder, query });
        return manyAllowed ? Array.from({ length: 120 }, (_, i) => i + 1) : large ? Array.from({ length: 1200 }, (_, i) => i + 1) : folder === 'INBOX' ? [1, 2, 3] : [4, 5];
      },
      fetch: async function* (uids: number[], query: Record<string, unknown>) {
        fetchCalls++;
        fetches.push({ uids: [...uids], query });
        for (const uid of uids) yield {
          uid, flags: new Set(), source: Buffer.from('Subject: Example\r\n\r\nneedle'),
          envelope: {
            from: [{ address: large || (!manyAllowed && uid === 3) ? 'blocked@example.test' : 'allowed@example.test' }],
            to: [{ address: 'recipient@example.test' }], subject: `Message ${uid}`,
            date: new Date(Date.UTC(2026, 8, shuffledDates && uid === 1 ? 25 : uid)),
          },
        };
      },
    } as unknown as ImapClientLike;
  });
  try {
    const page = await listImapEmailMessages(account, { query: 'to:recipient AND body:needle', limit: 1 });
    assert.deepEqual(page.messages.map((message) => message.uid), ['2']);
    assert.ok(fetches[0].query.source && fetches[0].query.bodyStructure, 'normal message search still fetches source and MIME metadata');
    assert.equal(page.hasMore, true); assert.equal(page.nextOffset, 1);
    const second = await listImapEmailMessages(account, { query: 'to:recipient AND body:needle', limit: 1, offset: 1 });
    assert.deepEqual(second.messages.map((message) => message.uid), ['1']); assert.equal(second.hasMore, false);
    assert.ok(JSON.stringify(searches[0].query).includes('"body":"needle"'));
    assert.equal(JSON.stringify(searches[0].query).includes('to:recipient AND body:needle'), false);
    const all = await listImapEmailMessages(account, { folder: 'all', query: 'needle', limit: 2 });
    assert.deepEqual(all.messages.map((message) => message.uid), ['5', '4']); assert.equal(all.hasMore, true);
    assert.equal(parseImapMessageReference(all.messages[0].id).folder, 'Archive');
    const allNext = await listImapEmailMessages(account, { folder: 'all', query: 'needle', limit: 2, offset: 2 });
    assert.deepEqual(allNext.messages.map((message) => message.uid), ['2', '1']);
    assert.equal(allNext.hasMore, false);
    shuffledDates = true;
    const reordered = await listImapEmailMessages(account, { folder: 'all', query: 'needle', limit: 1 });
    assert.equal(reordered.messages[0].uid, '1', 'date ordering is applied before slicing each folder');
    shuffledDates = false; manyAllowed = true; fetchCalls = 0;
    await listImapEmailMessages(account, { folder: 'all', query: 'needle', limit: 20, offset: 50 });
    assert.equal(fetchCalls, 4, 'later pages scan each folder once in batches rather than refetching each prefix');
    manyAllowed = false;
    large = true;
    const bounded = await listImapEmailMessages(account, { query: 'needle', limit: 2 });
    assert.equal(bounded.messages.length, 0); assert.equal(bounded.total, null); assert.match(bounded.searchNotice || '', /1000 candidates/);

    fetches.length = 0;
    const discoveryBounded = await listImapEmailMessages(account, { query: 'to:recipient', limit: 2 }, { recipientDiscovery: true });
    assert.equal(discoveryBounded.messages.length, 0, 'read policy is applied before returning recipient metadata');
    assert.equal(discoveryBounded.total, null); assert.match(discoveryBounded.searchNotice || '', /100 candidates/u);
    assert.equal(fetches.reduce((sum, fetch) => sum + fetch.uids.length, 0), 100, 'initial recipient scan is capped at 100 candidates');
    assert.ok(fetches.every(fetch => !Object.hasOwn(fetch.query, 'source') && !Object.hasOwn(fetch.query, 'bodyStructure')));

    fetches.length = 0; searches.length = 0;
    const allDiscoveryBounded = await listImapEmailMessages(account, { folder: 'all', query: 'to:recipient', limit: 2 }, { recipientDiscovery: true });
    assert.equal(allDiscoveryBounded.messages.length, 0); assert.equal(allDiscoveryBounded.total, null);
    assert.match(allDiscoveryBounded.searchNotice || '', /100-candidate limit/u);
    assert.equal(fetches.reduce((sum, fetch) => sum + fetch.uids.length, 0), 100, 'all-folder discovery shares one initial scan budget');
    assert.deepEqual(searches.map(search => search.folder), ['INBOX'], 'the response states incomplete coverage rather than scanning every folder eagerly');

    large = false; manyAllowed = true; fetches.length = 0;
    const discovery = await listImapEmailMessages(account, { query: 'from:allowed OR to:recipient OR cc:copy', limit: 2 }, { recipientDiscovery: true });
    assert.deepEqual(discovery.messages.map(message => message.uid), ['120', '119']);
    assert.equal(discovery.messages[0].snippet, '', 'recipient metadata omits source-derived snippets');
    assert.deepEqual(discovery.messages[0].to, ['recipient@example.test']);
    assert.equal(discovery.hasMore, true); assert.equal(discovery.nextOffset, 2);
    assert.ok(fetches.every(fetch => !Object.hasOwn(fetch.query, 'source') && !Object.hasOwn(fetch.query, 'bodyStructure')));

    fetches.length = 0;
    const discoveryLater = await listImapEmailMessages(account, { query: 'to:recipient', limit: 5, offset: 110 }, { recipientDiscovery: true });
    assert.deepEqual(discoveryLater.messages.map(message => message.uid), ['10', '9', '8', '7', '6']);
    assert.equal(discoveryLater.hasMore, true); assert.equal(discoveryLater.nextOffset, 115);
    assert.equal(fetches.reduce((sum, fetch) => sum + fetch.uids.length, 0), 116, 'explicit pagination expands only the requested metadata scan window');

    const beforeInvalidSearches = searches.length;
    const beforeInvalidFetches = fetches.length;
    for (const query of ['body:needle', 'needle', 'to:recipient OR body:needle', 'subject:recipient', 'bcc:recipient', '']) {
      await assert.rejects(listImapEmailMessages(account, { query }, { recipientDiscovery: true }), /address-header search/u);
    }
    assert.equal(searches.length, beforeInvalidSearches);
    assert.equal(fetches.length, beforeInvalidFetches, 'invalid recipient queries never open a provider search or body fetch');
    console.log('IMAP search: normal source/MIME search, metadata-only recipient lookup, policy, all-folder scan budgets, explicit paging and query guards passed.');
  } finally { setImapClientFactoryForTests(null); internals._load = originalLoad; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
