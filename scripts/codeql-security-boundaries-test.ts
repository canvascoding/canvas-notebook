import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpawnCommandRunner } from '../cli/src/core/process';

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-codeql-boundaries-'));
  const previousDataRoot = process.env.CANVAS_DATA_ROOT;
  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    const profile = await import('../app/lib/user-profile/storage');
    const appearance = { ...profile.createDefaultUserProfileAppearance(), revision: 7 };
    await profile.writeUserProfileAppearance('profile-fixture', appearance);
    assert.deepEqual(await profile.readUserProfileAppearance('profile-fixture'), appearance);
    assert.equal((await profile.readUserProfileAppearance('another-user')).revision, 0);
    for (const id of ['..', '.', '../profile-fixture', 'fixture/../profile-fixture', '/etc', 'fixture\\..', 'fixture\0']) {
      await assert.rejects(() => profile.readUserProfileAppearance(id));
      await assert.rejects(() => profile.readUserProfileAvatar(id));
    }
    assert.equal((await profile.readUserProfileAppearance('%2e%2e%2fprofile-fixture')).revision, 0,
      'encoded separators remain literal directory names and cannot select another profile');

    const args = ['/tmp/$(touch SHELL_EXECUTED);x', 'quote"; touch SHELL_EXECUTED; #', '`touch SHELL_EXECUTED`'];
    const result = await new SpawnCommandRunner().run(process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args],
      { cwd: dataRoot },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args, 'command arguments must pass literally without shell expansion');
    await assert.rejects(() => fs.access(path.join(dataRoot, 'SHELL_EXECUTED')));
    console.log('CodeQL profile and command security boundaries passed');
  } finally {
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
