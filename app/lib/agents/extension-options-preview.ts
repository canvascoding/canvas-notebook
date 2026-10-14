import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';
import { openDb } from '@/app/lib/db';
import { findCapabilityResourceRecord } from '@/app/lib/capabilities/resources/store';
import { getCapabilityPackagePublishedRevision } from '@/app/lib/capabilities/packages/store';
import { intersectPackageExtensionToolCaps } from '@/app/lib/capabilities/packages/extension-projection';
import { ExtensionContextBudgetError, EXTENSION_CONTEXT_MAX_BYTES } from '@/app/lib/capabilities/extensions/context-prompt';
import { projectAgentStandaloneConfigurations } from '@/app/lib/capabilities/extensions/agent-standalone-configuration';
import { createStandaloneExtensionSlotRef } from '@/app/lib/capabilities/extensions/standalone-reference';
import { EXTENSION_SELECTION_LIMITS, extensionSelectionIdentity, type AgentStandaloneEntryInput,
  type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import { isIntegrationProviderOperationAllowed, intersectIntegrationPolicies } from '@/app/lib/integration-tools/policy';
import { validatePersonalWorkflowProviderBinding } from '@/app/lib/integration-tools/workflow-personal-bindings';
import { createPersonalWorkflowProviderMetadataReference, presentPersonalWorkflowProvider } from '@/app/lib/integration-tools/workflow-provider-presentation';
import { presentSharedIntegrationProvider } from '@/app/lib/integration-tools/connections/provider-policy';
import { getComposioMode } from '@/app/lib/composio/composio-client';
import type { IntegrationProviderDescriptor } from '@/app/lib/integration-tools/contracts';
import { readPersonalComposioAccountReference } from '@/app/lib/composio/composio-shared-account-reference';
import { listExistingComposioProfiles, listExistingComposioProfilesOnConnection,
  readOwnedComposioProfileOnConnection } from '@/app/lib/composio/composio-profiles';
import { isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { hashMcpLegacyConfig, validateMcpConnectionId } from '@/app/lib/mcp/connection-identity';
import { parseWorkflowManifest, type WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';
import { readExistingConfig } from '@/app/lib/mcp/read-only-config';
import { resolveOrganizationDataRoot } from '@/app/lib/runtime-data-paths';
import { readAgentExtensionPackageVersion } from './extension-package-options';
import { readAgentOwnMcpOptionMetadata, readAgentOwnMcpOptionsInventory } from './extension-options-inventory';
import { prepareAgentExtensionPreviewProviderMetadata, readAgentExtensionPreviewNoAuthMetadataOnConnection,
  type PreparedAgentExtensionPreviewProviderMetadata } from './extension-options-preview-provider-metadata';
import { revalidateAgentExtensionOptionsContext, type AgentExtensionOptionsContext } from './extension-options-context';
import { agentExtensionOptionsRequestSchema, type AgentExtensionOptionsRequest,
  type AgentExtensionOptionsResponse, type AgentExtensionConfigurationPreview } from './extension-options-contracts';
import { AgentWorkflowError, agentWorkflowCapabilityKey, type AgentWorkflowTarget, type StoredAgentWorkflowPackage, type StoredAgentWorkflowTarget } from './workflow-contracts';
import { resolveRetainedAgentWorkflowTarget, type AgentWorkflowBindingSlot } from './workflow-binding-retention';
import { validateSpecialAgentTools } from './management-actions';
import { getSelectedAgentWorkflowCapability } from './workflow-configuration';
import { selectAgentStandaloneExtension, type AgentStandaloneRuntimeSelection } from '@/app/lib/capabilities/extensions/standalone-runtime';
import type { PreparedAgentExtensionContextPackageSource } from './extension-context-package-metadata';
import { projectAgentExtensionProviderContext, type AgentExtensionProviderContextChoice,
  type AgentExtensionProviderContextProjectionInput } from './extension-provider-context-projection';
import { compileProposedAgentExtensionOptionsPreview, compileKeptAgentExtensionOptionsPreview,
  presentCompiledAgentExtensionOptionsContext, validateAgentExtensionOptionsPreviewRuntimeFields,
  type CompleteAgentExtensionOptionsContext } from './extension-options-preview-compilation';
import type { ProposedAgentExtensionPreviewFrame } from './extension-options-preview-compilation';

type PreviewRequest = Extract<AgentExtensionOptionsRequest, { operation: 'preview' }>;
type PreviewResponse = Extract<AgentExtensionOptionsResponse, { operation: 'preview' }>;
type Issue = AgentExtensionConfigurationPreview['issues'][number];
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
  const sources: PreparedAgentExtensionContextPackageSource[] = [];
  const capabilities: AgentExtensionProviderContextProjectionInput['capabilities'][number][] = [];
  const standalone: AgentExtensionProviderContextProjectionInput['standalone'][number][] = [];
  let personalSetupRequired = false;
  const metadataStamps: unknown[] = [];
  try { await validateSpecialAgentTools(request.enabledTools); }
  catch { issue('AGENT_TOOL_CONFIGURATION_INVALID', 'The selected native tools contain an unknown or protected operation.'); }
  const retainedStandalone = context.snapshot && configuration?.mode === 'fixed' && configuration.standalone.some(slot =>
    (slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices).some(entry => entry.retainedBindingRef))
    ? await projectAgentStandaloneConfigurations(context.actor, context.snapshot) : [];

  const checkSelection = async (frame: ProposedAgentExtensionPreviewFrame, entry: AgentStandaloneEntryInput, issuePath: string,
    retention?: { configurationId?: string; choiceId?: string }, mapping?: { alternative: WorkflowIntegrationAlternative; target?: StoredAgentWorkflowTarget;
      confirmation?: boolean }): Promise<{ descriptor: IntegrationProviderDescriptor; toolCap: string[] | null }> => {
    const selection = entry.selection;
    if (selection.kind === 'composio' && !isComposioIntegrationApplicationVisible(selection.toolkit)) fail('AGENT_WORKFLOW_BINDING_DENIED');
    if (entry.retainedBindingRef) {
      const slot = retainedStandalone.find(slot => slot.configurationId === retention?.configurationId);
      const previous = slot?.mode === 'fixed' ? retention?.choiceId === undefined ? slot.entry : undefined
        : slot?.allowedChoices.find(choice => choice.choiceId === retention?.choiceId);
      if (!previous || previous.retainedBindingRef !== entry.retainedBindingRef
        || JSON.stringify(previous.selection) !== JSON.stringify(selection)) fail('AGENT_EXTENSION_RETENTION_INVALID');
    }
    if (selection.target.kind === 'shared') {
      const current = frame.shared.get(selection.target.connectionRef);
      if (!current) fail('AGENT_WORKFLOW_BINDING_CHANGED');
      metadataStamps.push(current.authorizationRevision);
      const allowedToolNames = current.allowedToolNames;
      if (!current.canUse || current.resource.status !== 'active' || current.resource.source !== selection.source
        || current.resource.bindingRevision !== selection.target.bindingRevision
        || selection.kind === 'composio' && (current.backend.source !== 'composio' || current.backend.toolkit !== selection.toolkit
          || current.backend.accountBinding === 'pending')) fail('AGENT_WORKFLOW_BINDING_CHANGED');
      if (mapping?.alternative.source === 'mcp') {
        if (!current.canManage) fail('AGENT_WORKFLOW_MAPPING_REQUIRED', 'The declared MCP mapping requires current connection management permission.');
        if (current.backend.source !== 'mcp') fail('AGENT_WORKFLOW_BINDING_CHANGED');
        validateMcpConnectionId(current.backend.connectionId);
        const file = path.join(resolveOrganizationDataRoot(current.resource.ownership.organizationId), 'mcp', 'shared', current.backend.connectionId, 'config.json');
        const servers = Object.values((await readExistingConfig(file)).mcpServers), connection = servers[0];
        if (servers.length !== 1 || !connection || connection.connectionId !== current.backend.connectionId || connection.ownerUserId
          || connection.organizationId !== current.resource.ownership.organizationId || connection.enabled === false) fail('AGENT_WORKFLOW_BINDING_CHANGED');
        const { listMcpServerDefinitions, matchesMcpServerDefinition } = await import('@/app/lib/mcp/server-definitions');
        const definition = connection.serverDefinitionId ? (await listMcpServerDefinitions(current.resource.ownership.organizationId))
          .find(definition => definition.id === connection.serverDefinitionId) : undefined;
        if (connection.serverDefinitionId && (!definition?.enabled || !matchesMcpServerDefinition(connection, definition))) fail('AGENT_WORKFLOW_BINDING_CHANGED');
        metadataStamps.push([hashMcpLegacyConfig(connection), definition ?? null]);
        if (mapping.target?.verifiedMcpMapping) {
          if (mapping.target.verifiedMcpMapping.connector !== mapping.alternative.connector
            || mapping.target.verifiedMcpMapping.configFingerprint !== hashMcpLegacyConfig(connection)
            || mapping.target.verifiedMcpMapping.definitionId !== (definition?.id ?? null)
            || mapping.target.verifiedMcpMapping.definitionRevision !== (definition?.revision ?? null)) fail('AGENT_WORKFLOW_BINDING_CHANGED');
        } else if (!mapping.confirmation && !connection.serverDefinitionId) fail('AGENT_WORKFLOW_MAPPING_REQUIRED');
      }
      return { descriptor: presentSharedIntegrationProvider(current.resource),
        toolCap: intersectPackageExtensionToolCaps(entry.toolCap, allowedToolNames) };
    }
    if (!context.allowPersonal) fail('AGENT_WORKFLOW_BINDING_DENIED', 'A shared Agent cannot embed a personal connection.');
    let descriptor: IntegrationProviderDescriptor;
    if (selection.kind === 'mcp') {
      const actual = await readAgentOwnMcpOptionMetadata(context, selection.target.connectionRef, { database: frame.database });
      if (!actual) fail('AGENT_WORKFLOW_BINDING_DENIED');
      metadataStamps.push([actual.serverName, hashMcpLegacyConfig(actual.connection)]);
      const binding = validatePersonalWorkflowProviderBinding({ source: 'mcp', ownerUserId: context.actor.userId,
        connectionId: actual.connection.connectionId, serverDefinitionId: actual.connection.serverDefinitionId ?? null });
      descriptor = presentPersonalWorkflowProvider({ binding, boundProviderRef: createPersonalWorkflowProviderMetadataReference(binding) },
        actual.connection.displayName || actual.serverName);
    } else {
      if (!isComposioIntegrationApplicationVisible(selection.toolkit)) fail('AGENT_WORKFLOW_BINDING_DENIED');
      const personalTarget = selection.target;
      const profile = await readOwnedComposioProfileOnConnection(frame.database, context.actor.userId, personalTarget.profileId);
      if (!profile) fail('AGENT_WORKFLOW_BINDING_DENIED');
      metadataStamps.push(profile);
      if (selection.target.accountBinding === 'no_auth' && !entry.retainedBindingRef && !mapping?.target?.personalBinding) {
        // Initial no-auth intent is accepted only from actual toolkit metadata.
        // Metadata lookup neither enumerates accounts nor proves runtime health.
        if (!preparedProviderMetadata) fail('AGENT_EXTENSION_PREVIEW_INVALID');
        const metadata = await readAgentExtensionPreviewNoAuthMetadataOnConnection(frame.database, context, preparedProviderMetadata,
          selection.target.profileId, selection.toolkit);
        if (!metadata.noAuth) fail('AGENT_EXTENSION_ACCOUNT_REQUIRED');
        metadataStamps.push(metadata.stamp);
        const fresh = await readOwnedComposioProfileOnConnection(frame.database, context.actor.userId, profile.id);
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
      issue('AGENT_EXTENSION_PERSONAL_RUNTIME_UNKNOWN', 'Personal account credentials, provider authentication and live tool schemas require fresh validation when saved and used.', 'warning', issuePath);
      const binding = validatePersonalWorkflowProviderBinding({ source: 'composio', ownerUserId: context.actor.userId,
        profileId: profile.id, toolkit: selection.toolkit,
        mode: await getComposioMode({ secretScope: 'user', userId: context.actor.userId }),
        accountBinding: selection.target.accountBinding,
        connectedAccountId: selection.target.accountBinding === 'account' ? selection.target.accountId : null });
      descriptor = presentPersonalWorkflowProvider({ binding, boundProviderRef: createPersonalWorkflowProviderMetadataReference(binding) },
        `${selection.toolkit} · ${profile.name}`);
    }
    const retained = mapping?.target?.personalBinding ?? (entry.retainedBindingRef ? (() => {
      const slot = frame.existing?.bindings.find(binding => binding.standaloneConfiguration?.configurationId === retention?.configurationId)?.standaloneConfiguration;
      const choice = slot?.mode === 'fixed' ? slot.entry : slot?.allowedChoices.find(choice => choice.choiceId === retention?.choiceId);
      return choice?.target.kind === 'personal' ? choice.target.personalBinding : undefined;
    })() : undefined);
    if (retained && createPersonalWorkflowProviderMetadataReference(validatePersonalWorkflowProviderBinding(retained)) !== descriptor.providerRef) {
      fail('AGENT_WORKFLOW_BINDING_CHANGED');
    }
    return { descriptor, toolCap: entry.toolCap };
  };

  const resolveTarget = async (frame: ProposedAgentExtensionPreviewFrame, target: AgentWorkflowTarget, alternative: WorkflowIntegrationAlternative,
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
      const binding = stored.personalBinding;
      return { selection: binding.source === 'mcp' ? { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${binding.connectionId}` } }
        : { kind: 'composio', source: 'composio', toolkit: binding.toolkit, target: binding.accountBinding === 'no_auth'
          ? { kind: 'personal', profileId: binding.profileId, accountBinding: 'no_auth' }
          : { kind: 'personal', profileId: binding.profileId, accountBinding: 'account', accountId: binding.connectedAccountId!,
            connectionRef: `composio-personal:${binding.profileId}:${binding.connectedAccountId}` } }, stored };
    }
    if (alternative.source === 'mcp') {
      const matches = (await readAgentOwnMcpOptionsInventory(context, { database: frame.database })).items.filter(item => item.kind === 'mcp' && item.mcp.serverId
        && item.ownership?.type === 'user' && item.ownership.ownerUserId === context.actor.userId && item.access.canUse
        && createIntegrationProviderRef({ source: 'mcp', connectionId: item.mcp.serverId,
          scope: { type: 'user', ownerUserId: context.actor.userId, resourceId: item.mcp.serverId } }) === current.providerRef);
      if (matches.length !== 1) fail('AGENT_WORKFLOW_BINDING_DENIED');
      return { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: matches[0].id } } };
    }
    if (!current.accountSelectionRef) {
      // A legacy public personal target has no account/no-auth discriminator.
      // Only actual toolkit metadata may establish no-auth; never enumerate accounts here.
      const profile = (await listExistingComposioProfilesOnConnection(frame.database, context.actor.userId)).find(profile => profile.status === 'active'
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

  const sharedReferences = new Set<string>();
  if (configuration?.mode === 'legacy_inherit') issue('AGENT_EXTENSION_INHERITED_CONTEXT_UNKNOWN', 'Inherited context is resolved from current runtime policy when the Agent starts.', 'warning');
  if (configuration?.mode === 'fixed') {
    for (const pkg of configuration.workflow?.packages ?? []) {
      try {
        const actual = await readAgentExtensionPackageVersion(resourceActor, { resourceRef: pkg.resourceRef,
          publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum }, { allowPersonalPackages: context.allowPersonal });
        const record = await findCapabilityResourceRecord(pkg.resourceRef);
        if (!record) fail('AGENT_EXTENSION_PACKAGE_UNAVAILABLE');
        const inventory = actual.metadata.skillRoots.map(({ name, relativeRoot }) => ({ name, relativeRoot }));
        const source: StoredAgentWorkflowPackage = { ...pkg, version: 1, declarations: [],
          selectedSkills: pkg.skillSelection.kind === 'plugin' ? inventory : pkg.skillSelection.relativeRoots.map(root => {
            const found = inventory.find(skill => skill.relativeRoot === root);
            if (!found) fail('AGENT_EXTENSION_SELECTION_INVALID');
            return found;
          }) };
        const database = await openDb();
        try {
          const published = await getCapabilityPackagePublishedRevision(pkg.resourceRef, pkg.publishedRevisionRef, database);
          if (!published || published.checksum !== pkg.checksum) fail('AGENT_EXTENSION_PACKAGE_UNAVAILABLE');
          // These are source facts and declaration containers, never invented
          // stored provider targets. The assembler rechecks bytes and Use.
          sources.push({ storage: record.storage, published,
            extensionSelections: configuration.selections.flatMap(({ selection, requirement, toolCap }) =>
              (selection.kind === 'plugin' || selection.kind === 'skill') && key(selection.package) === key(pkg)
                ? [{ selection, requirement, toolCap }] : []),
            stored: { ...source, declarations: actual.metadata.declarations.map(declaration => ({
              declarationPath: declaration.declarationPath, capabilities: [] })) } });
        } finally { await database.close(); }
      } catch { issue('AGENT_EXTENSION_PACKAGE_UNAVAILABLE', 'The exact package selection, declaration scope or current source Use cannot be verified.'); }
      for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
        const choices = capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices;
        for (const choice of choices) {
          try {
            const target = choice.target.kind === 'retained' && context.snapshot ? resolveRetainedAgentWorkflowTarget(context.actor, context.snapshot,
              { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, declarationPath: declaration.declarationPath,
                capabilityId: capability.capabilityId, alternativeKey: choice.alternativeKey, ...('choiceId' in choice ? { choiceId: choice.choiceId } : {}) },
              choice.target.retainedBindingRef) : choice.target;
            if (target.kind === 'shared') sharedReferences.add(target.connectionRef);
          } catch { issue('AGENT_WORKFLOW_RETENTION_INVALID', 'The exact saved connection cannot be retained. Reload its configuration.'); }
        }
      }
    }
    for (const slot of configuration.standalone) for (const choice of slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices) {
      if (choice.selection.target.kind === 'shared') sharedReferences.add(choice.selection.target.connectionRef);
    }
  }
  // Bind only explicit initial no-auth candidates before the compiler opens its
  // transaction. Missing/default workspaces are resolved here, never under the
  // held Agent/Actor/source locks. The opaque preparation is freshly rechecked
  // against the same SQL lease for each subsequent metadata use.
  const noAuthProfiles = new Set<string>();
  if (configuration?.mode === 'fixed') {
    for (const slot of configuration.standalone) for (const entry of slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices) {
      const selection = entry.selection;
      if (selection.kind === 'composio' && selection.target.kind === 'personal' && selection.target.accountBinding === 'no_auth'
        && !entry.retainedBindingRef) noAuthProfiles.add(selection.target.profileId);
    }
    const targets = (configuration.workflow?.packages ?? []).flatMap(pkg => pkg.declarations.flatMap(declaration =>
      declaration.capabilities.flatMap(capability => (capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices)
        .flatMap(choice => choice.target.kind === 'personal' && choice.target.source === 'composio' && !choice.target.accountSelectionRef
          ? [{ target: choice.target, toolkit: choice.alternativeKey.startsWith('composio:') ? choice.alternativeKey.slice('composio:'.length) : null }] : []))));
    if (targets.length) for (const profile of await listExistingComposioProfiles(context.actor.userId)) {
      if (targets.some(({ target, toolkit }) => toolkit && target.ownerUserId === context.actor.userId
        && createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit,
          scope: { type: 'user', ownerUserId: context.actor.userId, resourceId: `profile:${profile.id}:${toolkit}` } }) === target.providerRef)) noAuthProfiles.add(profile.id);
    }
  }
  const preparedProviderMetadata: PreparedAgentExtensionPreviewProviderMetadata = await prepareAgentExtensionPreviewProviderMetadata(context, [...noAuthProfiles]);
  const initialIssues = [...issues];
  const resolveProviders = async (frame: ProposedAgentExtensionPreviewFrame) => {
    if (configuration?.mode !== 'fixed') fail('AGENT_EXTENSION_PREVIEW_INVALID');
    issues.splice(0, issues.length, ...initialIssues); requirements.length = 0; effectiveToolCaps.length = 0;
    capabilities.length = 0; standalone.length = 0; metadataStamps.length = 0; personalSetupRequired = false;
    const staleChoice = (slot: string): boolean => {
      const choice = frame.existing?.choices[slot];
      // A complete replacement increments the actual workflow revision. Existing
      // choices remain stored and suppress default fallback when now stale.
      if (choice && frame.existing && choice.workflowRevision > frame.existing.workflowRevision) fail('AGENT_WORKFLOW_CORRUPT');
      return choice !== undefined;
    };
    for (const actual of frame.packages.packages) {
      const pkg = configuration.workflow?.packages.find(pkg => key(pkg) === key(actual));
      if (!pkg) fail('AGENT_EXTENSION_PACKAGE_UNAVAILABLE');
      try {
        const entries = configuration.selections.filter(entry => (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill')
          && key(entry.selection.package) === key(pkg));
        // Final source-normalized declarations include fresh policy-required
        // children. Never use the earlier catalogue's declaration mask here.
        const declarations = actual.declarations.map(declaration => ({ declarationPath: declaration.declarationPath,
          workflow: parseWorkflowManifest({ version: 1, integrationCapabilities: declaration.capabilities }) }));
        if (pkg.declarations.some(declaration => !declarations.some(actual => actual.declarationPath === declaration.declarationPath))) fail('AGENT_WORKFLOW_DECLARATION_INVALID');
        const parentCap = entries.find(entry => entry.selection.kind === 'plugin')?.toolCap ?? null;
        entries.forEach(entry => effectiveToolCaps.push({ selection: entry.selection,
          toolCap: intersectPackageExtensionToolCaps(parentCap, entry.toolCap) }));
        for (const declaration of declarations) {
          const supplied = pkg.declarations.find(value => value.declarationPath === declaration.declarationPath);
          if (supplied?.capabilities.some(selected => !declaration.workflow.integrationCapabilities.some(actual => actual.id === selected.capabilityId))) fail('AGENT_WORKFLOW_DECLARATION_INVALID');
          for (const capability of declaration.workflow.integrationCapabilities) {
            const selected = supplied?.capabilities.find(selected => selected.capabilityId === capability.id);
            const required = capability.required || selected?.required === true;
            const state: AgentExtensionConfigurationPreview['requirements'][number] = { package: { resourceRef: pkg.resourceRef,
              publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum }, declarationPath: declaration.declarationPath,
              capabilityId: capability.id, required, state: 'unbound' };
            requirements.push(state);
            let providerChoice: AgentExtensionProviderContextChoice | null = null;
            if (!selected) {
              if (required) issue('AGENT_WORKFLOW_REQUIRED_BINDING', 'A required declared connection has no explicit binding.', 'error', declaration.declarationPath);
              capabilities.push({ required, choice: null }); continue;
            }
            if (selected.required === false && capability.required) fail('AGENT_WORKFLOW_REQUIRED_BINDING');
            const isStale = selected.selection.mode === 'selectable' && staleChoice(agentWorkflowCapabilityKey(pkg.resourceRef, declaration.declarationPath, capability.id));
            if (selected.selection.mode === 'selectable' && selected.selection.personalPolicy) {
              const policy = selected.selection.personalPolicy;
              if (policy.alternativeKeys.some(key => !capability.alternatives.some(alternative => alternativeKey(alternative) === key
                && policy.sources.includes(alternative.source)))) fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID');
              if (policy.mcpDefinitionMappings?.length) {
                const definitions = context.organizationId ? await (await import('@/app/lib/mcp/server-definitions')).listMcpServerDefinitions(context.organizationId) : [];
                for (const mapping of policy.mcpDefinitionMappings) if (!capability.alternatives.some(alternative => alternative.source === 'mcp'
                  && alternative.connector === mapping.connector) || mapping.serverDefinitionIds.some(id => !definitions.some(definition => definition.id === id && definition.enabled))) fail('AGENT_EXTENSION_POLICY_UNAVAILABLE');
                metadataStamps.push(definitions);
              }
            }
            const choices = selected.selection.mode === 'fixed' ? [selected.selection] : selected.selection.allowedChoices;
            for (const choice of choices) {
              try {
                const alternative = capability.alternatives.find(value => alternativeKey(value) === choice.alternativeKey);
                if (!alternative) fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID');
                const target = await resolveTarget(frame, choice.target, alternative, { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef,
                  declarationPath: declaration.declarationPath, capabilityId: capability.id, alternativeKey: choice.alternativeKey,
                  ...('choiceId' in choice ? { choiceId: choice.choiceId } : {}) });
                const rootCap = entries.find(entry => entry.selection.kind === 'skill'
                  && (entry.selection.relativeRoot ? `${entry.selection.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml') === declaration.declarationPath)?.toolCap ?? null;
                const checked = await checkSelection(frame, { selection: target.selection, requirement: required ? 'required' : 'optional',
                  toolCap: intersectPackageExtensionToolCaps(parentCap, rootCap, choice.toolCap), ...(target.receipt ? { accountSelectionRef: target.receipt } : {}) },
                  declaration.declarationPath, undefined, { alternative, target: target.stored, confirmation: target.confirmation });
                if (checked.toolCap !== null && alternative.requiredTools?.some(name => !checked.toolCap!.includes(name))) fail('AGENT_WORKFLOW_TOOL_POLICY_DENIED');
                effectiveToolCaps.push({ selection: target.selection, toolCap: checked.toolCap });
                if (selected.selection.mode === 'fixed' || !isStale && 'choiceId' in choice && selected.selection.defaultChoiceId === choice.choiceId) {
                  state.state = 'bound'; state.alternativeKey = choice.alternativeKey; state.connectionSelection = target.selection;
                  providerChoice = { resolve: async () => checked };
                }
              } catch { state.state = 'unavailable'; issue('AGENT_WORKFLOW_BINDING_UNAVAILABLE', 'A declared connection or its tool limit cannot be verified.', 'error', declaration.declarationPath); }
            }
            if (state.state === 'unbound' && required) {
              state.state = 'personal_choice_required'; personalSetupRequired = true;
              issue('AGENT_EXTENSION_CHOICE_REQUIRED', 'This required connection needs a per-user choice before execution.', 'warning', declaration.declarationPath);
            }
            capabilities.push({ required, choice: providerChoice });
          }
        }
      } catch { issue('AGENT_EXTENSION_PACKAGE_UNAVAILABLE', 'The exact package declaration scope or current connection selection cannot be verified.'); }
    }
    for (const slot of configuration.standalone) {
      const choices = slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices;
      const configurationId = slot.configurationId ?? `fixed:${createHash('sha256').update(extensionSelectionIdentity(choices[0].selection)).digest('base64url')}`;
      const source = slot.mode === 'fixed' ? slot.entry.selection.source : slot.source;
      const toolkit = slot.mode === 'fixed' ? slot.entry.selection.kind === 'composio' ? slot.entry.selection.toolkit : undefined
        : slot.source === 'composio' ? slot.toolkit : undefined;
      const slotRef = createStandaloneExtensionSlotRef({ configurationId, source, ...(toolkit ? { toolkit } : {}) });
      const isStale = slot.mode === 'selectable' && staleChoice(slotRef);
      let state: AgentStandaloneRuntimeSelection['state'] = isStale ? 'stale' : slot.mode === 'fixed' || slot.defaultChoiceId ? 'selected' : 'missing';
      let providerChoice: AgentExtensionProviderContextChoice | null = null;
      let selectedConnection: StandaloneExtensionSelection | undefined;
      for (const choice of choices) {
        try {
          const checked = await checkSelection(frame, { ...choice, requirement: slot.mode === 'fixed' ? slot.entry.requirement : slot.requirement },
            configurationId, { configurationId, ...('choiceId' in choice ? { choiceId: choice.choiceId } : {}) });
          effectiveToolCaps.push({ selection: choice.selection, toolCap: checked.toolCap });
          if (slot.mode === 'fixed' || !isStale && 'choiceId' in choice && slot.defaultChoiceId === choice.choiceId) {
            providerChoice = { resolve: async () => checked }; selectedConnection = choice.selection;
          }
        } catch { state = 'unavailable'; issue('AGENT_EXTENSION_CONNECTION_UNAVAILABLE', 'An exact standalone connection cannot be verified.', 'error', configurationId); }
      }
      if (slot.mode === 'selectable' && slot.personalPolicy?.source === 'mcp') {
        const definitions = context.organizationId ? await (await import('@/app/lib/mcp/server-definitions')).listMcpServerDefinitions(context.organizationId) : [];
        if (slot.personalPolicy.serverDefinitionIds.some(id => !definitions.some(definition => definition.id === id && definition.enabled))) {
          state = 'unavailable'; issue('AGENT_EXTENSION_POLICY_UNAVAILABLE', 'An approved MCP definition is unavailable.', 'error', configurationId);
        }
        metadataStamps.push(definitions);
      }
      if (slot.mode === 'selectable' && slot.personalPolicy?.source === 'composio' && !isComposioIntegrationApplicationVisible(slot.personalPolicy.toolkit)) {
        state = 'unavailable'; issue('AGENT_EXTENSION_POLICY_UNAVAILABLE', 'The declared personal integration is unavailable.', 'error', configurationId);
      }
      if (slot.mode === 'selectable' && !providerChoice && slot.requirement === 'required') {
        personalSetupRequired = true;
        issue('AGENT_EXTENSION_PERSONAL_CHOICE_REQUIRED', 'Choose one of this Agent’s allowed connections before external workflow use.', 'warning', configurationId);
      } else if (slot.mode === 'selectable' && slot.personalPolicy) issue('AGENT_EXTENSION_PERSONAL_CHOICE_REQUIRED', 'Per-user connections are selected and validated separately at use time.', 'warning', configurationId);
      standalone.push({ summary: { configurationId, slotRef, source,
        required: (slot.mode === 'fixed' ? slot.entry.requirement : slot.requirement) === 'required',
        origin: slot.mode === 'fixed' ? 'fixed' : isStale ? 'stale' : slot.defaultChoiceId ? 'default' : 'missing', state,
        ...(selectedConnection ? { selection: selectedConnection } : {}) }, choice: providerChoice });
    }
    const projected = await projectAgentExtensionProviderContext({ capabilities, standalone, revisionSeed: [context.contextKey, configuration] });
    return { context: projected, fingerprint: createHash('sha256').update(JSON.stringify(metadataStamps)).digest('hex') };
  };
  let budget: AgentExtensionConfigurationPreview['budget'] = { usedBytes: 0, maxBytes: EXTENSION_CONTEXT_MAX_BYTES, detailStatus: 'complete', omittedDetails: 0 };
  let contextPreview: string | undefined;
  let contextValidation: AgentExtensionConfigurationPreview['contextValidation'] = 'unknown';
  let compiled: CompleteAgentExtensionOptionsContext | null = null;
  try {
    if (configuration?.mode === 'fixed') {
      compiled = await compileProposedAgentExtensionOptionsPreview(context, request, sources, {
        sharedReferences: [...sharedReferences].sort(), resolveProviders });
    } else if (configuration === undefined) {
      compiled = await compileKeptAgentExtensionOptionsPreview(context, request);
      if (compiled && context.snapshot) {
        for (const pkg of compiled.packageContext.configurations) for (const declaration of pkg.declarations) {
          for (const capability of declaration.capabilities) {
            const chosen = getSelectedAgentWorkflowCapability(context.snapshot, pkg, declaration, capability);
            const needsChoice = capability.required && !chosen;
            personalSetupRequired ||= needsChoice;
            requirements.push({ package: { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum },
              declarationPath: declaration.declarationPath, capabilityId: capability.capabilityId, required: capability.required,
              state: chosen ? 'bound' : needsChoice ? 'personal_choice_required' : 'unbound',
              ...(chosen ? { alternativeKey: chosen.alternativeKey } : {}) });
          }
        }
        for (const binding of context.snapshot.bindings) {
          for (const entry of binding.extensionSelections ?? []) effectiveToolCaps.push({ selection: entry.selection, toolCap: entry.toolCap });
          if (!binding.standaloneConfiguration) continue;
          const selected = selectAgentStandaloneExtension(binding.standaloneConfiguration, context.snapshot, context.actor.userId);
          personalSetupRequired ||= selected.required && !selected.choice;
          if (selected.choice) {
            const current = compiled.providerContext.projection.standaloneSelections.find(value => value.slotRef === selected.slotRef);
            const cap = compiled.providerContext.projection.policy.providerToolRules?.find(value => value.providerRef === current?.providerRef)?.allowedToolNames ?? null;
            effectiveToolCaps.push({ selection: selected.choice.selection,
              toolCap: intersectPackageExtensionToolCaps(selected.choice.toolCap, cap) });
          }
        }
      }
      if (!compiled) issue('AGENT_EXTENSION_INHERITED_CONTEXT_UNKNOWN', 'Existing inherited context remains resolved at runtime; this preview does not claim a complete context budget.', 'warning');
    } else await validateAgentExtensionOptionsPreviewRuntimeFields(context, request);
    if (compiled) {
      budget = compiled.rendered.budget;
      contextPreview = presentCompiledAgentExtensionOptionsContext(compiled);
      contextValidation = issues.some(value => value.severity === 'error') ? 'unknown' : 'complete';
      const ceiling = compiled.registration.integrationPolicyCeiling;
      const projected = compiled.providerContext.projection;
      const policy = ceiling ? intersectIntegrationPolicies(ceiling, projected.policy) : null;
      for (const provider of projected.selectedProviders) {
        if (!policy || !isIntegrationProviderOperationAllowed(policy, provider.source, provider.providerRef, 'search_tools')
          || !isIntegrationProviderOperationAllowed(policy, provider.source, provider.providerRef, 'describe')) {
          const conflict = { code: 'AGENT_EXTENSION_DISCOVERY_DISABLED',
            message: 'An optional selected connection has no permitted tool search/schema route.', toolNames: [provider.source] };
          toolConflicts.push(conflict); issue(conflict.code, conflict.message, 'warning');
        }
      }
      if (projected.unavailable) issue('AGENT_EXTENSION_RUNTIME_SETUP_REQUIRED',
        'Required connection setup or current access is incomplete. External workflow actions stay blocked; local skill context remains available.', 'warning');
    }
  } catch (error) {
    if (error instanceof ExtensionContextBudgetError) {
      contextValidation = issues.some(value => value.severity === 'error') ? 'unknown' : 'complete';
      budget = { usedBytes: error.requiredBytes, maxBytes: error.maxBytes, detailStatus: 'compacted', omittedDetails: 0 };
      issue(error.code, error.message);
    } else {
      const code = error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string' ? String(Reflect.get(error, 'code')) : 'AGENT_EXTENSION_PREVIEW_UNAVAILABLE';
      const safe = /^AGENT_|^INCOMPLETE_AGENT_DEFAULT$|^INVALID_CATALOG_REVISION$|^INVALID_RUNTIME_INPUT$|^INVALID_THINKING_LEVEL$/u.test(code);
      const message = safe && error instanceof Error ? error.message : 'The complete configuration context could not be verified. Reload its current sources.';
      issue(safe ? code : 'AGENT_EXTENSION_PREVIEW_UNAVAILABLE', message);
      if (code === 'AGENT_EXTENSION_READ_TOOL_REQUIRED' || code === 'AGENT_EXTENSION_DISCOVERY_TOOLS_REQUIRED') {
        toolConflicts.push({ code, message, toolNames: code === 'AGENT_EXTENSION_READ_TOOL_REQUIRED' ? ['read'] : ['mcp', 'composio'] });
      }
    }
  }
  await revalidateAgentExtensionOptionsContext(context);
  return { schemaVersion: 1, operation: 'preview', target: request.target, contextKey: context.contextKey, limits: EXTENSION_SELECTION_LIMITS,
    coverage: [{ source: 'packages', status: issues.some(issue => issue.code === 'AGENT_EXTENSION_PACKAGE_UNAVAILABLE') ? 'partial' : 'complete' }],
    preview: { configurationReadiness: issues.some(issue => issue.severity === 'error') ? 'blocked'
      : contextValidation === 'unknown' || issues.some(issue => issue.code === 'AGENT_EXTENSION_PERSONAL_RUNTIME_UNKNOWN')
        ? 'unknown' : 'valid', contextValidation, personalSetupRequired,
    runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSaveValidationRequired: true,
      issues, requirements, effectiveToolCaps, toolConflicts, budget, ...(contextPreview ? { contextPreview } : {}) } };
}
