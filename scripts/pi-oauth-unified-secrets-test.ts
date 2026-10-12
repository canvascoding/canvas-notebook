import assert from 'node:assert/strict';
import Module, { registerHooks } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CredentialStore } from '@earendil-works/pi-ai';

let latestStore: CredentialStore;
let loginSequence = 0;
const internals = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = internals._load;
const fixtureSdk = {
    builtinModels: ({ credentials }: { credentials: CredentialStore }) => {
      latestStore = credentials;
      return {
        getAuth: async (provider: string) => {
          const initial = await credentials.read(provider);
          if (!initial) return undefined;
          const current = await credentials.modify(provider, async credential => {
            if (!credential || credential.type !== 'oauth') return credential;
            if (credential.expires > Date.now()) return credential;
            await new Promise(resolve => setTimeout(resolve, 30));
            return { ...credential, access: `${credential.access}:refreshed`, refresh: `${credential.refresh}:rotated`, expires: Date.now() + 120_000 };
          });
          return current?.type === 'oauth' ? { auth: { apiKey: current.access }, env: {} } : undefined;
        },
        login: async (provider: string) => credentials.modify(provider, async () => ({
          type: 'oauth', access: `fixture-login-${++loginSequence}`, refresh: `fixture-refresh-${loginSequence}`, expires: Date.now() + 120_000,
        })),
      };
    },
};
const fixtureGlobal = globalThis as typeof globalThis & { __canvasOAuthFixtureSdk?: typeof fixtureSdk };
fixtureGlobal.__canvasOAuthFixtureSdk = fixtureSdk;
// PI's SDK is ESM: a CJS _load stub alone cannot intercept dynamic imports.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@earendil-works/pi-ai/providers/all') return {
      url: 'data:text/javascript,export const builtinModels = (options) => globalThis.__canvasOAuthFixtureSdk.builtinModels(options);', shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
internals._load = function (name, ...args) {
  if (name === 'server-only') return {};
  if (name === '@earendil-works/pi-ai/providers/all') return fixtureSdk;
  return originalLoad.call(this, name, ...args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected network request in isolated OAuth fixture.'); };
async function child() {
  const { getProviderApiKey } = await import('../app/lib/pi/oauth');
  const provider = process.argv[process.argv.indexOf('--child') + 1] as 'openai-codex' | 'openrouter';
  await getProviderApiKey(provider, { userId: 'parallel' });
}
async function runChild(provider: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const worker = spawn(process.execPath, ['--import', 'tsx', path.resolve('scripts/pi-oauth-unified-secrets-test.ts'), '--child', provider], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    worker.stdout.on('data', chunk => { output += chunk; }); worker.stderr.on('data', chunk => { output += chunk; });
    worker.once('error', reject); worker.once('close', code => code === 0 ? resolve() : reject(new Error(`OAuth child failed (${code}): ${output}`)));
  });
}
async function fixture(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
}
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-oauth-unified-'));
  const saved = { ...process.env };
  try {
    process.env.CANVAS_DATA_ROOT = root;
    for (const key of ['DATA', 'OAUTH_STORAGE_PATH', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY']) delete process.env[key];
    const oauth = await import('../app/lib/pi/oauth');
    const env = await import('../app/lib/integrations/env-config');
    const userA = { userId: 'alice' }; const userB = { userId: 'bob' };
    const provider = 'openai-codex';
    const key = 'CANVAS_CREDENTIAL_PI_OAUTH';
    const credentials = (access: string, expires = Date.now() + 120_000) => ({ access, refresh: `${access}-refresh`, expires });
    await oauth.initiateOAuthLogin(provider, () => undefined, async () => '', undefined, userA);
    const a = oauth.getProviderCredentials(provider, userA)!;
    await oauth.initiateOAuthLogin(provider, () => undefined, async () => '', undefined, userB);
    assert.notEqual(oauth.getProviderCredentials(provider, userB)!.access, a.access);
    assert.equal(oauth.getProviderCredentials(provider, { userId: 'missing' }), null);
    await oauth.saveProviderCredentials(provider, credentials('global-fixture'));
    assert.equal(oauth.getProviderCredentials(provider, { userId: 'missing' }), null, 'personal scope never borrows the system token');
    assert.equal((await oauth.getProviderRequestAuth(provider, userA))?.apiKey, a.access);
    const revision = (await env.readUnifiedEnvState(userA)).revision;
    assert.equal((await oauth.getProviderApiKey(provider, userA))?.apiKey, a.access);
    await latestStore.list();
    assert.equal((await env.readUnifiedEnvState(userA)).revision, revision, 'read/list/unexpired getAuth retain exact revision');
    await oauth.saveProviderCredentials(provider, credentials('alice-expired', 1), userA);
    assert.equal((await oauth.refreshProviderToken(provider, userA))?.access, 'alice-expired:refreshed');
    assert.equal(oauth.getProviderCredentials(provider, userB)?.access, 'fixture-login-2');
    await oauth.initiateOAuthLogin(provider, () => undefined, async () => '', undefined, userA);
    assert.equal(oauth.getProviderCredentials(provider, userA)?.access, 'fixture-login-3', 'reconnect replaces only this user/provider');
    await oauth.removeProviderCredentials(provider, userA);
    assert.equal(env.readUnifiedSecretValue(key, userA), '{}');
    assert.equal(oauth.getProviderCredentials(provider, userA), null);
    assert.equal(oauth.getProviderCredentials(provider, userB)?.access, 'fixture-login-2');
    const personalLegacy = { userId: 'legacy-personal' };
    const legacyFile = path.join(root, 'users/legacy-personal/settings/auth.json');
    const legacy = { [provider]: credentials('legacy-personal') };
    await fixture(legacyFile, legacy);
    assert.equal(oauth.getProviderCredentials(provider, personalLegacy)?.access, 'legacy-personal');
    assert.equal(await fs.stat(oauth.getAuthFilePath(personalLegacy)).catch(() => null), null, 'sync status lookup is read-only');
    const originalSource = await fs.readFile(legacyFile, 'utf8');
    assert.equal((await oauth.getProviderApiKey(provider, personalLegacy))?.apiKey, 'legacy-personal');
    assert.equal(await fs.readFile(legacyFile, 'utf8'), originalSource, 'migration does not modify auth.json');
    await oauth.removeProviderCredentials(provider, personalLegacy);
    assert.equal(env.readUnifiedSecretValue(key, personalLegacy), '{}');
    assert.equal(oauth.getProviderCredentials(provider, personalLegacy), null, 'logout cannot resurrect retained auth.json');
    const customRoot = await fs.mkdtemp(path.join(root, 'custom-system-'));
    process.env.CANVAS_DATA_ROOT = customRoot;
    const customFile = path.join(customRoot, 'auth-source.json');
    await fixture(customFile, { openrouter: credentials('custom-system') }); process.env.OAUTH_STORAGE_PATH = customFile;
    assert.equal(oauth.getProviderCredentials('openrouter')?.access, 'custom-system');
    assert.equal((await oauth.getProviderApiKey('openrouter'))?.apiKey, 'custom-system');
    assert.equal(oauth.getProviderCredentials('openrouter', { userId: 'missing' }), null);
    await fixture(customFile, { openrouter: credentials('changed-source') });
    assert.equal(oauth.getProviderCredentials('openrouter')?.access, 'custom-system', 'source override imports once');
    assert.equal(oauth.getAuthFilePath(), path.join(customRoot, 'system/secrets/Canvas-Secrets.env'));
    const fallbackRoot = await fs.mkdtemp(path.join(root, 'legacy-global-'));
    process.env.CANVAS_DATA_ROOT = fallbackRoot; delete process.env.OAUTH_STORAGE_PATH;
    await fixture(path.join(fallbackRoot, 'canvas-agent/auth.json'), { [provider]: credentials('fallback-global') });
    assert.equal((await oauth.getProviderApiKey(provider))?.apiKey, 'fallback-global');
    assert.equal(await fs.stat(path.join(fallbackRoot, 'settings/auth.json')).catch(() => null), null);
    process.env.CANVAS_DATA_ROOT = root;
    const malformed = { userId: 'malformed' };
    await fixture(path.join(root, 'users/malformed/settings/auth.json'), { [provider]: { access: 'bad' } });
    assert.throws(() => oauth.getProviderCredentials(provider, malformed), /invalid provider credential/);
    await assert.rejects(() => oauth.saveProviderCredentials(provider, credentials('new'), malformed), /invalid provider credential/);
    assert.equal(await fs.stat(oauth.getAuthFilePath(malformed)).catch(() => null), null);
    await env.mutateUnifiedSecretValue(key, async () => '["invalid"]', userA);
    assert.throws(() => oauth.getAllProviderStatus(userA), /provider map/);
    await assert.rejects(() => oauth.saveProviderCredentials(provider, credentials('new'), userA), /provider map/);
    await env.mutateUnifiedSecretValue(key, async () => '{invalid-sensitive-input', userA);
    assert.throws(() => oauth.getProviderCredentials(provider, userA), error => error instanceof Error && error.message === 'PI OAuth credential data is not valid JSON.');
    await env.mutateUnifiedSecretValue(key, async () => '{}', userA);
    process.env.CANVAS_SECRETS_MASTER_KEY = 'fixture-master';
    const secure = { userId: 'secure' };
    await oauth.saveProviderCredentials(provider, credentials('secure-fixture'), secure);
    const disk = await fs.readFile(oauth.getAuthFilePath(secure), 'utf8'); assert.equal(disk.includes('secure-fixture'), false);
    process.env.CANVAS_SECRETS_MASTER_KEY = 'wrong-master';
    assert.throws(() => oauth.getProviderCredentials(provider, secure), /cannot be decrypted/);
    await assert.rejects(() => oauth.removeProviderCredentials(provider, secure), /cannot be read safely/);
    delete process.env.CANVAS_SECRETS_MASTER_KEY;
    const parallel = { userId: 'parallel' };
    await oauth.saveProviderCredentials(provider, credentials('parallel-codex', 1), parallel);
    const connectionBeforeRefresh = oauth.getProviderConnectionId(provider, parallel);
    await oauth.saveProviderCredentials('openrouter', credentials('parallel-router', 1), parallel);
    await Promise.all([runChild(provider), runChild('openrouter')]);
    assert.equal(oauth.getProviderConnectionId(provider, parallel), connectionBeforeRefresh, 'token rotation preserves the tested account connection');
    assert.equal(oauth.getProviderCredentials(provider, parallel)?.access, 'parallel-codex:refreshed');
    assert.equal(oauth.getProviderCredentials('openrouter', parallel)?.access, 'parallel-router:refreshed', 'different-provider refreshes cannot lose each other');
    await oauth.saveProviderCredentials(provider, credentials('same-provider', 1), parallel);
    assert.notEqual(oauth.getProviderConnectionId(provider, parallel), connectionBeforeRefresh, 'reconnect invalidates the old model check');
    await Promise.all([runChild(provider), runChild(provider)]);
    assert.equal(oauth.getProviderCredentials(provider, parallel)?.access, 'same-provider:refreshed', 'second process sees the first refresh and does not rotate twice');
    assert.equal((await fs.stat(oauth.getAuthFilePath(parallel))).mode & 0o777, 0o600);
    console.log('PI OAuth unified storage: two-user login/read/refresh/reconnect/logout, read-only migration, custom override, tombstones, schema/encryption fail-closed and atomic cross-process refresh passed.');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true }); internals._load = originalLoad;
    hooks.deregister(); delete fixtureGlobal.__canvasOAuthFixtureSdk; globalThis.fetch = originalFetch;
  }
}
(process.argv.includes('--child') ? child() : main()).catch(error => { console.error(error); process.exitCode = 1; });
