import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import type { AgentWorkflowConfiguration, AgentWorkflowPackageConfiguration } from '../app/lib/agents/workflow-contracts';
import type { AgentWorkflowManagement, AgentWorkflowManagementOptions } from '../app/lib/agents/workflow-management-contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityResourceActor, CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

/** Actual SQL/FS/SDK services; only the database module transport and ESM import boundary are substituted. */
async function main() {
  const native = process.argv.includes('--native');
  if (native && (process.env.NODE_ENV !== 'test' || process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST !== '1')) {
    throw new Error('Native fixture execution requires --native, NODE_ENV=test and the explicit isolated PostgreSQL test flag.');
  }
  const requestedDatabaseUrl = process.env.DATABASE_URL;
  if (native && (!requestedDatabaseUrl || !requestedDatabaseUrl.trim())) throw new Error('Native fixture execution requires the privately supplied database transport.');
  const databaseUrl = native && requestedDatabaseUrl ? requestedDatabaseUrl : 'postgresql://127.0.0.1:1/isolated_fixture';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workflow-management-'));
  const provider = await createComposioProviderFixture();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const org = 'workflow-management-org', userIds = ['owner', 'editor', 'user', 'manager', 'outsider'];
  const payload = { sub: 'isolated-workflow-management', instanceId: 'isolated-workflow-management', iss: 'canvas-control-plane', aud: 'canvas-notebook',
    plan: 'managed', status: 'active', protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'isolated-workflow-management-license',
    hostingMode: 'cloud', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', seatLimit: 10, nonBillable: false,
    entitlementsVersion: 1, deploymentMode: 'managed-team', databaseProvider: 'postgres', vectorProvider: 'pgvector', postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true }, features: { teamWorkspace: true, multiUser: true }, quotas: { users: 10 },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) }), JSON.stringify(payload)]
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  const env = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_SHARED_CONNECTION_POSTGRES_TEST: native ? '1' : '0', DATABASE_URL: databaseUrl,
    CANVAS_ORGANIZATION_ID: org, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_INSTANCE_ID: payload.instanceId,
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', CANVAS_LICENSE_CERT: `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`,
    CANVAS_LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: fingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_API_KEY: '',
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), AUTH_SECRET: randomBytes(32).toString('base64url'), QMD_ENABLED: 'false',
    CANVAS_MCP_DIRECT_ENABLED: 'false', MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true',
    BASE_URL: 'http://127.0.0.1:3001', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:3001' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const database = await createSharedConnectionTestDatabase(); assert.equal(database.native, native);
  const raw = await database.openDb(), modules = new Map<string, unknown>();
  let nativeDatabaseName: string | null = null;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  const resourceReadBoundary: { after: ((actor: CapabilityResourceActor, result: CapabilityResourceDescriptor[], caller: string) => Promise<void>) | null } = { after: null };
  const resourceWrappers = new WeakMap<object, object>();
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (modules.has(name)) return modules.get(name);
    if (name === '@/app/lib/capabilities/resources/actions' || /\/app\/lib\/capabilities\/resources\/actions(?:\.ts)?$/u.test(name)) {
      const actual = original(name, parent, isMain) as typeof import('../app/lib/capabilities/resources/actions');
      let wrapper = resourceWrappers.get(actual);
      if (!wrapper) {
        const list = async (acting: CapabilityResourceActor) => {
          const caller = new Error().stack ?? '', result = await actual.listCapabilityResources(acting);
          const hook = resourceReadBoundary.after; if (hook) await hook(acting, result, caller);
          return result; // Exact actual DTO, unmodified, after all real action leases have returned.
        };
        wrapper = new Proxy(actual, { get: (target, key, receiver) => key === 'listCapabilityResources' ? list : Reflect.get(target, key, receiver) });
        resourceWrappers.set(actual, wrapper);
      }
      return wrapper;
    }
    return original(name, parent, isMain);
  };
  try {
    if (native) {
      const nativePool = database.getPostgresRuntimeQueryable(), options: unknown = Reflect.get(nativePool, 'options');
      assert(options && typeof options === 'object', 'Native fixture must return the actual configured PostgreSQL pool.');
      assert.equal(Reflect.get(options, 'max'), 8, 'Native fixture must retain the eight-client pool.');
      assert(process.env.DATABASE_URL === env.DATABASE_URL, 'Native fixture pool setup must restore the caller database transport.');
      const actual = await raw.get('SELECT current_database() AS name') as { name?: unknown } | undefined;
      assert(typeof actual?.name === 'string' && /^canvas_connection_test_[a-f0-9]{32}$/u.test(actual.name), 'Native fixture must use exactly its own helper-created nonce database.');
      nativeDatabaseName = actual.name;
      console.log(`NATIVE_RECEIPT ${JSON.stringify({ phase: 'created', databaseName: nativeDatabaseName })}`);
    }
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    for (const id of userIds) await raw.run('INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at) VALUES($1,$1,$2,1,\'user\',0,1,1)', [id, `${id}@management.example.test`]);
    await raw.run('INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES($1,\'owner\',\'team\',1,1,1)', [org]);
    for (const id of userIds) {
      await raw.run('INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES($1,$2,$3,\'active\',$4,1,1)', [org, id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
      await raw.run('INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,\'active\',1,1,1,1)', [`seat-${id}`, org, `${id}@management.example.test`, id, id === 'owner' ? 'owner' : 'member']);
      await raw.run('INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,\'personal\',$3,$1,$3,\'active\',1,1)', [`personal-${id}`, org, id]);
    }
    const actor = (id: string): AgentManagementActor => ({ userId: id, organizationId: org, workspaceId: `personal-${id}`, source: 'api' });
    const owner = actor('owner'), editor = actor('editor'), user = actor('user'), manager = actor('manager'), outsider = actor('outsider');
    const packageActor = { userId: owner.userId, workspaceId: owner.workspaceId };
    const agents = await import('../app/lib/agents/registry'), agentGrants = await import('../app/lib/agents/grants');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const management = await import('../app/lib/agents/workflow-management');
    const retention = await import('../app/lib/agents/workflow-binding-retention');
    const schemas = await import('../app/lib/agents/workflow-api-contracts');
    const pluginRegistry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions'), packages = await import('../app/lib/capabilities/packages/actions');
    const connectionStore = await import('../app/lib/integration-tools/connections/store');
    const sharedProfiles = await import('../app/lib/composio/composio-shared-profiles');
    const personalProfiles = await import('../app/lib/composio/composio-profiles');
    const emailPolicy = async () => {
      const email = await agents.ensureEmailAgent(), access = await import('../app/lib/agents/access');
      const actualAccess = await access.getAgentAccess('user', email.agentId, { organizationId: org, workspaceId: user.workspaceId });
      const beforeEmail = await raw.get('SELECT * FROM agents WHERE agent_id=$1', [email.agentId]);
      let managerDenied = false, writeDenied = false;
      try { await management.listAgentWorkflowManagementOptions(user, { view: 'management', agentId: email.agentId }); }
      catch (error) { managerDenied = Boolean(error && typeof error === 'object' && Reflect.get(error, 'status') === 403); }
      try { await workflow.updateManagedAgentConfiguration({ actor: user, agentId: email.agentId, expectedRevision: email.revision,
        expectedWorkflowRevision: email.workflowRevision ?? 0, workflow: { version: 1, packages: [] } }); }
      catch (error) { writeDenied = Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'AGENT_ORGANIZATION_ADMIN_REQUIRED'); }
      const afterEmail = await raw.get('SELECT * FROM agents WHERE agent_id=$1', [email.agentId]);
      const current = await agents.getAgentProfile(email.agentId); assert(current);
      console.log(`Email central-policy observation: member legacy canEdit=${actualAccess.canEdit}; managerDenied=${managerDenied}; workflowWriteDenied=${writeDenied}; nativeToolsUnchanged=${JSON.stringify(current.enabledTools) === JSON.stringify(email.enabledTools)}.`);
      assert(managerDenied, 'An ordinary member must not read the built-in email central configuration as a manager.');
      assert(writeDenied, 'An ordinary member must not configure built-in email workflow even when enabledTools is omitted.');
      assert.deepEqual(afterEmail, beforeEmail, 'Built-in email central policy denies writes independently of enabledTools.');
      const ownerEmail = await management.listAgentWorkflowManagementOptions(owner, { view: 'management', agentId: email.agentId });
      assert.equal(ownerEmail.view, 'management'); if (ownerEmail.view === 'management') assert.deepEqual(ownerEmail.profile.enabledTools, email.enabledTools);
      assert.equal((await workflow.inspectManagedAgentWorkflow(user, email.agentId)).workflowVersion, email.workflowVersion ?? null,
        'Central management denial must preserve the existing native email use projection.');
    };
    if (process.argv.includes('--email-policy-only')) { await emailPolicy(); return; }
    const { patchUnifiedEnvEntries } = await import('../app/lib/secrets/unified-env-store');
    await patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'inert-managed-fixture-key' }], { secretScope: 'organization', organizationId: org });
    await patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'inert-personal-fixture-key' }], { secretScope: 'user', userId: 'editor' });
    const source = path.join(root, 'source', 'management-package'), child = 'skills/selected-workflow';
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true });
    for (const name of ['selected-workflow', 'unselected-sibling']) {
      await fs.mkdir(path.join(source, 'skills', name, 'agents'), { recursive: true });
      await fs.writeFile(path.join(source, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Exact management fixture\nmetadata:\n  version: "1.0.0"\n---\nVersion-one bytes.\n`);
    }
    const portable = { version: 1, integrationCapabilities: [{ id: 'assets', application: 'canva', alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: ['ASSET_LOOKUP'] }] }] };
    await fs.writeFile(path.join(source, child, 'agents/canvas.yaml'), `workflow: ${JSON.stringify(portable)}\n`);
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'management-package', version: '1.0.0', description: 'Pinned management fixture', skills: 'skills' }));
    const installed = await pluginRegistry.installCanvasPluginFromPath(source, { scope: { scopeType: 'organization', organizationId: org }, installedBy: 'owner', enable: true });
    assert(installed.success && installed.plugin?.resourceId, installed.error || 'Actual fixture package installation failed.');
    const installedResourceId = installed.plugin.resourceId;
    const governed = await resources.configureCapabilityResource(packageActor, installedResourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'organization' }, accessMode: 'restricted', grants: userIds.slice(0, 4).map(id => ({ targetType: 'user', targetId: id, canUse: true, canEdit: id === 'owner', canManage: id === 'owner' })) });
    const ref = governed.metadata.resourceRef;
    assert.equal(governed.access.canRead, true, 'Actual fixture resource owner must retain read authority.');
    assert.equal((await resources.inspectCapabilityResource(packageActor, ref)).access.canRead, true);
    const { loadCapabilityCandidatesForResourceActor } = await import('../app/lib/capabilities/resources/read');
    const { assertCapabilityCandidateAccess } = await import('../app/lib/capabilities/resources/catalog-access');
    const actualCandidates = await loadCapabilityCandidatesForResourceActor(packageActor);
    const actualParent = actualCandidates.find(candidate => candidate.ref.resourceId === installedResourceId); assert(actualParent);
    await assertCapabilityCandidateAccess(packageActor, actualParent, 'canRead');
    const edit = (descriptor: CapabilityPackageDescriptor) => ({ operation: 'edit' as const, resourceRef: ref, expectedMetadataRevision: descriptor.resource.metadataRevision,
      expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: descriptor.state?.packageRevision ?? 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const publish = (draft: CapabilityPackageDraft, descriptor: CapabilityPackageDescriptor) => ({ draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: descriptor.state?.packageRevision ?? 0,
      expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const before = await packages.inspectCapabilityPackage(packageActor, ref), initialDraft = await packages.createCapabilityPackageDraftAction(packageActor, edit(before));
    const v1 = await packages.publishCapabilityPackageDraftAction(packageActor, publish(initialDraft, before));
    let agent = await agents.createAgentProfile({ agentId: 'management-agent', name: 'Managed configuration', scopeType: 'organization', organizationId: org,
      accessPolicy: 'restricted', createdByUserId: 'owner', enabledTools: ['read', 'email_read_message', 'email_create_outbox_draft'] });
    for (const id of userIds.slice(0, 4)) await agentGrants.upsertAgentGrant({ agentId: agent.agentId, organizationId: org, actorUserId: 'owner', targetType: 'user', targetId: id, canUse: true, canEdit: true, canManage: true });
    // Persist independent facets directly: the legacy upsert helper intentionally normalizes them hierarchically.
    await raw.run('UPDATE agent_grants SET can_use=$1,can_edit=$2,can_manage=$3 WHERE agent_id=$4 AND target_id=$5', [0, 1, 0, agent.agentId, 'editor']);
    await raw.run('UPDATE agent_grants SET can_use=$1,can_edit=$2,can_manage=$3 WHERE agent_id=$4 AND target_id=$5', [1, 0, 0, agent.agentId, 'user']);
    await raw.run('UPDATE agent_grants SET can_use=$1,can_edit=$2,can_manage=$3 WHERE agent_id=$4 AND target_id=$5', [0, 0, 1, agent.agentId, 'manager']);
    const sharedProfile = await sharedProfiles.createSharedComposioProfile({ actor: owner, ownership: { type: 'organization', organizationId: org }, name: 'Shared metadata fixture', providerMode: 'local' });
    provider.accounts.set(sharedProfile.composioUserId, [{ id: 'SHARED_EXACT', toolkit: 'canva', status: 'ACTIVE' }]);
    const connection = await connectionStore.createSharedIntegrationConnection(owner, { ownership: { type: 'organization', organizationId: org }, displayName: 'Exact shared design', accessMode: 'restricted', allowedToolNames: ['ASSET_LOOKUP'],
      backend: { source: 'composio', profileId: sharedProfile.id, toolkit: 'canva', mode: 'local', accountBinding: 'account', connectedAccountId: 'SHARED_EXACT' },
      grants: [{ targetType: 'user', targetId: 'editor', canUse: true, canManage: false, allowedToolNames: ['ASSET_LOOKUP'] },
        { targetType: 'user', targetId: 'user', canUse: true, canManage: false, allowedToolNames: ['ASSET_LOOKUP'] }] });
    const pkg: AgentWorkflowPackageConfiguration = { resourceRef: ref, publishedRevisionRef: v1.published.revisionRef, checksum: v1.published.checksum,
      skillSelection: { kind: 'skills', relativeRoots: [child] }, declarations: [{ declarationPath: `${child}/agents/canvas.yaml`, capabilities: [{ capabilityId: 'assets', selection: { mode: 'fixed',
        alternativeKey: 'composio:canva', toolCap: ['ASSET_LOOKUP'], target: { kind: 'shared', source: 'composio', connectionRef: connection.resource.connectionRef, bindingRevision: connection.resource.bindingRevision } } }] }] };
    const configure = async (acting: AgentManagementActor, configuration: AgentWorkflowConfiguration, id = agent.agentId, extra: Record<string, unknown> = {}) => {
      const current = await agents.getAgentProfile(id); assert(current);
      return workflow.updateManagedAgentConfiguration({ actor: acting, agentId: id, expectedRevision: current.revision, expectedWorkflowRevision: current.workflowRevision ?? 0, workflow: configuration, ...extra });
    };
    const saved = await configure(editor, { version: 1, packages: [pkg] }); agent = saved.agent;
    const header = async (acting: AgentManagementActor = editor, id = agent.agentId) => {
      const result = await management.listAgentWorkflowManagementOptions(acting, { view: 'management', agentId: id });
      assert.equal(result.view, 'management'); return result as AgentWorkflowManagement;
    };
    const requests = (current: AgentWorkflowManagement) => ({ agentId: current.agentId, expectedRevision: current.revision, expectedWorkflowRevision: current.workflowRevision });
    const slot = { resourceRef: ref, publishedRevisionRef: v1.published.revisionRef, declarationPath: `${child}/agents/canvas.yaml`, capabilityId: 'assets', alternativeKey: 'composio:canva' };
    const storedSnapshot = async (id = agent.agentId) => ({ agent: await raw.get('SELECT * FROM agents WHERE agent_id=$1', [id]),
      bindings: await raw.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id', [id]) });
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const workflowErrors = await import('../app/lib/agents/workflow-contracts'), resourceErrors = await import('../app/lib/capabilities/resources/contracts');
    const connectionErrors = await import('../app/lib/integration-tools/connections/contracts');
    const expectedManagementDenial = (error: unknown) => {
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
      return (error instanceof workflowErrors.AgentWorkflowError || error instanceof resourceErrors.CapabilityResourceError || connectionErrors.isIntegrationConnectionError(error))
        && ['AGENT_ACCESS_DENIED', 'AGENT_REVISION_CONFLICT', 'AGENT_WORKFLOW_REVISION_CONFLICT', 'AGENT_WORKFLOW_BINDING_CHANGED',
          'AGENT_WORKFLOW_RETENTION_INVALID', 'AGENT_WORKFLOW_PACKAGE_DENIED', 'AGENT_WORKFLOW_PACKAGE_CHANGED', 'CONNECTION_ACCESS_DENIED',
          'CAPABILITY_RESOURCE_ACCESS_DENIED', 'CAPABILITY_RESOURCE_NOT_FOUND', 'CAPABILITY_RESOURCE_UNAVAILABLE'].includes(String(code));
    };
    const seedPublishedPackage = async (name: string, skillName: string, alternative: { source: 'composio'; toolkit: string; requiredTools: string[] }
      | { source: 'mcp'; connector: string; requiredTools: string[] }) => {
      const directory = path.join(root, 'source', name), skillRoot = `skills/${skillName}`;
      await fs.mkdir(path.join(directory, '.canvas-plugin'), { recursive: true }); await fs.mkdir(path.join(directory, skillRoot, 'agents'), { recursive: true });
      await fs.writeFile(path.join(directory, skillRoot, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Independent actual fixture\nmetadata:\n  version: "1.0.0"\n---\nActual independent package bytes.\n`);
      await fs.writeFile(path.join(directory, skillRoot, 'agents/canvas.yaml'), `workflow: ${JSON.stringify({ version: 1, integrationCapabilities: [{ id: 'assets', application: 'canva', alternatives: [alternative] }] })}\n`);
      await fs.writeFile(path.join(directory, '.canvas-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Actual independent source', skills: 'skills',
        ...(alternative.source === 'mcp' ? { connectors: { mcp: [{ name: alternative.connector, required: false }] } } : {}) }));
      const result = await pluginRegistry.installCanvasPluginFromPath(directory, { scope: { scopeType: 'organization', organizationId: org }, installedBy: 'owner', enable: true });
      assert(result.success && result.plugin?.resourceId, result.error || 'Independent fixture source install failed.');
      const resource = await resources.configureCapabilityResource(packageActor, result.plugin.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
        ownership: { type: 'organization' }, accessMode: 'restricted', grants: [{ targetType: 'user', targetId: 'owner', canUse: true, canEdit: true, canManage: true },
          { targetType: 'user', targetId: 'editor', canUse: true, canEdit: false, canManage: false }] });
      const resourceRef = resource.metadata.resourceRef, current = await packages.inspectCapabilityPackage(packageActor, resourceRef);
      const draft = await packages.createCapabilityPackageDraftAction(packageActor, { ...edit(current), resourceRef });
      const published = await packages.publishCapabilityPackageDraftAction(packageActor, publish(draft, current));
      return { resourceRef, published: published.published, skillRoot };
    };
    if (process.argv.includes('--empty-profile-read-only')) {
      const ownAgent = await agents.createAgentProfile({ agentId: 'empty-profile-agent', name: 'No profiles', scopeType: 'user', ownerUserId: 'editor', organizationId: org, createdByUserId: 'editor' });
      const snapshot = async () => ({ profiles: await raw.all('SELECT * FROM composio_connection_profiles ORDER BY id'),
        defaults: await raw.all('SELECT * FROM composio_workspace_profile_overrides ORDER BY user_id,workspace_id'),
        user: await raw.get('SELECT * FROM "user" WHERE id=$1', ['editor']) });
      assert.equal((await raw.all('SELECT id FROM composio_connection_profiles WHERE owner_user_id=$1', ['editor'])).length, 0);
      const beforeProfiles = await snapshot(), beforeCalls = provider.calls.length, current = await header(editor, ownAgent.agentId);
      const result = await management.listAgentWorkflowManagementOptions(editor, { view: 'personal-connections', ...requests(current), ...slot });
      const afterProfiles = await snapshot();
      console.log(`Empty-profile management metadata observation: SDK requests=${provider.calls.length - beforeCalls}; persisted profile delta=${afterProfiles.profiles.length - beforeProfiles.profiles.length}; responseView=${result.view}.`);
      assert.equal(provider.calls.length, beforeCalls, 'A management metadata list must not discover accounts.');
      assert.equal(digest(afterProfiles), digest(beforeProfiles), 'Read-only manager metadata must not seed or change personal default profiles.');
      return;
    }
    if (process.argv.includes('--late-read-revoke')) {
      const second = await seedPublishedPackage('management-second-package', 'second-selected-workflow', { source: 'composio', toolkit: 'canva', requiredTools: ['ASSET_LOOKUP'] });
      const secondConnection = await connectionStore.createSharedIntegrationConnection(owner, { ownership: { type: 'organization', organizationId: org }, displayName: 'Second exact shared design', accessMode: 'restricted', allowedToolNames: ['ASSET_LOOKUP'],
        backend: { source: 'composio', profileId: sharedProfile.id, toolkit: 'canva', mode: 'local', accountBinding: 'account', connectedAccountId: 'SHARED_EXACT' },
        grants: [{ targetType: 'user', targetId: 'editor', canUse: true, canManage: false, allowedToolNames: ['ASSET_LOOKUP'] }] });
      const secondPkg: AgentWorkflowPackageConfiguration = { resourceRef: second.resourceRef, publishedRevisionRef: second.published.revisionRef, checksum: second.published.checksum,
        skillSelection: { kind: 'skills', relativeRoots: [second.skillRoot] }, declarations: [{ declarationPath: `${second.skillRoot}/agents/canvas.yaml`, capabilities: [{ capabilityId: 'assets',
          selection: { mode: 'fixed', alternativeKey: 'composio:canva', toolCap: ['ASSET_LOOKUP'], target: { kind: 'shared', source: 'composio',
            connectionRef: secondConnection.resource.connectionRef, bindingRevision: secondConnection.resource.bindingRevision } } }] }] };
      agent = (await configure(editor, { version: 1, packages: [pkg, secondPkg] })).agent;
      const originalResource = await resources.inspectCapabilityResource(packageActor, ref);
      assert(originalResource.grants, 'The actual managing actor must receive the current resource grant set.');
      const originalResourceGrants = originalResource.grants;
      const resourceGrants = originalResourceGrants.map(grant => ({ targetType: grant.targetType, targetId: grant.targetId, canUse: grant.canUse, canEdit: grant.canEdit, canManage: grant.canManage }));
      const replaceResourceGrants = async (revoke: boolean) => {
        const current = await resources.inspectCapabilityResource(packageActor, ref);
        await resources.updateCapabilityResource(packageActor, ref, { expectedMetadataRevision: current.metadata.metadataRevision, expectedGrantsRevision: current.metadata.grantsRevision,
          grants: resourceGrants.map(grant => grant.targetId === 'editor' && revoke ? { ...grant, canUse: false, canEdit: false, canManage: false } : grant) });
      };
      const replaceConnectionGrants = async (revoke: boolean) => {
        const current = await connectionStore.inspectSharedIntegrationConnection(owner, connection.resource.connectionRef); assert(current.grants);
        await connectionStore.mutateSharedIntegrationConnection(owner, connection.resource.connectionRef, { expectedMetadataRevision: current.resource.metadataRevision,
          expectedGrantsRevision: current.resource.grantsRevision, expectedBindingRevision: current.resource.bindingRevision,
          grants: current.grants.map(grant => ({ targetType: grant.targetType, targetId: grant.targetId, canUse: grant.targetId === 'editor' ? !revoke : grant.canUse,
            canManage: grant.canManage, allowedToolNames: grant.allowedToolNames })) });
      };
      const observations: Array<{ name: string; blocked: boolean; hookRan: boolean }> = [];
      for (const name of ['resource', 'connection'] as const) {
        let catalogs = 0;
        const boundary: { hookRan: boolean; error: unknown } = { hookRan: false, error: null };
        resourceReadBoundary.after = async (acting, _result, caller) => {
          if (acting.userId !== 'editor' || !caller.includes('packageDescriptor')) return;
          catalogs++;
          if (catalogs !== 4) return; // Actual two-pass A/B sequence: A was final-checked; B's real catalog read just returned.
          resourceReadBoundary.after = null;
          try { if (name === 'resource') await replaceResourceGrants(true); else await replaceConnectionGrants(true); boundary.hookRan = true; }
          catch (error) { boundary.error = error; throw error; }
        };
        try {
          let result: AgentWorkflowManagement | null = null, denied = false;
          try { result = await header(); } catch (error) { if (boundary.error) throw boundary.error; if (!expectedManagementDenial(error)) throw error; denied = true; }
          const leaked = result?.configuration && JSON.stringify(result.configuration).includes(name === 'resource' ? ref : connection.resource.connectionRef);
          observations.push({ name, blocked: denied || !leaked, hookRan: boundary.hookRan });
          console.log(`Late ${name} observation: realMutationCompleted=${boundary.hookRan}; configurationBlocked=${denied || !leaked}.`);
        } finally { resourceReadBoundary.after = null; if (name === 'resource') await replaceResourceGrants(false); else await replaceConnectionGrants(false); }
      }
      let finalCatalogs = 0;
      const boundary: { hookRan: boolean; error: unknown } = { hookRan: false, error: null };
      const current = await header(), agentActions = await import('../app/lib/agents/management-actions');
      resourceReadBoundary.after = async (acting, _result, caller) => {
        if (acting.userId !== 'editor' || caller.includes('packageDescriptor') || !caller.includes('packageOptions')) return;
        finalCatalogs++;
        if (finalCatalogs !== 2) return;
        resourceReadBoundary.after = null;
        const profile = await agents.getAgentProfile(agent.agentId); assert(profile);
        try { await agentActions.setManagedAgentGrant({ actor: owner, agentId: agent.agentId, expectedRevision: profile.revision, targetType: 'user', targetId: 'editor', canUse: true, canEdit: false, canManage: false }); boundary.hookRan = true; }
        catch (error) { boundary.error = error; throw error; }
      };
      let denied = false;
      try { await management.listAgentWorkflowManagementOptions(editor, { view: 'packages', ...requests(current) }); }
      catch (error) { if (boundary.error) throw boundary.error; if (!expectedManagementDenial(error)) throw error; denied = true; }
      finally { resourceReadBoundary.after = null; }
      observations.push({ name: 'agent-edit', blocked: denied, hookRan: boundary.hookRan });
      console.log(`Late actual-action revocation observations: ${JSON.stringify(observations)}.`);
      assert(observations.every(value => value.hookRan), 'Every revocation must occur at the actual fully-returned catalog boundary.');
      assert(observations.every(value => value.blocked), 'Final manager configuration/options must not survive an earlier resource/connection or late AgentEdit revocation.');
      return;
    }
    if (process.argv.includes('--mcp-approval-retention')) {
      const definitionStore = await import('../app/lib/mcp/server-definitions'), mcpStore = await import('../app/lib/mcp/shared-connections');
      const definition = await definitionStore.publishMcpServerDefinition(org, 'Actual MCP mapping', { url: `${provider.baseUrl}/unused-mcp`, auth: 'none' });
      const mcp = await mcpStore.createSharedMcpConnection(owner, { ownership: { type: 'organization', organizationId: org }, displayName: 'Mapped actual MCP connection', definitionId: definition.id,
        secrets: [], accessMode: 'restricted', allowedToolNames: ['ASSET_LOOKUP'], grants: [{ targetType: 'user', targetId: 'editor', canUse: true, canManage: true, allowedToolNames: null }] });
      const selectedPackage = await seedPublishedPackage('management-mcp-package', 'mcp-selected-workflow', { source: 'mcp', connector: 'design', requiredTools: ['ASSET_LOOKUP'] });
      const selected: AgentWorkflowPackageConfiguration = { resourceRef: selectedPackage.resourceRef, publishedRevisionRef: selectedPackage.published.revisionRef, checksum: selectedPackage.published.checksum,
        skillSelection: { kind: 'skills', relativeRoots: [selectedPackage.skillRoot] }, declarations: [{ declarationPath: `${selectedPackage.skillRoot}/agents/canvas.yaml`, capabilities: [{ capabilityId: 'assets',
          selection: { mode: 'fixed', alternativeKey: 'mcp:design', toolCap: ['ASSET_LOOKUP'], target: { kind: 'shared', source: 'mcp', connectionRef: mcp.resource.connectionRef, bindingRevision: mcp.resource.bindingRevision } } }] }] };
      agent = (await configure(editor, { version: 1, packages: [selected] })).agent;
      const publicConfiguration = await header(); assert(publicConfiguration.configuration);
      const beforeWrite = await storedSnapshot();
      const changed = await definitionStore.publishMcpServerDefinition(org, definition.name, definition.config, definition.id);
      assert.equal(changed.revision, definition.revision + 1); assert.deepEqual(changed.config, definition.config);
      assert.equal((await connectionStore.getIntegrationConnectionRecord(mcp.resource.connectionRef))!.resource.bindingRevision, mcp.resource.bindingRevision);
      let rejected = false;
      try { await workflow.updateManagedAgentConfiguration({ actor: editor, agentId: agent.agentId, expectedRevision: publicConfiguration.revision,
        expectedWorkflowRevision: publicConfiguration.workflowRevision, workflow: publicConfiguration.configuration }); }
      catch (error) {
        if (!(error instanceof workflowErrors.AgentWorkflowError) || !['AGENT_WORKFLOW_BINDING_CHANGED', 'AGENT_WORKFLOW_RETENTION_INVALID', 'AGENT_WORKFLOW_REVISION_CONFLICT'].includes(error.code)) throw error;
        rejected = true;
      }
      const unchanged = digest(await storedSnapshot()) === digest(beforeWrite);
      console.log(`MCP unchanged-manager roundtrip observation: definitionChanged=true; physicalBindingUnchanged=true; unchangedConfigRejected=${rejected}; SQLUnchanged=${unchanged}.`);
      assert(rejected && unchanged, 'An unchanged manager roundtrip must not silently approve a changed MCP definition revision.');
      await configure(editor, { version: 1, packages: [selected] });
      assert.equal((await header()).configurationState, 'available', 'An explicit new selection may approve the current exact definition under current connection management authority.');
      assert(!provider.calls.some(call => call.path.includes('/tools/execute/')));
      return;
    }
    const safe = (dto: AgentWorkflowManagementOptions) => {
      const json = JSON.stringify(dto);
      for (const key of ['personalBinding', 'bindingFingerprint', 'boundProviderRef', 'profileId', 'connectedAccountId', 'composioUserId', 'rootPath', 'sourceStamp']) assert(!new RegExp(`"${key}"\\s*:`, 'u').test(json), `Public management DTO must not expose ${key}.`);
      assert(!json.includes(root)); assert(!json.includes(sharedProfile.id)); assert(!json.includes('SHARED_EXACT'));
    };
    const callCount = provider.calls.length, managed = await header(); safe(managed);
    assert.deepEqual(managed.access, { canUse: false, canEdit: true, canManage: false });
    if (process.argv.includes('--configuration-discovery')) {
      const agentActions = await import('../app/lib/agents/management-actions');
      assert(!(await agentActions.listManagedAgents(editor)).some(item => item.agentId === agent.agentId),
        'Legacy use discovery must still exclude the Edit-only manager.');
      const configured = await agentActions.listManagedAgents(editor, { purpose: 'configure' });
      assert(configured.some(item => item.agentId === agent.agentId && item.access.canEdit && !item.access.canUse),
        'Configuration discovery must include an independently Edit-authorized manager.');
      assert(!(await agentActions.listManagedAgents(outsider, { purpose: 'configure' })).some(item => item.agentId === agent.agentId));
      await assert.rejects(() => agentActions.listManagedAgents({ ...editor, workspaceId: 'personal-owner' }, { purpose: 'configure' }));
      let authenticatedUser: string | null = 'editor';
      modules.set('@/app/lib/auth', { auth: { api: { getSession: async () => authenticatedUser ? {
        user: { id: authenticatedUser }, session: { id: 'controlled-discovery-session' },
      } : null } } });
      const route = await import('../app/api/agents/route'), { NextRequest } = await import('next/server');
      const request = (extra: Record<string, string> = {}) => new NextRequest(`http://127.0.0.1:3001/api/agents?${new URLSearchParams({
        workspaceId: 'personal-editor', ...extra,
      })}`);
      const legacy = await route.GET(request()); assert.equal(legacy.status, 200);
      assert(!(await legacy.json()).data.agents.some((item: { agentId: string }) => item.agentId === agent.agentId));
      const response = await route.GET(request({ purpose: 'configure' })); assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert((await response.json()).data.agents.some((item: { agentId: string; access: { canUse: boolean; canEdit: boolean } }) =>
        item.agentId === agent.agentId && item.access.canEdit && !item.access.canUse));
      assert.equal((await route.GET(request({ purpose: 'configure', agentId: agent.agentId }))).status, 400);
      assert.equal((await route.GET(request({ purpose: 'invalid' }))).status, 400);
      assert.equal((await route.GET(request({ purpose: 'configure', organizationId: 'foreign-organization' }))).status, 403,
        'An explicit organization identity must not be replaced by the readable workspace organization.');
      assert.equal((await route.GET(request({ purpose: 'configure', projectId: 'foreign-project' }))).status, 403,
        'An explicit project identity must not be replaced by the readable workspace project.');
      assert.equal((await route.GET(new NextRequest(`${request({ purpose: 'configure' }).url}&purpose=use`))).status, 400);
      assert.equal((await route.GET(request({ agentId: agent.agentId }))).status, 403, 'Configuration discovery does not authorize legacy content inspection.');
      authenticatedUser = null; assert.equal((await route.GET(request({ purpose: 'configure' }))).status, 401);
      console.log('PASS actual Edit-only configuration discovery with unchanged legacy use discovery.');
      return;
    }
    assert.equal(managed.bindingSummaries?.[0]?.scopeLabel, 'organization');
    assert.equal(managed.bindingSummaries?.[0]?.source, 'composio');
    assert.equal(managed.bindingSummaries?.[0]?.resourceRef, ref);
    assert.equal(managed.bindingSummaries?.[0]?.publishedRevisionRef, v1.published.revisionRef);
    assert.equal(managed.unavailableConnectionCount, 0, 'Configure-authorized connections must not be mistaken for unavailable solely because AgentUse is false.');
    await assert.rejects(() => header(user), { code: 'AGENT_ACCESS_DENIED' });
    await assert.rejects(() => header(manager), { code: 'AGENT_ACCESS_DENIED' });
    await assert.rejects(() => header(outsider), { code: 'AGENT_ACCESS_DENIED' });
    assert.equal((await workflow.inspectManagedAgentWorkflow(user, agent.agentId)).workflowVersion, 1);
    await assert.rejects(() => configure(user, { version: 1, packages: [pkg] }), { code: 'AGENT_ACCESS_DENIED' });
    const packageOptions = await management.listAgentWorkflowManagementOptions(editor, { view: 'packages', ...requests(managed), kind: 'plugin' }); safe(packageOptions);
    assert.equal(packageOptions.view, 'packages'); if (packageOptions.view === 'packages') assert(packageOptions.packages.some(item => item.resourceRef === ref));
    const versions = await management.listAgentWorkflowManagementOptions(editor, { view: 'package-version', ...requests(managed), resourceRef: ref, publishedRevisionRef: v1.published.revisionRef }); safe(versions);
    assert.equal(versions.view, 'package-version'); if (versions.view === 'package-version') {
      assert.equal(versions.checksum, v1.published.checksum); assert.deepEqual(versions.skillRoots.map(item => item.relativeRoot).sort(), [child, 'skills/unselected-sibling'].sort());
      assert.deepEqual(versions.declarations.map(item => item.declarationPath), [`${child}/agents/canvas.yaml`]);
    }
    const options = await management.listAgentWorkflowManagementOptions(editor, { view: 'connections', ...requests(managed), ...slot }); safe(options);
    assert.equal(options.view, 'connections'); if (options.view === 'connections') assert(options.connections.some(item => item.connectionRef === connection.resource.connectionRef));
    assert.equal(provider.calls.length, callCount, 'Management metadata/version/shared-option reads must perform zero SDK requests.');
    assert.deepEqual(agent.enabledTools, ['read', 'email_read_message', 'email_create_outbox_draft'], 'Central workflow configuration preserves native email names.');
    // Actual thin adapters with controlled auth/context transport; this is not browser/session authentication acceptance.
    let authenticatedUser = 'editor';
    modules.set('@/app/lib/auth', { auth: { api: { getSession: async () => ({ user: { id: authenticatedUser }, session: { id: 'controlled-auth-session' } }) } } });
    const route = await import('../app/api/agents/workflow/route'), { NextRequest } = await import('next/server');
    const request = (query: Record<string, string>) => new NextRequest(`http://127.0.0.1:3001/api/agents/workflow?${new URLSearchParams({ agentId: agent.agentId, workspaceId: `personal-${authenticatedUser}`, ...query })}`);
    const response = await route.GET(request({ view: 'management' })); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const publicBody = await response.json(); assert.equal(publicBody.data.view, 'management'); safe(publicBody.data);
    assert.equal((await route.GET(request({ view: 'management', unsupported: 'value' }))).status, 400);
    assert.equal((await route.GET(new NextRequest(`${request({ view: 'packages', expectedRevision: String(managed.revision), expectedWorkflowRevision: String(managed.workflowRevision) }).url}&page=1&page=2`))).status, 400);
    authenticatedUser = 'user'; assert.equal((await route.GET(request({ view: 'management' }))).status, 403);
    const legacyResponse = await route.GET(request({ view: 'options' })); assert.equal(legacyResponse.status, 200); assert.equal((await legacyResponse.json()).data.workflowVersion, 1);
    const { createAgentManagementTools } = await import('../app/lib/pi/agent-management-tools');
    const { DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    const managementTool = createAgentManagementTools('editor', DEFAULT_MANAGED_AGENT_ID).find(tool => tool.name === 'list_agent_workflow_options'); assert(managementTool);
    const toolOutput = await managementTool.execute('management-fixture', { view: 'management', agentId: agent.agentId });
    assert.equal((toolOutput.details as { management: AgentWorkflowManagement }).management.view, 'management');
    const useTool = createAgentManagementTools('user', DEFAULT_MANAGED_AGENT_ID).find(tool => tool.name === 'list_agent_workflow_options'); assert(useTool);
    const userToolOutput = await useTool.execute('legacy-options-fixture', { agentId: agent.agentId }); assert.equal((userToolOutput.details as { workflow: { workflowVersion: number } }).workflow.workflowVersion, 1);
    assert.equal(provider.calls.length, callCount, 'The actual HTTP/tool manager and legacy adapters retain metadata-only behavior.');
    console.log('PASS actual Edit-only manager/read/configure versus independent Use/Manage, exact package inventory, safe DTO and zero SDK metadata.');

    for (const toolCap of [null, ['ASSET_LOOKUP', 'DESIGN_CREATE']]) {
      const bounded = structuredClone(pkg), selectedCapability = bounded.declarations[0].capabilities[0].selection;
      if (selectedCapability.mode !== 'fixed') throw new Error('Expected fixed fixture slot.'); selectedCapability.toolCap = toolCap;
      agent = (await configure(editor, { version: 1, packages: [bounded] })).agent;
      const current = await header(); assert.equal(current.configurationState, 'available');
      const selectedConfiguration = current.configuration!.packages[0].declarations[0].capabilities[0].selection;
      if (selectedConfiguration.mode !== 'fixed') throw new Error('Expected fixed public fixture slot.'); assert.deepEqual(selectedConfiguration.toolCap, toolCap);
      const currentOptions = await management.listAgentWorkflowManagementOptions(editor, { view: 'connections', ...requests(current), ...slot });
      assert.equal(currentOptions.view, 'connections'); if (currentOptions.view === 'connections') {
        assert.deepEqual(currentOptions.connections.find(item => item.connectionRef === connection.resource.connectionRef)!.allowedToolNames, ['ASSET_LOOKUP'],
          'Null inherits the current grant; optional stored names must never widen that grant.');
      }
    }
    agent = (await configure(editor, { version: 1, packages: [pkg] })).agent;
    assert.equal(provider.calls.length, callCount, 'Null/optional caps are configuration metadata, not provider or business discovery.');

    const state = async (id = agent.agentId) => ({ profile: await raw.get('SELECT * FROM agents WHERE agent_id=$1', [id]), bindings: await raw.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id', [id]) });
    const unchanged = async (operation: () => Promise<unknown>, code?: string, id = agent.agentId) => {
      const previousState = await state(id);
      if (code) await assert.rejects(operation, { code }); else await assert.rejects(operation);
      assert.deepEqual(await state(id), previousState, 'Rejected configuration must preserve profile and all bindings.');
    };
    await unchanged(() => workflow.updateManagedAgentConfiguration({ actor: editor, agentId: agent.agentId, expectedRevision: agent.revision - 1, expectedWorkflowRevision: 1, workflow: { version: 1, packages: [pkg] } }));
    await assert.rejects(() => management.listAgentWorkflowManagementOptions(editor, { view: 'connections', ...requests(managed), expectedWorkflowRevision: 0, ...slot }));
    await raw.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_user_id=$2', [ref, 'editor']);
    await unchanged(() => configure(editor, { version: 1, packages: [pkg] }));
    await raw.run('UPDATE capability_resource_grants SET can_use=1 WHERE resource_ref=$1 AND target_user_id=$2', [ref, 'editor']);
    await raw.run('UPDATE integration_connection_grants SET can_use=0,can_manage=1 WHERE connection_ref=$1 AND target_user_id=$2', [connection.resource.connectionRef, 'editor']);
    await unchanged(() => configure(editor, { version: 1, packages: [pkg] }));
    const deniedConnections = await management.listAgentWorkflowManagementOptions(editor, { view: 'connections', ...requests(await header()), ...slot });
    assert.equal(deniedConnections.view, 'connections'); if (deniedConnections.view === 'connections') assert(!deniedConnections.connections.some(item => item.connectionRef === connection.resource.connectionRef));
    await raw.run('UPDATE integration_connection_grants SET can_use=1,can_manage=0 WHERE connection_ref=$1 AND target_user_id=$2', [connection.resource.connectionRef, 'editor']);
    await raw.run('UPDATE integration_connection_grants SET allowed_tool_names_json=$1 WHERE connection_ref=$2 AND target_user_id=$3', [JSON.stringify(['DESIGN_CREATE']), connection.resource.connectionRef, 'editor']);
    try {
      const missingRequired = await header(); assert.equal(missingRequired.configurationState, 'blocked'); assert.equal(missingRequired.configuration, null);
      assert(missingRequired.unavailableConnectionCount > 0, 'A missing required action blocks central configuration rather than granting it.');
      const inherited = structuredClone(pkg), inheritedSelection = inherited.declarations[0].capabilities[0].selection;
      if (inheritedSelection.mode !== 'fixed') throw new Error('Expected fixed fixture slot.'); inheritedSelection.toolCap = null;
      await unchanged(() => configure(editor, { version: 1, packages: [inherited] }));
    } finally { await raw.run('UPDATE integration_connection_grants SET allowed_tool_names_json=$1 WHERE connection_ref=$2 AND target_user_id=$3', [JSON.stringify(['ASSET_LOOKUP']), connection.resource.connectionRef, 'editor']); }
    const currentPackage = await packages.inspectCapabilityPackage(packageActor, ref); let nextDraft = await packages.createCapabilityPackageDraftAction(packageActor, edit(currentPackage));
    for (const file of [`${child}/agents/canvas.yaml`, `${child}/SKILL.md`]) nextDraft = (await packages.deleteCapabilityPackageDraftFileAction(packageActor, nextDraft.draftRef, { expectedDraftRevision: nextDraft.draftRevision, path: file })).draft;
    nextDraft = (await packages.writeCapabilityPackageDraftFileAction(packageActor, nextDraft.draftRef, { expectedDraftRevision: nextDraft.draftRevision,
      path: '.canvas-plugin/plugin.json', encoding: 'base64', content: Buffer.from(JSON.stringify({ name: 'management-package', version: '2.0.0', description: 'HEAD without the selected child', skills: 'skills' })).toString('base64') })).draft;
    const v2 = await packages.publishCapabilityPackageDraftAction(packageActor, publish(nextDraft, currentPackage)); assert.notEqual(v2.published.revisionRef, v1.published.revisionRef);
    const pinned = await management.listAgentWorkflowManagementOptions(editor, { view: 'package-version', ...requests(await header()), resourceRef: ref, publishedRevisionRef: v1.published.revisionRef });
    assert.equal(pinned.view, 'package-version'); if (pinned.view === 'package-version') assert(pinned.skillRoots.some(item => item.relativeRoot === child));
    const stillPinned = await header(); assert.equal(stillPinned.configuration?.packages[0].publishedRevisionRef, v1.published.revisionRef);
    assert.deepEqual(stillPinned.configuration?.packages[0].skillSelection, { kind: 'skills', relativeRoots: [child] });
    const missingPin = 'canvas-package-revision:00000000-0000-4000-8000-000000000000';
    await assert.rejects(() => management.listAgentWorkflowManagementOptions(editor, { view: 'package-version', ...requests(stillPinned), resourceRef: ref, publishedRevisionRef: missingPin }));
    await unchanged(() => configure(editor, { version: 1, packages: [{ ...pkg, publishedRevisionRef: v2.published.revisionRef, checksum: v2.published.checksum }] }));
    const storedPin = await raw.get('SELECT configuration_json FROM agent_capability_bindings WHERE agent_id=$1 AND configuration_json IS NOT NULL', [agent.agentId]) as { configuration_json: string };
    const unavailablePin = JSON.parse(storedPin.configuration_json); unavailablePin.publishedRevisionRef = missingPin;
    try {
      await raw.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2 AND configuration_json IS NOT NULL', [JSON.stringify(unavailablePin), agent.agentId]);
      const unavailable = await header(); assert.equal(unavailable.configurationState, 'blocked'); assert.equal(unavailable.configuration, null);
      assert.deepEqual(unavailable.bindingSummaries, [], 'Blocked bindings must not reveal unavailable connection labels.');
      assert(unavailable.unavailablePackageCount > 0, 'A missing stored pin must be explicitly unavailable, never silently replaced by HEAD.');
    } finally { await raw.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2 AND configuration_json IS NOT NULL', [storedPin.configuration_json, agent.agentId]); }
    console.log('PASS actual independent package/connection grants, CAS rollback, v1 child pin after removed HEAD child, no missing-pin fallback.');

    // Personal target retention uses a separate user agent; organization fixed personal targets remain prohibited.
    let personalAgent = await agents.createAgentProfile({ agentId: 'personal-management-agent', name: 'Personal retained binding', scopeType: 'user', ownerUserId: 'editor',
      organizationId: org, accessPolicy: 'restricted', createdByUserId: 'editor', enabledTools: ['read', 'email_read_message'] });
    const selectedProfile = await personalProfiles.createComposioProfile({ ownerUserId: 'editor', name: 'Explicit profile' });
    assert(selectedProfile.updatedAt instanceof Date && Number.isFinite(selectedProfile.updatedAt.getTime()), 'Actual profile timestamps must be valid with both PGlite and native PostgreSQL transport.');
    const unrelatedProfile = await personalProfiles.createComposioProfile({ ownerUserId: 'editor', name: 'Unrelated default' });
    provider.accounts.set(selectedProfile.composioUserId, [{ id: 'PERSONAL_ACCOUNT_A', toolkit: 'canva', status: 'ACTIVE' }, { id: 'PERSONAL_ACCOUNT_B', toolkit: 'canva', status: 'ACTIVE' }]);
    provider.accounts.set(unrelatedProfile.composioUserId, [{ id: 'UNRELATED_DEFAULT', toolkit: 'canva', status: 'ACTIVE' }]);
    await personalProfiles.setComposioWorkspaceProfileOverride({ userId: 'editor', workspaceId: editor.workspaceId!, profileId: unrelatedProfile.id });
    const defaultsBefore = await raw.all('SELECT * FROM composio_workspace_profile_overrides ORDER BY workspace_id');
    const profileDefaultsBefore = await raw.all('SELECT id,is_default FROM composio_connection_profiles WHERE owner_user_id=$1 ORDER BY id', ['editor']);
    const metadataBefore = provider.calls.length;
    const personalHeader = await header(editor, personalAgent.agentId);
    const ownOptions = await management.listAgentWorkflowManagementOptions(editor, { view: 'personal-connections', ...requests(personalHeader), ...slot }); safe(ownOptions);
    assert.equal(ownOptions.view, 'personal-connections'); assert.equal(provider.calls.length, metadataBefore, 'Personal profiles require no account SDK discovery until explicit profile selection.');
    if (ownOptions.view !== 'personal-connections') throw new Error('Expected personal connection options.');
    const { createIntegrationProviderRef } = await import('../app/lib/integration-tools/references');
    const exactProvider = createIntegrationProviderRef({ source: 'composio', profileId: selectedProfile.id, toolkit: 'canva', scope: { type: 'user', ownerUserId: 'editor', resourceId: `profile:${selectedProfile.id}:canva` } });
    assert(ownOptions.alternatives[0].providers.some(item => item.providerRef === exactProvider));
    if (process.argv.includes('--planning-metadata-only')) {
      const { filterToolsForPlanningMode } = await import('../app/lib/pi/planning-mode');
      const { AgentManagementError } = await import('../app/lib/agents/management-actions');
      const { Check } = await import('typebox/value');
      const normalTools = createAgentManagementTools('editor', DEFAULT_MANAGED_AGENT_ID), planningTools = filterToolsForPlanningMode(normalTools);
      const metadataTool = planningTools.find(tool => tool.name === 'list_agent_workflow_options'); assert(metadataTool);
      assert(!planningTools.some(tool => tool.name === 'list_agent_workflow_personal_options'), 'Explicit account discovery must not enter the Planning whitelist.');
      const beforeCalls = provider.calls.length, request = { view: 'personal-connections', ...requests(personalHeader), ...slot };
      assert.equal(Check(metadataTool.parameters, request), true, 'Public metadata JSONSchema accepts the same minimal actual readonly request.');
      assert.equal(Check(metadataTool.parameters, { ...request, providerRef: exactProvider }), false, 'The public wire schema must reject the Planning SDK alias, too.');
      const metadata = await metadataTool.execute('planning-metadata-fixture', request);
      assert.equal((metadata.details as { management: AgentWorkflowManagementOptions }).management.view, 'personal-connections');
      assert.equal(provider.calls.length, beforeCalls, 'Planning keeps readonly own-profile metadata available without SDK requests.');
      let denied = false;
      try { await metadataTool.execute('planning-account-fixture', { ...request, providerRef: exactProvider }); }
      catch (error) {
        if (!(error instanceof AgentManagementError) || !['AGENT_WORKFLOW_INVALID', 'AGENT_WORKFLOW_BINDING_DENIED', 'AGENT_ACCESS_DENIED'].includes(error.code)) throw error;
        denied = true;
      }
      console.log(`Planning actual tool observation: metadataAvailable=true; explicitAccountDenied=${denied}; SDK delta=${provider.calls.length - beforeCalls}.`);
      assert(denied, 'A Planning-whitelisted metadata tool must not expose explicit account SDK discovery through a management view alias.');
      assert.equal(provider.calls.length, beforeCalls, 'Rejected Planning account discovery must issue zero SDK requests.');
      const explicitTool = normalTools.find(tool => tool.name === 'list_agent_workflow_personal_options'); assert(explicitTool);
      assert.equal(Check(explicitTool.parameters, { ...request, providerRef: exactProvider }), true, 'The existing normal-only tool explicitly accepts central account discovery.');
      const explicitOutput = await explicitTool.execute('normal-account-fixture', { ...request, providerRef: exactProvider });
      const explicitManagement = (explicitOutput.details as { management: AgentWorkflowManagementOptions }).management;
      safe(explicitManagement); assert.equal(explicitManagement.view, 'personal-connections');
      if (explicitManagement.view === 'personal-connections') assert(explicitManagement.alternatives.flatMap(value => value.providers).find(value => value.providerRef === exactProvider)?.accounts?.[1]?.selectable);
      assert(provider.calls.length > beforeCalls, 'Normal explicit account discovery must still perform the actual SDK metadata lookup.');
      assert.deepEqual(await raw.all('SELECT * FROM composio_workspace_profile_overrides ORDER BY workspace_id'), defaultsBefore);
      assert.deepEqual(await raw.all('SELECT id,is_default FROM composio_connection_profiles WHERE owner_user_id=$1 ORDER BY id', ['editor']), profileDefaultsBefore);
      console.log('PASS actual Planning metadata/schema SDK0, explicit account alias denied, normal-only existing tool SDK discovery and default preservation.');
      return;
    }
    const explicit = await management.listAgentWorkflowManagementOptions(editor, { view: 'personal-connections', ...requests(personalHeader), ...slot, providerRef: exactProvider }); safe(explicit);
    assert.equal(explicit.view, 'personal-connections'); if (explicit.view !== 'personal-connections') throw new Error('Expected explicit profile account options.');
    const selected = explicit.alternatives.flatMap(item => item.providers).find(item => item.providerRef === exactProvider); assert(selected?.accounts?.[1]?.selectable);
    assert(provider.calls.length > metadataBefore); assert(!provider.calls.some(item => item.path.includes('/tools/execute/')), 'All protocol traffic must remain metadata, never business execution.');
    const personalPkg = structuredClone(pkg), personalSelection = personalPkg.declarations[0].capabilities[0].selection;
    assert.equal(personalSelection.mode, 'fixed'); if (personalSelection.mode !== 'fixed') throw new Error('Expected fixed fixture slot.');
    personalSelection.target = { kind: 'personal', source: 'composio', ownerUserId: 'editor', providerRef: exactProvider, accountSelectionRef: selected.accounts[1].accountSelectionRef };
    await unchanged(() => configure(editor, { version: 1, packages: [personalPkg] }), 'AGENT_WORKFLOW_BINDING_DENIED');
    personalAgent = (await configure(editor, { version: 1, packages: [personalPkg] }, personalAgent.agentId)).agent;
    const privateBefore = await workflow.readManagedAgentWorkflow(editor, personalAgent.agentId), originalTarget = structuredClone(privateBefore.bindings[0].configuration!.declarations[0].capabilities[0].selection);
    if (originalTarget.mode !== 'fixed' || originalTarget.target.kind !== 'personal' || originalTarget.target.personalBinding?.source !== 'composio') throw new Error('Expected actual exact personal Composio binding.');
    assert.equal(originalTarget.target.personalBinding.connectedAccountId, 'PERSONAL_ACCOUNT_B', 'Central configuration must persist the explicitly selected second account.');
    const publicPersonal = await header(editor, personalAgent.agentId); safe(publicPersonal);
    assert.equal(publicPersonal.bindingSummaries?.[0]?.scopeLabel, 'personal');
    assert.equal(publicPersonal.bindingSummaries?.[0]?.label, 'Personal Composio connection');
    assert(!JSON.stringify(publicPersonal).includes(selectedProfile.id)); assert(!JSON.stringify(publicPersonal).includes('PERSONAL_ACCOUNT_B'));
    const retained = retention.createRetainedAgentWorkflowTarget(editor, privateBefore, slot); assert(retained);
    const retainedPkg = structuredClone(pkg), retainedSelection = retainedPkg.declarations[0].capabilities[0].selection;
    if (retainedSelection.mode !== 'fixed') throw new Error('Expected fixed retained fixture slot.'); retainedSelection.target = retained;
    const retainedSaved = await configure(editor, { version: 1, packages: [retainedPkg] }, personalAgent.agentId, { enabledTools: ['read', 'email_read_message', 'email_create_outbox_draft'] }); personalAgent = retainedSaved.agent;
    const retainedPrivate = await workflow.readManagedAgentWorkflow(editor, personalAgent.agentId);
    assert.deepEqual(retainedPrivate.bindings[0].configuration!.declarations[0].capabilities[0].selection, originalTarget, 'Unrelated tool saves preserve the original exact personal provider/account proof.');
    assert.deepEqual(await raw.all('SELECT * FROM composio_workspace_profile_overrides ORDER BY workspace_id'), defaultsBefore, 'Discovery/retention must preserve unrelated defaults.');
    assert.deepEqual(await raw.all('SELECT id,is_default FROM composio_connection_profiles WHERE owner_user_id=$1 ORDER BY id', ['editor']), profileDefaultsBefore);
    await unchanged(() => configure(editor, { version: 1, packages: [retainedPkg] }, personalAgent.agentId), 'AGENT_WORKFLOW_RETENTION_INVALID', personalAgent.agentId);
    const freshPrivate = await workflow.readManagedAgentWorkflow(editor, personalAgent.agentId), freshRef = retention.createRetainedAgentWorkflowTarget(editor, freshPrivate, slot); assert(freshRef);
    assert.throws(() => retention.resolveRetainedAgentWorkflowTarget(user, freshPrivate, slot, freshRef.retainedBindingRef), { code: 'AGENT_WORKFLOW_RETENTION_INVALID' });
    for (const wrongSlot of [{ ...slot, capabilityId: 'other' }, { ...slot, publishedRevisionRef: v2.published.revisionRef }, { ...slot, choiceId: 'invented' }, { ...slot, alternativeKey: 'composio:slack' }]) {
      assert.throws(() => retention.resolveRetainedAgentWorkflowTarget(editor, freshPrivate, wrongSlot, freshRef.retainedBindingRef), { code: 'AGENT_WORKFLOW_RETENTION_INVALID' });
    }
    const mixed = structuredClone(retainedPkg), mixedSelection = mixed.declarations[0].capabilities[0].selection;
    if (mixedSelection.mode !== 'fixed') throw new Error('Expected fixed fixture slot.');
    Object.assign(mixedSelection.target, { ownerUserId: 'editor', providerRef: exactProvider });
    assert.equal(schemas.updateAgentConfigurationSchema.safeParse({ agentId: personalAgent.agentId, expectedRevision: personalAgent.revision, expectedWorkflowRevision: personalAgent.workflowRevision,
      workflow: { version: 1, packages: [mixed] } }).success, false, 'Retained requests reject mixed personal identity fields.');
    const freshPkg = structuredClone(pkg), freshSelection = freshPkg.declarations[0].capabilities[0].selection;
    if (freshSelection.mode !== 'fixed') throw new Error('Expected fixed fixture slot.'); freshSelection.target = freshRef;
    assert.equal(schemas.updateAgentConfigurationSchema.safeParse({ agentId: personalAgent.agentId, expectedRevision: personalAgent.revision, expectedWorkflowRevision: personalAgent.workflowRevision,
      workflow: { version: 1, packages: [freshPkg] } }).success, true, 'The strict public contract must accept the exact retained-only shape.');
    provider.accounts.set(selectedProfile.composioUserId, [{ id: 'PERSONAL_ACCOUNT_A', toolkit: 'canva', status: 'ACTIVE' }]);
    await unchanged(() => configure(editor, { version: 1, packages: [freshPkg] }, personalAgent.agentId), undefined, personalAgent.agentId);
    provider.accounts.set(selectedProfile.composioUserId, [{ id: 'PERSONAL_ACCOUNT_A', toolkit: 'canva', status: 'ACTIVE' }, { id: 'PERSONAL_ACCOUNT_B', toolkit: 'canva', status: 'ACTIVE' }]);
    await raw.run('UPDATE composio_connection_profiles SET status=\'archived\' WHERE id=$1', [selectedProfile.id]);
    await unchanged(() => configure(editor, { version: 1, packages: [freshPkg] }, personalAgent.agentId), undefined, personalAgent.agentId);
    await raw.run('UPDATE composio_connection_profiles SET status=\'active\' WHERE id=$1', [selectedProfile.id]);
    let revokedDuringMetadata = false;
    provider.rotateOnEndpoint('/api/v3.1/connected_accounts', async () => {
      revokedDuringMetadata = true;
      await raw.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_user_id=$2', [ref, 'editor']);
    });
    try {
      await unchanged(() => configure(editor, { version: 1, packages: [freshPkg] }, personalAgent.agentId), undefined, personalAgent.agentId);
      assert(revokedDuringMetadata, 'The actual account SDK await must precede the fresh publication authority check.');
    } finally { await raw.run('UPDATE capability_resource_grants SET can_use=1 WHERE resource_ref=$1 AND target_user_id=$2', [ref, 'editor']); }
    assert(!provider.calls.some(item => item.path.includes('/tools/execute/')));
    console.log('PASS actual explicit profile/account metadata, strict retained DTO, unchanged exact personal binding, cross-actor/slot/pin/stale/account/provider rejection, defaults and native email preserved.');
    await emailPolicy();
    console.log(`PASS isolated ${native ? 'native PostgreSQL' : 'PGlite'}/FS workflow management matrix; local real Composio SDK protocol metadata only, no business calls or browser acceptance.`);
  } finally {
    loader._load = original; await raw.close(); await database.close(); await provider.close();
    if (nativeDatabaseName) console.log(`NATIVE_RECEIPT ${JSON.stringify({ phase: 'cleaned', databaseName: nativeDatabaseName })}`);
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    const unlock = async (directory: string): Promise<void> => { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(directory, 0o700); for (const name of await fs.readdir(directory)) await unlock(path.join(directory, name)); };
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
