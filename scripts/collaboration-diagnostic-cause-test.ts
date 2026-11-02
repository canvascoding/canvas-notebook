import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { captureCollaborationDiagnosticCause as capture } from '../app/lib/collaboration/diagnostic-cause';

const message = 'Internal failure; never publish this text or a document path.';
const fingerprint = createHash('sha256').update(message).digest('hex').slice(0, 16);
let cases = 0;
function check(name: string, run: () => void) {
  try { run(); cases++; } catch (error) { throw new Error(`Diagnostic cause case failed: ${name}`, { cause: error }); }
}

check('native error fingerprints without text', () => {
  const result = capture(new Error(message));
  assert.deepEqual(result, { code: 'NATIVE_ERROR', fingerprint });
  assert(Object.isFrozen(result)); assert(!JSON.stringify(result).includes(message));
});
check('registered-shaped native transport codes remain data', () => {
  assert.deepEqual(capture({ code: 'NATIVE_TRANSPORT_SCOPE_CHANGED', message }), { code: 'NATIVE_TRANSPORT_SCOPE_CHANGED' });
});
check('PostgreSQL SQLSTATE is observable', () => { assert.deepEqual(capture({ code: '55P03' }), { code: '55P03' }); });
check('credential-shaped codes and paths are omitted', () => {
  for (const code of ['cnk_00000000-0000-4000-8000-000000000000.private-key', 'eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOiJ4In0.signature', '/data/private.md', 'secret-provider-value']) {
    assert.deepEqual(capture({ code, message }), { code: 'UNCLASSIFIED' });
  }
});
check('inherited codes do not become observations', () => {
  assert.deepEqual(capture(Object.create({ code: 'PRINCIPAL_ACCESS_DENIED' })), { code: 'UNCLASSIFIED' });
});
check('code and message accessors are not invoked', () => {
  let calls = 0; const error = new Error(message);
  Object.defineProperties(error, { code: { get() { calls++; throw new Error('getter'); } }, message: { get() { calls++; throw new Error('getter'); } } });
  assert.deepEqual(capture(error), { code: 'NATIVE_ERROR' }); assert.equal(calls, 0);
});
check('stack and name accessors are not invoked', () => {
  let calls = 0; const error = new Error(message);
  Object.defineProperties(error, { stack: { get() { calls++; throw new Error('stack'); } }, name: { get() { calls++; throw new Error('name'); } } });
  assert.deepEqual(capture(error), { code: 'NATIVE_ERROR', fingerprint }); assert.equal(calls, 0);
});
check('transparent proxies do not run traps', () => {
  let calls = 0;
  const error = new Proxy(new Error(message), { get() { calls++; throw new Error('get'); }, getOwnPropertyDescriptor() { calls++; throw new Error('descriptor'); } });
  assert.deepEqual(capture(error), { code: 'UNCLASSIFIED' }); assert.equal(calls, 0);
});
check('revoked proxies remain safe', () => {
  const proxy = Proxy.revocable({}, {}); proxy.revoke(); assert.deepEqual(capture(proxy.proxy), { code: 'UNCLASSIFIED' });
});
check('large messages and codes are bounded', () => {
  assert.deepEqual(capture(new Error('x'.repeat(4097))), { code: 'NATIVE_ERROR' });
  assert.deepEqual(capture({ code: 'NATIVE_' + 'X'.repeat(101) }), { code: 'UNCLASSIFIED' });
});
check('foreign-realm native errors are recognized', () => {
  const error: unknown = runInNewContext('new Error(' + JSON.stringify(message) + ')');
  assert.deepEqual(capture(error), { code: 'NATIVE_ERROR', fingerprint });
});
check('primitive throws and nested causes stay opaque', () => {
  for (const error of [null, undefined, 1, message, { cause: { code: 'PRINCIPAL_BUSY' } }]) assert.deepEqual(capture(error), { code: 'UNCLASSIFIED' });
});
console.log(`Collaboration diagnostic cause passed ${cases} data-only cases; no app requests, permissions or raw exception data.`);
