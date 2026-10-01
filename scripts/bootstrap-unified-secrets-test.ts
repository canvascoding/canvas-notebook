import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CANONICAL_MASTER = 'fixture-bootstrap-canonical-master';
const LEGACY_INTEGRATIONS_MASTER = 'fixture-bootstrap-integrations-master';
const LEGACY_AGENTS_MASTER = 'fixture-bootstrap-agents-master';

function encrypted(value: string, master: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(master).digest(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
}

async function writeFixture(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 });
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-bootstrap-unified-secrets-'));
  const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const bootstrapScript = path.join(repositoryRoot, 'scripts', 'bootstrap-agent-runtime.ts');

  async function runBootstrap(dataRoot: string, oldMasterOverrides = false): Promise<void> {
    const env = { ...process.env };
    for (const key of [
      'CANVAS_DATA_ROOT', 'CANVAS_SECRETS_ENV_PATH', 'CANVAS_ENV_FILE', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH',
      'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY',
    ]) delete env[key];
    Object.assign(env, {
      NODE_ENV: 'test',
      DATA: dataRoot,
      CANVAS_DATABASE_PROVIDER: 'postgres',
      DATABASE_URL: '',
      CANVAS_APP_ROOT: repositoryRoot,
      CANVAS_SECRETS_MASTER_KEY: CANONICAL_MASTER,
      INTEGRATIONS_ENV_MASTER_KEY: oldMasterOverrides ? 'fixture-rotated-old-integrations-master' : LEGACY_INTEGRATIONS_MASTER,
      AGENTS_ENV_MASTER_KEY: oldMasterOverrides ? 'fixture-rotated-old-agents-master' : LEGACY_AGENTS_MASTER,
      CANVAS_BOOTSTRAP_SEED_PLUGINS: '__none__',
      CANVAS_BOOTSTRAP_SEED_SKILLS: '__none__',
    });
    await execFileAsync(process.execPath, [
      tsxCli,
      '--tsconfig',
      path.join(repositoryRoot, 'tsconfig.json'),
      bootstrapScript,
    ], { cwd: fixtureRoot, env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  }

  async function readSystemState(dataRoot: string) {
    const envKeys = [
      'DATA', 'CANVAS_DATA_ROOT', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH',
      'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY',
    ] as const;
    const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    try {
      for (const key of envKeys) delete process.env[key];
      process.env.CANVAS_DATA_ROOT = dataRoot;
      process.env.CANVAS_SECRETS_MASTER_KEY = CANONICAL_MASTER;
      process.env.INTEGRATIONS_ENV_MASTER_KEY = LEGACY_INTEGRATIONS_MASTER;
      process.env.AGENTS_ENV_MASTER_KEY = LEGACY_AGENTS_MASTER;
      const { readUnifiedEnvState } = await import('../app/lib/secrets/unified-env-store');
      return await readUnifiedEnvState({ secretScope: 'system' });
    } finally {
      for (const key of envKeys) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  try {
    const freshRoot = path.join(fixtureRoot, 'fresh-data');
    await fs.mkdir(path.join(freshRoot, 'settings'), { recursive: true });
    await writeFixture(path.join(freshRoot, 'settings', '.legacy-session-wipe-done'), '{}\n');
    await Promise.all([runBootstrap(freshRoot), runBootstrap(freshRoot)]);
    const freshCanonicalPath = path.join(freshRoot, 'system', 'secrets', 'Canvas-Secrets.env');
    const freshCanonical = await fs.readFile(freshCanonicalPath, 'utf8');
    assert.equal(freshCanonical, '', 'fresh installation creates the canonical secret file');
    await assert.rejects(fs.stat(path.join(freshRoot, 'secrets', 'Canvas-Integrations.env')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(freshRoot, 'secrets', 'Canvas-Agents.env')), { code: 'ENOENT' });
    assert.equal((await fs.stat(freshCanonicalPath)).mode & 0o777, 0o600);

    const migratedRoot = path.join(fixtureRoot, 'migrated-data');
    const oldIntegrations = path.join(migratedRoot, 'secrets', 'Canvas-Integrations.env');
    const oldAgents = path.join(migratedRoot, 'secrets', 'Canvas-Agents.env');
    await fs.mkdir(path.join(migratedRoot, 'settings'), { recursive: true });
    await writeFixture(path.join(migratedRoot, 'settings', '.legacy-session-wipe-done'), '{}\n');
    const integrationsSource = `SHARED=${encrypted('fixture-integration-shared', LEGACY_INTEGRATIONS_MASTER)}\nINTEGRATION_ONLY=${encrypted('fixture-integration-only', LEGACY_INTEGRATIONS_MASTER)}\n`;
    const agentsSource = `SHARED=${encrypted('fixture-agent-shared', LEGACY_AGENTS_MASTER)}\nAGENT_ONLY=${encrypted('fixture-agent-only', LEGACY_AGENTS_MASTER)}\n`;
    await writeFixture(oldIntegrations, integrationsSource);
    await writeFixture(oldAgents, agentsSource);
    await runBootstrap(migratedRoot);

    const state = await readSystemState(migratedRoot);
    const canonicalPath = path.join(migratedRoot, 'system', 'secrets', 'Canvas-Secrets.env');
    assert.equal(state.path, canonicalPath);
    assert.equal(state.exists, true);
    assert.equal(state.entries.find(entry => entry.key === 'SHARED')?.value, 'fixture-integration-shared');
    assert.equal(state.entries.find(entry => entry.key === 'CANVAS_PROFILE_AGENTS__SHARED')?.value, 'fixture-agent-shared');
    assert.equal(state.entries.find(entry => entry.key === 'INTEGRATION_ONLY')?.value, 'fixture-integration-only');
    assert.equal(state.entries.find(entry => entry.key === 'AGENT_ONLY')?.value, 'fixture-agent-only');
    const canonicalDisk = await fs.readFile(canonicalPath, 'utf8');
    assert.doesNotMatch(canonicalDisk, /fixture-(?:integration|agent)-(?:shared|only)/u, 'canonical disk contents do not include the fixture plaintexts');
    assert.match(canonicalDisk, /enc:env:v1:/u);
    assert.equal((await fs.stat(canonicalPath)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(oldIntegrations, 'utf8'), integrationsSource, 'legacy integrations source remains import-only');
    assert.equal(await fs.readFile(oldAgents, 'utf8'), agentsSource, 'legacy agents source remains import-only');

    const canonicalBeforeRestart = canonicalDisk;
    await writeFixture(oldIntegrations, `SHARED=${encrypted('fixture-replayed-integration', LEGACY_INTEGRATIONS_MASTER)}\nREPLAY_ONLY=${encrypted('fixture-replay-only', LEGACY_INTEGRATIONS_MASTER)}\n`);
    await writeFixture(oldAgents, `SHARED=${encrypted('fixture-replayed-agent', LEGACY_AGENTS_MASTER)}\n`);
    await runBootstrap(migratedRoot, true);
    assert.equal(await fs.readFile(canonicalPath, 'utf8'), canonicalBeforeRestart, 'restart does not replay changed legacy files or old master overrides');
    const restartedState = await readSystemState(migratedRoot);
    assert.equal(restartedState.entries.find(entry => entry.key === 'SHARED')?.value, 'fixture-integration-shared');
    assert.equal(restartedState.entries.find(entry => entry.key === 'CANVAS_PROFILE_AGENTS__SHARED')?.value, 'fixture-agent-shared');
    assert.equal(restartedState.entries.some(entry => entry.key === 'REPLAY_ONLY'), false);

    console.log('bootstrap-unified-secrets-test: fresh store, legacy import, divergent profiles, encryption, and restart passed');
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
