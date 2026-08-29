#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = String(JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')).version || '');
const architecture = process.env.CANVAS_LINUX_CLI_ARCH || ({ x64: 'amd64', arm64: 'arm64' })[process.arch] || '';
const runtimeBinary = path.resolve(process.env.CANVAS_LINUX_CLI_NODE_BINARY || process.execPath);
const skipRuntimeValidation = process.env.CANVAS_LINUX_CLI_SKIP_RUNTIME_VALIDATION === 'true';
const outputRoot = path.join(rootDir, 'dist-linux-cli', architecture);
const packageName = `canvas-notebook-linux-cli-${architecture}`;
const packageDir = path.join(outputRoot, packageName);
const releaseDir = path.join(packageDir, 'releases', packageVersion);
const archivePath = path.join(outputRoot, `${packageName}.tar.gz`);
const checksumPath = path.join(outputRoot, `${packageName}.sha256`);

if (!/^(amd64|arm64)$/u.test(architecture)) throw new Error(`Unsupported Linux CLI architecture: ${architecture || '(empty)'}`);
if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u.test(packageVersion)) {
  throw new Error(`Linux CLI package version is not release-safe: ${packageVersion}`);
}
if (process.platform !== 'linux' && process.env.CANVAS_LINUX_CLI_ALLOW_NON_LINUX !== 'true') {
  throw new Error('Linux CLI packages must be built on Linux unless explicitly enabled for layout-only tests.');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: options.capture ? 'pipe' : 'inherit', shell: false });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited with ${code}`)));
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

if (process.env.CANVAS_LINUX_CLI_SKIP_BUILD !== 'true') await run('npm', ['run', 'cli:build']);
const nodeVersion = await run(runtimeBinary, ['--version'], { capture: true });
const nodeMatch = nodeVersion.match(/^v(\d+)\.(\d+)\.(\d+)$/u);
if (!nodeMatch || Number(nodeMatch[1]) < 22 || (Number(nodeMatch[1]) === 22 && Number(nodeMatch[2]) < 19)) {
  throw new Error(`Bundled Node.js must satisfy >=22.19.0; found ${nodeVersion || '(unknown)'}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(packageDir, 'bin'), { recursive: true });
await mkdir(path.join(packageDir, 'runtime', 'bin'), { recursive: true });
await mkdir(path.join(packageDir, 'state'), { recursive: true });
await mkdir(path.join(packageDir, 'install'), { recursive: true });
await mkdir(releaseDir, { recursive: true });
await cp(path.join(rootDir, 'dist-cli'), path.join(releaseDir, 'dist-cli'), { recursive: true });
await cp(runtimeBinary, path.join(packageDir, 'runtime', 'bin', 'node'));
await cp(path.join(rootDir, 'install', 'linux-cli-launcher.sh'), path.join(packageDir, 'bin', 'canvas-notebook'));
await cp(path.join(rootDir, 'install', 'linux-cli.sh'), path.join(packageDir, 'install', 'linux-cli.sh'));
await Promise.all([
  chmod(path.join(packageDir, 'runtime', 'bin', 'node'), 0o755),
  chmod(path.join(packageDir, 'bin', 'canvas-notebook'), 0o755),
  chmod(path.join(packageDir, 'install', 'linux-cli.sh'), 0o755),
]);
if (!skipRuntimeValidation) {
  const bundledNodeVersion = await run(path.join(packageDir, 'runtime', 'bin', 'node'), ['--version'], { capture: true });
  if (bundledNodeVersion !== nodeVersion) {
    throw new Error(`Bundled Node.js validation mismatch: expected ${nodeVersion}, received ${bundledNodeVersion || '(empty)'}`);
  }
}
await writeFile(path.join(packageDir, 'state', 'current'), `${packageVersion}\n`, { encoding: 'utf8', mode: 0o644 });
await writeFile(path.join(packageDir, 'state', 'previous'), '', { encoding: 'utf8', mode: 0o644 });
await writeFile(path.join(releaseDir, 'VERSION'), `${packageVersion}\n`, { encoding: 'utf8', mode: 0o644 });
await writeFile(path.join(packageDir, 'VERSION'), `${packageVersion}\n`, { encoding: 'utf8', mode: 0o644 });
await writeFile(path.join(packageDir, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  platform: 'linux',
  architecture,
  cliVersion: packageVersion,
  nodeVersion,
  runtimeValidated: !skipRuntimeValidation,
  entrypoint: 'bin/canvas-notebook',
  installer: 'install/linux-cli.sh',
  runtime: 'runtime/bin/node',
  activeRelease: `releases/${packageVersion}`,
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });

await tar.c({
  cwd: outputRoot,
  file: archivePath,
  gzip: true,
  portable: true,
  mtime: new Date(0),
}, [packageName]);
const archiveDigest = await sha256File(archivePath);
await writeFile(checksumPath, `${archiveDigest}  ${packageName}.tar.gz\n`, 'utf8');

console.log(`Created Linux CLI package: ${archivePath}`);
console.log(`Created Linux CLI checksum: ${checksumPath}`);
