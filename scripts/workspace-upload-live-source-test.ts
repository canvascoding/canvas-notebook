import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MarkdownUploadAttemptSelection } from '../app/lib/files/workspace-markdown-upload-attempt';
import type { CurrentWorkspaceUploadFileSource } from '../app/lib/files/workspace-upload-live-source';

const cwd = process.cwd(), script = path.resolve('scripts/workspace-upload-live-source-test.ts');
const children = new Set<cp.ChildProcess>();
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const codes = (error: unknown): string[] => error instanceof AggregateError ? error.errors.flatMap(codes)
  : error && typeof error === 'object' && 'code' in error ? [String(error.code)] : [];
const has = (code: string) => (error: unknown) => codes(error).includes(code);
function workspace() {
  return { workspaceId: 'live-workspace', workspaceType: 'personal' as const, rootPath: path.join(process.env.DATA!, 'workspace'), legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
}
async function worker() {
  const service = await import('../app/lib/files/workspace-upload-service');
  const live = await import('../app/lib/files/workspace-upload-live-source');
  const selection = JSON.parse(process.argv[4]) as MarkdownUploadAttemptSelection;
  const scope = { sessionId: selection.uploadSessionId, userId: selection.actorUserId, workspace: workspace() };
  process.stdout.write('ready\n');
  const entered = async () => {
    process.stdout.write('entered\n');
    if (process.argv[3].startsWith('hold')) await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));
  };
  try {
    switch (process.argv[3]) {
      case 'hold-source': await live.withCurrentWorkspaceUploadFile(selection, async source => { await source.readSource(); await entered(); await source.assertCurrent(); }); break;
      case 'hold-complete': case 'complete': await service.completeWorkspaceUploadFile({ ...scope, fileId: selection.fileId, commit: entered }); break;
      case 'cancel': await service.cancelWorkspaceUploadSession(scope); break;
      case 'cleanup': await service.cleanupExpiredWorkspaceUploadSessions(); break;
      default: assert.fail('Unknown worker action');
    }
    process.stdout.write('done\n');
  } catch (error) { process.stdout.write(JSON.stringify({ codes: codes(error) }) + '\n'); }
}
function start(action: string, selection: MarkdownUploadAttemptSelection) {
  const child = cp.spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', script, '--worker', action, JSON.stringify(selection)],
    { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); let output = '', stderr = '';
  child.stdout!.on('data', bytes => { output += String(bytes); }); child.stderr!.on('data', bytes => { stderr += String(bytes); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => { children.delete(child); if (code === 0) resolve(); else reject(new Error(`Worker ${code}: ${stderr}`)); });
  });
  const wait = async (text: string) => {
    for (let index = 0; index < 600; index++) {
      if (output.includes(text)) return;
      if (child.exitCode !== null) assert.fail(`Worker exited: ${output}${stderr}`);
      await delay(10);
    }
    assert.fail(`No worker event ${text}: ${output}`);
  };
  return { child, done, wait, output: () => output };
}
async function intercept<T>(target: string, operation: () => Promise<T>, mutation?: () => Promise<void>): Promise<T> {
  const original = cp.spawn; let fired = false;
  cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
    const child = original(...args);
    if (Array.isArray(args[1]) && args[1].some(value => String(value).endsWith('/workspace-upload-live.py'))) {
      let latest = '', buffer = '';
      child.stdout!.on('data', bytes => {
        buffer += String(bytes);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { const value = JSON.parse(line); if (value.stage) latest = value.stage; } catch { /* finite private output */ }
        }
      });
      const write = child.stdin!.write;
      child.stdin!.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!fired && chunk === 'continue\n' && latest.endsWith(target)) {
          fired = true;
          if (mutation) void mutation().then(() => Reflect.apply(write, child.stdin, [chunk, ...rest]), () => child.kill('SIGKILL'));
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
  finally { cp.spawn = original; syncBuiltinESMExports(); assert.equal(fired, true, `No actual phase ${target}`); }
}
async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-upload-live-'));
  process.env.DATA = data; process.env.CANVAS_DATA_ROOT = data;
  const service = await import('../app/lib/files/workspace-upload-service');
  const live = await import('../app/lib/files/workspace-upload-live-source');
  const ws = workspace(); await fs.mkdir(ws.rootPath);
  let passed = 0;
  const run = async (name: string, action: () => Promise<void>) => {
    if (process.env.CANVAS_UPLOAD_LIVE_TEST_CASE && name !== process.env.CANVAS_UPLOAD_LIVE_TEST_CASE) return;
    await action(); passed++; console.log('PASS ' + name);
  };
  async function fixture(count = 1) {
    const content = Buffer.from('\uFEFF---\r\ntitle: Original\r\n---\r\nText 🦊\r\n');
    const session = await service.createWorkspaceUploadSession({ userId: 'owner', workspace: ws, targetDir: '.',
      files: Array.from({ length: count }, (_, index) => ({ path: `source-${index}.md`, size: content.byteLength, mimeType: 'text/markdown' })) });
    const scope = { sessionId: session.id, userId: 'owner', workspace: ws };
    for (const file of session.files) await service.writeWorkspaceUploadChunk({ ...scope, fileId: file.id, offset: 0,
      expectedBytes: content.byteLength, body: new Blob([content]).stream() });
    const selection: MarkdownUploadAttemptSelection = { uploadSessionId: session.id, fileId: session.files[0].id,
      workspaceId: ws.workspaceId, targetPath: session.files[0].targetPath, actorUserId: 'owner', actorSessionId: 'actual-intent-session', requestId: randomUUID(), operationId: randomUUID() };
    const directory = path.join(data, '.uploads/workspace', session.id), marker = path.join(data, 'canvas-upload-live', session.id + '.terminal.json');
    return { content, session, scope, selection, directory, marker };
  }
  try {
    await run('actual initialize crash resumes only its exact fsynced private anchor', async () => {
      const scope = { sessionId: randomUUID() };
      await assert.rejects(intercept('canvas-upload-live-anchor.json:file_synced', () => live.withWorkspaceUploadLiveSession(scope, 'exclusive', async () => undefined)), has('UPLOAD_STATE_UNCONFIRMED'));
      const temporary = (await fs.readdir(data)).filter(name => /^\.canvas-upload-live-anchor\.json\.tmp-[a-f0-9]{32}$/u.test(name));
      assert.equal(temporary.length, 1);
      const before = await fs.stat(path.join(data, temporary[0])), raw = await fs.readFile(path.join(data, temporary[0]));
      await live.withWorkspaceUploadLiveSession(scope, 'exclusive', async () => undefined);
      const final = await fs.stat(path.join(data, 'canvas-upload-live-anchor.json'));
      assert.equal(final.ino, before.ino); assert.deepEqual(await fs.readFile(path.join(data, 'canvas-upload-live-anchor.json')), raw);
      assert.equal(await fs.stat(path.join(data, temporary[0])).catch(() => null), null);
    });
    await run('initialize refuses ambiguous foreign and unattributed remnants without cleanup', async () => {
      for (const variant of ['multiple', 'foreign-control', 'boolean-version', 'extra-field', 'public-mode', 'symlink', 'unknown-name', 'no-temp']) {
        const isolated = await fs.mkdtemp(path.join(data, 'anchor-negative-'));
        process.env.DATA = isolated; process.env.CANVAS_DATA_ROOT = isolated;
        try {
          const scope = { sessionId: randomUUID() };
          await assert.rejects(intercept('canvas-upload-live-anchor.json:file_synced', () => live.withWorkspaceUploadLiveSession(scope, 'exclusive', async () => undefined)), has('UPLOAD_STATE_UNCONFIRMED'));
          const temporary = (await fs.readdir(isolated)).find(name => name.startsWith('.canvas-upload-live-anchor.json.tmp-'))!;
          const filename = path.join(isolated, temporary), raw = await fs.readFile(filename), anchor = JSON.parse(raw.toString());
          if (variant === 'multiple') await fs.writeFile(path.join(isolated, '.canvas-upload-live-anchor.json.tmp-' + randomUUID().replaceAll('-', '')), raw, { mode: 0o600 });
          if (variant === 'foreign-control') await fs.writeFile(filename, JSON.stringify({ ...anchor, control: { ...anchor.control, ino: '0' } }));
          if (variant === 'boolean-version') await fs.writeFile(filename, JSON.stringify({ ...anchor, version: true }));
          if (variant === 'extra-field') await fs.writeFile(filename, JSON.stringify({ ...anchor, extra: 'foreign' }));
          if (variant === 'public-mode') await fs.chmod(filename, 0o644);
          if (variant === 'symlink') { await fs.rename(filename, filename + '.owned-old'); await fs.symlink(filename + '.owned-old', filename); }
          if (variant === 'unknown-name') await fs.rename(filename, path.join(isolated, '.canvas-upload-live-anchor.json.tmp-unknown'));
          if (variant === 'no-temp') await fs.unlink(filename);
          const before = (await fs.readdir(isolated)).sort();
          await assert.rejects(live.withWorkspaceUploadLiveSession(scope, 'exclusive', async () => assert.fail('Unconfirmed anchor must never enter a callback.')), has('UPLOAD_STATE_UNCONFIRMED'));
          assert.deepEqual((await fs.readdir(isolated)).sort(), before, 'Unattributed remnants are retained unchanged.');
          assert.equal(await fs.lstat(path.join(isolated, 'canvas-upload-live-anchor.json')).catch(() => null), null);
        } finally { process.env.DATA = data; process.env.CANVAS_DATA_ROOT = data; }
      }
    });
    await run('anchor two-link recovery requires exact original temp and final inode', async () => {
      for (const sameInode of [true, false]) {
        const isolated = await fs.mkdtemp(path.join(data, 'anchor-links-'));
        process.env.DATA = isolated; process.env.CANVAS_DATA_ROOT = isolated;
        try {
          const scope = { sessionId: randomUUID() };
          await assert.rejects(intercept('canvas-upload-live-anchor.json:file_synced', () => live.withWorkspaceUploadLiveSession(scope, 'exclusive', async () => undefined)), has('UPLOAD_STATE_UNCONFIRMED'));
          const temporary = (await fs.readdir(isolated)).find(name => name.startsWith('.canvas-upload-live-anchor.json.tmp-'))!;
          const filename = path.join(isolated, temporary), final = path.join(isolated, 'canvas-upload-live-anchor.json'), before = await fs.stat(filename), raw = await fs.readFile(filename);
          // Actual owned hardlink reconstructs the post-link/pre-unlink crash
          // state; this is a filesystem recovery fixture, not a SIGKILL there.
          if (sameInode) await fs.link(filename, final);
          else await fs.writeFile(final, raw, { mode: 0o600 });
          if (sameInode) {
            await live.withWorkspaceUploadLiveSession(scope, 'exclusive', async () => undefined);
            assert.equal((await fs.stat(final)).ino, before.ino); assert.equal((await fs.stat(final)).nlink, 1);
            assert.equal(await fs.stat(filename).catch(() => null), null); assert.deepEqual(await fs.readFile(final), raw);
          } else {
            await assert.rejects(live.withWorkspaceUploadLiveSession(scope, 'exclusive', async () => assert.fail()), has('UPLOAD_STATE_UNCONFIRMED'));
            assert.equal((await fs.stat(filename)).ino, before.ino); assert.notEqual((await fs.stat(final)).ino, before.ino);
            assert.deepEqual(await fs.readFile(final), raw);
          }
        } finally { process.env.DATA = data; process.env.CANVAS_DATA_ROOT = data; }
      }
    });
    await run('original source capsule stays current and cannot escape callback', async () => {
      const entry = await fixture(); let escaped: CurrentWorkspaceUploadFileSource | undefined;
      await live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
        escaped = source; assert.equal(source.binding.sourceHash, hash(entry.content));
        assert.equal(source.binding.sourceBytes, entry.content.byteLength);
        assert.deepEqual(await source.readSource(), Uint8Array.from(entry.content)); await source.assertCurrent();
      });
      await assert.rejects(escaped!.readSource(), has('UPLOAD_SOURCE_CLOSED'));
      assert.equal((await service.getWorkspaceUploadSession(entry.scope)).files[0].status, 'uploaded');
    });
    await run('two real processes preserve different-file parallelism and same-file exclusion', async () => {
      const entry = await fixture(2), held = start('hold-source', entry.selection);
      await held.wait('entered\n');
      const same = start('complete', entry.selection); await same.wait('ready\n'); await delay(150);
      assert.equal(same.output().includes('entered\n'), false);
      const other = start('complete', { ...entry.selection, fileId: entry.session.files[1].id, targetPath: entry.session.files[1].targetPath });
      await other.wait('entered\n'); await other.done;
      held.child.stdin!.end('release'); await held.done; await same.done;
      assert.match(same.output(), /entered/);
    });
    await run('Cancel waits for actual shared writer then durably excludes every reader', async () => {
      const entry = await fixture(), held = start('hold-source', entry.selection); await held.wait('entered\n');
      const cancel = start('cancel', entry.selection); await cancel.wait('ready\n'); await delay(150);
      assert.equal(cancel.output().includes('done\n'), false);
      held.child.stdin!.end('release'); await held.done; await cancel.done; assert.match(cancel.output(), /done/);
      await assert.rejects(service.getWorkspaceUploadSession(entry.scope), has('UPLOAD_CANCELLED'));
      await assert.rejects(service.completeWorkspaceUploadFile({ ...entry.scope, fileId: entry.selection.fileId, commit: async () => assert.fail() }), has('UPLOAD_CANCELLED'));
      await service.cancelWorkspaceUploadSession(entry.scope);
      const marker = JSON.parse(await fs.readFile(entry.marker, 'utf8')); assert.equal(marker.reason, 'cancelled');
      assert.equal(await fs.stat(entry.directory).catch(() => null), null);
    });
    await run('cancel-first wins before any new source or chunk callback', async () => {
      const entry = await fixture(); await service.cancelWorkspaceUploadSession(entry.scope);
      await assert.rejects(live.withCurrentWorkspaceUploadFile(entry.selection, async () => assert.fail()), has('UPLOAD_CANCELLED'));
      await assert.rejects(service.writeWorkspaceUploadChunk({ ...entry.scope, fileId: entry.selection.fileId, offset: 0,
        expectedBytes: entry.content.byteLength, body: new Blob([entry.content]).stream() }), has('UPLOAD_CANCELLED'));
      assert.equal(await fs.stat(entry.directory).catch(() => null), null, 'Chunk must not recreate cancelled staging.');
    });
    await run('durable marker before unlink makes GET fail closed after real helper crash', async () => {
      const entry = await fixture();
      await assert.rejects(intercept('.terminal.json:published', () => service.cancelWorkspaceUploadSession(entry.scope)), has('UPLOAD_STATE_UNCONFIRMED'));
      assert.ok(await fs.stat(entry.directory));
      await assert.rejects(service.getWorkspaceUploadSession(entry.scope), has('UPLOAD_CANCELLED'));
      const before = await fs.readFile(entry.marker);
      await service.cancelWorkspaceUploadSession(entry.scope);
      assert.deepEqual(await fs.readFile(entry.marker), before);
      assert.equal(await fs.stat(entry.directory).catch(() => null), null);
    });
    await run('crash after actual removal recovers same cancellation without recreation', async () => {
      const entry = await fixture();
      await assert.rejects(intercept('terminal:removed', () => service.cancelWorkspaceUploadSession(entry.scope)), has('UPLOAD_STATE_UNCONFIRMED'));
      assert.equal(await fs.stat(entry.directory).catch(() => null), null);
      await service.cancelWorkspaceUploadSession(entry.scope);
      await assert.rejects(service.getWorkspaceUploadSession(entry.scope), has('UPLOAD_CANCELLED'));
    });
    await run('new cleanup uses actual EX and expired journal; TTL is checked again at exit', async () => {
      const entry = await fixture(), held = start('hold-source', entry.selection); await held.wait('entered\n');
      const manifestPath = path.join(entry.directory, 'session.json'), manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.expiresAt = '2000-01-01T00:00:00.000Z'; await fs.writeFile(manifestPath, JSON.stringify(manifest));
      const cleanup = start('cleanup', entry.selection); await cleanup.wait('ready\n'); await delay(150);
      assert.ok(await fs.stat(entry.directory));
      held.child.stdin!.end('release'); await held.done; await cleanup.done;
      assert.match(held.output(), /UPLOAD_EXPIRED/);
      assert.equal(JSON.parse(await fs.readFile(entry.marker, 'utf8')).reason, 'expired');
      await assert.rejects(service.getWorkspaceUploadSession(entry.scope), has('UPLOAD_EXPIRED'));
    });
    await run('missing or unreadable legacy manifest orphans stay retained without invented birth', async () => {
      for (const malformed of [false, true]) {
        const entry = await fixture();
        if (malformed) await fs.writeFile(path.join(entry.directory, 'session.json'), '{');
        else await fs.unlink(path.join(entry.directory, 'session.json'));
        const old = new Date('2000-01-01'); await fs.utimes(entry.directory, old, old);
        await service.cleanupExpiredWorkspaceUploadSessions();
        assert.ok(await fs.stat(entry.directory), 'Intentional conservative difference from old 24h mtime orphan cleanup.');
        assert.equal(await fs.stat(entry.marker).catch(() => null), null);
      }
    });
    await run('malformed and foreign terminal record cannot authorize deletion or successful retry', async () => {
      const entry = await fixture();
      await assert.rejects(intercept('.terminal.json:published', () => service.cancelWorkspaceUploadSession(entry.scope)), has('UPLOAD_STATE_UNCONFIRMED'));
      const raw = await fs.readFile(entry.marker), record = JSON.parse(raw.toString());
      for (const change of [{ version: true }, { userId: 'other' }, { birth: { ...record.birth, directory: {} } }, { extra: 'foreign' }]) {
        await fs.writeFile(entry.marker, JSON.stringify({ ...record, ...change }));
        await assert.rejects(service.cancelWorkspaceUploadSession(entry.scope), has('UPLOAD_STATE_UNCONFIRMED'));
        assert.ok(await fs.stat(entry.directory));
      }
      await fs.writeFile(entry.marker, raw); await service.cancelWorkspaceUploadSession(entry.scope);
    });
    await run('new helpers and callbacks hold real file fence through DATA descriptor close', async () => {
      const entry = await fixture(), original = fs.open, resolved = await fs.realpath(data);
      const lockPath = path.join(data, 'canvas-upload-live', `file-${hash(JSON.stringify([entry.session.id, entry.selection.fileId]))}.lock`);
      let checked = 0;
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]) === resolved) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            try {
              const probe = cp.spawnSync('python3', ['-I', '-c', 'import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(7)\nsys.exit(0)', lockPath]);
              assert.equal(probe.status, 7, 'Actual file EX must remain held at each DATA-close boundary.'); checked++;
            } finally { await close(); }
          };
        }
        return handle;
      }) as typeof fs.open;
      try { await live.withCurrentWorkspaceUploadFile(entry.selection, async source => { await source.readSource(); }); }
      finally { fs.open = original; }
      assert.equal(checked, 2);
    });
    await run('unawaited session facade promise never escapes closure or reports success', async () => {
      const entry = await fixture(); let pending: Promise<unknown> | undefined;
      await assert.rejects(live.withWorkspaceUploadLiveSession({ sessionId: entry.session.id, userId: 'owner', workspaceId: ws.workspaceId }, 'exclusive', async lease => {
        pending = lease.cancel().catch(error => error);
      }), has('UPLOAD_UNAWAITED_IO'));
      await pending;
    });
    await run('historical malformed terminal without staging stays unconfirmed', async () => {
      const entry = await fixture(); await service.cancelWorkspaceUploadSession(entry.scope);
      const raw = await fs.readFile(entry.marker), value = JSON.parse(raw.toString());
      await fs.writeFile(entry.marker, JSON.stringify({ ...value, birth: { ...value.birth, directory: {} } }));
      await assert.rejects(service.cancelWorkspaceUploadSession(entry.scope), has('UPLOAD_STATE_UNCONFIRMED'));
      await assert.rejects(service.getWorkspaceUploadSession(entry.scope), has('UPLOAD_STATE_UNCONFIRMED'));
      assert.equal(await fs.stat(entry.directory).catch(() => null), null);
    });
    await run('named kernel sidecar inode replacement cannot stay current', async () => {
      for (const name of ['session', 'file']) {
        const entry = await fixture();
        const lockPath = path.join(data, 'canvas-upload-live', name === 'session' ? `session-${entry.session.id}.lock`
          : `file-${hash(JSON.stringify([entry.session.id, entry.selection.fileId]))}.lock`);
        await assert.rejects(live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
          await fs.rename(lockPath, lockPath + '.owned-old'); await fs.writeFile(lockPath, '', { mode: 0o600 });
          await source.assertCurrent();
        }), has('UPLOAD_STATE_UNCONFIRMED'));
        assert.equal(await fs.readFile(lockPath, 'utf8'), '');
      }
    });
    await run('ordinary missing file remains the exact old ServiceError contract', async () => {
      const entry = await fixture();
      for (const fileId of ['', randomUUID()]) {
        await assert.rejects(service.writeWorkspaceUploadChunk({ ...entry.scope, fileId, offset: 0,
          expectedBytes: 1, body: new Blob(['x']).stream() }), error => error instanceof service.WorkspaceUploadServiceError
            && error.code === 'UPLOAD_FILE_NOT_FOUND' && error.status === 404);
      }
    });
    await run('named sidecar replacement during actual close cannot report success', async () => {
      for (const name of ['session', 'file']) {
        const entry = await fixture(), original = fs.open;
        const lockPath = path.join(await fs.realpath(data), 'canvas-upload-live', name === 'session' ? `session-${entry.session.id}.lock`
          : `file-${hash(JSON.stringify([entry.session.id, entry.selection.fileId]))}.lock`);
        let replaced = false;
        fs.open = (async (...args: Parameters<typeof fs.open>) => {
          const handle = await original(...args);
          if (String(args[0]) === lockPath) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close(); await fs.rename(lockPath, lockPath + '.closed-old');
              await fs.writeFile(lockPath, '', { mode: 0o600 }); replaced = true;
            };
          }
          return handle;
        }) as typeof fs.open;
        try { await assert.rejects(live.withCurrentWorkspaceUploadFile(entry.selection, async source => { await source.readSource(); }), has('UPLOAD_STATE_UNCONFIRMED')); }
        finally { fs.open = original; }
        assert.equal(replaced, true);
      }
    });
    await run('same lease reserves exactly one file before the first actual open await', async () => {
      const entry = await fixture(2), original = fs.open;
      let release!: () => void, entered!: () => void, opened = 0;
      const barrier = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]).includes('/canvas-upload-live/file-')) { opened++; if (opened === 1) { entered(); await barrier; } }
        return handle;
      }) as typeof fs.open;
      try {
        await live.withWorkspaceUploadLiveSession({ sessionId: entry.session.id, userId: 'owner', workspaceId: ws.workspaceId }, 'shared', async lease => {
          const first = live.withWorkspaceUploadLiveFile(lease, entry.session.files[0].id, async () => undefined);
          first.catch(() => undefined); await ready;
          const second = live.withWorkspaceUploadLiveFile(lease, entry.session.files[1].id, async () => undefined);
          second.catch(() => undefined); release();
          const outcomes = await Promise.allSettled([first, second]);
          assert.equal(outcomes[0].status, 'fulfilled');
          assert.equal(outcomes[1].status, 'rejected', 'Parallel File must be refused before a second actual open.');
          if (outcomes[1].status === 'rejected') assert.ok(has('UPLOAD_LOCK_ORDER')(outcomes[1].reason));
          assert.equal(opened, 1);
        });
      } finally { release(); fs.open = original; }
    });
    await run('detached actual file callback drains before any parent fence closes', async () => {
      const entry = await fixture(), original = fs.open;
      let release!: () => void, entered!: () => void, callbackComplete = false, parentClosed = false;
      const barrier = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
      const resolved = await fs.realpath(data);
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]) === resolved) {
          const close = handle.close.bind(handle);
          handle.close = async () => { parentClosed = true; await close(); };
        }
        return handle;
      }) as typeof fs.open;
      let detached: Promise<unknown> | undefined;
      try {
        const session = live.withWorkspaceUploadLiveSession({ sessionId: entry.session.id, userId: 'owner', workspaceId: ws.workspaceId }, 'shared', async lease => {
          detached = live.withWorkspaceUploadLiveFile(lease, entry.selection.fileId, async () => { entered(); await barrier; callbackComplete = true; });
          detached.catch(() => undefined); await ready;
        });
        session.catch(() => undefined); await ready; await delay(100);
        assert.equal(parentClosed, false, 'A full detached File callback must settle before parent DATA/File/Session close.');
        release(); await assert.rejects(session, has('UPLOAD_UNAWAITED_IO')); await detached;
        assert.equal(callbackComplete, true); assert.equal(parentClosed, true);
      } finally { release(); await detached?.catch(() => undefined); fs.open = original; }
    });
    await run('once pre-close fault preserves error and confirms actual kernel fence release', async () => {
      for (const name of ['data', 'session', 'file']) {
        const entry = await fixture(), original = fs.open, fault = new Error('Owned once pre-close fault');
        const resolved = await fs.realpath(data);
        const lockPath = path.join(resolved, 'canvas-upload-live', name === 'session' || name === 'data' ? `session-${entry.session.id}.lock`
          : `file-${hash(JSON.stringify([entry.session.id, entry.selection.fileId]))}.lock`);
        let triggered = false, trackedOpen = false, closeCalls = 0, actualClose: (() => Promise<void>) | undefined;
        fs.open = (async (...args: Parameters<typeof fs.open>) => {
          const handle = await original(...args);
          if (!trackedOpen && String(args[0]) === (name === 'data' ? resolved : lockPath)) {
            trackedOpen = true;
            const close = handle.close.bind(handle); actualClose = close;
            handle.close = async () => { closeCalls++; if (!triggered) { triggered = true; throw fault; } await close(); };
          }
          return handle;
        }) as typeof fs.open;
        const contains = (error: unknown): boolean => error === fault || error instanceof AggregateError && error.errors.some(contains);
        try {
          await assert.rejects(live.withCurrentWorkspaceUploadFile(entry.selection, async source => { await source.readSource(); }), contains);
          assert.equal(triggered, true);
          assert.equal(closeCalls, 2, 'The same actual parent handle gets exactly one bounded cleanup close.');
          const probe = cp.spawnSync('python3', ['-I', '-c', 'import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(7)\nsys.exit(0)', lockPath]);
          assert.equal(probe.status, 0, 'The rejected whole callback must still release its actual original kernel fence.');
        } finally { fs.open = original; await actualClose?.(); }
      }
    });
    await run('detached delayed acquisition never starts a new callback after parent return', async () => {
      const entry = await fixture(), original = fs.open;
      let release!: () => void, entered!: () => void, callbackRan = false, detached: Promise<unknown> | undefined;
      const barrier = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]).includes('/canvas-upload-live/file-')) { entered(); await barrier; }
        return handle;
      }) as typeof fs.open;
      try {
        const session = live.withWorkspaceUploadLiveSession({ sessionId: entry.session.id, userId: 'owner', workspaceId: ws.workspaceId }, 'shared', async lease => {
          detached = live.withWorkspaceUploadLiveFile(lease, entry.selection.fileId, async () => { callbackRan = true; });
          detached.catch(() => undefined); await ready;
        });
        session.catch(() => undefined); await ready; await delay(100); release();
        await assert.rejects(session, has('UPLOAD_UNAWAITED_IO'));
        await detached?.catch(() => undefined);
        assert.equal(callbackRan, false, 'A drained acquisition may clean up, but must not first enter operation after the parent callback ends.');
      } finally { release(); await detached?.catch(() => undefined); fs.open = original; }
    });
    console.log(`workspace-upload-live-source-test: ${passed} actual FS/process families; no Auth/PG/native/API/browser proof`);
  } finally {
    const active = [...children], done = active.map(child => new Promise<void>(resolve => child.once('close', () => resolve())));
    for (const child of active) child.kill('SIGKILL'); await Promise.all(done);
    await fs.rm(data, { recursive: true, force: true }); syncBuiltinESMExports();
  }
}
if (process.argv[2] === '--worker') void worker().catch(error => { console.error(error); process.exitCode = 1; });
else void main().catch(error => { console.error(error); process.exitCode = 1; });
