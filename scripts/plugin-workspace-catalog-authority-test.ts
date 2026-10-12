import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { PluginWorkspaceCatalogResponse } from '../app/lib/plugins/plugin-workspace-catalog-contracts';

// New test only: actual PostgreSQL engine/schema, Better Auth, registry IO and resource authority.
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-catalog-authority-'));
  const database = await createPiTestDatabase(), sql = await database.openDb();
  const organizationId = 'catalog-org', registryPath = path.join(root, 'store-registry.json');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const instanceId = `catalog-${randomUUID()}`;
  const claims = { sub: instanceId, instanceId, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'managed', status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'catalog-fixture-license', hostingMode: 'cloud', edition: 'team',
    licenseClass: 'commercial', licenseEnvironment: 'production', seatLimit: 20, nonBillable: false, entitlementsVersion: 1,
    deploymentMode: 'managed-team', databaseProvider: 'postgres', vectorProvider: 'pgvector', postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true }, features: { teamWorkspace: true, multiUser: true }, quotas: { users: 20 },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) }), JSON.stringify(claims)]
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_catalog_fixture',
    CANVAS_INSTANCE_ID: instanceId, CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '',
    CANVAS_LICENSE_CERT: `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`,
    CANVAS_LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: fingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', AUTH_SECRET: randomBytes(32).toString('hex'),
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BASE_URL: 'http://localhost:3001', BETTER_AUTH_BASE_URL: 'http://localhost:3001', NODE_ENV: 'test',
    CANVAS_PLUGIN_STORE_REGISTRY_URL: pathToFileURL(registryPath).href };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const modules = new Map<string, unknown>();
  let observe = false, remoteRequests = 0, legacyProbes = 0, observedChecksumCalls = 0;
  let authReady: Promise<void> | undefined;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (modules.has(name)) return modules.get(name);
    const exported = originalLoad(name, parent, isMain) as Record<string, unknown>;
    if (/canvas-plugin-registry(?:\.ts)?$/u.test(name) && typeof exported.computeCanvasPluginChecksum === 'function') {
      const compute = exported.computeCanvasPluginChecksum as (...args: unknown[]) => Promise<string>;
      return { ...exported, computeCanvasPluginChecksum: (...args: unknown[]) => {
        if (observe) observedChecksumCalls += 1;
        if (observe && /addPageStateDetails|computeInstalledSkillModified|enrichStoreSkillsWithInstalledState/u.test(new Error().stack || '')) legacyProbes += 1;
        return compute(...args);
      } };
    }
    return exported;
  };
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    const users = ['owner', 'alice', 'bob', 'administrator', 'manager', 'reader', 'inactive', 'banned', 'outsider'];
    for (const id of users) {
      await sql.run('INSERT INTO "user"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES($1,$1,$2,$3,1,0,1,1)',
        [id, `${id}@catalog.example.test`, id === 'owner' || id === 'administrator' ? 'admin' : 'user']);
    }
    await sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES($1,'owner','team',1,1,1)", [organizationId]);
    await sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('other-org','outsider','team',1,2,2)");
    for (const id of users) {
      const role = id === 'owner' ? 'owner' : id === 'administrator' ? 'admin' : 'member';
      const status = id === 'outsider' ? 'suspended' : 'active';
      await sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES($1,$2,$3,$4,$5,1,1)",
        [organizationId, id, role, status, Number(id === 'owner' || id === 'administrator' || id === 'manager')]);
      await sql.run("INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',$6,$6,$6,$6)",
        [`seat-${id}`, organizationId, `${id}@catalog.example.test`, id, role, Date.now()]);
      await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,'personal',$3,$4,$3,'active',1,1)",
        [`personal-${id}`, organizationId, id, `workspaces/${id}/files`]);
    }
    await sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES('other-org','outsider','owner','active',1,1,1)");
    for (const [id, org, status] of [['catalog-team', organizationId, 'active'], ['disabled-team', organizationId, 'disabled'], ['foreign-team', 'other-org', 'active']] as const) {
      await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,'team',$1,$1,$3,1,1)", [id, org, status]);
    }
    for (const [id, manage] of [['manager', 1], ['reader', 0]] as const) {
      await sql.run("INSERT INTO canvas_workspace_members(organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES($1,'catalog-team',$2,'member','active',1,0,$3,1,1)", [organizationId, id, manage]);
    }
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const store = await import('../app/lib/skills/canvas-skill-store');
    type Offering = { name: string; displayName: string; description: string; latestVersion: string;
      versions: Record<string, { version: string; downloadUrl: string; checksum: string }> };
    const pluginOfferings = new Map<string, Offering>(), skillOfferings = new Map<string, Offering>();
    const sourceBytesMarker = 'CATALOG_PRIVATE_PACKAGE_BYTES';
    const packageSource = async (kind: 'plugin' | 'skill', name: string, version: string) => {
      const directory = path.join(root, 'sources', kind, name, version), files = new Map<string, string>();
      if (kind === 'plugin') {
        files.set('.canvas-plugin/plugin.json', JSON.stringify({ name, version, description: 'Catalog fixture package', skills: 'skills', connectors: { composioToolkits: ['canva'] } }));
        files.set(`skills/${name}-context/SKILL.md`, `---\nname: ${name}-context\ndescription: Catalog context\nmetadata:\n  version: ${version}\n---\n\n${sourceBytesMarker}\n`);
      } else files.set('SKILL.md', `---\nname: ${name}\ndescription: Catalog standalone skill\nmetadata:\n  version: ${version}\n---\n\n${sourceBytesMarker}\n`);
      files.set('scripts/helper.js', `console.log('${sourceBytesMarker}');\n`);
      const archive = new JSZip();
      for (const [relative, content] of files) { await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await fs.writeFile(path.join(directory, relative), content); archive.file(relative, content); }
      const archivePath = path.join(root, `${kind}-${name}-${version}.zip`);
      await fs.writeFile(archivePath, await archive.generateAsync({ type: 'nodebuffer' }));
      const offerings = kind === 'plugin' ? pluginOfferings : skillOfferings;
      const offering = offerings.get(name) || { name, displayName: name, description: 'Public registry description', latestVersion: version, versions: {} };
      offering.versions[version] = { version, downloadUrl: pathToFileURL(archivePath).href, checksum: await plugins.computeCanvasPluginChecksum(directory) };
      offering.latestVersion = version; offerings.set(name, offering);
      return directory;
    };
    const pluginNames = ['catalog-design', 'organization-only', 'team-design', 'personal-private', 'hidden-org', 'foreign-org'];
    for (const name of pluginNames) for (const version of name === 'catalog-design' ? ['1.0.0', '2.0.0', '3.0.0'] : ['1.0.0']) await packageSource('plugin', name, version);
    const skillNames = ['catalog-design', 'hidden-skill', 'private-skill', 'single-skill'];
    for (const name of skillNames) for (const version of name === 'catalog-design' ? ['1.0.0', '2.0.0', '3.0.0'] : ['1.0.0']) await packageSource('skill', name, version);
    await fs.writeFile(registryPath, JSON.stringify({ schemaVersion: 1, id: 'catalog-store-fixture', name: 'Catalog store', updatedAt: '2026-10-07T00:00:00Z',
      plugins: [...pluginOfferings.values()], skills: [...skillOfferings.values()] }));
    const pluginStore = await import('../app/lib/plugins/canvas-plugin-store');
    const orgScope = { scopeType: 'organization' as const, organizationId };
    const ownScope = (userId: string) => ({ scopeType: 'user' as const, userId });
    const installedPlugins = new Map<string, NonNullable<Awaited<ReturnType<typeof pluginStore.installCanvasPluginFromStore>>['plugin']>>();
    for (const [key, name, version, scope] of [
      ['own', 'catalog-design', '1.0.0', ownScope('alice')], ['org', 'catalog-design', '2.0.0', orgScope], ['shared', 'catalog-design', '3.0.0', ownScope('bob')],
      ['organization', 'organization-only', '1.0.0', orgScope], ['team', 'team-design', '1.0.0', orgScope],
      ['private', 'personal-private', '1.0.0', ownScope('bob')], ['hidden', 'hidden-org', '1.0.0', orgScope],
      ['foreign', 'foreign-org', '1.0.0', { scopeType: 'organization' as const, organizationId: 'other-org' }],
    ] as const) {
      const result = await pluginStore.installCanvasPluginFromStore(name, version, { scope, enable: false, replace: false });
      assert.ok(result.success && result.plugin?.resourceId, result.error || 'Actual plugin fixture installation failed.'); installedPlugins.set(key, result.plugin!);
    }
    const installedSkills = new Map<string, NonNullable<Awaited<ReturnType<typeof store.installCanvasSkillFromStore>>['skill']>>();
    for (const [key, name, version, scope] of [
      ['own', 'catalog-design', '1.0.0', ownScope('alice')], ['team', 'catalog-design', '2.0.0', orgScope], ['shared', 'catalog-design', '3.0.0', ownScope('bob')],
      ['hidden', 'hidden-skill', '1.0.0', orgScope], ['private', 'private-skill', '1.0.0', ownScope('bob')], ['single', 'single-skill', '1.0.0', ownScope('alice')],
    ] as const) {
      const result = await store.installCanvasSkillFromStore(name, version, { scope, enable: false, replace: false });
      assert.ok(result.success && result.skill?.resourceId, result.error || 'Actual skill fixture installation failed.'); installedSkills.set(key, result.skill!);
    }
    // Represent pre-provenance legacy installations: real validated bytes/identity,
    // with no optional import receipt. ACL and current activation stay unchanged.
    const { resolveScopedSkillRegistryPath } = await import('../app/lib/runtime-data-paths');
    for (const scope of [ownScope('alice'), orgScope, ownScope('bob')]) {
      const file = resolveScopedSkillRegistryPath(scope);
      const document = JSON.parse(await fs.readFile(file, 'utf8')) as Awaited<ReturnType<typeof store.readCanvasSkillRegistry>>;
      delete document.skills['catalog-design'].storeOrigin;
      await fs.writeFile(file, JSON.stringify(document));
    }
    const actions = await import('../app/lib/capabilities/resources/actions');
    const owner = { userId: 'owner', workspaceId: 'personal-owner' }, alice = { userId: 'alice', workspaceId: 'personal-alice' };
    const grant = (targetId: string) => ({ targetType: 'user' as const, targetId, canUse: true, canEdit: false, canManage: false });
    const descriptors = new Map<string, CapabilityResourceDescriptor>();
    for (const [key, record] of installedPlugins) {
      if (key === 'foreign') continue;
      const actor = key === 'own' ? alice : key === 'shared' || key === 'private' ? { userId: 'bob', workspaceId: 'personal-bob' }
        : key === 'team' ? { userId: 'manager', workspaceId: 'personal-manager' } : owner;
      const configured = await actions.configureCapabilityResource(actor, record.resourceId!, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
        ...(key === 'team' ? { ownership: { type: 'team' as const, workspaceId: 'catalog-team' } } : {}),
        accessMode: 'restricted', grants: ['org', 'organization', 'team', 'shared'].includes(key) ? [grant('alice')] : [] });
      descriptors.set(`plugin-${key}`, configured);
    }
    for (const [key, record] of installedSkills) {
      const actor = key === 'own' || key === 'single' ? alice : key === 'shared' || key === 'private' ? { userId: 'bob', workspaceId: 'personal-bob' }
        : key === 'team' ? { userId: 'manager', workspaceId: 'personal-manager' } : owner;
      const configured = await actions.configureCapabilityResource(actor, record.resourceId!, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
        ...(key === 'team' ? { ownership: { type: 'team' as const, workspaceId: 'catalog-team' } } : {}),
        accessMode: 'restricted', grants: key === 'team' || key === 'shared' ? [grant('alice')] : [] });
      descriptors.set(`skill-${key}`, configured);
    }
    const { writeEnabledSkillsForScope } = await import('../app/lib/skills/skill-settings');
    await writeEnabledSkillsForScope(['single-skill'], { scope: ownScope('alice'), updatedBy: 'alice' });
    await writeEnabledSkillsForScope(['catalog-design'], { scope: orgScope, updatedBy: 'owner' });
    const { setPersonalCapabilityActivation } = await import('../app/lib/capabilities/activation-actions');
    await setPersonalCapabilityActivation({ actorUserId: 'alice', context: { userId: 'alice', organizationId, role: 'member', workspaceId: 'personal-alice' },
      resourceId: installedSkills.get('team')!.resourceId!, enabled: true, expectedRevision: 0 });
    const auth = await import('../app/lib/auth'); authReady = auth.ensureAuthReady(); await authReady;
    const tokens = new Map<string, string>();
    for (const id of users) {
      const token = randomBytes(32).toString('hex'); tokens.set(id, token);
      await sql.run('INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES($1,$2,$3,$4,$4,$5)',
        [`session-${id}`, Date.now() + 3600_000, token, Date.now(), id]);
    }
    const headers = (userId: string, workspaceId?: string) => new Headers({ authorization: `Bearer ${tokens.get(userId)}`,
      ...(workspaceId ? { 'x-canvas-workspace-id': workspaceId } : {}) });
    assert.equal((await auth.auth.api.getSession({ headers: headers('alice') }))?.user.id, 'alice', 'Actual Better Auth consumes the stored token and seat authority.');
    observe = true;
    globalThis.fetch = async () => { remoteRequests += 1; throw new Error('Catalog fixture forbids remote/provider requests.'); };
    const catalog = await import('../app/lib/plugins/plugin-workspace-catalog');
    const route = await import('../app/api/plugins/catalog/route');
    const query = (value = '') => catalog.parsePluginWorkspaceCatalogQuery(new URLSearchParams(value));
    const read = (actor: typeof alice, selection = '') => catalog.listPluginWorkspaceCatalog(actor, query(selection));
    const own = await read(alice, 'scope=user&kind=plugin');
    assert.deepEqual(own.items.map(item => item.resourceRef), [descriptors.get('plugin-own')!.metadata.resourceRef]);
    assert.equal(own.items[0].activation?.enabled, false, 'Management listing keeps the shadowed own instance without activating it.');
    assert.equal(own.items[0].activation?.readiness, 'conflict');
    const shared = await read(alice, 'scope=user&audience=shared');
    for (const key of ['plugin-org', 'plugin-organization', 'plugin-team', 'plugin-shared', 'skill-team', 'skill-shared']) assert(shared.items.some(item => item.resourceRef === descriptors.get(key)!.metadata.resourceRef), `Readable exact instance ${key}`);
    assert(!shared.items.some(item => item.ownership.type === 'system' || item.ownership.type === 'user' && item.ownership.ownerUserId === 'alice'));
    for (const key of ['plugin-private', 'plugin-hidden', 'skill-private', 'skill-hidden']) assert(!shared.items.some(item => item.resourceRef === descriptors.get(key)!.metadata.resourceRef));
    assert.equal(shared.items.find(item => item.resourceRef === descriptors.get('plugin-team')!.metadata.resourceRef)!.ownership.type, 'team');
    const organization = await read(alice, 'scope=organization&kind=plugin');
    assert.deepEqual(new Set(organization.items.map(item => item.resourceRef)), new Set(['plugin-org', 'plugin-organization'].map(key => descriptors.get(key)!.metadata.resourceRef)));
    assert.equal(shared.scopes.teams.length, 0, 'A resource user grant does not disclose the owner team directory.');
    await assert.rejects(() => read(alice, 'scope=team&teamId=catalog-team'), { status: 404 });
    const team = await read({ userId: 'manager', workspaceId: 'personal-manager' }, 'scope=team&teamId=catalog-team');
    assert(team.items.some(item => item.resourceRef === descriptors.get('plugin-team')!.metadata.resourceRef));
    assert.equal(descriptors.get('plugin-team')!.metadata.createdByUserId, 'manager');
    assert(team.items.every(item => item.ownership.type === 'team' && item.ownership.workspaceId === 'catalog-team'));
    assert.equal(team.scopes.teams[0]?.teamId, 'catalog-team');
    assert(!JSON.stringify(team.scopes).includes('canCreate'), 'Browse choices do not issue creation authority.');
    const choose = await read({ userId: 'reader', workspaceId: 'personal-reader' }, 'scope=team');
    assert.deepEqual(choose.items, []); assert.equal(choose.selection.selectionRequired, 'team');
    const packageActions = await import('../app/lib/capabilities/packages/actions');
    const creationScopes = await packageActions.listCapabilityPackageCreationScopes({ userId: 'reader', workspaceId: 'personal-reader' });
    assert(!creationScopes.some(scope => scope.type === 'team' && scope.workspaceId === 'catalog-team'), 'Read-only team browsing grants no package creation target.');
    for (const teamId of ['missing-team', 'disabled-team', 'foreign-team']) await assert.rejects(() => read(alice, `scope=team&teamId=${teamId}`), { status: 404 });
    const admin = await read({ userId: 'administrator', workspaceId: 'personal-administrator' });
    assert(!admin.items.some(item => ['plugin-private', 'skill-private'].some(key => item.resourceRef === descriptors.get(key)!.metadata.resourceRef)), 'Organization admin is not a foreign personal package reader.');
    const all = await read(alice, 'limit=50');
    assert.equal(all.items.filter(item => item.name === 'catalog-design' && item.kind === 'plugin').length, 3);
    assert.equal(all.items.filter(item => item.name === 'catalog-design' && item.kind === 'skill').length, 3);
    assert.equal(new Set(all.items.map(item => item.resourceRef)).size, all.items.length);
    for (const item of all.items) {
      assert(!JSON.stringify(item).includes(root)); assert(!JSON.stringify(item).includes(sourceBytesMarker));
      for (const forbidden of ['checksum', 'grants', 'installDir', 'skillPath', 'runtimePath', 'connectors', 'config']) assert(!Object.hasOwn(item, forbidden));
      if (item.people) for (const person of Object.values(item.people)) assert(!Object.hasOwn(person!, 'userId'));
    }
    const child = all.items.find(item => item.kind === 'skill' && item.parentResourceRef);
    assert.ok(child, 'Actual installed plugin children retain an authorized exact parent reference.');
    const page = await read(alice, `kind=skill&q=${encodeURIComponent(child.name)}&limit=1`);
    assert.equal(page.items.length, 1); assert.ok(page.items[0].parentResourceRef);
    assert(all.items.some(parent => parent.kind === 'plugin' && parent.resourceRef === page.items[0].parentResourceRef), 'Canonical parent mapping survives filtering and pagination.');
    const request = (userId?: string, selection = '', workspaceId?: string) => new Request(`http://localhost:3001/api/plugins/catalog?${selection}`, { headers: userId ? headers(userId, workspaceId) : undefined });
    assert.equal((await route.GET(request())).status, 401);
    for (const selection of ['scope=user&scope=organization', 'scope=user&audience=own&audience=shared', 'kind=plugin&kind=skill', 'scope=bogus', 'teamId=catalog-team', 'page=0', 'limit=51', 'page=1e2',
      'workspaceId=personal-alice&workspaceId=personal-bob', 'actorUserId=owner', 'organizationId=other-org']) assert.equal((await route.GET(request('alice', selection))).status, 400, selection);
    assert.equal((await route.GET(request('alice', 'workspaceId=personal-bob', 'personal-alice'))).status, 400);
    assert.equal((await route.GET(request('alice', 'workspaceId=personal-bob'))).status, 403);
    const accepted = await route.GET(request('alice', 'scope=user&kind=plugin', 'personal-alice'));
    assert.equal(accepted.status, 200); assert.equal(accepted.headers.get('cache-control'), 'no-store');
    const payload = await accepted.json() as { data: PluginWorkspaceCatalogResponse };
    assert.deepEqual(payload.data.items.map(item => item.resourceRef), own.items.map(item => item.resourceRef));
    await assert.rejects(() => read({ userId: 'outsider', workspaceId: 'personal-outsider' }), { status: 403 });
    await assert.rejects(() => read({ userId: 'nonexistent', workspaceId: 'personal-alice' }), { status: 403 });
    await sql.run("UPDATE organization_user_permissions SET status='suspended' WHERE user_id='inactive' AND organization_id=$1", [organizationId]);
    await sql.run('UPDATE "user" SET banned=1 WHERE id=\'banned\'');
    for (const userId of ['inactive', 'banned']) await assert.rejects(() => read({ userId, workspaceId: `personal-${userId}` }), { status: 403 });
    const state = await store.listCanvasSkillStore({ actor: alice, scope: ownScope('alice'), pageSize: 50 });
    assert.equal(state.comparison, 'partial', 'Known single Store origin and unknown legacy instances remain distinct.');
    const multiple = state.skills.find(skill => skill.name === 'catalog-design')!.installed;
    const multipleResources = state.installedResources!.filter(resource => resource.artifact.name === 'catalog-design');
    assert.equal(multipleResources.length, 3); assert.deepEqual(multiple.resources, []); assert.equal(multiple.installed, false);
    assert.equal(multiple.version, undefined); assert.equal(multiple.enabled, false);
    assert.equal(multiple.installedSkill, undefined); assert.equal(multiple.restoreAvailable, false); assert.equal(multiple.modified, false); assert.equal(multiple.updateAvailable, false);
    assert.deepEqual(new Set(multipleResources.map(resource => resource.metadata.resourceRef)), new Set(['skill-own', 'skill-team', 'skill-shared'].map(key => descriptors.get(key)!.metadata.resourceRef)));
    assert(multipleResources.every(resource => resource.storeState?.origin === 'unknown'));
    assert.equal(multipleResources.find(resource => resource.metadata.resourceRef === descriptors.get('skill-team')!.metadata.resourceRef)!.metadata.ownership.type, 'team');
    for (const name of ['hidden-skill', 'private-skill']) {
      const installed = state.skills.find(skill => skill.name === name)!.installed; assert.equal(installed.installed, false); assert.deepEqual(installed.resources, []);
      assert(!state.installedResources!.some(resource => resource.artifact.name === name));
    }
    const single = state.skills.find(skill => skill.name === 'single-skill')!.installed;
    assert.equal(single.resources?.length, 1); assert.equal(single.enabled, true); assert.equal(single.version, '1.0.0');
    const singleResource = state.installedResources!.find(resource => resource.artifact.name === 'single-skill')!;
    assert.equal(singleResource.activation?.enabled, true); assert.equal(singleResource.artifact.version, '1.0.0');
    const serializedState = JSON.stringify(state);
    assert(!serializedState.includes(root)); assert(!serializedState.includes(sourceBytesMarker));
    for (const skill of state.skills) for (const resource of skill.installed.resources || []) assert(!Object.hasOwn(resource.artifact, 'checksum'));
    for (const resource of state.installedResources || []) assert(!Object.hasOwn(resource.artifact, 'checksum'));
    assert(observedChecksumCalls > 0, 'Current ACL catalog and bounded authorized comparison perform real checksum IO.');
    assert.equal(legacyProbes, 0, 'Authorized comparison adds no legacy modification/restore path.');
    const invalidActorsAccepted: string[] = [];
    for (const userId of ['banned', 'nonexistent']) {
      try {
        const invalidState = await store.listCanvasSkillStore({ actor: {
          userId, workspaceId: userId === 'banned' ? 'personal-banned' : 'personal-alice',
        }, scope: ownScope(userId), pageSize: 50 });
        assert(invalidState.skills.every(skill => skill.installed.resources?.length === 0), 'Denied actor must not receive private installed state.');
        invalidActorsAccepted.push(userId);
      } catch (error) { assert.equal((error as { status?: number }).status, 403); }
    }
    const sharedPlugin = descriptors.get('plugin-shared')!;
    await actions.updateCapabilityResource({ userId: 'bob', workspaceId: 'personal-bob' }, sharedPlugin.metadata.resourceRef,
      { expectedMetadataRevision: sharedPlugin.metadata.metadataRevision, expectedGrantsRevision: sharedPlugin.metadata.grantsRevision, grants: [] });
    assert(!(await read(alice, 'scope=user&audience=shared')).items.some(item => item.resourceRef === sharedPlugin.metadata.resourceRef), 'Current revoked read authority is not cached.');
    await sql.run("UPDATE canvas_workspace_members SET status='removed' WHERE workspace_id='catalog-team' AND user_id='manager'");
    assert(!(await read({ userId: 'manager', workspaceId: 'personal-manager' })).items.some(item => item.resourceRef === descriptors.get('plugin-team')!.metadata.resourceRef), 'A former creator has no implicit read after team authority is revoked.');
    await assert.rejects(() => read({ userId: 'manager', workspaceId: 'personal-manager' }, 'scope=team&teamId=catalog-team'), { status: 404 });
    await sql.run("UPDATE canvas_workspaces SET status='disabled' WHERE id='catalog-team'");
    assert(!(await read(alice, 'scope=user&audience=shared')).items.some(item => item.ownership.type === 'team'));
    await assert.rejects(() => read({ userId: 'manager', workspaceId: 'personal-manager' }, 'scope=team&teamId=catalog-team'), { status: 404 });
    assert.equal(remoteRequests, 0);
    assert.deepEqual(invalidActorsAccepted, [], 'Public store must reject invalid actors rather than returning public offerings with no installed state.');
    console.log('PASS actual PostgreSQL/PGlite + Better Auth catalog: exact Own/Org/Team/Shared identities, current rights and real activation, strict API/query, no private installed paths/bytes, no extra legacy probes or provider requests.');
  } finally {
    observe = false; globalThis.fetch = originalFetch;
    await authReady;
    loader._load = originalLoad;
    await sql.close(); await database.close();
    assert(path.basename(root).startsWith('canvas-plugin-catalog-authority-')); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

main().catch(error => { console.error(error instanceof Error ? error.stack : 'Catalog authority fixture failed.'); process.exitCode = 1; });
