import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

let preferredOpenRouterAuth: string | undefined = 'api-key';
let oauthResult: { apiKey?: string } | null = null;
let oauthError: Error | null = null;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === '@/app/lib/agents/storage') {
    return {
      readPiRuntimeConfig: async () => ({
        providers: { openrouter: { authMethod: preferredOpenRouterAuth } },
      }),
    };
  }
  // Only this exported constant is used by the credential resolver. Avoid
  // loading the model catalog and its SDK dependencies in this focused test.
  if (request === './model-resolver' && parent?.filename?.endsWith('/app/lib/pi/api-key-resolver.ts')) {
    return { CANVAS_CONTROL_PLANE_PROVIDER_ID: 'canvas-control-plane' };
  }
  if (request === './oauth' && parent?.filename?.endsWith('/app/lib/pi/api-key-resolver.ts')) {
    return {
      getProviderApiKey: async () => {
        if (oauthError) throw oauthError;
        return oauthResult;
      },
      isOAuthProvider: (provider: string) => provider === 'openrouter',
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-unified-secrets-'));
  const names = [
    'CANVAS_DATA_ROOT', 'DATA', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH',
    'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY', 'OLLAMA_API_KEY', 'CANVAS_INSTANCE_TOKEN',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    for (const name of names.slice(1)) delete process.env[name];
    process.env.CANVAS_SECRETS_MASTER_KEY = 'pi-secrets-test-master';

    const { readScopedEnvState, replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const { resolvePiApiKey } = await import('../app/lib/pi/api-key-resolver');

    await replaceScopedEnvEntries('integrations', [
      { key: 'OPENAI_API_KEY', value: 'system-integration-openai' },
      { key: 'OPENROUTER_API_KEY', value: 'system-openrouter-key' },
      { key: 'OLLAMA_API_KEY', value: 'system-ollama-key' },
    ]);
    await replaceScopedEnvEntries('agents', [
      { key: 'OPENAI_API_KEY', value: 'system-agent-openai' },
      { key: 'OPENROUTER_API_KEY', value: 'system-agent-openrouter' },
    ]);
    await replaceScopedEnvEntries('integrations', [
      { key: 'OPENAI_API_KEY', value: 'alice-integration-openai' },
      { key: 'OPENROUTER_API_KEY', value: 'alice-openrouter-key' },
    ], { userId: 'alice' });
    await replaceScopedEnvEntries('agents', [{ key: 'OPENAI_API_KEY', value: 'alice-agent-openai' }], { userId: 'alice' });
    await replaceScopedEnvEntries('integrations', [{ key: 'OPENAI_API_KEY', value: 'bob-integration-openai' }], { userId: 'bob' });

    process.env.OPENAI_API_KEY = 'process-openai-decoy';
    process.env.OPENROUTER_API_KEY = 'process-openrouter-decoy';
    process.env.OLLAMA_API_KEY = 'process-ollama-decoy';
    assert.equal(await resolvePiApiKey('openai', { userId: 'alice' }), 'alice-agent-openai');
    assert.equal(await resolvePiApiKey('openai', { userId: 'bob' }), 'bob-integration-openai');
    assert.equal(await resolvePiApiKey('openai', { userId: 'no-credentials' }), undefined);

    assert.equal(await resolvePiApiKey('openai'), 'process-openai-decoy');
    delete process.env.OPENAI_API_KEY;
    assert.equal(await resolvePiApiKey('openai'), 'system-agent-openai');
    await replaceScopedEnvEntries('agents', []);
    assert.equal(await resolvePiApiKey('openai'), 'system-integration-openai');

    preferredOpenRouterAuth = 'oauth';
    oauthError = new Error('oauth fixture failure');
    await assert.rejects(() => resolvePiApiKey('openrouter', { userId: 'alice' }), /oauth fixture failure/u);
    oauthError = null;
    oauthResult = null;
    assert.equal(await resolvePiApiKey('openrouter', { userId: 'alice' }), undefined);

    const aliceOllama = await resolvePiApiKey('ollama', { userId: 'ollama-alice' });
    const bobOllama = await resolvePiApiKey('ollama', { userId: 'ollama-bob' });
    assert.match(aliceOllama || '', /^\d{24}$/u);
    assert.match(bobOllama || '', /^\d{24}$/u);
    assert.notEqual(aliceOllama, bobOllama);
    const aliceState = await readScopedEnvState('agents', { userId: 'ollama-alice' });
    const bobState = await readScopedEnvState('agents', { userId: 'ollama-bob' });
    const systemState = await readScopedEnvState('agents');
    assert.equal(aliceState.entries.find((entry) => entry.key === 'OLLAMA_API_KEY')?.value, aliceOllama);
    assert.equal(bobState.entries.find((entry) => entry.key === 'OLLAMA_API_KEY')?.value, bobOllama);
    assert.equal(systemState.entries.some((entry) => entry.key === 'OLLAMA_API_KEY'), false);

    console.log('pi-unified-secrets-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
