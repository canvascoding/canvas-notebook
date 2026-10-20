import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { workspaceOperationFailureDiagnostics as diagnose, reportWorkspaceOperationFailureDiagnostics as report,
  type WorkspaceOperationFailureDiagnosticNode } from '../app/lib/files/workspace-operation-failure-diagnostics';

const secret = 'secret:/private/document.md?token=private-token SELECT private_content';
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['app/lib/files/workspace-operation-failure-diagnostics.ts', 'scripts/workspace-operation-failure-diagnostics-test.ts']
  .map(file => ({ file: path.resolve(file), hash: hash(file) }));
function flatten(node: WorkspaceOperationFailureDiagnosticNode | null): string[] {
  return node ? [node.code, ...flatten(node.cause ?? null), ...(node.errors ?? []).flatMap(flatten)] : [];
}
function depth(node: WorkspaceOperationFailureDiagnosticNode | null): number {
  return node ? Math.max(0, ...[node.cause, ...(node.errors ?? [])].filter(Boolean)
    .map(child => 1 + depth(child ?? null))) : 0;
}
test('real AggregateError and primary cause retain nested transaction timeout without private text', () => {
  const sql = Object.assign(new Error(secret), { code: '25P04', query: secret, parameters: [secret] });
  const unavailable = Object.assign(new Error(secret, { cause: sql }), { code: 'postgres_unavailable' });
  const error = new AggregateError([unavailable, { code: '55P03', path: secret }], secret,
    { cause: { code: 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED' } });
  assert.deepEqual(diagnose(error), { version: 1, truncated: false, tree: { code: 'UNCLASSIFIED',
    cause: { code: 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED' }, errors: [
      { code: 'DATABASE_UNAVAILABLE', cause: { code: 'SQLSTATE_25P04' } }, { code: 'SQLSTATE_55P03' }] } });
  assert.equal(JSON.stringify(diagnose(error)).includes(secret), false);
});
test('only the six declared SQLSTATE values are emitted', () => {
  for (const code of ['25P04', '57014', '55P03', '08003', '08006', '57P01']) {
    assert.equal(diagnose({ code }).tree?.code, `SQLSTATE_${code}`);
  }
  for (const code of ['40001', '42P01', 'SQLSTATE_25P04', 'DATABASE_UNAVAILABLE', secret, '__proto__']) {
    assert.equal(diagnose({ code }).tree?.code, 'UNCLASSIFIED');
  }
});
test('finite existing principal, owner, native, filesystem and busy codes retain distinct labels', () => {
  for (const code of ['PRINCIPAL_EXPIRED', 'PRINCIPAL_BUSY', 'JOB_LIFECYCLE_DISPOSAL_UNCONFIRMED',
    'ORIGINAL_NATIVE_DELETE_BUSY', 'NATIVE_LINK_MUTATION_BUSY', 'COLLABORATION_FILE_LIFECYCLE_BUSY',
    'ROOM_OWNER_LOST', 'FILE_MUTATION_LOCK_TIMEOUT']) assert.equal(diagnose({ code }).tree?.code, code);
  assert.equal(diagnose({ code: 'disposal-unconfirmed' }).tree?.code, 'FILESYSTEM_DISPOSAL_UNCONFIRMED');
  assert.equal(diagnose({ code: 'source-changed' }).tree?.code, 'FILESYSTEM_SOURCE_CHANGED');
  assert.equal(diagnose({ code: 'PRINCIPAL_PRIVATE_DOCUMENT_CONTENT' }).tree?.code, 'UNCLASSIFIED');
});
test('inherited code, cause and aggregate fields are never adopted', () => {
  const inherited = Object.create({ code: '25P04', cause: { code: '57014' }, errors: [{ code: '55P03' }] });
  assert.deepEqual(diagnose(inherited), { version: 1, tree: { code: 'UNCLASSIFIED' }, truncated: false });
});
test('implicit preparation retains finite admission causes without exposing payloads', () => {
  for (const code of ['IMPLICIT_MOVE_PHASE_CHANGED', 'ADMISSION_RECOVERY_REQUIRED',
    'ADMISSION_REQUEST_CHANGED', 'ADMISSION_SCOPE_CHANGED', 'ADMISSION_STATE_CHANGED', 'NATIVE_MOVE_PLAN_CHANGED',
    'NATIVE_MOVE_PLAN_INVALID', 'NATIVE_MOVE_PLAN_TOO_LARGE', 'NATIVE_SOURCE_EVIDENCE_INVALID',
    'NATIVE_SOURCE_EVIDENCE_TOO_LARGE', 'NATIVE_SOURCE_IMPORT_REQUIRED', 'NATIVE_SOURCE_EVIDENCE_CHANGED']) {
    const error = Object.assign(new Error(secret, { cause: { code, payload: secret } }),
      { code: 'IMPLICIT_MOVE_OUTCOME_UNCONFIRMED', request: secret });
    assert.deepEqual(diagnose(error), { version: 1, truncated: false,
      tree: { code: 'IMPLICIT_MOVE_OUTCOME_UNCONFIRMED', cause: { code } } });
    assert.equal(JSON.stringify(diagnose(error)).includes(secret), false);
  }
  assert.equal(diagnose({ code: 'IMPLICIT_MOVE_PRIVATE_DOCUMENT_CONTENT' }).tree?.code, 'UNCLASSIFIED');
});
test('no error getters, coercion or message/name/stack/private fields are evaluated', () => {
  let reads = 0;
  const error = {};
  for (const name of ['code', 'cause', 'errors', 'message', 'stack', 'name', 'path', 'query', 'parameters', 'toString']) {
    Object.defineProperty(error, name, { get() { reads++; throw new Error(secret); } });
  }
  assert.deepEqual(diagnose(error), { version: 1, tree: { code: 'UNCLASSIFIED' }, truncated: true });
  assert.equal(reads, 0);
  const code = { toString() { reads++; return secret; } };
  assert.equal(diagnose({ code, message: secret }).tree?.code, 'UNCLASSIFIED'); assert.equal(reads, 0);
});
test('cyclic causes and shared aggregate children terminate without duplicate expansion', () => {
  const first: { code: string; cause?: unknown; errors?: unknown[] } = { code: 'PRINCIPAL_EXPIRED' };
  const second = { code: '25P04', cause: first };
  first.cause = second; first.errors = [first, second];
  const output = diagnose(first);
  assert.deepEqual(flatten(output.tree), ['PRINCIPAL_EXPIRED', 'SQLSTATE_25P04']); assert.equal(output.truncated, true);
});
test('large aggregate lists emit at most sixteen nodes without reading later entries', () => {
  let laterReads = 0;
  const errors: unknown[] = Array.from({ length: 100 }, () => ({ code: '55P03' }));
  Object.defineProperty(errors, '15', { get() { laterReads++; throw new Error(secret); } });
  const output = diagnose({ code: 'PRINCIPAL_BUSY', errors });
  assert.equal(flatten(output.tree).length, 16); assert.equal(output.truncated, true); assert.equal(laterReads, 0);
});
test('depth is limited to four and does not inspect a deeper primary cause', () => {
  let laterReads = 0;
  let error: object = Object.defineProperty({}, 'code', { get() { laterReads++; return secret; } });
  for (let index = 0; index < 10; index++) error = { code: 'PRINCIPAL_EXPIRED', cause: error };
  const output = diagnose(error);
  assert.equal(depth(output.tree), 4); assert.equal(flatten(output.tree).length, 5);
  assert.equal(output.truncated, true); assert.equal(laterReads, 0);
});
test('aggregate data descriptors avoid index getters and iterator hooks', () => {
  let reads = 0;
  const errors: unknown[] = [{ code: '25P04' }, { code: '55P03' }];
  Object.defineProperty(errors, '0', { get() { reads++; return { code: '57014' }; } });
  Object.defineProperty(errors, Symbol.iterator, { get() { reads++; throw new Error(secret); } });
  const output = diagnose({ errors });
  assert.deepEqual(flatten(output.tree), ['UNCLASSIFIED', 'SQLSTATE_55P03']);
  assert.equal(output.truncated, true); assert.equal(reads, 0);
});
test('hostile descriptor proxies and revoked proxies never escape the diagnostic helper', () => {
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); }, get() { throw new Error(secret); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const error of [hostile, revoked.proxy, { errors: revoked.proxy }]) {
    const output = diagnose(error); assert.equal(output.truncated, true);
    assert.equal(JSON.stringify(output).includes(secret), false);
  }
});
test('output is frozen and a failing synchronous logger cannot mask the original failure', () => {
  const original = new Error(secret, { cause: { code: '25P04' } }), output = diagnose(original);
  assert.equal(Object.isFrozen(output), true); assert.equal(Object.isFrozen(output.tree), true);
  assert.equal(Object.isFrozen(output.tree!.cause), true);
  assert.doesNotThrow(() => report(original, () => { throw new Error(secret); }));
  try { report(original, () => { throw new Error(secret); }); throw original; }
  catch (error) { assert.equal(error, original); }
  let recorded: unknown;
  report(original, diagnostic => { recorded = diagnostic; }); assert.deepEqual(recorded, output);
});
test('primitive rejections retain only a static unclassified label', () => {
  for (const error of [undefined, null, false, 42, secret, Symbol(secret), () => secret]) {
    assert.deepEqual(diagnose(error), { version: 1, tree: { code: 'UNCLASSIFIED' }, truncated: false });
  }
});
let completed = false;
const watchdog = setTimeout(() => { console.error('workspace operation failure diagnostics incomplete'); process.exitCode = 1; }, 15_000);
process.on('beforeExit', () => { if (!completed) process.exitCode = 1; });
after(() => {
  clearTimeout(watchdog);
  for (const source of sources) assert.equal(hash(source.file), source.hash);
  completed = true;
  console.log('workspace-operation-failure-diagnostics-test: COMPLETED: assertions and source pins settled');
});
