import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const environmentKeys = [
  'BOOTSTRAP_ADMIN_EMAIL',
  'CANVAS_DATABASE_PROVIDER',
  'CANVAS_INSTANCE_ID',
  'CANVAS_INSTANCE_TOKEN',
  'CANVAS_LICENSE_CERT',
  'CANVAS_LICENSE_CONTROL_PLANE_URL',
  'CANVAS_LICENSE_PUBLIC_KEY',
  'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
  'CANVAS_MANAGED_SERVICES_ENABLED',
  'DATA',
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

type RouteSession = {
  user: { id: string; email: string; name: string; image: null; role: string };
  session: { id: string };
};

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function publicKeyFingerprint(publicKeyPem: string) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function signLicense(privateKey: crypto.KeyObject, instanceId: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: instanceId,
    iss: 'canvas-control-plane',
    aud: 'canvas-notebook',
    plan: 'community',
    status: 'active',
    deploymentMode: 'community',
    features: {},
    quotas: {},
    iat: now,
    exp: now + 3600,
  }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

async function main() {
  const proxyModule = await import('../proxy');
  const defaultExport = proxyModule.default as unknown;
  const middleware = typeof defaultExport === 'function'
    ? defaultExport
    : (defaultExport as { default: (request: NextRequest) => Promise<Response> }).default;
  const licenseStatusResponse = await middleware(new NextRequest(
    'http://localhost/api/mobile/v1/license/status',
    { headers: { cookie: 'better-auth.session_token=middleware-test' } },
  ));
  assert.equal(licenseStatusResponse.status, 200);
  assert.equal(licenseStatusResponse.headers.get('x-middleware-next'), '1');
  const preferencesResponse = await middleware(new NextRequest(
    'http://localhost/api/mobile/v1/account/preferences',
    { headers: { cookie: 'better-auth.session_token=middleware-test' } },
  ));
  assert.equal(preferencesResponse.status, 200);
  assert.equal(preferencesResponse.headers.get('x-middleware-next'), '1');

  let middlewareFetchCalls = 0;
  globalThis.fetch = async () => {
    middlewareFetchCalls += 1;
    throw new Error('Core middleware must not fetch license status');
  };
  const bootstrapResponse = await middleware(new NextRequest(
    'http://localhost:3456/api/mobile/v1/bootstrap',
    { headers: { cookie: 'better-auth.session_token=middleware-test' } },
  ));
  assert.equal(bootstrapResponse.status, 200);
  assert.equal(bootstrapResponse.headers.get('x-middleware-next'), '1');
  assert.equal(middlewareFetchCalls, 0);

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-license-'));
  const dataRoot = path.join(temporaryRoot, 'data');
  const instanceId = 'mobile-license-private-instance';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_INSTANCE_ID = instanceId;
  process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://api.canvasnotebook.app';
  process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
  process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = publicKeyFingerprint(publicKeyPem);
  delete process.env.CANVAS_INSTANCE_TOKEN;
  delete process.env.CANVAS_LICENSE_CERT;
  delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
  await fs.mkdir(dataRoot, { recursive: true });

  const { runMigrations } = await import('../app/lib/db/migrate');
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    runMigrations(sqlite);
  } finally {
    sqlite.close();
  }

  const { auth } = await import('../app/lib/auth');
  let currentSession: RouteSession | null = null;
  assert.equal(Reflect.set(auth.api, 'getSession', async () => currentSession), true);
  const statusRoute = await import('../app/api/mobile/v1/license/status/route');
  const registerRoute = await import('../app/api/mobile/v1/license/register/route');
  const activateRoute = await import('../app/api/mobile/v1/license/activate/route');

  const unauthorized = await statusRoute.GET(new Request('https://notebook.example/api/mobile/v1/license/status'));
  assert.equal(unauthorized.status, 401);

  currentSession = {
    user: { id: 'member-user', email: 'member@example.test', name: 'Member', image: null, role: 'user' },
    session: { id: 'member-session' },
  };
  const memberStatusResponse = await statusRoute.GET(new Request('https://notebook.example/api/mobile/v1/license/status'));
  const memberStatus = await memberStatusResponse.json() as Record<string, unknown>;
  assert.equal(memberStatusResponse.status, 200);
  assert.equal(memberStatus.licensed, false);
  assert.equal(memberStatus.code, 'LICENSE_OPTIONAL');
  assert.equal(memberStatus.licenseState, 'inactive');
  assert.equal(memberStatus.hostingMode, null);
  assert.deepEqual(memberStatus.capabilities, {});
  assert.deepEqual(memberStatus.features, {});
  assert.equal((memberStatus.activation as Record<string, unknown>).canManage, false);
  assert.equal(JSON.stringify(memberStatus).includes(instanceId), false);

  const forbiddenRegistration = await registerRoute.POST(new Request(
    'https://notebook.example/api/mobile/v1/license/register',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
  ) as never);
  assert.equal(forbiddenRegistration.status, 403);

  currentSession = {
    user: { id: 'admin-user', email: 'admin@example.test', name: 'Admin', image: null, role: 'admin' },
    session: { id: 'admin-session' },
  };
  let registrationBody: Record<string, unknown> | null = null;
  const emailActivationPollToken = `lep_${'b'.repeat(64)}`;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.canvasnotebook.app/v1/license/register');
    registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      ok: true,
      status: 'issued',
      expiresAt: '2027-07-23T00:00:00.000Z',
      activation: {
        id: '88a79dcb-b35a-4c33-b82a-6e11f7a5f9aa',
        pollToken: emailActivationPollToken,
        expiresAt: '2027-07-23T00:00:00.000Z',
        pollIntervalSeconds: 5,
      },
    });
  };
  const registrationResponse = await registerRoute.POST(new Request(
    'https://internal.invalid/api/mobile/v1/license/register',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-host': 'notebook.example',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ email: 'ADMIN@EXAMPLE.TEST', marketingOptIn: true }),
    },
  ) as never);
  assert.equal(registrationResponse.status, 202);
  const registrationPayload = await registrationResponse.json() as Record<string, unknown>;
  assert.equal(JSON.stringify(registrationPayload).includes(emailActivationPollToken), false);
  assert.equal((registrationPayload.activation as Record<string, unknown>).state, 'authorization_pending');
  assert.deepEqual(registrationBody, {
    email: 'admin@example.test',
    instanceId,
    activationUrl: 'https://notebook.example/settings?tab=license&source=mobile',
    marketingOptIn: true,
  });
  const { loadPendingLicenseEmailActivation } = await import('../app/lib/license/email-activation-storage');
  assert.equal((await loadPendingLicenseEmailActivation())?.pollToken, emailActivationPollToken);

  const certificate = signLicense(privateKey, instanceId);
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.canvasnotebook.app/v1/license/activate');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.instanceId, instanceId);
    assert.equal(body.key, 'lic_0123456789abcdef0123456789abcdef');
    return Response.json({ license: certificate });
  };
  const activationResponse = await activateRoute.POST(new Request(
    'https://notebook.example/api/mobile/v1/license/activate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'lic_0123456789abcdef0123456789abcdef' }),
    },
  ) as never);
  const activated = await activationResponse.json() as Record<string, unknown>;
  assert.equal(activationResponse.status, 200);
  assert.equal(activated.licensed, true);
  assert.equal(activated.plan, 'community');
  assert.equal(activated.code, 'LICENSE_ACTIVE');
  assert.equal(activated.licenseState, 'active');
  assert.equal(activated.hostingMode, 'community');
  assert.equal(activated.edition, 'solo');
  assert.equal(activated.seatLimit, 1);
  assert.match(String(activated.instanceId), /^cni_[a-f0-9]{24}$/u);
  assert.equal(JSON.stringify(activated).includes(instanceId), false);

  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

main()
  .then(() => console.log('mobile-license-test: ok'))
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
