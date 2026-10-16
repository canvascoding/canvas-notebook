import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import type { AgentWorkflowInternalSnapshot } from '../app/lib/agents/workflow-contracts';
import {
  projectExtensionSkillMetadata, projectExtensionPackageMetadata,
  projectPinnedExtensionSkillCandidates, projectPinnedExtensionEffectiveCapabilities, selectExtensionRuntimeSkillCandidates,
} from '../app/lib/capabilities/packages/extension-context-metadata';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Real published sources, effective policies, writers and runtime proofs; the pure projection issues none. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const { alice, owner, sql, organizationId } = fixture;
    const actor = { ...alice, source: 'api' as const };
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/store');
    const catalog = await import('../app/lib/capabilities/catalog');
    const { resolveEffectiveCapabilities } = await import('../app/lib/capabilities/effective-resolver');
    const { CapabilityPolicyStore } = await import('../app/lib/capabilities/policy-store');
    const policies = new CapabilityPolicyStore(sql);
    const { readAgentExtensionPackageVersion } = await import('../app/lib/agents/extension-package-options');
    const { readPackageExtensionSourceMetadata } = await import('../app/lib/capabilities/packages/extension-metadata');
    const { projectPackageExtensionSelection } = await import('../app/lib/capabilities/packages/extension-projection');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const management = await import('../app/lib/agents/management-actions');
    const registry = await import('../app/lib/agents/registry');
    const { piSessions } = await import('../app/lib/db/schema');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const { parseSkillFile } = await import('../app/lib/skills/canvas-skill-manifest');
    const { readExactPackageInventory } = await import('../app/lib/capabilities/packages/io');
    const prefix = `metadata-${randomUUID().slice(0, 8)}`;
    const grants = [owner.userId, alice.userId].map(targetId => ({ targetType: 'user' as const, targetId,
      canUse: true, canEdit: true, canManage: true }));
    const declaration = (id: string) => ({ version: 1, integrationCapabilities: [{ id, application: 'canva', required: false,
      alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: ['READ_EXACT'] }] }] });
    const body = (name: string, version = '1.0.0') => `---\nname: ${name}\ndescription: Exact ${name} source\nmetadata:\n  version: "${version}"\n---\n\nRead this source.\n`;
    const rootFiles = (version: string) => ({ '.canvas-plugin/plugin.json': JSON.stringify({ name: `${prefix}-root`, version, skills: '.',
      description: `  Published ${version}  description  `, interface: { displayName: 'Root metadata',
        defaultPrompt: ['Exact held root', 'Second instruction', 'Third', 'Fourth', 'Omit fifth'] }, workflow: declaration('parent') }),
      'SKILL.md': body('metadata-root-step', version),
      'agents/canvas.yaml': `interface:\n  display_name: Exact root title\nworkflow: ${JSON.stringify(declaration('root'))}\n` });
    async function install(kind: 'plugin' | 'skill', name: string, files: Record<string, string>) {
      const archive = await fixture.registry.addPackage('application', kind, name, '1.0.0', files, plugins.computeCanvasPluginChecksum);
      return stores.installCapabilityPackageFromStoreAction(owner, { source: { kind, registryId: 'store-application', entryKey: name,
        version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' }, grants });
    }
    const root = await install('plugin', `${prefix}-root`, rootFiles('1.0.0'));
    const nested = await install('plugin', `${prefix}-nested`, {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: `${prefix}-nested`, version: '1.0.0', skills: './skills',
        description: 'Real nested selection', workflow: declaration('nested-parent') }),
      'skills/metadata-required-child/SKILL.md': body('metadata-required-child'),
      'skills/metadata-required-child/agents/canvas.yaml': `workflow: ${JSON.stringify(declaration('required-child'))}\n`,
      'skills/metadata-optional-child/SKILL.md': body('metadata-optional-child'),
      'skills/metadata-optional-child/agents/canvas.yaml': `workflow: ${JSON.stringify(declaration('optional-child'))}\n`,
    });
    const required = await install('skill', `${prefix}-required`, { 'SKILL.md': body(`${prefix}-required`) });
    const optional = await install('skill', `${prefix}-optional`, { 'SKILL.md': body(`${prefix}-optional`) });
    const policyContext = { userId: alice.userId, organizationId, role: 'member', workspaceId: alice.workspaceId };
    const nestedChild = (await catalog.loadCapabilityCandidates(policyContext, { resolveConnections: false }))
      .find(value => value.ref.sourcePluginId === nested.resource.legacyResourceId && value.ref.name === 'metadata-required-child');
    assert(nestedChild);
    for (const [resourceType, resourceId, effect] of [
      ['skill', nestedChild.ref.resourceId, 'required'], ['skill', required.resource.legacyResourceId, 'required'],
      ['skill', optional.resource.legacyResourceId, 'default-enabled'],
    ] as const) await policies.upsertPolicy({ organizationId, resourceType, resourceId, targetType: 'user', targetId: alice.userId,
      effect, actorUserId: owner.userId });
    const { setCapabilityPreference } = await import('../app/lib/capabilities/preference-store');
    await setCapabilityPreference({ userId: alice.userId, resourceId: optional.resource.legacyResourceId, enabled: true });
    const pin = (value: typeof root) => ({ resourceRef: value.resource.resourceRef,
      publishedRevisionRef: value.published.revisionRef, checksum: value.published.checksum });
    const complete: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', standalone: [],
      selections: [{ selection: { kind: 'plugin', package: pin(root), skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null },
        { selection: { kind: 'plugin', package: pin(nested), skillSelection: { kind: 'subset', relativeRoots: [] } }, requirement: 'optional', toolCap: null }],
      workflow: { version: 1, packages: [root, nested].map(value => ({ ...pin(value), skillSelection: { kind: 'plugin' }, declarations: [] })) } };
    const created = await management.createManagedAgent(actor, { name: `${prefix} fixed`, enabledTools: ['read'], extensions: complete });
    async function contextFor(agentId: string): Promise<AgentExecutionContext> {
      const sessionId = `${agentId}-${randomUUID()}`;
      await fixture.database.db.insert(piSessions).values({ sessionId, userId: alice.userId, agentId, workspaceId: alice.workspaceId,
        workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
      return sessions.resolveAgentExecutionContextForSession({ userId: alice.userId, sessionId, agentId });
    }
    async function checkParity(context: AgentExecutionContext, snapshot: AgentWorkflowInternalSnapshot) {
      const candidates = await catalog.loadCapabilityCandidates(policyContext, { resolveConnections: false });
      const effective = resolveEffectiveCapabilities({ context: policyContext, candidates: candidates.map(candidate => candidate.ref.resourceType === 'plugin'
        ? { ...candidate, connectionRequirementCount: 0 } : candidate), policies: await policies.listOrganizationPolicies(organizationId) });
      const actualSelection = await runtime.getAuthorizedAgentWorkflowPackageSelections(context);
      const captured = await runtime.captureCapabilityPackageRuntimeBindings(context, { selection: actualSelection });
      const packageSkills: import('../app/lib/capabilities/types').CapabilityCandidate[] = [];
      const preparedPackages: Array<{ candidate: import('../app/lib/capabilities/types').CapabilityCandidate;
        skills: import('../app/lib/capabilities/types').CapabilityCandidate[] }> = [];
      const projected = [];
      for (const binding of snapshot.bindings) {
        if (!binding.configuration) continue;
        const source = binding.configuration;
        const held = await readAgentExtensionPackageVersion(alice, { resourceRef: source.resourceRef,
          publishedRevisionRef: source.publishedRevisionRef, checksum: source.checksum }, { allowPersonalPackages: false });
        const record = await resources.findCapabilityResourceRecord(source.resourceRef); assert(record);
        const candidate = effective.capabilities.find(value => value.ref.resourceId === record.storage.resourceId); assert(candidate);
        const published = (source.resourceRef === root.resource.resourceRef ? root : nested).published;
        const metadata = await readPackageExtensionSourceMetadata({ ...published, owner: record.metadata.ownership, rootPath: held.source.rootPath });
        const all = await resources.withAuthorizedCapabilityPackageResource(alice, record.storage, 'use', undefined, async authorization =>
          projectPinnedExtensionSkillCandidates({ candidate, effective, metadata, published,
            resourceAccess: authorization.access, resourceMetadata: authorization.record.metadata }));
        const requiredRoots = source.skillSelection.kind === 'plugin' ? metadata.skills.filter(child =>
          effective.capabilities.find(value => value.ref.resourceId === all.find(value => value.ref.name === child.skill.name)?.ref.resourceId)
            ?.effectivePolicy === 'required').map(child => child.relativeRoot) : [];
        const normalized = projectPackageExtensionSelection({ source, kind: published.kind,
          inventory: held.metadata.skillRoots, selections: binding.extensionSelections, requiredRoots });
        const selected = all.filter(value => metadata.skills.some(child => child.skill.name === value.ref.name && normalized.selectedRoots.includes(child.relativeRoot)));
        packageSkills.push(...selected);
        preparedPackages.push({ candidate, skills: selected });
        const skillMetadata = selected.map(candidate => {
          const child = metadata.skills.find(child => child.skill.name === candidate.ref.name)!;
          return projectExtensionSkillMetadata({ candidate, skill: child.skill,
            required: effective.capabilities.find(value => value.ref.resourceId === candidate.ref.resourceId)?.effectivePolicy === 'required',
            package: { ...pin(source.resourceRef === root.resource.resourceRef ? root : nested), kind: published.kind, relativeRoot: child.relativeRoot } });
        });
        projected.push(projectExtensionPackageMetadata({ published, configuration: normalized.configuration, metadata, skills: skillMetadata,
          workflowVersion: snapshot.workflowVersion }));
      }
      assert.deepEqual(projected, runtime.getAuthorizedAgentWorkflowPackageMetadata(actualSelection, context), 'Actual runtime and prepared-source presentation must be identical.');
      const projectedEffective = projectPinnedExtensionEffectiveCapabilities({ effective, workflowVersion: snapshot.workflowVersion,
        packages: preparedPackages, role: policyContext.role, policies: await policies.listOrganizationPolicies(organizationId) });
      const selected = selectExtensionRuntimeSkillCandidates({ effective: projectedEffective, agentKind: 'special', relevantSkills: snapshot.agent.relevantSkills,
        workflowVersion: snapshot.workflowVersion, packageSkills });
      const projectedSkills = [];
      for (const candidate of selected) {
        const held = projected.flatMap(pkg => pkg.skills).find(skill => skill.resourceId === candidate.ref.resourceId);
        if (held) projectedSkills.push(held);
        else {
          const skill = await parseSkillFile(candidate.runtimePath!); assert(skill);
          const binding = captured.skillPackageBindings.find(value => value.resourceId === candidate.ref.resourceId);
          const coreBinding = captured.corePluginSkillBindings.find(value => value.resourceId === candidate.ref.resourceId);
          const metadata = projectExtensionSkillMetadata({ candidate, skill,
            required: effective.capabilities.find(value => value.ref.resourceId === candidate.ref.resourceId)?.effectivePolicy === 'required',
            ...(binding ? { runtimePath: binding.runtimePath, package: { resourceRef: binding.resourceRef, publishedRevisionRef: binding.publishedRevisionRef,
              checksum: binding.checksum, kind: 'skill', relativeRoot: binding.childRelativeRoot } } : {}) });
          if (coreBinding) {
            const parent = projectedEffective.capabilities.find(value => value.ref.resourceId === coreBinding.parentResourceId); assert(parent);
            const source = await plugins.getCanvasPlugin(parent.ref.name, { userId: alice.userId }); assert(source?.core);
            const inventory = await readExactPackageInventory(path.dirname(candidate.runtimePath!));
            assert.equal(source.checksum, coreBinding.parentChecksum);
            assert.equal(inventory.checksum, coreBinding.checksum);
            projectedSkills.push(Object.freeze({ ...metadata, coreSource: Object.freeze({ resourceId: candidate.ref.resourceId,
              checksum: inventory.checksum, parentResourceId: parent.ref.resourceId, parentChecksum: source.checksum }) }));
          } else projectedSkills.push(metadata);
        }
      }
      assert.deepEqual(projectedSkills, await runtime.getAuthorizedAgentWorkflowSkillMetadata(actualSelection, context, { bindings: captured.skillPackageBindings }));
      assert.equal(runtime.isAuthorizedAgentWorkflowPackageSelections(projected, context), false, 'Pure presentation never becomes a runtime issuer.');
      assert.throws(() => runtime.getAuthorizedAgentWorkflowPackageMetadata(structuredClone(actualSelection), context), { code: 'PACKAGE_ACCESS_DENIED' });
      assert(projected.every(pkg => Object.isFrozen(pkg) && Object.isFrozen(pkg.skills) && Object.isFrozen(pkg.declarations)));
      return { projected, projectedSkills, effective, packageSkills };
    }
    const fixedSnapshot = await workflows.readManagedAgentWorkflow(actor, created.agent.agentId);
    const fixedContext = await contextFor(created.agent.agentId);
    const fixed = await checkParity(fixedContext, fixedSnapshot);
    const rootMetadata = fixed.projected.find(value => value.resourceRef === root.resource.resourceRef)!;
    const nestedMetadata = fixed.projected.find(value => value.resourceRef === nested.resource.resourceRef)!;
    assert.deepEqual(rootMetadata.defaultPrompts, ['Exact held root', 'Second instruction', 'Third', 'Fourth']);
    assert.equal(rootMetadata.skills[0].package?.relativeRoot, '');
    assert.deepEqual(nestedMetadata.skills.map(skill => skill.name), ['metadata-required-child']);
    assert.deepEqual(nestedMetadata.declarations.map(value => value.declarationPath), ['.canvas-plugin/plugin.json', 'skills/metadata-required-child/agents/canvas.yaml']);
    assert(fixed.projectedSkills.some(skill => skill.name === `${prefix}-required` && skill.required));
    assert(fixed.projectedSkills.some(skill => skill.core), 'Actual bundled Core skills remain in a fixed specialized selection.');
    assert(!fixed.projectedSkills.some(skill => skill.name === `${prefix}-optional` || skill.name === 'metadata-optional-child'));

    const updatedArchive = await fixture.registry.addPackage('application', 'plugin', `${prefix}-root`, '2.0.0', rootFiles('2.0.0'), plugins.computeCanvasPluginChecksum);
    const review = await stores.inspectCapabilityPackageStoreUpdateAction(owner, pin(root).resourceRef, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: `${prefix}-root`, version: '2.0.0', checksum: updatedArchive.checksum } });
    await stores.updateCapabilityPackageFromStoreAction(owner, pin(root).resourceRef, { source: review.source, expectedMetadataRevision: review.expectedMetadataRevision,
      expectedGrantsRevision: review.expectedGrantsRevision, expectedPackageRevision: review.expectedPackageRevision,
      expectedPublishedRevisionRef: review.expectedPublishedRevisionRef, expectedLocalChecksum: review.expectedLocalChecksum, replaceLocalChanges: false });
    const afterHead = await checkParity(fixedContext, fixedSnapshot);
    const heldRoot = afterHead.projected.find(value => value.resourceRef === root.resource.resourceRef)!;
    assert.equal(heldRoot.version, '1.0.0'); assert.equal(heldRoot.description, 'Published 1.0.0 description');

    const legacy = await registry.createAgentProfile({ name: `${prefix} V1`, scopeType: 'user', ownerUserId: alice.userId, organizationId, createdByUserId: alice.userId });
    await workflows.updateManagedAgentConfiguration({ actor, agentId: legacy.agentId, expectedRevision: legacy.revision, expectedWorkflowRevision: 0,
      workflow: { version: 1, packages: [{ ...pin(root), skillSelection: { kind: 'skills', relativeRoots: [''] }, declarations: [] }] } });
    const legacyResult = await checkParity(await contextFor(legacy.agentId), await workflows.readManagedAgentWorkflow(actor, legacy.agentId));
    assert.deepEqual(legacyResult.projected[0].declarations.map(value => value.declarationPath), ['agents/canvas.yaml'], 'V1 child-only selection preserves its exact historical parent-declaration mask.');
    const inputBefore = JSON.stringify(fixed.effective);
    const inherited = selectExtensionRuntimeSkillCandidates({ effective: fixed.effective, agentKind: 'special', relevantSkills: null, workflowVersion: null, packageSkills: [] });
    assert(inherited.some(value => value.ref.name === `${prefix}-optional`), 'Legacy null retains allowed inherited skills.');
    const empty = selectExtensionRuntimeSkillCandidates({ effective: fixed.effective, agentKind: 'special', relevantSkills: [], workflowVersion: null, packageSkills: [] });
    assert(!empty.some(value => value.ref.name === `${prefix}-optional`)); assert(empty.some(value => value.ref.name === `${prefix}-required`));
    const main = selectExtensionRuntimeSkillCandidates({ effective: fixed.effective, agentKind: 'main', relevantSkills: [], workflowVersion: null, packageSkills: [] });
    assert.deepEqual(main.map(value => value.ref.resourceId), inherited.map(value => value.ref.resourceId));
    assert.equal(JSON.stringify(fixed.effective), inputBefore, 'Pure selection does not change its actual effective source snapshot.');
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} pure extension metadata parity: actual immutable root/nested sources, exact V1/V2 declaration masks, required-child subset, Core/required/inherited/empty policy, held old pin after new HEAD, private runtime proofs preserved, zero provider probes.`);
  } finally { await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
