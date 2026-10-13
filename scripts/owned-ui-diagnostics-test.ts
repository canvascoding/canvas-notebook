import assert from 'node:assert/strict';
import { BoundedUiObservations, redactDiagnosticText, summarizeDiagnosticResponse } from '../tests/helpers/owned-ui-diagnostics';

const shape = summarizeDiagnosticResponse({ success: true, token: 'never-log-this', data: {
  content: 'Private content must not be recorded', contentUnavailable: true,
  stats: { size: null, modified: '2026-10-13T16:55:38.157Z', permissions: undefined, cookie: 'private-cookie' },
  collaboration: { crdtCapable: true, strategy: 'crdt_text', document: { provider: 'yjs', token: 'private-token' } },
} });
assert.equal(shape.stats.modifiedKind, 'string');
assert.equal(shape.stats.modified, '2026-10-13T16:55:38.157Z');
assert.equal(shape.stats.sizeKind, 'null');
assert.equal(shape.stats.permissionsKind, 'undefined');
assert.equal(shape.contentUnavailable, true);
const output = JSON.stringify(shape);
for (const secret of ['never-log-this', 'Private content', 'private-cookie', 'private-token']) assert(!output.includes(secret));
assert.equal(summarizeDiagnosticResponse({ data: { stats: { modified: 1770000000 } } }).stats.modified, 1770000000);
const redacted = redactDiagnosticText('RangeError: Invalid time value\n{"token":"unknown-opaque", "cookie": "private-value"}\nBearer abc.def\nknown-secret', ['known-secret']);
for (const secret of ['unknown-opaque', 'private-value', 'abc.def', 'known-secret']) assert(!redacted.includes(secret));
assert(redacted.includes('RangeError: Invalid time value'));
const observations = new BoundedUiObservations();
for (let i = 0; i < 110; i += 1) observations.add({ type: 'console', text: 'diagnostic' });
assert.equal(observations.events.length, 96); assert.equal(observations.dropped, 14);
const oversized = new BoundedUiObservations(); oversized.add({ text: 'x'.repeat(128 * 1024) });
assert.equal(oversized.events.length, 0); assert.equal(oversized.dropped, 1);
console.log('Owned UI diagnostics passed: credential/content exclusion, timestamp shape preservation and bounded events.');
