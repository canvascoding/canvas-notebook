import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-brave-search-'));
  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.INTEGRATIONS_ENV_PATH = path.join(dataDir, 'secrets', 'Canvas-Integrations.env');
  delete process.env.BRAVE_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.WEB_SEARCH_PROVIDER;
  delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
  delete process.env.CANVAS_CONTROL_PLANE_URL;
  delete process.env.CANVAS_INSTANCE_TOKEN;

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  const originalFetch = globalThis.fetch;
  try {
    const { formatWebSearchResults, getWebSearchStatus, searchWeb } = await import('../app/lib/integrations/brave-search-service');

    const disabledStatus = await getWebSearchStatus();
    assert.equal(disabledStatus.mode, 'disabled');

    const secretsDir = path.join(dataDir, 'secrets');
    await fs.mkdir(secretsDir, { recursive: true });
    await fs.writeFile(path.join(secretsDir, 'Canvas-Integrations.env'), 'BRAVE_API_KEY=test-local-key\n', 'utf8');

    let sawSubscriptionToken = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.match(url, /api\.search\.brave\.com\/res\/v1\/web\/search/);
      assert.match(url, /q=canvas/);
      const headers = new Headers(init?.headers);
      sawSubscriptionToken = headers.get('X-Subscription-Token') === 'test-local-key';
      return new Response(JSON.stringify({
        web: {
          results: [
            {
              title: 'Canvas Docs',
              url: 'https://example.com/docs',
              description: 'Documentation result',
              age: '1 day ago',
              profile: { name: 'Example' },
            },
          ],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const status = await getWebSearchStatus();
    assert.equal(status.mode, 'local');
    assert.equal(status.localConfigured, true);

    const result = await searchWeb({ query: 'canvas', count: 2, country: 'de' });
    assert.equal(sawSubscriptionToken, true);
    assert.equal(result.mode, 'local');
    assert.equal(result.country, 'DE');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, 'https://example.com/docs');
    assert.doesNotMatch(formatWebSearchResults(result), /test-local-key/);

    process.env.WEB_SEARCH_PROVIDER = 'ollama';
    await fs.writeFile(path.join(secretsDir, 'Canvas-Integrations.env'), 'OLLAMA_API_KEY=test-ollama-key\n', 'utf8');
    let sawOllamaAuthorization = false;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://ollama.com/api/web_search');
      assert.equal(init?.method, 'POST');
      const headers = new Headers(init?.headers);
      sawOllamaAuthorization = headers.get('Authorization') === 'Bearer test-ollama-key';
      assert.deepEqual(JSON.parse(String(init?.body)), { query: 'canvas', max_results: 10 });
      return new Response(JSON.stringify({
        results: [{ title: 'Ollama Docs', url: 'https://ollama.com/docs', content: 'Web search documentation' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const ollamaStatus = await getWebSearchStatus();
    assert.equal(ollamaStatus.provider, 'ollama');
    assert.equal(ollamaStatus.mode, 'local');
    const ollamaResult = await searchWeb({ query: 'canvas', count: 20 });
    assert.equal(sawOllamaAuthorization, true);
    assert.equal(ollamaResult.provider, 'ollama');
    assert.equal(ollamaResult.results[0].snippet, 'Web search documentation');
    assert.match(formatWebSearchResults(ollamaResult), /Ollama Web Search/);

    console.log('brave-search-service-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
