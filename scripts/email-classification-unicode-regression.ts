import assert from 'node:assert/strict';
import type { PostgresEmailClassificationStore } from '../app/lib/email/classification/store';
import type { EmailClassificationMetadataInput, EmailClassificationQueryable, EmailIndexedMessageList } from '../app/lib/email/classification/store-types';

/** Exercise the JSONB write boundary in both PGlite and native PostgreSQL. */
export async function verifyEmailClassificationUnicodePersistence(input: {
  store: PostgresEmailClassificationStore;
  postgres: EmailClassificationQueryable;
  mailboxRef: string;
  now: number;
}): Promise<void> {
  const { store, postgres, mailboxRef, now } = input;
  const limits = { from: 1_000, subject: 2_000, date: 200, snippet: 2_000, to: 500, cc: 500, threadId: 500 };
  const cases: Array<{ name: string; values: (limit: number) => [string, string] }> = [
    { name: 'ordinary', values: () => ['Grüße 😀 aus Berlin', 'Grüße 😀 aus Berlin'] },
    { name: 'exact-limit', values: limit => ['a'.repeat(limit), 'a'.repeat(limit)] },
    { name: 'over-limit', values: limit => ['a'.repeat(limit + 1), 'a'.repeat(limit)] },
    { name: 'emoji-fits', values: limit => ['a'.repeat(limit - 2) + '😀tail', 'a'.repeat(limit - 2) + '😀'] },
    { name: 'emoji-crosses', values: limit => ['a'.repeat(limit - 1) + '😀tail', 'a'.repeat(limit - 1)] },
    { name: 'emoji-only', values: limit => ['😀'.repeat(limit / 2) + 'tail', '😀'.repeat(limit / 2)] },
    { name: 'lone-surrogates', values: () => ['a\uD800b\uDC00c', 'a\uFFFDb\uFFFDc'] },
    { name: 'adjacent-surrogates', values: () => ['\uD83D\uD83D\uDE00\uDE00', '\uFFFD😀\uFFFD'] },
    { name: 'nul', values: () => ['a\u0000b', 'ab'] },
    { name: 'nul-at-limit', values: limit => ['a'.repeat(limit - 2) + '\u0000😀tail', 'a'.repeat(limit - 2) + '😀'] },
    { name: 'malformed-at-limit', values: limit => ['a'.repeat(limit - 1) + '\uD800tail', 'a'.repeat(limit - 1) + '\uFFFD'] },
    { name: 'mixed-at-limit', values: limit => ['a'.repeat(limit - 3) + '\uD800\u0000😀tail', 'a'.repeat(limit - 3) + '\uFFFD😀'] },
    { name: 'nul-in-pair', values: () => ['\uD83D\u0000\uDE00', '😀'] },
  ];
  const metadata = (id: string, list: EmailIndexedMessageList): EmailClassificationMetadataInput => ({
    messageRef: id, mailboxRef, canonicalId: `provider-${id}`, folder: 'INBOX', dateTimestamp: now,
    replyStatus: 'unknown', fingerprint: `fingerprint-${id}`, list,
  });

  // Prove this backend rejects the exact invalid JSONB representations that
  // ordinary UTF-16 slicing or malformed provider headers previously produced.
  for (const unsafe of ['a'.repeat(1_999) + '\uD83D', '\uDE00', '\u0000']) {
    await assert.rejects(postgres.query('SELECT $1::jsonb', [JSON.stringify({ subject: unsafe })]));
  }
  for (const sample of cases) {
    const list = Object.fromEntries(Object.entries(limits).map(([field, limit]) => {
      const [value] = sample.values(limit);
      return [field, field === 'to' || field === 'cc' ? [value] : value];
    })) as unknown as EmailIndexedMessageList;
    Object.assign(list, { isRead: false, isFlagged: true, hasAttachments: false });
    const expected = Object.fromEntries(Object.entries(limits).map(([field, limit]) => {
      const [, value] = sample.values(limit);
      assert(value.length <= limit && value.isWellFormed() && !value.includes('\u0000'));
      return [field, field === 'to' || field === 'cc' ? [value] : value];
    }));
    Object.assign(expected, { isRead: false, isFlagged: true, hasAttachments: false });
    const source = structuredClone(list);
    const message = metadata(`unicode-${sample.name}`, list);
    const stored = await store.upsertMessageMetadata(message, now);
    assert.deepEqual(stored.list, expected, sample.name);
    assert.deepEqual((await store.readMessages([message.messageRef]))[0].list, expected, `${sample.name}: persisted read`);
    const persisted = (await postgres.query<{ list_json: EmailIndexedMessageList }>(
      'SELECT list_json FROM email_classification_messages WHERE message_ref = $1', [message.messageRef],
    )).rows[0].list_json;
    assert.deepEqual(persisted, expected, `${sample.name}: actual JSONB`);
    assert.deepEqual(list, source, `${sample.name}: original provider metadata stays unchanged`);
    assert.equal((await store.upsertMessageMetadata(message, now + 1)).indexRevision, stored.indexRevision, `${sample.name}: refresh stays idempotent`);
  }

  const minimal = await store.upsertMessageMetadata(metadata('unicode-minimal', { from: '', subject: '', date: '', snippet: '', threadId: null }), now);
  assert.deepEqual(minimal.list, { from: '', subject: '', date: '', snippet: '', threadId: null }, 'Optional fields remain absent and null thread IDs remain null');
  const addresses = Array.from({ length: 101 }, (_, index) => `recipient-${index}@example.test`);
  const continued = await store.upsertMessageMetadata(metadata('unicode-continued', {
    from: 'sender@example.test', subject: 'Mail after malformed metadata', date: '2026-10-09', snippet: 'Scanning can continue', to: addresses, cc: addresses,
  }), now + 2);
  assert.equal(continued.list.subject, 'Mail after malformed metadata', 'Subsequent valid messages still persist');
  assert.deepEqual(continued.list.to, addresses.slice(0, 100));
  assert.deepEqual(continued.list.cc, addresses.slice(0, 100));
  assert.equal(addresses.length, 101, 'Provider address arrays stay unchanged');
}
