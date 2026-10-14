import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MarkdownUploadAttemptAccess, MarkdownUploadAttemptSelection } from '../app/lib/files/workspace-markdown-upload-attempt';

const own = process.cwd(), script = path.resolve('scripts/workspace-markdown-upload-attempt-test.ts');
const children = new Set<cp.ChildProcess>();
async function worker() {
  const { withWorkspaceMarkdownUploadAttempt } = await import('../app/lib/files/workspace-markdown-upload-attempt');
  const selection = JSON.parse(process.argv[3]) as MarkdownUploadAttemptSelection;
  process.stdout.write('ready\n');
  try {
    await withWorkspaceMarkdownUploadAttempt(selection, async access => {
      process.stdout.write('entered\n');
      if (process.argv[4] === 'hold') await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));
      if (process.argv[4] === 'unawaited') {
        void access.readSource(); void access.retainForRecovery(); void access.abandon();
        return;
      }
      const observation = await access.inspect();
      process.stdout.write(JSON.stringify(observation) + '\n');
    });
  } catch (error) { process.stdout.write(JSON.stringify({ code: error && typeof error === 'object' && 'code' in error ? error.code : 'unknown' }) + '\n'); }
}

function start(selection: MarkdownUploadAttemptSelection, hold: boolean | 'unawaited' = false) {
  const child = cp.spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', script, '--worker', JSON.stringify(selection), hold === 'unawaited' ? hold : hold ? 'hold' : 'read'], {
    cwd: own, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '', errors = '';
  child.stdout!.on('data', bytes => { output += String(bytes); });
  child.stderr!.on('data', bytes => { errors += String(bytes); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { children.delete(child); if (code === 0) resolve(); else reject(new Error(`Worker ${code}: ${errors}`)); });
  });
  const wait = async (value: string) => {
    for (let i = 0; i < 500; i++) {
      if (output.includes(value)) return;
      if (child.exitCode !== null) throw new Error(`Worker ended before ${value}: ${output}${errors}`);
      await delay(10);
    }
    throw new Error(`Worker wait expired: ${value}`);
  };
  return { child, done, wait, output: () => output };
}

/** Observe actual helper checkpoints before its acknowledged next IO step. */
async function interceptPhase<T>(target: string, operation: () => Promise<T>, mutate?: () => Promise<void>): Promise<T> {
  const original = cp.spawn;
  let fired = false;
  cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
    const child = original(...args);
    if (Array.isArray(args[1]) && args[1].some(value => String(value).endsWith('/markdown-upload-attempt.py'))) {
      let latest = '', lines = '';
      child.stdout!.on('data', bytes => {
        lines += String(bytes);
        for (let end = lines.indexOf('\n'); end >= 0; end = lines.indexOf('\n')) {
          const line = lines.slice(0, end); lines = lines.slice(end + 1);
          try { const value = JSON.parse(line); if (value.stage) latest = value.stage; } catch { /* Other finite helper output. */ }
        }
      });
      const write = child.stdin!.write;
      child.stdin!.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!fired && chunk === 'continue\n' && latest === target) {
          fired = true;
          if (mutate) void mutate().then(() => { Reflect.apply(write, child.stdin, [chunk, ...rest]); }, () => child.kill('SIGKILL'));
          else child.kill('SIGKILL');
          return true;
        }
        return Reflect.apply(write, child.stdin, [chunk, ...rest]);
      }) as typeof write;
    }
    return child;
  }) as typeof cp.spawn;
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { cp.spawn = original; syncBuiltinESMExports(); assert.equal(fired, true, `Actual helper phase was not reached: ${target}`); }
}

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-markdown-upload-attempt-'));
  process.env.DATA = data; process.env.CANVAS_DATA_ROOT = data;
  const service = await import('../app/lib/files/workspace-upload-service');
  const attempt = await import('../app/lib/files/workspace-markdown-upload-attempt');
  const workspace = { workspaceId: 'attempt-workspace', workspaceType: 'personal' as const, rootPath: path.join(data, 'workspace'), legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
  await fs.mkdir(workspace.rootPath);
  let passed = 0;
  const run = async (name: string, action: () => Promise<void>) => {
    if (process.env.CANVAS_UPLOAD_ATTEMPT_TEST_CASE && name !== process.env.CANVAS_UPLOAD_ATTEMPT_TEST_CASE) return;
    await action(); passed++; console.log(`PASS ${name}`);
  };
  const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  async function fixture(content: Uint8Array = Buffer.from('\uFEFF---\r\ntitle: Datei\r\n---\r\nText 🦊\r\n'), count = 1, targetDir = 'folder') {
    const session = await service.createWorkspaceUploadSession({ userId: 'owner', workspace, targetDir,
      files: Array.from({ length: count }, (_, index) => ({ path: `original-${index}.md`, size: content.byteLength, mimeType: 'text/markdown' })) });
    for (const file of session.files) {
      if (content.byteLength) await service.writeWorkspaceUploadChunk({ sessionId: session.id, fileId: file.id, userId: 'owner', workspace,
        offset: 0, expectedBytes: content.byteLength, body: new Blob([Uint8Array.from(content)]).stream() });
      else await fs.writeFile(path.join(data, '.uploads/workspace', session.id, file.id + '.part'), content, { mode: 0o600 });
    }
    const selection: MarkdownUploadAttemptSelection = { uploadSessionId: session.id, fileId: session.files[0].id, workspaceId: workspace.workspaceId,
      targetPath: session.files[0].targetPath, actorUserId: 'owner', actorSessionId: 'actual-session-intent', requestId: randomUUID(), operationId: randomUUID() };
    const key = hash(JSON.stringify([selection.uploadSessionId, selection.fileId]));
    const directory = path.join(data, 'canvas-markdown-upload-attempts', key);
    const original = path.join(data, '.uploads/workspace', session.id, selection.fileId + '.part');
    return { session, selection, directory, original, content };
  }
  const code = (expected: string) => (error: unknown) => Boolean(error instanceof attempt.MarkdownUploadAttemptError && error.code === expected);
  const namespaceClosure = (error: unknown): boolean => code('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED')(error)
    || error instanceof AggregateError && error.message === 'MARKDOWN_UPLOAD_ATTEMPT_CLOSURE_FAILED'
    && error.errors.length > 0 && error.errors.every(code('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED'));
  try {
    const normal = await fixture();
    await run('opaque original bytes and immutable durable retry', async () => {
      let escaped: MarkdownUploadAttemptAccess | undefined;
      await attempt.withWorkspaceMarkdownUploadAttempt(normal.selection, async access => {
        escaped = access;
        assert.deepEqual(await access.inspect(), { state: 'staged', uploadStatus: 'available', sourceHash: hash(normal.content), sourceBytes: normal.content.byteLength });
        assert.deepEqual(await access.readSource(), Uint8Array.from(normal.content));
        assert.equal(JSON.stringify(access), '{}');
      });
      await assert.rejects(escaped!.readSource(), code('MARKDOWN_UPLOAD_ATTEMPT_CLOSED'));
      const record = await fs.readFile(path.join(normal.directory, 'record.json'));
      const inode = (await fs.stat(path.join(normal.directory, 'source.bin'))).ino;
      await attempt.withWorkspaceMarkdownUploadAttempt(normal.selection, async access => { assert.deepEqual(await access.readSource(), Uint8Array.from(normal.content)); });
      assert.deepEqual(await fs.readFile(path.join(normal.directory, 'record.json')), record);
      assert.equal((await fs.stat(path.join(normal.directory, 'source.bin'))).ino, inode);
      assert.equal((await fs.stat(normal.directory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(normal.directory, 'record.json'))).mode & 0o777, 0o600);
    });
    await run('all immutable request bindings and unknown credentials fields refused', async () => {
      const before = await fs.readFile(path.join(normal.directory, 'record.json'));
      for (const key of ['requestId', 'operationId', 'actorSessionId', 'actorUserId', 'workspaceId', 'targetPath'] as const) {
        await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt({ ...normal.selection, [key]: key === 'targetPath' ? 'changed.md' : 'other' }, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_REQUEST_CONFLICT'));
      }
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt({ ...normal.selection, headers: { authorization: 'must-not-persist' } } as never, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_INVALID_INPUT'));
      assert.deepEqual(await fs.readFile(path.join(normal.directory, 'record.json')), before);
      assert.doesNotMatch(before.toString(), /headers|authorization|must-not-persist/);
    });
    await run('actual old cancellation retains historical snapshot and refuses consumption', async () => {
      await attempt.withWorkspaceMarkdownUploadAttempt(normal.selection, async access => {
        await access.retainForRecovery();
        await service.cancelWorkspaceUploadSession({ sessionId: normal.session.id, userId: 'owner', workspace });
        assert.equal((await access.inspect()).uploadStatus, 'missing');
        await assert.rejects(access.readSource(), code('MARKDOWN_UPLOAD_ATTEMPT_REFUSED_CONSUMPTION'));
        await assert.rejects(access.abandon(), code('MARKDOWN_UPLOAD_ATTEMPT_RECOVERY_REQUIRED'));
      });
      assert.deepEqual(await fs.readFile(path.join(normal.directory, 'source.bin')), normal.content);
      await attempt.withWorkspaceMarkdownUploadAttempt(normal.selection, async access => { assert.equal((await access.inspect()).state, 'retained'); });
    });
    for (const status of ['expired', 'completed'] as const) await run(`${status} original session never reanimated`, async () => {
      const entry = await fixture();
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => undefined);
      if (status === 'expired') {
        const filename = path.join(path.dirname(entry.original), 'session.json');
        const manifest = JSON.parse(await fs.readFile(filename, 'utf8')); manifest.expiresAt = '2000-01-01T00:00:00.000Z';
        await fs.writeFile(filename, JSON.stringify(manifest));
      } else {
        const filename = entry.original + '.json';
        const progress = JSON.parse(await fs.readFile(filename, 'utf8')); progress.status = 'completed';
        await fs.writeFile(filename, JSON.stringify(progress));
      }
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => {
        assert.equal((await access.inspect()).uploadStatus, status);
        await assert.rejects(access.readSource(), code('MARKDOWN_UPLOAD_ATTEMPT_REFUSED_CONSUMPTION'));
      });
    });
    await run('own abandon is durable non-destructive cleanup and retained cannot be abandoned', async () => {
      const entry = await fixture();
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { await access.abandon(); assert.equal((await access.inspect()).state, 'abandoned'); });
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => {
        await access.abandon();
        await assert.rejects(access.readSource(), code('MARKDOWN_UPLOAD_ATTEMPT_REFUSED_CONSUMPTION'));
        await assert.rejects(access.retainForRecovery(), code('MARKDOWN_UPLOAD_ATTEMPT_RECOVERY_REQUIRED'));
      });
      assert.deepEqual(await fs.readFile(path.join(entry.directory, 'source.bin')), entry.content);
    });
    await run('original source inode ABA and hardlink refused without replacing private snapshot', async () => {
      const entry = await fixture();
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => undefined);
      await fs.rename(entry.original, entry.original + '.original'); await fs.writeFile(entry.original, entry.content, { mode: 0o600 });
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => {
        assert.equal((await access.inspect()).uploadStatus, 'changed');
        await assert.rejects(access.readSource(), code('MARKDOWN_UPLOAD_ATTEMPT_REFUSED_CONSUMPTION'));
      });
      assert.deepEqual(await fs.readFile(path.join(entry.directory, 'source.bin')), entry.content);
      const linked = await fixture(); await fs.link(linked.original, linked.original + '.foreign');
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(linked.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_UNSAFE_SOURCE'));
    });
    await run('snapshot inode replacement and hardlink cannot be cleaned or consumed', async () => {
      const entry = await fixture(); await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => undefined);
      const source = path.join(entry.directory, 'source.bin');
      await fs.rename(source, source + '.original'); await fs.writeFile(source, entry.content, { mode: 0o600 });
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => access.abandon()), code('MARKDOWN_UPLOAD_ATTEMPT_SOURCE_CHANGED'));
      assert.deepEqual(await fs.readFile(source), entry.content);
      const linked = await fixture(); await attempt.withWorkspaceMarkdownUploadAttempt(linked.selection, async () => undefined);
      await fs.link(path.join(linked.directory, 'source.bin'), path.join(linked.directory, 'foreign-link'));
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(linked.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_UNSAFE_SOURCE'));
    });
    await run('two actual process callbacks serialize the same file and allow different files', async () => {
      const entry = await fixture(undefined, 2), held = start(entry.selection, true);
      await held.wait('entered\n');
      const contender = start(entry.selection); await contender.wait('ready\n'); await delay(150);
      assert.equal(contender.output().includes('entered\n'), false);
      const other = start({ ...entry.selection, fileId: entry.session.files[1].id, targetPath: entry.session.files[1].targetPath });
      await other.wait('entered\n'); await other.done;
      held.child.stdin!.end('release'); await held.done; await contender.done;
      assert.equal(contender.output().includes('entered\n'), true);
      const conflict = start({ ...entry.selection, requestId: 'different-request' }); await conflict.done;
      assert.match(conflict.output(), /MARKDOWN_UPLOAD_ATTEMPT_REQUEST_CONFLICT/);
    });
    await run('unrelated manifest entries survive without a manifest rewrite', async () => {
      const entry = await fixture(undefined, 2); await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => undefined);
      const filename = path.join(path.dirname(entry.original), 'session.json');
      const manifest = JSON.parse(await fs.readFile(filename, 'utf8')); manifest.files[1].officeAttempt = { unrelated: true };
      await fs.writeFile(filename, JSON.stringify(manifest));
      const before = await fs.readFile(filename);
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { assert.equal((await access.inspect()).uploadStatus, 'available'); });
      assert.deepEqual(await fs.readFile(filename), before);
    });
    await run('zero bytes and exact 5MiB bound use actual files; oversized opaque source refused', async () => {
      for (const size of [0, 5 * 1024 * 1024]) {
        const entry = await fixture(Buffer.alloc(size, 0xff));
        await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => {
          assert.equal((await access.inspect()).sourceBytes, size);
          assert.deepEqual(await access.readSource(), Uint8Array.from(entry.content));
        });
      }
      const large = await fixture(Buffer.alloc(5 * 1024 * 1024 + 1));
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(large.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_SOURCE_TOO_LARGE'));
      assert.equal(await fs.stat(large.directory).catch(() => null), null);
    });
    await run('source symlink and FIFO are bounded refusals; outside bytes unchanged', async () => {
      const alias = await fixture(), outside = path.join(data, 'outside-source');
      await fs.writeFile(outside, 'foreign'); await fs.unlink(alias.original); await fs.symlink(outside, alias.original);
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(alias.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'));
      assert.equal(await fs.readFile(outside, 'utf8'), 'foreign');
      const fifo = await fixture(); await fs.unlink(fifo.original);
      const made = cp.spawnSync('python3', ['-I', '-c', 'import os,sys;os.mkfifo(sys.argv[1],0o600)', fifo.original]);
      assert.equal(made.status, 0, made.stderr.toString());
      const before = Date.now();
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(fifo.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_UNSAFE_SOURCE'));
      assert.ok(Date.now() - before < 2000, 'FIFO must not wait for another writer.');
    });
    await run('original parent alias after actual copy cannot publish a birth record', async () => {
      const entry = await fixture(), sessionDir = path.dirname(entry.original), moved = sessionDir + '.moved';
      const outside = path.join(data, 'foreign-directory'); await fs.mkdir(outside);
      await assert.rejects(interceptPhase('source.bin:published', () => attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), async () => {
        await fs.rename(sessionDir, moved); await fs.symlink(outside, sessionDir);
      }), code('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'));
      assert.equal(await fs.stat(path.join(entry.directory, 'record.json')).catch(() => null), null);
      assert.deepEqual(await fs.readdir(outside), []);
      await fs.unlink(sessionDir); await fs.rename(moved, sessionDir);
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_RECOVERY_REQUIRED'));
    });
    await run('lost helper response after actual atomic record recovers without replay', async () => {
      const entry = await fixture();
      await assert.rejects(interceptPhase('record.json:published', () => attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail())), code('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'));
      const raw = await fs.readFile(path.join(entry.directory, 'record.json')), inode = (await fs.stat(path.join(entry.directory, 'source.bin'))).ino;
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { assert.deepEqual(await access.readSource(), Uint8Array.from(entry.content)); });
      assert.deepEqual(await fs.readFile(path.join(entry.directory, 'record.json')), raw);
      assert.equal((await fs.stat(path.join(entry.directory, 'source.bin'))).ino, inode);
    });
    await run('crash before record publication stays retained recovery-required', async () => {
      const entry = await fixture();
      await assert.rejects(interceptPhase('source.bin:file_synced', () => attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail())), code('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'));
      const files = await fs.readdir(entry.directory);
      assert.ok(files.some(name => name.startsWith('.source.bin.tmp-')));
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_RECOVERY_REQUIRED'));
      assert.deepEqual(await fs.readdir(entry.directory), files, 'Recovery must preserve unfamiliar partial files.');
    });
    await run('lost retained marker answer remains retained and refuses cleanup', async () => {
      const entry = await fixture(); await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => undefined);
      await assert.rejects(interceptPhase('retained.json:published', () => attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, access => access.retainForRecovery())), code('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'));
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => {
        assert.equal((await access.inspect()).state, 'retained');
        await access.retainForRecovery();
        await assert.rejects(access.abandon(), code('MARKDOWN_UPLOAD_ATTEMPT_RECOVERY_REQUIRED'));
      });
    });
    await run('actual file/directory fsync faults preserve partial/committed recovery boundaries', async () => {
      const application = path.join(data, 'fault-app'), runtime = path.join(application, 'scripts/runtime');
      await fs.mkdir(runtime, { recursive: true });
      await fs.copyFile(path.join(own, 'scripts/runtime/workspace-file-lock.py'), path.join(runtime, 'workspace-file-lock.py'));
      const realHelper = path.join(own, 'scripts/runtime/markdown-upload-attempt.py');
      const originalAppRoot = process.env.CANVAS_APP_ROOT;
      for (const kind of ['file', 'directory'] as const) {
        const entry = await fixture();
        const wrapper = `import json,os,runpy,stat,sys\noriginal_readline=sys.stdin.readline\noriginal_fsync=os.fsync\naction=''\ncount=0\nclass Input:\n def readline(self,*args):\n  global action\n  value=original_readline(*args)\n  if value.startswith('{'):\n   action=json.loads(value).get('action','')\n  return value\nsys.stdin=Input()\ndef fsync(fd):\n global count\n info=os.fstat(fd)\n wanted=stat.S_ISREG(info.st_mode) if ${kind === 'file' ? 'True' : 'False'} else stat.S_ISDIR(info.st_mode)\n if action=='stage' and wanted:\n  count+=1\n  if count==${kind === 'file' ? '1' : '2'}:\n   raise OSError(5,'Injected actual fsync failure')\n return original_fsync(fd)\nos.fsync=fsync\nrunpy.run_path(${JSON.stringify(realHelper)},run_name='__main__')\n`;
        await fs.writeFile(path.join(runtime, 'markdown-upload-attempt.py'), wrapper);
        process.env.CANVAS_APP_ROOT = application;
        try { await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED')); }
        finally { if (originalAppRoot === undefined) delete process.env.CANVAS_APP_ROOT; else process.env.CANVAS_APP_ROOT = originalAppRoot; }
        if (kind === 'file') await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_RECOVERY_REQUIRED'));
        else await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { assert.deepEqual(await access.readSource(), Uint8Array.from(entry.content)); });
      }
    });
    await run('malformed/foreign/duplicate-key records and marker cannot be trusted', async () => {
      const entry = await fixture(); await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => undefined);
      const filename = path.join(entry.directory, 'record.json'), raw = await fs.readFile(filename);
      for (const malformed of [
        { ...JSON.parse(raw.toString()), sourceBytes: true },
        { ...JSON.parse(raw.toString()), version: true },
        { ...JSON.parse(raw.toString()), extraNativeReceipt: {} },
      ]) {
        await fs.writeFile(filename, JSON.stringify(malformed));
        await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_RECORD_CHANGED'));
      }
      await fs.writeFile(filename, raw.toString().replace('"version":1', '"version":1,"version":1'));
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_RECORD_CHANGED'));
      await fs.writeFile(filename, raw);
      await fs.writeFile(path.join(entry.directory, 'abandoned.json'), JSON.stringify({ version: 1, state: 'abandoned', recordHash: 'foreign' }), { mode: 0o600 });
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_RECORD_CHANGED'));
    });
    await run('unawaited helper IO closes before file-fence release and cannot publish success', async () => {
      const entry = await fixture(); let late: Promise<unknown> | undefined;
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { late = access.readSource().catch(error => error); }), code('MARKDOWN_UPLOAD_ATTEMPT_UNAWAITED_IO'));
      assert.equal((await late) instanceof attempt.MarkdownUploadAttemptError, true);
      await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { assert.deepEqual(await access.readSource(), Uint8Array.from(entry.content)); });
    });
    await run('source change at actual copy boundary never creates a valid record', async () => {
      const entry = await fixture();
      await assert.rejects(interceptPhase('source.bin:published', () => attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), async () => {
        await fs.rename(entry.original, entry.original + '.old'); await fs.writeFile(entry.original, entry.content, { mode: 0o600 });
      }), code('MARKDOWN_UPLOAD_ATTEMPT_SOURCE_CHANGED'));
      assert.equal(await fs.stat(path.join(entry.directory, 'record.json')).catch(() => null), null);
      assert.deepEqual(await fs.readFile(entry.original), entry.content);
    });
    await run('foreign slot and copied wrong-file record are never overwritten', async () => {
      const entry = await fixture(); await fs.mkdir(entry.directory, { mode: 0o700 });
      const foreign = Buffer.from('{"foreign":true}'); await fs.writeFile(path.join(entry.directory, 'record.json'), foreign, { mode: 0o600 });
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_RECORD_CHANGED'));
      assert.deepEqual(await fs.readFile(path.join(entry.directory, 'record.json')), foreign);
      const original = await fixture(); await attempt.withWorkspaceMarkdownUploadAttempt(original.selection, async () => undefined);
      const copied = await fixture(); await fs.cp(original.directory, copied.directory, { recursive: true });
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(copied.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_REQUEST_CONFLICT'));
    });
    await run('private entry namespace swap refuses copied same-byte record', async () => {
      const entry = await fixture(); await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => undefined);
      const saved = entry.directory + '.saved'; await fs.rename(entry.directory, saved); await fs.cp(saved, entry.directory, { recursive: true });
      const before = await fs.readFile(path.join(entry.directory, 'record.json'));
      await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => access.abandon()), code('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED'));
      assert.deepEqual(await fs.readFile(path.join(entry.directory, 'record.json')), before);
      assert.equal(await fs.stat(path.join(entry.directory, 'abandoned.json')).catch(() => null), null);
    });
    await run('private store namespace swap at child publication writes no foreign store', async () => {
      const entry = await fixture(), store = path.dirname(entry.directory), saved = store + '.saved';
      try {
        await assert.rejects(interceptPhase('source.bin:published', () => attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), async () => {
          await fs.rename(store, saved); await fs.mkdir(store, { mode: 0o700 });
        }), code('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED'));
        assert.deepEqual(await fs.readdir(store), [], 'Inherited directory descriptors must not write through a replaced namespace.');
        await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), code('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED'));
      } finally { await fs.rmdir(store); await fs.rename(saved, store); }
    });
    await run('configured DATA root swap at child publication cannot publish in foreign root', async () => {
      const entry = await fixture(), saved = data + '.saved';
      try {
        await assert.rejects(interceptPhase('source.bin:published', () => attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail()), async () => {
          await fs.rename(data, saved); await fs.mkdir(data, { mode: 0o700 });
        }), namespaceClosure);
        assert.deepEqual(await fs.readdir(data), []);
      } finally { await fs.rmdir(data); await fs.rename(saved, data); }
    });
    await run('helper fd3 must be an actual DATA directory despite matching supplied scalar identity', async () => {
      const entry = await fixture(), fake = path.join(data, 'fake-root-file'); await fs.writeFile(fake, '', { mode: 0o600 });
      const handle = await fs.open(fake, 'r');
      try {
        const stat = await handle.stat();
        const child = cp.spawn('python3', ['-I', path.join(own, 'scripts/runtime/markdown-upload-attempt.py')], { stdio: ['pipe', 'pipe', 'pipe', handle.fd] });
        let output = ''; child.stdout!.on('data', bytes => { output += String(bytes); });
        const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        child.stdin!.end(JSON.stringify({ action: 'initialize', selection: entry.selection,
          key: hash(JSON.stringify([entry.selection.uploadSessionId, entry.selection.fileId])), root: { path: fake, dev: String(stat.dev), ino: String(stat.ino) } }) + '\n');
        assert.equal(await done, 1);
        assert.equal(JSON.parse(output).error, 'MARKDOWN_UPLOAD_ATTEMPT_UNSAFE_NAMESPACE');
        assert.equal(await fs.readFile(fake, 'utf8'), '');
      } finally { await handle.close(); }
    });
    await run('parallel terminal helpers produce one durable marker', async () => {
      const entry = await fixture(); await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => undefined);
      const original = cp.spawn;
      const acknowledgements: Array<() => void> = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => { clearTimeout(timer); for (const acknowledge of acknowledgements.splice(0)) acknowledge(); };
      cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
        const child = original(...args);
        if (Array.isArray(args[1]) && args[1].some(value => String(value).endsWith('/markdown-upload-attempt.py'))) {
          let latest = '', lines = '';
          child.stdout!.on('data', bytes => {
            lines += String(bytes);
            for (let end = lines.indexOf('\n'); end >= 0; end = lines.indexOf('\n')) {
              const line = lines.slice(0, end); lines = lines.slice(end + 1);
              try { const value = JSON.parse(line); if (value.stage) latest = value.stage; } catch { /* Finite helper output. */ }
            }
          });
          const write = child.stdin!.write;
          child.stdin!.write = ((chunk: unknown, ...rest: unknown[]) => {
            if (chunk === 'continue\n' && ['retained.json:file_synced', 'abandoned.json:file_synced'].includes(latest)) {
              acknowledgements.push(() => { Reflect.apply(write, child.stdin, [chunk, ...rest]); });
              if (acknowledgements.length === 2) release();
              else timer = setTimeout(release, 200);
              return true;
            }
            return Reflect.apply(write, child.stdin, [chunk, ...rest]);
          }) as typeof write;
        }
        return child;
      }) as typeof cp.spawn;
      syncBuiltinESMExports();
      try {
        await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => {
          const results = await Promise.allSettled([access.retainForRecovery(), access.abandon()]);
          const markers = (await fs.readdir(entry.directory)).filter(name => name === 'retained.json' || name === 'abandoned.json');
          assert.equal(markers.length, 1, `Actual staged/barrier helpers published contradictory markers: ${markers}`);
          assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
          const rejected = results.find(result => result.status === 'rejected');
          assert.ok(rejected?.status === 'rejected' && code('MARKDOWN_UPLOAD_ATTEMPT_RECOVERY_REQUIRED')(rejected.reason));
          assert.equal((await access.inspect()).state, 'retained');
        });
      } finally { release(); cp.spawn = original; syncBuiltinESMExports(); }
    });
    await run('callback exit verifies configured DATA', async () => {
      const entry = await fixture();
      const previous = process.env.CANVAS_DATA_ROOT;
      try {
        await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => {
          await access.inspect(); process.env.CANVAS_DATA_ROOT = path.join(data, 'different-root');
        }), namespaceClosure);
      } finally { process.env.CANVAS_DATA_ROOT = previous; }
    });
    await run('DATA directory closes under actual file fence', async () => {
      const entry = await fixture();
      const original = fs.open, resolved = await fs.realpath(data);
      const lockKey = 'markdown-upload-attempt-file-v1:' + hash(JSON.stringify([entry.selection.uploadSessionId, entry.selection.fileId]));
      const lockPath = path.join(data, 'canvas-file-locks', hash(lockKey) + '.lock');
      let checked = 0;
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]) === resolved) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            try {
              const probe = cp.spawnSync('python3', ['-I', '-c', 'import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(7)\nsys.exit(0)', lockPath]);
              assert.equal(probe.status, 7, 'The actual other process must still see the kernel fence at DATA-fd close.');
              checked++;
            } finally { await close(); }
          };
        }
        return handle;
      }) as typeof fs.open;
      try { await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { await access.inspect(); }); }
      finally { fs.open = original; }
      assert.equal(checked, 1);
    });
    await run('unawaited facade errors are observed in a real process without handlers', async () => {
      const entry = await fixture(), child = start(entry.selection, 'unawaited');
      await child.done;
      assert.match(child.output(), /MARKDOWN_UPLOAD_ATTEMPT_UNAWAITED_IO/);
    });
    await run('malformed selected manifest fields cannot copy credential objects to journal', async () => {
      for (const field of ['mimeType', 'relativePath', 'targetDir', 'createdAt']) {
        const entry = await fixture(), filename = path.join(path.dirname(entry.original), 'session.json');
        const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (field === 'mimeType' || field === 'relativePath') manifest.files[0][field] = { authorization: 'must-not-copy' };
        else manifest[field] = { authorization: 'must-not-copy' };
        await fs.writeFile(filename, JSON.stringify(manifest));
        await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => assert.fail('Malformed manifest was accepted.')), code('MARKDOWN_UPLOAD_ATTEMPT_UPLOAD_CHANGED'));
        assert.equal(await fs.stat(path.join(entry.directory, 'record.json')).catch(() => null), null);
      }
    });
    await run('actual root-target uploads and optional MIME legacy shapes retain original bytes', async () => {
      for (const mimeType of ['text/markdown', null, undefined]) {
        const entry = await fixture(undefined, 1, '.'), filename = path.join(path.dirname(entry.original), 'session.json');
        const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
        assert.equal(manifest.targetDir, '.');
        assert.equal(entry.selection.targetPath, 'original-0.md');
        if (mimeType === undefined) delete manifest.files[0].mimeType;
        else manifest.files[0].mimeType = mimeType;
        // Missing/null MIME are old-shape compatibility fixtures; root-target
        // creation, chunking and source bytes use the actual service.
        await fs.writeFile(filename, JSON.stringify(manifest));
        const before = await fs.readFile(filename);
        await attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => {
          assert.equal((await access.inspect()).uploadStatus, 'available');
          assert.deepEqual(await access.readSource(), Uint8Array.from(entry.content));
        });
        assert.deepEqual(await fs.readFile(filename), before);
      }
    });
    await run('DATA/config drift during actual directory close cannot report success', async () => {
      const entry = await fixture(), original = fs.open, resolved = await fs.realpath(data);
      const previous = process.env.CANVAS_DATA_ROOT;
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]) === resolved) {
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); process.env.CANVAS_DATA_ROOT = path.join(data, 'changed-during-close'); };
        }
        return handle;
      }) as typeof fs.open;
      try { await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { await access.inspect(); }), code('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED')); }
      finally { fs.open = original; process.env.CANVAS_DATA_ROOT = previous; }
    });
    await run('primary callback and actual close failures both survive', async () => {
      const entry = await fixture(), original = fs.open, resolved = await fs.realpath(data);
      const primary = new Error('Original callback failure'), closure = new Error('Actual DATA descriptor close failed');
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]) === resolved) {
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); throw closure; };
        }
        return handle;
      }) as typeof fs.open;
      try {
        await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async () => { throw primary; }),
          error => error instanceof AggregateError && error.errors.includes(primary) && error.errors.includes(closure));
      } finally { fs.open = original; }
    });
    await run('named DATA inode and mode drift during actual close cannot report success', async () => {
      for (const change of ['inode', 'mode']) {
        const entry = await fixture(), original = fs.open, resolved = await fs.realpath(data);
        const saved = data + '.close-saved', mode = (await fs.stat(data)).mode & 0o7777;
        let changed = false;
        fs.open = (async (...args: Parameters<typeof fs.open>) => {
          const handle = await original(...args);
          if (String(args[0]) === resolved) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close();
              if (change === 'inode') { await fs.rename(data, saved); await fs.mkdir(data, { mode: 0o700 }); }
              else await fs.chmod(data, mode ^ 0o010);
              changed = true;
            };
          }
          return handle;
        }) as typeof fs.open;
        try {
          await assert.rejects(attempt.withWorkspaceMarkdownUploadAttempt(entry.selection, async access => { await access.inspect(); }), code('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED'));
          assert.equal(changed, true);
          if (change === 'inode') assert.deepEqual(await fs.readdir(data), [], 'No foreign named root may receive writes.');
        } finally {
          fs.open = original;
          if (changed && change === 'inode') { await fs.rmdir(data); await fs.rename(saved, data); }
          if (changed && change === 'mode') await fs.chmod(data, mode);
        }
      }
    });
    console.log(`workspace-markdown-upload-attempt-test: ${passed} actual FS/process families passed; no Auth/PG/browser evidence`);
  } finally {
    const active = [...children];
    const stopped = active.map(child => new Promise<void>(resolve => child.once('close', () => resolve())));
    for (const child of active) child.kill('SIGKILL');
    await Promise.all(stopped);
    await fs.rm(data, { recursive: true, force: true });
    syncBuiltinESMExports();
  }
}
if (process.argv[2] === '--worker') void worker().catch(error => { console.error(error); process.exitCode = 1; });
else void main().catch(error => { console.error(error); process.exitCode = 1; });
