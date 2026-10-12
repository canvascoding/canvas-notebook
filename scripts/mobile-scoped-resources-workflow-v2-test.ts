import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { IntegrationConnectionDescriptor } from '../app/lib/integration-tools/connections/contracts';
import type { AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';

/** Actual in-memory PostgreSQL schema, filesystem, signed-license/seat, workspace, ACL, CAS and workflow services.
 * Only database transport and the HTTP authentication entry point are controlled; no external server or model is started. */
async function runMobileScopedResourcesWorkflowV2Test(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-scoped-v2-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const org = 'mobile-v2-org', ids = ['owner', 'member', 'editor', 'manager', 'outsider'];
  const payload = { sub: 'mobile-scoped-v2', instanceId: 'mobile-scoped-v2', iss: 'canvas-control-plane', aud: 'canvas-notebook',
    plan: 'managed', status: 'active', protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'mobile-scoped-v2-license',
    hostingMode: 'cloud', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', seatLimit: 10, nonBillable: false,
    entitlementsVersion: 1, deploymentMode: 'managed-team', databaseProvider: 'postgres', vectorProvider: 'pgvector', postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true }, features: { teamWorkspace: true, multiUser: true }, quotas: { users: 10 },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) }), JSON.stringify(payload)]
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  const env = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_SHARED_CONNECTION_POSTGRES_TEST: '0', DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_mobile_v2',
    CANVAS_ORGANIZATION_ID: org, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_INSTANCE_ID: payload.instanceId,
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', CANVAS_LICENSE_CERT: `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`,
    CANVAS_LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: fingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'),
    AUTH_SECRET: randomBytes(32).toString('base64url'), QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true', BASE_URL: 'http://fixture.invalid', BETTER_AUTH_BASE_URL: 'http://fixture.invalid' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load, modules = new Map<string, unknown>();
  let afterResourceList: (() => Promise<void>) | undefined;
  let afterSharedProfileList: (() => Promise<void>) | undefined;
  const wrappers = new WeakMap<object, object>();
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('authorization')?.replace(/^Bearer fixture-/u, '')
        ?? headers.get('cookie')?.match(/^fixture-session=([a-z]+)$/u)?.[1];
      if (!id || !ids.includes(id)) return null;
      return { user: { id, name: id, email: `${id}@mobile-v2.example.test`, role: id === 'owner' ? 'admin' : 'user' },
        session: { id: `auth-${id}`, userId: id, expiresAt: new Date(Date.now() + 3600_000) } };
    } } } };
    if (modules.has(name)) return modules.get(name);
    if (name === '@/app/lib/composio/composio-shared-profiles') {
      const actual = original(name, parent, isMain) as typeof import('../app/lib/composio/composio-shared-profiles');
      let wrapped = wrappers.get(actual);
      if (!wrapped) {
        wrapped = new Proxy(actual, { get(target, key, receiver) {
          if (key !== 'listSharedComposioProfiles') return Reflect.get(target, key, receiver);
          return async (...args: Parameters<typeof actual.listSharedComposioProfiles>) => {
            const result = await actual.listSharedComposioProfiles(...args), hook = afterSharedProfileList; afterSharedProfileList = undefined;
            await hook?.(); return result;
          };
        } }); wrappers.set(actual, wrapped);
      }
      return wrapped;
    }
    if (name === '@/app/lib/capabilities/resources/actions') {
      const actual = original(name, parent, isMain) as typeof import('../app/lib/capabilities/resources/actions');
      let wrapped = wrappers.get(actual);
      if (!wrapped) {
        wrapped = new Proxy(actual, { get(target, key, receiver) {
          if (key !== 'listCapabilityResources') return Reflect.get(target, key, receiver);
          return async (...args: Parameters<typeof actual.listCapabilityResources>) => {
            const result = await actual.listCapabilityResources(...args), hook = afterResourceList; afterResourceList = undefined;
            await hook?.(); return result; // Actual result unchanged; deterministic post-action authority revocation seam.
          };
        } }); wrappers.set(actual, wrapped);
      }
      return wrapped;
    }
    return original(name, parent, isMain);
  };
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    for (const id of ids) {
      await raw.run('INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at) VALUES($1,$1,$2,1,$3,0,1,1)', [id, `${id}@mobile-v2.example.test`, id === 'owner' ? 'admin' : 'user']);
      await raw.run('INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at) VALUES($1,$2,$1,$3,1,1)', [`auth-${id}`, id, Date.now() + 3600_000]);
    }
    await raw.run('INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES($1,\'owner\',\'team\',1,1,1)', [org]);
    for (const id of ids) {
      await raw.run('INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES($1,$2,$3,\'active\',$4,1,1)', [org, id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
      await raw.run('INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,\'active\',1,1,1,1)', [`seat-${id}`, org, `${id}@mobile-v2.example.test`, id, id === 'owner' ? 'owner' : 'member']);
      await raw.run('INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,\'personal\',$3,$1,$3,\'active\',1,1)', [`personal-${id}`, org, id]);
    }
    await raw.run('INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES(\'native-team\',$1,\'team\',\'native-team\',\'Native team\',\'active\',1,1)', [org]);
    for (const id of ['member', 'editor', 'manager']) await raw.run('INSERT INTO canvas_workspace_members(organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES($1,\'native-team\',$2,\'member\',\'active\',1,0,0,1,1)', [org, id]);
    const resources = await import('../app/api/mobile/v1/capabilities/resources/route');
    const resource = await import('../app/api/mobile/v1/capabilities/resources/[resourceRef]/route');
    const resourceTargets = await import('../app/api/mobile/v1/capabilities/resources/[resourceRef]/targets/route');
    const connections = await import('../app/api/mobile/v1/integrations/shared-connections/route');
    const connection = await import('../app/api/mobile/v1/integrations/shared-connections/[connectionRef]/route');
    const connectionTargets = await import('../app/api/mobile/v1/integrations/shared-connections/[connectionRef]/targets/route');
    const setup = await import('../app/api/mobile/v1/integrations/shared-connections/setup/route');
    const sharedProfiles = await import('../app/api/mobile/v1/integrations/shared-connections/profiles/route');
    const packagePresentation = await import('../app/api/mobile/v1/extensions/packages/[resourceRef]/presentation/route');
    const packageInstallOptions = await import('../app/api/mobile/v1/extensions/packages/store/install-options/route');
    const workflowRoute = await import('../app/api/mobile/v1/agents/[agentId]/workflow/route');
    const sources = await import('../app/api/mobile/v1/agents/[agentId]/configuration-sources/route');
    const guard = await import('../app/lib/mobile/scoped-route-v2');
    const request = (id: string | null, suffix: string, body?: Record<string, unknown>, method = body ? 'PATCH' : 'GET', workspace = 'native-team') =>
      new NextRequest(`http://fixture.invalid/api/mobile/v1/${suffix}`, { method, headers: {
        ...(id ? { Authorization: `Bearer fixture-${id}` } : {}), 'X-Canvas-Workspace-Id': workspace,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
    async function success<T>(response: Response): Promise<T> {
      assert.equal(response.status, 200); const value = await response.json() as { success: boolean; contractVersion: number; workspaceId: string; data: T };
      assert.equal(value.success, true); assert.equal(value.contractVersion, 2); assert.equal(value.workspaceId, 'native-team');
      assert.match(response.headers.get('Cache-Control') ?? '', /no-store/u); assert.match(response.headers.get('Vary') ?? '', /Authorization/u);
      assert.doesNotMatch(JSON.stringify(value), /privateBinding|connectedAccountId|backendId|authSessionId|PRIVATE_CONTENT|installDir|rootPath/u); return value.data;
    }
    async function denied(response: Response, status: number) { assert.equal(response.status, status); const value = await response.json() as { success: boolean; contractVersion: number }; assert.equal(value.success, false); assert.equal(value.contractVersion, 2); }
    const source = path.join(root, 'source');
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true }); await fs.mkdir(path.join(source, 'skills', 'native-context'), { recursive: true });
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'same-native-plugin', version: '1.0.0', description: 'Native fixture package', skills: 'skills' }));
    await fs.writeFile(path.join(source, 'skills/native-context/SKILL.md'), '---\nname: native-context\ndescription: Native fixture\n---\nPRIVATE_CONTENT\n');
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const orgInstall = await registry.installCanvasPluginFromPath(source, { scope: { scopeType: 'organization', organizationId: org }, enable: true, installedBy: 'owner' });
    const personalInstall = await registry.installCanvasPluginFromPath(source, { scope: { scopeType: 'user', userId: 'owner' }, enable: false, installedBy: 'owner' });
    assert(orgInstall.success && orgInstall.plugin?.resourceId); assert(personalInstall.success && personalInstall.plugin?.resourceId);
    const orgLegacyRef = orgInstall.plugin.resourceId, personalLegacyRef = personalInstall.plugin.resourceId;
    const refParams = (resourceRef: string) => ({ params: Promise.resolve({ resourceRef }) });
    const before = await success<{ resources: CapabilityResourceDescriptor[] }>(await resources.GET(request('owner', 'capabilities/resources')));
    assert(before.resources.some(value => value.metadata.resourceRef === orgLegacyRef)); assert(before.resources.some(value => value.metadata.resourceRef === personalLegacyRef));
    const initial = await success<{ resource: CapabilityResourceDescriptor }>(await resource.GET(request('owner', 'capabilities/resources/ref'), refParams(orgLegacyRef)));
    assert.equal(initial.resource.metadata.metadataRevision, 0); assert.equal(initial.resource.artifact.name, 'same-native-plugin');
    const configured = await success<{ resource: CapabilityResourceDescriptor }>(await resource.POST(request('owner', 'capabilities/resources/ref', {
      contractVersion: 2, expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'team', workspaceId: 'native-team' }, accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: 'owner', canUse: true, canEdit: true, canManage: true },
        { targetType: 'user', targetId: 'member', canUse: true, canEdit: false, canManage: false },
        { targetType: 'user', targetId: 'editor', canUse: false, canEdit: true, canManage: false },
        { targetType: 'user', targetId: 'manager', canUse: false, canEdit: false, canManage: true }],
    }, 'POST'), refParams(orgLegacyRef)));
    const canonical = configured.resource.metadata.resourceRef; assert.match(canonical, /^canvas-resource:/u); assert.equal(configured.resource.metadata.ownership.type, 'team');
    const duplicates = await success<{ resources: CapabilityResourceDescriptor[] }>(await resources.GET(request('owner', 'capabilities/resources?resourceType=plugin')));
    assert.equal(duplicates.resources.filter(value => value.artifact.name === 'same-native-plugin').length, 2);
    const edited = await success<{ resource: CapabilityResourceDescriptor }>(await resource.GET(request('editor', 'capabilities/resources/ref'), refParams(canonical)));
    assert.equal(edited.resource.access.canEdit, true); assert.equal(edited.resource.access.canUse, false); assert.equal(edited.resource.access.canManage, false); assert.equal(edited.resource.grants, undefined);
    const managed = await success<{ resource: CapabilityResourceDescriptor }>(await resource.GET(request('manager', 'capabilities/resources/ref'), refParams(canonical)));
    assert.equal(managed.resource.access.canManage, true); assert.equal(managed.resource.access.canEdit, false); assert.equal(managed.resource.access.canUse, false); assert(managed.resource.grants);
    await denied(await resource.GET(request('outsider', 'capabilities/resources/ref', undefined, 'GET', 'personal-outsider'), refParams(canonical)), 404);
    await denied(await resource.GET(request('owner', 'capabilities/resources/ref'), refParams('same-native-plugin')), 400);
    await denied(await resourceTargets.GET(request('member', 'capabilities/resources/ref/targets'), refParams(canonical)), 403);
    const targets = await success<{ targets: { users: unknown[] } }>(await resourceTargets.GET(request('manager', 'capabilities/resources/ref/targets'), refParams(canonical))); assert(targets.targets.users.length > 0);
    const revision = { expectedMetadataRevision: configured.resource.metadata.metadataRevision, expectedGrantsRevision: configured.resource.metadata.grantsRevision };
    await denied(await resource.PATCH(request('manager', 'capabilities/resources/ref', { contractVersion: 2, ...revision, metadata: { displayName: 'Management alone' } }), refParams(canonical)), 403);
    const renamed = await success<{ resource: CapabilityResourceDescriptor }>(await resource.PATCH(request('editor', 'capabilities/resources/ref', { contractVersion: 2, ...revision, metadata: { displayName: 'Native updated' } }), refParams(canonical)));
    assert(renamed.resource.metadata.metadataRevision > revision.expectedMetadataRevision);
    await denied(await resource.PATCH(request('owner', 'capabilities/resources/ref', { contractVersion: 2, ...revision, metadata: { displayName: 'Stale' } }), refParams(canonical)), 409);
    await denied(await resource.PATCH(request('member', 'capabilities/resources/ref', { contractVersion: 2,
      expectedMetadataRevision: renamed.resource.metadata.metadataRevision, expectedGrantsRevision: renamed.resource.metadata.grantsRevision, metadata: { displayName: 'Forbidden' } }), refParams(canonical)), 403);
    await denied(await resource.PATCH(request('owner', 'capabilities/resources/ref', { contractVersion: 2, ...revision, actorUserId: 'owner', metadata: { displayName: 'Forged' } }), refParams(canonical)), 400);
    await denied(await resources.GET(request('owner', 'capabilities/resources?scope=team&scope=user')), 400);
    await denied(await resources.GET(request('owner', 'capabilities/resources?ownerUserId=owner')), 400);
    await denied(await resources.GET(request(null, 'capabilities/resources')), 401);
    const nativeCookie = request('owner', 'capabilities/resources/ref', { contractVersion: 2,
      expectedMetadataRevision: renamed.resource.metadata.metadataRevision, expectedGrantsRevision: renamed.resource.metadata.grantsRevision,
      metadata: { displayName: 'Native cookie updated' } });
    nativeCookie.headers.delete('Authorization'); nativeCookie.headers.set('Cookie', 'fixture-session=owner');
    const cookieUpdated = await success<{ resource: CapabilityResourceDescriptor }>(await resource.PATCH(nativeCookie, refParams(canonical)));
    assert(cookieUpdated.resource.metadata.metadataRevision > renamed.resource.metadata.metadataRevision);
    const originMutation = { contractVersion: 2, expectedMetadataRevision: cookieUpdated.resource.metadata.metadataRevision,
      expectedGrantsRevision: cookieUpdated.resource.metadata.grantsRevision, metadata: { displayName: 'Browser mutation denied' } };
    for (const [header, value] of [['Origin', 'https://untrusted.example.test'], ['Sec-Fetch-Site', 'same-origin'],
      ['Sec-Fetch-Mode', 'cors'], ['Sec-Fetch-Dest', 'empty']]) {
      const browserRequest = request('owner', 'capabilities/resources/ref', originMutation); browserRequest.headers.set(header, value);
      await denied(await resource.PATCH(browserRequest, refParams(canonical)), 403);
    }
    const crossSiteRequest = request('owner', 'capabilities/resources/ref', originMutation);
    crossSiteRequest.headers.set('Origin', env.BASE_URL); crossSiteRequest.headers.set('Sec-Fetch-Site', 'cross-site');
    await denied(await resource.PATCH(crossSiteRequest, refParams(canonical)), 403);
    const withoutJson = request('owner', 'capabilities/resources/ref', originMutation); withoutJson.headers.delete('Content-Type');
    await denied(await resource.PATCH(withoutJson, refParams(canonical)), 415);
    const trustedBrowser = request('owner', 'capabilities/resources/ref', { ...originMutation, metadata: { displayName: 'Native updated' } });
    trustedBrowser.headers.set('Origin', env.BASE_URL); trustedBrowser.headers.set('Sec-Fetch-Site', 'same-origin');
    await success(await resource.PATCH(trustedBrowser, refParams(canonical)));
    await denied(await resource.PATCH(request('owner', 'capabilities/resources/ref', { ...originMutation, contractVersion: 1 }), refParams(canonical)), 400);
    const noWorkspace = request('owner', 'capabilities/resources'); noWorkspace.headers.delete('X-Canvas-Workspace-Id');
    await denied(await resources.GET(noWorkspace), 400);
    await denied(await resources.GET(request('owner', 'capabilities/resources?workspaceId=personal-owner')), 400);
    console.log('PASS native resources: real installed duplicate identities, legacy adoption, canonical refs, independent rights, target ACL, CAS and strict envelope.');
    console.log('PASS native mutation transport: unmarked Bearer and Cookie accepted; every browser marker enforces trusted origin, cross-site denied, JSON mandatory.');

    const packages = await import('../app/lib/capabilities/packages/actions');
    const packageActor = { userId: 'owner', workspaceId: 'native-team' }, description = await packages.inspectCapabilityPackage(packageActor, canonical);
    const draft = await packages.createCapabilityPackageDraftAction(packageActor, { operation: 'edit', resourceRef: canonical,
      expectedMetadataRevision: description.resource.metadataRevision, expectedGrantsRevision: description.resource.grantsRevision,
      expectedPackageRevision: description.state?.packageRevision ?? 0, expectedPublishedRevisionRef: description.state?.currentPublishedRevisionRef ?? null });
    const published = await packages.publishCapabilityPackageDraftAction(packageActor, { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: description.resource.metadataRevision, expectedGrantsRevision: description.resource.grantsRevision,
      expectedPackageRevision: description.state?.packageRevision ?? 0, expectedPublishedRevisionRef: description.state?.currentPublishedRevisionRef ?? null });
    assert(published.state?.currentPublishedRevisionRef);
    const agentStore = await import('../app/lib/agents/registry'), grants = await import('../app/lib/agents/grants');
    const agent = await agentStore.createAgentProfile({ agentId: 'native-workflow', name: 'Native workflow', scopeType: 'organization', organizationId: org,
      accessPolicy: 'restricted', enabledTools: ['read'], createdByUserId: 'owner' });
    for (const id of ['owner', 'member', 'editor', 'manager']) await grants.upsertAgentGrant({ agentId: agent.agentId, organizationId: org, actorUserId: 'owner', targetType: 'user', targetId: id, canUse: true, canEdit: true, canManage: true });
    await raw.run('UPDATE agent_grants SET can_use=1,can_edit=0,can_manage=0 WHERE agent_id=$1 AND target_id=\'member\'', [agent.agentId]);
    await raw.run('UPDATE agent_grants SET can_use=0,can_edit=1,can_manage=0 WHERE agent_id=$1 AND target_id=\'editor\'', [agent.agentId]);
    const agentParams = { params: Promise.resolve({ agentId: agent.agentId }) };
    const usable = await success<{ workflow: AgentWorkflowDescriptor }>(await workflowRoute.GET(request('member', 'agents/native-workflow/workflow'), agentParams));
    assert.equal(usable.workflow.access.canUse, true); assert.equal(usable.workflow.access.canEdit, false);
    await denied(await sources.GET(request('member', 'agents/native-workflow/configuration-sources'), agentParams), 403);
    const management = await success<{ sources: { revision: number; workflowRevision: number; access: { canEdit: boolean; canUse: boolean } } }>(await sources.GET(request('editor', 'agents/native-workflow/configuration-sources'), agentParams));
    assert.equal(management.sources.access.canEdit, true); assert.equal(management.sources.access.canUse, false);
    const versions = await success<{ sources: { packages: Array<{ resourceRef: string; versions: Array<{ revisionRef: string }> }> } }>(await sources.GET(request('owner', `agents/native-workflow/configuration-sources?${new URLSearchParams({ view: 'packages', expectedRevision: String(agent.revision), expectedWorkflowRevision: '0' })}`), agentParams));
    const publishedResource = await success<{ resource: CapabilityResourceDescriptor }>(await resource.GET(request('owner', 'capabilities/resources/ref'), refParams(canonical)));
    assert(versions.sources.packages.some(value => value.resourceRef === canonical && value.versions.some(version => version.revisionRef === published.state!.currentPublishedRevisionRef)),
      JSON.stringify({ activation: publishedResource.resource.activation, access: publishedResource.resource.access, packageCount: versions.sources.packages.length }));
    const update = { contractVersion: 2, expectedRevision: agent.revision, expectedWorkflowRevision: 0, workflow: { version: 1, packages: [] } };
    const configuredWorkflow = await success<{ workflow: AgentWorkflowDescriptor }>(await workflowRoute.PATCH(request('editor', 'agents/native-workflow/workflow', update), agentParams));
    assert.equal(configuredWorkflow.workflow.workflowVersion, 1); assert(configuredWorkflow.workflow.workflowRevision > 0);
    await denied(await workflowRoute.PATCH(request('owner', 'agents/native-workflow/workflow', update), agentParams), 409);
    await denied(await workflowRoute.PATCH(request('member', 'agents/native-workflow/workflow', { ...update,
      expectedRevision: configuredWorkflow.workflow.revision, expectedWorkflowRevision: configuredWorkflow.workflow.workflowRevision }), agentParams), 403);
    await denied(await workflowRoute.PATCH(request('editor', 'agents/native-workflow/workflow', { ...update, agentId: agent.agentId }), agentParams), 400);
    await denied(await sources.GET(request('owner', 'agents/native-workflow/configuration-sources?agentId=other'), agentParams), 400);
    const pinnedWorkflow = await success<{ workflow: AgentWorkflowDescriptor }>(await workflowRoute.PATCH(request('owner', 'agents/native-workflow/workflow', {
      contractVersion: 2, expectedRevision: configuredWorkflow.workflow.revision, expectedWorkflowRevision: configuredWorkflow.workflow.workflowRevision,
      workflow: { version: 1, packages: [{ resourceRef: canonical, publishedRevisionRef: published.published.revisionRef,
        checksum: published.published.checksum, skillSelection: { kind: 'plugin' }, declarations: [] }] },
    }), agentParams));
    assert.equal(pinnedWorkflow.workflow.packages[0].resourceRef, canonical);
    assert.equal(pinnedWorkflow.workflow.packages[0].publishedRevisionRef, published.published.revisionRef);
    const pinnedUsable = await success<{ workflow: AgentWorkflowDescriptor }>(await workflowRoute.GET(request('member', 'agents/native-workflow/workflow'), agentParams));
    assert.equal(pinnedUsable.workflow.packages[0].checksum, published.published.checksum);
    const currentResource = await success<{ resource: CapabilityResourceDescriptor }>(await resource.GET(request('owner', 'capabilities/resources/ref'), refParams(canonical)));
    const revoked = await success<{ resource: CapabilityResourceDescriptor }>(await resource.PATCH(request('owner', 'capabilities/resources/ref', {
      contractVersion: 2, expectedMetadataRevision: currentResource.resource.metadata.metadataRevision,
      expectedGrantsRevision: currentResource.resource.metadata.grantsRevision,
      grants: [{ targetType: 'user', targetId: 'owner', canUse: true, canEdit: true, canManage: true },
        { targetType: 'user', targetId: 'member', canUse: true, canEdit: false, canManage: false },
        { targetType: 'user', targetId: 'manager', canUse: false, canEdit: false, canManage: true }],
    }), refParams(canonical)));
    await denied(await resource.GET(request('editor', 'capabilities/resources/ref'), refParams(canonical)), 404);
    await denied(await resource.PATCH(request('editor', 'capabilities/resources/ref', { contractVersion: 2,
      expectedMetadataRevision: revoked.resource.metadata.metadataRevision, expectedGrantsRevision: revoked.resource.metadata.grantsRevision,
      metadata: { displayName: 'Revoked editor' } }), refParams(canonical)), 404);
    console.log('PASS native workflow: actual published package discovery, use/edit separation, central configuration CAS, stale and forged selectors denied.');

    const grant = (targetId: string, canUse: boolean, canManage = false) => ({ targetType: 'user' as const, targetId, canUse, canManage, allowedToolNames: ['read'] });
    const makeConnection = async (ownership: { type: string; workspaceId?: string }) => (await success<{ connection: IntegrationConnectionDescriptor }>(await connections.POST(request('owner', 'integrations/shared-connections', {
      contractVersion: 2, source: 'mcp', ownership, displayName: 'Same native connector', allowedToolNames: ['read'], accessMode: 'restricted',
      config: { url: 'http://127.0.0.1:1/mcp', auth: 'none' }, grants: [grant('member', true), grant('manager', false, true)],
    }, 'POST')))).connection;
    const orgConnection = await makeConnection({ type: 'organization' }), teamConnection = await makeConnection({ type: 'team', workspaceId: 'native-team' });
    assert.notEqual(orgConnection.resource.connectionRef, teamConnection.resource.connectionRef);
    const connParams = (connectionRef: string) => ({ params: Promise.resolve({ connectionRef }) });
    const visible = await success<{ connections: IntegrationConnectionDescriptor[] }>(await connections.GET(request('member', 'integrations/shared-connections?source=mcp')));
    assert.equal(visible.connections.filter(value => value.resource.displayName === 'Same native connector').length, 2);
    const manageOnly = await success<{ connection: IntegrationConnectionDescriptor & { access: { canEdit: boolean }; editAuthority: string } }>(await connection.GET(request('manager', 'integrations/shared-connections/ref'), connParams(teamConnection.resource.connectionRef)));
    assert.equal(manageOnly.connection.access.canUse, false); assert.equal(manageOnly.connection.access.canManage, true); assert.equal(manageOnly.connection.access.canEdit, true); assert.equal(manageOnly.connection.editAuthority, 'manage');
    await denied(await connectionTargets.GET(request('member', 'integrations/shared-connections/ref/targets'), connParams(teamConnection.resource.connectionRef)), 403);
    const connectionCatalog = await success<{ targets: { users: unknown[] } }>(await connectionTargets.GET(request('manager', 'integrations/shared-connections/ref/targets'), connParams(teamConnection.resource.connectionRef))); assert(connectionCatalog.targets.users.length > 0);
    const scopes = await success<{ scopes: Array<{ ownership: { type: string } }> }>(await setup.GET(request('owner', 'integrations/shared-connections/setup'))); assert(scopes.scopes.some(value => value.ownership.type === 'team'));
    const expected = { expectedMetadataRevision: teamConnection.resource.metadataRevision, expectedGrantsRevision: teamConnection.resource.grantsRevision, expectedBindingRevision: teamConnection.resource.bindingRevision };
    const changed = await success<{ connection: IntegrationConnectionDescriptor }>(await connection.PATCH(request('manager', 'integrations/shared-connections/ref', { contractVersion: 2, ...expected, metadata: { displayName: 'Renamed native' } }), connParams(teamConnection.resource.connectionRef)));
    assert(changed.connection.resource.metadataRevision > expected.expectedMetadataRevision);
    await denied(await connection.PATCH(request('owner', 'integrations/shared-connections/ref', { contractVersion: 2, ...expected, metadata: { displayName: 'Stale native' } }), connParams(teamConnection.resource.connectionRef)), 409);
    await denied(await connection.PATCH(request('member', 'integrations/shared-connections/ref', { contractVersion: 2, ...expected, metadata: { displayName: 'Denied' } }), connParams(teamConnection.resource.connectionRef)), 403);
    await denied(await connection.GET(request('owner', 'integrations/shared-connections/ref'), connParams('Same native connector')), 400);
    await denied(await connections.GET(request('owner', 'integrations/shared-connections?scope=user')), 400);
    await denied(await connections.POST(request('owner', 'integrations/shared-connections', { contractVersion: 2, source: 'mcp', ownership: { type: 'organization' }, displayName: 'Unsafe', backend: { connectionId: 'supplied' } }, 'POST')), 400);
    const store = await import('../app/lib/integration-tools/connections/store');
    await store.mutateSharedIntegrationConnection({ userId: 'owner', workspaceId: 'native-team' }, teamConnection.resource.connectionRef, {
      expectedMetadataRevision: changed.connection.resource.metadataRevision, expectedGrantsRevision: changed.connection.resource.grantsRevision, expectedBindingRevision: changed.connection.resource.bindingRevision,
      grants: [grant('member', true)],
    });
    await denied(await connection.GET(request('manager', 'integrations/shared-connections/ref'), connParams(teamConnection.resource.connectionRef)), 404);
    console.log('PASS native connections: actual provider setup/storage actions, exact same-name Org/Team identities, managed-only rights, CAS and revocation.');

    const profileIds: string[] = [];
    for (const ownership of [{ type: 'organization' }, { type: 'team', workspaceId: 'native-team' }]) {
      const created = await sharedProfiles.POST(request('owner', 'integrations/shared-connections/profiles', {
        contractVersion: 2, name: 'Same native profile', ownership, providerMode: 'local',
      }, 'POST'));
      assert.equal(created.status, 201);
      const value = await created.json() as { success: boolean; contractVersion: number; workspaceId: string;
        data: { profile: { id: string; name: string; ownership: { type: string }; canManage: boolean } } };
      assert.equal(value.success, true); assert.equal(value.contractVersion, 2); assert.equal(value.workspaceId, 'native-team');
      assert.equal(value.data.profile.name, 'Same native profile'); assert.equal(value.data.profile.ownership.type, ownership.type);
      assert.equal(value.data.profile.canManage, true); profileIds.push(value.data.profile.id);
      assert.doesNotMatch(JSON.stringify(value), /composioUserId|credential|connectedAccountId|ownerUserId|authSessionId/u);
      const suffix = ownership.type === 'team' ? 'ownershipType=team&teamWorkspaceId=native-team' : 'ownershipType=organization';
      const listed = await success<{ profiles: Array<{ id: string }> }>(await sharedProfiles.GET(request('owner', `integrations/shared-connections/profiles?${suffix}`)));
      assert.deepEqual(listed.profiles.map(profile => profile.id), [value.data.profile.id]);
      await denied(await sharedProfiles.GET(request('member', `integrations/shared-connections/profiles?${suffix}`)), 403);
    }
    assert.notEqual(profileIds[0], profileIds[1]);
    await raw.run('UPDATE canvas_workspace_members SET can_manage=1 WHERE workspace_id=\'native-team\' AND user_id=\'manager\'');
    await success(await sharedProfiles.GET(request('manager', 'integrations/shared-connections/profiles?ownershipType=team&teamWorkspaceId=native-team')));
    afterSharedProfileList = async () => {
      await raw.run('UPDATE canvas_workspace_members SET can_manage=0 WHERE workspace_id=\'native-team\' AND user_id=\'manager\'');
    };
    await denied(await sharedProfiles.GET(request('manager', 'integrations/shared-connections/profiles?ownershipType=team&teamWorkspaceId=native-team')), 403);
    await denied(await sharedProfiles.GET(request('owner', 'integrations/shared-connections/profiles?ownershipType=organization&teamWorkspaceId=native-team')), 400);
    await denied(await sharedProfiles.POST(request('owner', 'integrations/shared-connections/profiles', {
      contractVersion: 2, name: 'Forged profile', ownership: { type: 'organization', organizationId: 'forged' }, providerMode: 'local',
    }, 'POST')), 400);
    console.log('PASS native shared profiles: real Org/Team profile creation and exact scoped lists, same-name separation, management denial and safe central projection.');

    const presentation = await success<{ presentation: { schemaVersion: number; readOnly: boolean; resourceRef: string } }>(await packagePresentation.GET(
      request('owner', 'extensions/packages/ref/presentation'), refParams(canonical)));
    assert.equal(presentation.presentation.schemaVersion, 1); assert.equal(presentation.presentation.readOnly, false);
    assert.equal(presentation.presentation.resourceRef, canonical);
    await denied(await packagePresentation.GET(request('outsider', 'extensions/packages/ref/presentation'), refParams(canonical)), 404);
    await denied(await packagePresentation.GET(request('owner', 'extensions/packages/ref/presentation?unknown=1'), refParams(canonical)), 400);
    const browserPackage = request('owner', 'extensions/packages/store/install-options', { contractVersion: 2 }, 'POST');
    browserPackage.headers.set('Sec-Fetch-Mode', 'cors');
    await denied(await packageInstallOptions.POST(browserPackage), 403);
    await denied(await packageInstallOptions.POST(request('owner', 'extensions/packages/store/install-options', { contractVersion: 1 }, 'POST')), 400);
    await denied(await packageInstallOptions.POST(request('owner', 'extensions/packages/store/install-options', { contractVersion: 2 }, 'POST')), 400);
    const noPackageWorkspace = request('owner', 'extensions/packages/ref/presentation'); noPackageWorkspace.headers.delete('X-Canvas-Workspace-Id');
    await denied(await packagePresentation.GET(noPackageWorkspace, refParams(canonical)), 400);
    const nativePackageFacade = await import('../app/lib/mobile/capability-package-route-v2');
    const packagePresentationAction = await import('../app/lib/capabilities/packages/presentation-actions');
    const delayedNativePackage = nativePackageFacade.mobileCapabilityPackageRoute(async (_request, actor) => {
      const result = await packagePresentationAction.inspectCapabilityPackagePresentationAction(actor, canonical);
      await raw.run('UPDATE "session" SET expires_at=1 WHERE id=\'auth-owner\'');
      return { presentation: result };
    });
    await denied(await delayedNativePackage(request('owner', 'extensions/packages/ref/presentation')), 401);
    await raw.run('UPDATE "session" SET expires_at=$1 WHERE id=\'auth-owner\'', [Date.now() + 3600_000]);
    console.log('PASS native package facade: actual installed presentation, read/management denial, bounded V2 envelope, original workspace and browser-marked mutation guard.');

    const context = await guard.requireMobileScopedContext(request('member', 'capabilities/resources'));
    await assert.rejects(() => guard.revalidateMobileScopedContext({ ...context }), { code: 'UNAUTHORIZED' });
    await raw.run('UPDATE "session" SET expires_at=1 WHERE id=\'auth-member\'');
    await denied(await resources.GET(request('member', 'capabilities/resources')), 401);
    await raw.run('UPDATE "session" SET expires_at=$1 WHERE id=\'auth-member\'', [Date.now() + 3600_000]);
    afterResourceList = async () => { await raw.run('UPDATE "session" SET expires_at=1 WHERE id=\'auth-member\''); };
    await denied(await resources.GET(request('member', 'capabilities/resources')), 401);
    await raw.run('UPDATE "session" SET expires_at=$1 WHERE id=\'auth-member\'', [Date.now() + 3600_000]);
    afterResourceList = async () => { await raw.run('UPDATE canvas_workspace_members SET can_read=0 WHERE workspace_id=\'native-team\' AND user_id=\'member\''); };
    await denied(await resources.GET(request('member', 'capabilities/resources')), 404);
    await raw.run('UPDATE canvas_workspace_members SET can_read=1 WHERE workspace_id=\'native-team\' AND user_id=\'member\'');
    await raw.run('UPDATE team_memberships SET status=\'suspended\' WHERE user_id=\'member\'');
    await denied(await resources.GET(request('member', 'capabilities/resources')), 403);
    await raw.run('UPDATE team_memberships SET status=\'active\' WHERE user_id=\'member\'');
    const { SecretReadinessError } = await import('../app/lib/secrets/readiness');
    const secret = guard.mobileScopedError(new SecretReadinessError('master_key_missing', 'PRIVATE_CONTENT'));
    assert.deepEqual(await secret.json(), { success: false, contractVersion: 2, code: 'master_key_missing', error: 'Configure the required secrets in Settings.', setupHref: '/settings?tab=secrets' });
    console.log('PASS original-session private proof, session/seat/workspace SQL revocation before/after awaits, no DTO authority and sanitized Secrets recovery.');
  } finally {
    loader._load = original; await raw.close(); await database.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const unlock = async (directory: string): Promise<void> => {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(directory, 0o700);
      for (const name of await fs.readdir(directory)) await unlock(path.join(directory, name));
    };
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
  }
}
void runMobileScopedResourcesWorkflowV2Test().catch(error => { console.error(error); process.exitCode = 1; });
