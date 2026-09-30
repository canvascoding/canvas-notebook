import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

type TestUser = { id: string; admin: boolean };
const users = new Map<string, TestUser>([
  ['admin-a', { id: 'admin-a', admin: true }],
  ['admin-b', { id: 'admin-b', admin: true }],
  ['member-a', { id: 'member-a', admin: false }],
  ['member-b', { id: 'member-b', admin: false }],
]);
const memberships = new Map([
  ['admin-a', { configured: true, organizationId: 'org-a', permission: 'admin' }],
  ['admin-b', { configured: true, organizationId: 'org-b', permission: 'admin' }],
  ['member-a', { configured: true, organizationId: 'org-a', permission: 'member' }],
  ['member-b', { configured: true, organizationId: 'org-b', permission: 'member' }],
]);
const auditEvents: Array<Record<string, unknown>> = [];
const closedScopes: Array<{ scope: unknown; changedEnvKeys?: string[] }> = [];

function request(url: string, userId?: string, init: RequestInit = {}): NextRequest {
  const { signal: _signal, ...requestInit } = init;
  const headers = new Headers(init.headers);
  if (userId) headers.set('x-test-user', userId);
  if (init.body) headers.set('content-type', 'application/json');
  return new NextRequest(url, { ...requestInit, headers });
}

function json(method: string, payload: unknown): RequestInit {
  return { method, body: JSON.stringify(payload) };
}

async function responseBody(response: Response): Promise<{
  success: boolean;
  code?: string;
  error?: string;
  data?: {
    revision?: string;
    rawContent?: string;
    entries?: Array<{ key: string; value: string; reserved?: boolean }>;
  };
}> {
  return response.json() as Promise<{
    success: boolean;
    code?: string;
    error?: string;
    data?: {
      revision?: string;
      rawContent?: string;
      entries?: Array<{ key: string; value: string; reserved?: boolean }>;
    };
  }>;
}

function entryValue(data: Awaited<ReturnType<typeof responseBody>>['data'], key: string): string | undefined {
  return data?.entries?.find(entry => entry.key === key)?.value;
}

async function main() {
  const environmentBefore = { ...process.env };
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-unified-secrets-api-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_SECRETS_MASTER_KEY = 'test-only-unified-secrets-master-key';
  delete process.env.INTEGRATIONS_ENV_MASTER_KEY;
  delete process.env.AGENTS_ENV_MASTER_KEY;
  delete process.env.CANVAS_SECRETS_ENV_PATH;
  delete process.env.INTEGRATIONS_ENV_PATH;
  delete process.env.AGENTS_ENV_PATH;

  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (moduleRequest, parent, isMain) => {
    if (moduleRequest === '@/app/lib/auth' || /(?:^|\/)app\/lib\/auth$/u.test(moduleRequest)) {
      return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
        const user = users.get(headers.get('x-test-user') || '');
        return user ? { user: { id: user.id } } : null;
      } } } };
    }
    if (moduleRequest === '@/app/lib/admin-auth' || /(?:^|\/)app\/lib\/admin-auth$/u.test(moduleRequest)) {
      return { isAdminUser: (user: { id: string }) => users.get(user.id)?.admin === true };
    }
    if (moduleRequest === '@/app/lib/organization/permissions' || /(?:^|\/)app\/lib\/organization\/permissions$/u.test(moduleRequest)) {
      return {
        readOrganizationPermissionForUser: async (userId: string) => memberships.get(userId) ?? { configured: false, organizationId: null, permission: null },
        isOrganizationAdminLike: (permission: string | null) => permission === 'admin' || permission === 'owner',
      };
    }
    if (moduleRequest === '@/app/lib/audit/audit-service' || /(?:^|\/)app\/lib\/audit\/audit-service$/u.test(moduleRequest)) {
      return { recordAuditEvent: async (event: Record<string, unknown>) => { auditEvents.push(event); } };
    }
    if (moduleRequest === '@/app/lib/mcp/manager' || /(?:^|\/)app\/lib\/mcp\/manager$/u.test(moduleRequest)) {
      return { closeMcpServersForScope: async (scope: unknown, changedEnvKeys?: string[]) => { closedScopes.push({ scope, changedEnvKeys }); } };
    }
    if (moduleRequest === '@/app/lib/utils/rate-limit' || /(?:^|\/)app\/lib\/utils\/rate-limit$/u.test(moduleRequest)) {
      return { rateLimit: () => ({ ok: true }) };
    }
    if (moduleRequest === '@/app/lib/agents/storage' || /(?:^|\/)app\/lib\/agents\/storage$/u.test(moduleRequest)) {
      return { migrateLegacyAgentEnvIfNeeded: async () => undefined };
    }
    return originalLoad(moduleRequest, parent, isMain);
  };

  try {
    const route = await import('../app/api/integrations/env/route');
    const store = await import('../app/lib/secrets/unified-env-store');
    const userA = { secretScope: 'user' as const, userId: 'member-a' };
    const userB = { secretScope: 'user' as const, userId: 'member-b' };
    const systemScope = { secretScope: 'system' as const };
    const orgAScope = { secretScope: 'organization' as const, organizationId: 'org-a' };
    const orgBScope = { secretScope: 'organization' as const, organizationId: 'org-b' };

    const unauthenticated = await route.GET(request('http://canvas.test/api/integrations/env'));
    assert.equal(unauthenticated.status, 401, 'missing sessions are rejected');

    await store.patchUnifiedEnvEntries([{ key: 'PERSONAL_OWNER_VALUE', value: 'member-a-only-fixture' }], userA);
    await store.patchUnifiedEnvEntries([{ key: 'PERSONAL_OWNER_VALUE', value: 'member-b-only-fixture' }], userB);
    const foreignQuery = await route.GET(request('http://canvas.test/api/integrations/env?scope=all&userId=member-a', 'member-b'));
    assert.equal(entryValue((await responseBody(foreignQuery)).data, 'PERSONAL_OWNER_VALUE'), 'member-b-only-fixture', 'query userId cannot select another personal store');
    const adminForeignWrite = await route.PUT(request('http://canvas.test/api/integrations/env', 'admin-a', json('PUT', {
      secretScope: 'user', userId: 'member-a', scope: 'all', mode: 'patch', patches: [{ key: 'ADMIN_TARGETED_VALUE', value: 'admin-own-store-fixture' }],
    })));
    assert.equal(adminForeignWrite.status, 200, 'admin personal writes target the admin session, ignoring payload userId');
    const adminOwnValue = await store.readUnifiedEnvState({ secretScope: 'user', userId: 'admin-a' });
    assert.equal(entryValue({ entries: adminOwnValue.entries }, 'ADMIN_TARGETED_VALUE'), 'admin-own-store-fixture');
    const stillMemberA = await store.readUnifiedEnvState(userA);
    assert.equal(entryValue({ entries: stillMemberA.entries }, 'ADMIN_TARGETED_VALUE'), undefined);

    await store.patchUnifiedEnvEntries([{ key: 'ORG_SCOPE_VALUE', value: 'org-a-fixture' }], orgAScope);
    await store.patchUnifiedEnvEntries([{ key: 'ORG_SCOPE_VALUE', value: 'org-b-fixture' }], orgBScope);
    const orgBRead = await route.GET(request('http://canvas.test/api/integrations/env?secretScope=organization&scope=all&organizationId=org-a', 'admin-b'));
    assert.equal(entryValue((await responseBody(orgBRead)).data, 'ORG_SCOPE_VALUE'), 'org-b-fixture', 'organization ID comes from server membership, not the request');
    const memberSystem = await route.GET(request('http://canvas.test/api/integrations/env?secretScope=system', 'member-a'));
    const memberOrg = await route.GET(request('http://canvas.test/api/integrations/env?secretScope=organization', 'member-a'));
    assert.equal(memberSystem.status, 403, 'non-admin cannot read system scope');
    assert.equal(memberOrg.status, 403, 'non-admin cannot read organization scope');

    await store.replaceEnvView('integrations', [{ key: 'OWNER_FIXTURE', value: 'owned-integration-fixture' }], userA);
    await store.mutateUnifiedSecretValue('CANVAS_CREDENTIAL_MOCK_PROVIDER__TOKEN', async () => 'hidden-credential-fixture', userA);
    await store.patchUnifiedEnvEntries([
      { key: 'MCP_CREDENTIAL_KEY', value: 'hidden-mcp-key-fixture' },
      { key: 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY', value: 'hidden-email-encryption-fixture' },
      { key: 'CANVAS_SYSTEM_SMTP_PASSWORD', value: 'smtp-first-line-fixture\nsmtp-second-line-fixture' },
      { key: 'UNRELATED_KEEP', value: 'unrelated-keep-fixture' },
    ], userA);
    const protectedKeys = [
      'CANVAS_CREDENTIAL_MOCK_PROVIDER__TOKEN', 'CANVAS_PROFILE_OWNERS__OWNER_FIXTURE',
      'MCP_CREDENTIAL_KEY', 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY', 'CANVAS_SYSTEM_SMTP_PASSWORD',
    ];
    const allViews = [
      ['all', await route.GET(request('http://canvas.test/api/integrations/env?scope=all', 'member-a'))],
      ['integrations', await route.GET(request('http://canvas.test/api/integrations/env?scope=integrations', 'member-a'))],
      ['agents', await route.GET(request('http://canvas.test/api/integrations/env?scope=agents', 'member-a'))],
    ] as const;
    for (const [view, response] of allViews) {
      assert.equal(response.status, 200, `${view} view is available`);
      const serialized = JSON.stringify(await responseBody(response));
      for (const fakeSecret of [
        'hidden-credential-fixture', 'hidden-mcp-key-fixture', 'hidden-email-encryption-fixture',
        'smtp-first-line-fixture', 'smtp-second-line-fixture',
      ]) assert.equal(serialized.includes(fakeSecret), false, `${view} view never leaks ${fakeSecret}`);
    }
    for (const key of protectedKeys) {
      const keyResponse = await route.GET(request(`http://canvas.test/api/integrations/env?scope=all&key=${encodeURIComponent(key)}`, 'member-a'));
      const serialized = JSON.stringify(await responseBody(keyResponse));
      for (const fakeSecret of ['hidden-credential-fixture', 'hidden-mcp-key-fixture', 'hidden-email-encryption-fixture', 'smtp-first-line-fixture', 'smtp-second-line-fixture']) {
        assert.equal(serialized.includes(fakeSecret), false, `key lookup for ${key} never leaks ${fakeSecret}`);
      }
    }
    const legacyIntegrations = await route.GET(request('http://canvas.test/api/integrations/env?scope=integrations', 'member-a'));
    const legacyAgents = await route.GET(request('http://canvas.test/api/integrations/env?scope=agents', 'member-a'));
    assert.equal(entryValue((await responseBody(legacyIntegrations)).data, 'OWNER_FIXTURE'), 'owned-integration-fixture');
    assert.equal(entryValue((await responseBody(legacyAgents)).data, 'OWNER_FIXTURE'), undefined, 'integrations-only values remain out of the agents legacy view');

    const revisionResponse = await route.GET(request('http://canvas.test/api/integrations/env?scope=all', 'member-a'));
    const revision = (await responseBody(revisionResponse)).data?.revision;
    assert.equal(typeof revision, 'string');
    const missingRevisionRaw = await route.PUT(request('http://canvas.test/api/integrations/env', 'member-a', json('PUT', {
      scope: 'all', mode: 'raw', rawContent: 'RAW_KEY="value"\n',
    })));
    assert.equal(missingRevisionRaw.status, 400, 'raw editing requires the original revision');

    const protectedRaw = await route.PUT(request('http://canvas.test/api/integrations/env', 'member-a', json('PUT', {
      scope: 'all', mode: 'raw', baseRevision: revision, rawContent: 'CANVAS_CREDENTIAL_FORGED=raw-forgery-fixture\n',
    })));
    assert.equal(protectedRaw.status, 400, 'raw editing rejects protected credentials');
    const protectedPatch = await route.PATCH(request('http://canvas.test/api/integrations/env', 'member-a', json('PATCH', {
      scope: 'all', patches: [{ key: 'MCP_CREDENTIAL_KEY', value: 'patch-forgery-fixture' }],
    })));
    assert.equal(protectedPatch.status, 400, 'patch editing rejects protected encryption material');
    const duplicateEntries = await route.PUT(request('http://canvas.test/api/integrations/env', 'member-a', json('PUT', {
      scope: 'integrations', entries: [
        { key: 'DUPLICATE_FIXTURE', value: 'first-fixture' },
        { key: 'DUPLICATE_FIXTURE', value: 'second-fixture' },
      ],
    })));
    const invalidEntry = await route.PATCH(request('http://canvas.test/api/integrations/env', 'member-a', json('PATCH', {
      scope: 'all', patches: [{ key: 'INVALID-FIXTURE', value: 'invalid-fixture' }],
    })));
    assert.equal(duplicateEntries.status, 400, 'duplicate entries are rejected');
    assert.equal(invalidEntry.status, 400, 'invalid environment keys are rejected');

    const literal = 'quoted "fixture" text\nsecond literal line';
    const rawEdit = await route.PUT(request('http://canvas.test/api/integrations/env', 'member-a', json('PUT', {
      scope: 'all', mode: 'raw', baseRevision: revision,
      rawContent: `RAW_LITERAL_FIXTURE=${JSON.stringify(literal)}\nUNRELATED_KEEP=updated-by-raw-fixture\n`,
    })));
    assert.equal(rawEdit.status, 200, 'revision-checked raw editing succeeds');
    const afterRaw = await route.GET(request('http://canvas.test/api/integrations/env?scope=all', 'member-a'));
    const afterRawData = (await responseBody(afterRaw)).data;
    assert.equal(entryValue(afterRawData, 'RAW_LITERAL_FIXTURE'), literal, 'quoted multiline values round-trip exactly');
    assert.equal(entryValue(afterRawData, 'UNRELATED_KEEP'), 'updated-by-raw-fixture');
    assert.equal(entryValue(afterRawData, 'MCP_CREDENTIAL_KEY'), undefined);
    const rawRevision = afterRawData?.revision;
    const staleRaw = await route.PUT(request('http://canvas.test/api/integrations/env', 'member-a', json('PUT', {
      scope: 'all', mode: 'raw', baseRevision: revision, rawContent: 'STALE_SHOULD_NOT_APPLY=stale-fixture\n',
    })));
    assert.equal(staleRaw.status, 409, 'stale raw revisions are rejected');
    const afterStale = await route.GET(request('http://canvas.test/api/integrations/env?scope=all', 'member-a'));
    const afterStaleData = (await responseBody(afterStale)).data;
    assert.equal(afterStaleData?.revision, rawRevision, 'stale write preserves the current revision');
    assert.equal(entryValue(afterStaleData, 'STALE_SHOULD_NOT_APPLY'), undefined, 'stale raw content is not applied');
    for (const [key, value] of [
      ['CANVAS_CREDENTIAL_MOCK_PROVIDER__TOKEN', 'hidden-credential-fixture'],
      ['CANVAS_PROFILE_OWNERS__OWNER_FIXTURE', 'integrations'],
      ['MCP_CREDENTIAL_KEY', 'hidden-mcp-key-fixture'],
      ['EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY', 'hidden-email-encryption-fixture'],
      ['CANVAS_SYSTEM_SMTP_PASSWORD', 'smtp-first-line-fixture\nsmtp-second-line-fixture'],
    ]) assert.equal(store.readUnifiedSecretValue(key, userA), value, `raw replacement preserves omitted ${key}`);

    const concurrentResults = await Promise.all([
      route.PATCH(request('http://canvas.test/api/integrations/env', 'member-a', json('PATCH', {
        scope: 'all', patches: [{ key: 'CONCURRENT_ALPHA', value: 'alpha-fixture' }],
      }))),
      route.PATCH(request('http://canvas.test/api/integrations/env', 'member-a', json('PATCH', {
        scope: 'all', patches: [{ key: 'CONCURRENT_BETA', value: 'beta-fixture' }],
      }))),
    ]);
    assert.ok(concurrentResults.every(result => result.status === 200), 'independent targeted patches both succeed under the store lock');
    const concurrentData = (await responseBody(await route.GET(request('http://canvas.test/api/integrations/env?scope=all', 'member-a')))).data;
    assert.equal(entryValue(concurrentData, 'CONCURRENT_ALPHA'), 'alpha-fixture');
    assert.equal(entryValue(concurrentData, 'CONCURRENT_BETA'), 'beta-fixture');
    assert.equal(entryValue(concurrentData, 'UNRELATED_KEEP'), 'updated-by-raw-fixture', 'concurrent patches preserve unrelated keys');

    await route.PUT(request('http://canvas.test/api/integrations/env', 'member-a', json('PUT', {
      scope: 'integrations', entries: [
        { key: 'MANUAL_CATEGORY_FIXTURE', value: 'manual-category-fixture' },
        { key: 'OWNER_FIXTURE', value: 'owned-integration-fixture' },
      ],
    })));
    await route.PUT(request('http://canvas.test/api/integrations/env', 'member-a', json('PUT', {
      scope: 'agents', entries: [{ key: 'AGENT_PROFILE_FIXTURE', value: 'agent-profile-fixture' }],
    })));
    const legacyPatch = await route.PATCH(request('http://canvas.test/api/integrations/env', 'member-a', json('PATCH', {
      scope: 'integrations', patches: [{ key: 'MANUAL_PATCH_FIXTURE', value: 'manual-patch-fixture' }],
    })));
    assert.equal(legacyPatch.status, 200);
    const integrationsAfterPatch = (await responseBody(await route.GET(request('http://canvas.test/api/integrations/env?scope=integrations', 'member-a')))).data;
    const agentsAfterPatch = (await responseBody(await route.GET(request('http://canvas.test/api/integrations/env?scope=agents', 'member-a')))).data;
    assert.equal(entryValue(integrationsAfterPatch, 'MANUAL_CATEGORY_FIXTURE'), 'manual-category-fixture', 'legacy PATCH preserves unrelated manual category keys');
    assert.equal(entryValue(integrationsAfterPatch, 'MANUAL_PATCH_FIXTURE'), 'manual-patch-fixture');
    assert.equal(entryValue(agentsAfterPatch, 'AGENT_PROFILE_FIXTURE'), 'agent-profile-fixture', 'legacy PATCH preserves agent profile values');

    const closesBeforeDeniedWrites = closedScopes.length;
    const deniedOrgWrite = await route.PATCH(request('http://canvas.test/api/integrations/env', 'member-a', json('PATCH', {
      secretScope: 'organization', scope: 'all', patches: [{ key: 'DENIED_ORG_WRITE', value: 'denied-fixture' }],
    })));
    const deniedSystemWrite = await route.PATCH(request('http://canvas.test/api/integrations/env', 'member-a', json('PATCH', {
      secretScope: 'system', scope: 'all', patches: [{ key: 'DENIED_SYSTEM_WRITE', value: 'denied-fixture' }],
    })));
    assert.equal(deniedOrgWrite.status, 403);
    assert.equal(deniedSystemWrite.status, 403);
    assert.equal(closedScopes.length, closesBeforeDeniedWrites, 'denied writes do not close MCP servers');
    const systemWrite = await route.PATCH(request('http://canvas.test/api/integrations/env', 'admin-a', json('PATCH', {
      secretScope: 'system', scope: 'all', patches: [{ key: 'SYSTEM_CANONICAL_FIXTURE', value: 'system-store-fixture' }],
    })));
    assert.equal(systemWrite.status, 200, 'admin system writes use the canonical system store');
    const systemValue = await store.readUnifiedEnvState(systemScope);
    assert.equal(entryValue({ entries: systemValue.entries }, 'SYSTEM_CANONICAL_FIXTURE'), 'system-store-fixture');
    const orgWrite = await route.PATCH(request('http://canvas.test/api/integrations/env', 'admin-b', json('PATCH', {
      secretScope: 'organization', scope: 'all', organizationId: 'org-a', patches: [{ key: 'ORG_B_CANONICAL_FIXTURE', value: 'org-b-write-fixture' }],
    })));
    assert.equal(orgWrite.status, 200);
    assert.equal(store.readUnifiedSecretValue('ORG_B_CANONICAL_FIXTURE', orgBScope), 'org-b-write-fixture');
    assert.equal(store.readUnifiedSecretValue('ORG_B_CANONICAL_FIXTURE', orgAScope), null, 'organization writes use the authenticated admin membership');

    const auditText = JSON.stringify(auditEvents);
    for (const secretValue of [
      'hidden-credential-fixture', 'hidden-mcp-key-fixture', 'hidden-email-encryption-fixture',
      'smtp-first-line-fixture', 'smtp-second-line-fixture', 'patch-forgery-fixture', 'raw-forgery-fixture',
    ]) assert.equal(auditText.includes(secretValue), false, `audit events omit ${secretValue}`);
    assert.ok(closedScopes.length > 0, 'successful writes close scoped MCP servers');
    assert.equal(closedScopes.length, auditEvents.length - 1, 'authorized personal and system writes close MCP servers; organization write does not');
    assert.ok(closedScopes.some(call => JSON.stringify(call.scope).includes('admin-a')), 'personal invalidation uses the authenticated user scope');
    assert.ok(closedScopes.some(call => call.scope === null), 'system invalidation uses the canonical system scope');
    assert.ok(closedScopes.every(call => !JSON.stringify(call.scope).includes('organization')), 'organization writes skip MCP invalidation because the MCP environment reader has no organization scope');
    console.log('unified-secrets-api-test: ok');
  } finally {
    internals._load = originalLoad;
    await fs.rm(dataRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in environmentBefore)) delete process.env[key];
    Object.assign(process.env, environmentBefore);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
