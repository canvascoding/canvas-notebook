import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { CapabilityResourceDescriptor, CapabilityResourceGrantInput } from '../app/lib/capabilities/resources/contracts';

/** Real PostgreSQL-compatible schema/FS/registry/resource actions and mobile routes; only DB transport and HTTP session adapters are fixtures. */
async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-resource-read-'));
  const env = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'mobile-read-org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', BETTER_AUTH_BASE_URL: 'http://fixture.invalid', QMD_ENABLED: 'false',
    DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_mobile_resource_fixture', NODE_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const database = await createPiTestDatabase();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  const esmModules = new Map<string, unknown>();
  let requestHeaders = new Headers();
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-fixture-user');
      return id ? { user: { id }, session: { id: `fixture-session-${id}` } } : null;
    } } } };
    if (name === 'next/headers') return { headers: async () => requestHeaders };
    if (esmModules.has(name)) return esmModules.get(name);
    return originalLoad(name, parent, isMain);
  };
  const originalReadFile = fs.readFile;
  const actualPromises = (originalLoad('node:fs', null, false) as typeof import('node:fs')).promises;
  const originalActualReadFile = actualPromises.readFile;
  const installedRoots: string[] = [];
  const sourceReads: string[] = [];
  let afterAssetRead: (() => Promise<void>) | undefined;
  const observedReadFile = (async (...args: Parameters<typeof originalActualReadFile>) => {
    const filename = String(args[0]);
    if (installedRoots.some(directory => filename === directory || filename.startsWith(`${directory}${path.sep}`))) sourceReads.push(filename);
    const result = await originalActualReadFile(...args);
    if (afterAssetRead && filename.endsWith(`${path.sep}assets${path.sep}icon.png`)) {
      const hook = afterAssetRead; afterAssetRead = undefined; await hook();
    }
    return result;
  }) as typeof originalActualReadFile;
  actualPromises.readFile = observedReadFile;
  fs.readFile = observedReadFile;
  try {
    // Keep actual ESM exports when the fixture's CJS dependency graph loads runtime invalidation dependencies.
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) esmModules.set(name, await import(name));
    const raw = await database.openDb();
    for (const id of ['owner', 'member', 'unassigned', 'other-owner']) await raw.run(
      'INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@mobile-read.fixture.invalid`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('mobile-read-org','owner','team',1,1000,1000)");
    for (const id of ['owner', 'member', 'unassigned', 'other-owner']) await raw.run(
      "INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('mobile-read-org',$1,$2,'active',$3,1000,1000)",
      [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('mobile-read-team','mobile-read-org','team','workspaces/mobile-read-team/files','Fixture team','active',1000,1000)");
    for (const id of ['owner', 'member', 'unassigned', 'other-owner']) await raw.run(
      "INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('mobile-read-org','mobile-read-team',$1,'member','active',1,1,$2,1000,1000)", [id, Number(id === 'owner')]);
    const packageRoot = path.join(root, 'source');
    await fs.mkdir(path.join(packageRoot, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(packageRoot, 'skills', 'mobile-context'), { recursive: true });
    await fs.mkdir(path.join(packageRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name: 'mobile-private-package', version: '1.0.0',
      description: 'PRIVATE_INSTALLED_DESCRIPTION', skills: 'skills', interface: { displayName: 'Fixture private package', icon: 'assets/icon.png' } }));
    await fs.writeFile(path.join(packageRoot, 'skills', 'mobile-context', 'SKILL.md'), '---\nname: mobile-context\ndescription: Private mobile context\n---\n\nPRIVATE_SKILL_BYTES\n');
    await fs.writeFile(path.join(packageRoot, 'README.md'), 'PRIVATE_README_BYTES\n');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPwd3v6HwAE3AJ67pkOGgAAAABJRU5ErkJggg==', 'base64');
    await fs.writeFile(path.join(packageRoot, 'assets', 'icon.png'), png);
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const installed = await registry.installCanvasPluginFromPath(packageRoot, { scope: { scopeType: 'organization', organizationId: 'mobile-read-org' }, enable: true, installedBy: 'owner' });
    assert(installed.success && installed.plugin, installed.error || 'Actual fixture package installation failed.');
    const legacyResourceId = installed.plugin.resourceId;
    assert(typeof legacyResourceId === 'string' && legacyResourceId.length > 0, 'Actual installation must issue a resource identity.');
    installedRoots.push(installed.plugin.installDir);
    const actions = await import('../app/lib/capabilities/resources/actions');
    const owner = { userId: 'owner', workspaceId: 'mobile-read-team' };
    const restricted = await actions.configureCapabilityResource(owner, legacyResourceId, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted', grants: [],
    });
    const detail = await import('../app/api/mobile/v1/extensions/plugins/[name]/route');
    const asset = await import('../app/api/mobile/v1/extensions/plugins/asset/route');
    const request = (userId: string | null, suffix: string, workspaceId = 'mobile-read-team') => {
      requestHeaders = new Headers({ ...(userId ? { 'x-fixture-user': userId } : {}), 'x-canvas-workspace-id': workspaceId });
      return new NextRequest(`http://fixture.invalid/api/mobile/v1/extensions/plugins/${suffix}`, { headers: requestHeaders });
    };
    const params = { params: Promise.resolve({ name: installed.plugin.name }) };
    const query = new URLSearchParams({ scope: 'organization', resourceId: legacyResourceId, workspaceId: 'mobile-read-team' }).toString();
    const assetQuery = new URLSearchParams({ scope: 'organization', resourceId: legacyResourceId, plugin: installed.plugin.name, path: 'assets/icon.png', workspaceId: 'mobile-read-team' }).toString();
    assert.equal((await detail.GET(request(null, `${installed.plugin.name}?${query}`), params)).status, 401);
    assert.equal((await asset.GET(request(null, `asset?${assetQuery}`))).status, 401);
    const allowed = await detail.GET(request('owner', `${installed.plugin.name}?${query}`), params);
    assert.equal(allowed.status, 200);
    assert.doesNotMatch(JSON.stringify(await allowed.json()), /installDir|PRIVATE_README_BYTES|PRIVATE_SKILL_BYTES/);
    const allowedAsset = await asset.GET(request('owner', `asset?${assetQuery}`));
    assert.equal(allowedAsset.status, 200);
    assert.deepEqual(Buffer.from(await allowedAsset.arrayBuffer()), png);
    const freshCatalog = await actions.listCapabilityResources({ userId: 'unassigned', workspaceId: 'mobile-read-team' });
    assert(!freshCatalog.some(resource => resource.metadata.resourceRef === restricted.metadata.resourceRef), 'Actual common ResourceStore denies this unassigned actor.');
    sourceReads.length = 0;
    const deniedDetail = await detail.GET(request('unassigned', `${installed.plugin.name}?${query}`), params);
    const deniedAsset = await asset.GET(request('unassigned', `asset?${assetQuery}`));
    if (deniedAsset.status === 200) assert.deepEqual(Buffer.from(await deniedAsset.arrayBuffer()), png, 'The current unauthorized asset response contains the actual installed PNG bytes.');
    const assetReads = sourceReads.filter(filename => filename.endsWith(`${path.sep}assets${path.sep}icon.png`)).length;
    const childReads = sourceReads.filter(filename => filename.endsWith(`${path.sep}SKILL.md`)).length;
    console.log(`mobile read authority observation: restricted same-org unassigned detail=${deniedDetail.status} asset=${deniedAsset.status} requestedAssetReads=${assetReads} childContentReads=${childReads} packageContentReads=${sourceReads.length}; common catalog excludes exact resource.`);
    assert.equal(deniedDetail.status, 404, 'Unassigned same-organization mobile detail must respect current exact ResourceStore read authority.');
    assert.equal(deniedAsset.status, 404, 'Unassigned same-organization mobile asset must respect current exact ResourceStore read authority.');
    assert.equal(sourceReads.length, 0, 'Initially denied mobile requests must open no package contents.');
    assert(!JSON.stringify(await deniedDetail.json()).includes('PRIVATE_INSTALLED_DESCRIPTION'));
    console.log('PASS initial denial: exact ResourceStore decision, mobile404, requested asset and private child/manifest bytes unopened.');

    type Selection = { name: string; resourceId?: string; scope: 'user' | 'organization'; workspaceId?: string };
    const selectionQuery = (selection: Selection, image = false, assetPath = 'assets/icon.png') => new URLSearchParams({ scope: selection.scope,
      ...(selection.resourceId === undefined ? {} : { resourceId: selection.resourceId }), workspaceId: selection.workspaceId || 'mobile-read-team',
      ...(image ? { plugin: selection.name, path: assetPath } : {}) }).toString();
    const readDetail = (userId: string, selection: Selection) => detail.GET(request(userId, `${selection.name}?${selectionQuery(selection)}`, selection.workspaceId), { params: Promise.resolve({ name: selection.name }) });
    const readAsset = (userId: string, selection: Selection, assetPath?: string) => asset.GET(request(userId, `asset?${selectionQuery(selection, true, assetPath)}`, selection.workspaceId));
    const orgSelection: Selection = { name: installed.plugin.name, resourceId: legacyResourceId, scope: 'organization' };
    const assertReadable = async (userId: string, selection: Selection) => {
      const response = await readDetail(userId, selection); assert.equal(response.status, 200);
      assert.match(response.headers.get('Cache-Control') || '', /no-store/u);
      const serialized = JSON.stringify(await response.json());
      assert.doesNotMatch(serialized, /installDir|PRIVATE_README_BYTES|PRIVATE_SKILL_BYTES|ownerUserId|backendId|apiKey|bearerToken/u);
      const image = await readAsset(userId, selection); assert.equal(image.status, 200);
      assert.match(image.headers.get('Cache-Control') || '', /no-store/u);
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    };
    const assertDenied = async (userId: string, selection: Selection, label: string, unreadableRoot?: string) => {
      sourceReads.length = 0;
      const response = await readDetail(userId, selection), image = await readAsset(userId, selection);
      assert.equal(response.status, 404, `${label}: detail denies without disclosure.`);
      assert.equal(image.status, 404, `${label}: asset denies without disclosure.`);
      assert.doesNotMatch(await response.text(), /PRIVATE_|installDir|canvas-resource:/u);
      assert.doesNotMatch(await image.text(), /PRIVATE_|installDir|canvas-resource:/u);
      assert.equal(sourceReads.filter(filename => filename.endsWith(`${path.sep}assets${path.sep}icon.png`)).length, 0, `${label}: no requested image bytes opened.`);
      // Other currently readable packages may be parsed by catalog discovery. ACL-denied target bytes may never be opened.
      if (unreadableRoot) assert.equal(sourceReads.filter(filename => filename.startsWith(`${unreadableRoot}${path.sep}`)).length, 0, `${label}: no ACL-denied target content reads.`);
    };
    let current: CapabilityResourceDescriptor = restricted;
    const setGrants = async (grants: CapabilityResourceGrantInput[]) => {
      current = await actions.updateCapabilityResource(owner, current.metadata.resourceRef, { expectedMetadataRevision: current.metadata.metadataRevision,
        expectedGrantsRevision: current.metadata.grantsRevision, grants });
    };
    for (const permission of ['canUse', 'canEdit', 'canManage'] as const) {
      const grant = { targetType: 'user' as const, targetId: 'member', canUse: false, canEdit: false, canManage: false, [permission]: true };
      await setGrants([grant]);
      const resource = await actions.inspectCapabilityResource({ userId: 'member', workspaceId: 'mobile-read-team' }, current.metadata.resourceRef);
      assert.equal(resource.access.canRead, true);
      for (const key of ['canUse', 'canEdit', 'canManage'] as const) assert.equal(resource.access[key], key === permission, 'Read never broadens independent use/edit/manage flags.');
      await assertReadable('member', orgSelection);
      await assertReadable('member', { ...orgSelection, resourceId: current.metadata.resourceRef });
    }
    console.log('PASS independent explicit Use/Edit/Manage grants provide Read without other rights; canonical and legacy exact selectors agree.');
    await setGrants([]); await assertDenied('member', orgSelection, 'Actual grant revocation', installed.plugin.installDir);
    await setGrants([{ targetType: 'user', targetId: 'member', canUse: true, canEdit: false, canManage: false }]);

    const installPersonal = async (userId: string, name: string) => {
      const location = path.join(root, `source-${userId}-${name}`);
      await fs.cp(packageRoot, location, { recursive: true });
      const manifest = JSON.parse(await fs.readFile(path.join(location, '.canvas-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
      manifest.name = name;
      await fs.writeFile(path.join(location, '.canvas-plugin', 'plugin.json'), JSON.stringify(manifest));
      const installedPersonal = await registry.installCanvasPluginFromPath(location, { scope: { userId }, enable: false, installedBy: userId });
      assert(installedPersonal.success && installedPersonal.plugin, installedPersonal.error || 'Actual personal fixture installation failed.');
      const resourceId = installedPersonal.plugin.resourceId;
      assert(typeof resourceId === 'string' && resourceId.length > 0, 'Actual personal installation must issue a resource identity.');
      installedRoots.push(installedPersonal.plugin.installDir); return { ...installedPersonal.plugin, resourceId };
    };
    const sharedPersonal = await installPersonal('other-owner', 'mobile-shared-personal');
    const privatePersonal = await installPersonal('other-owner', 'mobile-private-personal');
    const sharedResource = await actions.configureCapabilityResource({ userId: 'other-owner', workspaceId: 'mobile-read-team' }, sharedPersonal.resourceId, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted', grants: [{ targetType: 'user', targetId: 'member', canUse: true, canEdit: false, canManage: false }],
    });
    await assertReadable('member', { name: sharedPersonal.name, resourceId: sharedPersonal.resourceId, scope: 'user' });
    await assertReadable('member', { name: sharedPersonal.name, resourceId: sharedResource.metadata.resourceRef, scope: 'user' });
    await assertDenied('member', { name: sharedPersonal.name, scope: 'user' }, 'Foreign personal name-only lookup');
    await assertDenied('member', { name: privatePersonal.name, resourceId: privatePersonal.resourceId, scope: 'user' }, 'Other owner private exact package', privatePersonal.installDir);
    await assertDenied('unassigned', { name: sharedPersonal.name, resourceId: sharedResource.metadata.resourceRef, scope: 'user' }, 'Other actor cannot inherit recipient access', sharedPersonal.installDir);
    const ownUnmanaged = await installPersonal('member', 'mobile-legacy-own');
    await assertReadable('member', { name: ownUnmanaged.name, scope: 'user' });
    const shadow = await installPersonal('member', orgSelection.name);
    assert.notEqual(shadow.resourceId, installed.plugin.resourceId);
    await assertDenied('member', { ...orgSelection, resourceId: shadow.resourceId }, 'Organization selector never falls back to personal name');
    await assertDenied('member', { ...orgSelection, scope: 'user' }, 'Personal selector never falls back to organization');
    await assertDenied('member', { ...orgSelection, resourceId: privatePersonal.resourceId }, 'Name and exact identity mismatch', privatePersonal.installDir);
    await assertDenied('member', { ...orgSelection, resourceId: 'canvas-resource:ffffffff-ffff-4fff-8fff-ffffffffffff' }, 'Unknown exact identity');
    console.log('PASS shared foreign personal exact IDs, no owner-wide exposure, unmanaged scoped-own compatibility, no scope/name/identity fallback.');

    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('mobile-private-team','mobile-read-org','team','workspaces/mobile-private-team/files','Unreadable team','active',1000,1000)");
    await assertDenied('member', { ...orgSelection, workspaceId: 'mobile-private-team' }, 'Unreadable requested workspace', installed.plugin.installDir);
    await assertDenied('member', { ...orgSelection, workspaceId: 'mobile-nonexistent-workspace' }, 'Unknown requested workspace', installed.plugin.installDir);
    await raw.run("UPDATE canvas_workspace_members SET can_read=0,can_write=0 WHERE workspace_id='mobile-read-team' AND user_id='member'");
    await assertDenied('member', orgSelection, 'Current workspace permissions revoked', installed.plugin.installDir);
    await raw.run("UPDATE canvas_workspace_members SET can_read=1,can_write=1 WHERE workspace_id='mobile-read-team' AND user_id='member'");
    await raw.run("UPDATE organization_user_permissions SET status='inactive' WHERE organization_id='mobile-read-org' AND user_id='member'");
    await assertDenied('member', orgSelection, 'Inactive organization member', installed.plugin.installDir);
    await raw.run("UPDATE organization_user_permissions SET status='active' WHERE organization_id='mobile-read-org' AND user_id='member'");
    await raw.run('UPDATE "user" SET banned=1 WHERE id=\'member\'');
    await assertDenied('member', orgSelection, 'Current user banned despite old HTTP session', installed.plugin.installDir);
    await raw.run('UPDATE "user" SET banned=0 WHERE id=\'member\'');
    await assertReadable('member', orgSelection);
    console.log('PASS fresh workspace/membership/banned-user authority against the same previously authenticated actor.');

    for (const unsafe of ['../assets/icon.png', 'assets/../assets/icon.png', '/assets/icon.png', 'C:\\assets\\icon.png', 'assets/icon.png\0']) {
      sourceReads.length = 0; const response = await readAsset('member', orgSelection, unsafe);
      assert.equal(response.status, 400, 'Traversal/absolute/NUL paths are rejected before byte reads.'); assert.equal(sourceReads.length, 0);
    }
    const outsideImage = path.join(root, 'private-outside.png'); await fs.writeFile(outsideImage, png);
    await fs.symlink(outsideImage, path.join(installed.plugin.installDir, 'assets', 'link.png'));
    const link = await readAsset('member', orgSelection, 'assets/link.png'); assert.equal(link.status, 400);
    await fs.mkdir(path.join(installed.plugin.installDir, 'assets', 'directory.png'));
    assert.equal((await readAsset('member', orgSelection, 'assets/directory.png')).status, 400);
    await fs.symlink(root, path.join(installed.plugin.installDir, 'assets', 'parent-link'));
    assert.equal((await readAsset('member', orgSelection, 'assets/parent-link/private-outside.png')).status, 400);
    sourceReads.length = 0; let revokedAfterRead = false;
    afterAssetRead = async () => { revokedAfterRead = true; await setGrants([]); };
    const late = await readAsset('member', orgSelection);
    assert.equal(revokedAfterRead, true, 'The real image was read before the actual grant mutation.');
    assert.equal(late.status, 404, 'Fresh post-byte-read authority prevents response disclosure after revocation.');
    assert.equal(late.headers.get('Content-Type')?.includes('image/'), false); assert.doesNotMatch(await late.text(), /PRIVATE_|iVBOR/u);
    await assertDenied('member', orgSelection, 'Subsequent request after late revocation', installed.plugin.installDir);
    console.log('PASS path/no-follow boundaries and actual late grant revocation after real PNG read, with no response image bytes.');
    console.log('mobile-plugin-resource-read-test: PASS full isolated PGlite/real FS/registry/resource/catalog/mobile route matrix; no provider, native-client or configured-database claims.');
  } finally {
    actualPromises.readFile = originalActualReadFile; fs.readFile = originalReadFile; loader._load = originalLoad;
    await database.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
