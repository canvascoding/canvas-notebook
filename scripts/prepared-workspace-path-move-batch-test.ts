import assert from 'node:assert/strict';
import io from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { withPreparedWorkspacePathMove as prepare, readPreparedWorkspacePathMove as read,
  withRecoveredWorkspacePathMoves as batch, movePreparedWorkspacePath as move,
  assertPreparedWorkspacePathMoveCurrent as current, assertPreparedWorkspacePathMoveReceiptCurrent as strict,
  assertPreparedWorkspacePathMoveParentReceipt as birth, bindPreparedWorkspacePathMoveSharedParent as share,
  PreparedWorkspacePathMoveError, type PreparedWorkspacePathMoveOriginal as Original,
  type PreparedWorkspacePathMoveParentReceipt as Parent,
} from '../app/lib/filesystem/prepared-workspace-path-move';

const error = (...codes: PreparedWorkspacePathMoveError['code'][]) => (failure: unknown) => {
  assert(failure instanceof PreparedWorkspacePathMoveError);
  assert(codes.includes(failure.code), `Unexpected prepared failure: ${failure.code}`); return true;
};
async function fixture(operation: (workspace: WorkspaceContext) => Promise<void>) {
  const rootPath = await fs.mkdtemp(path.join(tmpdir(), 'canvas-prepared-move-batch-'));
  await fs.chmod(rootPath, 0o700);
  const initial = await fs.lstat(rootPath), nodes = new Set<string>();
  const workspace: WorkspaceContext = { workspaceId: path.basename(rootPath), workspaceType: 'personal', organizationId: null,
    rootPath, legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true,
      canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true } };
  const remember = (filename: string) => {
    const info = io.lstatSync(filename); nodes.add(`${info.dev}:${info.ino}`);
    if (info.isDirectory() && !info.isSymbolicLink()) for (const name of io.readdirSync(filename)) remember(path.join(filename, name));
  };
  try { await operation(workspace); }
  finally {
    remember(rootPath);
    const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
    for (const name of io.readdirSync(directory)) if (/^\d+$/u.test(name)) {
      let info; try { info = io.fstatSync(Number(name)); } catch { continue; }
      assert.equal(nodes.has(`${info.dev}:${info.ino}`), false, 'Every fixture FD must close before private cleanup.');
    }
    const currentRoot = await fs.lstat(rootPath); assert.equal(currentRoot.dev, initial.dev); assert.equal(currentRoot.ino, initial.ino);
    await fs.rm(rootPath, { recursive: true });
  }
}
async function original(workspace: WorkspaceContext, sourcePath: string, destinationPath: string, absent = false): Promise<Original> {
  return prepare({ workspace, sourcePath, destinationPath, sourceKind: absent ? 'projection_absent' : 'regular_file' }, async cap => read(cap));
}
async function two(workspace: WorkspaceContext, shared = false, absent = false) {
  await fs.writeFile(path.join(workspace.rootPath, 'a.md'), 'A', { mode: 0o600 });
  if (!absent) await fs.writeFile(path.join(workspace.rootPath, 'b.md'), 'B', { mode: 0o600 });
  return [{ stepKey: 'a', original: await original(workspace, 'a.md', shared ? 'new/a.md' : 'moved-a.md') },
    { stepKey: 'b', original: await original(workspace, 'b.md', shared ? 'new/b.md' : 'moved-b.md', absent) }];
}

test('strict receipt getter accepts only exact actual receipt and active callback lifetime', () => fixture(async workspace => {
  await fs.writeFile(path.join(workspace.rootPath, 'a.md'), 'A', { mode: 0o600 });
  let retained!: () => Promise<void>;
  await prepare({ workspace, sourcePath: 'a.md', destinationPath: 'moved.md', sourceKind: 'regular_file' }, async cap => {
    const receipt = await move(cap); await strict(cap, receipt); retained = () => strict(cap, receipt);
  });
  await assert.rejects(retained(), error('invalid-lifetime'));
}));

test('copied receipt never becomes the actual receipt even when all JSON bytes match', () => fixture(async workspace => {
  await fs.writeFile(path.join(workspace.rootPath, 'a.md'), 'A', { mode: 0o600 });
  await assert.rejects(prepare({ workspace, sourcePath: 'a.md', destinationPath: 'moved.md', sourceKind: 'regular_file' }, async cap => {
    const receipt = await move(cap); await strict(cap, structuredClone(receipt));
  }), error('recovery-conflict'));
  assert.equal(await fs.readFile(path.join(workspace.rootPath, 'moved.md'), 'utf8'), 'A');
}));

test('ordinary recovery preserves D2 but stricter collector receipt rejects its exact old leaf', () => fixture(async workspace => {
  const moves = await two(workspace);
  await assert.rejects(batch({ workspace, moves }, async caps => {
    const receipt = await move(caps[0].cap);
    await fs.writeFile(path.join(workspace.rootPath, 'a.md'), 'Foreign D2', { mode: 0o600 });
    await current(caps[0].cap); await strict(caps[0].cap, receipt);
  }), error('recovery-conflict'));
  assert.equal(await fs.readFile(path.join(workspace.rootPath, 'a.md'), 'utf8'), 'Foreign D2');
  assert.equal(await fs.readFile(path.join(workspace.rootPath, 'moved-a.md'), 'utf8'), 'A');
}));

test('all genuine caps stay current together and cannot be retained after bounded batch callback', () => fixture(async workspace => {
  const moves = await two(workspace); let retained!: () => Promise<void>;
  await batch({ workspace, moves }, async caps => {
    assert(Object.isFrozen(caps)); assert.equal(caps.length, 2);
    for (const item of caps) { const receipt = await move(item.cap); await strict(item.cap, receipt); }
    await current(caps[0].cap); await current(caps[1].cap); retained = () => current(caps[0].cap);
  });
  await assert.rejects(retained(), error('invalid-lifetime'));
}));

for (const absent of [false, true]) test(`producer birth is shared unchanged with ${absent ? 'native absence' : 'physical file'} consumer`, () => fixture(async workspace => {
  const moves = await two(workspace, true, absent);
  await batch({ workspace, moves }, async caps => {
    const births: Parent[] = [];
    const producer = await move(caps[0].cap, async receipt => { birth(caps[0].cap, receipt); births.push(receipt); });
    assert.equal(births.length, 1); assert.equal(producer.createdParents[0], births[0]);
    await share(caps[1].cap, caps[0].cap, births[0]);
    const consumer = await move(caps[1].cap);
    assert.deepEqual(consumer.createdParents, []);
    assert.equal(consumer.observation.kind, absent ? 'projection_absent' : 'moved');
    assert.equal(births[0].originalProof, producer.createdParents[0].originalProof);
    await strict(caps[0].cap, producer); await strict(caps[1].cap, consumer);
  });
  assert.equal(await fs.readFile(path.join(workspace.rootPath, 'new/a.md'), 'utf8'), 'A');
  if (absent) await assert.rejects(fs.lstat(path.join(workspace.rootPath, 'new/b.md')), { code: 'ENOENT' });
  else assert.equal(await fs.readFile(path.join(workspace.rootPath, 'new/b.md'), 'utf8'), 'B');
}));

test('batch recovery consumes actual durable producer bindings without relabeling consumer proof', () => fixture(async workspace => {
  const moves = await two(workspace, true); let saved!: Parent;
  await batch({ workspace, moves }, async caps => {
    const producer = await move(caps[0].cap, async receipt => { birth(caps[0].cap, receipt); saved = receipt; });
    await share(caps[1].cap, caps[0].cap, saved); await move(caps[1].cap); await strict(caps[0].cap, producer);
  });
  const parents = [{ producerStep: 'a', consumers: [{ stepKey: 'a', sourceKind: 'regular_file' as const },
    { stepKey: 'b', sourceKind: 'regular_file' as const }], receipt: structuredClone(saved) }];
  await batch({ workspace, moves, parents }, async caps => {
    const producer = await move(caps[0].cap), consumer = await move(caps[1].cap);
    assert.deepEqual(producer.createdParents, [saved]); assert.deepEqual(consumer.createdParents, []);
    await strict(caps[0].cap, producer); await strict(caps[1].cap, consumer);
  });
}));

test('unacknowledged foreign destination parent cannot be adopted by batch recovery', () => fixture(async workspace => {
  const moves = await two(workspace, true); await fs.mkdir(path.join(workspace.rootPath, 'new'), { mode: 0o700 });
  await fs.writeFile(path.join(workspace.rootPath, 'new/foreign.bin'), 'Foreign', { mode: 0o600 });
  await assert.rejects(batch({ workspace, moves }, async () => assert.fail('Unjournaled parent reached callback.')), error('recovery-conflict'));
  assert.equal(await fs.readFile(path.join(workspace.rootPath, 'new/foreign.bin'), 'utf8'), 'Foreign');
}));

test('global hash budget rejects several individually legal steps before opening any batch source', () => fixture(async workspace => {
  const moves = await two(workspace);
  const oversized = structuredClone(moves);
  for (const item of oversized) {
    assert.equal(item.original.source.kind, 'regular_file');
    if (item.original.source.kind === 'regular_file') Reflect.set(item.original.source.identity, 'size', String(3 * 1024 ** 3));
  }
  await assert.rejects(batch({ workspace, moves: oversized }, async () => assert.fail('Global over-budget batch reached callback.')), error('budget-exceeded'));
  assert.equal(await fs.readFile(path.join(workspace.rootPath, 'a.md'), 'utf8'), 'A');
}));

test('same-batch concurrent operations poison every cap and drain before closing descriptors', () => fixture(async workspace => {
  const moves = await two(workspace);
  await assert.rejects(batch({ workspace, moves }, async caps => {
    const first = current(caps[0].cap);
    const second = current(caps[1].cap);
    const settled = await Promise.allSettled([first, second]);
    assert(settled.some(value => value.status === 'rejected'));
  }), error('reentrant-operation'));
}));

test('ordinary single callback still rejects a nested explicit batch and poisons its own stage', () => fixture(async workspace => {
  const moves = await two(workspace);
  await assert.rejects(prepare({ workspace, sourcePath: 'a.md', destinationPath: 'other.md', sourceKind: 'regular_file' }, async () => {
    await assert.rejects(batch({ workspace, moves }, async () => undefined), error('reentrant-operation'));
  }), error('reentrant-operation'));
}));

test('parent ACK getter refuses an equal copied birth during the real pending producer callback', () => fixture(async workspace => {
  const moves = await two(workspace, true);
  await assert.rejects(batch({ workspace, moves }, async caps => {
    await move(caps[0].cap, async receipt => { birth(caps[0].cap, receipt); birth(caps[0].cap, structuredClone(receipt)); });
  }), error('parent-create-unconfirmed', 'recovery-conflict'));
  await assert.rejects(fs.lstat(path.join(workspace.rootPath, 'new/a.md')), { code: 'ENOENT' });
}));
