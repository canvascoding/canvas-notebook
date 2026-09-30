import assert from 'node:assert/strict';
import Module from 'node:module';

const moduleInternals = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
const originalLoad = moduleInternals._load;
const runStatements: string[] = [];
const persistedConfig = JSON.stringify({
  authMethod: 'api-key',
  ollamaMode: 'cloud',
  ollamaHost: 'https://ollama.example.test/v1/',
  ollamaCustomModel: ' model-one ',
  ollamaAdditionalModels: ['model-one', 'model-two', 'model-one'],
  openaiCompatibleBaseUrl: 'https://compatible.example.test/v1',
  openaiCompatibleModelSource: 'custom',
  openaiCompatibleCustomModel: 'compatible-model',
  apiKey: 'fixture-provider-key',
  authorization: 'fixture-authorization',
  unknownSetting: 'fixture-unknown-value',
  privateEndpoint: 'https://user:fixture-password@private.example.test/v1',
});

moduleInternals._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') {
    return {
      openDb: async () => ({
        run: async (sql: string) => { runStatements.push(sql); },
        get: async () => undefined,
        all: async (sql: string) => sql.includes('ai_provider_installations') ? [{
          id: `aip_${'a'.repeat(24)}`,
          provider_id: 'fixture-provider',
          display_name: 'Fixture provider',
          source: 'self-hosted',
          credential_scope: 'organization',
          enabled: true,
          status: 'unverified',
          config_json: persistedConfig,
          source_revision: null,
          last_synced_at: null,
          revision: 1,
          verified_at: null,
          verified_by_user_id: null,
        }] : [],
        close: async () => undefined,
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    const { readAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-store');
    const catalog = await readAppRuntimeCatalog('org-config-test');
    const config = catalog.providers[0]?.config;

    assert.deepEqual(config, {
      authMethod: 'api-key',
      ollamaMode: 'cloud',
      ollamaHost: 'https://ollama.example.test/v1',
      ollamaCustomModel: 'model-one',
      ollamaAdditionalModels: ['model-one', 'model-two'],
      openaiCompatibleBaseUrl: 'https://compatible.example.test/v1',
      openaiCompatibleModelSource: 'custom',
      openaiCompatibleCustomModel: 'compatible-model',
    });
    const serialized = JSON.stringify(catalog);
    for (const fixtureSecret of ['fixture-provider-key', 'fixture-authorization', 'fixture-password', 'fixture-unknown-value']) {
      assert.equal(serialized.includes(fixtureSecret), false, `unsafe persisted field ${fixtureSecret} must not reach callers`);
    }
    assert.deepEqual(runStatements.map((statement) => statement.trim().split(/\s+/u)[0]), ['BEGIN', 'COMMIT']);
    console.log('agent-runtime-provider-config-read-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
