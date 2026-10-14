import 'server-only';

import { createHash } from 'node:crypto';
import { createCapabilityResourceId } from '@/app/lib/capabilities/reference';
import { listCapabilityResources, inspectCapabilityResource } from '@/app/lib/capabilities/resources/actions';
import { projectPackageExtensionSelection, intersectPackageExtensionToolCaps } from '@/app/lib/capabilities/packages/extension-projection';
import type { AuthorizedAgentWorkflowPackageMetadata } from '@/app/lib/capabilities/packages/runtime-bindings';
import { renderEffectiveExtensionContext, ExtensionContextBudgetError, EXTENSION_CONTEXT_MAX_BYTES,
  type ExtensionContextPresentation } from '@/app/lib/capabilities/extensions/context-prompt';
import { projectAgentStandaloneConfigurations } from '@/app/lib/capabilities/extensions/agent-standalone-configuration';
import { createStandaloneExtensionSlotRef } from '@/app/lib/capabilities/extensions/standalone-reference';
import { EXTENSION_SELECTION_LIMITS, extensionSelectionIdentity, type AgentStandaloneEntryInput,
  type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import { createIntegrationPolicyFromLegacyTools } from '@/app/lib/integration-tools/policy';
import { verifyStoredPersonalWorkflowProviderTarget } from '@/app/lib/integration-tools/workflow-personal-bindings';
import { readPersonalComposioAccountReference } from '@/app/lib/composio/composio-shared-account-reference';
import { listExistingComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { hashMcpLegacyConfig } from '@/app/lib/mcp/connection-identity';
import { getPiToolMetadata } from '@/app/lib/pi/tool-registry';
import { getDefaultEnabledToolNames, isLegacyEnabledToolsValue, resolveEnabledToolNames } from '@/app/lib/pi/enabled-tools';
import type { EffectiveToolManifest } from '@/app/lib/pi/effective-tool-manifest';
import type { WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';
import { readAgentExtensionPackageVersion } from './extension-package-options';
import { readAgentOwnMcpOptionMetadata, readAgentOwnMcpOptionsInventory, readAgentSharedMcpOptionMetadata,
  readAgentComposioOptionsCatalogue } from './extension-options-inventory';
import { authorizeAgentExtensionSharedOption, revalidateAgentExtensionOptionsContext, type AgentExtensionOptionsContext } from './extension-options-context';
import { agentExtensionOptionsRequestSchema, type AgentExtensionOptionsRequest,
  type AgentExtensionOptionsResponse, type AgentExtensionConfigurationPreview } from './extension-options-contracts';
import { AgentWorkflowError, type AgentWorkflowTarget, type StoredAgentWorkflowPackage, type StoredAgentWorkflowTarget } from './workflow-contracts';
import { resolveRetainedAgentWorkflowTarget, type AgentWorkflowBindingSlot } from './workflow-binding-retention';
import { validateSpecialAgentTools } from './management-actions';

type PreviewRequest = Extract<AgentExtensionOptionsRequest, { operation: 'preview' }>;
type PreviewResponse = Extract<AgentExtensionOptionsResponse, { operation: 'preview' }>;
type Issue = AgentExtensionConfigurationPreview['issues'][number];
const emptyManifest: EffectiveToolManifest = { tools: [], gateways: [], registeredToolNames: [], groups: [], revision: 'configuration-preview-no-runtime-registration' };
const key = (value: { resourceRef: string; publishedRevisionRef: string; checksum: string }) =>
  JSON.stringify([value.resourceRef, value.publishedRevisionRef, value.checksum]);
const alternativeKey = (alternative: WorkflowIntegrationAlternative) => `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`;
function fail(code: string, message = 'The exact selected source is unavailable.'): never { throw new AgentWorkflowError(code, message, 409); }

/** Metadata-only preflight. No Agent/session, runtime issuer or provider probe is created. */
export async function previewAgentExtensionConfiguration(context: AgentExtensionOptionsContext, value: PreviewRequest): Promise<PreviewResponse> {
  const parsed = agentExtensionOptionsRequestSchema.safeParse(structuredClone(value));
  if (!parsed.success || parsed.data.operation !== 'preview' || context.target.kind === 'user_choice'
    || JSON.stringify(context.target) !== JSON.stringify(parsed.data.target)) fail('AGENT_EXTENSION_PREVIEW_INVALID');
  const request = parsed.data;
  await revalidateAgentExtensionOptionsContext(context);
  const resourceActor = { userId: context.actor.userId, workspaceId: context.actor.workspaceId };
  const issues: Issue[] = [], requirements: AgentExtensionConfigurationPreview['requirements'] = [],
    effectiveToolCaps: AgentExtensionConfigurationPreview['effectiveToolCaps'] = [], toolConflicts: AgentExtensionConfigurationPreview['toolConflicts'] = [];
  const issue = (code: string, message: string, severity: Issue['severity'] = 'error', path?: string) => {
    issues.push({ code, message, severity, ...(path ? { path } : {}) });
  };
  const configuration = request.configuration;
  const packages: AuthorizedAgentWorkflowPackageMetadata[] = [];
  const standaloneSelections: NonNullable<ExtensionContextPresentation['workflowProjection']>['standaloneSelections'][number][] = [];
  const configuredTools = request.enabledTools === undefined ? context.snapshot?.agent.enabledTools ?? null : request.enabledTools;
  const catalog = await getPiToolMetadata();
  const known = catalog.map(tool => tool.name);
  const enabled = configuredTools?.includes('__none__') ? new Set<string>()
    : !configuredTools?.length || isLegacyEnabledToolsValue(configuredTools) ? getDefaultEnabledToolNames(known)
      : resolveEnabledToolNames(known, configuredTools);
  try { await validateSpecialAgentTools(configuredTools); }
  catch { issue('AGENT_TOOL_CONFIGURATION_INVALID', 'The selected native tools contain an unknown or protected operation.'); }
  const integrationPolicy = createIntegrationPolicyFromLegacyTools({ legacyToolNames: enabled });
  const retainedStandalone = context.snapshot && configuration.mode === 'fixed' && configuration.standalone.some(slot =>
    (slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices).some(entry => entry.retainedBindingRef))
    ? await projectAgentStandaloneConfigurations(context.actor, context.snapshot) : [];

  const checkSelection = async (entry: AgentStandaloneEntryInput, path: string,
    retention?: { configurationId?: string; choiceId?: string }, mapping?: { alternative: WorkflowIntegrationAlternative; target?: StoredAgentWorkflowTarget;
      confirmation?: boolean }): Promise<string[] | null> => {
    const selection = entry.selection;
    if (selection.kind === 'composio' && !isComposioIntegrationApplicationVisible(selection.toolkit)) fail('AGENT_WORKFLOW_BINDING_DENIED');
    if (!integrationPolicy.allowedSources?.includes(selection.source)) {
      toolConflicts.push({ code: 'AGENT_EXTENSION_GATEWAY_DISABLED', message: `The configured native tools do not permit ${selection.source} discovery/execution.`, toolNames: [selection.source] });
    } else if (![`${selection.source}.search_tools`, `${selection.source}.describe`].every(operation => integrationPolicy.allowedOperations?.includes(operation))) {
      toolConflicts.push({ code: 'AGENT_EXTENSION_DISCOVERY_DISABLED', message: `The configured native tools do not permit exact ${selection.source} tool discovery and schema description.`, toolNames: [selection.source] });
    }
    if (entry.retainedBindingRef) {
      const slot = retainedStandalone.find(slot => slot.configurationId === retention?.configurationId);
      const previous = slot?.mode === 'fixed' ? retention?.choiceId === undefined ? slot.entry : undefined
        : slot?.allowedChoices.find(choice => choice.choiceId === retention?.choiceId);
      if (!previous || previous.retainedBindingRef !== entry.retainedBindingRef
        || JSON.stringify(previous.selection) !== JSON.stringify(selection)) fail('AGENT_EXTENSION_RETENTION_INVALID');
    }
    if (selection.target.kind === 'shared') {
      const current = await authorizeAgentExtensionSharedOption(context, selection.target.connectionRef);
      let allowedToolNames = current.allowedToolNames;
      if (!current.canUse || current.resource.status !== 'active' || current.resource.source !== selection.source
        || current.resource.bindingRevision !== selection.target.bindingRevision
        || selection.kind === 'composio' && (current.backend.source !== 'composio' || current.backend.toolkit !== selection.toolkit
          || current.backend.accountBinding === 'pending')) fail('AGENT_WORKFLOW_BINDING_CHANGED');
      if (mapping?.alternative.source === 'mcp') {
        if (!current.canManage) fail('AGENT_WORKFLOW_MAPPING_REQUIRED', 'The declared MCP mapping requires current connection management permission.');
        const backend = await readAgentSharedMcpOptionMetadata(context, selection.target.connectionRef);
        if (!backend?.authorization.canManage || backend.authorization.resource.bindingRevision !== selection.target.bindingRevision) fail('AGENT_WORKFLOW_BINDING_CHANGED');
        allowedToolNames = backend.authorization.allowedToolNames;
        const { listMcpServerDefinitions, matchesMcpServerDefinition } = await import('@/app/lib/mcp/server-definitions');
        const definition = backend.connection.serverDefinitionId ? (await listMcpServerDefinitions(backend.authorization.resource.ownership.organizationId))
          .find(definition => definition.id === backend.connection.serverDefinitionId) : undefined;
        if (backend.connection.serverDefinitionId && (!definition?.enabled || !matchesMcpServerDefinition(backend.connection, definition))) fail('AGENT_WORKFLOW_BINDING_CHANGED');
        if (mapping.target?.verifiedMcpMapping) {
          if (mapping.target.verifiedMcpMapping.connector !== mapping.alternative.connector
            || mapping.target.verifiedMcpMapping.configFingerprint !== hashMcpLegacyConfig(backend.connection)
            || mapping.target.verifiedMcpMapping.definitionId !== (definition?.id ?? null)
            || mapping.target.verifiedMcpMapping.definitionRevision !== (definition?.revision ?? null)) fail('AGENT_WORKFLOW_BINDING_CHANGED');
        } else if (!mapping.confirmation && !backend.connection.serverDefinitionId) fail('AGENT_WORKFLOW_MAPPING_REQUIRED');
      }
      return intersectPackageExtensionToolCaps(entry.toolCap, allowedToolNames);
    }
    if (!context.allowPersonal) fail('AGENT_WORKFLOW_BINDING_DENIED', 'A shared Agent cannot embed a personal connection.');
    if (selection.kind === 'mcp') {
      if (!await readAgentOwnMcpOptionMetadata(context, selection.target.connectionRef)) fail('AGENT_WORKFLOW_BINDING_DENIED');
    } else {
      if (!isComposioIntegrationApplicationVisible(selection.toolkit)) fail('AGENT_WORKFLOW_BINDING_DENIED');
      const personalTarget = selection.target;
      const profile = (await listExistingComposioProfiles(context.actor.userId)).find(profile => profile.id === personalTarget.profileId && profile.status === 'active');
      if (!profile) fail('AGENT_WORKFLOW_BINDING_DENIED');
      if (selection.target.accountBinding === 'no_auth' && !entry.retainedBindingRef && !mapping?.target?.personalBinding) {
        // Initial no-auth intent is accepted only from actual toolkit metadata.
        // Metadata lookup neither enumerates accounts nor proves runtime health.
        const catalog = await readAgentComposioOptionsCatalogue(context, AbortSignal.timeout(10_000),
          { search: selection.toolkit, selectedSlug: selection.toolkit, profileId: selection.target.profileId });
        if (!catalog.items.some(item => item.kind === 'integration' && item.toolkit.slug === selection.toolkit && item.toolkit.noAuth)) {
          fail('AGENT_EXTENSION_ACCOUNT_REQUIRED');
        }
        const fresh = (await listExistingComposioProfiles(context.actor.userId)).find(value => value.id === profile.id);
        if (JSON.stringify(fresh) !== JSON.stringify(profile)) fail('AGENT_EXTENSION_ACCOUNT_CHANGED');
      }
      if (selection.target.accountBinding === 'account' && !entry.retainedBindingRef && !mapping?.target?.personalBinding) {
        if (!entry.accountSelectionRef) fail('AGENT_EXTENSION_ACCOUNT_REQUIRED');
        const receipt = readPersonalComposioAccountReference(entry.accountSelectionRef);
        const expected = createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit: selection.toolkit,
          scope: { type: 'user', ownerUserId: context.actor.userId, resourceId: `profile:${profile.id}:${selection.toolkit}` } });
        if (receipt.actorUserId !== context.actor.userId || receipt.workspaceId !== (context.actor.workspaceId ?? null)
          || receipt.organizationId !== context.organizationId || receipt.profileId !== profile.id || receipt.providerRef !== expected
          || receipt.toolkit !== selection.toolkit || receipt.accountId !== selection.target.accountId) fail('AGENT_EXTENSION_ACCOUNT_CHANGED');
      }
      issue('AGENT_EXTENSION_PERSONAL_RUNTIME_UNKNOWN', 'Personal account credentials, provider authentication and live tool schemas require fresh validation when saved and used.', 'warning', path);
    }
    return entry.toolCap;
  };

  const resolveTarget = async (target: AgentWorkflowTarget, alternative: WorkflowIntegrationAlternative,
    slot: AgentWorkflowBindingSlot): Promise<{ selection: StandaloneExtensionSelection; stored?: StoredAgentWorkflowTarget; receipt?: string; confirmation?: boolean }> => {
    const stored = target.kind === 'retained' ? context.snapshot
      ? resolveRetainedAgentWorkflowTarget(context.actor, context.snapshot, slot, target.retainedBindingRef)
      : fail('AGENT_WORKFLOW_RETENTION_INVALID') : undefined;
    const current = stored ?? target;
    if (current.kind === 'retained') fail('AGENT_WORKFLOW_RETENTION_INVALID');
    if (current.source !== alternative.source) fail('AGENT_WORKFLOW_BINDING_INVALID');
    if (current.kind === 'shared') return { selection: alternative.source === 'mcp'
      ? { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: current.connectionRef, bindingRevision: current.bindingRevision } }
      : { kind: 'composio', source: 'composio', toolkit: alternative.toolkit, target: { kind: 'shared', connectionRef: current.connectionRef, bindingRevision: current.bindingRevision } },
    stored, confirmation: Boolean(current.mcpMapping) };
    if (current.ownerUserId !== context.actor.userId || !context.allowPersonal || current.source !== alternative.source) fail('AGENT_WORKFLOW_BINDING_DENIED');
    if (stored?.kind === 'personal' && stored.personalBinding) {
      await verifyStoredPersonalWorkflowProviderTarget({ actor: context.actor, target: { binding: stored.personalBinding,
        baseProviderRef: stored.providerRef, boundProviderRef: stored.boundProviderRef!, bindingFingerprint: stored.bindingFingerprint! } }, { checkProviderReadiness: false });
      const binding = stored.personalBinding;
      return { selection: binding.source === 'mcp' ? { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${binding.connectionId}` } }
        : { kind: 'composio', source: 'composio', toolkit: binding.toolkit, target: binding.accountBinding === 'no_auth'
          ? { kind: 'personal', profileId: binding.profileId, accountBinding: 'no_auth' }
          : { kind: 'personal', profileId: binding.profileId, accountBinding: 'account', accountId: binding.connectedAccountId!,
            connectionRef: `composio-personal:${binding.profileId}:${binding.connectedAccountId}` } }, stored };
    }
    if (alternative.source === 'mcp') {
      const matches = (await readAgentOwnMcpOptionsInventory(context)).items.filter(item => item.kind === 'mcp' && item.mcp.serverId
        && item.ownership?.type === 'user' && item.ownership.ownerUserId === context.actor.userId && item.access.canUse
        && createIntegrationProviderRef({ source: 'mcp', connectionId: item.mcp.serverId,
          scope: { type: 'user', ownerUserId: context.actor.userId, resourceId: item.mcp.serverId } }) === current.providerRef);
      if (matches.length !== 1) fail('AGENT_WORKFLOW_BINDING_DENIED');
      return { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: matches[0].id } } };
    }
    if (!current.accountSelectionRef) {
      // A legacy public personal target has no account/no-auth discriminator.
      // Only actual toolkit metadata may establish no-auth; never enumerate accounts here.
      const profile = (await listExistingComposioProfiles(context.actor.userId)).find(profile => profile.status === 'active'
        && profile.ownerUserId === context.actor.userId && createIntegrationProviderRef({ source: 'composio', profileId: profile.id,
          toolkit: alternative.toolkit, scope: { type: 'user', ownerUserId: context.actor.userId,
            resourceId: `profile:${profile.id}:${alternative.toolkit}` } }) === current.providerRef);
      if (!profile) fail('AGENT_WORKFLOW_BINDING_DENIED');
      // checkSelection validates this no-auth intent through toolkit-only metadata.
      return { selection: { kind: 'composio', source: 'composio', toolkit: alternative.toolkit,
        target: { kind: 'personal', profileId: profile.id, accountBinding: 'no_auth' } } };
    }
    const receipt = readPersonalComposioAccountReference(current.accountSelectionRef);
    if (receipt.providerRef !== current.providerRef) fail('AGENT_EXTENSION_ACCOUNT_CHANGED');
    return { selection: { kind: 'composio', source: 'composio', toolkit: alternative.toolkit,
      target: { kind: 'personal', profileId: receipt.profileId, accountBinding: 'account', accountId: receipt.accountId,
        connectionRef: `composio-personal:${receipt.profileId}:${receipt.accountId}` } }, receipt: current.accountSelectionRef };
  };

  if (configuration.mode === 'legacy_inherit') issue('AGENT_EXTENSION_INHERITED_CONTEXT_UNKNOWN', 'Inherited context is resolved from current runtime policy when the Agent starts.', 'warning');
  else {
    const catalogResources = await listCapabilityResources(resourceActor);
    for (const pkg of configuration.workflow?.packages ?? []) {
      try {
        const actual = await readAgentExtensionPackageVersion(resourceActor, { resourceRef: pkg.resourceRef,
          publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum }, { allowPersonalPackages: context.allowPersonal });
        const resource = await inspectCapabilityResource(resourceActor, pkg.resourceRef);
        const entries = configuration.selections.filter(entry => (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill')
          && key(entry.selection.package) === key(pkg));
        const inventory = actual.metadata.skillRoots.map(({ name, relativeRoot }) => ({ name, relativeRoot }));
        const source: StoredAgentWorkflowPackage = { ...pkg, version: 1, declarations: [], selectedSkills: pkg.skillSelection.kind === 'plugin' ? inventory
          : pkg.skillSelection.relativeRoots.map(root => { const found = inventory.find(skill => skill.relativeRoot === root); if (!found) fail('AGENT_EXTENSION_SELECTION_INVALID'); return found; }) };
        const requiredRoots = pkg.skillSelection.kind === 'plugin' ? inventory.filter(skill => catalogResources.some(candidate =>
          candidate.artifact.sourcePluginId === resource.artifact.resourceId && candidate.artifact.name === skill.name
          && candidate.activation?.effectivePolicy === 'required')).map(skill => skill.relativeRoot) : [];
        const projection = projectPackageExtensionSelection({ source, kind: actual.metadata.kind, inventory, selections: entries, requiredRoots });
        const roots = new Set(projection.selectedRoots), paths = new Set([...roots].map(root => root ? `${root}/agents/canvas.yaml` : 'agents/canvas.yaml'));
        if (actual.metadata.kind === 'plugin') paths.add('.canvas-plugin/plugin.json');
        const declarations = actual.metadata.declarations.filter(declaration => paths.has(declaration.declarationPath));
        if (pkg.declarations.some(declaration => !declarations.some(actual => actual.declarationPath === declaration.declarationPath))) fail('AGENT_WORKFLOW_DECLARATION_INVALID');
        const parentCap = entries.find(entry => entry.selection.kind === 'plugin')?.toolCap ?? null;
        entries.forEach(entry => effectiveToolCaps.push({ selection: entry.selection,
          toolCap: intersectPackageExtensionToolCaps(parentCap, entry.toolCap) }));
        for (const declaration of declarations) {
          const supplied = pkg.declarations.find(value => value.declarationPath === declaration.declarationPath);
          if (supplied?.capabilities.some(selected => !declaration.workflow.integrationCapabilities.some(actual => actual.id === selected.capabilityId))) fail('AGENT_WORKFLOW_DECLARATION_INVALID');
          for (const capability of declaration.workflow.integrationCapabilities) {
            const selected = supplied?.capabilities.find(selected => selected.capabilityId === capability.id);
            const state: AgentExtensionConfigurationPreview['requirements'][number] = { package: { resourceRef: pkg.resourceRef,
              publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum }, declarationPath: declaration.declarationPath,
            capabilityId: capability.id, required: capability.required, state: 'unbound' };
            requirements.push(state);
            if (!selected) {
              if (capability.required) issue('AGENT_WORKFLOW_REQUIRED_BINDING', 'A required declared connection has no explicit binding.', 'error', declaration.declarationPath);
              continue;
            }
            if (selected.required === false && capability.required) fail('AGENT_WORKFLOW_REQUIRED_BINDING');
            if (selected.selection.mode === 'selectable' && selected.selection.personalPolicy) {
              const policy = selected.selection.personalPolicy;
              if (policy.alternativeKeys.some(key => !capability.alternatives.some(alternative => alternativeKey(alternative) === key
                && policy.sources.includes(alternative.source)))) fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID');
              if (policy.mcpDefinitionMappings?.length) {
                const definitions = context.organizationId ? await (await import('@/app/lib/mcp/server-definitions')).listMcpServerDefinitions(context.organizationId) : [];
                for (const mapping of policy.mcpDefinitionMappings) if (!capability.alternatives.some(alternative => alternative.source === 'mcp'
                  && alternative.connector === mapping.connector) || mapping.serverDefinitionIds.some(id => !definitions.some(definition => definition.id === id && definition.enabled))) {
                  fail('AGENT_EXTENSION_POLICY_UNAVAILABLE');
                }
              }
            }
            const choices = selected.selection.mode === 'fixed' ? [selected.selection] : selected.selection.allowedChoices;
            for (const choice of choices) {
              try {
                const alternative = capability.alternatives.find(value => alternativeKey(value) === choice.alternativeKey);
                if (!alternative) fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID');
                const target = await resolveTarget(choice.target, alternative, { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef,
                  declarationPath: declaration.declarationPath, capabilityId: capability.id, alternativeKey: choice.alternativeKey,
                  ...('choiceId' in choice ? { choiceId: choice.choiceId } : {}) });
                const rootCap = entries.find(entry => entry.selection.kind === 'skill'
                  && (entry.selection.relativeRoot ? `${entry.selection.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml') === declaration.declarationPath)?.toolCap ?? null;
                const cap = await checkSelection({ selection: target.selection, requirement: capability.required ? 'required' : 'optional',
                  toolCap: intersectPackageExtensionToolCaps(parentCap, rootCap, choice.toolCap), ...(target.receipt ? { accountSelectionRef: target.receipt } : {}) },
                declaration.declarationPath, undefined, { alternative, target: target.stored, confirmation: target.confirmation });
                if (cap !== null && alternative.requiredTools?.some(name => !cap.includes(name))) fail('AGENT_WORKFLOW_TOOL_POLICY_DENIED');
                effectiveToolCaps.push({ selection: target.selection, toolCap: cap });
                if (selected.selection.mode === 'fixed' || 'choiceId' in choice && selected.selection.defaultChoiceId === choice.choiceId) {
                  state.state = 'bound'; state.alternativeKey = choice.alternativeKey; state.connectionSelection = target.selection;
                }
              } catch { state.state = 'unavailable'; issue('AGENT_WORKFLOW_BINDING_UNAVAILABLE', 'A declared connection or its tool limit cannot be verified.', 'error', declaration.declarationPath); }
            }
            if (state.state === 'unbound' && capability.required) issue('AGENT_EXTENSION_CHOICE_REQUIRED', 'This required connection needs a per-user choice before execution.', 'warning', declaration.declarationPath);
          }
        }
        packages.push({ ...actual.metadata, declarations: declarations.map(declaration => ({ declarationPath: declaration.declarationPath,
          capabilities: declaration.workflow.integrationCapabilities })), skills: actual.source.skills.filter(child => roots.has(child.relativeRoot)).map(({ skill, relativeRoot }) => ({
          resourceId: actual.metadata.kind === 'skill' ? resource.artifact.resourceId : createCapabilityResourceId({ resourceType: 'skill',
            scopeType: resource.artifact.scopeType, name: skill.name, sourceType: 'plugin', sourcePluginName: resource.artifact.name,
            organizationId: resource.metadata.ownership.type === 'system' ? null : resource.metadata.ownership.organizationId,
            ownerUserId: resource.metadata.ownership.type === 'user' ? resource.metadata.ownership.ownerUserId : null }),
          name: skill.name, title: skill.title, description: skill.description, runtimePath: skill.path,
          core: false, required: requiredRoots.includes(relativeRoot) || entries.some(entry => entry.requirement === 'required'
            && (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill' && entry.selection.relativeRoot === relativeRoot)),
          origin: actual.metadata.kind === 'plugin' ? 'plugin' : 'standalone', package: { resourceRef: pkg.resourceRef,
            publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum, kind: actual.metadata.kind, relativeRoot } })) });
      } catch { issue('AGENT_EXTENSION_PACKAGE_UNAVAILABLE', 'The exact package selection, declaration scope or current source Use cannot be verified.'); }
    }
    for (const slot of configuration.standalone) {
      const choices = slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices;
      const configurationId = slot.configurationId ?? `fixed:${createHash('sha256').update(extensionSelectionIdentity(choices[0].selection)).digest('base64url')}`;
      let state: 'selected' | 'missing' | 'unavailable' = slot.mode === 'fixed' || slot.defaultChoiceId ? 'selected' : 'missing';
      for (const choice of choices) {
        try {
          const cap = await checkSelection({ ...choice, requirement: slot.mode === 'fixed' ? slot.entry.requirement : slot.requirement },
            configurationId, { configurationId, ...('choiceId' in choice ? { choiceId: choice.choiceId } : {}) });
          effectiveToolCaps.push({ selection: choice.selection, toolCap: cap });
        } catch { state = 'unavailable'; issue('AGENT_EXTENSION_CONNECTION_UNAVAILABLE', 'An exact standalone connection cannot be verified.', 'error', configurationId); }
      }
      if (slot.mode === 'selectable' && slot.personalPolicy?.source === 'mcp') {
        const definitions = context.organizationId ? await (await import('@/app/lib/mcp/server-definitions')).listMcpServerDefinitions(context.organizationId) : [];
        if (slot.personalPolicy.serverDefinitionIds.some(id => !definitions.some(definition => definition.id === id && definition.enabled))) {
          state = 'unavailable'; issue('AGENT_EXTENSION_POLICY_UNAVAILABLE', 'An approved MCP definition is unavailable.', 'error', configurationId);
        }
      }
      if (slot.mode === 'selectable' && slot.personalPolicy?.source === 'composio'
        && !isComposioIntegrationApplicationVisible(slot.personalPolicy.toolkit)) {
        state = 'unavailable'; issue('AGENT_EXTENSION_POLICY_UNAVAILABLE', 'The declared personal integration is unavailable.', 'error', configurationId);
      }
      if (slot.mode === 'selectable' && slot.personalPolicy) issue('AGENT_EXTENSION_PERSONAL_CHOICE_REQUIRED', 'Per-user connections are selected and validated separately at use time.', 'warning', configurationId);
      const source = slot.mode === 'fixed' ? slot.entry.selection.source : slot.source;
      const toolkit = slot.mode === 'fixed' ? slot.entry.selection.kind === 'composio' ? slot.entry.selection.toolkit : undefined
        : slot.source === 'composio' ? slot.toolkit : undefined;
      standaloneSelections.push({ configurationId, slotRef: createStandaloneExtensionSlotRef({ configurationId, source,
        ...(toolkit ? { toolkit } : {}) }),
      source, required: (slot.mode === 'fixed' ? slot.entry.requirement : slot.requirement) === 'required', origin: slot.mode === 'fixed' ? 'fixed' : 'default', state });
    }
  }
  if (packages.some(pkg => pkg.skills.length) && !enabled.has('read')) toolConflicts.push({ code: 'AGENT_EXTENSION_READ_DISABLED',
    message: 'The selected skills require the configured read capability.', toolNames: ['read'] });
  issues.push(...toolConflicts.map(conflict => ({ code: conflict.code, message: conflict.message, severity: 'error' as const })));
  issue('AGENT_EXTENSION_RUNTIME_REGISTRATION_UNKNOWN', 'This is a configuration preview. Actual runtime routes, exact provider references and their additional context bytes require fresh registration; no runtime tool recipe is supplied here.', 'warning');
  let budget: AgentExtensionConfigurationPreview['budget'] = { usedBytes: 0, maxBytes: EXTENSION_CONTEXT_MAX_BYTES, detailStatus: 'complete', omittedDetails: 0 };
  let contextPreview: string | undefined;
  try {
    const rendered = renderEffectiveExtensionContext({ fingerprint: `configuration:${context.contextKey}`, mode: configuration.mode === 'fixed' ? 'fixed' : 'legacy_specialized',
      packages, skills: [], workflowProjection: { policy: { allowedSources: [], allowedProviderRefs: [], allowedApplications: [], allowedToolNames: [], allowedOperations: [] },
        revision: context.contextKey, selectedProviders: [], standaloneSelections, unavailable: requirements.some(value => value.required && value.state !== 'bound')
          || standaloneSelections.some(value => value.required && value.state !== 'selected') } }, emptyManifest, '');
    budget = rendered.budget; contextPreview = rendered.prompt;
  } catch (error) {
    if (!(error instanceof ExtensionContextBudgetError)) throw error;
    budget = { usedBytes: error.requiredBytes, maxBytes: error.maxBytes, detailStatus: 'compacted', omittedDetails: 0 };
    issue(error.code, error.message);
  }
  await revalidateAgentExtensionOptionsContext(context);
  return { schemaVersion: 1, operation: 'preview', target: request.target, contextKey: context.contextKey, limits: EXTENSION_SELECTION_LIMITS,
    coverage: [{ source: 'packages', status: issues.some(issue => issue.code === 'AGENT_EXTENSION_PACKAGE_UNAVAILABLE') ? 'partial' : 'complete' }],
    preview: { configurationReadiness: issues.some(issue => issue.severity === 'error') ? 'blocked'
      : requirements.some(value => value.required && value.state !== 'bound') || standaloneSelections.some(value => value.required && value.state !== 'selected')
        ? 'incomplete' : issues.some(issue => issue.code === 'AGENT_EXTENSION_PERSONAL_RUNTIME_UNKNOWN' || issue.code === 'AGENT_EXTENSION_INHERITED_CONTEXT_UNKNOWN')
          ? 'unknown' : 'valid', runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSaveValidationRequired: true,
      issues, requirements, effectiveToolCaps, toolConflicts, budget, ...(contextPreview ? { contextPreview } : {}) } };
}
