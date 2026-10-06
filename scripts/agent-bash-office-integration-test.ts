import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createPiTestDatabase } from './helpers/pi-test-database';

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function main() {
  const fixture = await fs.mkdtemp(path.join(process.cwd(), '.agent-bash-office-test-'));
  const keys = ['DATA', 'CANVAS_DATA_ROOT', 'CANVAS_RUNTIME_ENV', 'CANVAS_AGENT_BASH_SANDBOX',
    'CANVAS_AGENT_LANDLOCK_PATH', 'CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES', 'CANVAS_ORGANIZATION_ID',
    'CANVAS_DEPLOYMENT_MODE', 'CANVAS_TEAM_FEATURES_ENABLED', 'BASE_URL', 'CANVAS_MCP_DIRECT_ENABLED'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const data = path.join(fixture, 'data');
  const workspace = path.join(data, 'workspaces', 'team', 'bash-office-org', 'files');
  const skill = path.join(data, 'users', 'bash-office-user', 'skills', 'office-fixture');
  const secret = path.join(fixture, 'private', 'secret.txt');
  process.env.DATA = data;
  process.env.CANVAS_DATA_ROOT = data;
  process.env.CANVAS_RUNTIME_ENV = 'test';
  process.env.CANVAS_ORGANIZATION_ID = 'bash-office-org';
  process.env.CANVAS_DEPLOYMENT_MODE = 'team';
  process.env.CANVAS_TEAM_FEATURES_ENABLED = 'true';
  process.env.BASE_URL = 'http://localhost:3001';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.CANVAS_AGENT_BASH_SANDBOX = process.platform === 'linux' ? 'required' : 'local-development';
  delete process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES;
  const database = await createPiTestDatabase();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, parent, mainModule) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    return originalLoad(name, parent, mainModule);
  };

  try {
    await Promise.all([workspace, skill, path.dirname(secret), data].map((directory) => fs.mkdir(directory, { recursive: true })));
    const raw = await database.openDb();
    await raw.run(`INSERT INTO "user" (id,name,email,email_verified,role,created_at,updated_at)
      VALUES ('bash-office-user','Office fixture','office-fixture@example.test',1,'user',1,1)`);
    await raw.run(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES ('bash-office-org','bash-office-user','team',1,1,1)`);
    await raw.run(`INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at)
      VALUES ('bash-office-org','bash-office-user','owner','active',1,1,1)`);
    await raw.run(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ('bash-office-workspace','bash-office-org','team','workspaces/team/bash-office-org/files','Bash Office test','active',1,1)`);
    await raw.run(`INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
      VALUES ('bash-office-org','bash-office-workspace','bash-office-user','member','active',1,1,1,1,1)`);
    await raw.run(`INSERT INTO agents (agent_id,name,type,access_policy,scope_type,owner_user_id,created_by_user_id,relevant_skills_json,created_at,updated_at)
      VALUES ('office-agent','Office fixture agent','custom','restricted','user','bash-office-user','bash-office-user','["office-fixture"]',1,1)`);
    await fs.writeFile(path.join(workspace, 'original.docx'), 'original document bytes');
    await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: office-fixture\ndescription: Office read fixture\n---\n\n# Office fixture\n');
    await fs.writeFile(path.join(skill, 'readable.txt'), 'skill-readable');
    await fs.writeFile(secret, 'private-sentinel');
    const { buildAgentBashEnvironment, executeAgentBashCommand } = await import('../app/lib/pi/agent-bash-runtime');
    const { cleanupAgentRuntimeTempDirs, ensureAgentRuntimeTempDir } = await import('../app/lib/pi/agent-runtime-temp');
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const resolveContext = async (sessionId: string): Promise<AgentExecutionContext> => {
      await raw.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,workspace_id,workspace_type,organization_id,workspace_root_relative_path,provider,model,created_at,updated_at)
        VALUES ($1,'bash-office-user','office-agent','bash-office-workspace','team','bash-office-org','workspaces/team/bash-office-org/files','fixture','fixture',1,1)`, [sessionId]);
      const issued = await resolveAgentExecutionContextForSession({ userId: 'bash-office-user', sessionId, agentId: 'office-agent' });
      assert(issued.skillReadRoots?.includes(skill), 'The actual personal package must be selected by the owned agent and its current workspace.');
      assert.equal(issued.workspaceRoot, workspace);
      return { ...issued, skillReadRoots: [skill] };
    };
    const context = await resolveContext('bash-office-session');
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

    const quotaContext = await resolveContext('quota-session');
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
    loader._load = originalLoad;
    await database.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
