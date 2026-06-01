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
    const { formatWebSearchResults, getBraveSearchStatus, searchWeb } = await import('../app/lib/integrations/brave-search-service');

    const disabledStatus = await getBraveSearchStatus();
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

    const status = await getBraveSearchStatus();
    assert.equal(status.mode, 'local');
    assert.equal(status.localConfigured, true);

    const result = await searchWeb({ query: 'canvas', count: 2, country: 'de' });
    assert.equal(sawSubscriptionToken, true);
    assert.equal(result.mode, 'local');
    assert.equal(result.country, 'DE');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, 'https://example.com/docs');
    assert.doesNotMatch(formatWebSearchResults(result), /test-local-key/);

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
