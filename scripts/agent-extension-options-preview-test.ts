import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const { resolveAgentExtensionOptionsContext } = await import('../app/lib/agents/extension-options-context');
    const { previewAgentExtensionConfiguration } = await import('../app/lib/agents/extension-options-preview');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const { owner, alice, organizationId, sql } = fixture;
    const ownerActor = { ...owner, source: 'api' as const }, aliceActor = { ...alice, source: 'api' as const };
    const target = { kind: 'prospective' as const, scopeType: 'user' as const };
    const ownerContext = await resolveAgentExtensionOptionsContext(ownerActor, target);
    const source = await createSharedMcpConnection({ ...owner, organizationId }, { ownership: { type: 'organization', organizationId },
      displayName: 'Actual preview connection', accessMode: 'restricted', allowedToolNames: ['read_fixture', 'optional_fixture'],
      grants: [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId,
        canUse: true, canManage: false, allowedToolNames: ['read_fixture'] })),
      config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true } });
    const sharedSelection = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'shared' as const,
      connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision } };
    const empty: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] };
    const fixed: AgentExtensionConfigurationInput = { ...empty, standalone: [{ mode: 'fixed', entry: { selection: sharedSelection, requirement: 'optional', toolCap: null } }] };
    const beforeAgents = await sql.all('SELECT * FROM agents ORDER BY id');
    const ownStandalone = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: fixed, enabledTools: ['mcp'] });
    assert.equal(ownStandalone.preview.configurationReadiness, 'valid');
    assert.deepEqual(ownStandalone.preview.effectiveToolCaps[0].toolCap, ['read_fixture']);
    assert.equal(ownStandalone.preview.providerHealth, 'unknown'); assert.equal(ownStandalone.preview.runtimeReadiness, 'not_checked');
    assert.equal(ownStandalone.preview.finalSaveValidationRequired, true);
    assert.doesNotMatch(ownStandalone.preview.contextPreview ?? '', /"integrations" \{|"read" \{|providerRef|fixture\.invalid/u);
    const aliceContext = await resolveAgentExtensionOptionsContext(aliceActor, target);
    const aliceStandalone = await previewAgentExtensionConfiguration(aliceContext, { operation: 'preview', target, configuration: fixed, enabledTools: ['mcp'] });
    assert.equal(aliceStandalone.preview.configurationReadiness, 'valid', 'Standalone requires current SourceUse, not SourceManage.');
    assert.deepEqual(aliceStandalone.preview.effectiveToolCaps[0].toolCap, ['read_fixture']);
    const disabled = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: fixed, enabledTools: ['__none__'] });
    assert.equal(disabled.preview.configurationReadiness, 'blocked'); assert(disabled.preview.toolConflicts.some(conflict => conflict.code === 'AGENT_EXTENSION_GATEWAY_DISABLED'));

    const name = `preview-package-${randomUUID().slice(0, 8)}`;
    const declared = (id: string) => ({ version: 1, integrationCapabilities: [{ id, application: 'reader', required: true,
      alternatives: [{ source: 'mcp', connector: 'preview-reader', requiredTools: ['read_fixture'] }] }] });
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Actual immutable preview', skills: './skills',
        connectors: { mcp: [{ name: 'preview-reader', required: false }] }, workflow: declared('parent-required') }),
      'skills/preview-child/SKILL.md': '---\nname: preview-child\ndescription: Actual selected child\n---\n\nExact child instructions.\n',
      'skills/preview-child/agents/canvas.yaml': `workflow: ${JSON.stringify(declared('child-required'))}\n`,
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application', entryKey: name,
      version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const unbound: AgentExtensionConfigurationInput = { ...empty, selections: [{ selection: { kind: 'skill', package: pin,
      origin: 'plugin_child', relativeRoot: 'skills/preview-child' }, requirement: 'optional', toolCap: ['read_fixture'] }],
    workflow: { version: 1, packages: [{ ...pin, skillSelection: { kind: 'skills', relativeRoots: ['skills/preview-child'] }, declarations: [] }] } };
    const unboundPreview = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: unbound, enabledTools: ['read', 'mcp'] });
    assert.equal(unboundPreview.preview.configurationReadiness, 'blocked');
    assert.deepEqual(unboundPreview.preview.requirements.map(requirement => [requirement.capabilityId, requirement.state]),
      [['parent-required', 'unbound'], ['child-required', 'unbound']], 'An individually selected child preserves its required parent declarations.');
    assert.match(unboundPreview.preview.contextPreview ?? '', /parent-required/u);
    const bound = structuredClone(unbound); assert(bound.mode === 'fixed' && bound.workflow);
    bound.workflow.packages[0].declarations = [
      { declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'parent-required', selection: { mode: 'fixed',
        alternativeKey: 'mcp:preview-reader', target: { kind: 'shared', source: 'mcp', connectionRef: source.resource.connectionRef,
          bindingRevision: source.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' } }, toolCap: ['read_fixture', 'optional_fixture'] } }] },
      { declarationPath: 'skills/preview-child/agents/canvas.yaml', capabilities: [{ capabilityId: 'child-required', selection: { mode: 'fixed',
        alternativeKey: 'mcp:preview-reader', target: { kind: 'shared', source: 'mcp', connectionRef: source.resource.connectionRef,
          bindingRevision: source.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' } }, toolCap: ['read_fixture', 'optional_fixture'] } }] },
    ];
    const boundPreview = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: bound, enabledTools: ['read', 'mcp'] });
    assert.equal(boundPreview.preview.configurationReadiness, 'valid', JSON.stringify(boundPreview.preview.issues));
    assert(boundPreview.preview.requirements.every(requirement => requirement.state === 'bound'));
    assert(boundPreview.preview.effectiveToolCaps.filter(cap => cap.selection.kind === 'mcp').every(cap => JSON.stringify(cap.toolCap) === '["read_fixture"]'));
    assert(boundPreview.preview.budget.usedBytes <= boundPreview.preview.budget.maxBytes);
    assert(boundPreview.preview.issues.some(issue => issue.code === 'AGENT_EXTENSION_RUNTIME_REGISTRATION_UNKNOWN'));
    const noMappingManage = await previewAgentExtensionConfiguration(aliceContext, { operation: 'preview', target, configuration: bound, enabledTools: ['read', 'mcp'] });
    assert.equal(noMappingManage.preview.configurationReadiness, 'blocked', 'A declared MCP mapping retains its independent SourceManage requirement.');
    const missingRead = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: bound, enabledTools: ['mcp'] });
    assert(missingRead.preview.toolConflicts.some(conflict => conflict.code === 'AGENT_EXTENSION_READ_DISABLED'));

    const rootName = `${name}-root`;
    const rootArchive = await fixture.registry.addPackage('application', 'plugin', rootName, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: rootName, version: '1.0.0', description: 'Actual root preview', skills: '.' }),
      'SKILL.md': '---\nname: preview-root-step\ndescription: Root skill with its own identity\n---\n\nActual root source.\n',
    }, plugins.computeCanvasPluginChecksum);
    const rootPackage = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: rootName, version: '1.0.0', checksum: rootArchive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
    const rootPin = { resourceRef: rootPackage.resource.resourceRef, publishedRevisionRef: rootPackage.published.revisionRef, checksum: rootPackage.published.checksum };
    const rootConfiguration: AgentExtensionConfigurationInput = { ...empty, selections: [{ selection: { kind: 'skill', package: rootPin,
      origin: 'plugin_child', relativeRoot: '' }, requirement: 'optional', toolCap: null }],
    workflow: { version: 1, packages: [{ ...rootPin, skillSelection: { kind: 'skills', relativeRoots: [''] }, declarations: [] }] } };
    const rootPreview = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: rootConfiguration, enabledTools: ['read'] });
    assert.equal(rootPreview.preview.configurationReadiness, 'valid', JSON.stringify(rootPreview.preview.issues));
    assert.match(rootPreview.preview.contextPreview ?? '', /"name":"preview-root-step","package":"P1","root":""/u);

    const budgetName = `${name}-budget`;
    const budgetFiles: Record<string, string> = { '.canvas-plugin/plugin.json': JSON.stringify({ name: budgetName, version: '1.0.0',
      description: 'Actual immutable budget inventory', skills: './skills' }) };
    for (let index = 0; index < 48; index++) {
      const child = `budget-${String(index).padStart(2, '0')}-${'x'.repeat(50)}`;
      budgetFiles[`skills/${child}/SKILL.md`] = `---\nname: ${child}\ndescription: Actual budget child ${index}\n---\n\nRead the exact source.\n`;
    }
    const budgetArchive = await fixture.registry.addPackage('application', 'plugin', budgetName, '1.0.0', budgetFiles, plugins.computeCanvasPluginChecksum);
    const budgetPackage = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: budgetName, version: '1.0.0', checksum: budgetArchive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
    const budgetPin = { resourceRef: budgetPackage.resource.resourceRef, publishedRevisionRef: budgetPackage.published.revisionRef, checksum: budgetPackage.published.checksum };
    const budgetConfiguration: AgentExtensionConfigurationInput = { ...empty, selections: [{ selection: { kind: 'plugin', package: budgetPin,
      skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null }],
    workflow: { version: 1, packages: [{ ...budgetPin, skillSelection: { kind: 'plugin' }, declarations: [] }] } };
    const overflow = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: budgetConfiguration, enabledTools: ['read'] });
    assert.equal(overflow.preview.configurationReadiness, 'blocked');
    assert(overflow.preview.issues.some(issue => issue.code === 'AGENT_EXTENSION_CONTEXT_TOO_LARGE'));
    assert.equal(overflow.preview.contextPreview, undefined);
    assert(overflow.preview.budget.usedBytes > overflow.preview.budget.maxBytes, 'Overflow reports the shared renderer’s measured mandatory bytes.');

    const profiles = await import('../app/lib/composio/composio-profiles');
    const profile = await profiles.createComposioProfile({ ownerUserId: owner.userId, name: 'Existing owned preview profile' });
    const { createPersonalComposioAccountReference } = await import('../app/lib/composio/composio-shared-account-reference');
    const { createIntegrationProviderRef } = await import('../app/lib/integration-tools/references');
    const account = { kind: 'composio' as const, source: 'composio' as const, toolkit: 'canva', target: { kind: 'personal' as const,
      profileId: profile.id, accountBinding: 'account' as const, accountId: 'owned-preview-account', connectionRef: `composio-personal:${profile.id}:owned-preview-account` } };
    // Genuine local seal tests only namespace/receipt metadata, not an SDK account proof.
    const receipt = createPersonalComposioAccountReference({ actorUserId: owner.userId, workspaceId: owner.workspaceId ?? null, organizationId,
      profileId: profile.id, toolkit: 'canva', accountId: account.target.accountId, cacheRevision: 'unverified-fixture-cache', credentialRevision: 'unverified-fixture-credential',
      providerRef: createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit: 'canva',
        scope: { type: 'user', ownerUserId: owner.userId, resourceId: `profile:${profile.id}:canva` } }) });
    const personal: AgentExtensionConfigurationInput = { ...empty, standalone: [{ mode: 'fixed', entry: { selection: account,
      requirement: 'optional', toolCap: null, accountSelectionRef: receipt } }] };
    const personalPreview = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: personal });
    assert.equal(personalPreview.preview.configurationReadiness, 'unknown');
    assert(personalPreview.preview.issues.some(issue => issue.code === 'AGENT_EXTENSION_PERSONAL_RUNTIME_UNKNOWN'));
    const foreign = await previewAgentExtensionConfiguration(aliceContext, { operation: 'preview', target, configuration: personal });
    assert.equal(foreign.preview.configurationReadiness, 'blocked');
    assert.deepEqual(await sql.all('SELECT * FROM agents ORDER BY id'), beforeAgents, 'Prospective preview never creates an Agent or issuer.');

    const management = await import('../app/lib/agents/management-actions');
    const created = await management.createManagedAgent(ownerActor, { name: 'Actual retained preview Agent', extensions: fixed, enabledTools: ['mcp'] });
    const existingTarget = { kind: 'existing' as const, agentId: created.agent.agentId, expectedRevision: created.agent.revision,
      expectedWorkflowRevision: created.agent.workflowRevision ?? 0 };
    const existingContext = await resolveAgentExtensionOptionsContext(ownerActor, existingTarget);
    const createdExtensions = created.extensions;
    assert(createdExtensions?.configuration?.mode === 'fixed');
    const retained = await previewAgentExtensionConfiguration(existingContext, { operation: 'preview', target: existingTarget, configuration: createdExtensions.configuration, enabledTools: ['mcp'] });
    assert.equal(retained.preview.configurationReadiness, 'valid');
    const wrongRetain = structuredClone(createdExtensions.configuration);
    assert(wrongRetain.mode === 'fixed' && wrongRetain.standalone[0].mode === 'fixed');
    wrongRetain.standalone[0].entry.retainedBindingRef = `agent-extension-retain:v1:${'0'.repeat(64)}`;
    const deniedRetain = await previewAgentExtensionConfiguration(existingContext, { operation: 'preview', target: existingTarget, configuration: wrongRetain, enabledTools: ['mcp'] });
    assert.equal(deniedRetain.preview.configurationReadiness, 'blocked');
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} real configuration preview: actual source Use/Manage separation, child/root normalization and immutable parent requirements, effective cap intersection, native read/gateway conflicts, shared renderer measured overflow for actual 48-child package, exact retained snapshot, personal local receipt metadata stays unknown, zero provider requests and no fake Agent/runtime authority.`);
  } finally { await fixture.close(); await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
