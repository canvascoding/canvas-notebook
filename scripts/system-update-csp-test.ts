import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import middleware from '../proxy';
import {
  DEFAULT_MANAGED_CONTROL_PLANE_URL,
  getManagedSystemUpdateOrigin,
} from '../app/lib/managed/control-plane-url-policy';

const baseSources = ["'self'", 'ws:', 'wss:', 'https://o4511053822099456.ingest.de.sentry.io', 'https://api.github.com'];
const keys = ['CANVAS_MANAGED_SERVICES_ENABLED', 'CANVAS_INSTANCE_TOKEN', 'CANVAS_CONTROL_PLANE_URL',
  'NEXT_PUBLIC_CANVAS_CONTROL_PLANE_URL', 'CANVAS_UPDATE_ALLOW_LOCAL_HTTP'] as const;

async function main() {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const cases: Array<{ env: Record<string, string>; origin?: string }> = [
    { env: {} },
    { env: { CANVAS_CONTROL_PLANE_URL: 'https://services.example.com' } },
    { env: { CANVAS_MANAGED_SERVICES_ENABLED: 'true' }, origin: DEFAULT_MANAGED_CONTROL_PLANE_URL },
    { env: { CANVAS_INSTANCE_TOKEN: 'fixture-only' }, origin: DEFAULT_MANAGED_CONTROL_PLANE_URL },
    { env: { CANVAS_MANAGED_SERVICES_ENABLED: '1', CANVAS_CONTROL_PLANE_URL: 'https://control.example.com:8443' }, origin: 'https://control.example.com:8443' },
    { env: { CANVAS_INSTANCE_TOKEN: 'fixture-only', CANVAS_CONTROL_PLANE_URL: 'wss://control.example.com/agent' }, origin: 'https://control.example.com' },
    { env: { CANVAS_MANAGED_SERVICES_ENABLED: 'true', NEXT_PUBLIC_CANVAS_CONTROL_PLANE_URL: 'https://public.example.com' }, origin: 'https://public.example.com' },
    { env: { CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_CONTROL_PLANE_URL: 'https://private.example.com', NEXT_PUBLIC_CANVAS_CONTROL_PLANE_URL: 'https://public.example.com' }, origin: 'https://private.example.com' },
  ];
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'host.orb.internal', 'host.docker.internal']) {
    const url = `http://${hostname}:4001`;
    cases.push({ env: { CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_CONTROL_PLANE_URL: url } });
    cases.push({ env: { CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_CONTROL_PLANE_URL: url, CANVAS_UPDATE_ALLOW_LOCAL_HTTP: 'true' }, origin: url });
  }
  for (const url of ['http://example.com', 'https://*.example.com', 'https://example.com;script-src',
    'https://user:credential@example.com', 'https://example.com/path', 'https://example.com?token=private',
    'https://example.com#fragment', 'file:///tmp/control-plane', "https://example.com; connect-src *", 'not-a-url']) {
    cases.push({ env: { CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_CONTROL_PLANE_URL: url, CANVAS_UPDATE_ALLOW_LOCAL_HTTP: 'true' } });
    assert.throws(() => getManagedSystemUpdateOrigin({ NODE_ENV: 'test', CANVAS_CONTROL_PLANE_URL: url, CANVAS_UPDATE_ALLOW_LOCAL_HTTP: 'true' }));
  }
  try {
    for (const { env, origin } of cases) {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, env);
      for (const pathname of ['/en/login', '/api/health']) {
        const response = await middleware(new NextRequest(`http://localhost:3100${pathname}`, {
          headers: { 'x-forwarded-host': 'attacker.example.com' },
        }));
        const csp = response.headers.get('Content-Security-Policy');
        assert.ok(csp, 'Real proxy page/API responses must carry CSP');
        const sources = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src '))?.split(' ').slice(1);
        assert.deepEqual(sources, origin ? [...baseSources, origin] : baseSources);
        assert.ok(!csp.includes('fixture-only'), 'Instance token must not appear in a response header');
        assert.ok(!csp.includes('attacker.example.com'), 'Request headers must not expand connect-src');
      }
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  console.log(`system-update-csp-test: ${cases.length} configurations passed through page and API proxy responses`);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
