import assert from 'node:assert/strict';

import {
  SYSTEM_UPDATE_CONTRACT_VERSION,
  canonicalizeSystemUpdateReleaseManifest,
  canTransitionSystemUpdateStatus,
  isTerminalSystemUpdateStatus,
  validateSystemUpdateEvent,
  validateSystemUpdateReleaseManifest,
  validateSystemUpdateSignedReleaseManifest,
} from '../cli/src/core/systemUpdateContract';

const digest = 'a'.repeat(64);
const checksum = 'b'.repeat(64);
const manifest = {
  contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
  releaseId: 'release-2026.9.4.3',
  version: '2026.9.4.3',
  channel: 'stable',
  imageRef: `ghcr.io/canvascoding/canvas-notebook@sha256:${digest}`,
  imageDigest: digest,
  cliVersion: '2026.9.4.3',
  cliArtifacts: [
    { architecture: 'amd64', url: 'https://example.com/canvas-cli-amd64.tar.gz', sha256: checksum },
    { architecture: 'arm64', url: 'https://example.com/canvas-cli-arm64.tar.gz', sha256: checksum },
  ],
  minimumVersion: '2026.9.1',
  backupRequired: false,
  releaseNotesUrl: 'https://example.com/releases/2026.9.4.3',
  publishedAt: '2026-09-04T12:00:00.000Z',
};

const validManifest = validateSystemUpdateReleaseManifest(manifest);
assert.equal(validManifest.ok, true);
if (validManifest.ok) {
  assert.equal(validManifest.value.imageDigest, digest);
  assert.equal(canonicalizeSystemUpdateReleaseManifest(validManifest.value), canonicalizeSystemUpdateReleaseManifest({
    ...validManifest.value,
    cliArtifacts: [...validManifest.value.cliArtifacts].reverse(),
  }));
}

const signedManifest = {
  manifest,
  signature: {
    algorithm: 'ed25519',
    keyId: 'canvas-release-2026-01',
    value: `${'A'.repeat(86)}==`,
  },
};
assert.equal(validateSystemUpdateSignedReleaseManifest(signedManifest).ok, true);
assert.equal(validateSystemUpdateSignedReleaseManifest({
  ...signedManifest,
  signature: { ...signedManifest.signature, algorithm: 'rsa' },
}).ok, false);
assert.equal(validateSystemUpdateSignedReleaseManifest({
  ...signedManifest,
  signature: { ...signedManifest.signature, value: 'not-base64' },
}).ok, false);

assert.equal(validateSystemUpdateReleaseManifest({ ...manifest, contractVersion: 2 }).ok, false);
assert.equal(validateSystemUpdateReleaseManifest({ ...manifest, imageRef: 'ghcr.io/canvascoding/canvas-notebook:latest' }).ok, false);
assert.equal(validateSystemUpdateReleaseManifest({ ...manifest, imageDigest: 'c'.repeat(64) }).ok, false);
assert.equal(validateSystemUpdateReleaseManifest({
  ...manifest,
  cliArtifacts: [...manifest.cliArtifacts, manifest.cliArtifacts[0]],
}).ok, false);
assert.equal(validateSystemUpdateReleaseManifest({ ...manifest, releaseNotesUrl: 'http://example.com/release' }).ok, false);

const event = {
  contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
  eventId: '3fd56ec5-6ca4-4a17-80a5-e707c8082221',
  sequence: 7,
  operationId: '8767a5c7-1a6d-4768-b760-d1c7d42fe095',
  stage: 'health_verification',
  status: 'running',
  message: 'Canvas Notebook is starting',
  occurredAt: '2026-09-04T12:05:00.000Z',
};

assert.equal(validateSystemUpdateEvent(event).ok, true);
assert.equal(validateSystemUpdateEvent({ ...event, sequence: -1 }).ok, false);
assert.equal(validateSystemUpdateEvent({ ...event, stage: 'shell_exec' }).ok, false);
assert.equal(validateSystemUpdateEvent({ ...event, errorCode: 'unknown_error' }).ok, false);

assert.equal(canTransitionSystemUpdateStatus('queued', 'preflight'), true);
assert.equal(canTransitionSystemUpdateStatus('running', 'verifying'), true);
assert.equal(canTransitionSystemUpdateStatus('succeeded', 'running'), false);
assert.equal(isTerminalSystemUpdateStatus('rolled_back'), true);
assert.equal(isTerminalSystemUpdateStatus('running'), false);

console.log('System update contract tests passed.');
