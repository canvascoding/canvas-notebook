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
  if (request === 'server-only') return {};
  if (request === '@composio/core') {
    return {
      Composio: class {
        connectedAccounts = { list: async () => ({ items: [] }) };
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-scope-'));
  process.env.DATA = tmpRoot;
  process.env.CANVAS_DATA_ROOT = tmpRoot;
  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
  process.env.CANVAS_CONTROL_PLANE_URL = 'https://control.example.test';
  process.env.CANVAS_INSTANCE_TOKEN = 'instance-token';
  process.env.CANVAS_INSTANCE_ID = 'vm-123';

  const { getComposioMode, getLocalComposioApiKey } = await import('../app/lib/composio/composio-client');
  const { getComposioUserId, resetComposioUserIdCache } = await import('../app/lib/composio/composio-identity');
  const { readScopedEnvState, replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');

  await replaceScopedEnvEntries('integrations', [
    { key: 'COMPOSIO_API_KEY', value: 'legacy-key' },
  ], { secretScope: 'legacy' });
  await replaceScopedEnvEntries('integrations', [
    { key: 'COMPOSIO_API_KEY', value: 'user-a-key' },
  ], { userId: 'user-a' });

  assert.equal(await getLocalComposioApiKey({ userId: 'user-a' }), 'user-a-key');
  assert.equal(await getLocalComposioApiKey({ userId: 'user-b' }), null);
  assert.equal(await getComposioMode({ userId: 'user-b' }), 'managed');

  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';
  assert.equal(await getLocalComposioApiKey({ userId: 'user-b' }), 'legacy-key');
  assert.equal(await getComposioMode({ userId: 'user-b' }), 'local');
  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';

  const userAComposioId = await getComposioUserId({ userId: 'user-a' });
  const userBComposioId = await getComposioUserId({ userId: 'user-b' });
  assert.match(userAComposioId, /^canvas-notebook-vm-123-user-/u);
  assert.match(userBComposioId, /^canvas-notebook-vm-123-user-/u);
  assert.notEqual(userAComposioId, userBComposioId);

  resetComposioUserIdCache();
  await replaceScopedEnvEntries('integrations', [
    { key: 'COMPOSIO_API_KEY', value: 'user-a-key' },
    { key: 'COMPOSIO_USER_ID', value: 'explicit-user-a' },
  ], { userId: 'user-a' });
  assert.equal(await getComposioUserId({ userId: 'user-a' }), 'explicit-user-a');

  const userBEnv = await readScopedEnvState('integrations', { userId: 'user-b' });
  assert.equal(
    userBEnv.entries.find((entry) => entry.key === 'COMPOSIO_USER_ID')?.value,
    userBComposioId,
  );

  console.log('composio-user-scope-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
