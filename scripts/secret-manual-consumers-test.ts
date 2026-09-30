import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@composio/core') {
    return { Composio: class { connectedAccounts = { list: async () => ({ items: [] }) }; } };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-secret-manual-consumers-'));
  const names = [
    'CANVAS_DATA_ROOT', 'DATA', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH',
    'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'CANVAS_MANAGED_SERVICES_ENABLED',
    'CANVAS_CONTROL_PLANE_URL', 'CANVAS_INSTANCE_TOKEN', 'CANVAS_INSTANCE_ID', 'OPENAI_API_KEY',
    'GEMINI_API_KEY', 'GROQ_API_KEY', 'KIE_API_KEY', 'BRAVE_API_KEY', 'OLLAMA_API_KEY', 'COMPOSIO_USER_ID',
    'COMPOSIO_API_KEY',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    for (const name of names.slice(1)) delete process.env[name];
    process.env.CANVAS_SECRETS_MASTER_KEY = 'manual-consumer-test-master';

    const envConfig = await import('../app/lib/integrations/env-config');
    const {
      getGeminiApiKeyFromIntegrations,
      getOpenAIApiKeyFromIntegrations,
      getGroqApiKeyFromIntegrations,
      getKieApiKeyFromIntegrations,
      readScopedEnvState,
      replaceScopedEnvEntries,
    } = envConfig;
    const { getLocalBraveApiKey, getLocalOllamaApiKey } = await import('../app/lib/integrations/brave-search-service');
    const { getComposioUserId, resetComposioUserIdCache } = await import('../app/lib/composio/composio-identity');
    const { getLocalComposioApiKey } = await import('../app/lib/composio/composio-client');

    const user = { userId: 'manual-user' };
    const organization = { organizationId: 'manual-org' };
    const processEntries = [
      ['GEMINI_API_KEY', 'process-gemini'], ['OPENAI_API_KEY', 'process-openai'],
      ['GROQ_API_KEY', 'process-groq'], ['KIE_API_KEY', 'process-kie'],
      ['BRAVE_API_KEY', 'process-brave'], ['OLLAMA_API_KEY', 'process-ollama'],
    ] as const;
    for (const [key, value] of processEntries) process.env[key] = value;

    await replaceScopedEnvEntries('integrations', [
      { key: 'GEMINI_API_KEY', value: 'user-gemini' },
      { key: 'OPENAI_API_KEY', value: 'user-openai' },
      { key: 'BRAVE_API_KEY', value: 'user-brave' },
    ], user);
    await replaceScopedEnvEntries('integrations', [
      { key: 'GROQ_API_KEY', value: 'org-groq' },
      { key: 'OLLAMA_API_KEY', value: 'org-ollama' },
    ], organization);
    await replaceScopedEnvEntries('integrations', [{ key: 'KIE_API_KEY', value: 'system-kie' }]);

    assert.equal(await getGeminiApiKeyFromIntegrations(user), 'user-gemini');
    assert.equal(await getOpenAIApiKeyFromIntegrations(user), 'user-openai');
    assert.equal(await getGroqApiKeyFromIntegrations(organization), 'org-groq');
    assert.equal(await getKieApiKeyFromIntegrations(), 'system-kie');
    assert.equal(await getLocalBraveApiKey(user), 'user-brave');
    assert.equal(await getLocalOllamaApiKey(organization), 'org-ollama');
    assert.equal(await getOpenAIApiKeyFromIntegrations({ userId: 'no-entry' }), 'process-openai');

    process.env.COMPOSIO_API_KEY = 'process-composio';
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'system-composio' }]);
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'user-composio' }], user);
    assert.equal(await getLocalComposioApiKey(user), 'system-composio');
    await replaceScopedEnvEntries('integrations', []);
    assert.equal(await getLocalComposioApiKey(user), 'user-composio');
    await replaceScopedEnvEntries('integrations', [], user);
    assert.equal(await getLocalComposioApiKey(user), 'process-composio');
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    process.env.CANVAS_CONTROL_PLANE_URL = 'https://control.example.test';
    process.env.CANVAS_INSTANCE_TOKEN = 'manual-test-token';
    assert.equal(await getLocalComposioApiKey({ userId: 'no-composio-key' }), null);
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';
    delete process.env.CANVAS_CONTROL_PLANE_URL;
    delete process.env.CANVAS_INSTANCE_TOKEN;

    await replaceScopedEnvEntries('integrations', [
      { key: 'GEMINI_API_KEY', value: 'stored-gemini' },
      { key: 'OPENAI_API_KEY', value: 'stored-openai' },
      { key: 'GROQ_API_KEY', value: 'stored-groq' },
      { key: 'KIE_API_KEY', value: 'stored-kie' },
      { key: 'BRAVE_API_KEY', value: 'stored-brave' },
      { key: 'OLLAMA_API_KEY', value: 'stored-ollama' },
    ], { userId: 'encrypted-user' });
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'stored-composio' }]);
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'scoped-composio' }], { userId: 'encrypted-user' });
    process.env.CANVAS_SECRETS_MASTER_KEY = 'wrong-manual-consumer-key';
    process.env.COMPOSIO_USER_ID = 'process-composio-decoy';
    const unreadableScope = { userId: 'encrypted-user' };
    const previousConsoleError = console.error;
    console.error = () => undefined;
    try {
      for (const read of [
        () => getGeminiApiKeyFromIntegrations(unreadableScope),
        () => getOpenAIApiKeyFromIntegrations(unreadableScope),
        () => getGroqApiKeyFromIntegrations(unreadableScope),
        () => getKieApiKeyFromIntegrations(unreadableScope),
        () => getLocalBraveApiKey(unreadableScope),
        () => getLocalOllamaApiKey(unreadableScope),
        () => getComposioUserId(unreadableScope),
        () => getLocalComposioApiKey(unreadableScope),
      ]) await assert.rejects(read);
    } finally {
      console.error = previousConsoleError;
    }

    process.env.CANVAS_SECRETS_MASTER_KEY = 'manual-consumer-test-master';
    process.env.CANVAS_INSTANCE_ID = 'manual-instance';
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';
    process.env.COMPOSIO_USER_ID = 'process-composio-id';
    const composioScope = { userId: 'composio-user' };
    await replaceScopedEnvEntries('integrations', [{ key: 'PRESERVE_ME', value: 'fixture' }], composioScope);
    resetComposioUserIdCache();
    const concurrentIds = await Promise.all(Array.from({ length: 12 }, () => getComposioUserId(composioScope)));
    assert.equal(new Set(concurrentIds).size, 1);
    assert.notEqual(concurrentIds[0], 'process-composio-id');
    const composioState = await readScopedEnvState('integrations', composioScope);
    assert.equal(composioState.entries.find((entry) => entry.key === 'COMPOSIO_USER_ID')?.value, concurrentIds[0]);
    assert.equal(composioState.entries.find((entry) => entry.key === 'PRESERVE_ME')?.value, 'fixture');

    delete process.env.INTEGRATIONS_ENV_MASTER_KEY;
    const { decryptWebhookSecret, encryptWebhookSecret } = await import('../app/lib/composio/composio-webhook-secret');
    await replaceScopedEnvEntries('integrations', [{ key: 'KEEP_DURING_WEBHOOK_KEY_SETUP', value: 'fixture' }]);
    const encryptedWebhookSecrets = await Promise.all(Array.from({ length: 12 }, () => encryptWebhookSecret('webhook-fixture')));
    assert.ok(encryptedWebhookSecrets.every((value) => value.startsWith('canvas:env:v1:')));
    assert.deepEqual(await Promise.all(encryptedWebhookSecrets.map(decryptWebhookSecret)), Array(12).fill('webhook-fixture'));
    const systemState = await readScopedEnvState('integrations');
    assert.equal(systemState.entries.find((entry) => entry.key === 'KEEP_DURING_WEBHOOK_KEY_SETUP')?.value, 'fixture');
    assert.ok(systemState.entries.some((entry) => entry.key === 'COMPOSIO_WEBHOOK_SECRET_ENCRYPTION_KEY'));

    console.log('secret-manual-consumers-test: ok');
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
