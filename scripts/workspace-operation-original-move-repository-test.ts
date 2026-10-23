import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SqlConnection } from '../app/lib/db';
import * as repo from '../app/lib/files/workspace-operation-original-move-repository';

// Declared borrowed-connection replies test input/response mechanics only.
// The separate PG18 suite proves actual DDL, locks, byte gates and COMMIT recovery.
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const batchId = 'move-pure-fixture-0001', intentText = '{"original":true}', intentDigest = hash(intentText);
const selected = { schema: 'owned_fixture', batchId, intentDigest };
const intent = { schema: selected.schema, batchId, planId: hash('plan'), workspaceId: 'owned-workspace', requestHash: hash('request'), intentText };
const parent = { ...selected, parentPath: 'new/shared', producerStep: 'step-0', consumerBindingsText: '[{"stepKey":"step-1","kind":"projection_absent"}]', receiptText: '{"parent":true}' };
const pathInput = { ...selected, stepKey: 'step-0', receiptText: '{"moved":true}' };
const final = { ...selected, receiptText: '{"complete":"domain-codec-required"}' };
const intentRow = () => ({ batchId, planId: intent.planId, workspaceId: intent.workspaceId, requestHash: intent.requestHash, intentText, intentDigest, createdAt: '100' });
const parentRow = () => ({ batchId, intentDigest, parentKey: hash(parent.parentPath), parentPath: parent.parentPath, producerStep: parent.producerStep,
  consumerBindingsText: parent.consumerBindingsText, consumerBindingsDigest: hash(parent.consumerBindingsText), receiptText: parent.receiptText,
  receiptDigest: hash(parent.receiptText), createdAt: '101' });
const pathRow = () => ({ batchId, intentDigest, stepKey: pathInput.stepKey, receiptText: pathInput.receiptText, receiptDigest: hash(pathInput.receiptText), createdAt: '102' });
const code = (value: unknown) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'code')?.value : undefined;
type Call = { sql: string; values?: unknown[] };
function fixture(get?: (call: Call, index: number) => unknown | Promise<unknown>, all?: (call: Call) => unknown[] | Promise<unknown[]>) {
  const calls: Call[] = [];
  const database: SqlConnection = {
    get: (sql, values) => { const call = { sql, values }; calls.push(call); return get?.(call, calls.length - 1); },
    all: (sql, values) => { const call = { sql, values }; calls.push(call); return all?.(call) ?? []; },
    run: () => { throw new Error('Repository must not run transaction/DDL SQL.'); },
    close: () => { throw new Error('Repository must not close the borrowed connection.'); },
  };
  return { database, calls };
}
const invalid = (error: unknown) => code(error) === 'ORIGINAL_MOVE_REPOSITORY_INVALID';

test('every insert rejects unknown/getter/prototype input before its first borrowed call', async () => {
  const writers = [
    { operation: repo.insertWorkspaceOperationOriginalMoveIntentOnConnection, value: intent },
    { operation: repo.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection, value: parent },
    { operation: repo.insertWorkspaceOperationOriginalMovePathReceiptOnConnection, value: pathInput },
    { operation: repo.insertWorkspaceOperationOriginalMoveReceiptOnConnection, value: final },
  ];
  for (const { operation, value } of writers) {
    const f = fixture(); let getters = 0;
    const invoke = (input: unknown) => operation(f.database, input as never);
    await assert.rejects(invoke({ ...value, extra: true }), invalid);
    await assert.rejects(invoke(Object.assign(Object.create({ inherited: true }), value)), invalid);
    await assert.rejects(invoke(Object.assign(Object.create(null), value)), invalid);
    await assert.rejects(invoke({ ...value, batchId: undefined }), invalid);
    const accessor = { ...value }; Object.defineProperty(accessor, 'schema', { enumerable: true, get() { getters++; return selected.schema; } });
    await assert.rejects(invoke(accessor), invalid); assert.equal(getters, 0); assert.equal(f.calls.length, 0);
  }
});

test('identifiers, Unicode, text and hashes remain strict primitives without coercion', async () => {
  const f = fixture(); let coerced = 0;
  const fake = { toString() { coerced++; return 'owned_fixture'; } };
  for (const patch of [{ schema: fake }, { schema: 'x'.repeat(64) }, { schema: 'bad\nname' }, { batchId: 'short' },
    { batchId: ' '.repeat(16) }, { batchId: 'move-\ud800-fixture-0001' }, { planId: intent.planId + '\n' },
    { planId: intent.planId.toUpperCase() }, { requestHash: 123 }, { intentText: '' }, { intentText: '\0' },
    { intentText: '\ud800' }, { intentText: new String('{}') }]) {
    await assert.rejects(repo.insertWorkspaceOperationOriginalMoveIntentOnConnection(f.database, { ...intent, ...patch } as never), invalid);
  }
  assert.equal(coerced, 0); assert.equal(f.calls.length, 0);
});

test('canonical literal parent paths enforce UTF8 component, depth and total bounds before IO', async () => {
  const f = fixture();
  for (const parentPath of ['../file', '/file', 'file/', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\nb', '\ud800',
    '😀'.repeat(64), 'a'.repeat(256), Array(34).fill('a').join('/'), Array(18).fill('a'.repeat(255)).join('/')]) {
    await assert.rejects(repo.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(f.database, { ...parent, parentPath }), invalid);
  }
  assert.equal(f.calls.length, 0);
  const allowed = fixture(() => undefined);
  assert.equal(await repo.readWorkspaceOperationOriginalMoveParentReceiptOnConnection(allowed.database,
    { ...selected, parentPath: 'ü'.repeat(127) + 'a' }), null);
  assert.equal(allowed.calls.length, 1);
});

test('consumer JSON stays opaque but bounded, explicit and array-shaped', async () => {
  const f = fixture();
  for (const consumerBindingsText of ['{}', 'null', '[]', '[', '[' + Array(1001).fill('{}').join(',') + ']', 'x'.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(repo.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(f.database, { ...parent, consumerBindingsText }), invalid);
  }
  await assert.rejects(repo.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(f.database,
    { ...parent, receiptText: 'x'.repeat(1024 * 1024) }), invalid);
  assert.equal(f.calls.length, 0);
  const permissiveDomain = fixture(() => undefined);
  assert.equal((await repo.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(permissiveDomain.database,
    { ...parent, consumerBindingsText: '[{"kind":"projection_absent","laterDomainFields":{"parentReference":"step-0"}}]' })).kind, 'conflict');
  assert.equal(permissiveDomain.calls.length, 1); // Missing original, never a fabricated authorization.
});

test('read lock options and list limits reject invalid input before any SQL', async () => {
  const f = fixture();
  for (const patch of [{ forShare: false }, { forUpdate: false }, { forShare: true, forUpdate: true }, { forShare: undefined }]) {
    await assert.rejects(repo.readWorkspaceOperationOriginalMoveReceiptOnConnection(f.database, { ...selected, ...patch } as never), invalid);
  }
  for (const patch of [{ maxRows: 0 }, { maxRows: 1001 }, { maxRows: 1.5 }, { maxRows: NaN }, { maxTotalBytes: 0 },
    { maxTotalBytes: 64 * 1024 * 1024 + 1 }, { maxTotalBytes: -0 }, { maxRows: undefined }]) {
    await assert.rejects(repo.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(f.database, { ...selected, ...patch }), invalid);
  }
  assert.equal(f.calls.length, 0);
});

test('all intent scalar data is captured before the first await', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const row = intentRow(), f = fixture(async (_call, index) => { if (index === 0) { await gate; return { batch_id: batchId }; } return { ...row }; });
  const supplied = { ...intent };
  const pending = repo.insertWorkspaceOperationOriginalMoveIntentOnConnection(f.database, supplied);
  supplied.schema = 'different'; supplied.batchId = 'different-batch-000001'; supplied.intentText = 'different'; supplied.planId = hash('different');
  release(); const result = await pending;
  assert.equal(result.kind, 'created');
  assert.equal(result.row.intentText, intentText); assert(Object.isFrozen(result) && Object.isFrozen(result.row));
  assert.deepEqual(f.calls[1].values, [batchId, intent.planId, intent.workspaceId, intent.requestHash, intentText, intentDigest]);
  assert(f.calls.every(call => call.sql.includes('"owned_fixture"')));
});

test('parent producer, consumer references and literal path are captured before header await', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const row = parentRow(), f = fixture(async (call, index) => {
    if (index === 0) { await gate; return { intentDigest }; }
    return call.sql.startsWith('SELECT intent_digest') ? { intentDigest } : { ...row };
  });
  const supplied = { ...parent }, pending = repo.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(f.database, supplied);
  supplied.parentPath = 'replacement'; supplied.producerStep = 'replacement'; supplied.consumerBindingsText = '[{"replacement":true}]'; supplied.receiptText = 'replacement';
  release(); const result = await pending; assert.equal(result.kind, 'created');
  assert.deepEqual(f.calls[1].values, [batchId, intentDigest, parent.receiptText, hash(parent.receiptText), hash(parent.parentPath),
    parent.parentPath, parent.producerStep, parent.consumerBindingsText, hash(parent.consumerBindingsText)]);
});

test('list overflow rejects metadata before inspecting any payload property', async () => {
  let payloadReads = 0;
  const row = { _rowCount: 2, _byteCount: '200' };
  Object.defineProperty(row, 'receiptText', { enumerable: true, get() { payloadReads++; throw new Error('Unbounded payload must remain unread'); } });
  const f = fixture(() => ({ intentDigest }), () => [row]);
  await assert.rejects(repo.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(f.database, { ...selected, maxRows: 1 }),
    error => code(error) === 'ORIGINAL_MOVE_REPOSITORY_LIMIT');
  await assert.rejects(repo.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(f.database, { ...selected, maxTotalBytes: 199 }),
    error => code(error) === 'ORIGINAL_MOVE_REPOSITORY_LIMIT');
  assert.equal(payloadReads, 0);
});

test('bounded list responses bind original, aggregate bytes, order and exact receipt hashes', async () => {
  const base = pathRow(), length = Buffer.byteLength(base.receiptText);
  const valid = { ...base, _rowCount: 1, _byteCount: String(length) };
  const f = fixture(() => ({ intentDigest }), () => [{ ...valid }]);
  assert.equal((await repo.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(f.database, selected))?.length, 1);
  for (const patch of [{ batchId: 'other-batch-00000001' }, { intentDigest: hash('other') }, { receiptDigest: hash('other') }, { _byteCount: String(length + 1) }]) {
    const changed = fixture(() => ({ intentDigest }), () => [{ ...valid, ...patch }]);
    await assert.rejects(repo.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(changed.database, selected));
  }
  const duplicate = fixture(() => ({ intentDigest }), () => [{ ...valid, _rowCount: 2, _byteCount: length * 2 }, { ...valid, _rowCount: 2, _byteCount: length * 2 }]);
  await assert.rejects(repo.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(duplicate.database, selected));
});

test('parent response cannot substitute a different literal path, producer or consumer bytes', async () => {
  const alternate = 'new/different', changed = parentRow();
  changed.parentPath = alternate; changed.parentKey = hash(alternate);
  const f = fixture(call => call.sql.startsWith('SELECT intent_digest') ? { intentDigest } : changed);
  await assert.rejects(repo.readWorkspaceOperationOriginalMoveParentReceiptOnConnection(f.database, { ...selected, parentPath: parent.parentPath }),
    error => code(error) === 'ORIGINAL_MOVE_REPOSITORY_CHANGED');
  const corrupted = { ...parentRow(), consumerBindingsDigest: hash('other') };
  const c = fixture(call => call.sql.startsWith('SELECT intent_digest') ? { intentDigest } : corrupted);
  await assert.rejects(repo.readWorkspaceOperationOriginalMoveParentReceiptOnConnection(c.database, { ...selected, parentPath: parent.parentPath }));
});

test('changed original header stops child work after its first read and grants no fallback', async () => {
  const f = fixture(() => ({ intentDigest: hash('different original') }));
  assert.equal((await repo.insertWorkspaceOperationOriginalMoveReceiptOnConnection(f.database, final)).kind, 'conflict');
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].sql, /FOR UPDATE NOWAIT/u);
  assert.equal(await repo.readWorkspaceOperationOriginalMoveReceiptOnConnection(f.database, selected), null);
  assert.equal(f.calls.length, 2);
});

test('Unicode step keys use PostgreSQL C UTF-8 byte ordering and reject its reverse', async () => {
  const expected = ['\uE000', '\u{10000}'], base = pathRow();
  const rows = expected.map(stepKey => ({ ...base, stepKey, _rowCount: 2, _byteCount: 2 * Buffer.byteLength(base.receiptText) }));
  const ordered = fixture(() => ({ intentDigest }), () => rows);
  assert.deepEqual((await repo.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(ordered.database, selected))?.map(row => row.stepKey), expected);
  const reversed = fixture(() => ({ intentDigest }), () => [...rows].reverse());
  await assert.rejects(repo.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(reversed.database, selected),
    error => code(error) === 'ORIGINAL_MOVE_REPOSITORY_CHANGED');
});
