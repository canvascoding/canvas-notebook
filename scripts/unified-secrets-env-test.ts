import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  readUnifiedEnvState, patchUnifiedEnvEntries, replaceUnifiedEnvRaw, getUnifiedEnvFilePath,
  readUnifiedSecretValue, mutateUnifiedSecretValue, readScopedEnvState, writeScopedEnvRaw,
  replaceScopedEnvEntries, SecretRevisionConflictError,
} from '../app/lib/integrations/env-config';
import { parseEnvDocument, formatEnvValue } from '../app/lib/secrets/env-document';

const scope = process.env.CANVAS_SECRET_TEST_SYSTEM === 'true' ? undefined : { userId: 'parallel' };
async function child() {
  for (let iteration = 0; iteration < 8; iteration++) await mutateUnifiedSecretValue('COUNTER', async current => {
    await new Promise(resolve => setTimeout(resolve, 2));
    return String(Number(current ?? 0) + 1);
  }, scope);
}
async function runChild(env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('scripts/unified-secrets-env-test.ts'), '--child'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Child failed (${code}): ${output}`)));
  });
}
function encrypted(value: string, master: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(master).digest(), iv);
  const body = Buffer.concat([cipher.update(value), cipher.final()]);
  return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
}
async function fixture(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, content, { mode: 0o600 });
}
async function main() {
  const saved = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-unified-secrets-'));
  try {
    process.env.CANVAS_DATA_ROOT = root;
    for (const key of ['DATA', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY']) delete process.env[key];
    const values = ['#hash $literal ${OTHER}', 'quotes " and \\ slash', "single ' quotes", 'a\nb\r\tc', '\0\b\f', '€ 😀', ''];
    for (const value of values) assert.equal(parseEnvDocument(`KEY=${formatEnvValue(value)}\n`)[0].value, value);
    assert.equal(parseEnvDocument('A="line one\nline two" # tail\n')[0].value, 'line one\nline two');
    assert.equal(parseEnvDocument("A='literal \\n $X #hash'\n")[0].value, 'literal \\n $X #hash');
    assert.throws(() => parseEnvDocument('A=one\nA=two\n'), /Duplicate/);
    assert.throws(() => parseEnvDocument('BROKEN\n'), /Invalid/);
    assert.throws(() => parseEnvDocument('A="unterminated\n'), /Unterminated/);
    assert.throws(() => parseEnvDocument('A="ok"bad\n'), /Unexpected/);
    const user = { userId: 'alice' };
    await fixture(path.join(root, 'users/alice/secrets/Canvas-Integrations.env'), '# media comment\nOPENAI_API_KEY=media # media inline\nLITERAL="hash # and $literal"\n');
    await fixture(path.join(root, 'users/alice/secrets/Canvas-Agents.env'), '# agent comment\nOPENAI_API_KEY=agent # agent inline\nAGENT_ONLY=unique\n');
    assert.equal(readUnifiedSecretValue('OPENAI_API_KEY', user), 'media');
    assert.equal(await fs.stat(getUnifiedEnvFilePath(user)).catch(() => null), null, 'sync fallback must not migrate');
    let state = await readUnifiedEnvState(user);
    assert.equal(state.entries.find(entry => entry.key === 'OPENAI_API_KEY')?.value, 'media');
    assert.equal(state.entries.find(entry => entry.key === 'CANVAS_PROFILE_AGENTS__OPENAI_API_KEY')?.value, 'agent');
    assert.equal(state.entries.find(entry => entry.key === 'AGENT_ONLY')?.value, 'unique');
    assert.match(state.rawContent, /# media comment/); assert.match(state.rawContent, /# agent comment/);
    assert.match(state.rawContent, /# media inline/); assert.match(state.rawContent, /# agent inline/);
    assert.equal((await readScopedEnvState('agents', user)).entries.find(entry => entry.key === 'OPENAI_API_KEY')?.value, 'agent');
    assert.equal((await readScopedEnvState('integrations', user)).entries.some(entry => entry.key === 'AGENT_ONLY'), false);
    await writeScopedEnvRaw('integrations', '# new media\nOTHER_KEY=preserved\n', user);
    assert.equal((await readScopedEnvState('agents', user)).entries.find(entry => entry.key === 'AGENT_ONLY')?.value, 'unique');
    assert.equal((await readScopedEnvState('agents', user)).entries.find(entry => entry.key === 'OPENAI_API_KEY')?.value, 'agent');
    await replaceScopedEnvEntries('agents', [], user);
    assert.equal((await readScopedEnvState('integrations', user)).entries.find(entry => entry.key === 'OTHER_KEY')?.value, 'preserved');
    state = await readUnifiedEnvState(user);
    const revision = state.revision;
    state = await patchUnifiedEnvEntries([{ key: 'CUSTOM', value: values[0] }], user, revision);
    assert.match(state.rawContent, /# media comment/); assert.match(state.rawContent, /# new media/);
    await assert.rejects(() => replaceUnifiedEnvRaw('CUSTOM=stale\n', revision, user), SecretRevisionConflictError);
    await mutateUnifiedSecretValue('CANVAS_CREDENTIAL_TEST', async () => '{"token":"fixture"}', user);
    await assert.rejects(() => patchUnifiedEnvEntries([{ key: 'CANVAS_PROFILE_OWNERS__CUSTOM', value: 'agents' }], user), /Protected/);
    state = await readUnifiedEnvState(user);
    assert.equal((await readScopedEnvState('integrations', user)).entries.some(entry => entry.key.startsWith('CANVAS_CREDENTIAL_')), false);
    await replaceUnifiedEnvRaw('# expert\nCUSTOM=changed\n', state.revision, user);
    assert.equal(readUnifiedSecretValue('CANVAS_CREDENTIAL_TEST', user), '{"token":"fixture"}');
    state = await readUnifiedEnvState(user);
    await assert.rejects(() => replaceUnifiedEnvRaw('CANVAS_CREDENTIAL_TEST=oops\n', state.revision, user), /credentials/);
    await mutateUnifiedSecretValue('CANVAS_CREDENTIAL_TEST', async () => null, user);
    assert.equal(readUnifiedSecretValue('CANVAS_CREDENTIAL_TEST', user), 'null');
    for (const operation of ['update-integrations', 'delete-integrations', 'update-agents', 'delete-agents']) {
      const paired = { userId: operation };
      await fixture(path.join(root, `users/${operation}/secrets/Canvas-Integrations.env`), 'SAME=original\n');
      await fixture(path.join(root, `users/${operation}/secrets/Canvas-Agents.env`), 'SAME=original\n');
      await readUnifiedEnvState(paired);
      const view = operation.endsWith('agents') ? 'agents' : 'integrations';
      await replaceScopedEnvEntries(view, operation.startsWith('update') ? [{ key: 'SAME', value: 'updated' }] : [], paired);
      const other = await readScopedEnvState(view === 'agents' ? 'integrations' : 'agents', paired);
      assert.equal(other.entries.find(entry => entry.key === 'SAME')?.value, 'original', `${operation} preserves the other legacy view`);
      const changed = await readScopedEnvState(view, paired);
      assert.equal(changed.entries.find(entry => entry.key === 'SAME')?.value, operation.startsWith('update') ? 'updated' : undefined);
    }
    await patchUnifiedEnvEntries([{ key: 'ORG', value: 'organization' }], { organizationId: 'org-a' });
    assert.equal((await readUnifiedEnvState({ organizationId: 'org-b' })).entries.length, 0);
    assert.equal((await readUnifiedEnvState({ userId: 'bob' })).entries.length, 0);
    await fixture(path.join(root, 'secrets/Canvas-Integrations.env'), 'LEGACY=old\nDUP=legacy-value\n');
    await fixture(path.join(root, 'system/secrets/Canvas-Integrations.env'), 'SYSTEM=explicit\nDUP=system-value\n');
    await fixture(path.join(root, 'secrets/Canvas-Agents.env'), 'DUP=legacy-agent # legacy agent comment\nAGENT_UNIQUE=legacy-unique\n');
    await fixture(path.join(root, 'system/secrets/Canvas-Agents.env'), 'DUP=dormant-agent # dormant agent comment\nAGENT_UNIQUE=dormant-unique\n');
    const externalAgent = path.join(root, 'external/old-agents.env');
    await fixture(externalAgent, 'DUP=active-agent # active agent comment\nAGENT_UNIQUE=active-unique\n');
    process.env.AGENTS_ENV_PATH = externalAgent;
    const external = path.join(root, 'external/old-integrations.env');
    await fixture(external, 'OVERRIDE=imported\nDUP=override-value\n'); process.env.INTEGRATIONS_ENV_PATH = external;
    state = await readUnifiedEnvState({ secretScope: 'system' });
    assert.equal(getUnifiedEnvFilePath(null), getUnifiedEnvFilePath({ secretScope: 'system' }));
    assert.equal(state.entries.find(entry => entry.key === 'LEGACY')?.value, 'old');
    assert.equal(state.entries.find(entry => entry.key === 'OVERRIDE')?.value, 'imported');
    assert.equal(state.entries.find(entry => entry.key === 'DUP')?.value, 'override-value');
    const systemAgents = await readScopedEnvState('agents');
    assert.equal(systemAgents.entries.find(entry => entry.key === 'DUP')?.value, 'active-agent');
    assert.equal(systemAgents.entries.some(entry => entry.value === 'dormant-agent' || entry.value === 'legacy-agent'), false);
    assert.equal(systemAgents.entries.find(entry => entry.key === 'AGENT_UNIQUE')?.value, 'active-unique');
    assert.equal(systemAgents.entries.some(entry => /__2$/.test(entry.key)), false);
    assert.match(state.rawContent, /# dormant agent comment/);
    assert.equal(state.entries.find(entry => entry.key === 'CANVAS_PROFILE_SOURCE_AGENTS__DUP__2')?.value, 'dormant-agent');
    assert.equal(state.entries.find(entry => entry.key === 'CANVAS_PROFILE_SOURCE_AGENTS__DUP')?.value, 'legacy-agent');
    assert.equal(state.entries.find(entry => entry.key === 'CANVAS_PROFILE_SOURCE_INTEGRATIONS__DUP')?.value, 'legacy-value');
    assert.equal(state.entries.find(entry => entry.key === 'CANVAS_PROFILE_SOURCE_INTEGRATIONS__DUP__2')?.value, 'system-value');
    assert.equal((await readUnifiedEnvState({ scopeType: 'system' })).path, state.path);
    const migratedRevision = state.revision;
    await fixture(external, 'OVERRIDE=changed-old-file\n');
    assert.equal((await readUnifiedEnvState()).revision, migratedRevision, 'migration runs once; old sources cannot resurrect or overwrite');
    process.env.CANVAS_SECRETS_ENV_PATH = path.join(root, 'custom/new.env');
    assert.equal(getUnifiedEnvFilePath(), process.env.CANVAS_SECRETS_ENV_PATH);
    assert.equal(getUnifiedEnvFilePath(user), path.join(root, 'users/alice/secrets/Canvas-Secrets.env'));
    delete process.env.CANVAS_SECRETS_ENV_PATH;
    process.env.INTEGRATIONS_ENV_MASTER_KEY = 'original-media'; process.env.AGENTS_ENV_MASTER_KEY = 'original-agent'; process.env.CANVAS_SECRETS_MASTER_KEY = 'new-master';
    const secure = { userId: 'secure' };
    await fixture(path.join(root, 'users/secure/secrets/Canvas-Integrations.env'), `SECURE=${encrypted('media-plain', 'original-media')}\n`);
    await fixture(path.join(root, 'users/secure/secrets/Canvas-Agents.env'), `SECURE=${encrypted('agent-plain', 'original-agent')}\n`);
    state = await readUnifiedEnvState(secure);
    assert.equal(state.entries.find(entry => entry.key === 'SECURE')?.value, 'media-plain');
    assert.equal((await readScopedEnvState('agents', secure)).entries.find(entry => entry.key === 'SECURE')?.value, 'agent-plain');
    const disk = await fs.readFile(state.path, 'utf8'); assert.equal(disk.includes('media-plain'), false); assert.match(disk, /enc:v1:/);
    process.env.CANVAS_SECRETS_MASTER_KEY = 'wrong-master';
    assert.equal((await readUnifiedEnvState(secure)).readable, false);
    await assert.rejects(() => patchUnifiedEnvEntries([{ key: 'ANY', value: 'x' }], secure), /cannot be read safely/);
    await assert.rejects(() => readScopedEnvState('agents', secure), /cannot be read safely/);
    assert.throws(() => readUnifiedSecretValue('SECURE', secure), /cannot be decrypted/);
    delete process.env.CANVAS_SECRETS_MASTER_KEY;
    delete process.env.INTEGRATIONS_ENV_MASTER_KEY; delete process.env.AGENTS_ENV_MASTER_KEY;
    const broken = { userId: 'broken' };
    await fixture(path.join(root, 'users/broken/secrets/Canvas-Agents.env'), `SECRET=${encrypted('hidden', 'missing')}\n`);
    await assert.rejects(() => readUnifiedEnvState(broken), /original master key/);
    assert.equal(await fs.stat(getUnifiedEnvFilePath(broken)).catch(() => null), null);
    const malformed = { userId: 'malformed' };
    await fixture(path.join(root, 'users/malformed/secrets/Canvas-Agents.env'), 'A=one\nA=two\n');
    await assert.rejects(() => readUnifiedEnvState(malformed), /Duplicate/);
    assert.equal(await fs.stat(getUnifiedEnvFilePath(malformed)).catch(() => null), null);
    await Promise.all(Array.from({ length: 4 }, () => runChild()));
    assert.equal(readUnifiedSecretValue('COUNTER', scope), '32', 'independent processes serialize read/refresh/write');
    assert.equal((await fs.stat(getUnifiedEnvFilePath(scope))).mode & 0o777, 0o600);
    const sharedOverride = path.join(root, 'shared/system.env');
    await Promise.all(Array.from({ length: 4 }, (_, index) => runChild({ ...process.env, CANVAS_SECRET_TEST_SYSTEM: 'true', CANVAS_DATA_ROOT: path.join(root, `other-data-${index}`), CANVAS_SECRETS_ENV_PATH: sharedOverride })));
    process.env.CANVAS_SECRETS_ENV_PATH = sharedOverride;
    assert.equal(readUnifiedSecretValue('COUNTER'), '32', 'one override file remains atomic across different DATA roots');
    delete process.env.CANVAS_SECRETS_ENV_PATH;
    console.log('unified-secrets-env-test: parser, migration, profiles, scoped isolation, revisions, encryption, protection and cross-process transactions passed');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true });
  }
}
(process.argv.includes('--child') ? child() : main()).catch(error => { console.error(error); process.exitCode = 1; });
