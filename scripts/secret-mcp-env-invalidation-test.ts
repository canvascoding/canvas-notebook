import assert from 'node:assert/strict';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';

type CacheEntry = {
  key: string;
  scope: { userId?: string | null; organizationId?: string | null; legacy?: boolean } | null;
  serverName: string;
  config: Record<string, unknown> & { organizationId?: string | null };
  transport: 'stdio';
  abortController: AbortController;
  client: { close: () => Promise<void> };
  activeCalls: number;
  lastUsedAt: number;
};

type ManagerStore = {
  entries: Map<string, CacheEntry>;
  cleanupStarted: boolean;
  shutdownHooksStarted: boolean;
  shuttingDown: boolean;
};

const globalCache = globalThis as typeof globalThis & { __canvasMcpManagerStore?: ManagerStore };
const closed: string[] = [];

function entry(
  key: string,
  scope: CacheEntry['scope'],
  config: CacheEntry['config'],
): CacheEntry {
  return {
    key,
    scope,
    serverName: key,
    config,
    transport: 'stdio',
    abortController: new AbortController(),
    client: { close: async () => { closed.push(key); } },
    activeCalls: 0,
    lastUsedAt: Date.now(),
  };
}

function resetCache(entries: CacheEntry[]) {
  const store = globalCache.__canvasMcpManagerStore!;
  store.entries.clear();
  for (const cachedEntry of entries) store.entries.set(cachedEntry.key, cachedEntry);
  closed.length = 0;
}

async function main() {
  const previousNextPhase = process.env.NEXT_PHASE;
  process.env.NEXT_PHASE = 'phase-production-build';
  const accessMocks = installMcpAccessMocks();
  globalCache.__canvasMcpManagerStore = {
    entries: new Map(), cleanupStarted: true, shutdownHooksStarted: true, shuttingDown: false,
  };

  try {
    const { closeMcpServersForScope } = await import('../app/lib/mcp/manager');
    const { MCP_SYSTEM_SCOPE } = await import('../app/lib/mcp/scope');
    const userA = { userId: 'env-user-a' };
    const userB = { userId: 'env-user-b' };
    const changed = 'CHANGED_ENV_FIXTURE';
    resetCache([
      entry('passthrough', userA, { envPassthrough: [changed] }),
      entry('env-reference', userA, { env: { API_TOKEN: '${' + changed + '}' } }),
      entry('header-reference', userA, { headers: { Authorization: 'Bearer ${' + changed + '}' } }),
      entry('headers-from-env', userA, { headersFromEnv: { Authorization: changed } }),
      entry('bearer-token-env', userA, { bearerTokenEnv: changed }),
      entry('unrelated-user-a', userA, { envPassthrough: ['SOME_OTHER_ENV'] }),
      entry('affected-user-b', userB, { envPassthrough: [changed] }),
      entry('affected-system', MCP_SYSTEM_SCOPE, { envPassthrough: [changed] }),
    ]);
    await closeMcpServersForScope(userA, [changed]);
    assert.deepEqual(new Set(closed), new Set([
      'passthrough', 'env-reference', 'header-reference', 'headers-from-env', 'bearer-token-env',
    ]), 'changed keys invalidate every affected credential or environment reference in this user scope only');
    assert.deepEqual(new Set(globalCache.__canvasMcpManagerStore.entries.keys()), new Set([
      'unrelated-user-a', 'affected-user-b', 'affected-system',
    ]));

    resetCache([
      entry('unrelated-change', userA, { envPassthrough: ['PROFILE_KEY_FIXTURE'] }),
      entry('different-user', userB, { envPassthrough: ['PROFILE_KEY_FIXTURE'] }),
    ]);
    await closeMcpServersForScope(userA, ['ANOTHER_ENV_FIXTURE']);
    assert.deepEqual(closed, [], 'unreferenced changed keys leave cached clients open');
    assert.equal(globalCache.__canvasMcpManagerStore.entries.size, 2);

    resetCache([
      entry('profile-backed', userA, { envPassthrough: ['PROFILE_KEY_FIXTURE'] }),
      entry('other-profile', userA, { env: { TOKEN: '${OTHER_PROFILE_FIXTURE}' } }),
      entry('same-profile-user-b', userB, { envPassthrough: ['PROFILE_KEY_FIXTURE'] }),
    ]);
    await closeMcpServersForScope(userA, ['PROFILE_KEY_FIXTURE']);
    assert.deepEqual(closed, ['profile-backed'], 'a changed logical profile key invalidates its dependent connection');
    assert.deepEqual(new Set(globalCache.__canvasMcpManagerStore.entries.keys()), new Set(['other-profile', 'same-profile-user-b']));

    resetCache([
      entry('default-close-user-a-one', userA, { envPassthrough: ['FIRST_ENV'] }),
      entry('default-close-user-a-two', userA, { envPassthrough: ['SECOND_ENV'] }),
      entry('default-close-user-b', userB, { envPassthrough: ['FIRST_ENV'] }),
    ]);
    await closeMcpServersForScope(userA);
    assert.deepEqual(new Set(closed), new Set(['default-close-user-a-one', 'default-close-user-a-two']), 'omitting changedEnvKeys preserves the old close-all-for-scope behavior');
    assert.deepEqual(new Set(globalCache.__canvasMcpManagerStore.entries.keys()), new Set(['default-close-user-b']));

    console.log('secret-mcp-env-invalidation-test: ok');
  } finally {
    globalCache.__canvasMcpManagerStore?.entries.clear();
    delete globalCache.__canvasMcpManagerStore;
    accessMocks.restore();
    if (previousNextPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = previousNextPhase;
  }
}

main().catch(error => { console.error(error); process.exit(1); });
