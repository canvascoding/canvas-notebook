import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityResourceActor } from '../app/lib/capabilities/resources/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** New isolated fixture only; production authority, BetterAuth and SQL remain real. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const { sql, owner, manager, alice, organizationId, registry } = fixture;
  try {
    const { inspectCapabilityPackageStoreInstallOptionsAction: inspect } = await import('../app/lib/capabilities/packages/store-install-options');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const source = { kind: 'plugin' as const, registryId: 'store-not-contacted', entryKey: 'options-new-package', version: '1.0.0', checksum: 'a'.repeat(64) };
    const selection = (ownership: { type: 'user' | 'organization' } | { type: 'team'; workspaceId: string }, entryKey = source.entryKey) =>
      ({ source: { ...source, entryKey }, ownership });
    await sql.run("INSERT INTO canvas_workspace_members(organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES($1,'store-team','bob','member','active',1,0,1,1)", [organizationId]);
    await sql.run('UPDATE "user" SET banned=1 WHERE id=$1', ['unassigned']);
    await sql.run("UPDATE organization_user_permissions SET status='disabled' WHERE user_id='alice'");
    await sql.run("INSERT INTO \"user\"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES('foreign','Foreign','foreign@options.example.test','user',1,0,1,1),('solo','Solo','solo@options.example.test','user',1,0,1,1)");
    await sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('foreign-org','foreign','team',1,2,2)");
    await sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES('foreign-org','foreign','owner','active',1,1,1)");
    await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES('personal-foreign','foreign-org','personal','foreign','personal-foreign','Private foreign', 'active',1,1),('personal-solo',$1,'personal','solo','personal-solo','Solo workspace','active',1,1),('foreign-team','foreign-org','team',NULL,'foreign-team','Foreign team','active',1,1)", [organizationId]);
    await sql.run("INSERT INTO canvas_projects(id,organization_id,name,slug,status,created_at,updated_at) VALUES('own-project',$1,'Own active project','own-project','active',1,1),('foreign-project','foreign-org','Foreign private project','foreign-project','active',1,1)", [organizationId]);

    const localSource = path.join(fixture.root, 'owned-source');
    await fs.mkdir(path.join(localSource, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(localSource, 'skills', 'options-child'), { recursive: true });
    await fs.writeFile(path.join(localSource, 'skills', 'options-child', 'SKILL.md'), '---\nname: options-child\ndescription: Owned collision fixture context\n---\nOwned fixture only.\n');
    await fs.writeFile(path.join(localSource, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'options-occupied', version: '1.0.0', description: 'Owned install options collision fixture', skills: './skills' }));
    await fs.writeFile(path.join(localSource, 'README.md'), 'Owned immutable namespace fixture.\n');
    const installed = await plugins.installCanvasPluginFromPath(localSource, { scope: fixture.organizationScope, enable: false });
    assert(installed.success && installed.plugin?.resourceId, JSON.stringify(installed.validation?.errors) || installed.error || 'Owned fixture installation did not return a resource identity.');
    await resources.configureCapabilityResource(owner, installed.plugin.resourceId, { ownership: { type: 'organization' }, expectedMetadataRevision: 0,
      expectedGrantsRevision: 0, accessMode: 'restricted', grants: [] });

    const snapshot = async () => {
      const records = await Promise.all(['capability_resources', 'capability_resource_grants', 'capability_resource_history',
        'capability_package_states', 'capability_package_versions', 'capability_package_drafts'].map(async table => [table, await sql.all(`SELECT * FROM ${table} ORDER BY 1`)]));
      const files: Array<[string, string]> = [];
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile()) files.push([path.relative(fixture.root, file), createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
        }
      };
      await walk(fixture.root); files.sort((left, right) => left[0].localeCompare(right[0]));
      return { records, files };
    };
    let reads: string[] = [], writes: string[] = [];
    const observed = async <T,>(operation: () => Promise<T>): Promise<T> => {
      reads = []; writes = [];
      fixture.setBeforeRead(async query => { reads.push(query); });
      fixture.setAfterQuery(async query => { writes.push(query); });
      try { return await operation(); }
      finally {
        fixture.setBeforeRead(undefined); fixture.setAfterQuery(undefined);
        assert(writes.every(query => /^(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(query.trim())), 'Options use transaction/locks, never a SQL data mutation.');
      }
    };
    const initial = await snapshot();
    for (const kind of ['plugin', 'skill'] as const) {
      const personal = await observed(() => inspect(owner, { ...selection({ type: 'user' }), source: { ...source, kind } }));
      assert.deepEqual(personal.ownership, { type: 'user', ownerUserId: owner.userId, organizationId });
      assert.equal(personal.schemaVersion, 1); assert.equal(personal.ownershipLabel, 'Personal'); assert.deepEqual(personal.source, { ...source, kind });
      assert(personal.targets.users.some(user => user.userId === 'owner')); assert(personal.targets.users.some(user => user.userId === 'bob'));
      for (const excluded of ['alice', 'unassigned', 'foreign', 'solo']) assert(!personal.targets.users.some(user => user.userId === excluded));
      assert(personal.targets.workspaces.some(workspace => workspace.workspaceId === 'personal-owner'));
      assert(!personal.targets.workspaces.some(workspace => ['personal-alice', 'personal-bob', 'personal-manager', 'personal-foreign'].includes(workspace.workspaceId)));
      assert.deepEqual(personal.targets.projects.map(project => project.projectId), ['own-project']);
      for (const targets of Object.values(personal.targets)) assert(targets.length <= 200);
      const organization = await observed(() => inspect(owner, { source: { ...source, kind }, ownership: { type: 'organization' } }));
      assert.deepEqual(organization.ownership, { type: 'organization', organizationId }); assert.equal(organization.ownershipLabel, 'Organization');
      const team = await observed(() => inspect(manager, { source: { ...source, kind }, ownership: { type: 'team', workspaceId: 'store-team' } }));
      assert.deepEqual(team.ownership, { type: 'team', organizationId, workspaceId: 'store-team' }); assert.equal(team.ownershipLabel, 'store-team');
      assert(team.targets.workspaces.some(workspace => workspace.workspaceId === 'personal-manager'));
      assert(!team.targets.workspaces.some(workspace => workspace.workspaceId === 'personal-owner'));
      const memberPersonal = await observed(() => inspect(fixture.actor('bob'), { source: { ...source, kind }, ownership: { type: 'user' } }));
      assert.equal(memberPersonal.ownership.type, 'user'); assert(memberPersonal.targets.users.some(user => user.userId === 'manager'));
    }
    assert.deepEqual(await snapshot(), initial);
    console.log('store-install-options: actual personal/organization/team authority and bounded active directories PASS');

    for (const actor of [alice, fixture.actor('unassigned'), fixture.actor('foreign'), fixture.actor('missing'),
      { userId: 'owner', workspaceId: 'personal-bob' }, { userId: 'owner', workspaceId: 'missing-workspace' }] satisfies CapabilityResourceActor[]) {
      await observed(async () => {
        await assert.rejects(() => inspect(actor, selection({ type: 'organization' })), { status: 403 });
        assert(!reads.some(query => /JOIN organization_user_permissions p ON p\.user_id=u\.id/iu.test(query)), 'Denied actors never query the target directory.');
      });
    }
    for (const entryKey of [source.entryKey, 'options-occupied']) {
      for (const actor of [fixture.actor('bob'), alice]) {
        await observed(async () => {
          await assert.rejects(() => inspect(actor, selection({ type: 'organization' }, entryKey)), { code: 'PACKAGE_ACCESS_DENIED', status: 403 });
          assert(!reads.some(query => /SELECT \* FROM capability_resources WHERE resource_ref/iu.test(query)), 'Target denial precedes occupied/free namespace lookup.');
        });
      }
    }
    await observed(async () => {
      await assert.rejects(() => inspect(owner, selection({ type: 'organization' }, 'options-occupied')), { code: 'PACKAGE_NAMESPACE_CONFLICT', status: 409 });
      assert(!reads.some(query => /JOIN organization_user_permissions p ON p\.user_id=u\.id/iu.test(query)), 'Authorized namespace conflict discloses no recipient directory.');
    });
    await observed(() => assert.rejects(() => inspect(fixture.actor('bob'), selection({ type: 'team', workspaceId: 'store-team' })), { status: 403 }));
    await observed(() => assert.rejects(() => inspect(manager, selection({ type: 'team', workspaceId: 'other-team' })), { status: 403 }));
    await observed(() => assert.rejects(() => inspect(owner, selection({ type: 'team', workspaceId: 'foreign-team' })), { status: 403 }));
    for (const extra of [{ actorUserId: 'foreign' }, { organizationId: 'foreign-org' }, { resourceRef: installed.plugin.resourceId },
      { ownership: { type: 'user', ownerUserId: 'foreign' } }, { ownership: { type: 'organization', organizationId: 'foreign-org' } },
      { source: { ...source, downloadUrl: registry.baseUrl } }]) {
      await observed(() => assert.rejects(() => inspect(owner, { ...selection({ type: 'user' }), ...extra }), { name: 'ZodError' }));
    }
    assert.deepEqual(await snapshot(), initial);
    console.log('store-install-options: inactive/banned/foreign/context denial, read-only Team and free/occupied indistinguishability PASS');

    const route = await import('../app/api/capabilities/packages/store/install-options/route');
    const request = (userId: string, body: unknown) => new Request('http://localhost/api/capabilities/packages/store/install-options',
      { method: 'POST', headers: fixture.headers(userId), body: JSON.stringify(body) });
    const context = { params: Promise.resolve<Record<string, string>>({}) };
    const http = await observed(() => route.POST(request('owner', selection({ type: 'organization' })), context));
    assert.equal(http.status, 200); const publicBody = await http.json() as { success: boolean; data: { ownership: unknown; targets: unknown } };
    assert.equal(publicBody.success, true); assert.deepEqual(publicBody.data.ownership, { type: 'organization', organizationId });
    const wire = JSON.stringify(publicBody);
    for (const field of ['storeOrigin', 'downloadUrl', 'installDir', 'sourcePath', 'connectedAccountId', 'backend', 'accessToken']) assert(!wire.includes(`"${field}"`));
    for (const entryKey of [source.entryKey, 'options-occupied']) assert.equal((await observed(() => route.POST(request('bob', selection({ type: 'organization' }, entryKey)), context))).status, 403);
    assert.equal((await observed(() => route.POST(request('owner', selection({ type: 'organization' }, 'options-occupied')), context))).status, 409);
    assert.equal((await observed(() => route.POST(request('owner', { ...selection({ type: 'user' }), actorUserId: 'foreign' }), context))).status, 400);
    assert.equal((await observed(() => route.POST(new Request('http://localhost/api/capabilities/packages/store/install-options', { method: 'POST', body: '{}' }), context))).status, 401);
    const mobile = await import('../app/api/mobile/v1/extensions/packages/store/install-options/route');
    const mobileResult = await observed(() => mobile.POST(request('owner', selection({ type: 'organization' })), context));
    assert.equal(mobileResult.status, 200); assert.deepEqual(await mobileResult.json(), publicBody);
    assert.deepEqual(await snapshot(), initial);

    const agents = await import('../app/lib/agents/registry'), { piSessions } = await import('../app/lib/db/schema');
    const { createCapabilityPackageTools } = await import('../app/lib/pi/scoped-tools');
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const toolName = 'inspect_canvas_package_store_install_options';
    const actorTools = [];
    for (const userId of ['owner', 'bob']) {
      const agentId = `options-agent-${userId}`, sessionId = `options-session-${userId}`;
      await agents.createAgentProfile({ agentId, name: 'Install options reader', scopeType: 'user', ownerUserId: userId,
        organizationId, createdByUserId: userId, enabledTools: [toolName] });
      await fixture.database.db.insert(piSessions).values({ sessionId, userId, agentId, workspaceId: `personal-${userId}`,
        workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
      const current = await resolveAgentExecutionContextForStoredSession({ userId, agentId, sessionId });
      const tool = createCapabilityPackageTools(userId, agentId, sessionId).find(candidate => candidate.name === toolName); assert.ok(tool);
      actorTools.push({ userId, current, tool });
    }
    const toolBefore = await snapshot(), ownerTool = actorTools[0], memberTool = actorTools[1];
    const toolResponse = await observed(() => runWithAgentExecutionContext(ownerTool.current, () => ownerTool.tool.execute('options-reader', selection({ type: 'organization' }))));
    const actualTool = toolResponse.details as { code?: string; capabilityPackage?: { result: unknown } };
    assert.equal(actualTool.code, undefined); assert.deepEqual(actualTool.capabilityPackage?.result, publicBody.data);
    const forgedTool = await observed(() => runWithAgentExecutionContext(ownerTool.current, () => ownerTool.tool.execute('options-forged-actor',
      { ...selection({ type: 'user' }), actorUserId: 'foreign' })));
    assert.equal((forgedTool.details as { code: string }).code, 'PACKAGE_REQUEST_INVALID');
    const memberDenied = await observed(() => runWithAgentExecutionContext(memberTool.current, () => memberTool.tool.execute('options-read-team', selection({ type: 'team', workspaceId: 'store-team' }))));
    assert.equal((memberDenied.details as { code: string }).code, 'PACKAGE_ACCESS_DENIED');
    const noContext = await observed(() => ownerTool.tool.execute('options-no-context', selection({ type: 'user' })));
    assert.equal((noContext.details as { code: string }).code, 'PACKAGE_ACCESS_DENIED');
    assert.deepEqual(await snapshot(), toolBefore);
    console.log('store-install-options: actual web/mobile BetterAuth routes and current PI Session/AgentTool boundaries PASS');

    // The disposable in-memory PGlite database now models a standalone instance with no organization.
    assert.equal(fixture.native, false);
    await sql.run('TRUNCATE canvas_organization_settings CASCADE');
    const standaloneBefore = await snapshot();
    const standaloneActor = { userId: 'solo' };
    const standalone = await observed(() => inspect(standaloneActor, selection({ type: 'user' })));
    assert.deepEqual(standalone.ownership, { type: 'user', ownerUserId: 'solo', organizationId: null });
    assert.deepEqual(standalone.targets, { users: [], workspaces: [], projects: [] });
    await observed(() => assert.rejects(() => inspect(standaloneActor, selection({ type: 'organization' })), { status: 403 }));
    assert.deepEqual(await snapshot(), standaloneBefore);
    assert.equal(registry.count('registry:application'), 0); assert.equal(registry.count('archive'), 0); assert.equal(fixture.providerRequests(), 0);
    console.log('capability-package-store-install-options-test: PASS (real PGlite/held authority/BetterAuth HTTP, no source/proxy HTTP, no SQL/package/draft/preference/pointer mutations)');
  } finally { await fixture.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.stack : 'Store install options fixture failed.'); process.exitCode = 1; });
