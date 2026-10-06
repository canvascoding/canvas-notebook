import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-resource-actions-'));
  process.env.DATA = root;
  process.env.CANVAS_DATA_ROOT = root;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('base64url');
  process.env.QMD_ENABLED = 'false';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  const database = await createPiTestDatabase();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    // Metadata requests do not run a model; only that boundary is replaced.
    // Package installation, actor/membership/target authority, grants and audit remain real.
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    return original(name, parent, isMain);
  };
  const connection = await database.openDb();
  try {
    for (const id of ['owner', 'reader-a', 'reader-b', 'editor', 'unassigned', 'foreign']) {
      await connection.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@resource-actions.example.test`]);
    }
    await connection.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org-a','owner','team',1,1000,1000)");
    for (const id of ['owner', 'reader-a', 'reader-b', 'editor', 'unassigned']) {
      await connection.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org-a',$1,$2,'active',$3,1000,1000)", [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    }
    await connection.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-a','org-a','team','team-a','Team A','active',1000,1000)");
    const { installCanvasPluginFromPath, getCanvasPlugin, computeCanvasPluginChecksum } = await import('../app/lib/plugins/canvas-plugin-registry');
    const createPackage = async (name: string) => {
      const directory = path.join(root, 'packages', name);
      await fs.mkdir(path.join(directory, '.canvas-plugin'), { recursive: true });
      await fs.mkdir(path.join(directory, 'skills', `${name}-context`), { recursive: true });
      await fs.writeFile(path.join(directory, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Resource access fixture', skills: 'skills' }));
      await fs.writeFile(path.join(directory, 'skills', `${name}-context`, 'SKILL.md'), `---\nname: ${name}-context\ndescription: Resource fixture context\n---\n\nPrivate package contents for ${name}.\n`);
      return directory;
    };
    const orgScope = { scopeType: 'organization' as const, organizationId: 'org-a' };
    const ownScope = { scopeType: 'user' as const, userId: 'owner' };
    const org = await installCanvasPluginFromPath(await createPackage('resource-governance'), { scope: orgScope, enable: true });
    assert(org.success && org.plugin?.resourceId, JSON.stringify(org.validation?.errors));
    const sharedPersonal = await installCanvasPluginFromPath(await createPackage('personal-shared'), { scope: ownScope, enable: true });
    assert(sharedPersonal.success && sharedPersonal.plugin?.resourceId);
    const privatePersonal = await installCanvasPluginFromPath(await createPackage('personal-private'), { scope: ownScope, enable: true });
    assert(privatePersonal.success && privatePersonal.plugin?.resourceId);
    const actions = await import('../app/lib/capabilities/resources/actions');
    const owner = { userId: 'owner' };
    const configuredPrivate = await actions.configureCapabilityResource(owner, privatePersonal.plugin.resourceId, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, metadata: { displayName: 'Private package' },
    });
    assert.equal(configuredPrivate.metadata.ownership.type, 'user', 'Omitted ownership adopts the actual installed scope');
    assert.equal(configuredPrivate.metadata.ownership.type === 'user' && configuredPrivate.metadata.ownership.ownerUserId, 'owner');
    const legacy = org.plugin.resourceId;
    const initial = await actions.inspectCapabilityResource(owner, legacy);
    assert.equal(initial.metadata.metadataRevision, 0);
    assert.equal(initial.access.canManage, true);
    assert.deepEqual(initial.grants, []);
    assert((await actions.listCapabilityResourceTargets(owner, legacy)).users.some(user => user.userId === 'reader-a'));
    const grant = (targetId: string, rights: { canUse?: boolean; canEdit?: boolean } = {}) => ({ targetType: 'user' as const, targetId,
      canUse: rights.canUse === true, canEdit: rights.canEdit === true, canManage: false });
    const configured = await actions.configureCapabilityResource(owner, legacy, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'team', workspaceId: 'team-a' }, accessMode: 'restricted',
      metadata: { displayName: 'Shared Design Workflow', responsibleUserId: 'editor' },
      grants: [grant('reader-a', { canUse: true }), grant('reader-b', { canUse: true }), grant('editor', { canEdit: true })],
    });
    const ref = configured.metadata.resourceRef;
    assert.notEqual(ref, legacy);
    assert.equal(configured.metadata.legacyResourceId, legacy);
    assert.deepEqual(configured.metadata.ownership, { type: 'team', organizationId: 'org-a', workspaceId: 'team-a' });
    assert.equal(configured.ownershipLabel, 'Team A');
    assert.deepEqual(configured.people?.responsible, { userId: 'editor', name: 'editor' });
    assert.deepEqual(configured.people?.createdBy, { userId: 'owner', name: 'owner' });
    assert.equal((await actions.inspectCapabilityResource(owner, legacy)).metadata.resourceRef, ref, 'Legacy references remain exact aliases');
    for (const userId of ['reader-a', 'reader-b']) {
      const inspect = await actions.inspectCapabilityResource({ userId }, ref);
      assert.equal(inspect.access.canUse, true);
      assert.equal(inspect.access.canEdit, false);
      assert.equal(inspect.access.canManage, false);
      assert.equal(inspect.grants, undefined, 'Readers never receive other principal grants');
      assert.equal(inspect.ownershipLabel, 'Team A', 'A reader can name this team without directory access');
      assert.equal(inspect.people?.responsible?.name, 'editor');
      assert(!JSON.stringify(inspect.people).includes('foreign'), 'Labels name only existing references');
      assert(!JSON.stringify(inspect.people).includes('@'), 'Referenced labels contain no email addresses');
      await assert.rejects(actions.listCapabilityResourceTargets({ userId }, ref));
      await assert.rejects(actions.updateCapabilityResource({ userId }, ref, {
        expectedMetadataRevision: configured.metadata.metadataRevision, expectedGrantsRevision: configured.metadata.grantsRevision,
        metadata: { displayName: 'Unauthorized change' },
      }));
    }
    await assert.rejects(actions.inspectCapabilityResource({ userId: 'unassigned' }, ref));
    await assert.rejects(actions.inspectCapabilityResource({ userId: 'foreign' }, ref));
    assert(!(await actions.listCapabilityResources({ userId: 'unassigned' })).some(value => value.metadata.resourceRef === ref));
    const editor = await actions.inspectCapabilityResource({ userId: 'editor' }, ref);
    assert.equal(editor.access.canRead, true);
    assert.equal(editor.access.canUse, false, 'Package editing does not grant runtime execution');
    assert.equal(editor.access.canEdit, true);
    assert.equal(editor.access.canManage, false);
    const edited = await actions.updateCapabilityResource({ userId: 'editor' }, ref, {
      expectedMetadataRevision: editor.metadata.metadataRevision, expectedGrantsRevision: editor.metadata.grantsRevision,
      metadata: { description: 'Changed through the shared action' },
    });
    assert.equal(edited.metadata.updatedByUserId, 'editor');
    assert.equal(edited.metadata.metadataRevision, editor.metadata.metadataRevision + 1);
    assert.equal(edited.metadata.grantsRevision, editor.metadata.grantsRevision);
    await assert.rejects(actions.updateCapabilityResource({ userId: 'editor' }, ref, {
      expectedMetadataRevision: edited.metadata.metadataRevision, expectedGrantsRevision: edited.metadata.grantsRevision,
      metadata: { responsibleUserId: 'reader-a' },
    }), { code: 'RESOURCE_ACCESS_DENIED', status: 403 });
    assert.deepEqual((await actions.inspectCapabilityResource({ userId: 'reader-b' }, ref)).people?.updatedBy, { userId: 'editor', name: 'editor' });
    await assert.rejects(actions.updateCapabilityResource(owner, ref, {
      expectedMetadataRevision: editor.metadata.metadataRevision, expectedGrantsRevision: editor.metadata.grantsRevision,
      metadata: { displayName: 'Stale editor write' },
    }));
    for (const extra of [{ actorUserId: 'owner' }, { ownerUserId: 'owner' }, { organizationId: 'org-a' }, { ownership: { type: 'user' } }, { storage: { scopeType: 'user' } }]) {
      await assert.rejects(actions.updateCapabilityResource({ userId: 'reader-a' }, ref, {
        expectedMetadataRevision: edited.metadata.metadataRevision, expectedGrantsRevision: edited.metadata.grantsRevision,
        metadata: { displayName: 'Forged request' }, ...extra,
      }), /supported fields/);
    }
    const revoked = await actions.updateCapabilityResource(owner, ref, {
      expectedMetadataRevision: edited.metadata.metadataRevision, expectedGrantsRevision: edited.metadata.grantsRevision,
      grants: [grant('reader-b', { canUse: true }), grant('editor', { canEdit: true })],
    });
    assert.equal(revoked.metadata.metadataRevision, edited.metadata.metadataRevision);
    assert.equal(revoked.metadata.grantsRevision, edited.metadata.grantsRevision + 1);
    await assert.rejects(actions.inspectCapabilityResource({ userId: 'reader-a' }, ref), 'Revocation is fresh');
    const shared = await actions.configureCapabilityResource(owner, sharedPersonal.plugin.resourceId, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'user' }, accessMode: 'restricted', grants: [grant('reader-b', { canUse: true })],
    });
    assert.equal(shared.metadata.ownership.type, 'user');
    assert.equal(shared.metadata.ownership.type === 'user' && shared.metadata.ownership.organizationId, 'org-a');
    assert.equal((await actions.inspectCapabilityResource({ userId: 'reader-b' }, shared.metadata.resourceRef)).people?.owner?.name, 'owner');
    const sharedList = await actions.listCapabilityResources({ userId: 'reader-b' });
    assert(sharedList.some(value => value.metadata.resourceRef === shared.metadata.resourceRef));
    assert(!sharedList.some(value => value.artifact.name === 'personal-private'), 'One personal share never lists the owner directory');
    await assert.rejects(actions.inspectCapabilityResource({ userId: 'reader-b' }, privatePersonal.plugin.resourceId));
    const child = sharedList.find(value => value.artifact.sourcePluginId === legacy);
    if (child) { assert.equal(child.access.canManage, false); assert.equal(child.access.canEdit, false); }
    const core = sharedList.find(value => value.artifact.sourceType === 'core');
    assert(core);
    assert.equal(core.people, undefined, 'Core packages never expose a user directory');
    await assert.rejects(actions.updateCapabilityResource(owner, core.metadata.resourceRef, { expectedMetadataRevision: 0, expectedGrantsRevision: 0, metadata: { displayName: 'Change bundled core' } }), /owning plugin|variant/);
    await actions.updateCapabilityResource({ userId: 'editor' }, ref, {
      expectedMetadataRevision: revoked.metadata.metadataRevision, expectedGrantsRevision: revoked.metadata.grantsRevision,
      metadata: { description: 'Attributed before membership suspension' },
    });
    await connection.run("UPDATE organization_user_permissions SET status='suspended' WHERE user_id='editor'");
    assert.equal((await actions.inspectCapabilityResource({ userId: 'reader-b' }, ref)).people?.updatedBy?.name, 'editor', 'Former editors remain attributed without directory access');
    await connection.run("UPDATE canvas_workspaces SET status='disabled' WHERE id='team-a'");
    await assert.rejects(actions.inspectCapabilityResource({ userId: 'reader-b' }, ref), 'Disabled owner team blocks the resource');
    const installed = await getCanvasPlugin('resource-governance', orgScope);
    assert.equal(installed?.version, org.plugin.version);
    assert.equal(installed?.checksum, org.plugin.checksum);
    assert.equal(await computeCanvasPluginChecksum(org.plugin.installDir), org.plugin.checksum, 'Metadata and grants never mutate published artifact contents');
    assert(!JSON.stringify(sharedList).includes(root), 'Public DTOs contain no storage paths');
    assert(!JSON.stringify(sharedList).includes('Private package contents'), 'Inspect never leaks package bodies');
    console.log('PASS actual PG + installed-package resource actions: targeted team/personal shares, independent rights, editor audit, immutable aliases/artifacts, strict model fields, revisions, revocation and safe DTOs');
  } finally {
    loader._load = original;
    await connection.close();
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
