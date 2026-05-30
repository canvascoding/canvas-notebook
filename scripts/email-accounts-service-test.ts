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
  if (request === 'server-only') {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

let tmpRoot = '';
let secretsDir = '';
let integrationsEnvPath = '';
let accountsPath = '';

async function writeLocalAccounts(accounts: unknown[]) {
  await fs.mkdir(path.dirname(accountsPath), { recursive: true });
  await fs.writeFile(accountsPath, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, 'utf8');
}

async function readStoredLocalAccounts() {
  const raw = JSON.parse(await fs.readFile(accountsPath, 'utf8')) as { accounts?: unknown[] };
  return Array.isArray(raw.accounts) ? raw.accounts : [];
}

function localAccount(status: 'active' | 'expired' | 'revoked' = 'active') {
  const now = new Date().toISOString();
  return {
    id: 'local_google_test',
    provider: 'google',
    providerAccountId: 'google-user-1',
    emailAddress: 'owner@example.test',
    displayName: 'Owner Example',
    tokenType: 'Bearer',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scope: 'email profile',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    policy: { readFrom: [], sendTo: [] },
    status,
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-email-accounts-'));
  secretsDir = path.join(tmpRoot, 'secrets');
  integrationsEnvPath = path.join(secretsDir, 'Canvas-Integrations.env');
  accountsPath = path.join(secretsDir, 'email-oauth', 'accounts.json');

  process.env.CANVAS_DATA_ROOT = tmpRoot;
  process.env.INTEGRATIONS_ENV_PATH = integrationsEnvPath;
  await fs.mkdir(secretsDir, { recursive: true });

  const originalFetch = globalThis.fetch;
  const { disconnectEmailAccount, listEmailAccounts, startEmailOAuth } = await import('../app/lib/email/service');

  delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
  delete process.env.CANVAS_CONTROL_PLANE_URL;
  delete process.env.CANVAS_INSTANCE_TOKEN;
  await fs.writeFile(integrationsEnvPath, '', 'utf8');
  await writeLocalAccounts([localAccount()]);

  const localBefore = await listEmailAccounts();
  assert.equal(localBefore.mode, 'local');
  assert.equal(localBefore.accounts.length, 1);

  await disconnectEmailAccount('local_google_test');

  const localAfter = await listEmailAccounts();
  assert.equal(localAfter.mode, 'local');
  assert.equal(localAfter.accounts.length, 0);
  assert.equal((await readStoredLocalAccounts()).length, 0);

  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
  process.env.CANVAS_CONTROL_PLANE_URL = 'https://control.example/agent';
  process.env.CANVAS_INSTANCE_TOKEN = 'managed-token';

  const managedRequests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    managedRequests.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer managed-token');
    return new Response(JSON.stringify({
      accounts: [
        { id: 'managed-active', provider: 'google', emailAddress: 'active@example.test', status: 'active', policy: { readFrom: [], sendTo: [] } },
        { id: 'managed-revoked', provider: 'google', emailAddress: 'revoked@example.test', status: 'revoked', policy: { readFrom: [], sendTo: [] } },
        { id: 'managed-expired', provider: 'google', emailAddress: 'expired@example.test', status: 'expired', policy: { readFrom: [], sendTo: [] } },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const managedList = await listEmailAccounts();
  assert.equal(managedList.mode, 'managed');
  assert.deepEqual(
    managedList.accounts.map((account) => (account as { id: string }).id),
    ['managed-active'],
  );
  assert.deepEqual(managedRequests, ['https://control.example/v1/managed/email/accounts']);

  await fs.writeFile(integrationsEnvPath, 'GOOGLE_OAUTH_CLIENT_ID=local-client\nGOOGLE_OAUTH_CLIENT_SECRET=local-secret\n', 'utf8');
  managedRequests.length = 0;
  globalThis.fetch = (async () => {
    throw new Error('Managed email API should not be called while local OAuth credentials are configured.');
  }) as typeof fetch;

  const localPriorityList = await listEmailAccounts();
  assert.equal(localPriorityList.mode, 'local');
  assert.equal(localPriorityList.accounts.length, 0);
  assert.equal(managedRequests.length, 0);

  const oauthStart = await startEmailOAuth({ provider: 'google', requestOrigin: 'http://localhost:3000' });
  assert.equal(oauthStart.provider, 'google');
  assert.match(oauthStart.authorizationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/u);

  globalThis.fetch = originalFetch;
  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('Email accounts service test passed.');
}

main().catch(async (error) => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
