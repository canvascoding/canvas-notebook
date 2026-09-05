import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-entrypoint-test-'));
  try {
    const installer = await fs.readFile(path.resolve('install/linux-cli.sh'), 'utf8');
    const functionSource = installer.match(/^activate_entrypoint\(\) \{[\s\S]*?^\}/mu)?.[0];
    assert.ok(functionSource);
    const target = path.join(root, 'managed-cli');
    const entrypoint = path.join(root, 'canvas-notebook');
    await fs.writeFile(target, 'fixture');
    await fs.symlink(target, entrypoint);
    const before = await fs.lstat(entrypoint);
    // Execute the actual installer function. Deny all mutation commands,
    // as they would be denied below ProtectSystem=full on the host.
    const result = spawnSync('bash', ['-eu', '-c', `${functionSource}\nmkdir() { return 91; }; rm() { return 92; }; ln() { return 93; }; mv() { return 94; }; activate_entrypoint "$TEST_TARGET"`], {
      env: { ...process.env, BIN_PATH: entrypoint, TEST_TARGET: target }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await fs.lstat(entrypoint)).ino, before.ino);
    assert.equal(await fs.readlink(entrypoint), target);
    // Initial installation still creates an entrypoint when none exists.
    await fs.unlink(entrypoint);
    const fresh = spawnSync('bash', ['-eu', '-c', `${functionSource}\nactivate_entrypoint "$TEST_TARGET"`], {
      env: { ...process.env, BIN_PATH: entrypoint, TEST_TARGET: target }, encoding: 'utf8',
    });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(await fs.readlink(entrypoint), target);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('linux-cli-stable-entrypoint-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
