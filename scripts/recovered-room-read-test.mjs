import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoveredRoomReadUrls, roomReadConsoleMessage } from '../tests/helpers/recovered-room-read.mjs';

const url = 'http://127.0.0.1:3000/api/files/read?path=owned.md&meta=1&t=1';
const busy = { url, status: 503, code: 'ROOM_OWNER_BUSY', at: 10 };
const ready = { url, status: 200, documentId: 'same-document', at: 100 };
const message = { url, message: roomReadConsoleMessage };

test('an exact metadata read qualifies only after actual same-identity recovery', () => {
  assert.deepEqual([...recoveredRoomReadUrls([busy, ready], [message])], [url]);
  assert.deepEqual([...recoveredRoomReadUrls([{ ...ready, at: 0 }, busy, ready], [message])], [url]);
});

for (const [name, responses, errors] of [
  ['no recovery', [busy], [message]],
  ['only earlier success', [ready, busy], [message]],
  ['unknown code', [{ ...busy, code: 'UNKNOWN' }, ready], [message]],
  ['identity changed', [{ ...ready, documentId: 'different' }, busy, ready], [message]],
  ['unstructured success', [busy, { url, status: 200 }], [message]],
  ['late recovery', [busy, { ...ready, at: 15_000 }], [message]],
  ['other console error', [busy, ready], [{ url, message: 'Unhandled JavaScript error' }]],
  ['unmatched error count', [busy, ready], [message, message]],
  ['unbounded contention', [busy, busy, busy, ready], [message, message, message]],
]) test(`retain diagnostic failures: ${name}`, () => {
  assert.equal(recoveredRoomReadUrls(responses, errors).size, 0);
});

test('a different path, origin, or retry URL cannot qualify the failed request', () => {
  for (const other of [url.replace('meta=1', 'meta=0'), url.replace('/files/read', '/files/delete'),
    url.replace('127.0.0.1:3000', 'customer.invalid'), url.replace('127.0.0.1:3000', 'user:password@127.0.0.1:3000')]) {
    assert.equal(recoveredRoomReadUrls([{ ...busy, url: other }, { ...ready, url: other }], [{ ...message, url: other }]).size, 0);
  }
  assert.equal(recoveredRoomReadUrls([busy, { ...ready, url: url + '2' }], [message]).size, 0);
});
