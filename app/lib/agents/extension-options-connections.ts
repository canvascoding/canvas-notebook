import 'server-only';

import { createHash } from 'node:crypto';
import { listExistingComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { readPersonalComposioAccountReference } from '@/app/lib/composio/composio-shared-account-reference';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import { listPersonalWorkflowProviderAccountChoices } from '@/app/lib/integration-tools/workflow-personal-bindings';
import { isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import type { IntegrationConnectionBindingAuthorization } from '@/app/lib/integration-tools/connections/store';
import { listMcpServerDefinitions, matchesMcpServerDefinition } from '@/app/lib/mcp/server-definitions';
import { hashMcpLegacyConfig } from '@/app/lib/mcp/connection-identity';
import { parseStoredStandaloneExtensionBinding, type StoredStandaloneExtensionBinding } from '@/app/lib/capabilities/extensions/stored-contracts';
import { createStandaloneExtensionSlotRef, isStandaloneExtensionSlotRef } from '@/app/lib/capabilities/extensions/standalone-reference';
import { standaloneExtensionSelectionSchema, EXTENSION_SELECTION_LIMITS, type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import { intersectPackageExtensionToolCaps, projectPackageExtensionSelection } from '@/app/lib/capabilities/packages/extension-projection';
import { loadCapabilityCandidates } from '@/app/lib/capabilities/catalog';
import { resolveEffectiveCapabilities } from '@/app/lib/capabilities/effective-resolver';
import { withCapabilityPolicyStore } from '@/app/lib/capabilities/policy-store';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { findCapabilityResourceRecord } from '@/app/lib/capabilities/resources/store';
import type { PluginExtensionCoverage } from '@/app/lib/plugins/plugin-extension-contracts';
import { AgentWorkflowError, agentWorkflowCapabilityKey, type StoredAgentWorkflowTarget } from './workflow-contracts';
import { agentExtensionOptionsRequestSchema, agentExtensionOptionsTargetSchema, type AgentExtensionConnectionChoice, type AgentExtensionConnectionChoicesRequest,
  type AgentExtensionOptionsResponse, type AgentExtensionAccountChoice, type AgentExtensionProfileChoice,
  type AgentExtensionPackageBinding } from './extension-options-contracts';
import { authorizeAgentExtensionSharedOption, listAgentExtensionSharedOptions, revalidateAgentExtensionOptionsContext,
  type AgentExtensionOptionsContext } from './extension-options-context';
import { readAgentExtensionPackageVersion } from './extension-package-options';
import { readAgentMcpOptionsInventory, readAgentOwnMcpOptionsInventory, readAgentOwnMcpOptionMetadata,
  readAgentSharedMcpOptionMetadata } from './extension-options-inventory';

type Response = Extract<AgentExtensionOptionsResponse, { operation: 'connection_choices' }>;
type Alternative = { source: 'mcp'; connector?: string; requiredTools?: readonly string[] }
  | { source: 'composio'; toolkit: string; requiredTools?: readonly string[] };
type Candidate = { choiceId: string; selection: StandaloneExtensionSelection; target: StoredAgentWorkflowTarget;
  toolCap: readonly string[] | null; alternativeKey?: string };
type Scope = { alternatives: Alternative[]; allowed?: Candidate[]; personal: Alternative[];
  definitionMappings?: readonly { connector: string; serverDefinitionIds: readonly string[] }[];
  definitionIds?: readonly string[]; toolCap: readonly string[] | null; required: boolean; package: boolean };

function fail(code: string, message: string, status = 409): never { throw new AgentWorkflowError(code, message, status); }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const label = (value: string, fallback: string): string => value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 160) || fallback;
const alternativeKey = (value: Alternative): string | undefined => value.source === 'composio' ? `composio:${value.toolkit}`
  : value.connector ? `mcp:${value.connector}` : undefined;
const visible = (value: Alternative): boolean => value.source !== 'composio' || isComposioIntegrationApplicationVisible(value.toolkit);
const unavailable = (error: unknown): boolean => isIntegrationConnectionError(error) && [403, 404, 409].includes(error.status);

function publicSelection(target: StoredAgentWorkflowTarget, alternative: Alternative): StandaloneExtensionSelection {
  if (target.kind === 'shared') return standaloneExtensionSelectionSchema.parse({ kind: alternative.source, source: alternative.source,
    ...(alternative.source === 'composio' ? { toolkit: alternative.toolkit } : {}),
    target: { kind: 'shared', connectionRef: target.connectionRef, bindingRevision: target.bindingRevision } });
  const binding = target.personalBinding;
  if (!binding || binding.source !== alternative.source) fail('AGENT_WORKFLOW_CORRUPT', 'The stored choice source is inconsistent.');
  if (binding.source === 'mcp') return standaloneExtensionSelectionSchema.parse({ kind: 'mcp', source: 'mcp',
    target: { kind: 'personal', connectionRef: `mcp-personal:${binding.connectionId}` } });
  return standaloneExtensionSelectionSchema.parse({ kind: 'composio', source: 'composio', toolkit: binding.toolkit,
    target: { kind: 'personal', profileId: binding.profileId, accountBinding: binding.accountBinding,
      ...(binding.accountBinding === 'account' ? { accountId: binding.connectedAccountId,
        connectionRef: `composio-personal:${binding.profileId}:${binding.connectedAccountId}` } : {}) } });
}

/** Called only for the freshly checked exact package alternative and selected source. */
function publicPackageBinding(context: AgentExtensionOptionsContext, scope: Scope, selection: StandaloneExtensionSelection,
  selectedAlternative?: string, accountSelectionRef?: string): AgentExtensionPackageBinding | undefined {
  if (!scope.package || !selectedAlternative) return;
  const alternative = scope.alternatives.find(value => alternativeKey(value) === selectedAlternative);
  if (!alternative || alternative.source !== selection.source
    || selection.kind === 'composio' && (alternative.source !== 'composio' || alternative.toolkit !== selection.toolkit)) {
    fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID', 'The exact selected source does not match this package alternative.');
  }
  if (selection.target.kind === 'shared') return { alternativeKey: selectedAlternative, target: {
    kind: 'shared', source: selection.source, connectionRef: selection.target.connectionRef, bindingRevision: selection.target.bindingRevision } };
  // Stored allowed choices use their choiceId. They do not constitute a new account admission.
  if (selection.kind === 'composio' && selection.target.accountBinding === 'account' && !accountSelectionRef) return;
  const providerRef = selection.kind === 'mcp'
    ? createIntegrationProviderRef({ source: 'mcp', connectionId: selection.target.connectionRef.slice('mcp-personal:'.length),
      scope: { type: 'user', ownerUserId: context.actor.userId, resourceId: selection.target.connectionRef.slice('mcp-personal:'.length) } })
    : createIntegrationProviderRef({ source: 'composio', profileId: selection.target.profileId, toolkit: selection.toolkit,
      scope: { type: 'user', ownerUserId: context.actor.userId, resourceId: `profile:${selection.target.profileId}:${selection.toolkit}` } });
  return { alternativeKey: selectedAlternative, target: { kind: 'personal', source: selection.source,
    ownerUserId: context.actor.userId, providerRef, ...(accountSelectionRef ? { accountSelectionRef } : {}) } };
}

async function selectionScope(context: AgentExtensionOptionsContext, request: AgentExtensionConnectionChoicesRequest): Promise<Scope> {
  const selector = request.selector;
  if (context.target.kind !== 'user_choice') {
    if (selector.kind === 'slot') fail('AGENT_WORKFLOW_CHOICE_INVALID', 'A central configuration needs an exact source.', 400);
    if (selector.kind === 'standalone') {
      const alternative: Alternative = selector.source === 'mcp' ? { source: 'mcp' } : { source: 'composio', toolkit: selector.toolkit };
      if (!visible(alternative)) fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID', 'This integration uses its native tool.', 400);
      return { alternatives: [alternative], personal: context.allowPersonal ? [alternative] : [], toolCap: null, required: false, package: false };
    }
    const source = await readAgentExtensionPackageVersion({ userId: context.actor.userId, workspaceId: context.actor.workspaceId }, selector.package,
      { allowPersonalPackages: context.allowPersonal });
    const capability = source.metadata.declarations.find(declaration => declaration.declarationPath === selector.declarationPath)
      ?.workflow.integrationCapabilities.find(capability => capability.id === selector.capabilityId);
    const alternative = capability?.alternatives.find(alternative => alternativeKey(alternative) === selector.alternativeKey);
    if (!alternative || !visible(alternative)) fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID', 'Choose one exact published declaration alternative.', 400);
    return { alternatives: [alternative], personal: context.allowPersonal ? [alternative] : [], toolCap: null,
      required: capability!.required, package: true };
  }
  if (selector.kind !== 'slot' || !context.snapshot) fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose a current agent slot.', 400);
  const snapshot = context.snapshot, capabilityKey = context.target.capabilityKey;
  if (isStandaloneExtensionSlotRef(capabilityKey)) {
    const matches: StoredStandaloneExtensionBinding[] = [];
    for (const binding of snapshot.bindings) if (binding.standaloneConfiguration) {
      const slot = parseStoredStandaloneExtensionBinding(binding.standaloneConfiguration);
      const source = slot.mode === 'fixed' ? slot.entry.selection.source : slot.source;
      const toolkit = slot.mode === 'fixed' ? slot.entry.selection.kind === 'composio' ? slot.entry.selection.toolkit : undefined : slot.toolkit;
      const ref = createStandaloneExtensionSlotRef({ configurationId: slot.configurationId, source, ...(toolkit ? { toolkit } : {}) });
      if (binding.resourceId !== ref) fail('AGENT_WORKFLOW_CORRUPT', 'A stored selection slot is inconsistent.');
      if (ref === capabilityKey) matches.push(slot);
    }
    if (matches.length !== 1) fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose one current standalone slot.', 400);
    const slot = matches[0]!;
    if (slot.mode !== 'selectable') fail('AGENT_WORKFLOW_CHOICE_DENIED', 'This connection is centrally fixed.', 403);
    const alternative: Alternative = slot.source === 'composio' ? { source: 'composio', toolkit: slot.toolkit! } : { source: 'mcp' };
    if (!visible(alternative) || selector.alternativeKey && selector.alternativeKey !== alternativeKey(alternative)) {
      fail('AGENT_WORKFLOW_CHOICE_DENIED', 'The requested alternative is outside this slot.', 403);
    }
    return { alternatives: [alternative], allowed: slot.allowedChoices.map(choice => ({ choiceId: choice.choiceId,
      selection: choice.selection, target: choice.target, toolCap: choice.toolCap })), personal: slot.personalPolicy ? [alternative] : [],
      definitionIds: slot.personalPolicy?.source === 'mcp' ? slot.personalPolicy.serverDefinitionIds : undefined,
      toolCap: slot.personalPolicy?.toolCap ?? null, required: slot.requirement === 'required', package: false };
  }
  for (const binding of snapshot.bindings) if (binding.configuration) {
    const stored = binding.configuration;
    if (!stored.declarations.some(declaration => declaration.capabilities.some(capability =>
      agentWorkflowCapabilityKey(stored.resourceRef, declaration.declarationPath, capability.capabilityId) === capabilityKey))) continue;
    const source = await readAgentExtensionPackageVersion({ userId: context.actor.userId, workspaceId: context.actor.workspaceId },
      { resourceRef: stored.resourceRef, publishedRevisionRef: stored.publishedRevisionRef, checksum: stored.checksum },
      { allowPersonalPackages: snapshot.agent.scopeType === 'user' });
    const requiredRoots: string[] = [];
    if (binding.extensionSelections?.some(entry => entry.selection.kind === 'plugin') && context.organizationId) {
      const record = await findCapabilityResourceRecord(stored.resourceRef);
      const state = await readOrganizationPermissionForUser(context.actor.userId);
      if (state.organizationId !== context.organizationId || state.permission?.status !== 'active') {
        fail('AGENT_ACCESS_DENIED', 'The current package policy actor changed.', 403);
      }
      const policyContext = { userId: context.actor.userId, organizationId: context.organizationId, role: state.permission.role,
        workspaceId: context.actor.workspaceId, projectId: context.actor.projectId };
      const [candidates, policies] = await Promise.all([loadCapabilityCandidates(policyContext, { resolveConnections: false }),
        withCapabilityPolicyStore(store => store.listOrganizationPolicies(context.organizationId!))]);
      const effective = resolveEffectiveCapabilities({ context: policyContext, candidates, policies });
      for (const skill of source.metadata.skillRoots) if (effective.capabilities.some(candidate => candidate.effectivePolicy === 'required'
        && candidate.ref.sourcePluginId === record?.storage.resourceId && candidate.ref.name === skill.name)) requiredRoots.push(skill.relativeRoot);
    }
    const effective = projectPackageExtensionSelection({ source: stored, kind: source.metadata.kind, inventory: source.metadata.skillRoots,
      selections: binding.extensionSelections, requiredRoots }).configuration;
    for (const declaration of effective.declarations) for (const capability of declaration.capabilities) {
      if (agentWorkflowCapabilityKey(effective.resourceRef, declaration.declarationPath, capability.capabilityId) !== capabilityKey) continue;
      const selection = capability.selection;
      if (selection.mode !== 'selectable') fail('AGENT_WORKFLOW_CHOICE_DENIED', 'This capability is centrally fixed.', 403);
      const alternatives = capability.alternatives.filter(alternative => visible(alternative)
        && (!selector.alternativeKey || alternativeKey(alternative) === selector.alternativeKey));
      if (!alternatives.length) fail('AGENT_WORKFLOW_CHOICE_DENIED', 'The requested alternative is outside this capability.', 403);
      return { alternatives, allowed: selection.allowedChoices.flatMap(choice => {
        const alternative = alternatives.find(alternative => alternativeKey(alternative) === choice.alternativeKey);
        return alternative ? [{ choiceId: choice.choiceId, selection: publicSelection(choice.target, alternative), target: choice.target,
          toolCap: choice.toolCap, alternativeKey: choice.alternativeKey }] : [];
      }), personal: alternatives.filter(alternative => selection.personalPolicy?.sources.includes(alternative.source)
        && selection.personalPolicy.alternativeKeys.includes(alternativeKey(alternative)!)),
      definitionMappings: selection.personalPolicy?.mcpDefinitionMappings, toolCap: selection.personalPolicy?.toolCap ?? null,
      required: capability.required, package: true };
    }
  }
  return fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose an active capability from the current exact package selection.', 400);
}

function permittedTools(tools: readonly string[] | null, cap: readonly string[] | null, alternative: Alternative): {
  allowedToolNames: string[] | null; eligibility: AgentExtensionConnectionChoice['eligibility'];
} {
  const allowedToolNames = intersectPackageExtensionToolCaps(tools, cap);
  return { allowedToolNames, eligibility: (alternative.requiredTools ?? []).some(name => allowedToolNames !== null && !allowedToolNames.includes(name))
    ? { action: 'unavailable', reason: { code: 'AGENT_WORKFLOW_REQUIRED_TOOLS', message: 'This connection does not grant every required tool.' } } : { action: 'select' } };
}

async function sharedChoice(context: AgentExtensionOptionsContext, scope: Scope, source: IntegrationConnectionBindingAuthorization,
  candidate?: Candidate): Promise<AgentExtensionConnectionChoice | null> {
  const alternative = scope.alternatives.find(alternative => alternative.source === source.resource.source
    && (alternative.source !== 'composio' || source.backend.source === 'composio' && source.backend.toolkit === alternative.toolkit)
    && (!candidate?.alternativeKey || alternativeKey(alternative) === candidate.alternativeKey));
  if (!alternative || !source.canUse || scope.package && context.target.kind !== 'user_choice' && alternative.source === 'mcp' && !source.canManage) return null;
  const currentSelection = standaloneExtensionSelectionSchema.parse({ kind: alternative.source, source: alternative.source,
    ...(alternative.source === 'composio' ? { toolkit: alternative.toolkit } : {}), target: { kind: 'shared',
      connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision } });
  const selection = candidate?.selection ?? currentSelection;
  const tools = permittedTools(source.allowedToolNames, candidate?.toolCap ?? null, alternative);
  let mappingRequired = false;
  if (alternative.source === 'mcp') {
    const backend = await readAgentSharedMcpOptionMetadata(context, source.resource.connectionRef);
    if (!backend || backend.connection.enabled === false || backend.authorization.authorizationRevision !== source.authorizationRevision) return null;
    if (scope.package) {
      const definitions = await listMcpServerDefinitions(source.resource.ownership.organizationId);
      if (context.target.kind !== 'user_choice') {
        if (!backend.authorization.canManage) return null;
        mappingRequired = !definitions.some(definition => definition.enabled && definition.id === backend.connection.serverDefinitionId);
      } else {
        const mapping = candidate?.target.kind === 'shared' ? candidate.target.verifiedMcpMapping : undefined;
        if (!mapping || mapping.connector !== alternative.connector || mapping.configFingerprint !== hashMcpLegacyConfig(backend.connection)
          || mapping.definitionId !== null && !definitions.some(definition => definition.enabled && definition.id === mapping.definitionId
            && definition.revision === mapping.definitionRevision && backend.connection.serverDefinitionId === definition.id)) return null;
      }
    }
  }
  const changed = selection.target.kind !== 'shared' || selection.target.bindingRevision !== source.resource.bindingRevision;
  const pending = source.backend.source === 'composio' && source.backend.accountBinding === 'pending';
  return { id: candidate ? `choice:${candidate.choiceId}` : source.resource.connectionRef, selection, label: label(source.resource.displayName, 'Shared connection'),
    ...(candidate ? { choiceId: candidate.choiceId } : {}), ...(alternativeKey(alternative) ? { alternativeKey: alternativeKey(alternative) } : {}),
    scopeLabel: source.resource.ownership.type === 'team' ? 'team' : 'organization', ...tools,
    eligibility: changed ? { action: 'unavailable', reason: { code: 'AGENT_WORKFLOW_BINDING_CHANGED', message: 'The centrally allowed connection changed.' } }
      : pending ? { action: 'setup', reason: { code: 'AGENT_WORKFLOW_SETUP_REQUIRED', message: 'Connect the shared app before choosing it.' } } : tools.eligibility,
    authorization: source.backend.source === 'composio' && source.backend.accountBinding === 'no_auth' ? 'not_required' : 'unknown',
    health: 'unknown', mappingRequired };
}

/** Fresh exact choices for one authorized configuration or Use-only slot; no provider discovery before explicit profile selection. */
export async function listAgentExtensionConnectionChoices(context: AgentExtensionOptionsContext,
  requestInput: AgentExtensionConnectionChoicesRequest, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  await revalidateAgentExtensionOptionsContext(context);
  const parsed = agentExtensionOptionsRequestSchema.safeParse(structuredClone(requestInput));
  if (!parsed.success || parsed.data.operation !== 'connection_choices'
    || JSON.stringify(parsed.data.target) !== JSON.stringify(agentExtensionOptionsTargetSchema.parse(context.target))) {
    fail('AGENT_WORKFLOW_OPTIONS_INVALID', 'Choose connections for the same current target context.', 400);
  }
  const request = parsed.data;
  const binding = digest([context.contextKey, request.selector, request.profileId ?? null, request.q, request.limit]);
  let offset = 0;
  if (request.cursor) try {
    const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (Object.keys(cursor).some(key => !['v', 'binding', 'offset'].includes(key)) || cursor.v !== 1 || cursor.binding !== binding
      || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > 4096) throw new Error('Invalid position');
    offset = Number(cursor.offset);
  } catch { fail('AGENT_WORKFLOW_OPTIONS_CURSOR_CHANGED', 'The current chooser changed. Restart its search.'); }
  const scope = await selectionScope(context, request), scopeStamp = digest(scope);
  const coverage = new Map<PluginExtensionCoverage['source'], PluginExtensionCoverage>();
  for (const alternative of scope.alternatives) coverage.set(alternative.source, { source: alternative.source, status: 'complete' });
  const connections: AgentExtensionConnectionChoice[] = [];
  const ownMcpStamps = new Map<string, string>();
  const shared = scope.allowed ? await Promise.all(scope.allowed.flatMap(candidate => candidate.target.kind === 'shared' ? [candidate] : []).map(async candidate => {
    try { return { authorization: await authorizeAgentExtensionSharedOption(context, candidate.target.kind === 'shared' ? candidate.target.connectionRef : ''), candidate }; }
    catch (error) { if (!unavailable(error)) throw error; return null; }
  })) : (await listAgentExtensionSharedOptions(context, scope.alternatives.length === 1 ? scope.alternatives[0]!.source : undefined))
    .map(authorization => ({ authorization, candidate: undefined }));
  for (const value of shared) if (value) {
    signal?.throwIfAborted();
    const item = await sharedChoice(context, scope, value.authorization, value.candidate);
    if (item) connections.push(item);
  }
  const personalMcp = scope.personal.some(alternative => alternative.source === 'mcp') || scope.allowed?.some(candidate =>
    candidate.selection.kind === 'mcp' && candidate.target.kind === 'personal' && candidate.target.ownerUserId === context.actor.userId);
  if (personalMcp && context.allowPersonal) {
    const inventory = context.target.kind === 'user_choice' ? await readAgentOwnMcpOptionsInventory(context) : await readAgentMcpOptionsInventory(context);
    coverage.set('mcp', inventory.coverage);
    const definitions = context.organizationId ? await listMcpServerDefinitions(context.organizationId) : [];
    for (const item of inventory.items) {
      if (item.kind !== 'mcp' || item.mcp.template || !item.id.startsWith('mcp-personal:') || !item.access.canUse) continue;
      const current = await readAgentOwnMcpOptionMetadata(context, item.id);
      if (!current || current.connection.enabled === false) continue;
      ownMcpStamps.set(item.id, digest(current.connection));
      const candidates = scope.allowed?.filter(candidate => candidate.selection.kind === 'mcp' && candidate.selection.target.kind === 'personal'
        && candidate.selection.target.connectionRef === item.id && candidate.target.kind === 'personal' && candidate.target.ownerUserId === context.actor.userId) ?? [];
      const alternatives = scope.personal.filter(alternative => alternative.source === 'mcp');
      for (const alternative of alternatives) {
        const ids = scope.definitionIds ?? (scope.definitionMappings?.find(mapping => mapping.connector === alternative.connector)?.serverDefinitionIds
          ?? (scope.package && context.target.kind === 'user_choice' ? [] : undefined));
        const definition = definitions.find(definition => definition.enabled && definition.id === current.connection.serverDefinitionId
          && (!ids || ids.includes(definition.id)) && matchesMcpServerDefinition(current.connection, definition));
        if ((scope.package || ids) && !definition) continue;
        const selection: StandaloneExtensionSelection = { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: item.id } };
        connections.push({ id: `personal:${alternativeKey(alternative) ?? 'mcp'}:${item.id}`, selection, label: item.displayName,
          ...(definition ? { definitionId: definition.id } : {}), ...(alternativeKey(alternative) ? { alternativeKey: alternativeKey(alternative) } : {}),
          scopeLabel: 'personal', ...permittedTools(null, scope.toolCap, alternative),
          authorization: item.connections[0]?.authorization ?? 'unknown', health: 'unknown', mappingRequired: false, ...(item.icon ? { icon: item.icon } : {}) });
      }
      for (const candidate of candidates) {
        if (context.scopeType !== 'user') continue;
        const alternative = scope.alternatives.find(alternative => alternative.source === 'mcp'
          && (!candidate.alternativeKey || alternativeKey(alternative) === candidate.alternativeKey));
        if (!alternative) continue;
        connections.push({ id: `choice:${candidate.choiceId}`, choiceId: candidate.choiceId, selection: candidate.selection,
          ...(candidate.alternativeKey ? { alternativeKey: candidate.alternativeKey } : {}), label: item.displayName, scopeLabel: 'personal',
          ...permittedTools(null, candidate.toolCap, alternative), authorization: item.connections[0]?.authorization ?? 'unknown',
          health: 'unknown', mappingRequired: false, ...(item.icon ? { icon: item.icon } : {}) });
      }
    }
  }
  const profiles: AgentExtensionProfileChoice[] = [], accounts: AgentExtensionAccountChoice[] = [];
  const personalComposio = scope.personal.filter((alternative): alternative is Extract<Alternative, { source: 'composio' }> => alternative.source === 'composio');
  const ownComposioCandidates = context.scopeType === 'user' ? scope.allowed?.filter(candidate => candidate.selection.kind === 'composio'
    && candidate.target.kind === 'personal' && candidate.target.ownerUserId === context.actor.userId) ?? [] : [];
  const initialProfiles = (personalComposio.length || ownComposioCandidates.length) && context.allowPersonal ? (await listExistingComposioProfiles(context.actor.userId))
    .filter(profile => profile.status === 'active' && profile.ownerUserId === context.actor.userId) : [];
  if (initialProfiles.length > 32) fail('AGENT_WORKFLOW_OPTIONS_UNAVAILABLE', 'Too many personal profiles are available for this chooser.', 503);
  for (const alternative of personalComposio) for (const profile of initialProfiles) profiles.push({ profileId: profile.id,
    label: label(profile.name, 'Personal profile'), status: 'unverified', ...(alternativeKey(alternative) ? { alternativeKey: alternativeKey(alternative) } : {}) });
  for (const candidate of ownComposioCandidates) {
    const selection = candidate.selection;
    if (selection.kind !== 'composio' || selection.target.kind !== 'personal') continue;
    const profileId = selection.target.profileId;
    const profile = initialProfiles.find(profile => profile.id === profileId);
    const alternative = scope.alternatives.find(alternative => alternative.source === 'composio' && alternative.toolkit === selection.toolkit);
    if (!profile || !alternative) continue;
    connections.push({ id: `choice:${candidate.choiceId}`, choiceId: candidate.choiceId, selection, scopeLabel: 'personal',
      label: `${selection.toolkit} · ${label(profile.name, 'Personal profile')}`, ...(candidate.alternativeKey ? { alternativeKey: candidate.alternativeKey } : {}),
      ...permittedTools(null, candidate.toolCap, alternative), authorization: 'unknown', health: 'unknown', mappingRequired: false });
  }
  signal?.throwIfAborted();
  let noAuthSelection: Extract<StandaloneExtensionSelection, { kind: 'composio' }> & {
    target: { kind: 'personal'; profileId: string; accountBinding: 'no_auth' } } | undefined;
  if (request.profileId !== undefined) {
    const profile = initialProfiles.find(profile => profile.id === request.profileId);
    if (!profile || personalComposio.length !== 1) fail('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose your own profile for one explicitly permitted app.', 403);
    const alternative = personalComposio[0]!;
    const providerRef = createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit: alternative.toolkit,
      scope: { type: 'user', ownerUserId: context.actor.userId, resourceId: `profile:${profile.id}:${alternative.toolkit}` } });
    const choices = await listPersonalWorkflowProviderAccountChoices({ actor: context.actor, providerRef,
      exactToolkit: { profileId: profile.id, toolkit: alternative.toolkit } });
    if (choices.noAuth) noAuthSelection = { kind: 'composio', source: 'composio', toolkit: alternative.toolkit,
      target: { kind: 'personal', profileId: profile.id, accountBinding: 'no_auth' } };
    else for (const account of choices.accounts) {
      const receipt = readPersonalComposioAccountReference(account.accountSelectionRef);
      if (receipt.actorUserId !== context.actor.userId || receipt.organizationId !== context.organizationId
        || receipt.workspaceId !== (context.actor.workspaceId ?? null) || receipt.profileId !== profile.id || receipt.toolkit !== alternative.toolkit
        || receipt.providerRef !== providerRef) fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The explicit account choice context changed.');
      const selection = standaloneExtensionSelectionSchema.parse({ kind: 'composio', source: 'composio', toolkit: alternative.toolkit,
        target: { kind: 'personal', profileId: profile.id, accountBinding: 'account', accountId: receipt.accountId,
          connectionRef: `composio-personal:${profile.id}:${receipt.accountId}` } });
      if (selection.kind !== 'composio' || selection.target.kind !== 'personal' || selection.target.accountBinding !== 'account') {
        fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The selected account changed.');
      }
      accounts.push({ selection: { ...selection, target: selection.target }, accountSelectionRef: account.accountSelectionRef,
        label: label(account.label, 'App account'), status: ['ACTIVE', 'INITIATED', 'INACTIVE', 'EXPIRED', 'FAILED', 'REVOKED'].includes(account.status) ? account.status : 'UNKNOWN',
        selectable: account.selectable, expiresAt: new Date(receipt.expiresAt).toISOString(), alternativeKey: alternativeKey(alternative) });
    }
    const current = (await listExistingComposioProfiles(context.actor.userId)).find(current => current.id === profile.id && current.status === 'active');
    if (!current || digest(current) !== digest(profile)) fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The selected profile changed. Reload its accounts.');
  }
  // Recheck exact source access and local configuration after explicit account
  // IO as well. A lost source is omitted; a changed target/policy fails the read.
  const freshScope = await selectionScope(context, request);
  if (digest(freshScope) !== scopeStamp) fail('AGENT_WORKFLOW_OPTIONS_CHANGED', 'The effective selection policy changed. Reload its options.');
  const latestProfiles = initialProfiles.length ? await listExistingComposioProfiles(context.actor.userId) : [];
  const currentProfileIds = new Set(latestProfiles.filter(profile => profile.ownerUserId === context.actor.userId && profile.status === 'active'
    && initialProfiles.some(previous => previous.id === profile.id && digest(previous) === digest(profile))).map(profile => profile.id));
  if (request.profileId !== undefined && !currentProfileIds.has(request.profileId)) {
    fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The selected profile changed before its accounts could be returned.');
  }
  for (let index = profiles.length - 1; index >= 0; index--) if (!currentProfileIds.has(profiles[index]!.profileId)) profiles.splice(index, 1);
  for (let index = connections.length - 1; index >= 0; index--) {
    const item = connections[index]!, selected = item.selection;
    if (selected.target.kind === 'shared') {
      try {
        const source = await authorizeAgentExtensionSharedOption(context, selected.target.connectionRef);
        const candidate = scope.allowed?.find(candidate => candidate.choiceId === item.choiceId);
        const current = await sharedChoice(context, scope, source, candidate);
        if (current && digest(current) === digest(item)) continue;
      } catch (error) { if (!unavailable(error)) throw error; }
    } else if (selected.kind === 'mcp') {
      const current = await readAgentOwnMcpOptionMetadata(context, selected.target.connectionRef);
      if (current && current.connection.enabled !== false && ownMcpStamps.get(selected.target.connectionRef) === digest(current.connection)) {
        if (!item.definitionId || context.organizationId && (await listMcpServerDefinitions(context.organizationId)).some(definition =>
          definition.id === item.definitionId && definition.enabled && matchesMcpServerDefinition(current.connection, definition))) continue;
      }
    } else if (currentProfileIds.has(selected.target.profileId)) continue;
    connections.splice(index, 1);
    const source = selected.source;
    coverage.set(source, { source, status: 'partial', error: { code: 'AGENT_WORKFLOW_OPTIONS_CHANGED', message: 'Some connection metadata changed while loading.', retryable: true } });
  }
  await revalidateAgentExtensionOptionsContext(context);
  signal?.throwIfAborted();
  for (const item of connections) {
    const packageBinding = publicPackageBinding(context, scope, item.selection, item.alternativeKey);
    if (packageBinding) item.packageBinding = packageBinding;
  }
  for (const item of accounts) {
    const packageBinding = publicPackageBinding(context, scope, item.selection, item.alternativeKey, item.accountSelectionRef);
    if (packageBinding) item.packageBinding = packageBinding;
  }
  const noAuthPackageBinding = noAuthSelection ? publicPackageBinding(context, scope, noAuthSelection, `composio:${noAuthSelection.toolkit}`) : undefined;
  const needle = request.q.toLocaleLowerCase();
  const rows = [...connections.map(value => ({ kind: 'connection' as const, value })), ...profiles.map(value => ({ kind: 'profile' as const, value })),
    ...accounts.map(value => ({ kind: 'account' as const, value }))].filter(row => row.value.label.toLocaleLowerCase().includes(needle));
  const page = rows.slice(offset, offset + request.limit), hasNextPage = offset + page.length < rows.length;
  const payload = { schemaVersion: 1 as const, contextKey: context.contextKey, limits: EXTENSION_SELECTION_LIMITS,
    coverage: [...coverage.values()], connections: page.flatMap(row => row.kind === 'connection' ? [row.value] : []),
    profiles: page.flatMap(row => row.kind === 'profile' ? [row.value] : []), accounts: page.flatMap(row => row.kind === 'account' ? [row.value] : []),
    ...(scope.personal.length ? { personalSelectionPolicy: { requirement: scope.required ? 'required' as const : 'optional' as const,
      toolCap: scope.toolCap && [...scope.toolCap] } } : {}), ...(noAuthSelection ? { noAuthSelection } : {}),
    ...(noAuthPackageBinding ? { noAuthPackageBinding } : {}),
    pagination: { nextCursor: hasNextPage ? Buffer.from(JSON.stringify({ v: 1, binding, offset: offset + page.length })).toString('base64url') : null,
      hasNextPage, loadedItems: page.length, totalItems: rows.length } };
  if (context.target.kind === 'user_choice' && request.selector.kind === 'slot') return { ...payload, operation: 'connection_choices', target: context.target, selector: request.selector };
  if (context.target.kind !== 'user_choice' && request.selector.kind !== 'slot') return { ...payload, operation: 'connection_choices', target: context.target, selector: request.selector };
  return fail('AGENT_WORKFLOW_OPTIONS_INVALID', 'The current target selection changed.');
}
