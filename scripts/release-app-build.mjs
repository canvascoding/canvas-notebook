import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const artifactDir = path.resolve('release-app-build');
const archive = path.join(artifactDir, 'canvas-next-build.tar.gz');
const metadataFile = path.join(artifactDir, 'metadata.json');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const commitSha = process.env.CANVAS_RELEASE_SOURCE_SHA;
const runId = process.env.CANVAS_RELEASE_BUILD_RUN_ID;
const deploymentId = (process.env.NEXT_DEPLOYMENT_ID?.trim() || `canvas-notebook-${version}`)
  .replace(/[^A-Za-z0-9_-]/g, '-');
assert.match(commitSha ?? '', /^[a-f0-9]{40}$/u, 'An exact source commit is required');
assert.match(runId ?? '', /^\d+$/u, 'An exact build run is required');

if (process.argv[2] === 'pack') {
  const config = JSON.parse(fs.readFileSync('.next/required-server-files.json', 'utf8'));
  assert.equal(config.config.deploymentId, deploymentId, 'Application build version mismatch');
  fs.mkdirSync(artifactDir, { recursive: true });
  execFileSync('tar', ['--exclude=.next/cache', '--exclude=.next/dev', '--exclude=.next/multiprocess-*',
    '--exclude=.next/standalone', '-czf', archive, '.next']);
  fs.writeFileSync(metadataFile, JSON.stringify({
    schemaVersion: 1, version, commitSha, runId, deploymentId,
    buildId: fs.readFileSync('.next/BUILD_ID', 'utf8').trim(),
    sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  }, null, 2) + '\n');
} else {
  assert.equal(process.argv[2], 'verify', 'Use pack or verify');
}

const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
assert.equal(metadata.schemaVersion, 1);
assert.equal(metadata.version, version);
assert.equal(metadata.commitSha, commitSha);
assert.equal(metadata.runId, runId);
assert.equal(metadata.deploymentId, deploymentId);
assert.equal(createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), metadata.sha256);
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .trim().split('\n');
for (const entry of entries) {
  assert(entry === '.next/' || entry.startsWith('.next/'), 'Unexpected application archive path');
  assert(!entry.split('/').includes('..'), 'Unsafe application archive path');
  assert(!/\.(?:node|so|dylib|dll|a)$/iu.test(entry), 'Native dependencies must be built in the architecture image');
}
if (process.argv[2] === 'verify') {
  execFileSync('tar', ['-xzf', archive]);
  assert.equal(fs.readFileSync('.next/BUILD_ID', 'utf8').trim(), metadata.buildId);
  const config = JSON.parse(fs.readFileSync('.next/required-server-files.json', 'utf8'));
  assert.equal(config.config.deploymentId, deploymentId);
}
console.log(`Verified application artifact: ${version}, ${commitSha}, run ${runId}`);
