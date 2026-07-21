import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const keys = ['CANVAS_DEPLOYMENT_MODE', 'CANVAS_INSTANCE_ID', 'CANVAS_INSTANCE_NAME'] as const;
const original = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));

async function main() {
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-single';
  process.env.CANVAS_INSTANCE_ID = 'route-test-private-id';
  process.env.CANVAS_INSTANCE_NAME = 'Route Test Notebook';

  const { GET } = await import('../app/api/mobile/v1/compatibility/route');
  const response = await GET();
  const payload = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(payload.product, 'canvas-notebook');
  assert.equal(JSON.stringify(payload).includes('route-test-private-id'), false);
  assert.deepEqual(payload.auth, {
    provider: 'better-auth',
    basePath: '/api/auth',
    methods: ['email-password'],
    cookiePrefix: 'better-auth',
    expoPlugin: true,
  });

  const proxySource = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8');
  assert.match(
    proxySource,
    /PUBLIC_EXACT_ROUTES\s*=\s*\[[\s\S]*['"]\/api\/mobile\/v1\/compatibility['"][\s\S]*\]/u,
    'The pre-authentication compatibility handshake must remain public in proxy.ts',
  );
}

main()
  .then(() => console.log('mobile-compatibility-route-test: ok'))
  .finally(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
