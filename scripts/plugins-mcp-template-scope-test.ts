import assert from 'node:assert/strict';
import Module from 'node:module';
import { createCapabilityResourceId } from '../app/lib/capabilities/reference';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
let memberActive = true;
let canManage = false;
let assigned = true;
let blocked = false;
let snapshotCalls = 0;
let readScope: string | null = null;
let templateRoot: string | null = null;
let personal: Record<string, unknown> = { name: 'same-name', resourceId: 'personal-id', scopeType: 'user', ownerUserId: 'member', version: '1.0.0', installDir: '/plugins/personal', connectors: { mcp: [{ name: 'shared', configPath: 'personal.json' }] } };
const organization = { ...personal, resourceId: 'assigned-id', scopeType: 'organization', organizationId: 'org', installDir: '/plugins/organization', connectors: { mcp: [{ name: 'shared', configPath: 'organization.json' }] } };

internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (parent?.filename.endsWith('/installed-plugin-read.ts') && request === '@/app/lib/plugins/canvas-plugin-registry') return { getCanvasPlugin: async (_name: string, scope: { scopeType: string }) => { readScope = scope.scopeType; return scope.scopeType === 'organization' ? organization : personal; } };
  if (parent?.filename.endsWith('/api/plugins/mcp-template/route.ts')) {
    if (request === 'next/headers') return { headers: async () => new Headers() };
    if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: 'member' } }) } } };
    if (request === '@/app/lib/organization/permissions') return { readOrganizationPermissionForUser: async () => ({ organizationId: 'org', permission: { status: memberActive ? 'active' : 'disabled', role: canManage ? 'admin' : 'member', canSharePluginsAndSkills: canManage } }) };
    if (request === '@/app/lib/capabilities/request-scope') return {
      resolveCapabilityStorageScope: ({ requestedScope }: { requestedScope: string }) => ({ scopeType: requestedScope === 'organization' ? 'organization' : 'user' }),
      resolveCapabilityExecutionContextForUser: async (input: { userId: string; organizationId: string; requestedWorkspaceId: string }) => {
        assert.equal(input.userId, 'member');
        assert.equal(input.organizationId, 'org');
        if (input.requestedWorkspaceId !== 'org-workspace') throw new Error('Workspace denied');
        return { userId: 'member', organizationId: 'org', workspaceId: 'org-workspace' };
      },
    };
    if (request === '@/app/lib/capabilities/catalog') return { resolveEffectiveCapabilitySnapshot: async (context: { workspaceId: string }) => {
      snapshotCalls += 1;
      assert.equal(context.workspaceId, 'org-workspace');
      return { capabilities: assigned ? [{ ref: { resourceType: 'plugin', scopeType: 'organization', resourceId: 'assigned-id', name: 'same-name' }, effectivePolicy: blocked ? 'blocked' : 'required', readiness: 'personal-connection-required' }] : [] };
    } };
    if (request === '@/app/lib/plugins/plugin-mcp-template-service') return { readPluginMcpTemplateFile: async ({ rootDir, configPath }: { rootDir: string; configPath: string }) => { templateRoot = rootDir; return { rawContent: configPath, config: { scope: rootDir } }; } };
    if (request === '@/app/lib/plugins/canvas-plugin-store') return { readCanvasPluginStoreMcpTemplate: async () => ({ source: 'catalog' }) };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const { POST } = await import('../app/api/plugins/mcp-template/route');
    const request = (patch: Record<string, unknown> = {}, workspaceHeader = 'org-workspace') => {
      readScope = null;
      templateRoot = null;
      return POST(new Request('https://canvas.example.test/api/plugins/mcp-template', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': workspaceHeader }, body: JSON.stringify({ source: 'installed', name: 'same-name', connector: 'shared', scope: 'organization', resourceId: 'assigned-id', ...patch }) }));
    };
    const assignedResult = await request();
    assert.equal(assignedResult.status, 200);
    assert.equal(readScope, 'organization');
    assert.equal(templateRoot, organization.installDir);
    assert.equal((await assignedResult.json()).template.rawContent, 'organization.json', 'same-name personal templates cannot replace exact assigned organization identity');
    const personalResult = await request({ scope: 'user', resourceId: 'personal-id' });
    assert.equal(personalResult.status, 200);
    assert.equal(templateRoot, personal.installDir);
    assert.equal((await request({ scope: 'user', resourceId: 'assigned-id' })).status, 404);
    assert.equal(templateRoot, null, 'identity mismatch cannot fall back to a same-name personal plugin');
    const originalPersonal = personal;
    personal = { ...originalPersonal, ownerUserId: 'foreign-user' };
    assert.equal((await request({ scope: 'user', resourceId: 'personal-id' })).status, 404, 'an explicit foreign owner is denied even when a stored resource ID matches');
    personal = { ...originalPersonal, resourceId: undefined, scopeType: undefined, ownerUserId: undefined };
    const legacyResourceId = createCapabilityResourceId({ resourceType: 'plugin', scopeType: 'user', ownerUserId: 'member', sourceType: 'standalone', name: 'same-name' });
    assert.equal((await request({ scope: 'user', resourceId: legacyResourceId })).status, 200, 'legacy personal template accepts the catalog-synthesized identity');
    assert.equal((await request({ scope: 'user', resourceId: undefined })).status, 200, 'legacy callers without an identity remain supported');
    assert.equal((await request({ scope: 'user', resourceId: createCapabilityResourceId({ resourceType: 'plugin', scopeType: 'user', ownerUserId: 'foreign-user', sourceType: 'standalone', name: 'same-name' }) })).status, 404, 'forged legacy ownership cannot resolve a same-name plugin');
    assert.equal(templateRoot, null);
    personal = { ...personal, scopeType: 'legacy', resourceId: 'old-system-resource-id' };
    assert.equal((await request({ scope: 'user', resourceId: legacyResourceId })).status, 200, 'explicit legacy records also use the user catalog fallback');
    assert.equal((await request({ scope: 'user', resourceId: 'old-system-resource-id' })).status, 404);
    const systemResourceId = createCapabilityResourceId({ resourceType: 'plugin', scopeType: 'system', sourceType: 'standalone', name: 'same-name' });
    personal = { ...personal, scopeType: 'system', resourceId: systemResourceId };
    assert.equal((await request({ scope: 'user', resourceId: systemResourceId })).status, 200, 'user legacy storage fallback preserves recorded global system identity');
    assert.equal((await request({ scope: 'user', resourceId: undefined })).status, 200);
    assert.equal((await request({ scope: 'user', resourceId: legacyResourceId })).status, 404, 'a global system record cannot be forged into a personal resource');
    personal = { ...personal, resourceId: undefined };
    assert.equal((await request({ scope: 'user', resourceId: systemResourceId })).status, 200, 'system fallback without an ID synthesizes the catalog system identity');
    personal = originalPersonal;
    assert.equal((await request({ resourceId: 'personal-id' })).status, 403);
    assert.equal((await request({ resourceId: 'foreign-org-id' })).status, 403);
    assert.equal(readScope, null, 'foreign identity is denied before storage lookup');
    assert.equal((await request({ resourceId: undefined })).status, 403);
    assigned = false;
    assert.equal((await request()).status, 403);
    assert.equal(templateRoot, null);
    assigned = true;
    blocked = true;
    assert.equal((await request()).status, 403);
    blocked = false;
    assert.equal((await request({}, 'foreign-workspace')).status, 403);
    assert.equal((await request({ workspaceId: 'foreign-workspace' })).status, 403);
    assert.equal(templateRoot, null, 'an inaccessible active workspace cannot expose an organization template');
    memberActive = false;
    assert.equal((await request()).status, 403);
    memberActive = true;
    canManage = true;
    assigned = false;
    const beforeAdminSnapshot = snapshotCalls;
    const adminResult = await request();
    assert.equal(adminResult.status, 200, 'server-authorized organization managers can configure an installed organization plugin without personal assignment');
    assert.equal(snapshotCalls, beforeAdminSnapshot);
    assert.equal(templateRoot, organization.installDir);
    assert.equal((await request({ resourceId: 'foreign-org-id' })).status, 404);
    assert.equal((await request({}, 'foreign-workspace')).status, 403, 'organization management retains workspace authorization');
    console.log('Plugin MCP template scope: exact assigned identity, same-name isolation, membership/workspace boundaries and authorized organization management passed.');
  } finally {
    internals._load = originalLoad;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
