import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CurrentWorkspaceUploadFileSource } from '../app/lib/files/workspace-upload-live-source';
import type { MarkdownUploadAttemptSelection } from '../app/lib/files/workspace-markdown-upload-attempt';

const codes = (error: unknown): string[] => error instanceof AggregateError ? error.errors.flatMap(codes)
  : error && typeof error === 'object' && 'code' in error ? [String(error.code)] : [];
const has = (code: string) => (error: unknown) => codes(error).includes(code);

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-markdown-chunk-live-'));
  const previous = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT };
  process.env.DATA = data; process.env.CANVAS_DATA_ROOT = data;
  let passed = 0;
  try {
    const service = await import('../app/lib/files/workspace-upload-service');
    const live = await import('../app/lib/files/workspace-upload-live-source');
    const workspace = { workspaceId: `source-${randomUUID()}`, workspaceType: 'personal' as const,
      rootPath: path.join(data, 'workspace'), legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    await fs.mkdir(workspace.rootPath);
    const fixture = async () => {
      const content = Buffer.from('\uFEFF---\r\ntitle: Own source\r\n---\r\n# Actual borrow 🦊\r\n');
      const targetPath = `${randomUUID()}.md`;
      const session = await service.createWorkspaceUploadSession({ userId: 'own-user', workspace, targetDir: '.',
        files: [{ path: targetPath, size: content.length, mimeType: 'text/markdown' }] });
      const file = session.files[0], scope = { sessionId: session.id, userId: session.userId, workspace };
      await service.writeWorkspaceUploadChunk({ ...scope, fileId: file.id, offset: 0,
        expectedBytes: content.length, body: new Blob([content]).stream() });
      const selection: MarkdownUploadAttemptSelection = { uploadSessionId: session.id, fileId: file.id,
        workspaceId: workspace.workspaceId, targetPath, actorUserId: session.userId,
        actorSessionId: `intent-${randomUUID()}`, requestId: randomUUID(), operationId: randomUUID() };
      return { content, session, file, scope, selection,
        part: path.join(data, '.uploads', 'workspace', session.id, `${file.id}.part`) };
    };
    type Entry = Awaited<ReturnType<typeof fixture>>;
    const heldFile = <T>(entry: Entry, action: () => Promise<T>) => live.withWorkspaceUploadLiveSession({
      sessionId: entry.session.id, userId: entry.session.userId, workspaceId: workspace.workspaceId,
    }, 'shared', lease => live.withWorkspaceUploadLiveFile(lease, entry.file.id, action));
    const check = async (name: string, action: () => Promise<void>) => {
      await action(); passed++; console.log(`PASS ${name}`);
    };
    const earlyLockOrder = async (attempt: () => Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      try {
        await assert.rejects(Promise.race([attempt(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Reentrant Source waited instead of rejecting its lock order.')), 2_000);
        })]), has('UPLOAD_LOCK_ORDER'));
      } finally { if (timer) clearTimeout(timer); }
      console.log(`  early lock-order rejection: ${(performance.now() - started).toFixed(1)} ms`);
    };

    await check('standalone Source rejects recursive same Source before an attempt-lock wait', async () => {
      const entry = await fixture(); let escaped: CurrentWorkspaceUploadFileSource | undefined;
      await live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
        escaped = source;
        assert.deepEqual(await source.readSource(), Uint8Array.from(entry.content));
        await earlyLockOrder(() => live.withCurrentWorkspaceUploadFile(entry.selection, async () => assert.fail('Recursive source callback entered.')));
        await source.assertCurrent();
      });
      await assert.rejects(escaped!.readSource(), has('UPLOAD_SOURCE_CLOSED'));
      await assert.rejects(escaped!.assertCurrent(), has('UPLOAD_SOURCE_CLOSED'));
      assert.deepEqual(await fs.readFile(entry.part), entry.content);
    });

    await check('actual Complete callback borrows its existing SessionSH and FileEX', async () => {
      const entry = await fixture(); let entered = false, escaped: CurrentWorkspaceUploadFileSource | undefined;
      const result = await service.completeWorkspaceUploadFile({ ...entry.scope, fileId: entry.file.id,
        commit: async ({ file, sourcePath }) => {
          assert.equal(file.id, entry.file.id); assert.equal(sourcePath, entry.part);
          await live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
            entered = true; escaped = source;
            assert.deepEqual(await source.readSource(), Uint8Array.from(entry.content)); await source.assertCurrent();
          });
        } });
      assert(entered); assert.equal(result.file.status, 'completed');
      await assert.rejects(escaped!.readSource(), has('UPLOAD_SOURCE_CLOSED'));
      assert.equal(await fs.stat(path.join(workspace.rootPath, entry.selection.targetPath)).catch(() => null), null,
        'This upload-only fixture publishes no native or target document.');
    });

    await check('two concurrent borrowed Sources reserve synchronously and sequential reuse survives', async () => {
      const entry = await fixture(); let callbacks = 0;
      await heldFile(entry, async () => {
        const first = live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
          callbacks++; assert.deepEqual(await source.readSource(), Uint8Array.from(entry.content));
        });
        await earlyLockOrder(() => live.withCurrentWorkspaceUploadFile(entry.selection, async () => assert.fail('Second concurrent callback entered.')));
        await first;
        await live.withCurrentWorkspaceUploadFile(entry.selection, async source => { callbacks++; await source.assertCurrent(); });
      });
      assert.equal(callbacks, 2); assert.deepEqual(await fs.readFile(entry.part), entry.content);
    });

    await check('borrow failure closes its capsule and resets only its Source reservation', async () => {
      const entry = await fixture(); const ownFailure = new Error('Owned callback failure');
      let escaped: CurrentWorkspaceUploadFileSource | undefined;
      await heldFile(entry, async () => {
        await assert.rejects(live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
          escaped = source; await source.assertCurrent(); throw ownFailure;
        }), error => error === ownFailure);
        await assert.rejects(escaped!.assertCurrent(), has('UPLOAD_SOURCE_CLOSED'));
        await live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
          assert.deepEqual(await source.readSource(), Uint8Array.from(entry.content));
        });
      });
    });

    for (const borrow of [false, true]) {
      const execute = <T>(entry: Entry, action: () => Promise<T>) => borrow ? heldFile(entry, action) : action();
      await check(`${borrow ? 'borrowed' : 'standalone'} Source refuses detached upload ancestor with copied equal bytes`, async () => {
        const entry = await fixture(), uploads = path.join(data, '.uploads'), detached = path.join(data, `.uploads-detached-${randomUUID()}`);
        await execute(entry, async () => {
          await assert.rejects(live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
            await source.assertCurrent(); await fs.rename(uploads, detached);
            try {
              await fs.cp(detached, uploads, { recursive: true, preserveTimestamps: true });
              assert.deepEqual(await fs.readFile(entry.part), entry.content);
              await source.assertCurrent();
            } finally { await fs.rm(uploads, { recursive: true, force: true }); await fs.rename(detached, uploads); }
          }), has('UPLOAD_STATE_UNCONFIRMED'));
        });
        assert.deepEqual(await fs.readFile(entry.part), entry.content);
      });
      await check(`${borrow ? 'borrowed' : 'standalone'} Source refuses terminal or incomplete progress`, async () => {
        // LiveSource pins the actual part and current progress values. An equal
        // replacement progress inode is a separate, stricter I04 birth claim.
        for (const terminal of [false, true]) {
          const entry = await fixture(), progress = `${entry.part}.json`, detached = `${progress}.detached-${randomUUID()}`;
          const bytes = await fs.readFile(progress), originalInode = (await fs.stat(progress)).ino;
          const changed = { ...JSON.parse(bytes.toString('utf8')),
            ...(terminal ? { status: 'completed' } : { uploadedBytes: entry.content.length - 1 }) };
          await execute(entry, async () => {
            await assert.rejects(live.withCurrentWorkspaceUploadFile(entry.selection, async source => {
              await source.assertCurrent(); await fs.rename(progress, detached);
              try {
                await fs.writeFile(progress, JSON.stringify(changed), { mode: 0o600, flag: 'wx' });
                assert.notEqual((await fs.stat(progress)).ino, originalInode);
                await source.assertCurrent();
              } finally { await fs.rm(progress, { force: true }); await fs.rename(detached, progress); }
            }), has('UPLOAD_FILE_INCOMPLETE'));
          });
          assert.equal((await fs.stat(progress)).ino, originalInode);
          assert.deepEqual(await fs.readFile(progress), bytes);
          assert.deepEqual(await fs.readFile(entry.part), entry.content);
        }
      });
    }
    console.log(`markdown-chunk-live-source-test: ok (${passed} actual local FS/Helper families; no Auth/PG/target publication)`);
  } finally {
    for (const key of ['DATA', 'CANVAS_DATA_ROOT'] as const) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await fs.rm(data, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
