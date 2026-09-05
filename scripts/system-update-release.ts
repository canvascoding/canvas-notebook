import fs from 'node:fs/promises';
import path from 'node:path';
import { signReleaseUpdateManifest, verifyReleaseUpdateManifest, verifyPublishedCliAssets } from './lib/standalone-release-manifest';

async function main(): Promise<void> {
  const [mode, metadataPath, manifestPath, publicAssets] = process.argv.slice(2);
  if (!['sign', 'verify'].includes(mode) || !metadataPath || !manifestPath) {
    throw new Error('Usage: system-update-release.ts sign|verify METADATA MANIFEST [PUBLIC_ASSET_DIRECTORY]');
  }
  const expected = {
    tag: process.env.RELEASE_TAG || '',
    commitSha: process.env.RELEASE_COMMIT_SHA || '',
    runId: process.env.RELEASE_RUN_ID || '',
  };
  const trustStorePath = path.resolve('install/keys/update-trust.json');
  const metadata: unknown = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  if (mode === 'sign') {
    const signed = await signReleaseUpdateManifest(metadata, expected,
      process.env.CANVAS_UPDATE_SIGNING_PRIVATE_KEY || '',
      process.env.CANVAS_UPDATE_SIGNING_KEY_ID || '', trustStorePath);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx' });
    console.log('Signed and verified standalone update manifest.');
  } else {
    const signed = await verifyReleaseUpdateManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown,
      metadata, expected, trustStorePath);
    if (publicAssets) await verifyPublishedCliAssets(signed.manifest, publicAssets);
    console.log('Verified standalone update manifest and release provenance.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Release manifest operation failed.');
  process.exitCode = 1;
});
