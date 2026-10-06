import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft } from '../app/lib/capabilities/packages/contracts';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-script-authorization-'));
  const settings = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'script-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', BASE_URL: 'http://localhost:3001', BETTER_AUTH_BASE_URL: 'http://localhost:3001',
    QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, mainModule) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    // Only the DB transport and unused model/prompt transports are fixtures.
    // Package installation, sessions, agents, ACLs, policies and bytes are real.
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    return original(name, parent, mainModule);
  };
  try {
    for (const id of ['owner', 'alice', 'outsider']) await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,0,1,1)', [id, `${id}@script.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('script-org','owner','team',1,1,1)");
    for (const id of ['owner', 'alice', 'outsider']) await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('script-org',$1,$2,'active',$3,1,1)", [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('script-team','script-org','team','workspaces/script-team/files','Script team','active',1,1)");
    for (const id of ['owner', 'alice', 'outsider']) await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('script-org','script-team',$1,'member','active',1,0,0,1,1)", [id]);
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const resourceStore = await import('../app/lib/capabilities/resources/store');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const agents = await import('../app/lib/agents/registry');
    const scripts = await import('../app/lib/skills/script-runtime/authorization');
    const { DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    const { piSessions } = await import('../app/lib/db/schema');
    const source = path.join(root, 'source', 'script-plugin');
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true });
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'script-plugin', version: '1.0.0', description: 'Versioned script fixture', skills: './skills' }));
    for (const name of ['script-first', 'script-second']) {
      await fs.mkdir(path.join(source, 'skills', name, '.canvas-skill'), { recursive: true });
      await fs.mkdir(path.join(source, 'skills', name, 'scripts'));
      await fs.writeFile(path.join(source, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Versioned script fixture\nmetadata:\n  version: "1.0.0"\n---\n\nUse the declared render script.\n`);
      await fs.writeFile(path.join(source, 'skills', name, 'scripts/main.js'), `process.stdout.write('version-one-${name}');\n`);
      await fs.writeFile(path.join(source, 'skills', name, 'scripts/helper.js'), 'module.exports = 1;\n');
      await fs.writeFile(path.join(source, 'skills', name, '.canvas-skill/runtime.json'), JSON.stringify({ version: 1, scripts: [{ id: 'render',
        runtime: { kind: 'node', minimumVersion: '22.0.0' }, path: 'scripts/main.js', argumentsSchema: { type: 'object', additionalProperties: false },
        tools: [{ alias: 'design', kind: 'integration', source: 'composio', application: 'canva', toolName: 'CANVA_GET_DESIGN' }],
        outputs: ['render.png'], dependencies: [{ kind: 'bundled', path: 'scripts/helper.js' }] }] }));
    }
    const installed = await registry.installCanvasPluginFromPath(source, { scope: { scopeType: 'organization', organizationId: 'script-org' }, enable: true, installedBy: 'owner' });
    assert(installed.success && installed.plugin?.resourceId, installed.error || 'Actual plugin installation failed.');
    const owner = { userId: 'owner', workspaceId: 'script-team' }, alice = { userId: 'alice', workspaceId: 'script-team' };
    const adopted = await resources.configureCapabilityResource(owner, installed.plugin.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'team', workspaceId: 'script-team' }, accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    const ref = adopted.metadata.resourceRef;
    const edit = (descriptor: CapabilityPackageDescriptor) => ({ operation: 'edit' as const, resourceRef: ref,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state?.packageRevision ?? 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const publish = (draft: CapabilityPackageDraft, descriptor: CapabilityPackageDescriptor) => ({ draftRef: draft.draftRef,
      expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: descriptor.resource.metadataRevision,
      expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: descriptor.state?.packageRevision ?? 0,
      expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    await agents.getAgentProfile(DEFAULT_MANAGED_AGENT_ID);
    await agents.createAgentProfile({ name: 'Script specialist', agentId: 'script-specialist', scopeType: 'user', ownerUserId: 'alice', organizationId: 'script-org', createdByUserId: 'alice', relevantSkills: ['script-first'] });
    for (const [sessionId, userId, agentId] of [['script-held', 'alice', DEFAULT_MANAGED_AGENT_ID], ['script-next', 'alice', DEFAULT_MANAGED_AGENT_ID],
      ['script-fork', 'alice', DEFAULT_MANAGED_AGENT_ID], ['script-selected', 'alice', 'script-specialist'], ['script-foreign', 'outsider', DEFAULT_MANAGED_AGENT_ID]]) {
      await database.db.insert(piSessions).values({ sessionId, userId, agentId, workspaceId: 'script-team', workspaceType: 'team', organizationId: 'script-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    }
    const { setCapabilityPreference } = await import('../app/lib/capabilities/preference-store');
    await setCapabilityPreference({ userId: 'alice', resourceId: installed.plugin.resourceId, enabled: true });
    const unversioned = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'script-held', agentId: DEFAULT_MANAGED_AGENT_ID });
    assert.deepEqual(await scripts.listAuthorizedSkillScripts(unversioned), [], 'Legacy/core roots never become implicit executable snapshots.');
    const descriptor = await packages.inspectCapabilityPackage(owner, ref);
    const initial = await packages.createCapabilityPackageDraftAction(owner, edit(descriptor));
    const first = await packages.publishCapabilityPackageDraftAction(owner, publish(initial, descriptor));
    const held = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'script-held', agentId: DEFAULT_MANAGED_AGENT_ID });
    const authorized = await scripts.listAuthorizedSkillScripts(held);
    assert.equal(authorized.length, 2);
    assert.equal(new Set(authorized.map(value => value.scriptRef)).size, 2, 'Same script IDs in two plugin children remain separate.');
    assert(authorized.every(value => value.binding.publishedRevisionRef === first.published.revisionRef));
    const one = authorized.find(value => value.binding.skillName === 'script-first')!;
    assert.equal(one.packageRoot, await fs.realpath(path.dirname(one.binding.runtimePath)));
    assert.equal(one.entryPath, path.join(one.packageRoot, 'scripts/main.js'));
    assert.equal(one.manifestChecksum, createHash('sha256').update(await fs.readFile(path.join(one.packageRoot, '.canvas-skill/runtime.json'))).digest('hex'));
    assert.equal((await scripts.authorizeSkillScript(held, one.scriptRef)).scriptRef, one.scriptRef);
    // The public reference alone cannot reconstruct a private held package receipt.
    assert.deepEqual(await scripts.listAuthorizedSkillScripts(JSON.parse(JSON.stringify(held))), []);
    const foreign = await sessions.resolveAgentExecutionContextForSession({ userId: 'outsider', sessionId: 'script-foreign', agentId: DEFAULT_MANAGED_AGENT_ID });
    assert.deepEqual(await scripts.listAuthorizedSkillScripts({ ...foreign, skillPackageBindings: held.skillPackageBindings }), []);
    for (const changes of [{ sessionId: 'script-next' }, { agentId: 'script-specialist' }]) {
      assert.deepEqual(await scripts.listAuthorizedSkillScripts({ ...held, ...changes }), [], 'Issued receipt identity is exact.');
    }
    await assert.rejects(scripts.listAuthorizedSkillScripts({ ...held, workspaceId: 'other-workspace' }), /Workspace not found or inaccessible/u);
    await assert.rejects(scripts.authorizeSkillScript(held, 'render'), { code: 'SCRIPT_NOT_FOUND' });

    const current = await packages.inspectCapabilityPackage(owner, ref);
    let nextDraft = await packages.createCapabilityPackageDraftAction(owner, edit(current));
    for (const name of ['script-first', 'script-second']) nextDraft = (await packages.writeCapabilityPackageDraftFileAction(owner, nextDraft.draftRef,
      { expectedDraftRevision: nextDraft.draftRevision, path: `skills/${name}/scripts/main.js`, encoding: 'base64', content: Buffer.from(`process.stdout.write('version-two-${name}');\n`).toString('base64') })).draft;
    const second = await packages.publishCapabilityPackageDraftAction(owner, publish(nextDraft, current));
    const next = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'script-next', agentId: DEFAULT_MANAGED_AGENT_ID });
    const nextScripts = await scripts.listAuthorizedSkillScripts(next);
    assert(nextScripts.every(value => value.binding.publishedRevisionRef === second.published.revisionRef));
    assert(!nextScripts.some(value => value.scriptRef === one.scriptRef), 'New version changes the opaque script reference.');
    const retained = await scripts.authorizeSkillScript(held, one.scriptRef);
    assert.equal(retained.entryPath, one.entryPath);
    assert.match(await fs.readFile(retained.entryPath, 'utf8'), /version-one/u, 'An issued v1 never silently executes v2.');
    const selected = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'script-selected', agentId: 'script-specialist' });
    assert.equal((await scripts.listAuthorizedSkillScripts(selected)).length, 1);
    await agents.updateAgentProfile({ agentId: 'script-specialist', relevantSkills: ['script-second'] });
    assert.deepEqual(await scripts.listAuthorizedSkillScripts(selected), [], 'Fresh agent selection revokes a previously selected child.');

    const childDescriptor = (await resources.listCapabilityResources(alice)).find(value => value.artifact.resourceType === 'skill' && value.artifact.name === 'script-first')!;
    const childPackage = await packages.inspectCapabilityPackage(alice, childDescriptor.metadata.resourceRef);
    const fork = await packages.createCapabilityPackageDraftAction(alice, { operation: 'fork', resourceRef: childPackage.resource.resourceRef,
      targetName: 'script-personal-fork', ownership: { type: 'user' }, expectedSourceMetadataRevision: childPackage.resource.metadataRevision,
      expectedSourceGrantsRevision: childPackage.resource.grantsRevision, expectedSourcePackageRevision: childPackage.state?.packageRevision ?? 0,
      expectedSourcePublishedRevisionRef: childPackage.state?.currentPublishedRevisionRef ?? null });
    const forked = await packages.publishCapabilityPackageDraftAction(alice, { draftRef: fork.draftRef, expectedDraftRevision: fork.draftRevision,
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    let forkContext = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'script-fork', agentId: DEFAULT_MANAGED_AGENT_ID });
    assert(!(await scripts.listAuthorizedSkillScripts(forkContext)).some(value => value.binding.resourceRef === forked.state.resourceRef), 'Installed disabled variants grant no execution.');
    const { writeEnabledSkillsForScope } = await import('../app/lib/skills/skill-settings');
    await writeEnabledSkillsForScope(['script-personal-fork'], { scope: { userId: 'alice' }, updatedBy: 'alice' });
    forkContext = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'script-fork', agentId: DEFAULT_MANAGED_AGENT_ID });
    const own = (await scripts.listAuthorizedSkillScripts(forkContext)).find(value => value.binding.skillName === 'script-personal-fork')!;
    assert(own && own.binding.childRelativeRoot === '', 'Published standalone skills use the same receipt contract.');
    const { withCapabilityPolicyStore } = await import('../app/lib/capabilities/policy-store');
    await withCapabilityPolicyStore(store => store.upsertPolicy({ organizationId: 'script-org', resourceType: 'skill', resourceId: own.binding.resourceId,
      targetType: 'user', targetId: 'alice', effect: 'blocked', actorUserId: 'owner', expectedRevision: 0 }));
    await assert.rejects(scripts.authorizeSkillScript(forkContext, own.scriptRef), { code: 'SCRIPT_NOT_FOUND' }, 'Fresh blocked policy overrides held bytes and activation.');

    const oldBytes = await fs.readFile(one.entryPath);
    await fs.chmod(one.entryPath, 0o600); await fs.writeFile(one.entryPath, 'tampered old revision\n');
    await assert.rejects(scripts.authorizeSkillScript(held, one.scriptRef), { code: 'SCRIPT_NOT_FOUND' });
    await fs.writeFile(one.entryPath, oldBytes); await fs.chmod(one.entryPath, 0o400);
    const newest = nextScripts.find(value => value.binding.skillName === 'script-first')!;
    const newestBytes = await fs.readFile(newest.entryPath);
    await fs.chmod(newest.entryPath, 0o600); await fs.writeFile(newest.entryPath, 'tampered current head\n');
    assert.deepEqual(await scripts.listAuthorizedSkillScripts(held), [], 'A broken current resource closes every old version.');
    await fs.writeFile(newest.entryPath, newestBytes); await fs.chmod(newest.entryPath, 0o400);
    assert.equal((await scripts.listAuthorizedSkillScripts(held)).length, 2);
    const managerOnly = await resourceStore.mutateCapabilityResource(owner, ref, { expectedMetadataRevision: adopted.metadata.metadataRevision,
      expectedGrantsRevision: adopted.metadata.grantsRevision, grants: [{ targetType: 'user', targetId: 'alice', canUse: false, canEdit: true, canManage: true }] });
    assert.equal(managerOnly.metadata.grantsRevision, adopted.metadata.grantsRevision + 1);
    assert.deepEqual(await scripts.listAuthorizedSkillScripts(held), [], 'Edit/manage grants never imply execution rights.');
    await assert.rejects(scripts.authorizeSkillScript(held, one.scriptRef), { code: 'SCRIPT_NOT_FOUND' });
    console.log('PASS actual PGlite/package/session skill script authorization: exact child/version references, private receipts, standalone activation, live selection/policy/ACL and full-byte integrity. No process launch was part of this gate.');
  } finally {
    loader._load = original;
    await raw.close(); await database.close();
    async function unlock(directory: string): Promise<void> {
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) { await fs.chmod(directory, 0o700); for (const entry of await fs.readdir(directory)) await unlock(path.join(directory, entry)); }
    }
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
