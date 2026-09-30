import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serverPreferencesPath } from '../app/lib/terminal-policy';
import {
  proposalReviewWritesEnabled,
  resolveProposalReviewCapability,
} from '../app/lib/file-version-center/proposal-review-capability';

const envKeys = [
  'NODE_ENV',
  'CANVAS_PROPOSAL_GRAPH_MODE',
  'CANVAS_PROPOSAL_GRAPH_WORKSPACE_IDS',
  'CANVAS_PROPOSAL_REVIEW_LOCAL_TEST',
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const testEnvironment: Record<string, string | undefined> = process.env;
const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-proposal-capability-'));
const previousDataRoot = process.env.CANVAS_DATA_ROOT;
process.env.CANVAS_DATA_ROOT = dataRoot;

function setEnv(values: Partial<Record<(typeof envKeys)[number], string | undefined>>): void {
  for (const key of envKeys) {
    const value = values[key];
    if (value === undefined) delete testEnvironment[key];
    else testEnvironment[key] = value;
  }
}

function result(workspaceId?: string) {
  return resolveProposalReviewCapability(workspaceId === undefined ? undefined : { workspaceId });
}

try {
  setEnv({ NODE_ENV: 'test' });
  assert.deepEqual(result('workspace-1'), { mode: 'off', enabled: false, reason: 'feature_disabled' });
  assert.equal(proposalReviewWritesEnabled({ workspaceId: 'workspace-1' }), false);
  assert.equal(proposalReviewWritesEnabled(), false);
  setEnv({ NODE_ENV: 'production', CANVAS_PROPOSAL_GRAPH_MODE: 'full' });
  assert.deepEqual(result('workspace-1'), { mode: 'off', enabled: false, reason: 'feature_disabled' },
    'the instance switch dominates an old explicit rollout');
  mkdirSync(path.dirname(serverPreferencesPath()), { recursive: true });
  writeFileSync(serverPreferencesPath(), JSON.stringify({ version: 1, settings: { documentReviewEnabled: true } }));

  setEnv({ NODE_ENV: 'production' });
  assert.deepEqual(result('workspace-1'), { mode: 'full', enabled: true, reason: 'enabled' },
    'an enabled instance works without legacy graph environment variables');
  assert.deepEqual(result(), { mode: 'full', enabled: false, reason: 'invalid_workspace' });

  for (const nodeEnv of ['development', 'test']) {
    setEnv({ NODE_ENV: nodeEnv, CANVAS_PROPOSAL_REVIEW_LOCAL_TEST: '1' });
    assert.deepEqual(result('workspace-1'), { mode: 'local_test', enabled: true, reason: 'enabled' });
    assert.equal(proposalReviewWritesEnabled({ workspaceId: 'workspace-1' }), true);
  }
  assert.deepEqual(result(), { mode: 'local_test', enabled: false, reason: 'invalid_workspace' });
  assert.equal(proposalReviewWritesEnabled({ workspaceId: '*' }), false);

  setEnv({ NODE_ENV: 'production', CANVAS_PROPOSAL_REVIEW_LOCAL_TEST: '1' });
  assert.deepEqual(result('workspace-1'), {
    mode: 'off', enabled: false, reason: 'local_test_environment_required',
  });
  setEnv({ CANVAS_PROPOSAL_REVIEW_LOCAL_TEST: '1' });
  assert.deepEqual(result('workspace-1'), {
    mode: 'off', enabled: false, reason: 'local_test_environment_required',
  });
  setEnv({ CANVAS_PROPOSAL_REVIEW_LOCAL_TEST: '1', CANVAS_PROPOSAL_GRAPH_MODE: 'off' });
  assert.deepEqual(result('workspace-1'), { mode: 'off', enabled: false, reason: 'explicitly_off' });

  setEnv({ NODE_ENV: 'production', CANVAS_PROPOSAL_GRAPH_MODE: 'full' });
  assert.deepEqual(result('workspace-1'), { mode: 'full', enabled: true, reason: 'enabled' });
  assert.deepEqual(result(), { mode: 'full', enabled: false, reason: 'invalid_workspace' });
  for (const invalidWorkspace of ['', '*', 'workspace/1', `${'a'.repeat(129)}`]) {
    assert.equal(proposalReviewWritesEnabled({ workspaceId: invalidWorkspace }), false);
  }

  setEnv({ CANVAS_PROPOSAL_GRAPH_MODE: 'canary', CANVAS_PROPOSAL_GRAPH_WORKSPACE_IDS: 'workspace-1, workspace-2' });
  assert.deepEqual(result('workspace-1'), { mode: 'canary', enabled: true, reason: 'enabled' });
  assert.deepEqual(result('workspace-10'), {
    mode: 'canary', enabled: false, reason: 'workspace_not_allowlisted',
  });
  setEnv({ CANVAS_PROPOSAL_GRAPH_MODE: 'canary' });
  assert.deepEqual(result('workspace-1'), {
    mode: 'canary', enabled: false, reason: 'workspace_not_allowlisted',
  });

  setEnv({ CANVAS_PROPOSAL_GRAPH_MODE: 'future' });
  assert.deepEqual(result('workspace-1'), { mode: 'off', enabled: false, reason: 'invalid_mode' });

  for (const allowlist of ['', 'workspace-1,,workspace-2', '*', 'prefix*', `${'x'.repeat(32_769)}`]) {
    setEnv({ CANVAS_PROPOSAL_GRAPH_MODE: 'full', CANVAS_PROPOSAL_GRAPH_WORKSPACE_IDS: allowlist });
    assert.deepEqual(result('workspace-1'), { mode: 'off', enabled: false, reason: 'invalid_allowlist' });
  }
  const tooManyEntries = Array.from({ length: 257 }, (_, index) => `workspace-${index}`).join(',');
  setEnv({ CANVAS_PROPOSAL_GRAPH_MODE: 'canary', CANVAS_PROPOSAL_GRAPH_WORKSPACE_IDS: tooManyEntries });
  assert.deepEqual(result('workspace-1'), { mode: 'off', enabled: false, reason: 'invalid_allowlist' });

  const maxEntries = Array.from({ length: 256 }, (_, index) => `workspace-${index}`).join(',');
  setEnv({ CANVAS_PROPOSAL_GRAPH_MODE: 'canary', CANVAS_PROPOSAL_GRAPH_WORKSPACE_IDS: maxEntries });
  assert.equal(result('workspace-255').enabled, true);
} finally {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete testEnvironment[key];
    else testEnvironment[key] = value;
  }
  if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
  else process.env.CANVAS_DATA_ROOT = previousDataRoot;
  rmSync(dataRoot, { recursive: true, force: true });
}

console.log('proposal-review-capability-test: ok');
