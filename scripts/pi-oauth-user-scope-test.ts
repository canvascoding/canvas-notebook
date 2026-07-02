import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type MockCredentials = {
  access: string;
  refresh?: string;
  expires?: number;
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-oauth-scope-'));
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousData = process.env.DATA;
  const previousOAuthStoragePath = process.env.OAUTH_STORAGE_PATH;

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;

  moduleInternals._load = (request, parent, isMain) => {
    if (request === '@earendil-works/pi-ai/oauth') {
      return {
        loginAnthropic: async () => ({ access: 'unused-anthropic' }),
        loginOpenAICodex: async () => ({ access: 'unused-codex' }),
        loginGitHubCopilot: async () => ({ access: 'unused-copilot' }),
        refreshOAuthToken: async (_provider: string, credentials: MockCredentials) => credentials,
        getOAuthApiKey: async (provider: string, auth: Record<string, MockCredentials>) => {
          const credentials = auth[provider];
          return credentials?.access ? { apiKey: credentials.access } : null;
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    delete process.env.DATA;
    delete process.env.OAUTH_STORAGE_PATH;

    const oauth = await import('../app/lib/pi/oauth');
    const { resolveScopedPiOAuthStatesDir } = await import('../app/lib/runtime-data-paths');
    const provider = 'openai-codex';
    const userA = { userId: 'oauth_user_a' };
    const userB = { userId: 'oauth_user_b' };
    const userC = { userId: 'oauth_user_c' };
    const expires = Date.now() + 60 * 60 * 1000;

    oauth.saveProviderCredentials(provider, { access: 'user-a-token', refresh: 'refresh-a', expires }, userA);
    oauth.saveProviderCredentials(provider, { access: 'user-b-token', refresh: 'refresh-b', expires }, userB);

    assert.equal(oauth.getProviderCredentials(provider, userA)?.access, 'user-a-token');
    assert.equal(oauth.getProviderCredentials(provider, userB)?.access, 'user-b-token');
    assert.equal(oauth.getProviderCredentials(provider, userC), null);
    assert.equal(oauth.hasProviderCredentials(provider, userA), true);
    assert.equal(oauth.hasProviderCredentials(provider, userC), false);

    const userAStatus = oauth.getAllProviderStatus(userA).find((entry) => entry.provider === provider);
    const userCStatus = oauth.getAllProviderStatus(userC).find((entry) => entry.provider === provider);
    assert.equal(userAStatus?.connected, true);
    assert.equal(userCStatus?.connected, false);

    assert.equal((await oauth.getProviderApiKey(provider, userA))?.apiKey, 'user-a-token');
    assert.equal(await oauth.getProviderApiKey(provider, userC), null);

    oauth.saveProviderCredentials(provider, { access: 'global-token', refresh: 'refresh-global', expires });
    assert.equal(oauth.getProviderCredentials(provider)?.access, 'global-token');
    assert.equal(oauth.getProviderCredentials(provider, userC), null);

    assert.equal(
      await fs.readFile(path.join(dataRoot, 'users', 'oauth_user_a', 'settings', 'auth.json'), 'utf8')
        .then((content) => JSON.parse(content)[provider].access),
      'user-a-token',
    );
    assert.equal(
      resolveScopedPiOAuthStatesDir(userA),
      path.join(dataRoot, 'users', 'oauth_user_a', 'settings', 'pi-oauth-states'),
    );

    console.log('pi-oauth-user-scope-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    restoreEnv('CANVAS_DATA_ROOT', previousCanvasDataRoot);
    restoreEnv('DATA', previousData);
    restoreEnv('OAUTH_STORAGE_PATH', previousOAuthStoragePath);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
