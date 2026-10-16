import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createPackageStoreRegistryFixture } from './helpers/package-store-registry-fixture';
import type { CapabilityStoreOrigin } from '../app/lib/capabilities/packages/store-origin';
import type { CapabilityResourceActor, CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';

type SafeResource = {
  metadata: { resourceRef: string; legacyResourceId: string; ownership: { type: string } };
  artifact: { name: string; version: string; resourceType: string };
  storeState: { origin: 'verified' | 'derived' | 'unknown'; localChanges: 'unchanged' | 'modified' | 'unknown';
    upstream: 'current' | 'update-available' | 'conflict' | 'unknown'; source?: { registryId: string; entryKey: string; version: string } };
};
type SafeStore = { availability: 'available' | 'unavailable'; comparison: 'known' | 'partial' | 'unknown';
  installedResources: SafeResource[]; plugins?: Array<{ name: string; installed: { resources?: SafeResource[]; updateAvailable: boolean } }>;
  skills?: Array<{ name: string; installed: { resources?: SafeResource[]; updateAvailable: boolean } }> };

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within the fixture deadline.`)), 8_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function removeOwnedRoot(root: string): Promise<void> {
  assert(path.basename(root).startsWith('canvas-package-store-origin-'));
  const unlock = async (directory: string): Promise<void> => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await unlock(path.join(directory, entry.name));
  };
  await unlock(root); await fs.rm(root, { recursive: true, force: true });
}

/** New test-only entrypoint: real schema, real authority, real archive IO and real publication. */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-package-store-origin-'));
  const database = await createPiTestDatabase(), sql = await database.openDb();
  const registry = await createPackageStoreRegistryFixture(root), organizationId = 'origin-org';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), instanceId = `origin-${randomUUID()}`;
  const claims = { sub: instanceId, instanceId, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'managed', status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'origin-fixture-license', hostingMode: 'cloud', edition: 'team',
    licenseClass: 'commercial', licenseEnvironment: 'production', seatLimit: 10, nonBillable: false, entitlementsVersion: 1,
    deploymentMode: 'managed-team', databaseProvider: 'postgres', vectorProvider: 'pgvector', postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true }, features: { teamWorkspace: true, multiUser: true }, quotas: { users: 10 },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) }), JSON.stringify(claims)].map(value => Buffer.from(value).toString('base64url')).join('.');
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_origin_fixture',
    CANVAS_INSTANCE_ID: instanceId, CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', NODE_ENV: 'test',
    CANVAS_LICENSE_CERT: `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`,
    CANVAS_LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: fingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', AUTH_SECRET: randomBytes(32).toString('hex'),
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BASE_URL: 'http://localhost:3001', BETTER_AUTH_BASE_URL: 'http://localhost:3001',
    CANVAS_PLUGIN_STORE_REGISTRY_URL: registry.registryUrl('a'), CANVAS_SKILL_STORE_REGISTRY_URL: registry.registryUrl('a') };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, modules = new Map<string, unknown>();
  let authReady: Promise<void> | undefined, providerRequests = 0;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (modules.has(name)) return modules.get(name);
    return originalLoad(name, parent, isMain);
  };
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    for (const id of ['owner', 'alice', 'bob', 'unassigned']) {
      await sql.run('INSERT INTO "user"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES($1,$1,$2,$3,1,0,1,1)', [id, `${id}@origin.example.test`, id === 'owner' ? 'admin' : 'user']);
    }
    await sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES($1,'owner','team',1,1,1)", [organizationId]);
    for (const id of ['owner', 'alice', 'bob', 'unassigned']) {
      const role = id === 'owner' ? 'owner' : 'member';
      await sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES($1,$2,$3,'active',$4,1,1)", [organizationId, id, role, Number(id === 'owner')]);
      await sql.run("INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',$6,$6,$6,$6)", [`seat-${id}`, organizationId, `${id}@origin.example.test`, id, role, Date.now()]);
      await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,'personal',$3,$1,$3,'active',1,1)", [`personal-${id}`, organizationId, id]);
    }
    await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES('origin-team',$1,'team','origin-team','Origin team','active',1,1)", [organizationId]);
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry'), pluginStore = await import('../app/lib/plugins/canvas-plugin-store');
    const skillStore = await import('../app/lib/skills/canvas-skill-store'), resources = await import('../app/lib/capabilities/resources/actions');
    const packages = await import('../app/lib/capabilities/packages/actions'), artifacts = await import('../app/lib/capabilities/packages/artifacts');
    const origins = await import('../app/lib/capabilities/packages/store-origin');
    registry.setRegistryId('a', 'same-registry-id'); registry.setRegistryId('b', 'same-registry-id');
    const secretMarker = 'OWN_PRIVATE_PACKAGE_CONTENT';
    const files = (kind: 'plugin' | 'skill', name: string, version: string, content: string): Record<string, string | Buffer> => kind === 'plugin' ? {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version, description: 'Actual origin fixture', skills: 'skills' }),
      [`skills/${name}-context/SKILL.md`]: `---\nname: ${name}-context\ndescription: Origin fixture child\nmetadata:\n  version: ${version}\n---\n${content}\n`,
      'assets/pixel.bin': Buffer.from([0, 255, 31]), 'scripts/tool.js': `console.log('${content}');\n`,
    } : { 'SKILL.md': `---\nname: ${name}\ndescription: Origin fixture standalone\nmetadata:\n  version: ${version}\n---\n${content}\n`, 'scripts/tool.py': `print('${content}')\n` };
    const sourceA = await registry.addPackage('a', 'plugin', 'origin-design', '1.0.0', files('plugin', 'origin-design', '1.0.0', 'origin-A'), plugins.computeCanvasPluginChecksum);
    const sourceB = await registry.addPackage('b', 'plugin', 'origin-design', '1.0.0', files('plugin', 'origin-design', '1.0.0', 'origin-B'), plugins.computeCanvasPluginChecksum);
    await registry.addPackage('a', 'plugin', 'origin-team-package', '1.0.0', files('plugin', 'origin-team-package', '1.0.0', 'team'), plugins.computeCanvasPluginChecksum);
    await registry.addPackage('a', 'plugin', 'origin-hidden', '1.0.0', files('plugin', 'origin-hidden', '1.0.0', secretMarker), plugins.computeCanvasPluginChecksum);
    await registry.addPackage('a', 'skill', 'origin-standalone', '1.0.0', files('skill', 'origin-standalone', '1.0.0', 'skill-A'), plugins.computeCanvasPluginChecksum);
    await registry.addPackage('b', 'skill', 'origin-standalone', '1.0.0', files('skill', 'origin-standalone', '1.0.0', 'skill-B'), plugins.computeCanvasPluginChecksum);
    await registry.addPackage('a', 'plugin', 'origin-wire-plugin', '1.0.0', files('plugin', 'origin-wire-plugin', '1.0.0', 'HTTP and tool metadata'), plugins.computeCanvasPluginChecksum);
    await registry.addPackage('a', 'skill', 'origin-wire-skill', '1.0.0', files('skill', 'origin-wire-skill', '1.0.0', 'HTTP metadata'), plugins.computeCanvasPluginChecksum);
    const selectRegistry = (origin: string) => { process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = registry.registryUrl(origin); process.env.CANVAS_SKILL_STORE_REGISTRY_URL = registry.registryUrl(origin); };
    const organizationScope = { scopeType: 'organization' as const, organizationId }, userScope = (userId: string) => ({ scopeType: 'user' as const, userId });
    const owner: CapabilityResourceActor = { userId: 'owner', workspaceId: 'personal-owner' }, alice: CapabilityResourceActor = { userId: 'alice', workspaceId: 'personal-alice' };
    const grant = { targetType: 'user' as const, targetId: 'alice', canUse: true, canEdit: false, canManage: false };
    const descriptors = new Map<string, CapabilityResourceDescriptor>();
    const configure = async (key: string, actor: CapabilityResourceActor, resourceId: string, team = false, share = false) => {
      const descriptor = await resources.configureCapabilityResource(actor, resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
        ...(team ? { ownership: { type: 'team' as const, workspaceId: 'origin-team' } } : {}), accessMode: 'restricted', grants: share ? [grant] : [] });
      descriptors.set(key, descriptor); return descriptor;
    };
    const importedPlugin = async (origin: string, key: string, name: string, scope: typeof organizationScope | ReturnType<typeof userScope>, actor: CapabilityResourceActor, team = false, share = false) => {
      selectRegistry(origin); const result = await pluginStore.installCanvasPluginFromStore(name, '1.0.0', { scope, enable: false, replace: false });
      assert.ok(result.success && result.plugin?.resourceId, result.error || 'Actual plugin import failed.');
      const importedOrigin = result.plugin!.storeOrigin; assert.ok(importedOrigin); assert.equal(importedOrigin.resourceId, result.plugin!.resourceId);
      await configure(key, actor, result.plugin!.resourceId!, team, share); return result.plugin!;
    };
    const own = await importedPlugin('a', 'own', 'origin-design', userScope('alice'), alice);
    const organization = await importedPlugin('b', 'organization', 'origin-design', organizationScope, owner, false, true);
    await importedPlugin('a', 'team', 'origin-team-package', organizationScope, owner, true, true);
    await importedPlugin('a', 'hidden', 'origin-hidden', organizationScope, owner);
    for (const [origin, key, scope, actor, team] of [['a', 'skill-own', userScope('alice'), alice, false], ['b', 'skill-team', organizationScope, owner, true]] as const) {
      selectRegistry(origin); const result = await skillStore.installCanvasSkillFromStore('origin-standalone', '1.0.0', { scope, enable: false, replace: false });
      assert.ok(result.success && result.skill?.resourceId && result.skill.storeOrigin, result.error || 'Actual skill import failed.');
      await configure(key, actor, result.skill!.resourceId!, team, team);
    }
    const baselineOwn = structuredClone(own.storeOrigin!) as CapabilityStoreOrigin, baselineOrg = structuredClone(organization.storeOrigin!) as CapabilityStoreOrigin;
    assert.equal(baselineOwn.baselineChecksum, sourceA.checksum); assert.equal(baselineOrg.baselineChecksum, sourceB.checksum);
    assert.equal(baselineOwn.registryId, baselineOrg.registryId); assert.notEqual(baselineOwn.registryIdentity, baselineOrg.registryIdentity);
    assert.equal(origins.isIssuedCapabilityStoreOrigin(structuredClone(baselineOwn), own.resourceId!), false);
    const paths = await import('../app/lib/runtime-data-paths'), ownRegistryPath = paths.resolveScopedPluginRegistryPath(userScope('alice'));
    const beforeForgedImport = await fs.readFile(ownRegistryPath, 'utf8');
    const forgedImport = await plugins.installCanvasPluginFromPath(sourceA.directory, { scope: userScope('alice'), enable: false, replace: false, storeOrigin: structuredClone(baselineOwn) });
    assert.equal(forgedImport.success, false); assert.equal(await fs.readFile(ownRegistryPath, 'utf8'), beforeForgedImport, 'JSON proof forgery performs no registry mutation.');
    const legacy = await plugins.installCanvasPluginFromPath(sourceA.directory, { scope: userScope('bob'), enable: false, replace: false,
      sourceRegistryId: baselineOwn.registryId, sourceRegistryUrl: registry.registryUrl('a') });
    assert.ok(legacy.success && legacy.plugin?.resourceId); assert.equal(legacy.plugin!.storeOrigin, undefined);
    await configure('legacy', { userId: 'bob', workspaceId: 'personal-bob' }, legacy.plugin!.resourceId!, false, true);
    const auth = await import('../app/lib/auth'); authReady = auth.ensureAuthReady(); await authReady;
    const token = randomBytes(32).toString('hex');
    await sql.run('INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES($1,$2,$3,$4,$4,$5)', ['origin-session-owner', Date.now() + 3_600_000, token, Date.now(), 'owner']);
    const authenticatedHeaders = new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-canvas-workspace-id': 'personal-owner' });
    assert.equal((await auth.auth.api.getSession({ headers: authenticatedHeaders }))?.user.id, 'owner');
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).origin !== registry.baseUrl) { providerRequests += 1; throw new Error('This fixture permits only its own registry transport.'); }
      return originalFetch(input, init);
    };
    const assertNoOrigin = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) { assert.notEqual(key, 'storeOrigin', 'Private provenance is absent throughout public metadata.'); assertNoOrigin(item); }
    };
    const pluginInstallRoute = await import('../app/api/plugins/store/install/route'), skillInstallRoute = await import('../app/api/skills/store/install/route');
    const installRequest = (name: string, kind: 'plugin' | 'skill') => new Request(`http://localhost:3001/api/${kind === 'plugin' ? 'plugins' : 'skills'}/store/install`, {
      method: 'POST', headers: authenticatedHeaders, body: JSON.stringify({ name, version: '1.0.0', enable: false, replace: false, scope: 'user' }),
    });
    selectRegistry('a');
    for (const [name, kind, route] of [['origin-wire-plugin', 'plugin', pluginInstallRoute], ['origin-wire-skill', 'skill', skillInstallRoute]] as const) {
      const response = await route.POST(installRequest(name, kind)); assert.equal(response.status, 200);
      const payload = await response.json() as { success: boolean }; assert.equal(payload.success, true); assertNoOrigin(payload);
    }
    const wirePlugin = (await plugins.readCanvasPluginRegistry(userScope('owner'))).plugins['origin-wire-plugin'];
    const wireSkill = (await skillStore.readCanvasSkillRegistry(userScope('owner'))).skills['origin-wire-skill'];
    assert.ok(wirePlugin.storeOrigin); assert.ok(wireSkill.storeOrigin, 'HTTP serialization does not mutate either internal import proof.');
    const duplicateResponse = await pluginInstallRoute.POST(installRequest('origin-wire-plugin', 'plugin'));
    const duplicatePayload = await duplicateResponse.json() as { success: boolean }; assert.equal(duplicatePayload.success, false); assertNoOrigin(duplicatePayload);
    const wireDescriptor = await configure('wire', owner, wirePlugin.resourceId!);
    const agents = await import('../app/lib/agents/registry'), { piSessions } = await import('../app/lib/db/schema');
    await agents.createAgentProfile({ agentId: 'origin-wire-agent', name: 'Origin metadata specialist', scopeType: 'user', ownerUserId: 'owner',
      organizationId, createdByUserId: 'owner', enabledTools: ['inspect_canvas_package', 'create_canvas_package_draft', 'write_canvas_package_draft_file', 'publish_canvas_package_draft'] });
    await database.db.insert(piSessions).values({ sessionId: 'origin-wire-session', userId: 'owner', agentId: 'origin-wire-agent', workspaceId: 'personal-owner',
      workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const { createCapabilityPackageTools } = await import('../app/lib/pi/scoped-tools');
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const packageTools = createCapabilityPackageTools('owner', 'origin-wire-agent', 'origin-wire-session');
    const toolCall = async <T,>(name: string, params: unknown): Promise<T> => {
      const tool = packageTools.find(value => value.name === name); assert.ok(tool);
      const context = await resolveAgentExecutionContextForStoredSession({ userId: 'owner', agentId: 'origin-wire-agent', sessionId: 'origin-wire-session' });
      const result = await runWithAgentExecutionContext(context, () => tool.execute(`wire-${name}`, params));
      const details = result.details as { error?: string; capabilityPackage?: { result: T } };
      assert.equal(details.error, undefined, details.error || 'The actual package tool operation must succeed.'); assert.ok(details.capabilityPackage);
      assertNoOrigin(result.details);
      for (const content of result.content) if (content.type === 'text') assertNoOrigin(JSON.parse(content.text));
      return details.capabilityPackage.result;
    };
    const wireInspection = await toolCall<Awaited<ReturnType<typeof packages.inspectCapabilityPackage>>>('inspect_canvas_package', { resourceRef: wireDescriptor.metadata.resourceRef });
    const wireDraft = await toolCall<Awaited<ReturnType<typeof packages.createCapabilityPackageDraftAction>>>('create_canvas_package_draft', { operation: 'edit',
      resourceRef: wireDescriptor.metadata.resourceRef, expectedMetadataRevision: wireInspection.resource.metadataRevision,
      expectedGrantsRevision: wireInspection.resource.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const wireWrite = await toolCall<Awaited<ReturnType<typeof packages.writeCapabilityPackageDraftFileAction>>>('write_canvas_package_draft_file', {
      draftRef: wireDraft.draftRef, expectedDraftRevision: wireDraft.draftRevision, path: 'scripts/tool.js', encoding: 'base64', content: Buffer.from('console.log("wire-publication");\n').toString('base64') });
    const wirePublish = await toolCall<Awaited<ReturnType<typeof packages.publishCapabilityPackageDraftAction>>>('publish_canvas_package_draft', {
      draftRef: wireDraft.draftRef, expectedDraftRevision: wireWrite.draft.draftRevision, expectedMetadataRevision: wireInspection.resource.metadataRevision,
      expectedGrantsRevision: wireInspection.resource.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    assert.ok(wirePublish.published.revisionRef);
    const wireInternal = await packages.inspectCapabilityPackage(owner, wireDescriptor.metadata.resourceRef);
    assert.deepEqual(wireInternal.state!.currentSourceStamp.storeOrigin, wirePlugin.storeOrigin);
    const packageGet = await import('../app/api/capabilities/packages/[resourceRef]/route');
    const wireGet = await packageGet.GET(new Request(`http://localhost:3001/api/capabilities/packages/${wireDescriptor.metadata.resourceRef}`, { headers: authenticatedHeaders }),
      { params: Promise.resolve({ resourceRef: wireDescriptor.metadata.resourceRef }) });
    assert.equal(wireGet.status, 200); assertNoOrigin(await wireGet.json());
    assert.ok((await plugins.readCanvasPluginRegistry(userScope('owner'))).plugins['origin-wire-plugin'].storeOrigin);
    const listPlugins = async (): Promise<SafeStore> => await pluginStore.listCanvasPluginStore({ actor: alice, scope: userScope('alice'), pageSize: 50 }) as unknown as SafeStore;
    const listSkills = async (): Promise<SafeStore> => await skillStore.listCanvasSkillStore({ actor: alice, scope: userScope('alice'), pageSize: 50 }) as unknown as SafeStore;
    const item = (state: SafeStore, key: string) => { const resource = state.installedResources.find(value => value.metadata.resourceRef === descriptors.get(key)!.metadata.resourceRef); assert.ok(resource, `Exact installed instance ${key}`); return resource; };
    const safe = (state: SafeStore) => {
      assert(!JSON.stringify(state).includes(root)); assert(!JSON.stringify(state).includes(secretMarker));
      const privateState = JSON.stringify(state.installedResources);
      for (const key of ['registryIdentity', 'baselineChecksum', 'upstreamChecksum', 'sourceRegistryUrl', 'sourcePath', 'installDir', 'runtimePath', 'fixture-config', 'fixture-download']) assert(!privateState.includes(key), `Private origin field ${key} must not be public.`);
      assert(!state.installedResources.some(value => value.metadata.resourceRef === descriptors.get('hidden')!.metadata.resourceRef));
    };
    selectRegistry('a'); registry.resetCounts();
    const knownA = await listPlugins(); safe(knownA);
    assert.equal(item(knownA, 'own').storeState.origin, 'verified'); assert.equal(item(knownA, 'own').storeState.localChanges, 'unchanged'); assert.equal(item(knownA, 'own').storeState.upstream, 'current');
    assert.equal(item(knownA, 'organization').storeState.upstream, 'unknown'); assert.equal(item(knownA, 'legacy').storeState.origin, 'unknown');
    const exactOffering = knownA.plugins!.find(value => value.name === 'origin-design')!;
    assert.deepEqual(exactOffering.installed.resources!.map(value => value.metadata.resourceRef), [descriptors.get('own')!.metadata.resourceRef], 'Same-name, same-registry-id origins and legacy instances never become the active offering by name.');
    assert.equal(item(knownA, 'team').metadata.ownership.type, 'team');
    const skillA = await listSkills(); safe(skillA);
    const child = skillA.installedResources.find(value => value.artifact.name === 'origin-team-package-context');
    assert.ok(child); assert.equal(child.storeState.origin, 'derived'); assert.equal(child.storeState.localChanges, 'unknown');
    const childPackage = await packages.inspectCapabilityPackage(alice, child.metadata.resourceRef);
    assert.equal(childPackage.sourceStamp.storeOrigin!.componentPath, 'skills/origin-team-package-context');
    assert.equal(childPackage.sourceStamp.storeOrigin!.baselineChecksum, null); assert.equal(childPackage.sourceStamp.storeOrigin!.kind, 'plugin');
    assert.equal(item(skillA, 'skill-own').storeState.upstream, 'current'); assert.equal(item(skillA, 'skill-team').storeState.upstream, 'unknown');
    assert.deepEqual(skillA.skills!.find(value => value.name === 'origin-standalone')!.installed.resources!.map(value => value.metadata.resourceRef), [descriptors.get('skill-own')!.metadata.resourceRef]);
    const initialLegacyPointer = (await plugins.readCanvasPluginRegistry(userScope('bob'))).plugins['origin-design'];
    await listPlugins(); assert.deepEqual((await plugins.readCanvasPluginRegistry(userScope('bob'))).plugins['origin-design'], initialLegacyPointer, 'GET comparison never adopts legacy provenance.');
    const editPublish = async (resourceRef: string, version: string) => {
      const inspected = await packages.inspectCapabilityPackage(owner, resourceRef);
      const draft = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef,
        expectedMetadataRevision: inspected.resource.metadataRevision, expectedGrantsRevision: inspected.resource.grantsRevision,
        expectedPackageRevision: inspected.state?.packageRevision || 0, expectedPublishedRevisionRef: inspected.state?.currentPublishedRevisionRef || null });
      const changed = await packages.writeCapabilityPackageDraftFileAction(owner, draft.draftRef, { expectedDraftRevision: draft.draftRevision,
        path: '.canvas-plugin/plugin.json', encoding: 'base64', content: Buffer.from(JSON.stringify({ name: 'origin-design', version, description: 'Local complete publication', skills: 'skills' })).toString('base64') });
      return packages.publishCapabilityPackageDraftAction(owner, { draftRef: draft.draftRef, expectedDraftRevision: changed.draft.draftRevision,
        expectedMetadataRevision: inspected.resource.metadataRevision, expectedGrantsRevision: inspected.resource.grantsRevision,
        expectedPackageRevision: inspected.state?.packageRevision || 0, expectedPublishedRevisionRef: inspected.state?.currentPublishedRevisionRef || null });
    };
    const organizationRef = descriptors.get('organization')!.metadata.resourceRef;
    const local99 = await editPublish(organizationRef, '99.0.0');
    assert.deepEqual(local99.state.currentSourceStamp.storeOrigin, baselineOrg); assert.notEqual(local99.published.checksum, baselineOrg.baselineChecksum);
    const local100 = await editPublish(organizationRef, '100.0.0');
    assert.deepEqual(local100.state.currentSourceStamp.storeOrigin, baselineOrg);
    assert(local100.published.sourceStamp, 'An edit publication retains its source provenance.');
    assert.equal(local100.published.sourceStamp.storeOrigin?.version, '1.0.0');
    await registry.addPackage('b', 'plugin', 'origin-design', '2.0.0', files('plugin', 'origin-design', '2.0.0', 'upstream-v2'), plugins.computeCanvasPluginChecksum);
    selectRegistry('b'); registry.resetCounts();
    const updated = await listPlugins(); safe(updated);
    assert.equal(item(updated, 'organization').artifact.version, '100.0.0');
    assert.deepEqual(item(updated, 'organization').storeState, { origin: 'verified', localChanges: 'modified', upstream: 'update-available', source: { registryId: baselineOrg.registryId, entryKey: 'origin-design', version: '1.0.0' } });
    assert.equal(updated.plugins!.find(value => value.name === 'origin-design')!.installed.updateAvailable, true);
    assert.equal(registry.count('archive'), 0, 'Comparison reads registry metadata without downloading or replacing a package.');
    const forkSource = await packages.inspectCapabilityPackage(alice, organizationRef);
    const fork = await packages.createCapabilityPackageDraftAction(alice, { operation: 'fork', resourceRef: organizationRef, targetName: 'origin-copy', ownership: { type: 'user' },
      expectedSourceMetadataRevision: forkSource.resource.metadataRevision, expectedSourceGrantsRevision: forkSource.resource.grantsRevision,
      expectedSourcePackageRevision: forkSource.state!.packageRevision, expectedSourcePublishedRevisionRef: forkSource.state!.currentPublishedRevisionRef });
    const renamed = await packages.writeCapabilityPackageDraftFileAction(alice, fork.draftRef, { expectedDraftRevision: fork.draftRevision, path: '.canvas-plugin/plugin.json', encoding: 'base64',
      content: Buffer.from(JSON.stringify({ name: 'origin-copy', version: '100.0.0', description: 'Explicit derived variant', skills: 'skills' })).toString('base64') });
    const publishedFork = await packages.publishCapabilityPackageDraftAction(alice, { draftRef: fork.draftRef, expectedDraftRevision: renamed.draft.draftRevision,
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const forkOrigin = publishedFork.state.currentSourceStamp.storeOrigin!;
    assert.equal(forkOrigin.relation, 'derived'); assert.notEqual(forkOrigin.resourceId, baselineOrg.resourceId); assert.equal(forkOrigin.baselineChecksum, baselineOrg.baselineChecksum);
    descriptors.set('fork', await resources.inspectCapabilityResource(alice, publishedFork.state.resourceRef));
    const forkState = await listPlugins();
    assert.equal(item(forkState, 'fork').storeState.origin, 'derived'); assert.equal(item(forkState, 'fork').storeState.localChanges, 'modified');
    assert.equal(item(forkState, 'fork').storeState.upstream, 'unknown', 'A derived variant has no direct Store update/replace entitlement.');
    const currentInspect = await packages.inspectCapabilityPackage(owner, organizationRef), draftRoute = await import('../app/api/capabilities/packages/drafts/route');
    const forgedBody = { operation: 'edit', resourceRef: organizationRef, expectedMetadataRevision: currentInspect.resource.metadataRevision, expectedGrantsRevision: currentInspect.resource.grantsRevision,
      expectedPackageRevision: currentInspect.state!.packageRevision, expectedPublishedRevisionRef: currentInspect.state!.currentPublishedRevisionRef, storeOrigin: baselineOwn };
    const forgedResponse = await draftRoute.POST(new Request('http://localhost:3001/api/capabilities/packages/drafts', { method: 'POST', headers: authenticatedHeaders, body: JSON.stringify(forgedBody) }), { params: Promise.resolve({}) });
    assert.equal(forgedResponse.status, 400, 'Real authenticated public bodies cannot override private origin.');
    const orgRegistryPath = paths.resolveScopedPluginRegistryPath(organizationScope), originalRegistry = await fs.readFile(orgRegistryPath, 'utf8');
    const tampered = JSON.parse(originalRegistry) as Awaited<ReturnType<typeof plugins.readCanvasPluginRegistry>>;
    tampered.plugins['origin-design'].storeOrigin = { ...baselineOrg, baselineChecksum: '0'.repeat(64) };
    await fs.writeFile(orgRegistryPath, JSON.stringify(tampered));
    try {
      await assert.rejects(() => artifacts.assertCapabilityPackageRegistryPointerCurrent('plugin', tampered.plugins['origin-design'], organizationScope), { code: 'PACKAGE_SNAPSHOT_UNAVAILABLE' });
      await assert.rejects(() => packages.inspectCapabilityPackage(owner, organizationRef));
    } finally { await fs.writeFile(orgRegistryPath, originalRegistry); }
    registry.setLatest('b', 'plugin', 'origin-design', '1.0.0'); registry.setDigest('b', 'plugin', 'origin-design', '1.0.0', 'f'.repeat(64));
    const conflicted = await listPlugins(); assert.equal(item(conflicted, 'organization').storeState.upstream, 'conflict');
    assert.equal(conflicted.plugins!.find(value => value.name === 'origin-design')!.installed.updateAvailable, false);
    registry.setDigest('b', 'plugin', 'origin-design', '1.0.0', baselineOrg.upstreamChecksum); registry.setLatest('b', 'plugin', 'origin-design', '2.0.0');
    const sourceUrl = process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL!;
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = sourceUrl.replace('fixture-config=b', 'fixture-config=other');
    const changedConfig = await listPlugins(); assert.equal(item(changedConfig, 'organization').storeState.upstream, 'unknown');
    assert.equal(changedConfig.plugins!.find(value => value.name === 'origin-design')!.installed.resources!.length, 0, 'The complete source URL identity is bound even if registry id, path and names match.');
    selectRegistry('b'); registry.setStatus('b', 503);
    const outage = await listPlugins(); safe(outage); assert.equal(outage.availability, 'unavailable'); assert.equal(item(outage, 'organization').storeState.upstream, 'unknown');
    const skillOutage = await listSkills(); safe(skillOutage); assert.equal(skillOutage.availability, 'unavailable'); assert.equal(item(skillOutage, 'skill-team').storeState.upstream, 'unknown');
    registry.setStatus('b', 200);
    const barrier = registry.holdNextRegistry('b'), delayed = listPlugins();
    await bounded(barrier.requested, 'Registry comparison barrier');
    const beforeRevoke = await resources.inspectCapabilityResource(owner, organizationRef);
    await bounded(resources.updateCapabilityResource(owner, organizationRef, { expectedMetadataRevision: beforeRevoke.metadata.metadataRevision,
      expectedGrantsRevision: beforeRevoke.metadata.grantsRevision, grants: [] }), 'Actual grant revoke while the transport is delayed');
    barrier.release(); const revoked = await bounded(delayed, 'Revoked comparison'); safe(revoked);
    assert(!revoked.installedResources.some(value => value.metadata.resourceRef === organizationRef));
    assert(!revoked.plugins!.some(value => value.installed.resources?.some(resource => resource.metadata.resourceRef === organizationRef)));
    const lastHead = await packages.inspectCapabilityPackage(owner, organizationRef);
    assert.equal(lastHead.state!.currentPublishedRevisionRef, local100.published.revisionRef, 'Comparison, outages and revocation never replace the committed package head.');
    assert.equal(providerRequests, 0);
    console.log('PASS actual PGlite/Better Auth + HTTP Store import/publication: stable baselines, exact origins and scopes, child/fork lineage, forged proof denial, unknown legacy, update/conflict/outage and delayed current-rights revoke.');
  } finally {
    globalThis.fetch = originalFetch; await registry.close(); await authReady; loader._load = originalLoad;
    await sql.close(); await database.close(); await removeOwnedRoot(root);
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

main().catch(error => { console.error(error instanceof Error ? error.stack : 'Store provenance fixture failed.'); process.exitCode = 1; });
