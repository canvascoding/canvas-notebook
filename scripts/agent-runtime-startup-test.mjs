import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const entrypoint = await readFile(path.join(repositoryRoot, 'scripts/docker-entrypoint.sh'), 'utf8');
const bootstrapStage = entrypoint.match(/^step "Agent runtime bootstrap"\n([\s\S]*?)\n# /m)?.[1];
assert.ok(bootstrapStage, 'The production entrypoint must contain the Agent runtime bootstrap stage');
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-agent-startup-'));

try {
  const dataRoot = path.join(fixtureRoot, 'data');
  await mkdir(path.join(dataRoot, 'settings'), { recursive: true });
  await writeFile(path.join(dataRoot, 'settings', '.legacy-session-wipe-done'), '{}\n');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:CANVAS_|INTEGRATIONS_|AGENTS_|DATABASE_URL|DATA$|NODE_OPTIONS$)/u.test(key)) delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'production', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot,
    CANVAS_ENV_FILE: path.join(fixtureRoot, 'absent.env'),
    CANVAS_APP_ROOT: repositoryRoot, CANVAS_DATABASE_PROVIDER: 'postgres', DATABASE_URL: '',
    CANVAS_BOOTSTRAP_SEED_PLUGINS: '__none__', CANVAS_BOOTSTRAP_SEED_SKILLS: '__none__',
    CANVAS_SECRETS_MASTER_KEY: 'fixture-agent-runtime-startup-master',
    PATH: `${path.join(repositoryRoot, 'node_modules', '.bin')}${path.delimiter}${env.PATH || ''}`,
    STARTUP_LOG: path.join(fixtureRoot, 'startup.log'),
  });
  const shellStage = `set -eu
step_ok() { printf 'BOOTSTRAP_STAGE_OK\\n'; }
step_fail() { cat "$STARTUP_LOG" >&2; }
fatal_startup() { printf '%s\\n' "$1" >&2; exit 1; }
${bootstrapStage}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { stdout } = await execFileAsync('sh', ['-c', shellStage], {
      cwd: repositoryRoot, env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.match(stdout, /BOOTSTRAP_STAGE_OK/u);
    assert.match(await readFile(env.STARTUP_LOG, 'utf8'), /Agent runtime bootstrap complete\./u);
    assert.ok((await readFile(path.join(dataRoot, 'agents', 'canvas-agent', 'AGENTS.md'), 'utf8')).length > 0);
  }
  console.log('agent-runtime-startup-test: production entrypoint bootstrap and restart passed');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
