import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function runStoreWorker(dataRoot: string, worker: number): Promise<void> {
  const program = `
    import { storeToolOutput } from './app/lib/pi/tool-output-store';
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => storeToolOutput({
      identity: { organizationId: 'org-a', userId: 'user-a', sessionId: 'multi-process' },
      toolCallId: 'worker-${worker}-' + index,
      content: 'x'.repeat(4 * 1024 * 1024),
      format: 'text',
    })));
    process.exitCode = results.some((result) => !result.ok && !/quota exceeded|session is busy/u.test(result.error)) ? 1 : 0;
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--conditions', 'react-server', '-e', program], {
      cwd: process.cwd(),
      env: { ...process.env, CANVAS_DATA_ROOT: dataRoot },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`worker ${worker} failed`)));
  });
}

async function run(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tool-output-store-'));
  const oldData = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  try {
    const store = await import('../app/lib/pi/tool-output-store');
    const identity = { organizationId: 'org-a', userId: 'user-a', sessionId: 'session-a' };
    const foreignIdentity = { ...identity, sessionId: 'session-b' };
    const content = `first\n${'middle detail '.repeat(300)}\nlast`;
    const stored = await store.storeToolOutput({
      identity,
      toolCallId: 'provider/opaque:call-a',
      content,
      format: 'text',
      source: { url: 'https://example.test/source', title: 'Example', provider: 'test' },
    });
    if (!stored.ok) throw new Error(stored.error);
    assert.equal(stored.ok, true);
    assert.match(stored.reference, /^tool-output:\/\/call-[a-f0-9]{64}\/output-[a-f0-9]{32}\.txt$/u);
    assert.equal((await store.readStoredToolOutput(identity, stored.reference)).content, content, 'middle data must survive persisted reads');
    const secondForSameCall = await store.storeToolOutput({
      identity,
      toolCallId: 'provider/opaque:call-a',
      content: 'second source returned by the same tool call',
      format: 'text',
    });
    if (!secondForSameCall.ok) throw new Error(secondForSameCall.error);
    assert.equal(
      secondForSameCall.reference.slice(0, secondForSameCall.reference.lastIndexOf('/')),
      stored.reference.slice(0, stored.reference.lastIndexOf('/')),
      'one call may persist multiple provider sources without reusing a filename',
    );

    // A fresh dynamic module evaluation must read the same on-disk reference.
    const restartedStore = await import(`../app/lib/pi/tool-output-store?restart=${Date.now()}`);
    assert.equal((await restartedStore.readStoredToolOutput(identity, stored.reference)).content, content);
    assert.match((await store.readStoredToolOutput(identity, stored.manifestReference)).content, /"source"/u);
    const relocatedRoot = `${dataRoot}-relocated`;
    await fs.rename(dataRoot, relocatedRoot);
    process.env.CANVAS_DATA_ROOT = relocatedRoot;
    try {
      assert.equal((await store.readStoredToolOutput(identity, stored.reference)).content, content, 'references survive restoring DATA at another location');
    } finally {
      await fs.rename(relocatedRoot, dataRoot);
      process.env.CANVAS_DATA_ROOT = dataRoot;
    }
    await assert.rejects(() => store.readStoredToolOutput(foreignIdentity, stored.reference), /not found/u);
    await assert.rejects(() => store.resolveToolOutputReference(identity, 'tool-output://call-any/../manifest.json'), /Invalid/u);

    const outside = path.join(dataRoot, 'outside.txt');
    await fs.writeFile(outside, 'outside');
    const callDirectory = path.dirname(await store.resolveToolOutputReference(identity, stored.reference));
    await fs.symlink(outside, path.join(callDirectory, 'output-00000000000000000000000000000000.txt'));
    await assert.rejects(
      () => store.resolveToolOutputReference(identity, `${stored.reference.slice(0, stored.reference.lastIndexOf('/') + 1)}output-00000000000000000000000000000000.txt`),
      /private regular file/u,
    );
    await fs.unlink(path.join(callDirectory, 'output-00000000000000000000000000000000.txt'));

    const parentLinkIdentity = { ...identity, sessionId: 'parent-link' };
    const parentLinkDirectory = store.getToolOutputSessionDirectory(parentLinkIdentity);
    await fs.symlink(path.dirname(callDirectory), parentLinkDirectory);
    await assert.rejects(
      () => store.resolveToolOutputReference(parentLinkIdentity, stored.reference),
      /non-symlink directory/u,
      'a symlink in the identity path must never escape into another session',
    );
    await fs.unlink(parentLinkDirectory);

    const oversizedJson = await store.storeToolOutput({
      identity,
      toolCallId: 'too-large',
      content: JSON.stringify({ payload: 'x'.repeat(4 * 1024 * 1024) }),
      format: 'json',
    });
    assert.equal(oversizedJson.ok, false);
    if (!oversizedJson.ok) assert.match(oversizedJson.error, /per-file limit/u);
    const oversizedManifest = await store.storeToolOutput({
      identity, toolCallId: 'huge-metadata', content: 'small', format: 'text', source: { url: 'u'.repeat(4 * 1024 * 1024) },
    });
    assert.equal(oversizedManifest.ok, false);
    if (!oversizedManifest.ok) assert.match(oversizedManifest.error, /per-file limit/u);
    assert.equal(await store.inspectToolOutputUsage(identity).then((usage) => usage.files), 4);

    const excluded = await store.storeToolOutput({
      identity,
      toolCallId: 'later-call',
      content: 'must not be visible in the fork',
      format: 'text',
    });
    assert.equal(excluded.ok, true);

    const writers = await Promise.all(Array.from({ length: 8 }, (_, index) => store.storeToolOutput({
      identity: { ...identity, sessionId: 'concurrent' },
      toolCallId: `call-${index}`,
      content: 'x'.repeat(3 * 1024 * 1024),
      format: 'text',
    })));
    assert.equal(writers.filter((result) => result.ok).length, 8, 'concurrent writers must serialize without corrupting quota accounting');
    let quotaOverflow: Awaited<ReturnType<typeof store.storeToolOutput>> | undefined;
    for (let index = 0; index < 10; index += 1) {
      const result = await store.storeToolOutput({
        identity: { ...identity, sessionId: 'concurrent' },
        toolCallId: `quota-fill-${index}`,
        content: 'x'.repeat(4 * 1024 * 1024),
        format: 'text',
      });
      if (!result.ok) {
        quotaOverflow = result;
        break;
      }
    }
    assert.ok(quotaOverflow && !quotaOverflow.ok, 'writes beyond the aggregate quota must fail');
    assert.match(quotaOverflow.error, /quota exceeded/u);

    // A crash can leave the lock file itself behind, but flock is attached to
    // the dead process's descriptor and therefore a later writer must proceed.
    const staleIdentity = { ...identity, sessionId: 'stale-lock' };
    const staleLockName = createHash('sha256')
      .update(JSON.stringify([staleIdentity.organizationId, staleIdentity.userId, staleIdentity.sessionId]))
      .digest('hex');
    await fs.writeFile(path.join(store.getToolOutputRoot(), '.locks', `${staleLockName}.lock`), 'stale', { mode: 0o600 });
    const afterCrash = await store.storeToolOutput({ identity: staleIdentity, toolCallId: 'after-crash', content: 'available', format: 'text' });
    assert.equal(afterCrash.ok, true, 'an unheld stale lockfile must not block later writers');

    await Promise.all(Array.from({ length: 4 }, (_, worker) => runStoreWorker(dataRoot, worker)));
    const multiProcessUsage = await store.inspectToolOutputUsage({ ...identity, sessionId: 'multi-process' });
    assert.ok(multiProcessUsage.bytes <= 64 * 1024 * 1024, 'multiple processes must never overrun the session quota');

    const cloneIdentity = { ...identity, sessionId: 'clone' };
    await store.cloneToolOutputs(identity, cloneIdentity, { references: [stored.reference] });
    assert.equal((await store.readStoredToolOutput(cloneIdentity, stored.reference)).content, content);
    if (excluded.ok) await assert.rejects(
      () => store.readStoredToolOutput(cloneIdentity, excluded.reference),
      /not found/u,
      'a selective clone must not expose output produced after its fork point',
    );
    await assert.rejects(
      () => store.readStoredToolOutput(cloneIdentity, secondForSameCall.reference),
      /not found/u,
      'a selective clone must copy only its selected output/manifest pair',
    );
    await store.deleteToolOutputs(identity);
    assert.equal((await store.readStoredToolOutput(cloneIdentity, stored.reference)).content, content, 'clone must not share source files');
    await store.deleteToolOutputs(identity);
    await store.deleteToolOutputs(cloneIdentity);
    await store.deleteToolOutputs(cloneIdentity);
    console.log('tool-output-store-test: ok');
  } finally {
    if (oldData === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = oldData;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
