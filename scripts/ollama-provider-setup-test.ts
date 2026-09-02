import assert from 'node:assert/strict';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => (
  request === 'server-only' ? {} : originalLoad(request, parent, isMain)
);

async function main() {
  const {
    defaultOllamaServerUrl,
    normalizeOllamaServerUrl,
    ollamaOpenAiBaseUrl,
    ollamaTagsUrl,
    OllamaServerUrlError,
  } = await import('../app/lib/agent-runtime-policy/ollama-url');
  const {
    discoverOllamaModels,
    OllamaDiscoveryError,
  } = await import('../app/lib/agent-runtime-policy/ollama-discovery-service');

  assert.equal(defaultOllamaServerUrl(), 'http://localhost:11434');
  assert.equal(normalizeOllamaServerUrl(' http://ollama.example.test:11434/ '), 'http://ollama.example.test:11434');
  assert.equal(normalizeOllamaServerUrl('https://models.example.test/ollama/v1'), 'https://models.example.test/ollama');
  assert.equal(ollamaOpenAiBaseUrl('https://models.example.test/ollama/v1'), 'https://models.example.test/ollama/v1');
  assert.equal(ollamaTagsUrl('https://models.example.test/ollama/v1'), 'https://models.example.test/ollama/api/tags');
  assert.throws(
    () => normalizeOllamaServerUrl('https://user:secret@example.test'),
    (error) => error instanceof OllamaServerUrlError,
  );

  let requestedUrl = '';
  let authorization = '';
  const models = await discoverOllamaModels({
    serverUrl: 'https://models.example.test/ollama/v1',
    apiKey: 'test-key',
  }, {
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      return new Response(JSON.stringify({
        models: [
          { name: 'qwen3:14b', model: 'qwen3:14b', size: 9_000, digest: 'sha256:abc' },
          { name: 'llama3.3:70b', modified_at: '2026-09-01T10:00:00Z' },
          { name: 'invalid model id' },
          { name: 'qwen3:14b', model: 'qwen3:14b' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(requestedUrl, 'https://models.example.test/ollama/api/tags');
  assert.equal(authorization, 'Bearer test-key');
  assert.deepEqual(models.map((model) => model.id), ['llama3.3:70b', 'qwen3:14b']);

  await assert.rejects(
    () => discoverOllamaModels({ serverUrl: 'https://models.example.test' }, {
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    }),
    (error) => error instanceof OllamaDiscoveryError
      && error.code === 'OLLAMA_CONNECTION_REJECTED'
      && error.status === 401,
  );

  console.log('ollama provider setup tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
  });
