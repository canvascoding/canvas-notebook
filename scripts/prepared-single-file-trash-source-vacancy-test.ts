import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { withPreparedWorkspaceSingleFileTrash as prepare, withRecoveredWorkspaceSingleFileTrash as recover,
  movePreparedWorkspaceSingleFileTrash as move, assertPreparedWorkspaceSingleFileTrashCurrent as assertCurrent,
  assertPreparedWorkspaceSingleFileTrashSourceVacant as assertVacant, readPreparedWorkspaceSingleFileTrash as read,
  PreparedSingleFileTrashError, type PreparedWorkspaceSingleFileTrash, type PreparedWorkspaceSingleFileTrashInput,
} from '../app/lib/filesystem/prepared-single-file-trash';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const vacancyError = (expected: PreparedSingleFileTrashError['code']) => (error: unknown) =>
  error instanceof PreparedSingleFileTrashError && error.code === expected;

async function withVacancyFixture(t: TestContext,
  operation: (input: PreparedWorkspaceSingleFileTrashInput) => Promise<void>): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-trash-vacancy-'));
  const data = await fs.realpath(temporary), root = path.join(data, 'workspace');
  await fs.mkdir(root, { mode: 0o700 });
  const workspace: WorkspaceContext = { workspaceId: `ws-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
    rootPath: root, legacy: false, permissions: { canRead: false, canWrite: false, canDelete: false, canCreatePublicLinks: false,
      canManageWorkspace: false, canRunAgent: false } };
  const actualOpen = fs.open.bind(fs), handles: FileHandle[] = [];
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args); handles.push(handle); return handle;
  });
  t.after(() => {
    assert(handles.length > 0, 'The fixture must exercise actual prepared file handles.');
    assert(handles.every(handle => handle.fd === -1), 'Every prepared file handle must be closed.');
    t.diagnostic(`Actual prepared handles closed: ${handles.length}/${handles.length}`);
  });
  try { await operation({ workspace, dataRoot: data, canonicalPath: 'note.md', trashEntryId: `trash-${randomUUID()}` }); }
  finally { await fs.rm(data, { recursive: true, force: true }); }
}

test('regular-file move and genuine recovered original retain strict source vacancy', async t => withVacancyFixture(t, async input => {
  const source = path.join(input.workspace.rootPath, input.canonicalPath);
  await fs.writeFile(source, 'original'); const sourceBefore = await fs.stat(source);
  const original = await prepare(input, async cap => {
    const receipt = await move(cap); await assertCurrent(cap); await assertVacant(cap);
    assert.equal(receipt.observation.kind, 'moved'); return read(cap);
  });
  const payload = path.join(input.dataRoot, original.trashRelativePath);
  assert.equal((await fs.stat(payload)).ino, sourceBefore.ino);
  await recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async cap => {
    await move(cap); await assertCurrent(cap); await assertVacant(cap);
  });
  await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
  assert.equal(await fs.readFile(payload, 'utf8'), 'original');
}));

test('nested projection absence and recovered missing-prefix evidence never create source parents', async t => withVacancyFixture(t, async input => {
  input = { ...input, canonicalPath: 'missing/child/note.md' };
  const original = await prepare(input, async cap => {
    await move(cap); await assertCurrent(cap); await assertVacant(cap); return read(cap);
  });
  assert.equal(original.source.kind, 'projection_absent'); assert.equal(original.filesystem.missingSourcePrefix, 'missing');
  await recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async cap => {
    await move(cap); await assertCurrent(cap); await assertVacant(cap);
  });
  await assert.rejects(fs.lstat(path.join(input.workspace.rootPath, 'missing')), { code: 'ENOENT' });
}));

test('recovered regular-file S2 remains tolerated by old Current and rejected by the strict vacancy gate', async t => withVacancyFixture(t, async input => {
  const source = path.join(input.workspace.rootPath, input.canonicalPath); await fs.writeFile(source, 'original');
  const receipt = await prepare(input, async cap => move(cap)), payload = path.join(input.dataRoot, receipt.original.trashRelativePath);
  await fs.writeFile(source, 'replacement'); const replacement = await fs.stat(source), originalPayload = await fs.stat(payload);
  let oldCurrentPassed = false;
  await assert.rejects(recover({ workspace: input.workspace, dataRoot: input.dataRoot, original: receipt.original }, async cap => {
    await move(cap); await assertCurrent(cap); oldCurrentPassed = true; await assertVacant(cap);
  }), vacancyError('source-changed'));
  assert(oldCurrentPassed); assert.equal((await fs.stat(source)).ino, replacement.ino);
  assert.equal(await fs.readFile(source, 'utf8'), 'replacement'); assert.equal((await fs.stat(payload)).ino, originalPayload.ino);
  assert.equal(await fs.readFile(payload, 'utf8'), 'original');
}));

test('recovered projection S2 remains untouched when strict vacancy fails after old Current succeeds', async t => withVacancyFixture(t, async input => {
  const original = await prepare(input, async cap => { await move(cap); return read(cap); });
  const source = path.join(input.workspace.rootPath, input.canonicalPath); await fs.writeFile(source, 'new projection');
  const replacement = await fs.stat(source); let oldCurrentPassed = false;
  await assert.rejects(recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async cap => {
    await move(cap); await assertCurrent(cap); oldCurrentPassed = true; await assertVacant(cap);
  }), vacancyError('source-changed'));
  assert(oldCurrentPassed); assert.equal((await fs.stat(source)).ino, replacement.ino);
  assert.equal(await fs.readFile(source, 'utf8'), 'new projection');
}));

test('a newly occupied original missing ancestor is rejected without adopting or removing it', async t => withVacancyFixture(t, async input => {
  input = { ...input, canonicalPath: 'missing/note.md' };
  const original = await prepare(input, async cap => { await move(cap); return read(cap); });
  const parent = path.join(input.workspace.rootPath, 'missing'); await fs.mkdir(parent); const replacement = await fs.stat(parent);
  await assert.rejects(recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async cap => {
    await move(cap); await assertVacant(cap);
  }), vacancyError('source-changed'));
  assert.equal((await fs.stat(parent)).ino, replacement.ino); assert.deepEqual(await fs.readdir(parent), []);
}));

test('source-vacancy checks before move poison the real cap without moving the original file', async t => withVacancyFixture(t, async input => {
  const source = path.join(input.workspace.rootPath, input.canonicalPath); await fs.writeFile(source, 'original');
  const before = await fs.stat(source);
  await assert.rejects(prepare(input, async cap => assertVacant(cap)), vacancyError('invalid-lifetime'));
  assert.equal((await fs.stat(source)).ino, before.ino); assert.equal(await fs.readFile(source, 'utf8'), 'original');
}));

test('overlapping vacancy checks poison both real operations and drain their filesystem IO', async t => withVacancyFixture(t, async input => {
  await assert.rejects(prepare(input, async cap => {
    await move(cap); const first = assertVacant(cap), second = assertVacant(cap);
    const settled = await Promise.allSettled([first, second]);
    assert(settled.every(item => item.status === 'rejected' && vacancyError('reentrant-operation')(item.reason)));
  }), vacancyError('reentrant-operation'));
}));

test('an unawaited genuine vacancy check is drained before descriptor disposal', async t => withVacancyFixture(t, async input => {
  await assert.rejects(prepare(input, async cap => {
    await move(cap); void assertVacant(cap).catch(() => undefined);
  }), vacancyError('unawaited-operation'));
}));

test('unminted and expired genuine caps cannot prove source vacancy', async t => withVacancyFixture(t, async input => {
  await assert.rejects(assertVacant(Object.freeze({}) as PreparedWorkspaceSingleFileTrash), vacancyError('invalid-lifetime'));
  let expired: PreparedWorkspaceSingleFileTrash | undefined;
  await prepare(input, async cap => { expired = cap; await move(cap); await assertVacant(cap); });
  assert(expired); await assert.rejects(assertVacant(expired), vacancyError('invalid-lifetime'));
}));
