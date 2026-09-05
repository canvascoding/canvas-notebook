import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { StandaloneReleaseResolver } from '../cli/src/core/standaloneUpdateRelease';
import {
  manifestFromReleaseMetadata, signReleaseUpdateManifest,
  verifyReleaseUpdateManifest, verifyPublishedCliAssets,
} from './lib/standalone-release-manifest';

async function main(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-release-signing-test-'));
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const trustStorePath = path.join(directory, 'trust.json');
    await fs.writeFile(trustStorePath, JSON.stringify({ version: 1, keys: [{
      keyId: 'test-only', algorithm: 'ed25519', publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    }] }), { mode: 0o600 });
    const expected = { tag: 'v2026.9.5.1', commitSha: 'a'.repeat(40), runId: '12345' };
    const payload = Buffer.from('test CLI archive bytes');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const metadata = {
      schemaVersion: 1, repository: 'canvascoding/canvas-notebook', version: '2026.9.5.1',
      tag: expected.tag, commitSha: expected.commitSha, build: { runId: expected.runId },
      image: { name: 'ghcr.io/canvascoding/canvas-notebook', digest: `sha256:${'b'.repeat(64)}` },
      linuxCli: {
        amd64: { filename: 'canvas-notebook-linux-cli-amd64.tar.gz', sha256: checksum },
        arm64: { filename: 'canvas-notebook-linux-cli-arm64.tar.gz', sha256: checksum },
      },
    };
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const signed = await signReleaseUpdateManifest(metadata, expected, privateKeyPem, 'test-only', trustStorePath);
    assert.equal(signed.manifest.backupRequired, true);
    assert.equal(signed.manifest.minimumVersion, null);
    assert.equal(signed.manifest.imageRef, `${metadata.image.name}@${metadata.image.digest}`);
    for (const [platformArchitecture, architecture] of [['x64', 'amd64'], ['arm64', 'arm64']] as const) {
      const resolver = new StandaloneReleaseResolver({
        env: { NODE_ENV: 'test', CANVAS_UPDATE_TRUST_STORE: trustStorePath }, platformArchitecture,
        fetch: async (url) => {
          assert.equal(url, 'https://github.com/canvascoding/canvas-notebook/releases/latest/download/canvas-notebook-update-stable.json');
          return new Response(JSON.stringify(signed));
        },
      });
      const verified = await resolver.resolve('stable');
      assert.equal(verified.cliArtifact.architecture, architecture);
      assert.equal(verified.cliArtifact.url,
        `https://github.com/canvascoding/canvas-notebook/releases/download/${expected.tag}/canvas-notebook-linux-cli-${architecture}.tar.gz`);
      await fs.writeFile(path.join(directory, `canvas-notebook-linux-cli-${architecture}.tar.gz`), payload);
    }
    await verifyPublishedCliAssets(signed.manifest, directory);
    await fs.writeFile(path.join(directory, 'canvas-notebook-linux-cli-arm64.tar.gz'), 'tampered');
    await assert.rejects(verifyPublishedCliAssets(signed.manifest, directory), /checksum mismatch/u);
    await verifyReleaseUpdateManifest(signed, metadata, expected, trustStorePath);
    await assert.rejects(verifyReleaseUpdateManifest({ ...signed, manifest: { ...signed.manifest, backupRequired: false } },
      metadata, expected, trustStorePath), /signature is invalid/u);
    const mismatched = structuredClone(metadata);
    mismatched.linuxCli.amd64.sha256 = 'c'.repeat(64);
    await assert.rejects(verifyReleaseUpdateManifest(signed, mismatched, expected, trustStorePath), /does not match/u);
    for (const provenance of [
      { ...expected, tag: 'v2026.9.6.1' }, { ...expected, runId: '999' }, { ...expected, commitSha: 'd'.repeat(40) },
    ]) {
      assert.throws(() => manifestFromReleaseMetadata(metadata, provenance, signed.manifest.publishedAt), /exact trusted tag build/u);
    }
    const wrongPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await assert.rejects(signReleaseUpdateManifest(metadata, expected, wrongPrivateKey, 'test-only', trustStorePath), /signature is invalid/u);
    await assert.rejects(signReleaseUpdateManifest(metadata, expected, '', 'test-only', trustStorePath), /required/u);
    await assert.rejects(signReleaseUpdateManifest(metadata, expected, privateKeyPem, 'unknown', trustStorePath), /unknown key/u);

    const publicStore = JSON.parse(await fs.readFile('install/keys/update-trust.json', 'utf8'));
    assert.equal(publicStore.version, 1);
    assert.ok(publicStore.keys.length > 0);
    for (const key of publicStore.keys) {
      assert.equal(key.algorithm, 'ed25519');
      assert.match(key.publicKey, /^-----BEGIN PUBLIC KEY-----/u);
      assert.equal(crypto.createPublicKey(key.publicKey).asymmetricKeyType, 'ed25519');
    }
    const buildSource = await fs.readFile('.github/workflows/build-both.yml', 'utf8');
    const buildWorkflow = YAML.parse(buildSource);
    const steps = buildWorkflow.jobs.merge.steps;
    const signStep = steps.find((step: { name: string }) => step.name === 'Sign standalone update manifest');
    assert.equal(signStep.env.CANVAS_UPDATE_SIGNING_KEY_ID, publicStore.keys[0].keyId);
    assert.match(signStep.if, /refs\/tags\/v/u);
    assert.match(signStep.env.CANVAS_UPDATE_SIGNING_PRIVATE_KEY, /secrets.CANVAS_UPDATE_SIGNING_PRIVATE_KEY/u);
    for (const job of Object.values(buildWorkflow.jobs) as Array<{ steps?: Array<{ uses?: string }> }>) {
      for (const step of job.steps || []) {
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/u, `Mutable GitHub Action: ${step.uses}`);
      }
    }
    const bundle = steps.find((step: { name: string }) => step.name === 'Upload gated release bundle');
    assert.match(bundle.with.path, /canvas-notebook-update-stable.json/u);
    const publicationSource = await fs.readFile('.github/workflows/publish-standalone-update.yml', 'utf8');
    const publication = YAML.parse(publicationSource);
    assert.deepEqual(publication.on.release.types, ['published']);
    assert.equal(publication.jobs.publish.permissions.contents, 'write');
    assert.doesNotMatch(publicationSource, /CONTROL_PLANE|CANVAS_UPDATE_SIGNING_PRIVATE_KEY|--clobber/u);
    assert.match(publicationSource, /\.conclusion == "success"/u);
    assert.match(publicationSource, /system-update-release.ts verify/u);
    assert.match(publicationSource, /cmp "signed-update/u);
    console.log('Standalone release manifest signing, provenance, published assets, and workflow tests passed.');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
