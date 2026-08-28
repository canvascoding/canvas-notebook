import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildControlPlaneReleasePayload,
  signControlPlaneReleasePayload,
} from './control-plane-release-payload.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const cliSha256 = 'b'.repeat(64);
const env = {
  MERGE_TAG: 'v2026.7.11.1',
  GHCR_IMAGE: 'ghcr.io/canvascoding/canvas-notebook',
  IMAGE_DIGEST: digest,
  HOST_CLI_VERSION: 'v2026.7.11.1',
  HOST_CLI_SHA256: cliSha256,
  LINUX_CLI_AMD64_SHA256: 'e'.repeat(64),
  LINUX_CLI_ARM64_SHA256: 'f'.repeat(64),
  GITHUB_REPOSITORY: 'canvascoding/canvas-notebook',
  GITHUB_REF: 'refs/tags/v2026.7.11.1',
  GITHUB_SHA: 'c'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_NUMBER: '45',
  GITHUB_RUN_ATTEMPT: '1',
};
const payload = buildControlPlaneReleasePayload(env, '2026.7.11.1', '2026-07-11T00:00:00.000Z');
assert.equal(payload.image.digest, digest);
assert.deepEqual(payload.cliArtifact, { version: 'v2026.7.11.1', sha256: cliSha256 });
assert.deepEqual(payload.linuxCli, {
  amd64: { filename: 'canvas-notebook-linux-cli-amd64.tar.gz', sha256: 'e'.repeat(64) },
  arm64: { filename: 'canvas-notebook-linux-cli-arm64.tar.gz', sha256: 'f'.repeat(64) },
});
assert.equal(payload.image.tags.includes('ghcr.io/canvascoding/canvas-notebook:v2026.7.11.1'), true);
const buildProvenance = buildControlPlaneReleasePayload({
  ...env,
  RELEASE_BUILD_RUN_ID: '678',
  RELEASE_BUILD_RUN_NUMBER: '90',
  RELEASE_BUILD_RUN_ATTEMPT: '2',
}, '2026.7.11.1');
assert.deepEqual(buildProvenance.workflow, { runId: '678', runNumber: '90', runAttempt: '2' });
const body = JSON.stringify(payload);
assert.equal(
  signControlPlaneReleasePayload('release-secret', '1720000000', body),
  signControlPlaneReleasePayload('release-secret', '1720000000', body),
);
assert.throws(
  () => buildControlPlaneReleasePayload({ ...env, IMAGE_DIGEST: '' }, '2026.7.11.1'),
  /digest/u,
);
assert.throws(
  () => buildControlPlaneReleasePayload({ ...env, HOST_CLI_SHA256: 'bad' }, '2026.7.11.1'),
  /host CLI/u,
);
assert.throws(
  () => buildControlPlaneReleasePayload({ ...env, LINUX_CLI_ARM64_SHA256: 'bad' }, '2026.7.11.1'),
  /Linux CLI/u,
);
assert.throws(
  () => buildControlPlaneReleasePayload(env, '2026.7.11.2'),
  /does not match package version/u,
);
const rebuilt = buildControlPlaneReleasePayload({
  ...env,
  MERGE_TAG: 'latest',
  GITHUB_REF: 'refs/heads/main',
  RELEASE_REF: 'refs/tags/v2026.7.11.1',
  RELEASE_TAG: 'v2026.7.11.1',
  RELEASE_COMMIT_SHA: 'd'.repeat(40),
  HOST_CLI_SHA256: '',
}, '2026.7.11.1');
assert.equal(rebuilt.event, 'image_rebuilt');
assert.equal(rebuilt.cliArtifact, undefined);
assert.equal(rebuilt.linuxCli, undefined);
assert.equal(rebuilt.image.digest, digest);
assert.equal(rebuilt.ref, 'refs/tags/v2026.7.11.1');
assert.equal(rebuilt.tag, 'v2026.7.11.1');
assert.equal(rebuilt.commitSha, 'd'.repeat(40));
assert.deepEqual(rebuilt.image.tags, ['ghcr.io/canvascoding/canvas-notebook:latest']);
assert.throws(
  () => buildControlPlaneReleasePayload({
    ...env,
    MERGE_TAG: 'latest',
    GITHUB_REF: 'refs/heads/main',
    HOST_CLI_SHA256: '',
  }, '2026.7.11.1'),
  /provenance/u,
);

const nativeWorkflow = await readFile(new URL('../.github/workflows/build-both.yml', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/notify-control-plane-release.yml', import.meta.url), 'utf8');
assert.doesNotMatch(nativeWorkflow, /gh release create/u);
assert.doesNotMatch(nativeWorkflow, /gh release upload/u);
assert.match(nativeWorkflow, /Package immutable release metadata/u);
assert.match(nativeWorkflow, /canvas-notebook-release-metadata\.json/u);
assert.match(nativeWorkflow, /canvas-notebook-linux-cli-amd64\.tar\.gz/u);
assert.match(nativeWorkflow, /canvas-notebook-linux-cli-arm64\.tar\.gz/u);
const verifyMultiArchIndex = nativeWorkflow.indexOf('Verify multi-architecture native compliance');
const createManifestIndex = nativeWorkflow.indexOf('Create multi-arch manifest');
const packageMetadataIndex = nativeWorkflow.indexOf('Package immutable release metadata');
const uploadBundleIndex = nativeWorkflow.indexOf('Upload gated release bundle');
assert(packageMetadataIndex > verifyMultiArchIndex, 'Release metadata must be created after native compliance verification');
assert(packageMetadataIndex > createManifestIndex, 'Release metadata must be created after multi-arch manifest creation');
assert(uploadBundleIndex > packageMetadataIndex, 'The gated release bundle must include release metadata after packaging');
assert.match(workflow, /release:\s+types: \[published\]/su);
assert.match(workflow, /browser_download_url/u);
assert.match(workflow, /canvas-notebook-release-metadata\.json/u);
assert.match(workflow, /metadata\.linuxCli\?\.amd64/u);
assert.match(workflow, /metadata\.linuxCli\?\.arm64/u);
assert.match(workflow, /RELEASE_BUILD_RUN_ID/u);
assert.match(workflow, /CONTROL_PLANE_RELEASE_WEBHOOK_SECRET is required for published releases/u);

console.log('control plane release payload tests passed');
