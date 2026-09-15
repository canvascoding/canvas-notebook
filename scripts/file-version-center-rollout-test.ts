import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  evaluateFileVersionCenterShadowReport,
  type FileVersionCenterShadowStorageSnapshot,
} from '../app/lib/file-version-center/rollout-report';
import {
  FILE_VERSION_CENTER_ROLLOUT_ENV_V1,
  resolveFileVersionCapabilitiesV1,
  resolveFileVersionRolloutV1,
} from '../app/lib/file-version-center/policy-v1';

const emptyStorage: FileVersionCenterShadowStorageSnapshot = {
  workspaceCount: 1,
  lineageCount: 1,
  capturedVersionCount: 3,
  uniqueBlobCount: 2,
  totalRawBytes: 30,
  totalStoredBytes: 22,
  maxRawVersionBytes: 20,
  maxStoredBlobBytes: 12,
  maxLineageStoredBytes: 22,
  maxWorkspaceStoredBytes: 22,
  maxLineageVersionCount: 3,
};

function capabilities(mode: 'off' | 'shadow' | 'read_only' | 'full') {
  return resolveFileVersionCapabilitiesV1({
    pathHint: 'docs/rollout.md',
    sizeBytes: 30,
    lineageAvailable: true,
    canRead: true,
    canWrite: true,
    rolloutMode: mode,
    backends: {
      storageReady: true,
      compareReady: true,
      restoreReady: true,
      policyReady: true,
    },
  });
}

async function main(): Promise<void> {
  assert.equal(FILE_VERSION_CENTER_ROLLOUT_ENV_V1.mode, 'FILE_VERSION_CENTER_MODE');
  assert.equal('NEXT_PUBLIC_FILE_VERSION_CENTER_MODE' in process.env, false);

  const off = resolveFileVersionRolloutV1('unexpected');
  assert.deepEqual(off, resolveFileVersionRolloutV1('off'));
  assert.deepEqual(off, resolveFileVersionRolloutV1(undefined));
  assert.equal(off.capture, false);
  assert.equal(off.visibleUi, false);
  assert.equal(off.notifications, false);

  const shadow = resolveFileVersionRolloutV1('shadow');
  assert.equal(shadow.capture, true);
  assert.equal(shadow.visibleUi, false);
  assert.equal(shadow.history, false);
  assert.equal(shadow.restore, false);
  assert.equal(shadow.notifications, false);
  assert.equal(capabilities('shadow').reason, 'rollout_disabled');

  const readOnly = resolveFileVersionRolloutV1('read_only');
  assert.equal(readOnly.capture, true);
  assert.equal(readOnly.visibleUi, true);
  assert.equal(readOnly.history, true);
  assert.equal(readOnly.compare, true);
  assert.equal(readOnly.restore, false);
  assert.equal(readOnly.policyMutation, false);
  assert.equal(readOnly.notifications, false);
  assert.equal(capabilities('read_only').history, true);
  assert.equal(capabilities('read_only').restore, false);

  const full = resolveFileVersionRolloutV1('full');
  assert.equal(full.restore, true);
  assert.equal(full.policyMutation, true);
  assert.equal(full.notifications, true);
  assert.equal(capabilities('full').restore, true);
  assert.equal(capabilities('full').agentReviewPolicy, true);

  const report = evaluateFileVersionCenterShadowReport({
    mode: 'shadow',
    storage: emptyStorage,
    captures: [{
      capturedBindingsDelta: 3,
      uniqueBlobDelta: 2,
      storedBytesDelta: 22,
      durationsMs: [15, 20, 25],
      documentAccessVerified: true,
      uiHiddenVerified: true,
    }],
    reads: [
      { operation: 'resolve', outcome: 'success', durationMs: 18 },
      { operation: 'timeline', outcome: 'success', durationMs: 24 },
    ],
  });
  assert.equal(report.passing, true);
  assert.equal(report.sample.deduplicationPercent, 33.33);
  assert.equal(report.sample.captureP95Ms, 25);

  assert.equal(evaluateFileVersionCenterShadowReport({
    mode: 'full', storage: emptyStorage, captures: [], reads: [],
  }).passing, false, 'a full-mode or empty sample is not shadow-rollout evidence');
  assert.equal(evaluateFileVersionCenterShadowReport({
    mode: 'shadow',
    storage: { ...emptyStorage, maxLineageVersionCount: 501 },
    captures: report.sample.captureRuns ? [{
      capturedBindingsDelta: 1,
      uniqueBlobDelta: 1,
      storedBytesDelta: 1,
      durationsMs: [1],
      documentAccessVerified: true,
      uiHiddenVerified: true,
    }] : [],
    reads: [{ operation: 'resolve', outcome: 'success', durationMs: 1 }],
  }).gates.lineageVersionLimit, false);

  for (const file of [
    'app/api/files/collaboration/operations/[operationId]/accept/route.ts',
    'app/api/files/collaboration/operations/[operationId]/reject/route.ts',
    'app/api/files/read/route.ts',
    'app/api/files/write/route.ts',
  ]) {
    assert.doesNotMatch(
      await readFile(file, 'utf8'),
      /FILE_VERSION_CENTER_MODE|FILE_VERSION_CENTER_ROLLOUT_ENV_V1/u,
      `${file} must stay usable while the version center is rolled back`,
    );
  }

  console.log('file-version-center-rollout-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
