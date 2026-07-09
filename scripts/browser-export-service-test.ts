import assert from 'node:assert/strict';
import Module from 'node:module';

type BrowserExportService = typeof import('../app/lib/exports/browser-export-service');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function importBrowserExportService(): Promise<BrowserExportService> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/exports/browser-export-service');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function withBrowserExportTestEnv(run: () => Promise<void>) {
  const keys = [
    'CANVAS_BROWSER_EXPORT_MAX_QUEUE',
    'CANVAS_BROWSER_EXPORT_QUEUE_WAIT_TIMEOUT_MS',
    'CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB',
    'CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU',
  ] as const;
  const original = new Map<string, string | undefined>();
  for (const key of keys) {
    original.set(key, process.env[key]);
  }

  try {
    process.env.CANVAS_BROWSER_EXPORT_MAX_QUEUE = '1';
    process.env.CANVAS_BROWSER_EXPORT_QUEUE_WAIT_TIMEOUT_MS = '1000';
    process.env.CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB = '0';
    process.env.CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU = '0';
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function testQueueBackpressure(service: BrowserExportService) {
  await withBrowserExportTestEnv(async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();

    const first = service.runBrowserExportJob({
      label: 'first',
      timeoutMs: 1000,
      run: async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return 'first';
      },
    });

    await firstStarted.promise;

    const second = service.runBrowserExportJob({
      label: 'second',
      timeoutMs: 1000,
      run: async () => 'second',
    });

    assert.deepEqual(service.getBrowserExportQueueStatus(), {
      active: 1,
      queued: 1,
      maxActive: 1,
      maxQueued: 1,
    });

    await assert.rejects(
      service.runBrowserExportJob({
        label: 'third',
        timeoutMs: 1000,
        run: async () => 'third',
      }),
      (error) =>
        service.isBrowserExportError(error) &&
        error.code === 'BROWSER_EXPORT_QUEUE_FULL' &&
        error.status === 503,
    );

    releaseFirst.resolve();

    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.deepEqual(service.getBrowserExportQueueStatus(), {
      active: 0,
      queued: 0,
      maxActive: 1,
      maxQueued: 1,
    });
  });
}

async function testTimeoutCleanup(service: BrowserExportService) {
  await withBrowserExportTestEnv(async () => {
    let cleanupCalled = false;

    await assert.rejects(
      service.runBrowserExportJob({
        label: 'timeout',
        timeoutMs: 25,
        timeoutErrorMessage: 'PDF_TIMEOUT',
        onTimeout: () => {
          cleanupCalled = true;
        },
        run: async () => new Promise(() => undefined),
      }),
      (error) =>
        service.isBrowserExportError(error) &&
        error.code === 'BROWSER_EXPORT_TIMEOUT' &&
        error.status === 504 &&
        error.message === 'PDF_TIMEOUT',
    );

    assert.equal(cleanupCalled, true);
    assert.equal(service.getBrowserExportQueueStatus().active, 0);
  });
}

async function main() {
  const service = await importBrowserExportService();
  await testQueueBackpressure(service);
  await testTimeoutCleanup(service);
  console.log('browser-export-service-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
