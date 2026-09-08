import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import { validateDocxPackage } from '../app/lib/office/docx-package';
import {
  OFFICE_JOURNAL_LIMITS,
  OfficeJournalError,
  completeOfficeCommit,
  findOfficeCommit,
  listOfficeVersions,
  listPendingOfficeCommits,
  prepareOfficeCommit,
  readOfficeVersion,
  type OfficeJournalErrorCode,
  type PrepareOfficeCommitInput,
} from '../app/lib/office/document-journal';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const workspaceId = 'office-journal-tests';
let before: Buffer;
let after: Buffer;
let third: Buffer;

async function docx(label: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${label}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Preserved table</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:ins w:id="1" w:author="Editor"><w:r><w:t>Tracked insertion</w:t></w:r></w:ins></w:p></w:body></w:document>`);
  zip.file('vendor/unknown.bin', Buffer.from([0, 255, 80, 75, 3, 4, 50, 128]));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function input(lineageId: string, overrides: Partial<PrepareOfficeCommitInput> = {}): PrepareOfficeCommitInput {
  return {
    workspaceId, lineageId, actorUserId: 'user-1', actorSessionId: 'editor-1', actorType: 'user',
    path: '/reports/document.docx', idempotencyKey: 'save-1', beforeHash: hash(before), baseRevisionId: 'revision-0',
    beforeContent: before, content: after, ...overrides,
  };
}

function scope(lineageId: string) { return { workspaceId, lineageId }; }

function storageRoot(lineageId: string): string {
  return path.join(process.env.CANVAS_DATA_ROOT!, 'office-documents', hash(workspaceId), hash(lineageId));
}

async function rejects(run: () => Promise<unknown>, code: OfficeJournalErrorCode): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof OfficeJournalError, `Expected OfficeJournalError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

const tests: [string, () => Promise<void>][] = [
  ['durably preserves original and changed OOXML bytes without touching the canonical file', async () => {
    const candidate = input('versions');
    const canonical = path.join(process.env.CANVAS_DATA_ROOT!, 'canonical.docx');
    await fs.writeFile(canonical, before);
    const record = await prepareOfficeCommit(candidate);
    assert.equal(record.status, 'prepared');
    assert.equal(record.revisionId, null);
    assert.equal(record.afterHash, hash(after));
    assert.equal(record.beforeHash, hash(before));
    assert.deepEqual(await fs.readFile(canonical), before);
    assert.deepEqual(await readOfficeVersion({ ...scope('versions'), contentHash: record.beforeHash! }), before);
    const version = await readOfficeVersion({ ...scope('versions'), contentHash: record.afterHash });
    assert.deepEqual(version, after);
    await validateDocxPackage(version);
    const zip = await JSZip.loadAsync(version);
    assert.deepEqual(await zip.file('vendor/unknown.bin')!.async('nodebuffer'), Buffer.from([0, 255, 80, 75, 3, 4, 50, 128]));
    assert.deepEqual(await listPendingOfficeCommits(scope('versions')), [record]);
    const versions = await listOfficeVersions(workspaceId, 'versions');
    assert.equal(versions.length, 2);
    assert.equal(versions.find((entry) => entry.contentHash === hash(before))?.status, 'baseline');
    assert.equal(versions.find((entry) => entry.contentHash === hash(before))?.actorUserId, null);
    assert.equal(versions.find((entry) => entry.contentHash === hash(after))?.status, 'prepared');
    const blob = path.join(storageRoot('versions'), 'blobs', `${record.afterHash}.docx`);
    assert.equal((await fs.stat(blob)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(storageRoot('versions'))).mode & 0o777, 0o700);
  }],
  ['snapshots caller-owned buffers before the first asynchronous wait', async () => {
    const mutableBefore = Buffer.from(before);
    const mutableAfter = Buffer.from(after);
    const pending = prepareOfficeCommit(input('buffer-copy', { beforeContent: mutableBefore, content: mutableAfter }));
    mutableBefore.fill(0);
    mutableAfter.fill(0);
    const record = await pending;
    assert.deepEqual(await readOfficeVersion({ ...scope('buffer-copy'), contentHash: record.beforeHash! }), before);
    assert.deepEqual(await readOfficeVersion({ ...scope('buffer-copy'), contentHash: record.afterHash }), after);
  }],
  ['serializes identical parallel keys even inside an already-held workspace lock', async () => {
    const candidate = input('parallel');
    const records = await withWorkspaceMutationLock(workspaceId, () => Promise.all(Array.from({ length: 6 }, () => prepareOfficeCommit(candidate))));
    for (const record of records) assert.deepEqual(record, records[0]);
    assert.equal((await listPendingOfficeCommits(scope('parallel'))).length, 1);
    assert.equal((await fs.readdir(path.join(storageRoot('parallel'), 'commits'))).length, 1);
    const completed = await completeOfficeCommit(records[0], 'revision-1');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.revisionId, 'revision-1');
    assert.deepEqual(await completeOfficeCommit(records[0], 'revision-1'), completed);
    assert.deepEqual(await prepareOfficeCommit(candidate), completed);
    assert.deepEqual(await findOfficeCommit(candidate), completed);
    assert.deepEqual(await listPendingOfficeCommits(scope('parallel')), []);
    assert.equal((await listOfficeVersions(workspaceId, 'parallel')).find((entry) => entry.contentHash === hash(after))?.revisionId, 'revision-1');
  }],
  ['rejects key reuse with different bytes, baseline, user, actor type, path or final revision', async () => {
    const candidate = input('conflicts');
    const record = await prepareOfficeCommit(candidate);
    for (const override of [
      { content: third }, { beforeContent: null, beforeHash: null }, { baseRevisionId: 'another-revision' },
      { actorUserId: 'another-user' }, { actorType: 'agent' as const }, { path: '/reports/renamed.docx' },
    ]) await rejects(() => prepareOfficeCommit({ ...candidate, ...override }), 'OFFICE_IDEMPOTENCY_CONFLICT');
    await rejects(() => findOfficeCommit({ ...candidate, actorUserId: 'another-user' }), 'OFFICE_IDEMPOTENCY_CONFLICT');
    await completeOfficeCommit(record, 'revision-1');
    await rejects(() => completeOfficeCommit(record, 'revision-2'), 'OFFICE_IDEMPOTENCY_CONFLICT');
    const secondSession = await prepareOfficeCommit({ ...candidate, actorSessionId: 'agent-run-2', actorType: 'agent', content: third });
    assert.notEqual(secondSession.id, record.id);
  }],
  ['keeps two unpublished results and the original independently recoverable', async () => {
    const first = await prepareOfficeCommit(input('two-pending'));
    const second = await prepareOfficeCommit(input('two-pending', { idempotencyKey: 'save-2', content: third }));
    assert.deepEqual(new Set((await listPendingOfficeCommits(scope('two-pending'))).map((record) => record.id)), new Set([first.id, second.id]));
    const versions = await listOfficeVersions(workspaceId, 'two-pending');
    assert.equal(versions.length, 3);
    assert.deepEqual(await readOfficeVersion({ ...scope('two-pending'), contentHash: first.afterHash }), after);
    assert.deepEqual(await readOfficeVersion({ ...scope('two-pending'), contentHash: second.afterHash }), third);
    await completeOfficeCommit(second, 'revision-2');
    assert.deepEqual((await listPendingOfficeCommits(scope('two-pending'))).map((record) => record.id), [first.id]);
  }],
  ['rejects corrupt blobs/manifests without overwriting recovery evidence', async () => {
    const candidate = input('corruption');
    const record = await prepareOfficeCommit(candidate);
    const blob = path.join(storageRoot('corruption'), 'blobs', `${record.afterHash}.docx`);
    const corrupt = Buffer.from('corrupted content');
    await fs.writeFile(blob, corrupt);
    await rejects(() => readOfficeVersion({ ...scope('corruption'), contentHash: record.afterHash }), 'OFFICE_JOURNAL_CORRUPT');
    await rejects(() => prepareOfficeCommit(candidate), 'OFFICE_JOURNAL_CORRUPT');
    assert.deepEqual(await fs.readFile(blob), corrupt);
    const manifest = path.join(storageRoot('corruption'), 'commits', `${record.id}.json`);
    await fs.writeFile(manifest, JSON.stringify({ ...record, workspaceId: 'another-workspace' }));
    await rejects(() => findOfficeCommit(candidate), 'OFFICE_JOURNAL_CORRUPT');
    await rejects(() => readOfficeVersion({ ...scope('corruption'), contentHash: 'a'.repeat(64) }), 'OFFICE_VERSION_NOT_FOUND');
  }],
  ['rejects symlinks, external hardlinks, unsafe permissions and oversized storage reads', async () => {
    const record = await prepareOfficeCommit(input('links'));
    const blob = path.join(storageRoot('links'), 'blobs', `${record.afterHash}.docx`);
    const external = path.join(process.env.CANVAS_DATA_ROOT!, 'external.bin');
    await fs.writeFile(external, Buffer.from('private outside bytes'), { mode: 0o600 });
    await fs.unlink(blob);
    await fs.symlink(external, blob);
    await rejects(() => readOfficeVersion({ ...scope('links'), contentHash: record.afterHash }), 'OFFICE_JOURNAL_UNSAFE_STORAGE');
    assert.equal((await fs.readFile(external)).toString(), 'private outside bytes');
    await fs.unlink(blob);
    await fs.link(external, blob);
    await rejects(() => readOfficeVersion({ ...scope('links'), contentHash: record.afterHash }), 'OFFICE_JOURNAL_UNSAFE_STORAGE');
    await fs.unlink(blob);
    await fs.writeFile(blob, after, { mode: 0o644 });
    await rejects(() => readOfficeVersion({ ...scope('links'), contentHash: record.afterHash }), 'OFFICE_JOURNAL_UNSAFE_STORAGE');
    await fs.chmod(blob, 0o600);
    await fs.truncate(blob, OFFICE_JOURNAL_LIMITS.contentBytes + 1);
    await rejects(() => readOfficeVersion({ ...scope('links'), contentHash: record.afterHash }), 'OFFICE_JOURNAL_CORRUPT');
    const directoryRecord = await prepareOfficeCommit(input('directory-link'));
    const blobs = path.join(storageRoot('directory-link'), 'blobs');
    await fs.rename(blobs, `${blobs}-original`);
    await fs.symlink(`${blobs}-original`, blobs);
    await rejects(() => readOfficeVersion({ ...scope('directory-link'), contentHash: directoryRecord.afterHash }), 'OFFICE_JOURNAL_UNSAFE_STORAGE');
  }],
  ['hashes identities and rejects invalid keys, traversal, oversized buffers and mismatched starting hashes', async () => {
    const encoded = input('../identity/is/metadata', { actorSessionId: '../session', idempotencyKey: '../key' });
    const record = await prepareOfficeCommit(encoded);
    assert.deepEqual(await findOfficeCommit(encoded), record);
    assert.ok((await fs.stat(storageRoot(encoded.lineageId))).isDirectory());
    for (const override of [
      { idempotencyKey: '' }, { idempotencyKey: 'x'.repeat(OFFICE_JOURNAL_LIMITS.idempotencyKeyLength + 1) },
      { actorSessionId: '' }, { actorUserId: '' }, { beforeHash: '0'.repeat(64) },
      { path: '../outside.docx' }, { path: '/valid/../outside.docx' }, { path: 'C:\\outside.docx' },
      { content: Buffer.alloc(OFFICE_JOURNAL_LIMITS.contentBytes + 1) },
    ]) await rejects(() => prepareOfficeCommit(input('invalid', override)), 'OFFICE_JOURNAL_INVALID_INPUT');
    await rejects(() => readOfficeVersion({ ...scope('invalid'), contentHash: '../../outside' }), 'OFFICE_JOURNAL_INVALID_INPUT');
    const created = await prepareOfficeCommit(input('new-file', { beforeContent: null, beforeHash: null, baseRevisionId: null }));
    assert.equal(created.beforeHash, null);
    assert.equal((await listOfficeVersions(workspaceId, 'new-file')).length, 1);
  }],
  ['retries safely after failures publishing blobs, manifests and pending markers', async () => {
    for (const failAt of ['blobs', 'commits', 'pending']) {
      const lineageId = `failure-${failAt}`;
      const candidate = input(lineageId);
      const originalRename = fs.rename;
      let injected = false;
      fs.rename = async (from, to) => {
        if (!injected && String(to).startsWith(path.join(storageRoot(lineageId), failAt) + path.sep)) {
          injected = true;
          throw Object.assign(new Error('injected persistence failure'), { code: 'EIO' });
        }
        return originalRename(from, to);
      };
      try {
        await rejects(() => prepareOfficeCommit(candidate), 'OFFICE_JOURNAL_UNAVAILABLE');
      } finally {
        fs.rename = originalRename;
      }
      assert.equal(injected, true);
      const found = await findOfficeCommit(candidate);
      assert.equal(found?.status ?? null, failAt === 'pending' ? 'prepared' : null);
      const retried = await prepareOfficeCommit(candidate);
      assert.deepEqual(await listPendingOfficeCommits(scope(lineageId)), [retried]);
      if (found) assert.deepEqual(retried, found);
      assert.deepEqual(await readOfficeVersion({ ...scope(lineageId), contentHash: retried.afterHash }), after);
      for (const directory of ['blobs', 'commits', 'pending']) assert.equal((await fs.readdir(path.join(storageRoot(lineageId), directory))).some((entry) => entry.startsWith('.tmp-')), false);
    }
  }],
  ['keeps prepared receipts on finalization failure and ignores stale markers after completed receipts', async () => {
    const candidate = input('finalization');
    const record = await prepareOfficeCommit(candidate);
    const manifest = path.join(storageRoot('finalization'), 'commits', `${record.id}.json`);
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (String(to) === manifest) throw Object.assign(new Error('injected finalize failure'), { code: 'EIO' });
      return originalRename(from, to);
    };
    try {
      await rejects(() => completeOfficeCommit(record, 'revision-final'), 'OFFICE_JOURNAL_UNAVAILABLE');
    } finally {
      fs.rename = originalRename;
    }
    assert.equal((await findOfficeCommit(candidate))?.status, 'prepared');
    assert.equal((await listPendingOfficeCommits(scope('finalization'))).length, 1);
    const marker = path.join(storageRoot('finalization'), 'pending', `${record.id}.json`);
    const originalUnlink = fs.unlink;
    fs.unlink = async (filename) => {
      if (String(filename) === marker) throw Object.assign(new Error('injected marker cleanup failure'), { code: 'EIO' });
      return originalUnlink(filename);
    };
    try {
      await rejects(() => completeOfficeCommit(record, 'revision-final'), 'OFFICE_JOURNAL_UNAVAILABLE');
    } finally {
      fs.unlink = originalUnlink;
    }
    assert.equal((await findOfficeCommit(candidate))?.status, 'completed');
    assert.deepEqual(await listPendingOfficeCommits(scope('finalization')), []);
    await completeOfficeCommit(record, 'revision-final');
    assert.deepEqual(await fs.readdir(path.join(storageRoot('finalization'), 'pending')), []);
  }],
  ['re-fsyncs existing snapshots when retrying an uncertain rename durability failure', async () => {
    const lineageId = 'fsync-retry';
    const candidate = input(lineageId);
    const blob = path.join(storageRoot(lineageId), 'blobs', `${hash(after)}.docx`);
    const originalRename = fs.rename;
    const originalOpen = fs.open;
    let blobPublished = false;
    let injected = false;
    let reusedBlobSynced = false;
    fs.rename = async (from, to) => {
      await originalRename(from, to);
      if (String(to) === blob) blobPublished = true;
    };
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (blobPublished && !injected && String(args[0]) === path.dirname(blob)) {
          injected = true;
          throw Object.assign(new Error('injected parent fsync failure'), { code: 'EIO' });
        }
        if (injected && String(args[0]) === blob) reusedBlobSynced = true;
        return originalSync();
      };
      return handle;
    };
    try {
      await rejects(() => prepareOfficeCommit(candidate), 'OFFICE_JOURNAL_UNAVAILABLE');
      assert.equal(injected, true);
      const retried = await prepareOfficeCommit(candidate);
      assert.equal(retried.afterHash, hash(after));
      assert.equal(reusedBlobSynced, true);
    } finally {
      fs.rename = originalRename;
      fs.open = originalOpen;
    }
  }],
  ['recovers a killed process after canonical replacement with the original actor and exact bytes', async () => {
    const canonical = path.join(process.env.CANVAS_DATA_ROOT!, 'crash-canonical.docx');
    await fs.writeFile(canonical, before);
    const child = spawn(process.execPath, ['--conditions', 'react-server', '--import', 'tsx', path.join(process.cwd(), 'scripts/office-document-journal-test.ts'), '--crash-after-replace'], {
      cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(() => reject(new Error(`Crash worker did not become ready: ${stderr}`)), 15_000);
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
          if (stdout.includes('ready\n')) { clearTimeout(timer); resolve(); }
        });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('exit', (code) => { if (code !== null) { clearTimeout(timer); reject(new Error(`Crash worker exited: ${code} ${stderr}`)); } });
      });
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    const [pending] = await listPendingOfficeCommits(scope('crash'));
    assert.ok(pending);
    assert.equal(pending.actorType, 'agent');
    assert.equal(pending.actorSessionId, 'agent-crash-run');
    assert.equal(pending.afterHash, hash(await fs.readFile(canonical)));
    assert.deepEqual(await readOfficeVersion({ ...scope('crash'), contentHash: pending.beforeHash! }), before);
    assert.deepEqual(await readOfficeVersion({ ...scope('crash'), contentHash: pending.afterHash }), await fs.readFile(canonical));
    const recovered = await completeOfficeCommit(pending, 'revision-recovered');
    assert.equal(recovered.revisionId, 'revision-recovered');
    assert.equal(recovered.actorSessionId, 'agent-crash-run');
    assert.deepEqual(await listPendingOfficeCommits(scope('crash')), []);
  }],
];

async function crashWorker(): Promise<void> {
  const canonical = path.join(process.env.CANVAS_DATA_ROOT!, 'crash-canonical.docx');
  before = await fs.readFile(canonical);
  after = await docx('After agent replacement');
  await prepareOfficeCommit(input('crash', { actorType: 'agent', actorSessionId: 'agent-crash-run' }));
  await fs.writeFile(canonical, after);
  const handle = await fs.open(canonical, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  process.stdout.write('ready\n');
  setInterval(() => {}, 1000);
}

async function main(): Promise<void> {
  if (process.argv.includes('--crash-after-replace')) return crashWorker();
  const originalDataRoot = process.env.CANVAS_DATA_ROOT;
  const originalAppRoot = process.env.CANVAS_APP_ROOT;
  // All filesystem work remains in this git worktree and is removed afterward.
  const directory = path.join(process.cwd(), `.office-journal-test-${randomUUID()}`);
  await fs.mkdir(directory, { mode: 0o700 });
  process.env.CANVAS_DATA_ROOT = directory;
  process.env.CANVAS_APP_ROOT = process.cwd();
  try {
    before = await docx('Before user edits');
    after = await docx('After user edits');
    third = await docx('Independent agent proposal');
    for (const [name, run] of tests) {
      await run();
      process.stdout.write(`✓ ${name}\n`);
    }
    process.stdout.write(`Office document journal: ${tests.length} scenarios passed.\n`);
  } finally {
    if (originalDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = originalDataRoot;
    if (originalAppRoot === undefined) delete process.env.CANVAS_APP_ROOT;
    else process.env.CANVAS_APP_ROOT = originalAppRoot;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
