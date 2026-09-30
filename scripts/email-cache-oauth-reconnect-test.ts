import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import type { EmailCacheStore } from '../app/lib/email/cache/store';
import { createPiTestDatabase } from './helpers/pi-test-database';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
let database: Awaited<ReturnType<typeof createPiTestDatabase>>;

moduleInternals._load = function loadWithEmailMocks(request, parent, isMain) {
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || request === '../app/lib/db') return database;
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return {
      completeSimple: async () => { throw new Error('Unexpected AI call.'); },
      getModels: () => [],
      getProviders: () => [],
      isContextOverflow: () => false,
      registerBuiltInApiProviders: () => undefined,
      streamSimple: async function* () { throw new Error('Unexpected AI call.'); },
    };
  }
  if (request === '@earendil-works/pi-ai/oauth') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  database = await createPiTestDatabase();
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-email-cache-oauth-'));
  const integrationsPath = path.join(dataRoot, 'secrets', 'Canvas-Integrations.env');
  const originalFetch = global.fetch;
  const originalSecretsMasterKey = process.env.CANVAS_SECRETS_MASTER_KEY;
  const originalIntegrationsMasterKey = process.env.INTEGRATIONS_ENV_MASTER_KEY;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.INTEGRATIONS_ENV_PATH = integrationsPath;
  process.env.CANVAS_SECRETS_MASTER_KEY = 'email-cache-oauth-test-store-key';
  delete process.env.INTEGRATIONS_ENV_MASTER_KEY;
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'https://canvas.example.test';
  await fs.mkdir(path.dirname(integrationsPath), { recursive: true });
  await fs.writeFile(
    integrationsPath,
    'GOOGLE_OAUTH_CLIENT_ID=client-id\nGOOGLE_OAUTH_CLIENT_SECRET=client-secret\n',
    'utf8',
  );

  try {
    const cacheCalls: Array<{ operation: string; accountId: string; accountSource?: string }> = [];
    const cacheStore = {
      enabled: true,
      async purgeAccount(input: { accountId: string; accountSource?: string }) {
        cacheCalls.push({ operation: 'purge', accountId: input.accountId, accountSource: input.accountSource });
        return { enabled: true, tombstoned: true, generation: 2, deletedLists: 0, deletedMessages: 0 };
      },
      async reactivateAccount(input: { accountId: string; accountSource?: string }) {
        cacheCalls.push({ operation: 'reactivate', accountId: input.accountId, accountSource: input.accountSource });
        return 3;
      },
    } as unknown as EmailCacheStore;
    const { setEmailCacheConsistencyStoreFactoryForTests } = await import('../app/lib/email/cache/consistency');
    setEmailCacheConsistencyStoreFactoryForTests(async () => cacheStore);

    const { db } = await import('../app/lib/db');
    const { user } = await import('../app/lib/db/schema');
    const { readStoredEmailAccountSecret, upsertOAuthEmailAccount } = await import('../app/lib/email/account-store');
    const { completeLocalEmailOAuth, listLocalEmailFolders } = await import('../app/lib/email/local-service');
    const { writeEmailAccountSecret } = await import('../app/lib/email/secret-store');
    const { disconnectEmailAccount, startEmailOAuth } = await import('../app/lib/email/service');
    const now = new Date();
    await db.insert(user).values({
      id: 'user-1',
      name: 'User One',
      email: 'owner@example.test',
      emailVerified: true,
      image: null,
      role: null,
      createdAt: now,
      updatedAt: now,
    });
    const initialAccount = await upsertOAuthEmailAccount({
      userId: 'user-1',
      provider: 'google',
      providerAccountId: 'google-user-1',
      emailAddress: 'owner@example.test',
      secret: {
        authType: 'oauth',
        tokenType: 'Bearer',
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        scope: 'email profile',
      },
    });

    await disconnectEmailAccount('user-1', initialAccount.id);
    assert.deepEqual(cacheCalls, [
      { operation: 'purge', accountId: initialAccount.id, accountSource: 'local' },
    ]);

    const oauthStart = await startEmailOAuth('user-1', {
      provider: 'google',
      requestOrigin: 'https://canvas.example.test',
    });
    const state = new URL(oauthStart.authorizationUrl).searchParams.get('state');
    assert.ok(state);

    global.fetch = async (input) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          token_type: 'Bearer',
          scope: 'email profile',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-user-1',
          email: 'owner@example.test',
          name: 'Owner',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const completed = await completeLocalEmailOAuth('user-1', 'authorization-code', state);
    assert.equal(completed.account.id, initialAccount.id);
    assert.deepEqual(cacheCalls, [
      { operation: 'purge', accountId: initialAccount.id, accountSource: 'local' },
      { operation: 'reactivate', accountId: initialAccount.id, accountSource: 'local' },
    ]);

    await writeEmailAccountSecret(initialAccount.secretRef, {
      authType: 'oauth', tokenType: 'Bearer', accessToken: 'expired-access-fixture',
      refreshToken: 'single-use-refresh-fixture', scope: 'email profile',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let refreshExchangeCalls = 0;
    let gmailFolderCalls = 0;
    global.fetch = async (input) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        refreshExchangeCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Response(JSON.stringify({
          access_token: 'rotated-access-fixture',
          refresh_token: 'rotated-refresh-fixture',
          token_type: 'Bearer',
          scope: 'email profile',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/labels') {
        gmailFolderCalls += 1;
        return new Response(JSON.stringify({ labels: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected refresh test request: ${url}`);
    };
    const refreshedFolders = await Promise.all([
      listLocalEmailFolders('user-1', initialAccount.id),
      listLocalEmailFolders('user-1', initialAccount.id),
    ]);
    assert.equal(refreshedFolders.length, 2);
    assert.equal(refreshExchangeCalls, 1);
    assert.equal(gmailFolderCalls, 2);
    const refreshedSecret = await readStoredEmailAccountSecret(initialAccount);
    assert.equal(refreshedSecret.authType, 'oauth');
    if (refreshedSecret.authType === 'oauth') {
      assert.equal(refreshedSecret.accessToken, 'rotated-access-fixture');
      assert.equal(refreshedSecret.refreshToken, 'rotated-refresh-fixture');
    }

    setEmailCacheConsistencyStoreFactoryForTests(null);
    console.log('email-cache-oauth-reconnect-test: ok');
  } finally {
    global.fetch = originalFetch;
    if (originalSecretsMasterKey === undefined) delete process.env.CANVAS_SECRETS_MASTER_KEY;
    else process.env.CANVAS_SECRETS_MASTER_KEY = originalSecretsMasterKey;
    if (originalIntegrationsMasterKey === undefined) delete process.env.INTEGRATIONS_ENV_MASTER_KEY;
    else process.env.INTEGRATIONS_ENV_MASTER_KEY = originalIntegrationsMasterKey;
    moduleInternals._load = originalLoad;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  moduleInternals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await database?.close();
});
