import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const users = new Map([
  ['fixture-admin', { id: 'fixture-admin', role: 'admin', email: 'admin@example.test' }],
  ['fixture-member', { id: 'fixture-member', role: 'user', email: 'member@example.test' }],
]);

function request(userId: string | null, value: string | null): NextRequest {
  return new NextRequest('https://notebook.example.test/api/integrations/env?scope=integrations', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-fixture-user': userId } : {}) },
    body: JSON.stringify({ scope: 'integrations', secretScope: 'system', patches: [{ key: 'COMPOSIO_API_KEY', value }] }),
  });
}

async function main() {
  const oldEnvironment = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-env-api-'));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.CANVAS_SECRETS_MASTER_KEY = 'fixture-only-composio-env-master-key';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'bootstrap@example.test';
  for (const key of ['CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY']) delete process.env[key];

  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const audit: Array<Record<string, unknown>> = [];
  const invalidations: Array<{ scope: unknown; keys?: string[] }> = [];
  internals._load = (name, parent, isMain) => {
    if (name === '@/app/lib/auth' || /(?:^|\/)app\/lib\/auth$/u.test(name)) return {
      auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
        const user = users.get(headers.get('x-fixture-user') || '');
        return user ? { user } : null;
      } } },
    };
    if (name === '@/app/lib/audit/audit-service' || /(?:^|\/)app\/lib\/audit\/audit-service$/u.test(name)) return {
      recordAuditEvent: async (event: Record<string, unknown>) => { audit.push(event); },
    };
    if (name === '@/app/lib/mcp/manager' || /(?:^|\/)app\/lib\/mcp\/manager$/u.test(name)) return {
      closeMcpServersForScope: async (scope: unknown, keys?: string[]) => { invalidations.push({ scope, keys }); },
    };
    if (name === '@/app/lib/agents/storage' || /(?:^|\/)app\/lib\/agents\/storage$/u.test(name)) return {
      migrateLegacyAgentEnvIfNeeded: async () => undefined,
    };
    if (name === '@/app/lib/organization/permissions' || /(?:^|\/)app\/lib\/organization\/permissions$/u.test(name)) return {
      readOrganizationPermissionForUser: async () => { throw new Error('System scope never resolves organization membership.'); },
      isOrganizationAdminLike: () => false,
    };
    return originalLoad(name, parent, isMain);
  };

  try {
    // Session injection is the harness boundary. The route's actual admin
    // predicate and encrypted central store remain unmodified.
    const route = await import('../app/api/integrations/env/route');
    const store = await import('../app/lib/secrets/unified-env-store');
    const env = await import('../app/lib/integrations/env-config');
    const system = { secretScope: 'system' as const };
    const personal = { secretScope: 'user' as const, userId: 'fixture-admin' };
    const untouched = [
      { key: 'OPENAI_API_KEY', value: 'fixture-unrelated-model' },
      { key: 'BRAVE_API_KEY', value: 'fixture-unrelated-search' },
      { key: 'OTHER_CENTRAL_KEY', value: 'fixture-unrelated-central' },
      { key: 'CANVAS_PROFILE_AGENTS__OPENAI_API_KEY', value: 'fixture-unrelated-profile' },
    ];
    await store.patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'fixture-old-composio' }, ...untouched], system);
    await store.patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'fixture-personal-composio' }], personal);
    const before = await store.readUnifiedEnvState(system);
    const beforeBytes = await fs.readFile(before.path);
    const personalBefore = await store.readUnifiedEnvState(personal);
    const personalBytes = await fs.readFile(personalBefore.path);

    const unsigned = await route.PATCH(request(null, 'fixture-forbidden-composio'));
    assert.equal(unsigned.status, 401);
    const denied = await route.PATCH(request('fixture-member', 'fixture-forbidden-composio'));
    assert.equal(denied.status, 403, 'a regular authenticated member cannot write system Composio credentials');
    assert.equal((await denied.json()).code, 'ADMIN_REQUIRED');
    assert.deepEqual(await fs.readFile(before.path), beforeBytes, 'rejected system writes leave the encrypted file unchanged');
    assert.equal(audit.length, 0);
    assert.equal(invalidations.length, 0, 'rejected system writes do not invalidate connections');

    const saved = await route.PATCH(request('fixture-admin', 'fixture-new-composio'));
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.success, true);
    assert.equal(savedBody.data.entries.find((entry: { key: string }) => entry.key === 'COMPOSIO_API_KEY')?.value, 'fixture-new-composio');
    const updated = await store.readUnifiedEnvState(system);
    const values = new Map(updated.entries.map(entry => [entry.key, entry.value]));
    assert.equal(values.get('COMPOSIO_API_KEY'), 'fixture-new-composio');
    const integrationView = await env.readScopedEnvState('integrations', { secretScope: 'legacy' });
    assert.equal(integrationView.entries.find(entry => entry.key === 'COMPOSIO_API_KEY')?.value, 'fixture-new-composio',
      'the same central integration view used by the Composio client observes the updated key');
    for (const entry of untouched) assert.equal(values.get(entry.key), entry.value, `${entry.key} survives a targeted Composio PATCH`);
    assert.deepEqual(await fs.readFile(personalBefore.path), personalBytes, 'system provider configuration does not overwrite personal credentials');
    assert.notEqual(updated.revision, before.revision);
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0].scope, null, 'the real route invalidates only the system MCP scope');
    assert.ok(invalidations[0].keys?.every(key => key === 'COMPOSIO_API_KEY'), 'unrelated keys are never reported as changed');
    assert.equal(audit.length, 1);
    assert.equal((audit[0].metadata as Record<string, unknown>).secretScope, 'system');
    assert.equal(JSON.stringify(audit).includes('fixture-new-composio'), false, 'audit metadata never contains the credential value');

    const removed = await route.PATCH(request('fixture-admin', null));
    assert.equal(removed.status, 200);
    const afterRemoval = new Map((await store.readUnifiedEnvState(system)).entries.map(entry => [entry.key, entry.value]));
    assert.equal(afterRemoval.has('COMPOSIO_API_KEY'), false);
    assert.equal((await env.readScopedEnvState('integrations', { secretScope: 'legacy' })).entries.some(entry => entry.key === 'COMPOSIO_API_KEY'), false);
    for (const entry of untouched) assert.equal(afterRemoval.get(entry.key), entry.value);
    assert.deepEqual(await fs.readFile(personalBefore.path), personalBytes);
    console.log('composio-settings-env-api-test: PASS actual ENV PATCH/admin predicate/encrypted store preserve unrelated and personal keys; 401/403 deny system writes without side effects.');
  } finally {
    internals._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in oldEnvironment)) delete process.env[key];
    Object.assign(process.env, oldEnvironment);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
