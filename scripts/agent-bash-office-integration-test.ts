import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  buildAgentBashEnvironment,
  executeAgentBashCommand,
} from '../app/lib/pi/agent-bash-runtime';
import {
  cleanupAgentRuntimeTempDirs,
  ensureAgentRuntimeTempDir,
} from '../app/lib/pi/agent-runtime-temp';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function main() {
  const fixture = await fs.mkdtemp(path.join(process.cwd(), '.agent-bash-office-test-'));
  const keys = ['DATA', 'CANVAS_DATA_ROOT', 'CANVAS_RUNTIME_ENV', 'CANVAS_AGENT_BASH_SANDBOX',
    'CANVAS_AGENT_LANDLOCK_PATH', 'CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const workspace = path.join(fixture, 'workspace');
  const skill = path.join(fixture, 'skill');
  const secret = path.join(fixture, 'private', 'secret.txt');
  const data = path.join(fixture, 'data');
  process.env.DATA = data;
  process.env.CANVAS_DATA_ROOT = data;
  process.env.CANVAS_RUNTIME_ENV = 'test';
  process.env.CANVAS_AGENT_BASH_SANDBOX = process.platform === 'linux' ? 'required' : 'local-development';
  delete process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES;

  try {
    await Promise.all([workspace, skill, path.dirname(secret), data].map((directory) => fs.mkdir(directory)));
    await fs.writeFile(path.join(workspace, 'original.docx'), 'original document bytes');
    await fs.writeFile(path.join(skill, 'readable.txt'), 'skill-readable');
    await fs.writeFile(secret, 'private-sentinel');
    const context: AgentExecutionContext = {
      userId: 'bash-office-user', sessionId: 'bash-office-session', agentId: 'office-agent',
      workspaceId: 'bash-office-workspace', workspaceType: 'team', workspaceName: 'Bash Office test',
      organizationId: 'bash-office-org', customerId: null, projectId: null,
      workspaceRoot: workspace, workspaceRootRelativePath: null,
      canWrite: true, canDelete: true, canShare: false, legacy: false, skillReadRoots: [skill],
    };
    const scratch = await ensureAgentRuntimeTempDir(context);
    await fs.symlink(workspace, path.join(scratch, 'workspace-alias'));
    const environment = buildAgentBashEnvironment({ sourceEnv: process.env, workspaceDir: workspace, tempDir: scratch });
    const run = (command: string, options: { cwd?: string; signal?: AbortSignal } = {}) => executeAgentBashCommand({
      command, cwd: options.cwd ?? scratch, workspaceDir: workspace, tempDir: scratch,
      env: environment, executionContext: context, signal: options.signal,
    });
    const probe = `
import errno, json, os, pathlib, sys, zipfile
workspace = pathlib.Path(${JSON.stringify(workspace)})
scratch = pathlib.Path(os.environ['CANVAS_AGENT_TEMP_DIR'])
target = workspace / 'original.docx'
assert target.read_text() == 'original document bytes'
assert pathlib.Path(${JSON.stringify(path.join(skill, 'readable.txt'))}).read_text() == 'skill-readable'
attempts = [lambda: target.write_text('broken'), lambda: target.chmod(0),
            lambda: os.utime(target, (0, 0)), lambda: os.open(target, os.O_RDONLY | os.O_TRUNC),
            lambda: (scratch / 'workspace-alias' / 'original.docx').write_text('broken')]
for mutation in attempts:
  try:
    mutation()
  except OSError as error:
    assert error.errno in (errno.EACCES, errno.EPERM, errno.EROFS), error
  else:
    raise AssertionError('Canonical mutation permitted')
  assert target.read_text() == 'original document bytes'
if sys.platform == 'linux':
  try:
    pathlib.Path(${JSON.stringify(secret)}).read_text()
  except PermissionError:
    pass
  else:
    raise AssertionError('Inner Landlock read boundary was lost')
with zipfile.ZipFile(scratch / 'working.docx', 'w', zipfile.ZIP_DEFLATED) as archive:
  archive.writestr('word/document.xml', '<document>draft</document>')
print(json.dumps({'cwd': os.getcwd(), 'home': os.environ['HOME'], 'cache': os.environ['XDG_CACHE_HOME']}))
`;
    const result = await run(`/usr/bin/python3 -c ${quote(probe)}`);
    assert.equal(result.sandboxMode, process.platform === 'linux' ? 'landlock' : 'local-development');
    const state = JSON.parse(result.stdout);
    assert.equal(state.cwd, await fs.realpath(scratch));
    assert.equal(state.home, path.join(scratch, 'home'));
    assert.equal(state.cache, path.join(scratch, 'cache'));
    assert.equal((await fs.stat(path.join(scratch, 'working.docx'))).size > 0, true);
    const workspaceCwd = await run(`${quote(process.execPath)} -p 'process.cwd()'`, { cwd: workspace });
    assert.equal(workspaceCwd.stdout.trim(), await fs.realpath(workspace));
    const largeOutput = await run(`${quote(process.execPath)} -e 'process.stdout.write("x".repeat(2 * 1024 * 1024))'`);
    assert.equal(largeOutput.stdout.length, 2 * 1024 * 1024);

    const startedFile = path.join(scratch, 'started');
    const abort = new AbortController();
    const pending = run(`exec ${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(startedFile)}, 'started');setTimeout(() => {}, 30000)`)}`, { signal: abort.signal });
    const observed = assert.rejects(pending, (error: unknown) => (error as { name?: string }).name === 'AbortError');
    try {
      const deadline = Date.now() + 5000;
      while (!(await fs.stat(startedFile).catch(() => null)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(await fs.stat(startedFile));
      const cleanup = await cleanupAgentRuntimeTempDirs({ nowMs: Date.now() + 48 * 60 * 60 * 1000, retentionMs: 1, force: true });
      assert.ok(!cleanup.deleted.includes(scratch), 'An active command must hold its scratch lease');
      assert.ok(await fs.stat(startedFile));
    } finally {
      abort.abort();
      await observed;
    }

    const quotaContext = { ...context, sessionId: 'quota-session' };
    const quotaScratch = await ensureAgentRuntimeTempDir(quotaContext);
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '4';
    try {
      await assert.rejects(executeAgentBashCommand({
        command: 'printf 12345 > oversized.bin', cwd: quotaScratch, workspaceDir: workspace, tempDir: quotaScratch,
        env: buildAgentBashEnvironment({ sourceEnv: process.env, workspaceDir: workspace, tempDir: quotaScratch }),
        executionContext: quotaContext,
      }), /quota exceeded.*cleared automatically/i);
      assert.deepEqual(await fs.readdir(quotaScratch), []);
    } finally {
      delete process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES;
    }

    await assert.rejects(executeAgentBashCommand({
      command: 'echo must-not-run', cwd: workspace, workspaceDir: workspace, tempDir: null,
      env: environment, executionContext: null,
    }), /workspace-bound session|active agent execution context/);
    process.env.CANVAS_AGENT_BASH_SANDBOX = 'required';
    process.env.CANVAS_AGENT_LANDLOCK_PATH = path.join(fixture, 'missing-launcher');
    await assert.rejects(run('echo must-not-run'), /required Landlock launcher is not executable/);
    assert.equal(await fs.readFile(path.join(workspace, 'original.docx'), 'utf8'), 'original document bytes');
    console.log(`agent-bash-office-integration-test: ${process.platform} passed; layered confinement, argv/env/cwd, 2 MiB output, quota cleanup, live lease and abort verified`);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

void main();
