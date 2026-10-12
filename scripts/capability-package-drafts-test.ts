import assert from 'node:assert/strict';
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { CapabilityResourceActor, CapabilityResourceStorageBinding } from '../app/lib/capabilities/resources/contracts';
import type { AuthorizedCapabilityPackageSource, CapabilityPackageDraft, CapabilityPackageOwnedDraftList,
  CapabilityPackageOwnedDraftStatus } from '../app/lib/capabilities/packages/contracts';

// New fixture only: actual in-memory PostgreSQL/authority and real draft IO, no configured DB or server.
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-private-draft-list-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, NODE_ENV: 'test', QMD_ENABLED: 'false',
    DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_private_drafts_fixture', BASE_URL: 'http://localhost:3001',
    BETTER_AUTH_BASE_URL: 'http://localhost:3001', AUTH_SECRET: randomUUID() + randomUUID() };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const modules = new Map<string, unknown>(), draftQueries: string[] = [];
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load, originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  const transport = { ...database, openDb: async () => {
    const connection = await database.openDb();
    return { ...connection,
      get: async (sql: string, parameters: unknown[] = []) => {
        if (/SELECT[\s\S]*FROM capability_package_drafts/u.test(sql)) draftQueries.push(sql);
        return connection.get(sql, parameters);
      },
      all: async (sql: string, parameters: unknown[] = []) => {
        if (/SELECT[\s\S]*FROM capability_package_drafts/u.test(sql)) draftQueries.push(sql);
        return connection.all(sql, parameters);
      } };
  } };
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return transport;
    if (name === '@/app/lib/auth' || /\/app\/lib\/auth(?:\.ts)?$/u.test(name)) return { auth: { api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-fixture-user');
        return id ? { user: { id }, session: { id: `fixture-${id}` } } : null;
      } } } };
    if (modules.has(name)) return modules.get(name);
    return original(name, parent, isMain);
  };
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    for (const id of ['owner', 'editor', 'foreign', 'outsider']) {
      await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,\'user\',1,0,1000,1000)', [id, `${id}@private-drafts.example.test`]);
    }
    for (const [organizationId, ownerUserId] of [['draft-org', 'owner'], ['other-org', 'outsider']]) {
      await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ($1,$2,'team',1,1000,1000)", [organizationId, ownerUserId]);
    }
    for (const id of ['owner', 'editor', 'foreign', 'outsider']) {
      const organizationId = id === 'outsider' ? 'other-org' : 'draft-org';
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ($1,$2,$3,'active',$4,1000,1000)", [organizationId, id, ['owner', 'outsider'].includes(id) ? 'owner' : 'member', Number(['owner', 'outsider'].includes(id))]);
      await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,$2,'personal',$3,$1,$3,'active',1000,1000)", [`personal-${id}`, organizationId, id]);
    }
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ('editor-second','draft-org','personal','editor','editor-second','Second personal','active',1000,1000)");
    const resources = await import('../app/lib/capabilities/resources/store');
    const store = await import('../app/lib/capabilities/packages/store');
    const io = await import('../app/lib/capabilities/packages/io');
    const actions = await import('../app/lib/capabilities/packages/actions');
    const collection = await import('../app/api/capabilities/packages/drafts/route');
    const statusRoute = await import('../app/api/capabilities/packages/drafts/[draftRef]/status/route');
    const treeRoute = await import('../app/api/capabilities/packages/drafts/[draftRef]/tree/route');
    const draftRoute = await import('../app/api/capabilities/packages/drafts/[draftRef]/route');
    const owner: CapabilityResourceActor = { userId: 'owner', workspaceId: 'personal-owner' };
    const editor: CapabilityResourceActor = { userId: 'editor', workspaceId: 'personal-editor' };
    const foreign: CapabilityResourceActor = { userId: 'foreign', workspaceId: 'personal-foreign' };
    const binding: CapabilityResourceStorageBinding = { resourceType: 'skill', resourceId: 'canvas-capability:v1:skill:org:draft-org:standalone:draft-source',
      scopeType: 'organization', name: 'draft-source', sourceType: 'standalone', organizationId: 'draft-org', ownerUserId: null, sourcePluginId: null };
    const grants = ['editor', 'foreign'].map(targetId => ({ targetType: 'user' as const, targetId, canUse: false, canEdit: true, canManage: false }));
    const adopted = await resources.adoptCapabilityResource(owner, binding, { expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted', grants });
    const sourceRoot = path.join(root, 'source', binding.name);
    await fs.mkdir(path.join(sourceRoot, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'SKILL.md'), '---\nname: draft-source\ndescription: Creator-private draft fixture\n---\nPRIVATE_SOURCE_BODY\n');
    await fs.writeFile(path.join(sourceRoot, 'scripts/run.js'), 'process.stdout.write("PRIVATE_SCRIPT_BODY");\n');
    const inventory = await io.readExactPackageInventory(sourceRoot);
    const location = (draft: CapabilityPackageDraft) => io.resolveCapabilityPackageDraftLocation({ ...draft, owner: adopted.metadata.ownership });
    const create = async (actor: CapabilityResourceActor) => {
      const authorization = await resources.authorizeCapabilityPackageResource(actor, binding, 'read');
      const source: AuthorizedCapabilityPackageSource = { authorization, storage: binding,
        sourceStamp: { resourceId: binding.resourceId, kind: 'skill', name: binding.name, version: '1.0.0', artifactRevision: 1,
          registryChecksum: inventory.checksum, checksum: inventory.checksum, sourcePluginId: null },
        location: { rootPath: sourceRoot, resourceRef: adopted.metadata.resourceRef, owner: adopted.metadata.ownership, kind: 'skill', name: binding.name }, readOnly: false };
      return store.beginCapabilityPackageDraft(actor, { operation: 'edit', resourceRef: adopted.metadata.resourceRef,
        expectedMetadataRevision: 1, expectedGrantsRevision: 1, expectedPackageRevision: 0, expectedPublishedRevisionRef: null }, { source }, async draft => {
        await io.createCapabilityPackageDraft(source.location, location(draft));
      });
    };
    const ownDrafts = [await create(editor), await create(editor), await create(editor)], foreignDraft = await create(foreign);
    for (const draft of [...ownDrafts, foreignDraft]) await raw.run('UPDATE capability_package_drafts SET created_at=1000,updated_at=2000 WHERE draft_ref=$1', [draft.draftRef]);
    const expectedOrder = ownDrafts.map(draft => draft.draftRef).sort();
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('No provider or source HTTP is permitted in this fixture.'); };
    const context = (parameters: Record<string, string> = {}) => ({ params: Promise.resolve(parameters) });
    const request = (userId: string | null, query = '', method = 'GET', body?: unknown) => new Request(`http://fixture/api/capabilities/packages/drafts${query ? `?${query}` : ''}`, {
      method, headers: { ...(userId ? { 'x-fixture-user': userId } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = async <T,>(response: Response, expectedStatus = 200): Promise<T> => {
      assert.equal(response.status, expectedStatus, await response.clone().text());
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      return (await response.json() as { data: T }).data;
    };
    assert.equal((await collection.GET(request(null), context())).status, 401);
    const first = await data<CapabilityPackageOwnedDraftList>(await collection.GET(request('editor', 'workspaceId=personal-editor&limit=1'), context()));
    assert.deepEqual(first.drafts.map(draft => draft.draftRef), expectedOrder.slice(0, 1));
    assert(first.nextCursor);
    const pageTwo = await actions.listCapabilityPackageOwnedDraftStatusesAction(editor, { limit: 1, cursor: first.nextCursor });
    assert(pageTwo.nextCursor);
    const pageThree = await store.listCapabilityPackageOwnedDraftStatuses(editor, { limit: 1, cursor: pageTwo.nextCursor });
    assert.equal(pageThree.nextCursor, null);
    assert.deepEqual([...first.drafts, ...pageTwo.drafts, ...pageThree.drafts].map(draft => draft.draftRef), expectedOrder);
    const all = await store.listCapabilityPackageOwnedDraftStatuses(editor);
    assert.equal(all.drafts.length, 3); assert.equal(all.nextCursor, null);
    for (const status of all.drafts) {
      assert.deepEqual(Object.keys(status).sort(), ['draftRef', 'resourceRef', 'sourceResourceRef', 'kind', 'name', 'draftRevision', 'operation', 'targetOwnership', 'createdAt', 'updatedAt'].sort());
      assert.equal(status.sourceResourceRef, adopted.metadata.resourceRef);
    }
    assert.doesNotMatch(JSON.stringify(all), /PRIVATE_SOURCE_BODY|PRIVATE_SCRIPT_BODY|sourceStamp|checksum|actorUserId|sourceStorage|rootPath/);
    assert(!JSON.stringify(all).includes(root));
    assert.deepEqual((await store.listCapabilityPackageOwnedDraftStatuses(foreign)).drafts.map(draft => draft.draftRef), [foreignDraft.draftRef]);
    assert.equal((await collection.GET(request('outsider', 'workspaceId=personal-outsider'), context())).status, 200);
    assert.deepEqual((await store.listCapabilityPackageOwnedDraftStatuses({ userId: 'outsider', workspaceId: 'personal-outsider' })).drafts, []);
    assert.equal((await statusRoute.GET(request('foreign'), context({ draftRef: ownDrafts[0].draftRef }))).status, 404);
    for (const actor of [foreign, { ...editor, workspaceId: 'editor-second' }]) {
      await assert.rejects(() => store.listCapabilityPackageOwnedDraftStatuses(actor, { cursor: first.nextCursor! }), { code: 'PACKAGE_REQUEST_INVALID' });
    }
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=1junk', 'limit=1e1', 'limit=1&limit=2', 'cursor=', 'cursor=bad',
      'actorUserId=owner', 'organizationId=other-org', 'scope=organization', 'workspaceId=personal-editor&workspaceId=personal-foreign']) {
      assert.equal((await collection.GET(request('editor', query), context())).status, 400, `Strict query: ${query}`);
    }
    await assert.rejects(() => actions.listCapabilityPackageOwnedDraftStatusesAction(editor, { limit: null }), { code: 'PACKAGE_REQUEST_INVALID' });
    const queryCount = draftQueries.length;
    assert.equal((await collection.GET(request('editor', 'workspaceId=personal-outsider'), context())).status, 403);
    assert.equal((await collection.GET(request('editor', 'workspaceId=personal-foreign'), context())).status, 403);
    assert.equal(draftQueries.length, queryCount, 'Unreachable workspace authority fails before any draft query.');
    const current = await store.mutateCapabilityPackageDraft(editor, ownDrafts[0].draftRef, 1, async draft => io.writeCapabilityPackageDraftFile(location(draft), {
      path: 'scripts/run.js', encoding: 'base64', content: Buffer.from('process.stdout.write("edited");\n').toString('base64') }));
    await resources.mutateCapabilityResource(owner, adopted.metadata.resourceRef, { expectedMetadataRevision: 1, expectedGrantsRevision: 1, grants: grants.filter(grant => grant.targetId === 'foreign') });
    await fs.rm(sourceRoot, { recursive: true });
    const revokedList = await data<CapabilityPackageOwnedDraftList>(await collection.GET(request('editor', 'workspaceId=personal-editor'), context()));
    assert.equal(revokedList.drafts.length, 3, 'Creator recovery remains discoverable after source revocation and removal.');
    assert.equal(revokedList.drafts[0].draftRef, current.draft.draftRef, 'The newest changed draft precedes older tied entries.');
    const ownStatus = await data<{ status: CapabilityPackageOwnedDraftStatus }>(await statusRoute.GET(request('editor'), context({ draftRef: current.draft.draftRef })));
    assert.equal(ownStatus.status.draftRevision, 2);
    assert.deepEqual(ownStatus.status, revokedList.drafts.find(draft => draft.draftRef === current.draft.draftRef));
    assert.equal((await treeRoute.GET(request('editor'), context({ draftRef: current.draft.draftRef }))).status, 403);
    assert.equal((await draftRoute.DELETE(request('editor', '', 'DELETE', { expectedDraftRevision: 1 }), context({ draftRef: current.draft.draftRef }))).status, 409);
    assert.equal((await fs.stat(location(current.draft).rootPath)).isDirectory(), true, 'Stale discard retains the current private draft.');
    await data(await draftRoute.DELETE(request('editor', '', 'DELETE', { expectedDraftRevision: 2 }), context({ draftRef: current.draft.draftRef })));
    assert.equal((await store.listCapabilityPackageOwnedDraftStatuses(editor)).drafts.length, 2);
    assert.equal((await statusRoute.GET(request('editor'), context({ draftRef: current.draft.draftRef }))).status, 404);
    await assert.rejects(() => fs.stat(location(current.draft).rootPath), { code: 'ENOENT' });
    const corrupt = ownDrafts[1];
    await raw.run('UPDATE capability_package_drafts SET source_storage=$1,base_source_stamp=$1 WHERE draft_ref=$2', ['PRIVATE_INVALID_JSON', corrupt.draftRef]);
    assert.equal((await store.listCapabilityPackageOwnedDraftStatuses(editor)).drafts.length, 2, 'Listing never parses private source bindings or stamps.');
    const originalOwner = JSON.stringify(adopted.metadata.ownership);
    for (const malformed of ['{bad', JSON.stringify({ type: 'system' }), JSON.stringify({ ...adopted.metadata.ownership, SECRET_FIELD: '/private/secret' })]) {
      await raw.run('UPDATE capability_package_drafts SET target_ownership=$1 WHERE draft_ref=$2', [malformed, corrupt.draftRef]);
      const response = await collection.GET(request('editor'), context());
      assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE_INVALID_JSON|SECRET_FIELD|\/private\/secret/);
      await assert.rejects(() => store.getCapabilityPackageOwnedDraftStatus(editor, corrupt.draftRef), { code: 'PACKAGE_SNAPSHOT_UNAVAILABLE' });
    }
    await raw.run('UPDATE capability_package_drafts SET target_ownership=$1,source_resource_ref=$2 WHERE draft_ref=$3', [originalOwner, '/private/SECRET_SOURCE', corrupt.draftRef]);
    await assert.rejects(() => store.listCapabilityPackageOwnedDraftStatuses(editor), { code: 'PACKAGE_SNAPSHOT_UNAVAILABLE' });
    const legacyCore = 'canvas-capability:v1:skill:system:core:draft-source';
    await raw.run('UPDATE capability_package_drafts SET source_resource_ref=$1 WHERE draft_ref=$2', [legacyCore, corrupt.draftRef]);
    assert.equal((await store.getCapabilityPackageOwnedDraftStatus(editor, corrupt.draftRef)).sourceResourceRef, legacyCore, 'Core forks retain their safe legacy source reference.');
    await raw.run('UPDATE capability_package_drafts SET updated_at=-1 WHERE draft_ref=$1', [corrupt.draftRef]);
    await assert.rejects(() => store.listCapabilityPackageOwnedDraftStatuses(editor), { code: 'PACKAGE_SNAPSHOT_UNAVAILABLE' });
    await raw.run('UPDATE capability_package_drafts SET updated_at=2000 WHERE draft_ref=$1', [corrupt.draftRef]);
    const beforeBanQueries = draftQueries.length;
    await raw.run('UPDATE "user" SET banned=1 WHERE id=\'editor\'');
    assert.equal((await collection.GET(request('editor'), context())).status, 403);
    assert.equal(draftQueries.length, beforeBanQueries, 'Current actor authority fails before the private query.');
    await raw.run('UPDATE "user" SET banned=0 WHERE id=\'editor\'');
    await raw.run("UPDATE organization_user_permissions SET status='inactive' WHERE user_id='editor'");
    assert.equal((await collection.GET(request('editor'), context())).status, 403);
    assert.equal(draftQueries.length, beforeBanQueries, 'Inactive membership fails before the private query.');
    assert.equal(fetchCalls, 0);
    const safeQueries = draftQueries.filter(sql => sql.includes('target_ownership') && !sql.includes('FOR UPDATE') && !sql.includes('FOR SHARE'));
    assert(safeQueries.length > 0);
    assert(safeQueries.every(sql => !/SELECT \*|source_storage|source_parent_storage|base_source_stamp/iu.test(sql)), 'Status/list queries select only safe columns.');
    console.log('PASS actual PostgreSQL/PGlite + authenticated actions/GET: creator-only private draft recovery, context-bound keyset pagination, strict queries, safe projection, fresh authority/revocation and real CAS discard; zero provider/source HTTP.');
  } finally {
    loader._load = original; globalThis.fetch = originalFetch;
    await raw.close(); await database.close();
    for (const key of Object.keys(environment)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    const unlock = async (directory: string): Promise<void> => {
      const stat = await fs.lstat(directory);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { await fs.chmod(directory, 0o700); for (const name of await fs.readdir(directory)) await unlock(path.join(directory, name)); }
    };
    await unlock(root); await fs.rm(root, { recursive: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
