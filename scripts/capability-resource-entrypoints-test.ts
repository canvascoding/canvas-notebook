import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-resource-entrypoints-'));
  const envKeys = ['DATA', 'CANVAS_DATA_ROOT', 'INTEGRATIONS_ENV_MASTER_KEY', 'QMD_ENABLED'] as const;
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATA: root, CANVAS_DATA_ROOT: root, INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), QMD_ENABLED: 'false' });
  const database = await createPiTestDatabase();
  const raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  let runtimeRefreshes = 0;
  loader._load = (name, parent, isMain) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@/app/lib/auth' || /\/app\/lib\/auth(?:\.ts)?$/u.test(name)) return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const userId = headers.get('x-fixture-user');
      return userId ? { user: { id: userId }, session: { id: `session-${userId}` } } : null;
    } } } };
    if (/capabilities\/activation-actions/u.test(name) || name === '../activation-actions') return {
      refreshCapabilityRuntimeForScope: async () => { runtimeRefreshes += 1; }, refreshOrganizationCapabilityRuntime: async () => {},
    };
    return original(name, parent, isMain);
  };
  try {
    for (const id of ['owner', 'editor', 'runner', 'unassigned']) await raw.run(
      'INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@resource-entrypoints.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org-entrypoints','owner','team',1,1000,1000)");
    for (const id of ['owner', 'editor', 'runner', 'unassigned']) await raw.run(
      "INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org-entrypoints',$1,$2,'active',$3,1000,1000)",
      [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-entrypoints','org-entrypoints','team','team-entrypoints','Fixture team','active',1000,1000)");
    for (const id of ['owner', 'editor', 'runner']) await raw.run(
      "INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ('org-entrypoints','team-entrypoints',$1,'member','active',1,$2,1000,1000)", [id, Number(id === 'owner')]);
    const packageDir = path.join(root, 'package');
    await fs.mkdir(path.join(packageDir, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(packageDir, 'skills', 'entrypoint-context'), { recursive: true });
    await fs.writeFile(path.join(packageDir, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name: 'entrypoint-resource', version: '1.0.0', description: 'Entrypoint fixture', skills: 'skills' }));
    await fs.writeFile(path.join(packageDir, 'skills', 'entrypoint-context', 'SKILL.md'), '---\nname: entrypoint-context\ndescription: Entrypoint context\n---\n\nPRIVATE_PACKAGE_BODY\n');
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const scope = { scopeType: 'organization' as const, organizationId: 'org-entrypoints' };
    const installed = await registry.installCanvasPluginFromPath(packageDir, { scope, enable: true });
    assert(installed.success && installed.plugin?.resourceId);
    const legacy = installed.plugin.resourceId;
    const actions = await import('../app/lib/capabilities/resources/actions');
    const collection = await import('../app/api/capabilities/resources/route');
    const item = await import('../app/api/capabilities/resources/[resourceRef]/route');
    const targetsRoute = await import('../app/api/capabilities/resources/[resourceRef]/targets/route');
    const { createCapabilityResourceTools } = await import('../app/lib/pi/capability-resource-tools');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const request = (userId: string | null, method = 'GET', body?: unknown) => new Request('http://localhost/api/capabilities/resources', {
      method, headers: { ...(userId ? { 'x-fixture-user': userId } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const params = (resourceRef: string) => ({ params: Promise.resolve({ resourceRef }) });
    const descriptor = async (response: Response) => {
      assert.equal(response.status, 200);
      const value = await response.json() as { success: boolean; data: { resource: CapabilityResourceDescriptor } };
      assert.equal(value.success, true);
      return value.data.resource;
    };
    assert.equal((await collection.GET(request(null))).status, 401);
    assert.equal((await item.GET(request(null), params(legacy))).status, 401);
    const initial = await descriptor(await item.GET(request('owner'), params(legacy)));
    assert.equal(initial.metadata.metadataRevision, 0);
    assert.equal((await targetsRoute.GET(request('owner'), params(legacy))).status, 200);
    const configured = await descriptor(await item.POST(request('owner', 'POST', {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'team', workspaceId: 'team-entrypoints' },
      metadata: { displayName: 'Managed fixture' }, accessMode: 'restricted', grants: [
        { targetType: 'user', targetId: 'editor', canUse: false, canEdit: true, canManage: false },
        { targetType: 'user', targetId: 'runner', canUse: true, canEdit: false, canManage: false },
      ],
    }), params(legacy)));
    const ref = configured.metadata.resourceRef;
    assert.equal(configured.metadata.ownership.type, 'team');
    assert.equal(configured.metadata.metadataRevision, 1);
    assert.equal(configured.metadata.grantsRevision, 1);
    const runner = await descriptor(await item.GET(request('runner'), params(ref)));
    assert.equal(runner.access.canUse, true); assert.equal(runner.access.canEdit, false); assert.equal(runner.grants, undefined);
    assert.equal((await targetsRoute.GET(request('runner'), params(ref))).status, 403);
    assert.equal((await item.GET(request('unassigned'), params(ref))).status, 404);
    const denyWrite = { expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { displayName: 'Denied' } };
    assert.equal((await item.PATCH(request('runner', 'PATCH', denyWrite), params(ref))).status, 403);
    assert.equal((await item.PATCH(request('runner', 'PATCH', { ...denyWrite, actorUserId: 'owner' }), params(ref))).status, 400);
    assert.equal((await item.POST(request('owner', 'POST', { expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'user', ownerUserId: 'runner' } }), params(ref))).status, 400);
    assert.equal((await item.PATCH(new Request('http://localhost/api/capabilities/resources', { method: 'PATCH', headers: { 'x-fixture-user': 'owner' }, body: '{' }), params(ref))).status, 400);
    const context = (userId: string, overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext => ({ userId, sessionId: `session-${userId}`,
      agentId: 'resource-agent', workspaceId: 'team-entrypoints', workspaceType: 'team', workspaceName: 'Fixture team', organizationId: 'org-entrypoints',
      customerId: null, projectId: null, workspaceRoot: root, workspaceRootRelativePath: 'team-entrypoints', canWrite: true, canDelete: true, canShare: true, legacy: false, ...overrides });
    const execute = async (userId: string, name: string, input: unknown, overrides: Partial<AgentExecutionContext> = {}) => {
      const selected = createCapabilityResourceTools(userId, 'resource-agent', `session-${userId}`).find(tool => tool.name === name)!;
      return runWithAgentExecutionContext(context(userId, overrides), () => selected.execute('entrypoint-test', input));
    };
    const resultData = <T,>(result: { details?: unknown }): T => {
      const details = result.details as { capabilityResource?: { result: T }; code?: string; error?: string };
      assert(details.capabilityResource, `Expected successful tool result: ${details.code || 'unknown'} ${details.error || ''}`);
      return details.capabilityResource.result;
    };
    const errorCode = (result: { details?: unknown }): string | undefined => (result.details as { code?: string }).code;
    const inspected = resultData<CapabilityResourceDescriptor>(await execute('editor', 'inspect_canvas_resource', { resourceRef: ref }));
    assert.equal(inspected.access.canEdit, true); assert.equal(inspected.access.canUse, false); assert.equal(inspected.access.canManage, false);
    assert.deepEqual(inspected.metadata, (await actions.inspectCapabilityResource({ userId: 'editor', workspaceId: 'team-entrypoints' }, ref)).metadata);
    const toolTargets = resultData<{ users: Array<{ userId: string }> }>(await execute('owner', 'list_canvas_resource_targets', { resourceRef: ref }));
    assert(toolTargets.users.some(user => user.userId === 'runner'));
    assert.equal(errorCode(await execute('runner', 'list_canvas_resource_targets', { resourceRef: ref })), 'CAPABILITY_RESOURCE_ACCESS_DENIED');
    assert.equal(errorCode(await execute('owner', 'configure_canvas_resource', { resourceRef: ref, expectedMetadataRevision: 0,
      expectedGrantsRevision: 0, ownership: { type: 'team', workspaceId: 'team-entrypoints' } })), 'RESOURCE_REVISION_CONFLICT');
    const edited = resultData<CapabilityResourceDescriptor>(await execute('editor', 'update_canvas_resource_metadata', {
      resourceRef: ref, expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { description: 'Updated through actual agent entrypoint' },
    }));
    assert.equal(edited.metadata.updatedByUserId, 'editor');
    assert.equal(edited.metadata.metadataRevision, 2); assert.equal(edited.metadata.grantsRevision, 1);
    const fromApi = await descriptor(await item.GET(request('editor'), params(legacy)));
    assert.equal(fromApi.metadata.description, edited.metadata.description);
    const extraActor = await execute('editor', 'update_canvas_resource_metadata', {
      resourceRef: ref, expectedMetadataRevision: 2, expectedGrantsRevision: 1, metadata: { description: 'Forged' }, userId: 'owner',
    });
    assert.equal(errorCode(extraActor), 'invalid_request');
    assert.equal(errorCode(await execute('editor', 'inspect_canvas_resource', { resourceRef: ref }, { userId: 'owner' })), 'resource_execution_context_required');
    assert.equal(errorCode(await execute('editor', 'inspect_canvas_resource', { resourceRef: ref }, { sessionId: 'other-session' })), 'resource_execution_context_required');
    assert.equal(errorCode(await execute('editor', 'inspect_canvas_resource', { resourceRef: ref }, { agentId: 'other-agent' })), 'resource_execution_context_required');
    const unbound = createCapabilityResourceTools().find(tool => tool.name === 'inspect_canvas_resource')!;
    assert.equal(errorCode(await runWithAgentExecutionContext(context('owner'), () => unbound.execute('metadata-only', { resourceRef: ref }))), 'resource_execution_context_required');
    const latest = resultData<CapabilityResourceDescriptor>(await execute('owner', 'set_canvas_resource_grants', {
      resourceRef: ref, expectedMetadataRevision: 2, expectedGrantsRevision: 1,
      grants: [{ targetType: 'user', targetId: 'runner', canUse: true, canEdit: false, canManage: false }],
    }));
    assert.equal(latest.metadata.grantsRevision, 2);
    assert.equal((await descriptor(await item.GET(request('owner'), params(ref)))).metadata.grantsRevision, 2);
    assert.equal(errorCode(await execute('editor', 'update_canvas_resource_metadata', { resourceRef: ref, expectedMetadataRevision: 2,
      expectedGrantsRevision: 2, metadata: { displayName: 'After revocation' } })), 'CAPABILITY_RESOURCE_NOT_FOUND');
    assert.equal((await item.PATCH(request('owner', 'PATCH', { expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { description: 'Stale' } }), params(ref))).status, 409);
    const visible = await (await collection.GET(request('runner'))).json() as { data: { resources: CapabilityResourceDescriptor[] } };
    assert(visible.data.resources.some(value => value.metadata.resourceRef === ref));
    assert(!JSON.stringify(visible).includes(root)); assert(!JSON.stringify(visible).includes('PRIVATE_PACKAGE_BODY'));
    assert.equal((await registry.getCanvasPlugin('entrypoint-resource', scope))?.checksum, installed.plugin.checksum);
    assert.equal(await registry.computeCanvasPluginChecksum(installed.plugin.installDir), installed.plugin.checksum);
    assert(runtimeRefreshes >= 3);
    console.log('PASS resource API + actual agent factory + shared actions/PG: strict identities, independent rights, aliases, revisions, revocation and immutable artifacts.');
  } finally {
    loader._load = original;
    await raw.close(); await database.close(); await fs.rm(root, { recursive: true, force: true });
    for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
