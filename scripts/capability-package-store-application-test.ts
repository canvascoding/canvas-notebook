import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { CapabilityResourceActor, CapabilityResourceGrantInput } from '../app/lib/capabilities/resources/contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreSelection, CapabilityPackageStoreUpdateReview } from '../app/lib/capabilities/packages/store-contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

type Kind = 'plugin' | 'skill';
type Ownership = { type: 'user' | 'organization' } | { type: 'team'; workspaceId: string };

/** Test-only HTTP wait: an early action result or missing endpoint fails within a bounded interval. */
async function awaitRegistryBarrier(requested: Promise<void>, action: Promise<unknown>, label: string, release: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      requested,
      action.then(() => { throw new Error(`${label}: action completed before the expected registry request.`); },
        error => { throw new Error(`${label}: action failed before the expected registry request.`, { cause: error }); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}: expected registry request was not observed within 60 seconds.`)), 60_000); }),
    ]);
  } catch (error) { release(); throw error; }
  finally { if (timer) clearTimeout(timer); }
}

/** New isolated entry point: no production callers; authority and publication are actual services. */
async function main() {
  const native = process.argv.includes('--native');
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native });
  const { registry, sql, owner, alice, manager } = fixture;
  try {
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const skills = await import('../app/lib/skills/canvas-skill-store');
    const stateStore = await import('../app/lib/capabilities/packages/store');
    const preparation = await import('../app/lib/plugins/store-package-preparation');
    const sourceReceipts = await import('../app/lib/capabilities/packages/store-source');
    const files = (kind: Kind, name: string, version: string, marker: string): Record<string, string | Buffer> => kind === 'plugin' ? {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version, description: 'Actual Store application fixture', skills: './skills' }),
      [`skills/${name}-context/SKILL.md`]: `---\nname: ${name}-context\ndescription: Store workflow context\nmetadata:\n  version: ${version}\n---\n${marker}\n`,
      'scripts/main.js': `process.stdout.write(${JSON.stringify(marker)});\n`, 'assets/pixel.bin': Buffer.from([0, 255, 31]),
    } : { 'SKILL.md': `---\nname: ${name}\ndescription: Store standalone context\nmetadata:\n  version: ${version}\n---\n${marker}\n`,
      'scripts/main.py': `print(${JSON.stringify(marker)})\n`, 'assets/pixel.bin': Buffer.from([0, 255, 31]) };
    const selected = new Map<string, CapabilityPackageStoreSelection>();
    const add = async (kind: Kind, name: string, version = '1.0.0', content = `${name}-${version}`, bytes = files(kind, name, version, content)) => {
      const archive = await registry.addPackage('application', kind, name, version, bytes, plugins.computeCanvasPluginChecksum);
      const selection = { kind, registryId: 'store-application', entryKey: name, version, checksum: archive.checksum };
      selected.set(`${kind}:${name}:${version}`, selection); return { selection, directory: archive.directory };
    };
    const grant: CapabilityResourceGrantInput = { targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false };
    const editor: CapabilityResourceGrantInput = { targetType: 'user', targetId: 'bob', canUse: false, canEdit: true, canManage: false };
    const initialGrants = [grant, editor];
    const beforeCounts = async () => Promise.all(['capability_resources', 'capability_resource_grants', 'capability_package_states', 'capability_package_versions', 'capability_resource_history']
      .map(async table => (await sql.get(`SELECT COUNT(*)::integer AS count FROM ${table}`) as { count: number }).count));
    const inspect = (actor: CapabilityResourceActor, result: CapabilityPackageStoreApplicationResult) => packages.inspectCapabilityPackage(actor, result.resource.resourceRef);
    const updateInput = (review: CapabilityPackageStoreUpdateReview, replaceLocalChanges = false) => ({ source: review.source,
      expectedMetadataRevision: review.expectedMetadataRevision, expectedGrantsRevision: review.expectedGrantsRevision,
      expectedPackageRevision: review.expectedPackageRevision, expectedPublishedRevisionRef: review.expectedPublishedRevisionRef,
      expectedLocalChecksum: review.expectedLocalChecksum, replaceLocalChanges });
    const rawRecord = async (kind: Kind, name: string, ownership: Ownership, actor: CapabilityResourceActor) => {
      const scope = ownership.type === 'user' ? fixture.userScope(actor.userId) : fixture.organizationScope;
      return kind === 'plugin' ? (await plugins.readCanvasPluginRegistry(scope)).plugins[name] : (await skills.readCanvasSkillRegistry(scope)).skills[name];
    };
    const readMarker = async (actor: CapabilityResourceActor, result: CapabilityPackageStoreApplicationResult, revisionRef?: string) => {
      const file = await packages.readCapabilityPackageFileAction(actor, result.resource.resourceRef, {
        path: result.state.kind === 'plugin' ? 'scripts/main.js' : 'scripts/main.py', ...(revisionRef ? { revisionRef } : {}) });
      return Buffer.from(file.file.content, 'base64').toString();
    };
    const assertNoOrigin = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) { assert.notEqual(key, 'storeOrigin'); assertNoOrigin(item); }
    };
    const installed = new Map<string, { actor: CapabilityResourceActor; ownership: Ownership; result: CapabilityPackageStoreApplicationResult }>();

    // Six exact installs validate all initial resource/grant/package writes in one actual SQL transaction.
    for (const kind of ['plugin', 'skill'] as const) for (const ownership of [{ type: 'user' }, { type: 'organization' }, { type: 'team', workspaceId: 'store-team' }] as const) {
      const actor = ownership.type === 'team' ? manager : owner;
      const name = `store-${kind}-${ownership.type}`, source = (await add(kind, name)).selection;
      const counts = await beforeCounts();
      const result = await stores.installCapabilityPackageFromStoreAction(actor, { source, ownership, grants: initialGrants, responsibleUserId: 'bob' });
      assert.equal(result.state.packageRevision, 1); assert.equal(result.resource.metadataRevision, 1); assert.equal(result.resource.grantsRevision, 1);
      assert.equal(result.resource.accessMode, 'restricted'); assert.equal(result.resource.responsibleUserId, 'bob');
      assert.equal(result.resource.ownership.type, ownership.type); assert.equal(result.published.publishedByUserId, actor.userId);
      assert.equal(result.resource.resourceRef, result.state.resourceRef); assert.equal(result.published.revisionRef, result.state.currentPublishedRevisionRef);
      assert.equal(result.state.currentSourceStamp.storeOrigin?.baselineChecksum, source.checksum);
      const descriptor = await resources.inspectCapabilityResource(actor, result.resource.resourceRef);
      assert.deepEqual(descriptor.grants?.map(value => ({ targetType: value.targetType, targetId: value.targetId, canUse: value.canUse, canEdit: value.canEdit, canManage: value.canManage })), initialGrants);
      assert.equal((await resources.inspectCapabilityResource(alice, result.resource.resourceRef)).access.canUse, true);
      const editorAccess = await resources.inspectCapabilityResource(fixture.actor('bob'), result.resource.resourceRef);
      assert.equal(editorAccess.access.canEdit, true); assert.equal(editorAccess.access.canUse, false); assert.equal(editorAccess.access.canManage, false);
      await assert.rejects(() => resources.inspectCapabilityResource(fixture.actor('unassigned'), result.resource.resourceRef));
      assert.equal((await inspect(actor, result)).defaultEnabled, false);
      const pointer = await rawRecord(kind, name, ownership, actor); assert.equal(pointer.packageManaged, true); assert.equal(pointer.packageResourceRef, result.resource.resourceRef);
      assert.equal(pointer.publishedRevisionRef, result.published.revisionRef); assert.ok(pointer.storeOrigin);
      assert.deepEqual(await beforeCounts(), counts.map((count, index) => count + [1, 2, 1, 1, 1][index]), 'No intermediate adoption/grant history is exposed.');
      installed.set(`${kind}:${ownership.type}`, { actor, ownership, result });
    }
    console.log('store-application: six scoped installations and independent initial grants PASS');

    // Target authority is checked before archive downloads, including scope managers outside another team.
    const deniedSource = (await add('plugin', 'store-forbidden')).selection;
    const deniedBefore = await beforeCounts(), archiveBefore = registry.count('archive');
    await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(alice, { source: deniedSource, ownership: { type: 'organization' }, grants: [] }), { code: 'PACKAGE_ACCESS_DENIED' });
    await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(manager, { source: deniedSource, ownership: { type: 'team', workspaceId: 'other-team' }, grants: [] }));
    assert.equal(registry.count('archive'), archiveBefore); assert.deepEqual(await beforeCounts(), deniedBefore);
    // The physical organization namespace is shared by organization and team owners; no same-name overwrite.
    const existingOrg = installed.get('plugin:organization')!;
    const collisionBefore = await rawRecord('plugin', 'store-plugin-organization', { type: 'organization' }, owner);
    await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(manager, { source: selected.get('plugin:store-plugin-organization:1.0.0'),
      ownership: { type: 'team', workspaceId: 'store-team' }, grants: [] }));
    assert.deepEqual(await rawRecord('plugin', 'store-plugin-organization', { type: 'organization' }, owner), collisionBefore);

    // An actual managed Agent configuration pins immutable v1 independently of the package HEAD.
    const agentActions = await import('../app/lib/agents/management-actions');
    const agentRegistry = await import('../app/lib/agents/registry');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const { piSessions: sessionTable } = await import('../app/lib/db/schema');
    const originalPin = existingOrg.result.published;
    const pinDescriptor = await resources.inspectCapabilityResource(owner, originalPin.resourceRef);
    await resources.updateCapabilityResource(owner, originalPin.resourceRef, { expectedMetadataRevision: pinDescriptor.metadata.metadataRevision,
      expectedGrantsRevision: pinDescriptor.metadata.grantsRevision, grants: [...initialGrants, { ...grant, targetId: 'owner' }] });
    const activePin = await packages.inspectCapabilityPackage(owner, originalPin.resourceRef);
    const { setCapabilityPackageDefaultActivationAction } = await import('../app/lib/capabilities/packages/activation');
    await setCapabilityPackageDefaultActivationAction(owner, originalPin.resourceRef, { expectedMetadataRevision: activePin.resource.metadataRevision,
      expectedGrantsRevision: activePin.resource.grantsRevision, expectedPackageRevision: 1, expectedPublishedRevisionRef: originalPin.revisionRef,
      expectedDefaultEnabled: false, enabled: true });
    await agentActions.createManagedAgent(owner, { agentId: 'store-pin-agent', name: 'Store package pin', scopeType: 'organization', enabledTools: [] });
    const pinAgent = (await agentRegistry.getAgentProfile('store-pin-agent'))!;
    await agentActions.setManagedAgentGrant({ actor: owner, agentId: pinAgent.agentId, expectedRevision: pinAgent.revision,
      targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false });
    const writablePin = (await agentRegistry.getAgentProfile('store-pin-agent'))!;
    await workflow.updateManagedAgentConfiguration({ actor: owner, agentId: writablePin.agentId,
      expectedRevision: writablePin.revision, expectedWorkflowRevision: writablePin.workflowRevision ?? 0,
      workflow: { version: 1, packages: [{ resourceRef: originalPin.resourceRef, publishedRevisionRef: originalPin.revisionRef,
        checksum: originalPin.checksum, skillSelection: { kind: 'plugin' }, declarations: [] }] } });
    await fixture.database.db.insert(sessionTable).values({ sessionId: 'store-pin-session', userId: 'alice', agentId: 'store-pin-agent',
      workspaceId: 'personal-alice', workspaceType: 'personal', organizationId: fixture.organizationId,
      provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const pinBindingsBefore = await sql.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1', ['store-pin-agent']);
    const preferences = await import('../app/lib/capabilities/preference-store');
    const { setPersonalCapabilityActivation } = await import('../app/lib/capabilities/activation-actions');
    const { resolveCapabilityExecutionContextForUser } = await import('../app/lib/capabilities/request-scope');
    const preferenceContext = await resolveCapabilityExecutionContextForUser({ userId: 'alice', organizationId: fixture.organizationId,
      role: 'member', requestedWorkspaceId: 'personal-alice' });
    for (const entry of installed.values()) if (entry.ownership.type !== 'user') {
      await setPersonalCapabilityActivation({ context: preferenceContext, actorUserId: 'alice', resourceId: entry.result.resource.legacyResourceId,
        enabled: entry.result.resource.resourceRef === originalPin.resourceRef, expectedRevision: 0 });
    }
    const preferencesBefore = await preferences.readCapabilityPreferences('alice');

    // Scoped updates preserve metadata, grants, default activation, history and readable immutable old bytes.
    for (const [key, entry] of installed) {
      const { actor, result, ownership } = entry;
      const kind = result.state.kind, name = result.state.name;
      const descriptor = await resources.inspectCapabilityResource(actor, result.resource.resourceRef);
      const changedMetadata = await resources.updateCapabilityResource(actor, result.resource.resourceRef, {
        expectedMetadataRevision: descriptor.metadata.metadataRevision, expectedGrantsRevision: descriptor.metadata.grantsRevision,
        metadata: { displayName: `Managed ${key}`, description: 'Preserved display', responsibleUserId: 'bob' } });
      const current = await inspect(actor, result), activation = await import('../app/lib/capabilities/packages/activation');
      if (!current.defaultEnabled) await activation.setCapabilityPackageDefaultActivationAction(actor, result.resource.resourceRef, {
        expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
        expectedPackageRevision: current.state!.packageRevision, expectedPublishedRevisionRef: current.state!.currentPublishedRevisionRef,
        expectedDefaultEnabled: false, enabled: true });
      const beforePointer = await rawRecord(kind, name, ownership, actor), source = (await add(kind, name, '2.0.0')).selection;
      const readArchives = registry.count('archive'), review = await stores.inspectCapabilityPackageStoreUpdateAction(actor, result.resource.resourceRef, { source });
      assert.equal(registry.count('archive'), readArchives, 'Update review downloads metadata only.');
      assert.equal(review.canUpdate, true); assert.equal(review.localChanges, 'unchanged');
      const updated = await stores.updateCapabilityPackageFromStoreAction(actor, result.resource.resourceRef, updateInput(review));
      assert.equal(updated.state.packageRevision, 2); assert.equal(updated.resource.resourceRef, result.resource.resourceRef);
      assert.deepEqual(updated.resource, changedMetadata.metadata, 'Updating content does not mutate management metadata.');
      const afterDescriptor = await resources.inspectCapabilityResource(actor, updated.resource.resourceRef);
      assert.deepEqual(afterDescriptor.grants, descriptor.grants); assert.equal((await inspect(actor, updated)).defaultEnabled, true);
      const afterPointer = await rawRecord(kind, name, ownership, actor);
      assert.equal(afterPointer.installedAt, beforePointer.installedAt);
      if ('installedBy' in beforePointer && 'installedBy' in afterPointer) assert.equal(afterPointer.installedBy, beforePointer.installedBy);
      assert.equal(updated.state.currentSourceStamp.storeOrigin?.version, '2.0.0'); assert.equal(updated.state.currentSourceStamp.storeOrigin?.baselineChecksum, source.checksum);
      assert.match(await readMarker(actor, updated, result.published.revisionRef), /1\.0\.0/u);
      assert.match(await readMarker(actor, updated), /2\.0\.0/u);
      const old = await stateStore.getCapabilityPackagePublishedRevision(updated.resource.resourceRef, result.published.revisionRef);
      assert.equal(old?.sourceStamp.storeOrigin?.version, '1.0.0');
      await assert.rejects(() => stores.updateCapabilityPackageFromStoreAction(actor, updated.resource.resourceRef, updateInput(review)), (error: unknown) =>
        Boolean(error && typeof error === 'object' && Reflect.get(error, 'status') === 409));
      entry.result = updated;
    }
    const { resolveAgentExecutionContextForStoredSession: resolvePinnedSession } = await import('../app/lib/pi/session-workspace-context');
    const pinnedContext = await resolvePinnedSession({ userId: 'alice', agentId: 'store-pin-agent', sessionId: 'store-pin-session' });
    assert.equal(pinnedContext.skillPackageBindings?.[0].publishedRevisionRef, originalPin.revisionRef);
    assert.equal(pinnedContext.skillPackageBindings?.[0].checksum, originalPin.checksum);
    assert.deepEqual(await sql.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1', ['store-pin-agent']), pinBindingsBefore);
    assert.deepEqual(await preferences.readCapabilityPreferences('alice'), preferencesBefore, 'Store updates preserve exact user activation preferences and their revisions.');
    console.log('store-application: six exact updates preserve metadata/grants/default/history PASS');

    const variantV1 = (await add('plugin', 'store-exact-variant')).selection;
    const ownVariant = await stores.installCapabilityPackageFromStoreAction(owner, { source: variantV1, ownership: { type: 'user' }, grants: [] });
    const orgVariant = await stores.installCapabilityPackageFromStoreAction(owner, { source: variantV1, ownership: { type: 'organization' }, grants: [] });
    const variantV2 = (await add('plugin', 'store-exact-variant', '2.0.0')).selection;
    const otherVariantState = await inspect(owner, orgVariant), variantReview = await stores.inspectCapabilityPackageStoreUpdateAction(owner, ownVariant.resource.resourceRef, { source: variantV2 });
    await stores.updateCapabilityPackageFromStoreAction(owner, ownVariant.resource.resourceRef, updateInput(variantReview));
    assert.deepEqual((await inspect(owner, orgVariant)).state, otherVariantState.state, 'A same-name organization instance does not become the update target.');
    const variantArchives = registry.count('archive');
    await assert.rejects(() => stores.updateCapabilityPackageFromStoreAction(alice, orgVariant.resource.resourceRef, updateInput(variantReview)));
    assert.equal(registry.count('archive'), variantArchives, 'Foreign reference rights fail before archive requests.');

    // Local version 99 never replaces the verified Store baseline. Replacement needs explicit current-checksum confirmation.
    const local = installed.get('plugin:user')!, localBefore = await inspect(owner, local.result);
    const draft = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: local.result.resource.resourceRef,
      expectedMetadataRevision: localBefore.resource.metadataRevision, expectedGrantsRevision: localBefore.resource.grantsRevision,
      expectedPackageRevision: localBefore.state!.packageRevision, expectedPublishedRevisionRef: localBefore.state!.currentPublishedRevisionRef });
    const changed = await packages.writeCapabilityPackageDraftFileAction(owner, draft.draftRef, { expectedDraftRevision: draft.draftRevision,
      path: '.canvas-plugin/plugin.json', encoding: 'base64', content: Buffer.from(JSON.stringify({ name: local.result.state.name, version: '99.0.0', skills: './skills', description: 'Local reviewed modification' })).toString('base64') });
    await packages.publishCapabilityPackageDraftAction(owner, { draftRef: draft.draftRef, expectedDraftRevision: changed.draft.draftRevision,
      expectedMetadataRevision: localBefore.resource.metadataRevision, expectedGrantsRevision: localBefore.resource.grantsRevision,
      expectedPackageRevision: localBefore.state!.packageRevision, expectedPublishedRevisionRef: localBefore.state!.currentPublishedRevisionRef });
    const newSource = (await add('plugin', local.result.state.name, '3.0.0')).selection;
    const localReview = await stores.inspectCapabilityPackageStoreUpdateAction(owner, local.result.resource.resourceRef, { source: newSource });
    assert.equal(localReview.current.version, '99.0.0'); assert.equal(localReview.current.upstreamVersion, '2.0.0');
    assert.equal(localReview.requiresLocalChangesConfirmation, true);
    const localStateBefore = await inspect(owner, local.result);
    await assert.rejects(() => stores.updateCapabilityPackageFromStoreAction(owner, local.result.resource.resourceRef, updateInput(localReview)), { code: 'PACKAGE_REVISION_CONFLICT' });
    assert.deepEqual((await inspect(owner, local.result)).state, localStateBefore.state);
    local.result = await stores.updateCapabilityPackageFromStoreAction(owner, local.result.resource.resourceRef, updateInput(localReview, true));
    assert.equal(local.result.published.version, '3.0.0');

    // Legacy verified imports are adopted atomically: original v1 and new v2 become immutable in the same transaction.
    for (const kind of ['plugin', 'skill'] as const) {
      const name = `store-legacy-${kind}`; await add(kind, name); const source = (await add(kind, name, '2.0.0')).selection;
      let legacyRef: string | undefined;
      if (kind === 'plugin') {
        const legacy = await (await import('../app/lib/plugins/canvas-plugin-store')).installCanvasPluginFromStore(name, '1.0.0', { scope: fixture.userScope('owner'), enable: true, replace: false });
        assert(legacy.success && legacy.plugin?.resourceId); legacyRef = legacy.plugin.resourceId;
      } else {
        const legacy = await skills.installCanvasSkillFromStore(name, '1.0.0', { scope: fixture.userScope('owner'), enable: true, replace: false });
        assert(legacy.success && legacy.skill?.resourceId); legacyRef = legacy.skill.resourceId;
      }
      assert(legacyRef); const old = await packages.inspectCapabilityPackage(owner, legacyRef);
      assert.equal(old.resource.metadataRevision, 0); assert.equal(old.state, null);
      const review = await stores.inspectCapabilityPackageStoreUpdateAction(owner, legacyRef, { source });
      assert.equal(review.expectedPackageRevision, 0); assert.equal(review.expectedMetadataRevision, 0);
      const updated = await stores.updateCapabilityPackageFromStoreAction(owner, legacyRef, updateInput(review));
      assert.equal(updated.resource.accessMode, old.resource.accessMode); assert.equal(updated.state.packageRevision, 2);
      assert.equal((await inspect(owner, updated)).defaultEnabled, true);
      const versions = await sql.all('SELECT version,source_stamp FROM capability_package_versions WHERE resource_ref=$1 ORDER BY version', [updated.resource.resourceRef]) as { version: string; source_stamp: string }[];
      assert.deepEqual(versions.map(value => value.version), ['1.0.0', '2.0.0']);
      assert.equal(updated.published.baseRevisionRef?.startsWith('canvas-package-revision:'), true);
    }
    console.log('store-application: explicit modified-content replacement and atomic legacy adoption PASS');

    const legacySeedFiles = (version: string) => ({ '.canvas-plugin/plugin.json': JSON.stringify({ name: 'store-legacy-seeds', version,
      description: 'Historical complete seed package', skillRefs: [{ name: 'skill-creator', source: 'seed' }, { name: 'docx', source: 'seed' }] }),
    'README.md': `Seed package ${version}` });
    const legacySeedV1 = await add('plugin', 'store-legacy-seeds', '1.0.0', 'legacy seed', legacySeedFiles('1.0.0'));
    const legacySeedV2 = (await add('plugin', 'store-legacy-seeds', '2.0.0', 'new seed', legacySeedFiles('2.0.0'))).selection;
    const legacySeeds = await (await import('../app/lib/plugins/canvas-plugin-store')).installCanvasPluginFromStore('store-legacy-seeds', '1.0.0',
      { scope: fixture.userScope('owner'), enable: false, replace: false });
    assert(legacySeeds.success && legacySeeds.plugin?.resourceId);
    const inventory = await import('../app/lib/capabilities/packages/io');
    const legacySeedBytes = await inventory.readExactPackageInventory(legacySeeds.plugin.installDir);
    const seedReview = await stores.inspectCapabilityPackageStoreUpdateAction(owner, legacySeeds.plugin.resourceId, { source: legacySeedV2 });
    const seedUpdate = await stores.updateCapabilityPackageFromStoreAction(owner, legacySeeds.plugin.resourceId, updateInput(seedReview));
    assert.equal(seedUpdate.state.packageRevision, 2);
    assert.equal((await inventory.readExactPackageInventory(legacySeeds.plugin.installDir)).checksum, legacySeedBytes.checksum, 'History normalization never mutates the original legacy root.');
    const seedHistory = await stateStore.getCapabilityPackagePublishedRevision(seedUpdate.resource.resourceRef, seedUpdate.published.baseRevisionRef!);
    assert.ok(seedHistory); assert.equal(seedHistory.version, '1.0.0');
    assert.equal(seedHistory.sourceStamp.storeOrigin?.upstreamChecksum, legacySeedV1.selection.checksum);
    const seedHistoryFiles = await packages.listCapabilityPackageFilesAction(owner, seedUpdate.resource.resourceRef, { revisionRef: seedHistory.revisionRef });
    assert(seedHistoryFiles.files.some(file => file.path === 'skills/skill-creator/SKILL.md'));
    assert(seedHistoryFiles.files.some(file => file.path === 'skills/docx/SKILL.md'));
    assert(seedHistoryFiles.files.some(file => file.path === 'skills/docx/agents/canvas.yaml'));
    assert(seedHistoryFiles.files.some(file => file.path === 'skills/docx/references/headless-libreoffice.md'));
    const historicalManifest = JSON.parse(Buffer.from((await packages.readCapabilityPackageFileAction(owner, seedUpdate.resource.resourceRef,
      { revisionRef: seedHistory.revisionRef, path: '.canvas-plugin/plugin.json' })).file.content, 'base64').toString()) as Record<string, unknown>;
    assert.equal(historicalManifest.skillRefs, undefined);
    assert.equal(seedUpdate.state.currentSourceStamp.storeOrigin?.version, '2.0.0');
    assert.equal(seedUpdate.state.currentSourceStamp.storeOrigin?.upstreamChecksum, legacySeedV2.checksum);
    const newSeedRevision = await stateStore.getCapabilityPackagePublishedRevision(seedUpdate.resource.resourceRef, seedUpdate.published.revisionRef);
    assert.equal(newSeedRevision!.sourceRevisionRef, seedHistory.revisionRef);
    assert.equal(newSeedRevision!.sourceChecksum, seedHistory.checksum, 'v2 provenance refers to the exact normalized immutable v1 tree.');

    for (const version of ['1.0.0', '2.0.0']) await add('plugin', 'store-legacy-seed-alias', version, 'scalar seed', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: 'store-legacy-seed-alias', version, description: 'Scalar seed alias fixture', seed_skills: 'skill-creator' }),
      'README.md': `Scalar seed alias ${version}`,
    });
    const scalarSeed = await (await import('../app/lib/plugins/canvas-plugin-store')).installCanvasPluginFromStore('store-legacy-seed-alias', '1.0.0',
      { scope: fixture.userScope('owner'), enable: false, replace: false });
    assert(scalarSeed.success && scalarSeed.plugin?.resourceId);
    const scalarReview = await stores.inspectCapabilityPackageStoreUpdateAction(owner, scalarSeed.plugin.resourceId,
      { source: selected.get('plugin:store-legacy-seed-alias:2.0.0') });
    const scalarUpdated = await stores.updateCapabilityPackageFromStoreAction(owner, scalarSeed.plugin.resourceId, updateInput(scalarReview));
    const scalarHistory = await packages.listCapabilityPackageFilesAction(owner, scalarUpdated.resource.resourceRef,
      { revisionRef: scalarUpdated.published.baseRevisionRef! });
    assert(scalarHistory.files.some(file => file.path === 'skills/skill-creator/SKILL.md'));

    for (const kind of ['plugin', 'skill'] as const) {
      const name = `store-adopted-${kind}`; await add(kind, name); const source = (await add(kind, name, '2.0.0')).selection;
      const imported = kind === 'plugin'
        ? (await (await import('../app/lib/plugins/canvas-plugin-store')).installCanvasPluginFromStore(name, '1.0.0', { scope: fixture.organizationScope, enable: false, replace: false })).plugin
        : (await skills.installCanvasSkillFromStore(name, '1.0.0', { scope: fixture.organizationScope, enable: false, replace: false })).skill;
      assert(imported?.resourceId);
      const adopted = await resources.configureCapabilityResource(owner, imported.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
        ownership: { type: 'team', workspaceId: 'store-team' }, accessMode: 'restricted', grants: initialGrants, metadata: { responsibleUserId: 'bob' } });
      const adoptedBefore = await packages.inspectCapabilityPackage(manager, adopted.metadata.resourceRef);
      const review = await stores.inspectCapabilityPackageStoreUpdateAction(manager, adopted.metadata.resourceRef, { source });
      assert.equal(review.expectedPackageRevision, 0); assert.equal(review.expectedMetadataRevision, 1);
      const applied = await stores.updateCapabilityPackageFromStoreAction(manager, adopted.metadata.resourceRef, updateInput(review));
      assert.deepEqual(applied.resource, adopted.metadata); assert.equal(applied.state.packageRevision, 2);
      assert.deepEqual((await resources.inspectCapabilityResource(manager, applied.resource.resourceRef)).grants, adopted.grants);
      assert.equal((await inspect(manager, applied)).defaultEnabled, adoptedBefore.defaultEnabled, 'Legacy default and user activation remain distinct and unchanged.');
    }

    // Unknown imports, child skills and derived forks remain distinct from a direct Store update target.
    const forkFrom = await inspect(owner, existingOrg.result);
    const fork = await packages.createCapabilityPackageDraftAction(owner, { operation: 'fork', resourceRef: forkFrom.resource.resourceRef,
      targetName: 'store-derived-copy', ownership: { type: 'user' }, expectedSourceMetadataRevision: forkFrom.resource.metadataRevision,
      expectedSourceGrantsRevision: forkFrom.resource.grantsRevision, expectedSourcePackageRevision: forkFrom.state!.packageRevision,
      expectedSourcePublishedRevisionRef: forkFrom.state!.currentPublishedRevisionRef });
    const forkManifest = JSON.parse(Buffer.from((await packages.readCapabilityPackageDraftFileAction(owner, fork.draftRef,
      { path: '.canvas-plugin/plugin.json' })).file.content, 'base64').toString()) as Record<string, unknown>;
    const renamed = await packages.writeCapabilityPackageDraftFileAction(owner, fork.draftRef, { expectedDraftRevision: fork.draftRevision,
      path: '.canvas-plugin/plugin.json', encoding: 'base64', content: Buffer.from(JSON.stringify({ ...forkManifest, name: 'store-derived-copy' })).toString('base64') });
    const forked = await packages.publishCapabilityPackageDraftAction(owner, { draftRef: fork.draftRef,
      expectedDraftRevision: renamed.draft.draftRevision, expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const derivedSource = (await add('plugin', 'store-derived-copy', '3.0.0')).selection;
    const archiveNegative = registry.count('archive');
    await assert.rejects(() => stores.inspectCapabilityPackageStoreUpdateAction(owner, forked.state.resourceRef, { source: derivedSource }), { code: 'PACKAGE_SOURCE_CHANGED' });
    const child = (await resources.listCapabilityResources(owner)).find(value => value.artifact.sourcePluginId === existingOrg.result.resource.legacyResourceId);
    assert.ok(child);
    await assert.rejects(() => stores.inspectCapabilityPackageStoreUpdateAction(owner, child.metadata.resourceRef, {
      source: selected.get('plugin:store-plugin-organization:2.0.0') }), { code: 'PACKAGE_SOURCE_CHANGED' });
    const unknownSource = await add('plugin', 'store-unknown');
    const unknown = await plugins.installCanvasPluginFromPath(unknownSource.directory, { scope: fixture.userScope('owner'), enable: false });
    assert(unknown.success && unknown.plugin?.resourceId);
    const unknownV2 = (await add('plugin', 'store-unknown', '2.0.0')).selection;
    await assert.rejects(() => stores.inspectCapabilityPackageStoreUpdateAction(owner, unknown.plugin!.resourceId!, { source: unknownV2 }), { code: 'PACKAGE_SOURCE_CHANGED' });
    await assert.rejects(() => stores.inspectCapabilityPackageStoreUpdateAction(owner, 'store-plugin-organization', { source: unknownV2 }));
    assert.equal(registry.count('archive'), archiveNegative);

    // Server receipts are not serializable authorization, and request identities cannot be chosen by clients.
    const forgedSource = (await add('plugin', 'store-receipt')).selection;
    const artifacts = await import('../app/lib/capabilities/packages/artifacts');
    const binding = artifacts.capabilityPackageLegacyStorageBinding('plugin', forgedSource.entryKey, fixture.userScope('owner'));
    const receipt = await preparation.prepareVerifiedCanvasPluginStorePackage({ ...forgedSource, resourceId: binding.resourceId, actor: owner });
    const receiptRoot = sourceReceipts.getPreparedCapabilityStorePackage(receipt).packageRoot;
    await assert.rejects(() => sourceReceipts.assertPreparedCapabilityStorePackage(structuredClone(receipt), { ...forgedSource, resourceId: binding.resourceId }), { code: 'PACKAGE_ACCESS_DENIED' });
    await sourceReceipts.disposePreparedCapabilityStorePackage(receipt);
    await assert.rejects(() => fs.lstat(receiptRoot), { code: 'ENOENT' });
    await assert.rejects(() => sourceReceipts.assertPreparedCapabilityStorePackage(receipt, { ...forgedSource, resourceId: binding.resourceId }), { code: 'PACKAGE_ACCESS_DENIED' });
    await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(owner, { source: forgedSource, ownership: { type: 'user' }, actorUserId: 'alice' }));
    await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(owner, { source: forgedSource, ownership: { type: 'user' }, storeOrigin: {} }));

    // Delayed registry reads recheck current ACL and namespace; no post-revoke or occupied-target mutation.
    const race = installed.get('plugin:organization')!, raceSource = (await add('plugin', race.result.state.name, '3.0.0')).selection;
    const raceDescriptor = await resources.inspectCapabilityResource(owner, race.result.resource.resourceRef);
    const managerGrant = { targetType: 'user' as const, targetId: 'bob', canUse: false, canEdit: true, canManage: true };
    const granted = await resources.updateCapabilityResource(owner, race.result.resource.resourceRef, { expectedMetadataRevision: raceDescriptor.metadata.metadataRevision,
      expectedGrantsRevision: raceDescriptor.metadata.grantsRevision, grants: [grant, managerGrant] });
    const bobReview = await stores.inspectCapabilityPackageStoreUpdateAction(fixture.actor('bob'), race.result.resource.resourceRef, { source: raceSource });
    const barrier = registry.holdNextRegistry('application');
    const pending = stores.updateCapabilityPackageFromStoreAction(fixture.actor('bob'), race.result.resource.resourceRef, updateInput(bobReview));
    await awaitRegistryBarrier(barrier.requested, pending, 'Grant-revoke barrier', barrier.release);
    const revoked = await resources.updateCapabilityResource(owner, race.result.resource.resourceRef, { expectedMetadataRevision: granted.metadata.metadataRevision,
      expectedGrantsRevision: granted.metadata.grantsRevision, grants: [grant] });
    const raceCounts = await beforeCounts(), racePointer = await rawRecord('plugin', race.result.state.name, race.ownership, owner);
    barrier.release(); await assert.rejects(() => pending);
    assert.deepEqual(await beforeCounts(), raceCounts); assert.deepEqual(await rawRecord('plugin', race.result.state.name, race.ownership, owner), racePointer);
    assert.equal((await resources.inspectCapabilityResource(owner, race.result.resource.resourceRef)).metadata.grantsRevision, revoked.metadata.grantsRevision);
    const namespaceSource = (await add('plugin', 'store-namespace-race')).selection;
    const namespace = registry.holdNextRegistry('application');
    const pendingInstall = stores.installCapabilityPackageFromStoreAction(owner, { source: namespaceSource, ownership: { type: 'user' }, grants: [] });
    await awaitRegistryBarrier(namespace.requested, pendingInstall, 'Namespace barrier', namespace.release);
    const occupied = await stores.installCapabilityPackageFromStoreAction(owner, { source: namespaceSource, ownership: { type: 'user' }, grants: [] });
    const occupiedCounts = await beforeCounts(); namespace.release(); await assert.rejects(() => pendingInstall);
    assert.deepEqual(await beforeCounts(), occupiedCounts); assert.equal((await packages.inspectCapabilityPackage(owner, occupied.resource.resourceRef)).state!.packageRevision, 1);

    const headSource = (await add('plugin', 'store-head-race')).selection;
    const headInstalled = await stores.installCapabilityPackageFromStoreAction(owner, { source: headSource, ownership: { type: 'user' }, grants: [] });
    const headV2 = (await add('plugin', 'store-head-race', '2.0.0')).selection;
    const headReview = await stores.inspectCapabilityPackageStoreUpdateAction(owner, headInstalled.resource.resourceRef, { source: headV2 });
    const headBarrier = registry.holdNextRegistry('application');
    const headPending = stores.updateCapabilityPackageFromStoreAction(owner, headInstalled.resource.resourceRef, updateInput(headReview));
    await awaitRegistryBarrier(headBarrier.requested, headPending, 'Package-head barrier', headBarrier.release);
    const headWinner = await stores.updateCapabilityPackageFromStoreAction(owner, headInstalled.resource.resourceRef, updateInput(headReview));
    const winnerCounts = await beforeCounts(), winnerPointer = await rawRecord('plugin', 'store-head-race', { type: 'user' }, owner);
    headBarrier.release(); await assert.rejects(() => headPending);
    assert.deepEqual(await beforeCounts(), winnerCounts); assert.deepEqual(await rawRecord('plugin', 'store-head-race', { type: 'user' }, owner), winnerPointer);
    assert.equal((await inspect(owner, headWinner)).state!.packageRevision, 2);
    const sourceRace = (await add('plugin', 'store-source-race')).selection;
    const sourceBarrier = registry.holdNextRegistry('application');
    const sourcePending = stores.installCapabilityPackageFromStoreAction(owner, { source: sourceRace, ownership: { type: 'user' }, grants: [] });
    await awaitRegistryBarrier(sourceBarrier.requested, sourcePending, 'Source-change barrier', sourceBarrier.release);
    registry.setDigest('application', 'plugin', 'store-source-race', '1.0.0', 'a'.repeat(64));
    const sourceCounts = await beforeCounts(); sourceBarrier.release(); await assert.rejects(() => sourcePending);
    assert.deepEqual(await beforeCounts(), sourceCounts);
    assert.equal((await plugins.readCanvasPluginRegistry(fixture.userScope('owner'))).plugins['store-source-race'], undefined);

    // An invalid complete manifest and selected digest conflict never create an installed resource or pointer.
    const invalid = (await add('plugin', 'store-invalid', '1.0.0', 'invalid', { '.canvas-plugin/plugin.json': '{invalid-json', 'README.md': 'Invalid package' })).selection;
    const invalidCounts = await beforeCounts(); await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(owner, { source: invalid, ownership: { type: 'user' }, grants: [] }));
    assert.deepEqual(await beforeCounts(), invalidCounts); assert.equal((await plugins.readCanvasPluginRegistry(fixture.userScope('owner'))).plugins['store-invalid'], undefined);
    registry.setDigest('application', 'plugin', 'store-receipt', '1.0.0', '0'.repeat(64));
    await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(owner, { source: forgedSource, ownership: { type: 'user' }, grants: [] }), { code: 'PACKAGE_SOURCE_CHANGED' });
    assert.deepEqual(await beforeCounts(), invalidCounts);

    // Exact known core dependencies are captured into the immutable complete package, not followed externally.
    const bundledSource = (await add('plugin', 'store-bundled-seed', '1.0.0', 'seed', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: 'store-bundled-seed', version: '1.0.0', description: 'Seed capture', skillRefs: [{ name: 'create-plugin', source: 'seed' }] }),
      'README.md': 'Known complete seed dependency',
    })).selection;
    const bundled = await stores.installCapabilityPackageFromStoreAction(owner, { source: bundledSource, ownership: { type: 'user' }, grants: [] });
    const bundledPointer = await rawRecord('plugin', 'store-bundled-seed', { type: 'user' }, owner);
    const capturedManifest = JSON.parse(await fs.readFile(`${bundledPointer.installDir}/.canvas-plugin/plugin.json`, 'utf8')) as Record<string, unknown>;
    assert.equal(capturedManifest.skillRefs, undefined); assert.equal(capturedManifest.skills, './skills');
    const capturedFiles = await packages.listCapabilityPackageFilesAction(owner, bundled.resource.resourceRef, {});
    assert(capturedFiles.files.some(file => file.path === 'skills/create-plugin/SKILL.md'));
    assert.equal(bundled.state.currentSourceStamp.storeOrigin?.baselineChecksum, bundled.published.checksum);
    assert.equal(bundled.state.currentSourceStamp.storeOrigin?.upstreamChecksum, bundledSource.checksum);
    assert.notEqual(bundled.published.checksum, bundledSource.checksum, 'Baseline proves the imported complete normalized tree including actual seed bytes.');

    // Actual SQL failure after pointer staging restores the registry and all initial resource/grant rows.
    const rollbackSource = (await add('plugin', 'store-rollback')).selection;
    await sql.run("CREATE FUNCTION store_application_reject_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='store-rollback' THEN RAISE EXCEPTION 'owned fixture publication failure'; END IF; RETURN NEW; END $$");
    await sql.run('CREATE TRIGGER store_application_reject BEFORE INSERT ON capability_package_versions FOR EACH ROW EXECUTE FUNCTION store_application_reject_version()');
    const rollbackCounts = await beforeCounts();
    await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(owner, { source: rollbackSource, ownership: { type: 'user' }, grants: initialGrants, responsibleUserId: 'bob' }));
    assert.deepEqual(await beforeCounts(), rollbackCounts);
    assert.equal((await plugins.readCanvasPluginRegistry(fixture.userScope('owner'))).plugins['store-rollback'], undefined);
    await sql.run('DROP TRIGGER store_application_reject ON capability_package_versions'); await sql.run('DROP FUNCTION store_application_reject_version()');
    // The database really COMMITs, then the transport loses its acknowledgement: inspection confirms one committed result.
    const commitSource = (await add('plugin', 'store-commit-loss')).selection;
    let publicationWritten = false, acknowledgementLost = false;
    fixture.setAfterQuery(async query => {
      if (/INSERT INTO capability_package_versions/iu.test(query)) publicationWritten = true;
      if (publicationWritten && /^COMMIT\s*$/iu.test(query)) {
        acknowledgementLost = true; fixture.setAfterQuery(undefined); throw new Error('Owned fixture lost COMMIT acknowledgement.');
      }
    });
    const commitCounts = await beforeCounts();
    const committed = await stores.installCapabilityPackageFromStoreAction(owner, { source: commitSource, ownership: { type: 'user' }, grants: initialGrants });
    assert.equal(acknowledgementLost, true); assert.equal(committed.state.packageRevision, 1);
    assert.deepEqual(await beforeCounts(), commitCounts.map((count, index) => count + [1, 2, 1, 1, 1][index]));
    assert.equal((await packages.inspectCapabilityPackage(owner, committed.resource.resourceRef)).state!.currentPublishedRevisionRef, committed.published.revisionRef);
    console.log('store-application: receipt/request forgery, delayed revoke/collision and invalid source rollback PASS');

    // Real BetterAuth HTTP boundaries and the actual scoped Agent factory share the same strict actions.
    const installRoute = await import('../app/api/capabilities/packages/store/install/route');
    const listRoute = await import('../app/api/capabilities/packages/store/route');
    const reviewRoute = await import('../app/api/capabilities/packages/[resourceRef]/store-update/review/route');
    const updateRoute = await import('../app/api/capabilities/packages/[resourceRef]/store-update/route');
    const context = (resourceRef?: string): { params: Promise<Record<string, string>> } => {
      const params: Record<string, string> = {}; if (resourceRef) params.resourceRef = resourceRef;
      return { params: Promise.resolve(params) };
    };
    const request = (userId: string, method: string, value?: unknown) => new Request('http://localhost:3001/api/capabilities/packages/store/install', {
      method, headers: fixture.headers(userId), ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const wireSource = (await add('plugin', 'store-http')).selection;
    const wire = await installRoute.POST(request('owner', 'POST', { source: wireSource, ownership: { type: 'organization' }, grants: [grant], responsibleUserId: 'bob' }), context());
    assert.equal(wire.status, 200); const wireBody = await wire.json() as { success: boolean; data: CapabilityPackageStoreApplicationResult };
    assert.equal(wireBody.success, true); assertNoOrigin(wireBody); const wirePayload = wireBody.data;
    const privateWire = await packages.inspectCapabilityPackage(owner, wirePayload.resource.resourceRef); assert.ok(privateWire.sourceStamp.storeOrigin);
    const wireV2 = (await add('plugin', 'store-http', '2.0.0')).selection;
    const wireReviewResponse = await reviewRoute.POST(request('owner', 'POST', { source: wireV2 }), context(wirePayload.resource.resourceRef));
    assert.equal(wireReviewResponse.status, 200); const wireReview = (await wireReviewResponse.json() as { data: CapabilityPackageStoreUpdateReview }).data;
    const wireUpdate = await updateRoute.POST(request('owner', 'POST', updateInput(wireReview)), context(wirePayload.resource.resourceRef));
    assert.equal(wireUpdate.status, 200); assertNoOrigin(await wireUpdate.json());
    const deniedHttpArchives = registry.count('archive'), deniedHttpRows = await beforeCounts();
    for (const source of [deniedSource, wireSource]) {
      assert.equal((await installRoute.POST(request('alice', 'POST', { source, ownership: { type: 'organization' }, grants: [] }), context())).status, 403,
        'Unauthorized free and occupied targets are indistinguishable to a Store caller.');
    }
    assert.equal(registry.count('archive'), deniedHttpArchives); assert.deepEqual(await beforeCounts(), deniedHttpRows);
    assert.equal((await installRoute.POST(request('owner', 'POST', { source: wireSource, ownership: { type: 'user' }, storeOrigin: privateWire.sourceStamp.storeOrigin }), context())).status, 400);
    assert.equal((await installRoute.POST(new Request('http://localhost/api/capabilities/packages/store/install', { method: 'POST', body: '{}' }), context())).status, 401);
    assert.equal((await listRoute.GET(request('owner', 'GET'), context())).status, 200);

    const aggregateResource = await resources.inspectCapabilityResource(owner, wirePayload.resource.resourceRef);
    const aggregatePrivate = await resources.updateCapabilityResource(owner, wirePayload.resource.resourceRef,
      { expectedMetadataRevision: aggregateResource.metadata.metadataRevision, expectedGrantsRevision: aggregateResource.metadata.grantsRevision,
        metadata: { displayName: 'PRIVATE_AGGREGATE_RESOURCE_LABEL' } });
    // Both installed Store readers intentionally use the same configured registry URL.
    let registryReads = 0, secondKind: ReturnType<typeof registry.holdNextRegistry> | undefined;
    let secondReceived!: () => void;
    const secondRequested = new Promise<void>(resolve => { secondReceived = resolve; });
    fixture.setBeforeFetch(async url => {
      if (new URL(url).pathname === '/registry/application' && ++registryReads === 2) {
        secondKind = registry.holdNextRegistry('application');
        void secondKind.requested.then(secondReceived);
      }
    });
    const combinedPending = stores.listCapabilityPackageStoreAction(alice, {});
    await awaitRegistryBarrier(secondRequested, combinedPending, 'Second-kind aggregate barrier', () => secondKind?.release()); assert.ok(secondKind);
    await resources.updateCapabilityResource(owner, wirePayload.resource.resourceRef, { expectedMetadataRevision: aggregatePrivate.metadata.metadataRevision,
      expectedGrantsRevision: aggregatePrivate.metadata.grantsRevision, grants: [] });
    secondKind.release(); const combined = await combinedPending;
    fixture.setBeforeFetch(undefined);
    assert(!combined.stores.some(store => store.installedResources.some(resource => resource.metadata.resourceRef === wirePayload.resource.resourceRef)));
    assert(!JSON.stringify(combined).includes('PRIVATE_AGGREGATE_RESOURCE_LABEL'), 'Combined metadata never retains an earlier kind after a late read-grant revoke.');

    // A lost COMMIT response plus unavailable verification is not reported as success or retried.
    const uncertainSource = (await add('plugin', 'store-commit-unverified')).selection;
    let uncertainPublished = false, verificationUnavailable = false;
    fixture.setAfterQuery(async query => {
      if (/INSERT INTO capability_package_versions/iu.test(query)) uncertainPublished = true;
      if (uncertainPublished && /^COMMIT\s*$/iu.test(query)) {
        verificationUnavailable = true; fixture.setAfterQuery(undefined);
        fixture.setBeforeRead(async read => { if (/capability_package_states/iu.test(read)) throw new Error('Owned fixture verification transport unavailable PRIVATE_TRANSPORT_DETAIL'); });
        throw new Error('Owned fixture lost COMMIT acknowledgement PRIVATE_TRANSPORT_DETAIL');
      }
    });
    const uncertainCounts = await beforeCounts();
    const uncertainResponse = await installRoute.POST(request('owner', 'POST', { source: uncertainSource, ownership: { type: 'user' }, grants: [] }), context());
    assert.equal(verificationUnavailable, true); assert.equal(uncertainResponse.status, 503);
    const uncertainBody = await uncertainResponse.json(); assert(!JSON.stringify(uncertainBody).includes('PRIVATE_TRANSPORT_DETAIL'));
    assert.equal((uncertainBody as { success: boolean }).success, false);
    const getPackageRoute = await import('../app/api/capabilities/packages/[resourceRef]/route');
    const uncertainPointer = (await plugins.readCanvasPluginRegistry(fixture.userScope('owner'))).plugins['store-commit-unverified'];
    assert.ok(uncertainPointer.packageResourceRef);
    const unreadable = await getPackageRoute.GET(request('owner', 'GET'), context(uncertainPointer.packageResourceRef));
    assert.equal(unreadable.status, 503, 'Current package readers fail closed while committed identity cannot be verified.');
    fixture.setBeforeRead(undefined);
    assert.deepEqual(await beforeCounts(), uncertainCounts.map((count, index) => count + [1, 0, 1, 1, 1][index]));
    const recovered = await packages.inspectCapabilityPackage(owner, uncertainPointer.packageResourceRef);
    assert.equal(recovered.state!.packageRevision, 1); assert.equal(recovered.state!.currentPublishedRevisionRef, uncertainPointer.publishedRevisionRef);
    const recoveredCounts = await beforeCounts();
    await assert.rejects(() => stores.installCapabilityPackageFromStoreAction(owner, { source: uncertainSource, ownership: { type: 'user' }, grants: [] }));
    assert.deepEqual(await beforeCounts(), recoveredCounts, 'No second publication is attempted for the uncertain completed instance.');

    const agents = await import('../app/lib/agents/registry'), { piSessions } = await import('../app/lib/db/schema');
    const names = ['list_canvas_package_store', 'inspect_canvas_package_store_update', 'install_canvas_package_from_store', 'update_canvas_package_from_store'];
    await agents.createAgentProfile({ agentId: 'store-application-agent', name: 'Store application specialist', scopeType: 'user', ownerUserId: 'owner',
      organizationId: fixture.organizationId, createdByUserId: 'owner', enabledTools: names });
    await fixture.database.db.insert(piSessions).values({ sessionId: 'store-application-session', userId: 'owner', agentId: 'store-application-agent', workspaceId: 'personal-owner',
      workspaceType: 'personal', organizationId: fixture.organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const { createCapabilityPackageTools } = await import('../app/lib/pi/scoped-tools');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const tools = createCapabilityPackageTools('owner', 'store-application-agent', 'store-application-session');
    const executeTool = async (name: string, value: unknown, withContext = true) => {
      const tool = tools.find(item => item.name === name); assert.ok(tool);
      const current = await resolveAgentExecutionContextForStoredSession({ userId: 'owner', agentId: 'store-application-agent', sessionId: 'store-application-session' });
      return withContext ? runWithAgentExecutionContext(current, () => tool.execute(`application-${name}`, value)) : tool.execute(`application-${name}`, value);
    };
    const toolSource = (await add('skill', 'store-agent')).selection;
    const toolInstalled = await executeTool('install_canvas_package_from_store', { source: toolSource, ownership: { type: 'user' }, grants: [] });
    assertNoOrigin(toolInstalled.details); const toolDetails = toolInstalled.details as { error?: string; capabilityPackage?: { result: CapabilityPackageStoreApplicationResult } };
    assert.equal(toolDetails.error, undefined); assert.ok(toolDetails.capabilityPackage);
    const toolRef = toolDetails.capabilityPackage.result.resource.resourceRef;
    const toolV2 = (await add('skill', 'store-agent', '2.0.0')).selection;
    const toolReviewResult = await executeTool('inspect_canvas_package_store_update', { resourceRef: toolRef, source: toolV2 });
    const toolReview = (toolReviewResult.details as { capabilityPackage: { result: CapabilityPackageStoreUpdateReview } }).capabilityPackage.result;
    const toolUpdated = await executeTool('update_canvas_package_from_store', { resourceRef: toolRef, ...updateInput(toolReview) });
    assertNoOrigin(toolUpdated.details); assert.equal((toolUpdated.details as { error?: string }).error, undefined);
    const forgedTool = await executeTool('install_canvas_package_from_store', { source: toolSource, ownership: { type: 'user' }, forgedReceipt: {} });
    assert.equal((forgedTool.details as { code: string }).code, 'PACKAGE_REQUEST_INVALID');
    const forgedActor = await executeTool('list_canvas_package_store', { actorUserId: 'alice' });
    assert.equal((forgedActor.details as { code: string }).code, 'PACKAGE_REQUEST_INVALID');
    const noContext = await executeTool('list_canvas_package_store', {}, false);
    assert.equal((noContext.details as { code: string }).code, 'PACKAGE_ACCESS_DENIED');
    await agents.createAgentProfile({ agentId: 'store-reader-agent', name: 'Store reader', scopeType: 'user', ownerUserId: 'alice',
      organizationId: fixture.organizationId, createdByUserId: 'alice', enabledTools: names });
    await fixture.database.db.insert(piSessions).values({ sessionId: 'store-reader-session', userId: 'alice', agentId: 'store-reader-agent', workspaceId: 'personal-alice',
      workspaceType: 'personal', organizationId: fixture.organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const readOnlyRights = await resources.inspectCapabilityResource(alice, race.result.resource.resourceRef);
    assert.equal(readOnlyRights.access.canUse, true); assert.equal(readOnlyRights.access.canEdit, false); assert.equal(readOnlyRights.access.canManage, false);
    const readerReview = await stores.inspectCapabilityPackageStoreUpdateAction(owner, race.result.resource.resourceRef, { source: raceSource });
    const readerMutationCounts = await beforeCounts(), readerArchives = registry.count('archive');
    assert.equal((await updateRoute.POST(request('alice', 'POST', updateInput(readerReview)), context(race.result.resource.resourceRef))).status, 403);
    const readerContext = await resolveAgentExecutionContextForStoredSession({ userId: 'alice', agentId: 'store-reader-agent', sessionId: 'store-reader-session' });
    const readerTools = createCapabilityPackageTools('alice', 'store-reader-agent', 'store-reader-session');
    const readerUpdate = readerTools.find(tool => tool.name === 'update_canvas_package_from_store'); assert.ok(readerUpdate);
    const readerDenied = await runWithAgentExecutionContext(readerContext, () => readerUpdate.execute('reader-cannot-update', { resourceRef: race.result.resource.resourceRef, ...updateInput(readerReview) }));
    assert.equal((readerDenied.details as { code: string }).code, 'PACKAGE_ACCESS_DENIED');
    assert.equal(registry.count('archive'), readerArchives); assert.deepEqual(await beforeCounts(), readerMutationCounts);
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { getProgressiveGatewayCapabilityNames } = await import('../app/lib/pi/progressive-tool-gateway');
    const current = await resolveAgentExecutionContextForStoredSession({ userId: 'owner', agentId: 'store-application-agent', sessionId: 'store-application-session' });
    const planningCounts = await beforeCounts(), planningArchives = registry.count('archive');
    const { filterToolsForPlanningMode, PLANNING_MODE_ALLOWED_TOOLS } = await import('../app/lib/pi/planning-mode');
    const loadedPlanningTools = await getPiTools('owner', 'store-application-agent', 'store-application-session', { executionContext: current, strictAuthorization: true, planningMode: true, metadataOnlyExternal: true });
    const planningTools = filterToolsForPlanningMode(loadedPlanningTools);
    const planningNames = [...planningTools.map(tool => tool.name), ...getProgressiveGatewayCapabilityNames(planningTools)];
    assert(PLANNING_MODE_ALLOWED_TOOLS.has('list_canvas_package_store')); assert(PLANNING_MODE_ALLOWED_TOOLS.has('inspect_canvas_package_store_update'));
    assert(!planningNames.includes('install_canvas_package_from_store')); assert(!planningNames.includes('update_canvas_package_from_store'));
    assert.equal(registry.count('archive'), planningArchives); assert.deepEqual(await beforeCounts(), planningCounts);
    console.log('store-application: BetterAuth HTTP, actual AgentTools and final Planning filter no mutations PASS');

    if (native) {
      assert.equal(fixture.native, true);
      const parallelSource = (await add('plugin', 'store-native-namespace')).selection;
      const parallelCounts = await beforeCounts();
      const simultaneous = await Promise.allSettled([grant, editor].map(initial => stores.installCapabilityPackageFromStoreAction(owner,
        { source: parallelSource, ownership: { type: 'organization' }, grants: [initial], responsibleUserId: 'bob' })));
      assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(simultaneous.filter(result => result.status === 'rejected').length, 1);
      const winner = simultaneous.find(result => result.status === 'fulfilled'); assert(winner?.status === 'fulfilled');
      assert.deepEqual(await beforeCounts(), parallelCounts.map((count, index) => count + [1, 1, 1, 1, 1][index]));
      const nativeV2 = (await add('plugin', 'store-native-namespace', '2.0.0')).selection;
      const nativeV3 = (await add('plugin', 'store-native-namespace', '3.0.0')).selection;
      const concurrentReviews = await Promise.all([nativeV2, nativeV3].map(source => stores.inspectCapabilityPackageStoreUpdateAction(owner, winner.value.resource.resourceRef, { source })));
      const beforeUpdates = await resources.inspectCapabilityResource(owner, winner.value.resource.resourceRef);
      const updated = await Promise.allSettled(concurrentReviews.map(review => stores.updateCapabilityPackageFromStoreAction(owner, winner.value.resource.resourceRef, updateInput(review))));
      assert.equal(updated.filter(result => result.status === 'fulfilled').length, 1);
      const updateFailure = updated.find(result => result.status === 'rejected'); assert(updateFailure?.status === 'rejected');
      assert.equal(Reflect.get(updateFailure.reason as object, 'status'), 409);
      const actualWinner = updated.find(result => result.status === 'fulfilled'); assert(actualWinner?.status === 'fulfilled');
      const currentWinner = await packages.inspectCapabilityPackage(owner, winner.value.resource.resourceRef);
      assert.equal(currentWinner.state!.packageRevision, 2); assert.equal(currentWinner.state!.currentPublishedRevisionRef, actualWinner.value.published.revisionRef);
      assert.equal(currentWinner.sourceStamp.checksum, actualWinner.value.published.checksum);
      assert.deepEqual((await resources.inspectCapabilityResource(owner, winner.value.resource.resourceRef)).grants, beforeUpdates.grants);

      const lockSource = (await add('plugin', 'store-native-lock-revoke')).selection;
      const lockResource = await stores.installCapabilityPackageFromStoreAction(owner, { source: lockSource, ownership: { type: 'organization' }, grants: [managerGrant] });
      const lockV2 = (await add('plugin', 'store-native-lock-revoke', '2.0.0')).selection;
      const lockReview = await stores.inspectCapabilityPackageStoreUpdateAction(fixture.actor('bob'), lockResource.resource.resourceRef, { source: lockV2 });
      const lockPointer = await rawRecord('plugin', 'store-native-lock-revoke', { type: 'organization' }, owner);
      const locker = await fixture.openObserverConnection();
      let held = false;
      try {
        await locker.run('BEGIN'); held = true;
        await locker.get('SELECT resource_ref FROM capability_resources WHERE resource_ref=$1 FOR UPDATE', [lockResource.resource.resourceRef]);
        const queued = stores.updateCapabilityPackageFromStoreAction(fixture.actor('bob'), lockResource.resource.resourceRef, updateInput(lockReview));
        const queuedResult = queued.then(value => ({ value, error: null }), error => ({ value: null, error }));
        const deadline = Date.now() + 10_000; let observedWait = false;
        while (Date.now() < deadline) {
          const activity = await sql.get("SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%capability_resources%' AND state='active'") as { count: number };
          if (activity.count > 0) { observedWait = true; break; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert(observedWait, 'Actual PostgreSQL resource row lock wait is observed before current grant revocation.');
        await locker.run('DELETE FROM capability_resource_grants WHERE resource_ref=$1', [lockResource.resource.resourceRef]);
        await locker.run('UPDATE capability_resources SET grants_revision=grants_revision+1 WHERE resource_ref=$1', [lockResource.resource.resourceRef]);
        await locker.run('COMMIT'); held = false;
        const stopped = await queuedResult; assert.equal(stopped.value, null); assert.equal(Reflect.get(stopped.error as object, 'code'), 'PACKAGE_ACCESS_DENIED');
        assert.equal((await packages.inspectCapabilityPackage(owner, lockResource.resource.resourceRef)).state!.packageRevision, 1);
        assert.deepEqual(await rawRecord('plugin', 'store-native-lock-revoke', { type: 'organization' }, owner), lockPointer);
      } finally { if (held) await locker.run('ROLLBACK'); await locker.close(); }
      console.log('store-application: native 8-client PostgreSQL exact namespace/head winners and observed lock-wait revoke PASS');
    }
    assert.equal(fixture.providerRequests(), 0);
    assert.equal((await packages.inspectCapabilityPackage(owner, existingOrg.result.resource.resourceRef)).resource.ownership.type, 'organization');
    console.log('capability-package-store-application-test: PASS (actual signed Team seats + PGlite authority/SQL, configured HTTP registry/ZIP, six atomic scopes, independent grants, exact updates/history, local confirmation, legacy adoption, late revoke/collision, private receipt/HTTP/Agent boundaries, planning no archives or mutations)');
  } finally { await fixture.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.stack : 'Store application fixture failed.'); process.exitCode = 1; });
