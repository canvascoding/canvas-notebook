import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function removeFixtureRoot(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  await fs.chmod(root, 0o700);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await removeFixtureRoot(path.join(root, entry.name));
  }
  await fs.rm(root, { recursive: true, force: true });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-package-artifacts-'));
  const keys = ['DATA', 'CANVAS_DATA_ROOT', 'QMD_ENABLED', 'CANVAS_MCP_DIRECT_ENABLED', 'BASE_URL', 'BETTER_AUTH_BASE_URL'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATA: root, CANVAS_DATA_ROOT: root, QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BASE_URL: 'http://127.0.0.1:3000', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:3000' });
  const database = await createPiTestDatabase(), db = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    return original(name, parent, isMain);
  };
  try {
    for (const id of ['owner', 'editor', 'unassigned']) await db.run(
      'INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@artifacts.example.test`]);
    await db.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org-artifacts','owner','team',1,1000,1000)");
    for (const id of ['owner', 'editor', 'unassigned']) await db.run(
      "INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org-artifacts',$1,$2,'active',$3,1000,1000)",
      [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    await db.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ('personal-editor','org-artifacts','personal','editor','personal-editor','Editor','active',1000,1000)");
    const packageRoot = path.join(root, 'package');
    await fs.mkdir(path.join(packageRoot, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(packageRoot, 'skills', 'artifact-child', 'scripts'), { recursive: true });
    await fs.mkdir(path.join(packageRoot, 'assets'), { recursive: true });
    const manifest = { name: 'artifact-package', version: '1.0.0', description: 'Full package fixture', skills: 'skills' };
    await fs.writeFile(path.join(packageRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(packageRoot, 'skills', 'artifact-child', 'SKILL.md'), '---\nname: artifact-child\ndescription: Full package fixture\nmetadata:\n  version: "1.0.0"\n---\n\nFixture package body.\n');
    await fs.writeFile(path.join(packageRoot, 'skills', 'artifact-child', 'scripts', 'run.py'), 'print("fixture")\n');
    await fs.writeFile(path.join(packageRoot, 'assets', 'pixel.bin'), Buffer.from([0, 1, 255]));
    const artifacts = await import('../app/lib/capabilities/packages/artifacts');
    const validation = await artifacts.validateCapabilityPackage('plugin', packageRoot, { name: manifest.name, version: '1.0.0' });
    assert.equal(validation.valid, true);
    assert(validation.files.some(file => file.path === 'assets/pixel.bin' && file.size === 3));
    assert(validation.files.some(file => file.path === 'skills/artifact-child/scripts/run.py'));
    await fs.writeFile(path.join(packageRoot, '.env'), 'PROVIDER_KEY=fixture\n');
    assert.equal((await artifacts.validateCapabilityPackage('plugin', packageRoot)).valid, false);
    await fs.rm(path.join(packageRoot, '.env'));
    await fs.symlink('/tmp', path.join(packageRoot, 'outside'));
    await assert.rejects(artifacts.validateCapabilityPackage('plugin', packageRoot));
    await fs.rm(path.join(packageRoot, 'outside'));
    await fs.writeFile(path.join(packageRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({ ...manifest, skillRefs: [{ name: 'skill-creator', source: 'seed' }] }));
    assert.equal((await artifacts.validateCapabilityPackage('plugin', packageRoot)).valid, false, 'External child content cannot be published as a complete immutable parent');
    await fs.writeFile(path.join(packageRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify(manifest));
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const installed = await registry.installCanvasPluginFromPath(packageRoot, { scope: { scopeType: 'organization', organizationId: 'org-artifacts' }, enable: true });
    assert(installed.success && installed.plugin?.resourceId);
    const resource = await import('../app/lib/capabilities/resources/actions');
    let configured = await resource.configureCapabilityResource({ userId: 'owner' }, installed.plugin.resourceId, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: 'editor', canUse: false, canEdit: true, canManage: false }],
    });
    const exact = await artifacts.resolveCapabilityPackageArtifact({ userId: 'editor' }, configured.metadata.resourceRef);
    assert.equal(exact.descriptor.access.canEdit, true);
    assert.equal(exact.sourceStamp.checksum, validation.checksum);
    assert.equal(exact.storage.organizationId, 'org-artifacts');
    await assert.rejects(artifacts.resolveCapabilityPackageArtifact({ userId: 'unassigned' }, configured.metadata.resourceRef));
    const child = exact.candidates.find(candidate => candidate.ref.sourceType === 'plugin' && candidate.ref.name === 'artifact-child')!;
    const childSource = await artifacts.resolveCapabilityPackageArtifact({ userId: 'editor' }, child.ref.resourceId);
    assert.equal(childSource.readOnly, true);
    assert.equal(childSource.descriptor.access.canRead, true);
    assert.equal(childSource.sourceStamp.parentResourceRef, configured.metadata.resourceRef);
    assert.equal(childSource.sourceStamp.relativeRoot, 'skills/artifact-child');
    const tools = await import('../app/lib/pi/scoped-tools');
    const execution = await import('../app/lib/pi/agent-execution-context');
    const progressive = await import('../app/lib/pi/progressive-tool-gateway');
    const gateway = progressive.createProgressiveGatewayTool(progressive.PROGRESSIVE_GATEWAY_DEFINITIONS.find(value => value.name === 'canvas_extensions')!,
      tools.createUserScopedTools('editor', 'package-agent', 'package-session'));
    const context = { userId: 'editor', agentId: 'package-agent', sessionId: 'package-session', workspaceId: 'personal-editor',
      organizationId: 'org-artifacts', workspaceType: 'personal' as const, workspaceName: 'Editor', customerId: null,
      projectId: null, workspaceRoot: root, workspaceRootRelativePath: null, canWrite: false, canDelete: false, canShare: false, legacy: false };
    const call = (operation: string, args: Record<string, unknown>) => execution.runWithAgentExecutionContext(context,
      () => gateway.execute('fixture', { action: 'call', operation, arguments: args }));
    const result = <T,>(value: unknown): T => {
      const details = (value as { details: { error?: string; capabilityPackage?: { result: T } } }).details;
      assert.equal(details.error, undefined, details.error ?? 'The package operation must succeed.');
      assert(details.capabilityPackage);
      return details.capabilityPackage.result;
    };
    const describe = await gateway.execute('schema', { action: 'describe', operation: 'create_canvas_package_draft' });
    assert(JSON.stringify(describe).includes('expectedPackageRevision'));
    const inspected = result<import('../app/lib/capabilities/packages/contracts').CapabilityPackageDescriptor>(await call('inspect_canvas_package', { resourceRef: configured.metadata.resourceRef }));
    assert.equal(inspected.access.canEdit, true);
    assert.equal(inspected.access.canUse, false);
    const denied = await gateway.execute('unauthenticated', { action: 'call', operation: 'inspect_canvas_package', arguments: { resourceRef: configured.metadata.resourceRef } });
    assert.equal((denied.details as { code: string }).code, 'PACKAGE_ACCESS_DENIED');
    const draft = result<import('../app/lib/capabilities/packages/contracts').CapabilityPackageDraft>(await call('create_canvas_package_draft', {
      operation: 'edit', resourceRef: configured.metadata.resourceRef, expectedMetadataRevision: configured.metadata.metadataRevision,
      expectedGrantsRevision: configured.metadata.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null,
    }));
    const written = result<{ draft: typeof draft }>(await call('write_canvas_package_draft_file', { draftRef: draft.draftRef,
      expectedDraftRevision: draft.draftRevision, path: 'skills/artifact-child/scripts/run.py', encoding: 'base64',
      content: Buffer.from('print("published")\n').toString('base64') }));
    const validated = result<{ validation: { valid: boolean } }>(await call('validate_canvas_package_draft', { draftRef: draft.draftRef }));
    assert.equal(validated.validation.valid, true);
    const published = result<{ state: { packageRevision: number }; published: { revisionRef: string } }>(await call('publish_canvas_package_draft', {
      draftRef: draft.draftRef, expectedDraftRevision: written.draft.draftRevision,
      expectedMetadataRevision: configured.metadata.metadataRevision, expectedGrantsRevision: configured.metadata.grantsRevision,
      expectedPackageRevision: 0, expectedPublishedRevisionRef: null,
    }));
    assert.equal(published.state.packageRevision, 1);
    const scope = { scopeType: 'organization' as const, organizationId: 'org-artifacts' };
    const pointer = (await registry.readCanvasPluginRegistry(scope)).plugins[manifest.name];
    assert.equal(pointer.publishedRevisionRef, published.published.revisionRef);
    assert.equal(pointer.packageManaged, true);
    assert.equal(pointer.installedBy, undefined, 'A content publisher must not invent a historically unknown first installer.');
    assert.equal(await fs.readFile(path.join(pointer.installDir, 'skills/artifact-child/scripts/run.py'), 'utf8'), 'print("published")\n');
    await artifacts.assertCapabilityPackageRegistryPointerCurrent('plugin', pointer, scope);
    const committedState = await db.get('SELECT * FROM capability_package_states WHERE resource_ref=$1', [configured.metadata.resourceRef]) as Record<string, unknown>;
    configured = await resource.updateCapabilityResource({ userId: 'owner' }, configured.metadata.resourceRef, {
      expectedMetadataRevision: configured.metadata.metadataRevision, expectedGrantsRevision: configured.metadata.grantsRevision,
      grants: [{ targetType: 'user', targetId: 'editor', canUse: false, canEdit: true, canManage: false },
        { targetType: 'user', targetId: 'unassigned', canUse: false, canEdit: false, canManage: true }],
    });
    const activation = await import('../app/lib/capabilities/packages/activation');
    const actions = await import('../app/lib/capabilities/packages/actions');
    const manager = await actions.inspectCapabilityPackage({ userId: 'unassigned' }, configured.metadata.resourceRef);
    assert.equal(manager.access.canManage, true);
    assert.equal(manager.access.canUse, false);
    assert.equal(manager.access.canEdit, false);
    const activationRequest = { enabled: false, expectedDefaultEnabled: true,
      expectedPackageRevision: published.state.packageRevision, expectedPublishedRevisionRef: published.published.revisionRef,
      expectedMetadataRevision: configured.metadata.metadataRevision, expectedGrantsRevision: configured.metadata.grantsRevision };
    const managerActivated = await activation.setCapabilityPackageDefaultActivationAction({ userId: 'unassigned' }, configured.metadata.resourceRef, activationRequest);
    assert.equal(managerActivated.enabled, false);
    const disabledPointer = (await registry.readCanvasPluginRegistry(scope)).plugins[manifest.name];
    assert.deepEqual(disabledPointer, { ...pointer, enabled: false }, 'Only the package default flag changes; bytes, head, installer and provenance stay exact.');
    assert.deepEqual(await db.get('SELECT * FROM capability_package_states WHERE resource_ref=$1', [configured.metadata.resourceRef]), committedState,
      'Default activation must not republish or change the package publisher.');
    assert.deepEqual((await resource.inspectCapabilityResource({ userId: 'owner' }, configured.metadata.resourceRef)).metadata, configured.metadata,
      'Default activation does not change metadata, responsibility or grant revisions.');
    await assert.rejects(() => activation.setCapabilityPackageDefaultActivationAction({ userId: 'unassigned' }, configured.metadata.resourceRef, activationRequest), { code: 'PACKAGE_REVISION_CONFLICT' });
    const deniedActivation = await call('set_canvas_package_activation', { ...activationRequest, resourceRef: configured.metadata.resourceRef,
      enabled: true, expectedDefaultEnabled: false });
    assert.equal((deniedActivation.details as { code: string }).code, 'PACKAGE_ACCESS_DENIED', 'Content editors cannot configure default activation.');
    await assert.rejects(() => activation.setCapabilityPackageDefaultActivationAction({ userId: 'unassigned' }, configured.metadata.resourceRef,
      { ...activationRequest, expectedDefaultEnabled: false, enabled: true, actorUserId: 'owner' }), 'Activation arguments cannot supply actor authority.');
    const forgedFlag = await registry.readCanvasPluginRegistry(scope);
    forgedFlag.plugins[manifest.name] = { ...disabledPointer, enabled: true };
    await assert.rejects(() => registry.writeCanvasPluginRegistry(forgedFlag, scope), { code: 'PACKAGE_REVISION_CONFLICT' }, 'A direct legacy registry write cannot impersonate an activation action.');
    await activation.setCapabilityPackageDefaultActivationAction({ userId: 'unassigned' }, configured.metadata.resourceRef,
      { ...activationRequest, expectedDefaultEnabled: false, enabled: true });
    assert.equal((await actions.inspectCapabilityPackage({ userId: 'unassigned' }, configured.metadata.resourceRef)).access.canUse, false,
      'Enabling the default never grants execution rights.');
    await assert.rejects(() => artifacts.assertCapabilityPackageRegistryPointerCurrent('plugin', { ...pointer, installDir: packageRoot }, scope), { code: 'PACKAGE_SNAPSHOT_UNAVAILABLE' });
    await db.run('DELETE FROM capability_package_states WHERE resource_ref=$1', [configured.metadata.resourceRef]);
    await assert.rejects(() => artifacts.assertCapabilityPackageRegistryPointerCurrent('plugin', pointer, scope), { code: 'PACKAGE_SNAPSHOT_UNAVAILABLE' },
      'An orphan filesystem publication must fail closed when no committed SQL head exists.');
    await db.run('INSERT INTO capability_package_states (resource_ref,kind,name,package_revision,current_published_revision_ref,current_source_stamp,updated_by_user_id,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      ['resource_ref', 'kind', 'name', 'package_revision', 'current_published_revision_ref', 'current_source_stamp', 'updated_by_user_id', 'updated_at'].map(key => committedState[key]));
    const sealedScript = path.join(pointer.installDir, 'skills/artifact-child/scripts/run.py');
    await fs.chmod(sealedScript, 0o600); await fs.writeFile(sealedScript, 'print("tampered")\n');
    await assert.rejects(() => artifacts.assertCapabilityPackageRegistryPointerCurrent('plugin', pointer, scope));
    await fs.writeFile(sealedScript, 'print("published")\n'); await fs.chmod(sealedScript, 0o444);
    await artifacts.assertCapabilityPackageRegistryPointerCurrent('plugin', pointer, scope);
    await assert.rejects(() => registry.installCanvasPluginFromPath(packageRoot, { scope, replace: true, enable: false }), { code: 'PACKAGE_REVISION_CONFLICT' });
    await assert.rejects(() => registry.deleteCanvasPlugin(manifest.name, scope), { code: 'PACKAGE_REVISION_CONFLICT' });
    const altered = await registry.readCanvasPluginRegistry(scope); delete altered.plugins[manifest.name];
    await assert.rejects(() => registry.writeCanvasPluginRegistry(altered, scope), { code: 'PACKAGE_REVISION_CONFLICT' });
    const foreign = path.join(root, 'foreign');
    await fs.cp(packageRoot, foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, '.canvas-plugin/plugin.json'), JSON.stringify({ ...manifest, name: 'unrelated-package' }));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const held = artifacts.withCapabilityPackageRegistryPublication(exact.storage, async () => { enter(); await barrier; });
    await entered;
    let completed = false;
    const legacy = registry.installCanvasPluginFromPath(foreign, { scope, enable: false }).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(completed, false, 'An actual legacy installation waits for the held publication scope lock.');
    release(); await held; assert.equal((await legacy).success, true);
    assert.equal((await registry.readCanvasPluginRegistry(scope)).plugins[manifest.name].publishedRevisionRef, published.published.revisionRef);
    const seedPackage = path.join(root, 'seed-package');
    await fs.cp(packageRoot, seedPackage, { recursive: true });
    await fs.writeFile(path.join(seedPackage, '.canvas-plugin/plugin.json'), JSON.stringify({ ...manifest, name: 'artifact-seed-package',
      skillRefs: [{ name: 'skill-creator', source: 'seed' }] }));
    const seedInstalled = await registry.installCanvasPluginFromPath(seedPackage, { scope, enable: false });
    assert(seedInstalled.success && seedInstalled.plugin?.resourceId);
    const seedSource = await artifacts.resolveCapabilityPackageArtifact({ userId: 'owner' }, seedInstalled.plugin.resourceId);
    assert.equal(seedSource.bundledReferences?.length, 1);
    assert.equal(seedSource.sourceStamp.dependencies?.[0].relativeRoot, 'skills/skill-creator');
    const seedDescriptor = await actions.inspectCapabilityPackage({ userId: 'owner' }, seedInstalled.plugin.resourceId);
    const seedDraft = await actions.createCapabilityPackageDraftAction({ userId: 'owner' }, {
      operation: 'fork', resourceRef: seedDescriptor.resource.resourceRef, targetName: 'artifact-seed-copy', ownership: { type: 'organization' },
      expectedSourceMetadataRevision: seedDescriptor.resource.metadataRevision, expectedSourceGrantsRevision: seedDescriptor.resource.grantsRevision,
      expectedSourcePackageRevision: 0, expectedSourcePublishedRevisionRef: null,
    });
    const seedManifest = JSON.parse(Buffer.from((await actions.readCapabilityPackageDraftFileAction({ userId: 'owner' }, seedDraft.draftRef,
      { path: '.canvas-plugin/plugin.json' })).file.content, 'base64').toString()) as { skillRefs?: unknown; skills: string };
    assert.equal(seedManifest.skillRefs, undefined, 'The captured draft no longer follows mutable seed references.');
    assert.equal(path.posix.normalize(seedManifest.skills), 'skills');
    assert.equal((await actions.validateCapabilityPackageDraftAction({ userId: 'owner' }, seedDraft.draftRef)).validation.valid, true);
    const seedPublished = await actions.publishCapabilityPackageDraftAction({ userId: 'owner' }, { draftRef: seedDraft.draftRef,
      expectedDraftRevision: seedDraft.draftRevision, expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const seedPointer = (await registry.readCanvasPluginRegistry(scope)).plugins['artifact-seed-copy'];
    assert.equal(seedPointer.enabled, false);
    const seedInventory = await (await import('../app/lib/capabilities/packages/io')).readExactPackageInventory(seedSource.bundledReferences![0].source.rootPath);
    const script = seedInventory.files.find(file => file.path.startsWith('scripts/'))!;
    assert(script, 'The seed fixture contains actual executable package code.');
    const bundled = await actions.readCapabilityPackageFileAction({ userId: 'owner' }, seedPublished.state.resourceRef,
      { path: `skills/skill-creator/${script.path}` });
    assert.deepEqual(Buffer.from(bundled.file.content, 'base64'), script.bytes, 'The immutable fork retains exact referenced skill code bytes.');
    assert.deepEqual(seedPublished.published.sourceStamp.dependencies, seedSource.sourceStamp.dependencies);
    const personalSource = await actions.inspectCapabilityPackage({ userId: 'owner' }, configured.metadata.resourceRef);
    const personalDraft = await actions.createCapabilityPackageDraftAction({ userId: 'owner' }, {
      operation: 'fork', resourceRef: configured.metadata.resourceRef, targetName: 'artifact-personal-copy', ownership: { type: 'user' },
      expectedSourceMetadataRevision: personalSource.resource.metadataRevision, expectedSourceGrantsRevision: personalSource.resource.grantsRevision,
      expectedSourcePackageRevision: personalSource.state!.packageRevision, expectedSourcePublishedRevisionRef: personalSource.state!.currentPublishedRevisionRef,
    });
    const personalPublished = await actions.publishCapabilityPackageDraftAction({ userId: 'owner' }, { draftRef: personalDraft.draftRef,
      expectedDraftRevision: personalDraft.draftRevision, expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const personalDescriptor = await actions.inspectCapabilityPackage({ userId: 'owner' }, personalPublished.state.resourceRef);
    const personalScope = { scopeType: 'user' as const, userId: 'owner' };
    const personalPointer = (await registry.readCanvasPluginRegistry(personalScope)).plugins['artifact-personal-copy'];
    assert.equal(personalPointer.enabled, false);
    await activation.setCapabilityPackageDefaultActivationAction({ userId: 'owner' }, personalPublished.state.resourceRef, {
      enabled: true, expectedDefaultEnabled: false, expectedPackageRevision: personalPublished.state.packageRevision,
      expectedPublishedRevisionRef: personalPublished.published.revisionRef,
      expectedMetadataRevision: personalDescriptor.resource.metadataRevision, expectedGrantsRevision: personalDescriptor.resource.grantsRevision,
    });
    assert.deepEqual((await registry.readCanvasPluginRegistry(personalScope)).plugins['artifact-personal-copy'], { ...personalPointer, enabled: true },
      'A personal immutable fork has the same guarded default activation path.');
    assert.equal((await actions.inspectCapabilityPackage({ userId: 'owner' }, personalPublished.state.resourceRef)).access.canUse, personalDescriptor.access.canUse,
      'Default activation preserves the personal fork’s current execution rights.');
    const currentParent = await artifacts.resolveCapabilityPackageArtifact({ userId: 'owner' }, configured.metadata.resourceRef);
    const currentChild = currentParent.candidates.find(candidate => candidate.ref.sourceType === 'plugin' && candidate.ref.name === 'artifact-child')!;
    const skillSource = await actions.inspectCapabilityPackage({ userId: 'owner' }, currentChild.ref.resourceId);
    const skillDraft = await actions.createCapabilityPackageDraftAction({ userId: 'owner' }, {
      operation: 'fork', resourceRef: skillSource.resource.resourceRef, targetName: 'artifact-skill-copy', ownership: { type: 'user' },
      expectedSourceMetadataRevision: skillSource.resource.metadataRevision, expectedSourceGrantsRevision: skillSource.resource.grantsRevision,
      expectedSourcePackageRevision: skillSource.state?.packageRevision ?? 0, expectedSourcePublishedRevisionRef: skillSource.state?.currentPublishedRevisionRef ?? null,
    });
    const skillPublished = await actions.publishCapabilityPackageDraftAction({ userId: 'owner' }, { draftRef: skillDraft.draftRef,
      expectedDraftRevision: skillDraft.draftRevision, expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const skillDescriptor = await actions.inspectCapabilityPackage({ userId: 'owner' }, skillPublished.state.resourceRef);
    assert.equal(skillDescriptor.defaultEnabled, false);
    const skillRegistry = await import('../app/lib/skills/canvas-skill-store');
    const skillPointer = (await skillRegistry.readCanvasSkillRegistry(personalScope)).skills['artifact-skill-copy'];
    await activation.setCapabilityPackageDefaultActivationAction({ userId: 'owner' }, skillPublished.state.resourceRef, {
      enabled: true, expectedDefaultEnabled: false, expectedPackageRevision: skillPublished.state.packageRevision,
      expectedPublishedRevisionRef: skillPublished.published.revisionRef,
      expectedMetadataRevision: skillDescriptor.resource.metadataRevision, expectedGrantsRevision: skillDescriptor.resource.grantsRevision,
    });
    assert.deepEqual((await skillRegistry.readCanvasSkillRegistry(personalScope)).skills['artifact-skill-copy'], { ...skillPointer, packageDefaultEnabled: true },
      'The standalone skill branch changes only packageDefaultEnabled under the exact activation proof.');
    assert.equal((await actions.inspectCapabilityPackage({ userId: 'owner' }, skillPublished.state.resourceRef)).defaultEnabled, true);
    assert.equal(await fs.readFile(path.join(skillPointer.installDir, 'scripts/run.py'), 'utf8'), 'print("published")\n',
      'Forking a plugin child keeps its complete code while preserving the parent.');
    await resource.updateCapabilityResource({ userId: 'owner' }, configured.metadata.resourceRef, {
      expectedMetadataRevision: configured.metadata.metadataRevision, expectedGrantsRevision: configured.metadata.grantsRevision, grants: [],
    });
    await assert.rejects(artifacts.assertCapabilityPackageArtifactCurrent({ userId: 'editor' }, exact), 'Late grant revocation invalidates the copied source');
    console.log('PASS package artifacts + actual agent gateway: real SQL ACL, scripts/assets, strict actor/schema, delegated immutable publish, legacy guards/concurrent scope lock, manager-only default activation/CAS, personal activation, exact seed bundling/provenance and fresh revocation');
  } finally {
    loader._load = original; await database.close(); await removeFixtureRoot(root);
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
