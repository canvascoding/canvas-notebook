import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAgentBashEnvironment,
  buildAgentLandlockArguments,
  resolveAgentBashSandboxMode,
} from '../app/lib/pi/agent-bash-runtime';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-bash-contract-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const scratchDir = path.join(tempRoot, 'scratch');
  const skillDir = path.join(tempRoot, 'skill');
  await Promise.all([
    fs.mkdir(workspaceDir, { recursive: true }),
    fs.mkdir(scratchDir, { recursive: true }),
    fs.mkdir(skillDir, { recursive: true }),
  ]);

  try {
    assert.equal(resolveAgentBashSandboxMode({}), 'local-development');
    assert.equal(resolveAgentBashSandboxMode({ CANVAS_AGENT_BASH_SANDBOX: 'required' }), 'landlock');
    assert.equal(resolveAgentBashSandboxMode({ CANVAS_RUNTIME_ENV: 'docker' }), 'landlock');

    const env = buildAgentBashEnvironment({
      sourceEnv: {
        PATH: '/untrusted/path',
        LANG: 'de_DE.UTF-8',
        CANVAS_UNKNOWN_SECRET: 'must-not-leak',
        DATA: '/data',
        CANVAS_DATA_ROOT: '/data',
      },
      workspaceDir,
      tempDir: scratchDir,
    });
    assert.equal(env.CANVAS_WORKSPACE_DIR, workspaceDir);
    assert.equal(env.CANVAS_AGENT_TEMP_DIR, scratchDir);
    assert.equal(env.HOME, path.join(scratchDir, 'home'));
    assert.equal(env.XDG_CACHE_HOME, path.join(scratchDir, 'cache'));
    assert.equal(env.CANVAS_UNKNOWN_SECRET, undefined);
    assert.equal(env.DATA, undefined);
    assert.equal(env.CANVAS_DATA_ROOT, undefined);
    assert.doesNotMatch(env.PATH ?? '', /untrusted/);

    const args = await buildAgentLandlockArguments({
      command: 'node script.js',
      cwd: scratchDir,
      workspaceDir,
      tempDir: scratchDir,
      skillReadRoots: [skillDir],
    });
    const canonicalWorkspace = await fs.realpath(workspaceDir);
    const canonicalScratch = await fs.realpath(scratchDir);
    const canonicalSkill = await fs.realpath(skillDir);
    assert.deepEqual(args.slice(0, 2), ['--cwd', canonicalScratch]);
    assert.ok(args.some((value, index) => value === '--ro' && args[index + 1] === canonicalWorkspace));
    assert.ok(args.some((value, index) => value === '--ro' && args[index + 1] === canonicalSkill));
    assert.ok(args.some((value, index) => value === '--rw' && args[index + 1] === canonicalScratch));
    assert.deepEqual(args.slice(-4), ['--', '/bin/bash', '-lc', 'node script.js']);

    console.log('agent-bash-sandbox-contract-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
