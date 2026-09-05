import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import {
  canonicalizeSystemUpdateReleaseManifest,
  SYSTEM_UPDATE_CONTRACT_VERSION,
  validateSystemUpdateReleaseManifest,
  type SystemUpdateReleaseManifest,
  type SystemUpdateSignedReleaseManifest,
} from '../../cli/src/core/systemUpdateContract';
import { StandaloneReleaseResolver } from '../../cli/src/core/standaloneUpdateRelease';

const REPOSITORY = 'canvascoding/canvas-notebook';
const IMAGE = 'ghcr.io/canvascoding/canvas-notebook';

export interface ReleaseProvenance {
  tag: string;
  commitSha: string;
  runId: string;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid release metadata.');
  return input as Record<string, unknown>;
}

export function manifestFromReleaseMetadata(
  input: unknown,
  expected: ReleaseProvenance,
  publishedAt: string,
): SystemUpdateReleaseManifest {
  const metadata = record(input);
  const image = record(metadata.image);
  const build = record(metadata.build);
  const linuxCli = record(metadata.linuxCli);
  if (!/^v\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u.test(expected.tag) ||
    !/^[a-f0-9]{40}$/u.test(expected.commitSha) || !/^\d+$/u.test(expected.runId) ||
    metadata.schemaVersion !== 1 || metadata.repository !== REPOSITORY ||
    metadata.tag !== expected.tag || metadata.version !== expected.tag.slice(1) ||
    metadata.commitSha !== expected.commitSha || build.runId !== expected.runId ||
    image.name !== IMAGE || typeof image.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(image.digest)) {
    throw new Error('Release metadata does not match the exact trusted tag build.');
  }
  const releaseBase = `https://github.com/${REPOSITORY}/releases`;
  const cliArtifacts = (['amd64', 'arm64'] as const).map((architecture) => {
    const artifact = record(linuxCli[architecture]);
    const filename = `canvas-notebook-linux-cli-${architecture}.tar.gz`;
    if (artifact.filename !== filename || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      throw new Error(`Release metadata has an invalid ${architecture} CLI artifact.`);
    }
    return { architecture, url: `${releaseBase}/download/${expected.tag}/${filename}`, sha256: artifact.sha256 };
  });
  const parsed = validateSystemUpdateReleaseManifest({
    contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
    releaseId: expected.tag,
    version: metadata.version,
    channel: 'stable',
    imageRef: `${IMAGE}@${image.digest}`,
    imageDigest: image.digest.slice('sha256:'.length),
    cliVersion: metadata.version,
    cliArtifacts,
    minimumVersion: null,
    backupRequired: true,
    releaseNotesUrl: `${releaseBase}/tag/${expected.tag}`,
    publishedAt,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

export async function verifyReleaseUpdateManifest(
  input: unknown,
  metadata: unknown,
  expected: ReleaseProvenance,
  trustStorePath: string,
): Promise<SystemUpdateSignedReleaseManifest> {
  // Use the host's real trust/contract checks rather than a second signature implementation.
  const resolver = new StandaloneReleaseResolver({
    env: { NODE_ENV: 'production', CANVAS_UPDATE_TRUST_STORE: trustStorePath },
    platformArchitecture: 'x64',
    fetch: async () => new Response(JSON.stringify(input)),
  });
  const { signed } = await resolver.resolve('stable');
  const expectedManifest = manifestFromReleaseMetadata(metadata, expected, signed.manifest.publishedAt);
  if (canonicalizeSystemUpdateReleaseManifest(signed.manifest) !== canonicalizeSystemUpdateReleaseManifest(expectedManifest)) {
    throw new Error('Signed update manifest does not match the release assets and provenance.');
  }
  return signed;
}

export async function signReleaseUpdateManifest(
  metadata: unknown,
  expected: ReleaseProvenance,
  privateKeyPem: string,
  keyId: string,
  trustStorePath: string,
  publishedAt = new Date().toISOString(),
): Promise<SystemUpdateSignedReleaseManifest> {
  if (!privateKeyPem) throw new Error('CANVAS_UPDATE_SIGNING_PRIVATE_KEY is required for a release build.');
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Update signing key must use Ed25519.');
  const manifest = manifestFromReleaseMetadata(metadata, expected, publishedAt);
  const signed: SystemUpdateSignedReleaseManifest = {
    manifest,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: crypto.sign(null, Buffer.from(canonicalizeSystemUpdateReleaseManifest(manifest)), privateKey).toString('base64'),
    },
  };
  // Fail the build when the CI secret and the public key shipped by the installer differ.
  return verifyReleaseUpdateManifest(signed, metadata, expected, trustStorePath);
}

export async function verifyPublishedCliAssets(manifest: SystemUpdateReleaseManifest, directory: string): Promise<void> {
  for (const artifact of manifest.cliArtifacts) {
    const filename = `canvas-notebook-linux-cli-${artifact.architecture}.tar.gz`;
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(path.join(directory, filename))) hash.update(chunk);
    if (hash.digest('hex') !== artifact.sha256) throw new Error(`Published CLI checksum mismatch: ${filename}`);
  }
}
