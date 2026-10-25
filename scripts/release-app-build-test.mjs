import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactScript = fileURLToPath(new URL('./release-app-build.mjs', import.meta.url));
const compileScript = fileURLToPath(new URL('./release-next-build.mjs', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-app-artifact-platform-test-'));
const env = { ...process.env, CANVAS_RELEASE_SOURCE_SHA: 'a'.repeat(40), CANVAS_RELEASE_BUILD_RUN_ID: '123',
  NEXT_DEPLOYMENT_ID: 'canvas-artifact-test' };
try {
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '2026.10.25.1' }));
  fs.mkdirSync(path.join(directory, '.next/server'), { recursive: true });
  fs.writeFileSync(path.join(directory, '.next/required-server-files.json'), JSON.stringify({ config: { deploymentId: env.NEXT_DEPLOYMENT_ID } }));
  fs.writeFileSync(path.join(directory, '.next/BUILD_ID'), 'isolated-platform-test');
  fs.writeFileSync(path.join(directory, '.next/server/application.js'), '/* Original fixture bytes. */');
  execFileSync(process.execPath, [artifactScript, 'pack'], { cwd: directory, env, stdio: 'pipe' });
  const metadataPath = path.join(directory, 'release-app-build/metadata.json');
  const original = JSON.parse(fs.readFileSync(metadataPath));
  assert.equal(original.schemaVersion, 2); assert.equal(original.buildPlatform, process.platform);
  const archivePath = path.join(directory, 'release-app-build/canvas-next-build.tar.gz');
  const archive = fs.readFileSync(archivePath);
  fs.rmSync(path.join(directory, '.next'), { recursive: true });
  for (const metadata of [
    { ...original, buildPlatform: process.platform === 'linux' ? 'darwin' : 'linux' },
    { ...original, buildPlatform: undefined },
    { ...original, schemaVersion: 1 },
  ]) {
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const rejected = spawnSync(process.execPath, [artifactScript, 'verify'], { cwd: directory, env, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0, 'Foreign or unbound operating systems must be rejected.');
    assert.equal(fs.existsSync(path.join(directory, '.next')), false, 'Rejection must precede extraction.');
    assert.deepEqual(fs.readFileSync(archivePath), archive, 'Rejected artifacts remain intact.');
  }
  fs.writeFileSync(metadataPath, JSON.stringify(original));
  execFileSync(process.execPath, [artifactScript, 'verify'], { cwd: directory, env, stdio: 'pipe' });
  assert.equal(fs.readFileSync(path.join(directory, '.next/server/application.js'), 'utf8'), '/* Original fixture bytes. */');
  for (const value of ['0', '5', '-1', '1.5', 'unbounded']) {
    const rejected = spawnSync(process.execPath, [compileScript, 'compile'], { cwd: directory,
      env: { ...env, CANVAS_RELEASE_NATIVE_PARALLELISM: value }, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /must be an integer from 1 to 4/u);
  }
  console.log('Application artifacts: same-OS round trip, cross-OS/missing/old metadata rejection before extraction, retained bytes and bounded compiler settings passed.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
