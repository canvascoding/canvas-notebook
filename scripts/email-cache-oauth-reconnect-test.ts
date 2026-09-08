import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import type { EmailCacheStore } from '../app/lib/email/cache/store';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;

moduleInternals._load = function loadWithEmailMocks(request, parent, isMain) {
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
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-email-cache-oauth-'));
  const integrationsPath = path.join(dataRoot, 'secrets', 'Canvas-Integrations.env');
  const originalFetch = global.fetch;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.INTEGRATIONS_ENV_PATH = integrationsPath;
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
    const { upsertOAuthEmailAccount } = await import('../app/lib/email/account-store');
    const { completeLocalEmailOAuth } = await import('../app/lib/email/local-service');
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

    setEmailCacheConsistencyStoreFactoryForTests(null);
    console.log('email-cache-oauth-reconnect-test: ok');
  } finally {
    global.fetch = originalFetch;
    moduleInternals._load = originalLoad;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  moduleInternals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
