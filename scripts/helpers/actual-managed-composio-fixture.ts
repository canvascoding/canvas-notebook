import assert from 'node:assert/strict';
import path from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

export async function createActualManagedProxy(apiKey: () => string) {
  const root = process.env.CANVAS_CONTROL_PLANE_TEST_ROOT;
  if (!root) throw new Error('CANVAS_CONTROL_PLANE_TEST_ROOT is required for the actual Managed Composio integration test.');
  const cp = path.resolve(root, 'apps/api');
  const url = (file: string) => pathToFileURL(path.join(cp, file)).href;
  mock.module(url('src/db/connection.ts'), { namedExports: { db: { insert: () => ({ values: async () => {} }) },
    closeDatabaseConnection: async () => {}, assertDatabaseTimeZone: async () => {} } });
  const secrets = await import(url('src/services/managedSecrets.ts'));
  mock.module(url('src/services/managedSecrets.ts'), { namedExports: { ...secrets,
    getManagedProviderSecret: async () => apiKey(), validateManagedInstanceToken: async (token: string, scope: string) => {
      assert.equal(scope, 'composio:tools');
      return token === 'fixture-instance-token' ? { vmId: 'composio-runtime', organizationId: 'runtime-org' } : null;
    } } });
  const organizations = await import(url('src/services/organizations.ts'));
  mock.module(url('src/services/organizations.ts'), { namedExports: { ...organizations, getVmOrganizationId: async () => 'runtime-org' } });
  const fastifyPath = pathToFileURL(path.resolve(cp, '../../node_modules/fastify/fastify.js')).href;
  const { default: Fastify } = await import(fastifyPath);
  const { default: routes } = await import(url('src/routes/managedServices.ts'));
  const app = Fastify();
  let beforeExecute: (() => Promise<void>) | null = null;
  app.addHook('onRequest', async (request: { url: string }) => {
    if (request.url.endsWith('/composio/execute') && beforeExecute) {
      const callback = beforeExecute; beforeExecute = null; await callback();
    }
  });
  await app.register(routes, { prefix: '/v1' });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { baseUrl, close: () => app.close(), beforeNextExecute: (callback: () => Promise<void>) => { beforeExecute = callback; } };
}
