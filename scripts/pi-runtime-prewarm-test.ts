import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canvas-pi-runtime-prewarm-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_DEPLOYMENT_MODE = 'single_user';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const firstRuntimeStarted = deferred();
const releaseFirstRuntime = deferred();
const callOrder: string[] = [];
let runtimeCalls = 0;
const status = {
  sessionId: 'session-prewarm',
  phase: 'idle' as const,
  activeTool: null,
  pendingToolCalls: 0,
  followUpQueue: [],
  steeringQueue: [],
  canAbort: false,
  contextWindow: 128_000,
  estimatedHistoryTokens: 0,
  availableHistoryTokens: 128_000,
  contextUsagePercent: 0,
  includedSummary: false,
  omittedMessageCount: 0,
  summaryUpdatedAt: null,
  lastCompactionAt: null,
  lastCompactionKind: null,
  lastCompactionOmittedCount: 0,
};
const fakeRuntime = { getStatus: () => status };

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/pi/live-runtime') {
    return {
      getExistingPiRuntimeStatuses: async () => new Map(),
      getExistingPiRuntime: async () => null,
      getOrCreatePiRuntime: async () => fakeRuntime,
      getOrCreatePiRuntimeWithState: async () => {
        runtimeCalls += 1;
        callOrder.push(`runtime:${runtimeCalls}:start`);
        if (runtimeCalls === 1) {
          firstRuntimeStarted.resolve();
          await releaseFirstRuntime.promise;
        }
        callOrder.push(`runtime:${runtimeCalls}:end`);
        return { runtime: fakeRuntime, created: runtimeCalls === 1 };
      },
      getPiRuntimeStatus: async () => null,
      invalidatePiRuntime: async () => false,
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { prewarmSessionRuntime } = await import('../app/lib/pi/runtime-service');

  const first = prewarmSessionRuntime('session-prewarm', 'user-prewarm');
  await firstRuntimeStarted.promise;
  const second = prewarmSessionRuntime('session-prewarm', 'user-prewarm');
  await Promise.resolve();
  assert.deepEqual(callOrder, ['runtime:1:start']);

  releaseFirstRuntime.resolve();
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.equal(firstStatus, status);
  assert.equal(secondStatus, status);
  assert.deepEqual(callOrder, [
    'runtime:1:start',
    'runtime:1:end',
    'runtime:2:start',
    'runtime:2:end',
  ]);

  console.log('pi-runtime-prewarm-test: ok');
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  });
