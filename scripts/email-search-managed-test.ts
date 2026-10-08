import assert from 'node:assert/strict';
import Module from 'node:module';

const internals = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = internals._load;
let acknowledged = false;
let managedMessage: Record<string, unknown> = { id: 'message', from: 'sender@example.test' };
const searches: Record<string, unknown>[] = [];
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request.endsWith('/email/local-service')) return { listLocalEmailAccounts: async () => [] };
  if (request.endsWith('/email/managed-client')) return {
    isManagedEmailAvailable: () => true,
    managedEmailRequest: async (url: string, init?: RequestInit) => {
      if (url.endsWith('/accounts')) return { accounts: [{ id: 'managed', provider: 'google', status: 'active' }] };
      if (url.includes('/messages/')) return { message: managedMessage };
      const body = JSON.parse(String(init?.body)); searches.push(body);
      return { messages: [managedMessage], ...(acknowledged ? { searchSyntaxVersion: 1, hasMore: true, nextOffset: body.offset + body.limit } : {}) };
    },
  };
  if (['/email/cache/read-through', '/email/cache/consistency', '/email/attachments', '/email/smtp-service'].some((suffix) => request.endsWith(suffix))) return {};
  if (request.endsWith('/email/cache/store')) return { normalizeEmailCacheProvider: (provider: string) => provider };
  return originalLoad(request, parent, isMain);
};
async function main() {
  try {
    const { searchEmail, listEmailMessages, readEmailMessage } = await import('../app/lib/email/service');
    const { EmailSearchQueryError } = await import('../app/lib/email/search-query');
    const basic = await searchEmail('test', { accountId: 'managed', query: 'invoice' });
    assert.match(basic.searchNotice || '', /compatibility mode/); assert.equal(basic.hasMore, false);
    for (const input of [{ query: 'invoice OR offer' }, { query: 'to:anna' }, { folder: 'all' }, { offset: 20 }, { filter: 'unread' }]) {
      await assert.rejects(() => listEmailMessages('test', { accountId: 'managed', ...input }), EmailSearchQueryError);
    }
    acknowledged = true;
    const result = await searchEmail('test', { accountId: 'managed', query: 'to:anna AND body:invoice', folder: 'all', offset: 20, limit: 10 });
    assert.equal(result.nextOffset, 30); assert.equal(result.hasMore, true); assert.equal(result.folder, 'all');
    assert.equal(searches.at(-1)?.searchSyntaxVersion, 1); assert.equal(searches.at(-1)?.offset, 20);
    assert.equal((searches.at(-1)?.searchExpression as { type: string }).type, 'and');
    const count = searches.length;
    await assert.rejects(() => searchEmail('test', { accountId: 'managed', query: 'invoice OR' }), EmailSearchQueryError);
    assert.equal(searches.length, count, 'invalid expressions never reach the provider');
    managedMessage = { id: 'message', from: { emailAddress: { name: 'Sender, Team', address: 'sender@example.test' } },
      to: [{ emailAddress: { name: 'Recipient', address: 'recipient@example.test' } }],
      cc: 'Copy <copy@example.test>', replyTo: '"Support, Team" <support@example.test>' };
    const detail = await readEmailMessage('test', 'managed', 'message', 'INBOX', { skipClassification: true });
    assert.equal(detail.message?.from, '"Sender, Team" <sender@example.test>');
    assert.deepEqual(detail.message?.to, ['Recipient <recipient@example.test>']);
    assert.deepEqual(detail.message?.cc, ['Copy <copy@example.test>']);
    assert.deepEqual(detail.message?.replyTo, ['"Support, Team" <support@example.test>']);
    managedMessage = { id: 'message', from: 'sender@example.test' };
    const legacyDetail = await readEmailMessage('test', 'managed', 'message', 'INBOX', { skipClassification: true });
    assert.equal(Object.hasOwn(legacyDetail.message || {}, 'replyTo'), false, 'legacy managed services must not synthesize Reply-To');
    console.log('Managed search: versioned AST/scope/paging contract, explicit legacy limitations and syntax preflight passed.');
  } finally { internals._load = originalLoad; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
