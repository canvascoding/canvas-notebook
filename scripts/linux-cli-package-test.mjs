import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const architecture = ({ x64: 'amd64', arm64: 'arm64' })[process.arch];
assert.ok(architecture);
const packageName = `canvas-notebook-linux-cli-${architecture}`;
const outputRoot = path.join(root, 'dist-linux-cli', architecture);
const archive = path.join(outputRoot, `${packageName}.tar.gz`);
const checksum = path.join(outputRoot, `${packageName}.sha256`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function packageCli() {
  const result = await run(process.execPath, ['scripts/package-linux-cli.mjs'], {
    env: {
      ...process.env,
      CANVAS_LINUX_CLI_ALLOW_NON_LINUX: 'true',
      CANVAS_LINUX_CLI_SKIP_RUNTIME_VALIDATION: process.platform === 'linux' ? 'false' : 'true',
    },
  });
  assert.equal(result.code, 0, result.stderr);
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

await packageCli();
const firstDigest = digest(await readFile(archive));
await packageCli();
const secondDigest = digest(await readFile(archive));
assert.equal(firstDigest, secondDigest, 'Linux CLI archive must be deterministic');
assert.equal((await readFile(checksum, 'utf8')).trim(), `${secondDigest}  ${packageName}.tar.gz`);

const entries = [];
await tar.t({ file: archive, onReadEntry: (entry) => entries.push({ path: entry.path, type: entry.type }) });
for (const entry of entries) {
  assert.match(entry.path, new RegExp(`^${packageName}(?:/|$)`, 'u'));
  assert.equal(entry.path.includes('../'), false);
  assert.equal(entry.type === 'File' || entry.type === 'Directory', true, `${entry.path}: ${entry.type}`);
}
const packageVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
for (const required of [
  `${packageName}/VERSION`,
  `${packageName}/manifest.json`,
  `${packageName}/bin/canvas-notebook`,
  `${packageName}/install/linux-cli.sh`,
  `${packageName}/runtime/bin/node`,
  `${packageName}/state/current`,
  `${packageName}/state/previous`,
  `${packageName}/releases/${packageVersion}/VERSION`,
  `${packageName}/releases/${packageVersion}/dist-cli/main.js`,
]) assert.equal(entries.some((entry) => entry.path === required), true, required);

const manifest = JSON.parse(await readFile(path.join(outputRoot, packageName, 'manifest.json'), 'utf8'));
assert.deepEqual({
  schemaVersion: manifest.schemaVersion,
  platform: manifest.platform,
  architecture: manifest.architecture,
  cliVersion: manifest.cliVersion,
}, { schemaVersion: 1, platform: 'linux', architecture, cliVersion: packageVersion });
assert.match(manifest.nodeVersion, /^v\d+\.\d+\.\d+$/u);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-linux-cli-package-'));
try {
  const installed = path.join(tempRoot, packageName);
  await cp(path.join(outputRoot, packageName), installed, { recursive: true });
  const launcher = path.join(installed, 'bin', 'canvas-notebook');
  if (process.platform === 'linux') {
    const versionResult = await run(launcher, ['version', '--json'], {
      cwd: tempRoot,
      env: {
        ...process.env,
        CANVAS_INSTALL_DIR: path.join(tempRoot, 'manager'),
        CANVAS_DATA_DIR: path.join(tempRoot, 'data'),
        PATH: `${path.dirname(launcher)}:${process.env.PATH || ''}`,
      },
    });
    assert.equal(versionResult.code, 0, versionResult.stderr);
    const version = JSON.parse(versionResult.stdout);
    assert.equal(version.cliVersion, packageVersion);
    assert.equal(version.cliGeneration, 'typescript');
  }

  await writeFile(path.join(installed, 'state', 'current'), '../unsafe\n', 'utf8');
  const unsafe = await run(launcher, ['version'], { cwd: tempRoot });
  assert.equal(unsafe.code, 78);
  assert.match(unsafe.stderr, /activation version is invalid/u);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('linux CLI package tests passed');
