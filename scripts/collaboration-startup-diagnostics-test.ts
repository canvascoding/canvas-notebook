import assert from 'node:assert/strict';
import { reportCollaborationStartupFailure } from '../app/lib/collaboration/startup-diagnostics';
import type { CollaborationDiagnostic } from '../app/lib/collaboration/diagnostics';

const documentId = '56ddcc84-2189-4aa1-a530-8b7dedac3317';
const privateText = 'Bearer confidential-credentials; /private/document.md; confidential-content';
const capture = (error: unknown, input = { phase: 'claim_owner' as const, documentId, generation: 1 }) => {
  const records: CollaborationDiagnostic[] = [];
  reportCollaborationStartupFailure((level, value) => {
    assert.equal(level, 'warn'); records.push(value);
  }, input, error);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.event, 'room_startup_failed');
  assert.equal(record.code, 'COLLABORATION_STARTUP_FAILED');
  assert.equal(record.documentId, documentId);
  assert.equal(record.generation, 1);
  assert.deepEqual(Object.keys(record).sort(), ['causeCode', 'code', 'documentId', 'event', 'generation', 'phase']);
  assert(!JSON.stringify(record).includes(privateText));
  return record;
};

for (const code of ['ROOM_OWNER_BUSY', 'ROOM_OWNER_LOST', 'ROOM_OWNER_SCOPE_CHANGED', 'ROOM_OWNER_UNAVAILABLE',
  'ROOM_ACTIVITY_BUSY', 'ROOM_ACTIVITY_CLOSED', 'ROOM_ACTIVITY_DRAINING', 'ADMISSION_INVALID_REQUEST',
  'ADMISSION_CONFLICT', 'ADMISSION_SCOPE_CHANGED', 'ADMISSION_REQUEST_CHANGED', 'ADMISSION_RECOVERY_REQUIRED',
  'ADMISSION_STATE_CHANGED', 'COLLABORATION_ACCESS_REVOKED']) {
  const error = Object.assign(new Error(privateText), { code, headers: privateText, path: privateText });
  assert.equal(capture(error).causeCode, code);
}
for (const code of ['40001', '40P01', '55P03', '57014', '08003', '08006', '57P01', '42P01', '42703']) {
  assert.equal(capture(Object.assign(new Error(privateText), { code, detail: privateText })).causeCode, `SQLSTATE_${code}`);
}
for (const error of [undefined, null, privateText, 1, new Error(privateText),
  Object.assign(new Error(privateText), { code: privateText }), { cause: { code: 'ROOM_OWNER_LOST' } },
  Object.create({ code: 'ROOM_OWNER_LOST' })]) assert.equal(capture(error).causeCode, 'UNCLASSIFIED');
assert.equal(capture(new Error('Collaboration document was not initialized.')).causeCode, 'DOCUMENT_UNINITIALIZED');
assert.equal(capture(new Error('Collaboration connection is closed.')).causeCode, 'CONNECTION_CLOSED');

let getterCalls = 0;
const hostile = Object.defineProperties({}, {
  code: { get() { getterCalls += 1; throw new Error(privateText); } },
  message: { get() { getterCalls += 1; throw new Error(privateText); } },
  stack: { get() { getterCalls += 1; throw new Error(privateText); } },
});
assert.equal(capture(hostile).causeCode, 'UNCLASSIFIED');
assert.equal(getterCalls, 0);
assert.equal(capture(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(privateText); } })).causeCode, 'UNCLASSIFIED');

const records: CollaborationDiagnostic[] = [];
reportCollaborationStartupFailure((_level, record) => records.push(record), {
  phase: privateText as never, documentId: privateText, generation: NaN,
}, new Error(privateText));
assert.deepEqual(records, [{ event: 'room_startup_failed', code: 'COLLABORATION_STARTUP_FAILED',
  phase: 'unknown', causeCode: 'UNCLASSIFIED' }]);
assert(!JSON.stringify(records).includes(privateText));

// A faulty sink never replaces the actual setup exception or skips its cleanup.
const original = new Error(privateText);
let cleaned = false;
let returned: unknown;
try {
  try { throw original; }
  catch (error) {
    reportCollaborationStartupFailure(() => { throw new Error('sink failed'); }, { phase: 'create_document' }, error);
    throw error;
  } finally { cleaned = true; }
} catch (error) { returned = error; }
assert.equal(returned, original);
assert.equal(cleaned, true);
assert.doesNotThrow(() => reportCollaborationStartupFailure(() => {},
  new Proxy({ phase: 'load_state' as const }, { get() { throw original; } }), original));
console.log('PASS startup diagnostics: known codes, bounded phases, credential privacy, hostile exceptions, original cleanup');
