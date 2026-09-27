import assert from 'node:assert/strict';

import { resolveLocalCollaborationRoomOwnerOptions } from '../app/lib/collaboration/room-owner-local-test';

const KEYS = [
  'NODE_ENV',
  'COLLABORATION_E2E',
  'CANVAS_PROPOSAL_REVIEW_LOCAL_TEST',
  'CANVAS_PROPOSAL_CRASH_TEST',
  'CANVAS_COLLABORATION_MULTIPROCESS_TEST',
  'CANVAS_DATABASE_PROVIDER',
  'DATABASE_URL',
  'HOSTNAME',
  'PORT',
  'BASE_URL',
] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const mutableEnv = process.env as Record<string, string | undefined>;

function setLocal(overrides: Partial<Record<(typeof KEYS)[number], string | undefined>> = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    COLLABORATION_E2E: '1',
    CANVAS_PROPOSAL_REVIEW_LOCAL_TEST: '1',
    CANVAS_PROPOSAL_CRASH_TEST: '1',
    CANVAS_COLLABORATION_MULTIPROCESS_TEST: '1',
    CANVAS_DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgresql://local:secret@127.0.0.1:55433/canvas_notebook',
    HOSTNAME: '127.0.0.1',
    PORT: '3101',
    BASE_URL: 'http://127.0.0.1:3000',
  }, overrides);
}

try {
  delete process.env.CANVAS_COLLABORATION_MULTIPROCESS_TEST;
  assert.equal(resolveLocalCollaborationRoomOwnerOptions(), undefined,
    'the regular bootstrap must remain owner-disabled');

  setLocal();
  const options = resolveLocalCollaborationRoomOwnerOptions();
  assert.equal(typeof options?.createSession, 'function');
  assert.equal(typeof options?.recoverRelease, 'function');
  assert.equal(typeof options?.admission.pendingDrains, 'function');
  assert.equal(typeof options?.admission.readDrain, 'function');
  assert.equal(options?.heartbeatMs, 100);
  assert.equal(options?.admission.pollMs, 100);

  for (const invalid of [
    { NODE_ENV: 'production' },
    { PORT: '3000' },
    { HOSTNAME: '0.0.0.0' },
    { BASE_URL: 'http://127.0.0.1:3101' },
    { DATABASE_URL: 'postgresql://local:secret@example.com:5432/canvas_notebook' },
    { DATABASE_URL: 'postgresql://local:secret@127.0.0.1:55433/other' },
    { CANVAS_PROPOSAL_CRASH_TEST: '0' },
  ]) {
    setLocal(invalid);
    assert.throws(() => resolveLocalCollaborationRoomOwnerOptions(), /requires|accepts/u);
  }

  console.log('Local multi-process room-owner bootstrap is disabled by default and hard-fenced to the managed acceptance stack.');
} finally {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else mutableEnv[key] = value;
  }
}
