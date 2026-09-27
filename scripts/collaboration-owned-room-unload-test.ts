import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

type TestDocument = { id: string };
type TestSnapshot = Readonly<{ releaseId: string }>;
type CoordinatorFactory = typeof import('../app/lib/collaboration/owned-room-unload').createOwnedRoomUnloadCoordinator;

async function loadCoordinator(): Promise<CoordinatorFactory> {
  const filename = path.resolve('app/lib/collaboration/owned-room-unload.ts');
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exports = {} as typeof import('../app/lib/collaboration/owned-room-unload');
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === 'server-only') return {};
    return createRequire(filename)(name);
  }, { exports }, exports);
  return exports.createOwnedRoomUnloadCoordinator;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const createCoordinator = await loadCoordinator();

  {
    const document = { id: 'cancelled' };
    let beginCalls = 0;
    let failures = 0;
    const coordinator = createCoordinator<TestDocument, TestSnapshot>({
      isCurrent: () => true,
      shouldUnload: () => true,
      beforeUnload: async () => { throw new Error('cancel unload'); },
      beginIdleDrain: () => { beginCalls++; throw new Error('must not begin'); },
      withMutationLock: async (_document, operation) => operation(),
      storeAndCapture: async () => ({ releaseId: 'unused' }),
      destroyCurrent() { throw new Error('must not destroy'); },
      afterUnload: async () => {},
      onFailure() { failures++; },
    });
    await coordinator.unload(document);
    assert.equal(beginCalls, 0);
    assert.equal(failures, 0);
    assert.equal(coordinator.isGated(document), false);
    console.log('PASS cancelled before-unload hook creates no terminal drain or failure retry');
  }

  {
    const document = { id: 'active-direct' };
    const neverIdle = gate();
    let beginCalls = 0;
    const coordinator = createCoordinator<TestDocument, TestSnapshot>({
      isCurrent: () => true,
      shouldUnload: () => true,
      beforeUnload: async () => {},
      beginIdleDrain: () => { beginCalls++; void neverIdle; return undefined; },
      withMutationLock: async (_document, operation) => operation(),
      storeAndCapture: async () => ({ releaseId: 'unused' }),
      destroyCurrent() { throw new Error('must not destroy'); },
      afterUnload: async () => {},
      onFailure() { throw new Error('must not fail'); },
    });
    await coordinator.unload(document);
    assert.equal(beginCalls, 1);
    assert.equal(coordinator.isGated(document), false);
    console.log('PASS active Direct activity defers unload without awaiting its own activity');
  }

  {
    const document = { id: 'late-connection' };
    const before = gate();
    let current = true;
    let shouldUnload = true;
    let beginCalls = 0;
    const coordinator = createCoordinator<TestDocument, TestSnapshot>({
      isCurrent: () => current,
      shouldUnload: () => shouldUnload,
      beforeUnload: async () => before.promise,
      beginIdleDrain: () => { beginCalls++; throw new Error('must not begin'); },
      withMutationLock: async (_document, operation) => operation(),
      storeAndCapture: async () => ({ releaseId: 'unused' }),
      destroyCurrent() { throw new Error('must not destroy'); },
      afterUnload: async () => {},
      onFailure() { throw new Error('must not fail'); },
    });
    const unloading = coordinator.unload(document);
    shouldUnload = false;
    current = true;
    before.resolve();
    await unloading;
    assert.equal(beginCalls, 0);
    console.log('PASS late connection after cancellable hook prevents terminal admission');
  }

  {
    const document = { id: 'store-retry' };
    let storeCalls = 0;
    let releaseCalls = 0;
    let destroyed = false;
    let finished = 0;
    const failures: string[] = [];
    const coordinator = createCoordinator<TestDocument, TestSnapshot>({
      isCurrent: () => !destroyed,
      shouldUnload: () => true,
      beforeUnload: async () => {},
      beginIdleDrain: () => ({
        idle: Promise.resolve(),
        async releaseDurably() { releaseCalls++; },
        finish() { finished++; },
      }),
      withMutationLock: async (_document, operation) => operation(),
      async storeAndCapture() {
        storeCalls++;
        if (storeCalls === 1) throw new Error('local after-store hook failure');
        return { releaseId: 'store-retry-release' };
      },
      destroyCurrent() { destroyed = true; },
      afterUnload: async () => {},
      onFailure(_document, _error, phase) { failures.push(phase); },
    });
    await coordinator.unload(document);
    assert.equal(destroyed, false);
    assert.equal(coordinator.isGated(document), true);
    await coordinator.unload(document);
    assert.deepEqual({ storeCalls, releaseCalls, finished, destroyed }, {
      storeCalls: 2, releaseCalls: 1, finished: 1, destroyed: true,
    });
    assert.deepEqual(failures, ['gated']);
    console.log('PASS local store-hook failure retains the gate and retries store before release');
  }

  {
    const document = { id: 'release-recovery' };
    let storeCalls = 0;
    let releaseCalls = 0;
    let firstSnapshot: TestSnapshot | undefined;
    let destroyed = false;
    const coordinator = createCoordinator<TestDocument, TestSnapshot>({
      isCurrent: () => !destroyed,
      shouldUnload: () => true,
      beforeUnload: async () => {},
      beginIdleDrain: () => ({
        idle: Promise.resolve(),
        async releaseDurably(snapshot) {
          releaseCalls++;
          firstSnapshot ??= snapshot;
          assert.equal(snapshot, firstSnapshot, 'release retry reuses the exact frozen snapshot object');
          if (releaseCalls === 1) throw new Error('receipt read unavailable');
        },
        finish() {},
      }),
      withMutationLock: async (_document, operation) => operation(),
      async storeAndCapture() { storeCalls++; return Object.freeze({ releaseId: 'same-release' }); },
      destroyCurrent() { destroyed = true; },
      afterUnload: async () => {},
      onFailure() {},
    });
    await coordinator.unload(document);
    await coordinator.unload(document);
    assert.deepEqual({ storeCalls, releaseCalls, destroyed }, { storeCalls: 1, releaseCalls: 2, destroyed: true });
    console.log('PASS receipt recovery retry is read-only over the original stored snapshot');
  }

  {
    const document = { id: 'destroy-retry' };
    let storeCalls = 0;
    let releaseCalls = 0;
    let destroyCalls = 0;
    let finished = 0;
    let destroyed = false;
    const coordinator = createCoordinator<TestDocument, TestSnapshot>({
      isCurrent: () => !destroyed,
      shouldUnload: () => true,
      beforeUnload: async () => {},
      beginIdleDrain: () => ({
        idle: Promise.resolve(),
        async releaseDurably() { releaseCalls++; },
        finish() { finished++; },
      }),
      withMutationLock: async (_document, operation) => operation(),
      async storeAndCapture() { storeCalls++; return { releaseId: 'destroy-release' }; },
      destroyCurrent() {
        destroyCalls++;
        if (destroyCalls === 1) throw new Error('local destroy failed');
        destroyed = true;
      },
      afterUnload: async () => {},
      onFailure() {},
    });
    await coordinator.unload(document);
    await coordinator.unload(document);
    assert.deepEqual({ storeCalls, releaseCalls, destroyCalls, finished, destroyed }, {
      storeCalls: 1, releaseCalls: 1, destroyCalls: 2, finished: 1, destroyed: true,
    });
    console.log('PASS post-receipt destroy retry never repeats store or durable release');
  }

  {
    const oldDocument = { id: 'old' };
    const replacement = { id: 'replacement' };
    let current = oldDocument;
    let storeCalls = 0;
    let destroyCalls = 0;
    const coordinator = createCoordinator<TestDocument, TestSnapshot>({
      isCurrent: (document) => current === document,
      shouldUnload: () => true,
      beforeUnload: async () => {},
      beginIdleDrain: () => ({ idle: Promise.resolve(), async releaseDurably() {}, finish() {} }),
      async withMutationLock(_document, operation) {
        current = replacement;
        return operation();
      },
      async storeAndCapture() { storeCalls++; return { releaseId: 'unused' }; },
      destroyCurrent() { destroyCalls++; },
      afterUnload: async () => {},
      onFailure() {},
    });
    await coordinator.unload(oldDocument);
    assert.equal(current, replacement);
    assert.equal(storeCalls, 0);
    assert.equal(destroyCalls, 0);
    assert.equal(coordinator.isGated(oldDocument), true);
    console.log('PASS exact-object replacement is never stored, deleted, or destroyed by the old drain');
  }
}

async function runBounded() {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([main(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: owned-room unload coordinator tests')), 5_000);
    })]);
    console.log('PASS all 7 owned-room unload coordinator scenarios');
  } finally {
    clearTimeout(timer);
  }
}

void runBounded().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
