import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import type { AiCredentialScope, AiProviderInstallation } from '../app/lib/agent-runtime-policy/types';

// Only the unrelated runtime settings loader is stubbed. Storage and each
// credential resolver below execute against real, isolated filesystem data.
const internals = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = internals._load;
internals._load = function (name, ...args) {
  if (name.endsWith('/agents/storage') || name === './storage') return {
    isManagedControlPlaneAvailable: () => Boolean(process.env.CANVAS_INSTANCE_TOKEN),
    readPiRuntimeConfig: async () => ({ providers: {} }),
  };
  return originalLoad.call(this, name, ...args);
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-secret-cascade-'));
  const saved = { ...process.env };
  const provider = (credentialScope: AiCredentialScope, providerId = 'openai'): AiProviderInstallation => ({
    installationId: `fixture-${credentialScope}`, providerId, credentialScope,
    name: 'Fixture', source: 'built-in', enabled: true, status: 'ready', config: { authMethod: 'api-key' },
    sourceRevision: null, lastSyncedAt: null, revision: 1, verifiedAt: null, verifiedByUserId: null, models: [],
  });

  try {
    process.env.CANVAS_DATA_ROOT = root;
    for (const key of ['DATA', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY', 'CANVAS_SECRETS_ENV_PATH', 'CANVAS_SECRETS_MASTER_KEY']) delete process.env[key];
    process.env.OPENAI_API_KEY = 'fixture-process';
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const { resolveProviderInstallationRuntimeAuth } = await import('../app/lib/agent-runtime-policy/installation-credentials');
    const { resolveStudioProviderCredential } = await import('../app/lib/integrations/studio-provider-credentials');
    const { resolveDictationCredential } = await import('../app/lib/dictation/credentials');
    const scopes = [
      { storage: { userId: 'alice' }, label: 'alice' },
      { storage: { userId: 'bob' }, label: 'bob' },
      { storage: { organizationId: 'org-a' }, label: 'org-a' },
      { storage: { organizationId: 'org-b' }, label: 'org-b' },
      { storage: undefined, label: 'system' },
    ];
    for (const { storage, label } of scopes) {
      await replaceScopedEnvEntries('integrations', [{ key: 'OPENAI_API_KEY', value: `fixture-${label}-media` }], storage);
      await replaceScopedEnvEntries('agents', [{ key: 'OPENAI_API_KEY', value: `fixture-${label}-agent` }], storage);
    }
    const auth = (scope: AiCredentialScope, userId = 'alice', organizationId = 'org-a') =>
      resolveProviderInstallationRuntimeAuth({ provider: provider(scope), userId, organizationId });
    assert.equal((await auth('user')).apiKey, 'fixture-alice-agent');
    assert.equal((await auth('user', 'bob')).apiKey, 'fixture-bob-agent');
    assert.equal((await auth('organization')).apiKey, 'fixture-org-a-agent');
    assert.equal((await auth('organization', 'alice', 'org-b')).apiKey, 'fixture-org-b-agent');
    assert.equal((await auth('system')).apiKey, 'fixture-system-agent');
    assert.equal((await auth('user', 'missing')).configured, false, 'personal installations must not borrow system credentials');
    assert.equal((await auth('organization', 'alice', 'missing')).configured, false, 'organization installations must not borrow system credentials');
    assert.equal(await resolveStudioProviderCredential('openai', { userId: 'alice' }), 'fixture-alice-media');
    assert.equal(await resolveStudioProviderCredential('openai', { organizationId: 'org-a' }), 'fixture-org-a-media');
    assert.equal(await resolveStudioProviderCredential('openai', { userId: 'missing' }), 'fixture-system-media');
    assert.equal((await resolveDictationCredential('openai')).value, 'fixture-system-media');

    await replaceScopedEnvEntries('agents', []);
    await replaceScopedEnvEntries('integrations', []);
    assert.equal((await auth('system')).apiKey, 'fixture-process');
    assert.equal(await resolveStudioProviderCredential('openai'), 'fixture-process');
    delete process.env.OPENAI_API_KEY;
    assert.equal(await resolveStudioProviderCredential('openai'), null, 'no local key leaves the managed fallback eligible');
    process.env.CANVAS_INSTANCE_TOKEN = 'fixture-instance-token';
    const managed = await resolveProviderInstallationRuntimeAuth({ provider: provider('managed', 'canvas-control-plane'), userId: 'alice', organizationId: 'org-a' });
    assert.equal(managed.apiKey, 'fixture-instance-token');
    const invalidManagedScope = await resolveProviderInstallationRuntimeAuth({ provider: provider('user', 'canvas-control-plane'), userId: 'alice', organizationId: 'org-a' });
    assert.equal(invalidManagedScope.configured, false);
    console.log('Secret cascade contracts passed: two users, two organizations, system, process fallback and managed identity.');
  } finally {
    internals._load = originalLoad;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
