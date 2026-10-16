import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import io from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { withPreparedWorkspacePathCopy as prepare, readPreparedWorkspacePathCopy as read,
  withRecoveredWorkspacePathCopy as recover, publishPreparedWorkspacePathCopy as publish,
  assertPreparedWorkspacePathCopyReceiptCurrent as receiptCurrent,
  assertPreparedWorkspacePathCopyParentReceipt as parentCurrent,
  bindPreparedWorkspacePathCopySharedParent as bind, preparedWorkspacePathCopyProof,
  PreparedWorkspacePathCopyError, type PreparedWorkspacePathCopyOriginal as Original,
  type PreparedWorkspacePathCopyReceipt as Receipt, type PreparedWorkspacePathCopyParentReceipt as Birth,
  type PreparedWorkspacePathCopySharedParent as Shared } from '../app/lib/filesystem/prepared-workspace-path-copy';
const clone = <T>(value: T): T => structuredClone(value);
const code = (...codes: string[]) => (error: unknown) => error instanceof PreparedWorkspacePathCopyError && codes.includes(error.code);
function workspace(rootPath: string, suffix: string): WorkspaceContext {
  return { workspaceId: `shared-${suffix}`, workspaceType: 'personal', rootPath, rootRelativePath: `users/shared/${suffix}`,
    organizationId: null, ownerUserId: 'shared-user', legacy: false,
    permissions: { canRead: false, canWrite: false, canDelete: false, canRunAgent: false, canManageWorkspace: false, canCreatePublicLinks: false } };
}
function snapshot(filename: string): unknown {
  const info = io.lstatSync(filename, { bigint: true });
  return { device: info.dev.toString(), inode: info.ino.toString(), mode: info.mode.toString(), size: info.size.toString(),
    ...(info.isDirectory() ? { children: io.readdirSync(filename).sort().map(name => [name, snapshot(path.join(filename, name))]) }
      : { hash: createHash('sha256').update(io.readFileSync(filename)).digest('hex') }) };
}
async function fixture(run: (f: { base: string; source: WorkspaceContext; destination: WorkspaceContext; originals: Original[];
  target(p: string): string; shared(producer: number, receipt: Receipt, birth: Birth): Shared }) => Promise<void>, logical = false): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-copy-shared-'))); await fs.chmod(base, 0o700);
  try {
    const from = path.join(base, 'from'), to = path.join(base, 'to'); await fs.mkdir(from, { mode: 0o700 }); await fs.mkdir(to, { mode: 0o700 });
    const source = workspace(from, randomUUID()), destination = workspace(to, randomUUID());
    for (const name of ['a', 'b', 'c']) if (!logical || name !== 'c') await fs.writeFile(path.join(from, name + '.bin'), name, { mode: 0o600 });
    const originals: Original[] = [];
    for (const [index, name] of ['a', 'b', 'c'].entries()) {
      const destinationPath = index === 0 ? 'new/a.bin' : `new/sub/${name}.bin`;
      await prepare({ sourceWorkspace: source, destinationWorkspace: destination, sourcePath: name + '.bin', destinationPath,
        sourceKind: logical && name === 'c' ? 'projection_absent' : 'regular_file' }, async cap => { originals.push(read(cap)); });
    }
    await run({ base, source, destination, originals, target: p => path.join(to, p),
      shared: (producer, producerReceipt, parentReceipt) => ({ producerOriginal: originals[producer], producerReceipt, parentReceipt }) });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
async function commit(f: Parameters<Parameters<typeof fixture>[0]>[0], index: number, sharedParents: Shared[] = []) {
  let result!: Receipt; const births: Birth[] = [];
  await recover({ sourceWorkspace: f.source, destinationWorkspace: f.destination, original: f.originals[index], sharedParents }, async cap => {
    result = await publish(cap, async birth => { parentCurrent(cap, birth); births.push(birth); }); await receiptCurrent(cap, result);
  });
  return { receipt: result, births };
}

test('sequential original selections share the exact durable producer birth and keep only their own births in receipts', async () => fixture(async f => {
  const source = snapshot(f.source.rootPath), a = await commit(f, 0), sharedA = f.shared(0, a.receipt, a.births[0]);
  const b = await commit(f, 1, [sharedA]); assert.deepEqual(b.births.map(row => row.relativePath), ['new/sub']);
  assert.deepEqual(b.receipt.createdParents, b.births); assert.equal(b.births[0].originalProof, preparedWorkspacePathCopyProof(f.originals[1]));
  const c = await commit(f, 2, [sharedA, f.shared(1, b.receipt, b.births[0])]); assert.deepEqual(c.receipt.createdParents, []);
  assert.deepEqual(snapshot(f.source.rootPath), source);
  for (const name of ['a', 'b', 'c']) assert.equal(await fs.readFile(f.target(name === 'a' ? 'new/a.bin' : `new/sub/${name}.bin`), 'utf8'), name);
  assert.equal(io.statSync(f.target('new')).ino.toString(), a.births[0].identity.inode);
  assert.equal(io.statSync(f.target('new/sub')).ino.toString(), b.births[0].identity.inode);
}));

test('same-name foreign parent D2 is preserved together with every original consumer stage', async () => fixture(async f => {
  const a = await commit(f, 0), shared = f.shared(0, a.receipt, a.births[0]);
  await fs.rename(f.target('new'), f.target('original-new')); await fs.mkdir(f.target('new'), { mode: 0o755 });
  await fs.writeFile(f.target('new/D2'), 'foreign', { mode: 0o600 }); const before = snapshot(f.destination.rootPath);
  await assert.rejects(commit(f, 1, [shared]), code('recovery-conflict'));
  assert.deepEqual(snapshot(f.destination.rootPath), before); assert.equal(await fs.readFile(f.target('new/D2'), 'utf8'), 'foreign');
}));

test('a real parent without a durable producer publication/birth binding cannot be inherited', async () => fixture(async f => {
  const a = await commit(f, 0), shared = f.shared(0, a.receipt, a.births[0]);
  const invalid: Shared[][] = [[], [{ ...shared, parentReceipt: { ...shared.parentReceipt, originalProof: 'f'.repeat(64) } }],
    [{ ...shared, producerOriginal: f.originals[1] }],
    [{ ...shared, producerReceipt: { ...shared.producerReceipt, createdParents: [] } }],
    [{ ...shared, producerReceipt: { ...shared.producerReceipt, observation: { kind: 'projection_absent' } } }],
    [{ ...shared, producerOriginal: { ...shared.producerOriginal, destinationWorkspace: { ...shared.producerOriginal.destinationWorkspace, ownerUserId: 'foreign' } } }]];
  for (const values of invalid) {
    const before = snapshot(f.destination.rootPath);
    await assert.rejects(commit(f, 1, values), code('invalid-input', 'recovery-conflict'));
    assert.deepEqual(snapshot(f.destination.rootPath), before);
  }
}));

test('gaps, duplicate births and differently cased paths do not authorize a missing parent prefix', async () => fixture(async f => {
  const a = await commit(f, 0), sharedA = f.shared(0, a.receipt, a.births[0]), b = await commit(f, 1, [sharedA]);
  const sharedB = f.shared(1, b.receipt, b.births[0]);
  for (const values of [[sharedB], [sharedA, sharedA], [sharedA, { ...sharedB, parentReceipt: { ...sharedB.parentReceipt, relativePath: 'new/SUB' } }]]) {
    const before = snapshot(f.destination.rootPath); await assert.rejects(commit(f, 2, values), code('invalid-input')); assert.deepEqual(snapshot(f.destination.rootPath), before);
  }
}));

test('consumer parent ACK loss recovers exact own births after the inherited prefix and never journals producer births as its own', async () => fixture(async f => {
  const a = await commit(f, 0), shared = f.shared(0, a.receipt, a.births[0]), persisted: Birth[] = [];
  await assert.rejects(recover({ sourceWorkspace: f.source, destinationWorkspace: f.destination, original: f.originals[1], sharedParents: [shared] }, async cap => {
    await publish(cap, async birth => { parentCurrent(cap, birth); persisted.push(birth); throw new Error('Actual durable parent journal ACK lost'); });
  }), code('parent-create-unconfirmed'));
  assert.deepEqual(persisted.map(row => row.relativePath), ['new/sub']);
  await assert.rejects(commit(f, 1, [shared]), code('recovery-conflict'));
  let receipt!: Receipt;
  await recover({ sourceWorkspace: f.source, destinationWorkspace: f.destination, original: f.originals[1], sharedParents: [shared], createdParents: persisted }, async cap => {
    receipt = await publish(cap); await receiptCurrent(cap, receipt);
  });
  assert.deepEqual(receipt.createdParents, persisted); assert.equal(await fs.readFile(f.target('new/sub/b.bin'), 'utf8'), 'b');
}));

test('projection absence may bind complete producer births while creating no physical file, parents or stage of its own', async () => fixture(async f => {
  const a = await commit(f, 0), sharedA = f.shared(0, a.receipt, a.births[0]), b = await commit(f, 1, [sharedA]);
  const before = snapshot(f.destination.rootPath), c = await commit(f, 2, [sharedA, f.shared(1, b.receipt, b.births[0])]);
  assert.equal(c.receipt.observation.kind, 'projection_absent'); assert.deepEqual(c.receipt.createdParents, []); assert.deepEqual(snapshot(f.destination.rootPath), before);
  await assert.rejects(fs.stat(f.target('new/sub/c.bin')), { code: 'ENOENT' });
}, true));

test('changed inherited parent mode or scope is never accepted from historically valid producer data', async () => {
  for (const change of ['mode', 'root'] as const) await fixture(async f => {
    const a = await commit(f, 0), shared = f.shared(0, a.receipt, a.births[0]);
    if (change === 'mode') await fs.chmod(f.target('new'), (io.statSync(f.target('new')).mode & 0o777) === 0o700 ? 0o755 : 0o700);
    else { await fs.rename(f.destination.rootPath, path.join(f.base, 'old-target')); await fs.mkdir(f.destination.rootPath, { mode: 0o700 }); }
    const before = snapshot(f.destination.rootPath); await assert.rejects(commit(f, 1, [shared]), code('recovery-conflict')); assert.deepEqual(snapshot(f.destination.rootPath), before);
  });
});

test('retained/forged live binder cannot mint a lifetime or a journal grant', async () => fixture(async f => {
  const a = await commit(f, 0), shared = f.shared(0, a.receipt, a.births[0]);
  await assert.rejects(bind({} as Parameters<typeof bind>[0], shared), code('invalid-lifetime'));
}));

// Live binding needs a parent born from a different operation context after
// this cap was prepared. Root's normal fixed owner uses sequential recovery.
test('live binder captures complete original producer data before first current-byte await', async t => fixture(async f => {
  // All originals were prepared before the producer. Hold producer publication
  // outside the consumer ALS context, then recover consumer while parent absent.
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
  const ready = gate(), publishNow = gate(); let a!: Awaited<ReturnType<typeof commit>>;
  const producer = (async () => { ready.resolve(); await publishNow.promise; a = await commit(f, 0); })();
  await ready.promise;
  await recover({ sourceWorkspace: f.source, destinationWorkspace: f.destination, original: f.originals[1] }, async cap => {
    publishNow.resolve(); await producer;
    const shared = clone(f.shared(0, a.receipt, a.births[0]));
    const realRead = io.read.bind(io); let changed = false;
    type Reader = { read(fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: (error: NodeJS.ErrnoException | null, bytes: number, buffer: Buffer) => void): void };
    t.mock.method(io as unknown as Reader, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: Parameters<Reader['read']>[5]) => {
      realRead(fd, buffer, offset, length, position, (error, bytes, result) => {
        if (!changed) { changed = true; (shared.parentReceipt as { originalProof: string }).originalProof = 'e'.repeat(64); } callback(error, bytes, result);
      });
    });
    await bind(cap, shared); assert(changed);
    const receipt = await publish(cap, async birth => parentCurrent(cap, birth)); await receiptCurrent(cap, receipt);
  });
  assert.equal(await fs.readFile(f.target('new/sub/b.bin'), 'utf8'), 'b');
}));
