import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import type { AgentExtensionOptionsResponse } from '../app/lib/agents/extension-options-contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

type FixedAgentExtensions = Extract<AgentExtensionConfigurationInput, { mode: 'fixed' }>;
type PreviewResponse = Extract<AgentExtensionOptionsResponse, { operation: 'preview' }>;

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const { resolveAgentExtensionOptionsContext } = await import('../app/lib/agents/extension-options-context');
    const { previewAgentExtensionConfiguration } = await import('../app/lib/agents/extension-options-preview');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const { presentSharedIntegrationProvider } = await import('../app/lib/integration-tools/connections/provider-policy');
    const storage = await import('../app/lib/agents/storage');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { resolveSpecialAgentRuntimeSettings } = await import('../app/lib/agents/effective-runtime-config');
    const { owner, alice, organizationId, sql } = fixture;
    await storage.writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, activeProvider: 'google',
      runtimeMigrations: { skillToolsDefaultEnabled: true }, providers: { ...DEFAULT_PI_CONFIG.providers,
        google: { ...DEFAULT_PI_CONFIG.providers.google, model: 'fixture-metadata-only-model', thinking: 'high', enabledTools: ['read', 'mcp'] } } });
    const inheritedSettings = await resolveSpecialAgentRuntimeSettings({});
    assert.equal(inheritedSettings.activeProvider, 'google');
    assert.equal(inheritedSettings.providerConfig.model, 'fixture-metadata-only-model');
    assert.equal(inheritedSettings.thinkingLevel, 'high');
    assert.deepEqual(inheritedSettings.enabledTools, ['read', 'mcp']);
    assert.deepEqual(inheritedSettings.overrideState, { model: false, tools: false });
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
    const empty: FixedAgentExtensions = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] };
    const fixed: FixedAgentExtensions = { ...empty, standalone: [{ mode: 'fixed', entry: { selection: sharedSelection, requirement: 'optional', toolCap: null } }] };
    const exactProviderRef = presentSharedIntegrationProvider(source.resource).providerRef;
    const beforeAgents = await sql.all('SELECT * FROM agents ORDER BY id');
    const ownStandalone = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: fixed, enabledTools: ['mcp'] });
    assert.equal(ownStandalone.preview.configurationReadiness, 'valid');
    assert.equal(ownStandalone.preview.contextValidation, 'complete');
    assert.equal(ownStandalone.preview.personalSetupRequired, false);
    assert.deepEqual(ownStandalone.preview.effectiveToolCaps[0].toolCap, ['read_fixture']);
    assert.equal(ownStandalone.preview.providerHealth, 'unknown'); assert.equal(ownStandalone.preview.runtimeReadiness, 'not_checked');
    assert.equal(ownStandalone.preview.finalSaveValidationRequired, true);
    assert(ownStandalone.preview.contextPreview?.includes(`"providerRef":${JSON.stringify(exactProviderRef)}`));
    assert.match(ownStandalone.preview.contextPreview ?? '', /"integrations" \{"action":"search","target":"tools","providerRef":/u);
    assert.match(ownStandalone.preview.contextPreview ?? '', /toolRef.*schemaRef/u);
    assert.doesNotMatch(ownStandalone.preview.contextPreview ?? '', /fixture\.invalid|accountSelectionRef|bindingFingerprint|rootPath/u);
    assert(!ownStandalone.preview.contextPreview?.includes(fixture.root));
    // The real public route inherits the same tools from the seeded Pi model.
    const { POST } = await import('../app/api/agents/extension-options/route');
    const { NextRequest } = await import('next/server');
    const routeBody = { operation: 'preview', target, configuration: fixed };
    const deniedRoute = await POST(new NextRequest('http://localhost:3001/api/agents/extension-options', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(routeBody) }));
    assert.equal(deniedRoute.status, 401);
    const publicRoute = await POST(new NextRequest(`http://localhost:3001/api/agents/extension-options?workspaceId=${owner.workspaceId}`, {
      method: 'POST', headers: fixture.headers(owner.userId), body: JSON.stringify(routeBody) }));
    assert.equal(publicRoute.status, 200);
    assert.equal(publicRoute.headers.get('cache-control'), 'private, no-store');
    const publicBody = await publicRoute.json() as { success: boolean; data: PreviewResponse };
    assert.equal(publicBody.success, true);
    assert.equal(publicBody.data.preview.contextValidation, 'complete');
    assert.equal(publicBody.data.preview.configurationReadiness, 'valid');
    assert(publicBody.data.preview.contextPreview?.includes(exactProviderRef));
    const explicitInheritedTools = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target,
      configuration: fixed, enabledTools: ['read', 'mcp'] });
    assert.deepEqual(publicBody.data.preview.budget, explicitInheritedTools.preview.budget,
      'Inherited read/MCP registration matches the actual explicit equivalent.');
    await assert.rejects(previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target }),
      { code: 'AGENT_EXTENSION_PREVIEW_INVALID' }, 'Omission means keep only for an actual existing Agent.');
    const aliceContext = await resolveAgentExtensionOptionsContext(aliceActor, target);
    const aliceStandalone = await previewAgentExtensionConfiguration(aliceContext, { operation: 'preview', target, configuration: fixed, enabledTools: ['mcp'] });
    assert.equal(aliceStandalone.preview.configurationReadiness, 'valid', 'Standalone requires current SourceUse, not SourceManage.');
    assert.deepEqual(aliceStandalone.preview.effectiveToolCaps[0].toolCap, ['read_fixture']);
    const prospectiveClearedModel = await previewAgentExtensionConfiguration(aliceContext, { operation: 'preview', target,
      configuration: fixed, defaultProviderInstallationId: null, defaultProvider: null, defaultModel: null, defaultThinking: null });
    assert.equal(prospectiveClearedModel.preview.configurationReadiness, 'valid',
      'A prospective user Agent with no model override needs no model-administration authority.');
    // This interleaving needs genuine independent PostgreSQL transactions;
    // the PGlite adapter intentionally has one in-memory connection.
    if (fixture.native) {
      const changedSource = await createSharedMcpConnection({ ...owner, organizationId }, { ownership: { type: 'organization', organizationId },
        displayName: 'Actual source changed before final Preview frame', accessMode: 'restricted', allowedToolNames: ['read_fixture'],
        grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canManage: false, allowedToolNames: ['read_fixture'] }],
        config: { url: 'https://changed-fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true } });
      const changedConfiguration: FixedAgentExtensions = { ...empty, standalone: [{ mode: 'fixed', entry: { requirement: 'optional', toolCap: null,
        selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: changedSource.resource.connectionRef,
          bindingRevision: changedSource.resource.bindingRevision } } } }] };
      const { mutateSharedIntegrationConnection } = await import('../app/lib/integration-tools/connections/store');
      let changedAtFinalBoundary = false;
      fixture.setAfterQuery(async query => {
        if (changedAtFinalBoundary || query.trim() !== 'BEGIN') return;
        changedAtFinalBoundary = true;
        // Real store mutation on the existing source, before the Preview takes
        // its final connection locks. No provider or authorization is replaced.
        await mutateSharedIntegrationConnection({ ...owner, organizationId }, changedSource.resource.connectionRef, {
          expectedMetadataRevision: changedSource.resource.metadataRevision,
          expectedGrantsRevision: changedSource.resource.grantsRevision,
          expectedBindingRevision: changedSource.resource.bindingRevision, status: 'archived' });
      });
      try {
        const changedPreview = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target,
          configuration: changedConfiguration });
        assert(changedAtFinalBoundary, 'The source was changed at a real Preview transaction boundary.');
        assert.equal(changedPreview.preview.configurationReadiness, 'blocked');
        assert(!changedPreview.preview.contextPreview?.includes(presentSharedIntegrationProvider(changedSource.resource).providerRef));
      } finally { fixture.setAfterQuery(undefined); }
    }
    const disabled = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: fixed, enabledTools: ['__none__'] });
    assert.equal(disabled.preview.configurationReadiness, 'valid');
    assert.equal(disabled.preview.contextValidation, 'complete');
    assert(disabled.preview.toolConflicts.some(conflict => conflict.code === 'AGENT_EXTENSION_DISCOVERY_DISABLED'));
    assert(disabled.preview.issues.some(issue => issue.code === 'AGENT_EXTENSION_DISCOVERY_DISABLED' && issue.severity === 'warning'));
    assert.doesNotMatch(disabled.preview.contextPreview ?? '', /"integrations" \{"action":"search"/u);
    const requiredStandalone = structuredClone(fixed);
    assert(requiredStandalone.standalone[0].mode === 'fixed'); requiredStandalone.standalone[0].entry.requirement = 'required';
    const requiredDisabled = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target,
      configuration: requiredStandalone, enabledTools: ['__none__'] });
    assert.equal(requiredDisabled.preview.configurationReadiness, 'blocked');
    assert(requiredDisabled.preview.toolConflicts.some(conflict => conflict.code === 'AGENT_EXTENSION_DISCOVERY_TOOLS_REQUIRED'));
    const requiredTemplate: FixedAgentExtensions = { ...empty, standalone: [{ mode: 'selectable', configurationId: 'required-template',
      source: 'mcp', requirement: 'required', allowedChoices: [{ choiceId: 'shared-reader', selection: sharedSelection, toolCap: ['read_fixture'] }] }] };
    const requiredTemplatePreview = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target,
      configuration: requiredTemplate });
    assert.equal(requiredTemplatePreview.preview.configurationReadiness, 'valid');
    assert.equal(requiredTemplatePreview.preview.contextValidation, 'complete');
    assert.equal(requiredTemplatePreview.preview.personalSetupRequired, true);

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
    assert.equal(boundPreview.preview.contextValidation, 'complete');
    assert.equal(boundPreview.preview.personalSetupRequired, false);
    assert(!boundPreview.preview.issues.some(issue => issue.code === 'AGENT_EXTENSION_RUNTIME_REGISTRATION_UNKNOWN'));
    assert(boundPreview.preview.contextPreview?.includes(exactProviderRef));
    const packageTemplate = structuredClone(bound);
    assert(packageTemplate.mode === 'fixed' && packageTemplate.workflow);
    for (const declaration of packageTemplate.workflow.packages[0].declarations) {
      for (const capability of declaration.capabilities) {
        assert(capability.selection.mode === 'fixed');
        capability.selection = { mode: 'selectable', allowedChoices: [{ choiceId: 'shared-reader',
          alternativeKey: capability.selection.alternativeKey, target: capability.selection.target, toolCap: capability.selection.toolCap }] };
      }
    }
    const packageTemplatePreview = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target,
      configuration: packageTemplate });
    assert.equal(packageTemplatePreview.preview.configurationReadiness, 'valid', JSON.stringify(packageTemplatePreview.preview.issues));
    assert.equal(packageTemplatePreview.preview.contextValidation, 'complete');
    assert.equal(packageTemplatePreview.preview.personalSetupRequired, true);
    assert(packageTemplatePreview.preview.requirements.every(requirement => requirement.state === 'personal_choice_required'));

    // The public configuration may tighten a declared optional capability.
    // Its effective requirement must match the actual writer, not just the ZIP.
    const promotedName = `${name}-promoted`;
    const promotedArchive = await fixture.registry.addPackage('application', 'plugin', promotedName, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: promotedName, version: '1.0.0', description: 'Optional declaration promoted by its user',
        skills: './skills', connectors: { mcp: [{ name: 'preview-reader', required: false }] },
        workflow: { version: 1, integrationCapabilities: [{ id: 'promoted-reader', application: 'reader', required: false,
          alternatives: [{ source: 'mcp', connector: 'preview-reader', requiredTools: ['read_fixture'] }] }] } }),
      'skills/promoted-child/SKILL.md': '---\nname: promoted-child\ndescription: Actual optional package source\n---\n\nRead the actual source.\n',
    }, plugins.computeCanvasPluginChecksum);
    const promotedPackage = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: promotedName, version: '1.0.0', checksum: promotedArchive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
    const promotedPin = { resourceRef: promotedPackage.resource.resourceRef, publishedRevisionRef: promotedPackage.published.revisionRef,
      checksum: promotedPackage.published.checksum };
    const promotedTemplate: FixedAgentExtensions = { ...empty,
      selections: [{ selection: { kind: 'plugin', package: promotedPin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null }],
      workflow: { version: 1, packages: [{ ...promotedPin, skillSelection: { kind: 'plugin' }, declarations: [{
        declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'promoted-reader', required: true,
          selection: { mode: 'selectable', allowedChoices: [{ choiceId: 'reader', alternativeKey: 'mcp:preview-reader',
            target: { kind: 'shared', source: 'mcp', connectionRef: source.resource.connectionRef,
              bindingRevision: source.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' } }, toolCap: ['read_fixture'] }] } }] }] }] } };
    const promotedPreview = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: promotedTemplate });
    assert.equal(promotedPreview.preview.configurationReadiness, 'valid', JSON.stringify(promotedPreview.preview.issues));
    assert.equal(promotedPreview.preview.contextValidation, 'complete');
    assert.equal(promotedPreview.preview.personalSetupRequired, true);
    assert.deepEqual(promotedPreview.preview.requirements.map(requirement => [requirement.required, requirement.state]),
      [[true, 'personal_choice_required']]);
    const promotedFixed = structuredClone(promotedTemplate);
    assert(promotedFixed.workflow);
    const promotedCapability = promotedFixed.workflow.packages[0].declarations[0].capabilities[0];
    assert(promotedCapability.selection.mode === 'selectable');
    const fixedPromotedChoice = promotedCapability.selection.allowedChoices[0];
    promotedCapability.selection = { mode: 'fixed', alternativeKey: fixedPromotedChoice.alternativeKey,
      target: fixedPromotedChoice.target, toolCap: fixedPromotedChoice.toolCap };
    const promotedDisabled = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target,
      configuration: promotedFixed, enabledTools: ['read'] });
    assert.equal(promotedDisabled.preview.configurationReadiness, 'blocked');
    assert(promotedDisabled.preview.toolConflicts.some(conflict => conflict.code === 'AGENT_EXTENSION_DISCOVERY_TOOLS_REQUIRED'));
    const noMappingManage = await previewAgentExtensionConfiguration(aliceContext, { operation: 'preview', target, configuration: bound, enabledTools: ['read', 'mcp'] });
    assert.equal(noMappingManage.preview.configurationReadiness, 'blocked', 'A declared MCP mapping retains its independent SourceManage requirement.');
    const missingRead = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target, configuration: bound, enabledTools: ['mcp'] });
    assert(missingRead.preview.toolConflicts.some(conflict => conflict.code === 'AGENT_EXTENSION_READ_TOOL_REQUIRED'));

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

    // Metadata-only account context needs an actually configured source. This
    // synthetic key is stored by the real scoped secrets service; it is never
    // used to contact Composio or presented as a verified account credential.
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations',
      [{ key: 'COMPOSIO_API_KEY', value: 'isolated-preview-fixture-key' }], { secretScope: 'user', userId: owner.userId });
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
    assert.equal(personalPreview.preview.configurationReadiness, 'unknown', JSON.stringify(personalPreview.preview.issues));
    assert.equal(personalPreview.preview.contextValidation, 'complete', 'The metadata budget is complete even when account readiness remains unknown.');
    assert(personalPreview.preview.issues.some(issue => issue.code === 'AGENT_EXTENSION_PERSONAL_RUNTIME_UNKNOWN'));
    const foreign = await previewAgentExtensionConfiguration(aliceContext, { operation: 'preview', target, configuration: personal });
    assert.equal(foreign.preview.configurationReadiness, 'blocked');
    const inherited = await previewAgentExtensionConfiguration(ownerContext, { operation: 'preview', target,
      configuration: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } });
    assert.equal(inherited.preview.configurationReadiness, 'unknown');
    assert.equal(inherited.preview.contextValidation, 'unknown', 'Legacy inheritance does not claim a complete fixed budget.');
    assert.deepEqual(await sql.all('SELECT * FROM agents ORDER BY id'), beforeAgents, 'Prospective preview never creates an Agent or issuer.');

    const management = await import('../app/lib/agents/management-actions');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const created = await management.createManagedAgent(ownerActor, { name: 'Actual retained preview Agent', extensions: fixed, enabledTools: ['mcp'] });
    const existingTarget = { kind: 'existing' as const, agentId: created.agent.agentId, expectedRevision: created.agent.revision,
      expectedWorkflowRevision: created.agent.workflowRevision ?? 0 };
    const existingContext = await resolveAgentExtensionOptionsContext(ownerActor, existingTarget);
    const createdExtensions = created.extensions;
    assert(createdExtensions?.configuration?.mode === 'fixed');
    const retained = await previewAgentExtensionConfiguration(existingContext, { operation: 'preview', target: existingTarget, configuration: createdExtensions.configuration, enabledTools: ['mcp'] });
    assert.equal(retained.preview.configurationReadiness, 'valid');
    const { compileKeptAgentExtensionOptionsPreview } = await import('../app/lib/agents/extension-options-preview-compilation');
    const savedFixed = await compileKeptAgentExtensionOptionsPreview(existingContext, { operation: 'preview', target: existingTarget });
    assert(savedFixed);
    assert.deepEqual(ownStandalone.preview.budget, savedFixed.rendered.budget,
      'The prospective complete budget agrees with the actual saved configuration.');
    const wrongRetain = structuredClone(createdExtensions.configuration);
    assert(wrongRetain.mode === 'fixed' && wrongRetain.standalone[0].mode === 'fixed');
    wrongRetain.standalone[0].entry.retainedBindingRef = `agent-extension-retain:v1:${'0'.repeat(64)}`;
    const deniedRetain = await previewAgentExtensionConfiguration(existingContext, { operation: 'preview', target: existingTarget, configuration: wrongRetain, enabledTools: ['mcp'] });
    assert.equal(deniedRetain.preview.configurationReadiness, 'blocked');

    const aliceAgent = await management.createManagedAgent(aliceActor, { name: 'Actual member Preview Agent', extensions: fixed });
    const aliceTarget = { kind: 'existing' as const, agentId: aliceAgent.agent.agentId, expectedRevision: aliceAgent.agent.revision,
      expectedWorkflowRevision: aliceAgent.agent.workflowRevision ?? 0 };
    const aliceExisting = await resolveAgentExtensionOptionsContext(aliceActor, aliceTarget);
    const deniedModelClear = await previewAgentExtensionConfiguration(aliceExisting, { operation: 'preview', target: aliceTarget,
      defaultProviderInstallationId: null, defaultProvider: null, defaultModel: null, defaultThinking: null });
    assert.equal(deniedModelClear.preview.configurationReadiness, 'blocked');
    assert(deniedModelClear.preview.issues.some(issue => issue.code === 'AGENT_ORGANIZATION_ADMIN_REQUIRED'));
    await assert.rejects(workflows.updateManagedAgentConfiguration({ actor: aliceActor, agentId: aliceAgent.agent.agentId,
      expectedRevision: aliceTarget.expectedRevision, defaultProviderInstallationId: null, defaultProvider: null,
      defaultModel: null, defaultThinking: null }), { code: 'AGENT_ORGANIZATION_ADMIN_REQUIRED' });

    // An actual created Agent is arranged into a historical model-override row.
    // This SQL fixture is not presented as a modern public model-default write.
    const historicalAgent = await management.createManagedAgent(ownerActor, { name: 'Actual historical model Preview Agent', extensions: empty });
    await sql.run(`UPDATE agents SET default_provider_installation_id=NULL,default_provider='google',
      default_model='fixture-metadata-only-model',default_thinking='high',revision=revision+1 WHERE agent_id=$1`, [historicalAgent.agent.agentId]);
    const historicalSnapshot = await workflows.readManagedAgentWorkflow(ownerActor, historicalAgent.agent.agentId);
    const historicalTarget = { kind: 'existing' as const, agentId: historicalSnapshot.agent.agentId,
      expectedRevision: historicalSnapshot.agent.revision, expectedWorkflowRevision: historicalSnapshot.workflowRevision };
    const historicalContext = await resolveAgentExtensionOptionsContext(ownerActor, historicalTarget);
    const historicalPreview = await previewAgentExtensionConfiguration(historicalContext, { operation: 'preview', target: historicalTarget,
      enabledTools: ['read', 'mcp'] });
    assert.equal(historicalPreview.preview.configurationReadiness, 'valid', JSON.stringify(historicalPreview.preview.issues));
    assert.equal(historicalPreview.preview.contextValidation, 'complete');
    const historicalSaved = await workflows.updateManagedAgentConfiguration({ actor: ownerActor,
      agentId: historicalSnapshot.agent.agentId, expectedRevision: historicalSnapshot.agent.revision, enabledTools: ['read', 'mcp'] });
    assert.equal(historicalSaved.agent.defaultProviderInstallationId, null);
    assert.equal(historicalSaved.agent.defaultProvider, 'google');
    assert.equal(historicalSaved.agent.defaultModel, 'fixture-metadata-only-model');

    // Required selectable templates are valid configuration, without choosing a
    // creator account for the future user. Exercise the actual final save gate.
    const savedStandaloneTemplate = await management.createManagedAgent(ownerActor, {
      name: 'Actual missing standalone choice template', extensions: requiredTemplate });
    assert.equal(savedStandaloneTemplate.agent.workflowVersion, 2);
    const savedPackageTemplate = await management.createManagedAgent(ownerActor, {
      name: 'Actual missing package choice template', extensions: packageTemplate });
    assert.equal(savedPackageTemplate.agent.workflowVersion, 2);
    const savedPromoted = await management.createManagedAgent(ownerActor, { name: 'Actual promoted requirement template', extensions: promotedTemplate });
    const savedPromotedSnapshot = await workflows.readManagedAgentWorkflow(ownerActor, savedPromoted.agent.agentId);
    const savedPromotedCapability = savedPromotedSnapshot.bindings.flatMap(binding => binding.configuration?.declarations ?? [])
      .flatMap(declaration => declaration.capabilities).find(capability => capability.capabilityId === 'promoted-reader');
    assert.equal(savedPromotedCapability?.required, true, 'The actual committed writer retains the user-tightened requirement.');

    // Include a real required standalone Skill plus the actual bundled Core in
    // the shared budget. This Skill is not part of the selected plugin.
    const requiredName = `${name}-required`;
    const requiredArchive = await fixture.registry.addPackage('application', 'skill', requiredName, '1.0.0', {
      'SKILL.md': `---\nname: ${requiredName}\ndescription: Actual policy-required preview context\nmetadata:\n  version: 1.0.0\n---\n\nRead the exact required source.\n`,
    }, plugins.computeCanvasPluginChecksum);
    const requiredPackage = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: requiredName, version: '1.0.0', checksum: requiredArchive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
    const { CapabilityPolicyStore } = await import('../app/lib/capabilities/policy-store');
    await new CapabilityPolicyStore(sql).upsertPolicy({ organizationId, resourceType: 'skill',
      resourceId: requiredPackage.resource.legacyResourceId, effect: 'required', targetType: 'user', targetId: owner.userId,
      actorUserId: owner.userId });
    const redactionAgent = await management.createManagedAgent(ownerActor, { name: 'Actual full-budget redaction Agent',
      extensions: { ...rootConfiguration, standalone: fixed.standalone } });
    const redactionTarget = { kind: 'existing' as const, agentId: redactionAgent.agent.agentId,
      expectedRevision: redactionAgent.agent.revision, expectedWorkflowRevision: redactionAgent.agent.workflowRevision ?? 0 };
    const redactionContext = await resolveAgentExtensionOptionsContext(ownerActor, redactionTarget);
    const redactionRequest = { operation: 'preview' as const, target: redactionTarget };
    const publicRedaction = await previewAgentExtensionConfiguration(redactionContext, redactionRequest);
    const internal = await compileKeptAgentExtensionOptionsPreview(redactionContext, redactionRequest); assert(internal);
    assert.equal(publicRedaction.preview.contextValidation, 'complete');
    assert.equal(publicRedaction.preview.configurationReadiness, 'valid');
    assert.deepEqual(publicRedaction.preview.budget, internal.rendered.budget);
    assert.equal(publicRedaction.preview.budget.usedBytes, Buffer.byteLength(internal.rendered.prompt, 'utf8'),
      'The public budget measures the full internal prompt before replacing private paths and the reserved query.');
    assert(Buffer.byteLength(publicRedaction.preview.contextPreview ?? '', 'utf8') < publicRedaction.preview.budget.usedBytes);
    assert(internal.rendered.prompt.includes(fixture.root));
    assert(!publicRedaction.preview.contextPreview?.includes(fixture.root));
    assert(publicRedaction.preview.contextPreview?.includes('<task query>'));
    const requiredSkill = internal.packageContext.skills.find(skill => skill.name === requiredName); assert(requiredSkill?.required);
    assert(publicRedaction.preview.contextPreview?.includes(`"name":${JSON.stringify(requiredName)}`));
    const coreSkills = internal.packageContext.skills.filter(skill => skill.core); assert(coreSkills.length > 0);
    for (const skill of coreSkills) assert(publicRedaction.preview.contextPreview?.includes(`"name":${JSON.stringify(skill.name)}`));

    // An omitted configuration retains the current user's exact B preference.
    // Replacement advances the real workflow revision: an existing per-user
    // preference becomes stale and does not silently fall back to default A.
    const sourceB = await createSharedMcpConnection({ ...owner, organizationId }, { ownership: { type: 'organization', organizationId },
      displayName: 'Actual replacement comparison B', accessMode: 'restricted', allowedToolNames: ['read_fixture'],
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canManage: false, allowedToolNames: ['read_fixture'] }],
      config: { url: 'https://fixture-b.invalid/mcp', transport: 'http', auth: 'none', enabled: true } });
    const selectionB = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'shared' as const,
      connectionRef: sourceB.resource.connectionRef, bindingRevision: sourceB.resource.bindingRevision } };
    const exactProviderRefB = presentSharedIntegrationProvider(sourceB.resource).providerRef;
    const selectable: FixedAgentExtensions = { ...empty, standalone: [{ mode: 'selectable', configurationId: 'actual-preview-choice',
      source: 'mcp', requirement: 'required', defaultChoiceId: 'a', allowedChoices: [
        { choiceId: 'a', selection: sharedSelection, toolCap: ['read_fixture'] },
        { choiceId: 'b', selection: selectionB, toolCap: ['read_fixture'] },
      ] }] };
    const choiceAgent = await management.createManagedAgent(ownerActor, { name: 'Actual choice-aware preview Agent', extensions: selectable });
    const { setManagedAgentStandaloneChoice } = await import('../app/lib/agents/extension-choice');
    const choiceSnapshot = await workflows.readManagedAgentWorkflow(ownerActor, choiceAgent.agent.agentId);
    const slot = choiceSnapshot.bindings.find(binding => binding.standaloneConfiguration?.mode === 'selectable'); assert(slot);
    await setManagedAgentStandaloneChoice({ actor: ownerActor, agentId: choiceAgent.agent.agentId, capabilityKey: slot.resourceId,
      expectedWorkflowRevision: choiceSnapshot.workflowRevision, expectedPreferenceRevision: choiceSnapshot.preferenceRevision, choiceId: 'b' });
    const choiceTarget = { kind: 'existing' as const, agentId: choiceAgent.agent.agentId, expectedRevision: choiceAgent.agent.revision,
      expectedWorkflowRevision: choiceSnapshot.workflowRevision };
    const choiceContext = await resolveAgentExtensionOptionsContext(ownerActor, choiceTarget);
    const storedBeforePreviews = await sql.get('SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2',
      [choiceAgent.agent.agentId, owner.userId]);
    const keepB = await previewAgentExtensionConfiguration(choiceContext, { operation: 'preview', target: choiceTarget });
    assert.equal(keepB.preview.configurationReadiness, 'valid', JSON.stringify(keepB.preview.issues));
    assert.equal(keepB.preview.contextValidation, 'complete');
    assert.equal(keepB.preview.personalSetupRequired, false);
    assert(keepB.preview.contextPreview?.includes(exactProviderRefB));
    assert(!keepB.preview.contextPreview?.includes(exactProviderRef));
    const replacedChoice = await previewAgentExtensionConfiguration(choiceContext, { operation: 'preview', target: choiceTarget,
      configuration: selectable });
    assert.equal(replacedChoice.preview.configurationReadiness, 'valid', JSON.stringify(replacedChoice.preview.issues));
    assert.equal(replacedChoice.preview.contextValidation, 'complete');
    assert.equal(replacedChoice.preview.personalSetupRequired, true);
    assert(!replacedChoice.preview.contextPreview?.includes(exactProviderRef));
    assert(!replacedChoice.preview.contextPreview?.includes(exactProviderRefB));
    assert.deepEqual(await sql.get('SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2',
      [choiceAgent.agent.agentId, owner.userId]), storedBeforePreviews, 'Both read-only previews retain the real stored B preference unchanged.');
    const replaced = await workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: choiceAgent.agent.agentId,
      expectedRevision: choiceTarget.expectedRevision, expectedWorkflowRevision: choiceTarget.expectedWorkflowRevision, extensions: selectable });
    const replacedSnapshot = await workflows.readManagedAgentWorkflow(ownerActor, replaced.agent.agentId);
    const replacedSlot = replacedSnapshot.bindings.find(binding => binding.standaloneConfiguration)?.standaloneConfiguration;
    assert(replacedSlot);
    const { selectAgentStandaloneExtension } = await import('../app/lib/capabilities/extensions/standalone-runtime');
    const actualReplacement = selectAgentStandaloneExtension(replacedSlot, replacedSnapshot, owner.userId);
    assert.equal(actualReplacement.origin, 'stale'); assert.equal(actualReplacement.choice, null);
    const replacedTarget = { kind: 'existing' as const, agentId: replaced.agent.agentId, expectedRevision: replaced.agent.revision,
      expectedWorkflowRevision: replacedSnapshot.workflowRevision };
    const actualReplacedContext = await resolveAgentExtensionOptionsContext(ownerActor, replacedTarget);
    const actualReplaced = await previewAgentExtensionConfiguration(actualReplacedContext, { operation: 'preview', target: replacedTarget });
    assert.equal(actualReplaced.preview.personalSetupRequired, true);
    assert.deepEqual(replacedChoice.preview.budget, actualReplaced.preview.budget);

    // A package slot has the same no-fallback rule as a standalone slot.
    const packageSelectable = structuredClone(promotedTemplate);
    assert(packageSelectable.workflow);
    const packageCapability = packageSelectable.workflow.packages[0].declarations[0].capabilities[0];
    assert(packageCapability.selection.mode === 'selectable');
    const choiceA = packageCapability.selection.allowedChoices[0];
    packageCapability.selection.defaultChoiceId = 'a';
    packageCapability.selection.allowedChoices = [{ ...choiceA, choiceId: 'a' }, { ...choiceA, choiceId: 'b',
      target: { kind: 'shared', source: 'mcp', connectionRef: sourceB.resource.connectionRef,
        bindingRevision: sourceB.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' } } }];
    const packageAgent = await management.createManagedAgent(ownerActor, { name: 'Actual package preference preview', extensions: packageSelectable });
    const packageSnapshot = await workflows.readManagedAgentWorkflow(ownerActor, packageAgent.agent.agentId);
    const { agentWorkflowCapabilityKey } = await import('../app/lib/agents/workflow-contracts');
    await workflows.setManagedAgentWorkflowChoice({ actor: ownerActor, agentId: packageAgent.agent.agentId,
      capabilityKey: agentWorkflowCapabilityKey(promotedPin.resourceRef, '.canvas-plugin/plugin.json', 'promoted-reader'),
      expectedWorkflowRevision: packageSnapshot.workflowRevision, expectedPreferenceRevision: packageSnapshot.preferenceRevision, choiceId: 'b' });
    const packageTarget = { kind: 'existing' as const, agentId: packageAgent.agent.agentId, expectedRevision: packageAgent.agent.revision,
      expectedWorkflowRevision: packageSnapshot.workflowRevision };
    const packageContext = await resolveAgentExtensionOptionsContext(ownerActor, packageTarget);
    const keptPackage = await previewAgentExtensionConfiguration(packageContext, { operation: 'preview', target: packageTarget });
    assert.equal(keptPackage.preview.personalSetupRequired, false);
    assert(keptPackage.preview.contextPreview?.includes(exactProviderRefB));
    const replacedPackage = await previewAgentExtensionConfiguration(packageContext, { operation: 'preview', target: packageTarget,
      configuration: packageSelectable });
    assert.equal(replacedPackage.preview.configurationReadiness, 'valid', JSON.stringify(replacedPackage.preview.issues));
    assert.equal(replacedPackage.preview.personalSetupRequired, true);
    assert(!replacedPackage.preview.contextPreview?.includes(exactProviderRef));
    assert(!replacedPackage.preview.contextPreview?.includes(exactProviderRefB));
    const savedPackageReplacement = await workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: packageAgent.agent.agentId,
      expectedRevision: packageTarget.expectedRevision, expectedWorkflowRevision: packageTarget.expectedWorkflowRevision, extensions: packageSelectable });
    const actualPackageReplacement = await workflows.readManagedAgentWorkflow(ownerActor, savedPackageReplacement.agent.agentId);
    const storedPackage = actualPackageReplacement.bindings.find(binding => binding.configuration)?.configuration;
    assert(storedPackage);
    const storedDeclaration = storedPackage.declarations[0], storedCapability = storedDeclaration.capabilities[0];
    assert.equal(workflows.getSelectedAgentWorkflowCapability(actualPackageReplacement, storedPackage, storedDeclaration, storedCapability), null);
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} public configuration preview: authenticated route and real Pi model/tool inheritance, source Use/Manage separation, exact public provider recipes with private path/query redaction after full internal budget, actual required/Core index, required missing-choice and user-promoted templates saved, prospective/saved budget parity, keep B versus replacement-stale without fallback for both standalone and package slots through actual public writes, child/root immutable parent requirements, native read/required-discovery conflicts versus optional warnings, actual 48-child measured overflow, retained-source boundaries, personal metadata remains unknown, zero provider requests or fake Agent/runtime authority.`);
  } finally { await fixture.close(); await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
