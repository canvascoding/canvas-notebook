import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { filesystemFileVersion } from '../app/lib/filesystem/file-version';
import { assertObservedWorkspaceStarterDocumentCurrent, createWorkspaceStarterDocument, readObservedWorkspaceStarterDocument,
  seedWorkspaceStarterDocument, withObservedWorkspaceStarterDocument, WORKSPACE_STARTER_DOCUMENT_NAME,
  WORKSPACE_STARTER_MAX_BYTES, WorkspaceStarterDocumentError, type ObservedWorkspaceStarterDocument } from '../app/lib/workspaces/starter-document';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function withRoot(operation: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'canvas-starter-source-')));
  try { await operation(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const changed = (error: unknown) => error instanceof WorkspaceStarterDocumentError && ['source-changed','invalid-source'].includes(error.code);

test('actual created starter facts bind exact held inode/version/hash/bytes for all workspace types', async () => {
  for (const workspaceType of ['personal','team','organization','project'] as const) await withRoot(async root => {
    let retained: ObservedWorkspaceStarterDocument | undefined;
    await withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType }, async observation => {
      retained = observation;
      const facts = readObservedWorkspaceStarterDocument(observation), file = path.join(root, WORKSPACE_STARTER_DOCUMENT_NAME);
      const bytes = await fs.readFile(file), stat = await fs.stat(file);
      assert.deepEqual(facts, { path: WORKSPACE_STARTER_DOCUMENT_NAME, seedDisposition: 'created', sourceFileVersion: filesystemFileVersion(stat),
        sourceSha256: sha256(bytes), sourceBytes: bytes.length });
      assert.equal(bytes.toString('utf8'), createWorkspaceStarterDocument(workspaceType));
      assert.equal(stat.mode & 0o777, 0o600); assert(Object.isFrozen(facts));
      await assertObservedWorkspaceStarterDocumentCurrent(observation);
    });
    assert.throws(() => readObservedWorkspaceStarterDocument(retained!), /observation-closed/u);
    await assert.rejects(assertObservedWorkspaceStarterDocumentCurrent(retained!), /observation-closed/u);
  });
});

test('existing literal original bytes including BOM/CRLF/emoji and empty files remain unchanged and are never template bytes', async () => {
  for (const bytes of [Buffer.from('\ufeff# Original 😀\r\nUnverändert\r\n'), Buffer.alloc(0)]) await withRoot(async root => {
    const file = path.join(root, WORKSPACE_STARTER_DOCUMENT_NAME); await fs.writeFile(file, bytes);
    const before = await fs.stat(file);
    await withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async observation => {
      const facts = readObservedWorkspaceStarterDocument(observation);
      assert.equal(facts.seedDisposition, 'existing'); assert.equal(facts.sourceSha256, sha256(bytes));
      assert.equal(facts.sourceBytes, bytes.length); assert.equal(facts.sourceFileVersion, filesystemFileVersion(before));
    });
    assert.deepEqual(await fs.readFile(file), bytes); assert.equal(filesystemFileVersion(await fs.stat(file)), filesystemFileVersion(before));
  });
});

test('legacy seed API still returns created then existing without replacing the original', async () => withRoot(async root => {
  assert.equal(seedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'team' }), 'created');
  const file = path.join(root, WORKSPACE_STARTER_DOCUMENT_NAME); await fs.writeFile(file, 'retained original');
  assert.equal(seedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'project' }), 'existing');
  assert.equal(await fs.readFile(file, 'utf8'), 'retained original');
}));

test('same-path replacement during callback is rejected while the retained original descriptor is never adopted as the replacement', async () => withRoot(async root => {
  const file = path.join(root, WORKSPACE_STARTER_DOCUMENT_NAME), original = path.join(root, 'retained-original');
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async observation => {
    const before = readObservedWorkspaceStarterDocument(observation); await fs.rename(file, original); await fs.writeFile(file, 'D2');
    await assert.rejects(assertObservedWorkspaceStarterDocumentCurrent(observation), changed);
    assert.equal(sha256(await fs.readFile(original)), before.sourceSha256);
  }), changed);
  assert.equal(await fs.readFile(file, 'utf8'), 'D2');
}));

test('same-inode content mutation and a caught failed check remain fatal to the enclosing observation', async () => withRoot(async root => {
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async observation => {
    await fs.appendFile(path.join(root, WORKSPACE_STARTER_DOCUMENT_NAME), '\nchanged');
    await assert.rejects(assertObservedWorkspaceStarterDocumentCurrent(observation), changed);
  }), changed);
}));

test('source symlinks, hardlinks, directory replacements and symlink ancestors are rejected', async () => withRoot(async root => {
  const outside = path.join(root, 'outside'); await fs.writeFile(outside, 'untouched');
  const file = path.join(root, WORKSPACE_STARTER_DOCUMENT_NAME);
  await fs.symlink(outside, file);
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async () => assert.fail('symlink callback')), changed);
  await fs.unlink(file); await fs.link(outside, file);
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async () => assert.fail('hardlink callback')), changed);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async () => assert.fail('directory callback')), changed);
  const real = path.join(root, 'real'); await fs.mkdir(real); const alias = path.join(root, 'alias'); await fs.symlink(real, alias);
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: alias, workspaceType: 'personal' }, async () => assert.fail('ancestor callback')), changed);
  assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
}));

test('replaced root or ancestor rejects without mutating the new root', async () => withRoot(async parent => {
  const root = path.join(parent, 'workspace'), moved = path.join(parent, 'old-workspace'); await fs.mkdir(root);
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'team' }, async () => {
    await fs.rename(root, moved); await fs.mkdir(root);
  }), changed);
  assert.deepEqual(await fs.readdir(root), []);
}));

test('size, malformed roots and fake observations fail closed; callback failure identity is retained', async () => withRoot(async root => {
  const file = path.join(root, WORKSPACE_STARTER_DOCUMENT_NAME), handle = await fs.open(file, 'w');
  try { await handle.truncate(WORKSPACE_STARTER_MAX_BYTES + 1); } finally { await handle.close(); }
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async () => assert.fail('oversize callback')), /source-too-large/u);
  await fs.unlink(file);
  for (const invalid of ['relative', `${root}/../escape`, `${root}/`, `${root}\0`, 'x'.repeat(4097)]) {
    await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: invalid, workspaceType: 'team' }, async () => assert.fail('invalid root')), /invalid-source/u);
  }
  assert.throws(() => readObservedWorkspaceStarterDocument(Object.freeze({}) as ObservedWorkspaceStarterDocument), /observation-closed/u);
  const expected = new Error('SQL intent insert failed');
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async () => { throw expected; }), error => error === expected);
  await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'personal' }, async () => { throw undefined; }), error => error === undefined);
}));

test('all real descriptor close failures are retained together with the original failure', async () => withRoot(async root => {
  const originalOpen = fs.open, expected = new Error('primary SQL failure'), closeFailure = new Error('close transport unconfirmed');
  let injected = false;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === path.join(root, WORKSPACE_STARTER_DOCUMENT_NAME)) {
      const originalClose = handle.close.bind(handle);
      handle.close = async () => { await originalClose(); injected = true; throw closeFailure; };
    }
    return handle;
  };
  try {
    await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: root, workspaceType: 'team' }, async () => { throw expected; }), error => {
      assert(error instanceof WorkspaceStarterDocumentError); assert.equal(error.code, 'disposal-unconfirmed'); assert.equal(error.status, 503);
      assert(error.cause instanceof AggregateError); assert.deepEqual(error.cause.errors, [expected, closeFailure]); return true;
    });
    assert.equal(injected, true);
  } finally { fs.open = originalOpen; }
}));
