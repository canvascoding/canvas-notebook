import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoveredRoomReadUrls, roomReadConsoleMessage } from '../tests/helpers/recovered-room-read.mjs';
import { recoveredRichMigrationErrors } from '../tests/helpers/recovered-rich-migration.mjs';

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

const sessionUrl = 'http://127.0.0.1:3100/api/files/collaboration/session';
const migrationRequest = { requestId: '72366e52-ddc7-4cbc-bed0-19e0e49cf53c', expectedDocumentId: 'same-document',
  expectedLifecycleGeneration: 1, documentSequence: 0, stateProof: 'yjs-snapshot-sha256-v1:' + 'a'.repeat(64) };
const pendingMigration = { requestId: migrationRequest.requestId, documentId: migrationRequest.expectedDocumentId,
  lifecycleGeneration: 2, status: 'pending', phase: 'handoff', reason: 'ADMISSION_SCOPE_CHANGED' };
const sessionPending = { client: 'peer', url: sessionUrl, method: 'POST', status: 503, success: false, at: 10,
  path: 'owned.md', requestRepresentation: 'auto', requestMigration: migrationRequest,
  migration: pendingMigration, credentialFieldsPresent: false, ticketIssued: false };
const sessionReady = { ...sessionPending, status: 200, success: true, at: 1_100,
  documentId: migrationRequest.expectedDocumentId, lifecycleGeneration: 2, representation: 'tiptap_blocks',
  migration: { requestId: migrationRequest.requestId, documentId: migrationRequest.expectedDocumentId,
    lifecycleGeneration: 2, status: 'already_rich' }, credentialFieldsPresent: true, ticketIssued: true };
const sessionMessage = { client: 'peer', url: sessionUrl, message: roomReadConsoleMessage, value: 'peer automatic 503 diagnostic' };

test('a concurrent migration qualifies only after the same client completes its exact request with a ticket', () => {
  assert.deepEqual([...recoveredRichMigrationErrors([sessionPending, sessionReady], [sessionMessage])], [sessionMessage.value]);
  assert.deepEqual([...recoveredRichMigrationErrors([sessionPending, { ...sessionReady,
    migration: { ...sessionReady.migration, status: 'migrated' } }], [sessionMessage])], [sessionMessage.value]);
  assert.deepEqual([...recoveredRichMigrationErrors([{ ...sessionPending,
    migration: { ...pendingMigration, lifecycleGeneration: 1, phase: 'quiescence', reason: undefined } }, sessionReady], [sessionMessage])], [sessionMessage.value]);
});

for (const [name, responses, errors] of [
  ['no completion', [sessionPending], [sessionMessage]],
  ['only earlier completion', [sessionReady, sessionPending], [sessionMessage]],
  ['another client completes', [sessionPending, { ...sessionReady, client: 'owner' }], [sessionMessage]],
  ['another client reports the error', [sessionPending, sessionReady], [{ ...sessionMessage, client: 'owner' }]],
  ['unknown error code', [{ ...sessionPending, code: 'UNKNOWN' }, sessionReady], [sessionMessage]],
  ['unknown pending reason', [{ ...sessionPending, migration: { ...pendingMigration, reason: 'DATABASE_FAILED' } }, sessionReady], [sessionMessage]],
  ['failed checkpoint', [{ ...sessionPending, migration: { ...pendingMigration, reason: 'checkpoint_failed', phase: 'projection' } }, sessionReady], [sessionMessage]],
  ['missing request', [{ ...sessionPending, requestMigration: null }, sessionReady], [sessionMessage]],
  ['extra request field', [{ ...sessionPending, requestMigration: { ...migrationRequest, cancel: true } }, sessionReady], [sessionMessage]],
  ['invalid state proof', [{ ...sessionPending, requestMigration: { ...migrationRequest, stateProof: 'unknown' } }, sessionReady], [sessionMessage]],
  ['changed request', [sessionPending, { ...sessionReady, requestMigration: { ...migrationRequest, documentSequence: 1 } }], [sessionMessage]],
  ['changed response receipt', [sessionPending, { ...sessionReady, migration: { ...sessionReady.migration, requestId: 'different' } }], [sessionMessage]],
  ['changed document', [sessionPending, { ...sessionReady, documentId: 'different' }], [sessionMessage]],
  ['changed generation', [sessionPending, { ...sessionReady, lifecycleGeneration: 3 }], [sessionMessage]],
  ['plain-text completion', [sessionPending, { ...sessionReady, representation: 'plain_text' }], [sessionMessage]],
  ['blocked completion', [sessionPending, { ...sessionReady, migration: { ...sessionReady.migration, status: 'blocked' } }], [sessionMessage]],
  ['pending ticket', [{ ...sessionPending, credentialFieldsPresent: true }, sessionReady], [sessionMessage]],
  ['completion has no ticket', [sessionPending, { ...sessionReady, ticketIssued: false }], [sessionMessage]],
  ['late completion', [sessionPending, { ...sessionReady, at: 5_011 }], [sessionMessage]],
  ['changed path', [sessionPending, { ...sessionReady, path: 'other.md' }], [sessionMessage]],
  ['changed representation request', [sessionPending, { ...sessionReady, requestRepresentation: 'plain_text' }], [sessionMessage]],
  ['unmatched console count', [sessionPending, sessionReady], [sessionMessage, sessionMessage]],
  ['unbounded pending requests', [sessionPending, sessionPending, sessionPending, sessionReady], [sessionMessage, sessionMessage, sessionMessage]],
  ['another console error', [sessionPending, sessionReady], [{ ...sessionMessage, message: 'Unhandled JavaScript error' }]],
]) test(`retain migration diagnostic failures: ${name}`, () => {
  assert.equal(recoveredRichMigrationErrors(responses, errors).size, 0);
});

test('foreign origins, other endpoints and unmatched retry URLs cannot qualify a migration console message', () => {
  for (const other of [sessionUrl.replace('127.0.0.1:3100', 'customer.invalid'),
    sessionUrl.replace('127.0.0.1:3100', 'user:password@127.0.0.1:3100'),
    sessionUrl.replace('/session', '/checkpoint'), sessionUrl + '?other=1']) {
    assert.equal(recoveredRichMigrationErrors([{ ...sessionPending, url: other }, { ...sessionReady, url: other }],
      [{ ...sessionMessage, url: other }]).size, 0);
  }
  assert.equal(recoveredRichMigrationErrors([sessionPending, { ...sessionReady, url: sessionUrl + '?retry=1' }], [sessionMessage]).size, 0);
});
