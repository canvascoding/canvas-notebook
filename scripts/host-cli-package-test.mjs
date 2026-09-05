import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.join(root, 'dist-host-cli/canvas-notebook-host-cli.tar.gz');
const checksum = path.join(root, 'dist-host-cli/canvas-notebook-host-cli.sha256');

function runPackage() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/package-host-cli.mjs'], { cwd: root, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`host CLI package exited with ${code}`)));
  });
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

await runPackage();
const firstDigest = digest(await readFile(archive));
await runPackage();
const secondDigest = digest(await readFile(archive));
assert.equal(firstDigest, secondDigest);
assert.equal((await readFile(checksum, 'utf8')).trim(), `${secondDigest}  canvas-notebook-host-cli.tar.gz`);

const entries = [];
await tar.t({
  file: archive,
  onReadEntry: (entry) => {
    entries.push({ path: entry.path, type: entry.type });
  },
});
for (const entry of entries) {
  assert.match(entry.path, /^canvas-notebook-host-cli(?:\/|$)/u);
  assert.equal(entry.path.includes('../'), false);
  assert.equal(entry.type === 'File' || entry.type === 'Directory', true);
}
for (const required of [
  'canvas-notebook-host-cli/VERSION',
  'canvas-notebook-host-cli/install.sh',
  'canvas-notebook-host-cli/install/bin/canvas-notebook',
  'canvas-notebook-host-cli/install/lib/common.sh',
  'canvas-notebook-host-cli/install/lib/systemd.sh',
  'canvas-notebook-host-cli/install/keys/update-trust.json',
]) {
  assert.equal(entries.some((entry) => entry.path === required), true, required);
}

console.log('host CLI package tests passed');
