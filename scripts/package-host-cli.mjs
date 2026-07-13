#!/usr/bin/env node
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(rootDir, 'dist-host-cli');
const packageDir = path.join(outputRoot, 'canvas-notebook-host-cli');
const archivePath = path.join(outputRoot, 'canvas-notebook-host-cli.tar.gz');
const checksumPath = path.join(outputRoot, 'canvas-notebook-host-cli.sha256');
const packageVersion = String(JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')).version || '');

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u.test(packageVersion)) {
  throw new Error(`Host CLI package version is not release-safe: ${packageVersion}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });
await cp(path.join(rootDir, 'install.sh'), path.join(packageDir, 'install.sh'));
await cp(path.join(rootDir, 'install'), path.join(packageDir, 'install'), { recursive: true });
await writeFile(path.join(packageDir, 'VERSION'), `${packageVersion}\n`, { encoding: 'utf8', mode: 0o644 });
await tar.c({
  cwd: outputRoot,
  file: archivePath,
  gzip: true,
  portable: true,
  mtime: new Date(0),
}, ['canvas-notebook-host-cli']);
const archiveDigest = await sha256File(archivePath);
await writeFile(checksumPath, `${archiveDigest}  canvas-notebook-host-cli.tar.gz\n`, 'utf8');

console.log(`Created host CLI archive: ${archivePath}`);
console.log(`Created host CLI checksum: ${checksumPath}`);
