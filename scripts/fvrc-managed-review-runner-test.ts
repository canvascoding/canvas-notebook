import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runManagedReviewSuite,
  type ManagedReviewExecution,
} from './fvrc-managed-review-runner';

const command = {
  name: 'review-regression',
  executable: 'npx',
  args: ['playwright', 'test', 'tests/review.spec.ts', '--workers=1'],
} as const;

async function rejectsMessage(action: () => Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof Error && message.test(error.message));
}

async function main(): Promise<void> {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'fvrc-managed-runner-'));
  const environment = {
    ...process.env,
    E2E_EXTERNAL_SERVER: '1',
    BASE_URL: 'http://127.0.0.1:3100',
    AUTH_ORIGIN: 'http://127.0.0.1:3100',
    DATA: data,
    DATABASE_URL: 'postgresql://redacted@127.0.0.1:55433/canvas_notebook',
    FVRC_FIXTURE_ID: 'fvrc-1005',
    FVRC_WORKSPACE_ID: 'workspace-review',
    FVRC_BUILD_MARKER: 'build-1',
  };
  try {
    const order: string[] = [];
    const records = await runManagedReviewSuite({
      commands: [command, { ...command, name: 'review-collaboration' }],
      environment,
      preflight: async () => { order.push('preflight'); },
      execute: async (input): Promise<ManagedReviewExecution> => {
        order.push(input.name);
        return { exitCode: 0, output: '2 passed' };
      },
    });
    assert.deepEqual(order, ['preflight', 'review-regression', 'review-collaboration', 'review-regression', 'review-collaboration']);
    assert.deepEqual(records.map((entry) => entry.pass), [1, 1, 2, 2]);

    await rejectsMessage(() => runManagedReviewSuite({
      commands: [command], environment, preflight: async () => ({ serverMarker: 'old-build' }),
    }), /build identity mismatch/);
    await rejectsMessage(() => runManagedReviewSuite({
      commands: [{ ...command, args: ['playwright', 'test'] }], environment, preflight: async () => undefined,
    }), /--workers=1/);
    for (const output of ['1 skipped', 'HTTP 429']) {
      await rejectsMessage(() => runManagedReviewSuite({
        commands: [command], environment, preflight: async () => undefined,
        execute: async () => ({ exitCode: 0, output }),
      }), /failed gate/);
    }
    const modelIndependent = await runManagedReviewSuite({
      commands: [command], environment, preflight: async () => undefined,
      execute: async () => ({ exitCode: 0, output: 'model provider unavailable; deterministic fixture used' }),
    });
    assert.equal(modelIndependent.length, 2, 'the deterministic review suite must not depend on a reachable model');
    await rejectsMessage(() => runManagedReviewSuite({
      commands: [command], environment, preflight: async () => undefined,
      execute: async () => ({ exitCode: 2, output: 'redacted failure' }),
    }), /exit 2/);
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
  console.log('fvrc-managed-review-runner-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
