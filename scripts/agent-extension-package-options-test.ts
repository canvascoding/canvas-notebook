import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import type { CapabilityResourceActor } from '../app/lib/capabilities/resources/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Actual Store transport, immutable snapshots, source ACLs and SQL; no fake Agent or runtime authority. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  let afterInspection: ((actor: CapabilityResourceActor, reference: string, stack: string) => Promise<void>) | undefined;
  const wrappers = new WeakMap<object, object>();
  loader._load = (name, parent, isMain) => {
    const actual = originalLoad(name, parent, isMain);
    if (name !== '@/app/lib/capabilities/resources/actions') return actual;
    const actions = actual as typeof import('../app/lib/capabilities/resources/actions');
    let wrapper = wrappers.get(actions);
    if (!wrapper) {
      wrapper = new Proxy(actions, { get(target, key, receiver) {
        if (key !== 'inspectCapabilityResource') return Reflect.get(target, key, receiver);
        return async (actor: CapabilityResourceActor, reference: string) => {
          const stack = new Error().stack ?? '', result = await target.inspectCapabilityResource(actor, reference);
          await afterInspection?.(actor, reference, stack);
          return result; // Genuine DTO; scheduling only, never mock or widen access.
        };
      } });
      wrappers.set(actions, wrapper);
    }
    return wrapper;
  };
  try {
    const { owner, alice, sql } = fixture;
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const { readAgentExtensionPackageVersion } = await import('../app/lib/agents/extension-package-options');
    const version = '1.0.0', name = `options-package-${randomUUID().slice(0, 8)}`;
    const workflow = (id: string) => ({ version: 1, integrationCapabilities: [{ id, application: 'canva', required: true,
      alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: ['READ_FIXTURE'] }] }] });
    const skillText = (skillName: string, text: string, selectedVersion = version) =>
      `---\nname: ${skillName}\ndescription: ${text}\nmetadata:\n  version: "${selectedVersion}"\n---\n\n${text} instructions.\n`;
    const rootFiles = (selectedVersion: string) => ({
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: selectedVersion, description: 'Actual package description', skills: '.',
        interface: { displayName: 'Published workflow title', defaultPrompt: ['Use the exact source.'] }, workflow: workflow('parent') }),
      'SKILL.md': skillText('root-options-step', 'Actual root skill', selectedVersion),
      'agents/canvas.yaml': `interface:\n  display_name: Root source title\nworkflow: ${JSON.stringify(workflow('root'))}\n`,
      'skills/child-options-step/SKILL.md': skillText('child-options-step', 'Actual child skill', selectedVersion),
      'skills/child-options-step/agents/canvas.yaml': `interface:\n  display_name: Child source title\nworkflow: ${JSON.stringify(workflow('child'))}\n`,
    });
    const grants = [...[owner.userId, alice.userId].map(targetId => ({ targetType: 'user' as const, targetId,
      canUse: true, canEdit: false, canManage: false })), { targetType: 'user' as const, targetId: 'bob', canUse: false, canEdit: true, canManage: false }];
    const archive = await fixture.registry.addPackage('application', 'plugin', name, version, rootFiles(version), plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version, checksum: archive.checksum }, ownership: { type: 'organization' }, grants });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const agentRowsBefore = await sql.all('SELECT * FROM agents ORDER BY id');
    const selected = await readAgentExtensionPackageVersion(alice, pin, { allowPersonalPackages: false });
    assert.equal(selected.metadata.title, 'Published workflow title'); assert.equal(selected.metadata.version, version);
    assert.deepEqual(selected.metadata.defaultPrompts, ['Use the exact source.']);
    assert.deepEqual(selected.metadata.skillRoots, [
      { name: 'root-options-step', title: 'Root source title', description: 'Actual root skill', relativeRoot: '' },
    ]);
    assert.deepEqual(selected.metadata.declarations.map(value => value.declarationPath),
      ['.canvas-plugin/plugin.json', 'agents/canvas.yaml']);
    assert.deepEqual(selected.source.skills.map(value => path.relative(selected.source.rootPath, value.skill.path).split(path.sep).join('/')),
      ['SKILL.md']);
    assert.match(selected.source.skills[0].skill.content, /Actual root skill instructions/u);
    assert.doesNotMatch(JSON.stringify(selected.metadata), /rootPath|runtimePath|ownerUserId|storeOrigin|\/private\/|\/Users\//u);
    assert.equal('workflowProof' in selected || 'runtimeProof' in selected, false);
    await assert.rejects(() => readAgentExtensionPackageVersion(fixture.actor('bob'), pin, { allowPersonalPackages: false }), { code: 'AGENT_WORKFLOW_PACKAGE_DENIED' });
    await assert.rejects(() => readAgentExtensionPackageVersion(alice, { ...pin, checksum: '0'.repeat(64) }, { allowPersonalPackages: false }),
      { code: 'AGENT_WORKFLOW_PACKAGE_CHANGED' });
    await assert.rejects(() => readAgentExtensionPackageVersion(alice, { ...pin, publishedRevisionRef: `canvas-package-revision:${randomUUID()}` },
      { allowPersonalPackages: false }), { code: 'AGENT_WORKFLOW_PACKAGE_CHANGED' });
    const child = (await resources.listCapabilityResources(alice)).find(value => value.artifact.sourceType === 'plugin'
      && value.artifact.name === 'root-options-step'); assert(child);
    await assert.rejects(() => readAgentExtensionPackageVersion(alice, { ...pin, resourceRef: child.metadata.resourceRef },
      { allowPersonalPackages: false }));

    const nestedName = `${name}-nested`;
    const nestedFiles = { '.canvas-plugin/plugin.json': JSON.stringify({ name: nestedName, version, skills: './skills',
      description: 'Declared nested inventory', workflow: workflow('nested-parent') }),
      'skills/nested-options-step/SKILL.md': skillText('nested-options-step', 'Actual declared nested child'),
      'skills/nested-options-step/agents/canvas.yaml': `interface:\n  display_name: Nested source title\nworkflow: ${JSON.stringify(workflow('nested-child'))}\n` };
    const nestedArchive = await fixture.registry.addPackage('application', 'plugin', nestedName, version, nestedFiles, plugins.computeCanvasPluginChecksum);
    const nested = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: nestedName, version, checksum: nestedArchive.checksum }, ownership: { type: 'organization' }, grants });
    const nestedVersion = await readAgentExtensionPackageVersion(alice, { resourceRef: nested.resource.resourceRef,
      publishedRevisionRef: nested.published.revisionRef, checksum: nested.published.checksum }, { allowPersonalPackages: false });
    assert.deepEqual(nestedVersion.metadata.skillRoots, [{ name: 'nested-options-step', title: 'Nested source title',
      description: 'Actual declared nested child', relativeRoot: 'skills/nested-options-step' }]);
    assert.deepEqual(nestedVersion.metadata.declarations.map(value => value.declarationPath),
      ['.canvas-plugin/plugin.json', 'skills/nested-options-step/agents/canvas.yaml']);

    const v2 = await fixture.registry.addPackage('application', 'plugin', name, '2.0.0', rootFiles('2.0.0'), plugins.computeCanvasPluginChecksum);
    const review = await stores.inspectCapabilityPackageStoreUpdateAction(owner, pin.resourceRef, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '2.0.0', checksum: v2.checksum } });
    await stores.updateCapabilityPackageFromStoreAction(owner, pin.resourceRef, { source: review.source, expectedMetadataRevision: review.expectedMetadataRevision,
      expectedGrantsRevision: review.expectedGrantsRevision, expectedPackageRevision: review.expectedPackageRevision,
      expectedPublishedRevisionRef: review.expectedPublishedRevisionRef, expectedLocalChecksum: review.expectedLocalChecksum, replaceLocalChanges: false });
    const oldVersion = await readAgentExtensionPackageVersion(alice, pin, { allowPersonalPackages: false });
    assert.equal(oldVersion.metadata.version, '1.0.0'); assert.equal(oldVersion.metadata.publishedRevisionRef, pin.publishedRevisionRef);
    assert.equal((await packages.inspectCapabilityPackage(owner, pin.resourceRef)).published?.version, '2.0.0');

    const privateName = `private-option-${randomUUID().slice(0, 8)}`;
    const privateArchive = await fixture.registry.addPackage('application', 'skill', privateName, version,
      { 'SKILL.md': skillText(privateName, 'Personal package source'), 'agents/canvas.yaml': 'interface:\n  display_name: Private source title\n  default_prompt: Follow this exact skill.\n' }, plugins.computeCanvasPluginChecksum);
    const privatePackage = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: privateName, version, checksum: privateArchive.checksum }, ownership: { type: 'user' }, grants: [] });
    const privatePin = { resourceRef: privatePackage.resource.resourceRef, publishedRevisionRef: privatePackage.published.revisionRef, checksum: privatePackage.published.checksum };
    const own = await readAgentExtensionPackageVersion(owner, privatePin, { allowPersonalPackages: true });
    assert.equal(own.metadata.skillRoots[0].relativeRoot, ''); assert.equal(own.metadata.title, 'Private source title');
    assert.deepEqual(own.metadata.defaultPrompts, ['Follow this exact skill.']);
    await assert.rejects(() => readAgentExtensionPackageVersion(owner, privatePin, { allowPersonalPackages: false }), { code: 'AGENT_WORKFLOW_PACKAGE_DENIED' });

    const conflictName = `conflict-option-${randomUUID().slice(0, 8)}`;
    const conflictArchive = await fixture.registry.addPackage('application', 'skill', conflictName, version,
      { 'SKILL.md': skillText(conflictName, 'Exact scope-conflict source') }, plugins.computeCanvasPluginChecksum);
    const conflictSource = { kind: 'skill' as const, registryId: 'store-application', entryKey: conflictName, version, checksum: conflictArchive.checksum };
    await stores.installCapabilityPackageFromStoreAction(owner, { source: conflictSource, ownership: { type: 'organization' }, grants });
    const conflicted = await stores.installCapabilityPackageFromStoreAction(owner, { source: conflictSource, ownership: { type: 'user' }, grants: [] });
    assert.equal((await resources.inspectCapabilityResource(owner, conflicted.resource.resourceRef)).activation?.readiness, 'conflict');
    await assert.rejects(() => readAgentExtensionPackageVersion(owner, { resourceRef: conflicted.resource.resourceRef,
      publishedRevisionRef: conflicted.published.revisionRef }, { allowPersonalPackages: true }), { code: 'AGENT_WORKFLOW_PACKAGE_DENIED' });

    const { CapabilityPolicyStore } = await import('../app/lib/capabilities/policy-store');
    const policyStore = new CapabilityPolicyStore(sql);
    await policyStore.upsertPolicy({ organizationId: fixture.organizationId, resourceType: 'plugin', resourceId: installed.resource.legacyResourceId,
      targetType: 'user', targetId: alice.userId, effect: 'blocked', actorUserId: owner.userId });
    await assert.rejects(() => readAgentExtensionPackageVersion(alice, pin, { allowPersonalPackages: false }), { code: 'AGENT_WORKFLOW_PACKAGE_DENIED' });
    await sql.run('DELETE FROM capability_policies WHERE organization_id=$1 AND resource_id=$2', [fixture.organizationId, installed.resource.legacyResourceId]);
    await sql.run("UPDATE capability_resources SET status='archived' WHERE resource_ref=$1", [pin.resourceRef]);
    await assert.rejects(() => readAgentExtensionPackageVersion(alice, pin, { allowPersonalPackages: false }));
    await sql.run("UPDATE capability_resources SET status='active' WHERE resource_ref=$1", [pin.resourceRef]);

    let inspections = 0, revoked = false;
    afterInspection = async (acting, reference, stack) => {
      if (acting.userId !== alice.userId || reference !== pin.resourceRef || !stack.includes('usableDescriptor')) return;
      if (++inspections !== 2) return;
      revoked = true;
      // The real metadata action has returned and released its transaction.
      // Revoke actual source Use before the reader's final SQL Use check.
      await sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [pin.resourceRef, alice.userId]);
    };
    await assert.rejects(() => readAgentExtensionPackageVersion(alice, pin, { allowPersonalPackages: false }));
    afterInspection = undefined;
    assert.equal(revoked, true);
    await assert.rejects(() => resources.inspectCapabilityResource(alice, pin.resourceRef), { code: 'CAPABILITY_RESOURCE_NOT_FOUND' });
    await sql.run('UPDATE capability_resource_grants SET can_use=1 WHERE resource_ref=$1 AND target_id=$2', [pin.resourceRef, alice.userId]);
    assert.deepEqual(await sql.all('SELECT * FROM agents ORDER BY id'), agentRowsBefore, 'Target-neutral reads create or change no Agent.');

    // Existing System/Email V1 options retain their established allowance for a
    // manager's own personal package; new V2 callers choose the stricter flag.
    const registry = await import('../app/lib/agents/registry');
    const legacy = await import('../app/lib/agents/workflow-management');
    const email = await registry.ensureEmailAgent();
    const legacyVersion = await legacy.listAgentWorkflowManagementOptions({ ...owner, source: 'api' }, { view: 'package-version', agentId: email.agentId,
      expectedRevision: email.revision, expectedWorkflowRevision: email.workflowRevision ?? 0,
      resourceRef: privatePin.resourceRef, publishedRevisionRef: privatePin.publishedRevisionRef });
    assert.equal(legacyVersion.view, 'package-version'); assert(legacyVersion.view === 'package-version');
    assert.deepEqual(Object.keys(legacyVersion).sort(), ['schemaVersion', 'agentId', 'revision', 'workflowRevision', 'view', 'resourceRef', 'publishedRevisionRef',
      'checksum', 'kind', 'name', 'version', 'skillRoots', 'declarations'].sort());
    assert.deepEqual(legacyVersion.skillRoots, [{ name: privateName, relativeRoot: '' }]);
    const originalSkill = await fs.readFile(oldVersion.source.skills[0].skill.path);
    const originalMode = (await fs.stat(oldVersion.source.skills[0].skill.path)).mode;
    try {
      await fs.chmod(oldVersion.source.skills[0].skill.path, 0o600);
      await fs.writeFile(oldVersion.source.skills[0].skill.path, Buffer.concat([originalSkill, Buffer.from('\nOwned snapshot corruption.\n')]));
      await assert.rejects(() => readAgentExtensionPackageVersion(alice, pin, { allowPersonalPackages: false }));
    } finally {
      await fs.writeFile(oldVersion.source.skills[0].skill.path, originalSkill);
      await fs.chmod(oldVersion.source.skills[0].skill.path, originalMode);
    }
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} target-neutral package options: exact immutable old pin/checksum and snapshot integrity, real root/child/parent metadata, standalone root, separate SourceUse, strict personal-scope option, blocked/conflict/archive denial, late SQL Use revocation, no fake Agent/runtime proof, legacy System DTO unchanged; provider IO zero.`);
  } finally {
    afterInspection = undefined; loader._load = originalLoad;
    await fixture.close(); await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
