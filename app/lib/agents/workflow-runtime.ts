import 'server-only';

import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { getAuthorizedAgentWorkflowPackageSelections, isAuthorizedAgentWorkflowPackageSelections,
  type AuthorizedAgentWorkflowPackageSelections } from '@/app/lib/capabilities/packages/runtime-bindings';
import { IntegrationContractError, type IntegrationExecutionContext, type IntegrationPolicy,
  type IntegrationProviderDescriptor, type IntegrationProviderToolRule } from '@/app/lib/integration-tools/contracts';
import { authorizeIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { createSharedIntegrationProviderRef, findSharedIntegrationConnectionAuthorization } from '@/app/lib/integration-tools/connections/provider-authorization';
import { createSharedIntegrationPolicyDescriptor } from '@/app/lib/integration-tools/connections/provider-policy';
import { integrationPolicyAllowedToolNames, isIntegrationProviderOperationAllowed, isIntegrationProviderVisible } from '@/app/lib/integration-tools/policy';
import { attachPersonalWorkflowProviderTargets, verifyStoredPersonalWorkflowProviderTarget, getPreparedPersonalWorkflowProviderTarget,
  type PreparedPersonalWorkflowProviderTarget } from '@/app/lib/integration-tools/workflow-personal-bindings';
import { getAttachedPersonalWorkflowProviderDescriptor } from '@/app/lib/integration-tools/workflow-personal-provenance';
import { schemaFingerprint } from '@/app/lib/integration-tools/schema';
import { attachWorkflowProviderAssociations, type WorkflowProviderAssociation } from '@/app/lib/integration-tools/workflow-provider-associations';
import { getSelectedAgentWorkflowCapability } from './workflow-configuration';
import { agentWorkflowRuntimeActor, getRuntimeAgentWorkflowMode } from './workflow-runtime-mode';
import { agentWorkflowCapabilityKey, type StoredAgentWorkflowTarget } from './workflow-contracts';
import type { WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';
import { resolveAgentStandaloneRuntimeProviders, type AgentStandaloneRuntimeSelection } from '@/app/lib/capabilities/extensions/standalone-runtime';
import { readAcceptedTurnRuntimeSelection, type HeldAcceptedTurnRuntimeSelection } from '@/app/lib/capabilities/extensions/turn-runtime';
import { extensionSelectionIdentity, type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import { resolveTurnPackageCapabilitySelections, turnPackageCapabilityKey,
  type TurnPackageCapability } from '@/app/lib/capabilities/extensions/turn-package-bindings';

const OPERATIONS = ['list_providers', 'search_providers', 'list_tools', 'search_tools', 'describe', 'call'] as const;
type RequiredProviderTools = { source: 'mcp' | 'composio'; providerRef: string; names: readonly string[] };
type RequiredProvider = { source: 'mcp' | 'composio'; providerRef: string };
export type AgentWorkflowRuntimeProjection = Readonly<{ policy: IntegrationPolicy; revision: string;
  selectedProviders: readonly IntegrationProviderDescriptor[];
  standaloneSelections: readonly AgentStandaloneRuntimeSelection[]; unavailable: boolean }>;
type ProjectionProof = { actorKey: string; prepared: readonly PreparedPersonalWorkflowProviderTarget[];
  requiredTools: readonly RequiredProviderTools[]; requiredProviders: readonly RequiredProvider[];
  associations: readonly WorkflowProviderAssociation[]; unavailable: boolean };
const host = globalThis as typeof globalThis & { __canvasAgentWorkflowRuntimeV1?: WeakMap<object, ProjectionProof> };
const projections = host.__canvasAgentWorkflowRuntimeV1 ??= new WeakMap<object, ProjectionProof>();
export type HeldAgentWorkflowPackageTurnFocus = Readonly<{ kind: 'workflow_package_turn_focus' }>;
type PackageTurnFocus = { actorKey: string; selection: AuthorizedAgentWorkflowPackageSelections;
  turnSource: HeldAcceptedTurnRuntimeSelection; identities: readonly string[] };
const focusHost = globalThis as typeof globalThis & { __canvasAgentPackageTurnFocusV1?: WeakMap<object, PackageTurnFocus> };
const packageTurnFocuses = focusHost.__canvasAgentPackageTurnFocusV1 ??= new WeakMap<object, PackageTurnFocus>();

/** This decision can only narrow standalone processing; its issuer is private to actual package compilation. */
export function readAgentWorkflowPackageTurnFocus(focus: HeldAgentWorkflowPackageTurnFocus,
  context: AgentExecutionContext, selection: AuthorizedAgentWorkflowPackageSelections,
  turnSource: HeldAcceptedTurnRuntimeSelection): readonly string[] {
  const issued = packageTurnFocuses.get(focus);
  if (!issued || issued.actorKey !== JSON.stringify([actorKey(context), context.agentTurnId, context.turnExtensions])
    || issued.selection !== selection || issued.turnSource !== turnSource
    || !isAuthorizedAgentWorkflowPackageSelections(selection, context)) return deny();
  readAcceptedTurnRuntimeSelection(turnSource, context, selection);
  return issued.identities;
}

function publicTargetIdentity(target: StoredAgentWorkflowTarget,
  alternative: WorkflowIntegrationAlternative): string | null {
  let selected: StandaloneExtensionSelection;
  if (target.kind === 'shared') {
    const current = { kind: 'shared' as const, connectionRef: target.connectionRef, bindingRevision: target.bindingRevision };
    selected = alternative.source === 'mcp' ? { kind: 'mcp', source: 'mcp', target: current }
      : { kind: 'composio', source: 'composio', toolkit: alternative.toolkit, target: current };
  } else if (target.personalBinding?.source === 'mcp') {
    selected = { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${target.personalBinding.connectionId}` } };
  } else if (target.personalBinding?.source === 'composio') {
    const binding = target.personalBinding;
    selected = { kind: 'composio', source: 'composio', toolkit: binding.toolkit, target: binding.accountBinding === 'no_auth'
      ? { kind: 'personal', profileId: binding.profileId, accountBinding: 'no_auth' }
      : { kind: 'personal', profileId: binding.profileId, accountBinding: 'account', accountId: binding.connectedAccountId!,
        connectionRef: `composio-personal:${binding.profileId}:${binding.connectedAccountId}` } };
  } else return null;
  return extensionSelectionIdentity(selected);
}

function actorKey(context: AgentExecutionContext | IntegrationExecutionContext): string {
  return 'userId' in context
    ? JSON.stringify([context.userId, context.organizationId, context.workspaceId, context.agentId, context.sessionId])
    : JSON.stringify([context.actorUserId, context.organizationId ?? null, context.workspaceId ?? null, context.agentId ?? null, context.sessionId ?? null]);
}
function deny(message = 'The required workflow connection is unavailable. Review this agent’s workflow settings.'): never {
  throw new IntegrationContractError('provider_denied', message);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function intersectTools(left: readonly string[] | null, right: readonly string[] | null): string[] | null {
  return left === null ? right === null ? null : [...right] : right === null ? [...left] : left.filter(name => right.includes(name));
}
function unionTools(left: readonly string[] | null, right: readonly string[] | null): string[] | null {
  return left === null || right === null ? null : [...new Set([...left, ...right])].sort();
}
function exactAlternative(alternative: WorkflowIntegrationAlternative, target: StoredAgentWorkflowTarget): boolean {
  return target.source === alternative.source && (alternative.source !== 'mcp' || target.kind !== 'shared'
    || target.verifiedMcpMapping?.connector === alternative.connector);
}

/** Compile only current, private instance bindings. This performs no provider or tool discovery. */
export async function resolveAgentWorkflowRuntimeProjection(context: AgentExecutionContext,
  options: { packageSelection?: AuthorizedAgentWorkflowPackageSelections } = {}): Promise<AgentWorkflowRuntimeProjection | null> {
  if (options.packageSelection && !isAuthorizedAgentWorkflowPackageSelections(options.packageSelection, context)) return deny();
  const mode = await getRuntimeAgentWorkflowMode(context);
  const packageTurn = context.turnExtensions?.selections.some(entry => entry.selection.kind === 'plugin' || entry.selection.kind === 'skill');
  if (mode === null && !context.turnExtensionSource && !packageTurn) return null;
  const actor = agentWorkflowRuntimeActor(context);
  const selection = options.packageSelection ?? await getAuthorizedAgentWorkflowPackageSelections(context);
  if (!isAuthorizedAgentWorkflowPackageSelections(selection, context)) return deny();
  const turn = context.turnExtensionSource ? readAcceptedTurnRuntimeSelection(context.turnExtensionSource, context, selection) : null;
  let chosen: readonly TurnPackageCapability[] = selection.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities.map(capability => ({
    pkg, declaration, capability, chosen: getSelectedAgentWorkflowCapability(selection.snapshot, pkg, declaration, capability),
  }))));
  const turnCapabilities = await resolveTurnPackageCapabilitySelections(context, selection);
  const turnBySlot = new Map(turnCapabilities.map(entry => [turnPackageCapabilityKey(entry), entry]));
  chosen = [...chosen.filter(entry => !turnBySlot.has(turnPackageCapabilityKey(entry))), ...turnCapabilities];
  let unavailable = chosen.some(entry => entry.capability.required && !entry.chosen);
  const requested = new Map((turn?.privateFixedBindings ?? []).map(binding => [extensionSelectionIdentity(binding.entry.selection), binding.entry]));
  const handled = new Map<string, { providerRef: string; toolCap: readonly string[] | null; required: boolean }>();
  const rules = new Map<string, IntegrationProviderToolRule>();
  const descriptors = new Map<string, IntegrationProviderDescriptor>();
  const prepared: PreparedPersonalWorkflowProviderTarget[] = [];
  const requirements = new Map<string, RequiredProviderTools>();
  const requiredProviders = new Map<string, RequiredProvider>();
  const associations = new Map<string, WorkflowProviderAssociation>();
  const authorityRevisions: unknown[] = [];
  // A missing mandatory selection closes the complete workflow before any provider inspection.
  if (!unavailable) for (const entry of chosen) {
    if (!entry.chosen) continue;
    const { target, toolCap, alternativeKey } = entry.chosen;
    const alternative = entry.capability.alternatives.find(item => `${item.source}:${item.source === 'mcp' ? item.connector : item.toolkit}` === alternativeKey);
    const identity = alternative ? publicTargetIdentity(target, alternative) : null;
    const focus = identity ? requested.get(identity) : undefined;
    if (focus) {
      const requestedTarget = focus.target;
      // An invalid explicit focus is fatal even when the package dependency is
      // optional. Check before adding a provider and outside its outage catch.
      if (requestedTarget.kind !== target.kind || requestedTarget.source !== target.source
        || target.kind === 'shared' && (requestedTarget.kind !== 'shared'
          || requestedTarget.connectionRef !== target.connectionRef || requestedTarget.bindingRevision !== target.bindingRevision)
        || target.kind === 'personal' && (requestedTarget.kind !== 'personal'
          || requestedTarget.ownerUserId !== target.ownerUserId || requestedTarget.providerRef !== target.providerRef
          || requestedTarget.boundProviderRef !== target.boundProviderRef || requestedTarget.bindingFingerprint !== target.bindingFingerprint
          || JSON.stringify(requestedTarget.personalBinding) !== JSON.stringify(target.personalBinding))) return deny();
    }
    try {
      if (!alternative || !exactAlternative(alternative, target)) return deny();
      let providerRef: string, permitted: readonly string[] | null = toolCap;
      const metadataContext: IntegrationExecutionContext = { actorUserId: actor.userId, organizationId: context.organizationId,
        workspaceId: context.workspaceId, agentId: context.agentId, sessionId: context.sessionId, policyRevision: 'agent-workflow-selection' };
      if (target.kind === 'shared') {
        const authorization = await authorizeIntegrationConnection({ userId: actor.userId, organizationId: actor.organizationId,
          workspaceId: actor.workspaceId, agentId: context.agentId, sessionId: context.sessionId, policyRevision: 'agent-workflow-selection' },
        target.connectionRef, 'inspect');
        if (!authorization.access.canUse || authorization.resource.source !== target.source
          || authorization.resource.bindingRevision !== target.bindingRevision || authorization.resource.status !== 'active') return deny();
        if (alternative.source === 'composio' && (authorization.backend.source !== 'composio'
          || authorization.backend.toolkit !== alternative.toolkit || authorization.backend.accountBinding === 'pending')) return deny();
        if (alternative.source === 'mcp') {
          const { resolveSharedMcpBackend } = await import('@/app/lib/mcp/shared-connections');
          const { hashMcpLegacyConfig } = await import('@/app/lib/mcp/connection-identity');
          const current = await resolveSharedMcpBackend(authorization.actor, target.connectionRef, 'inspect');
          if (!target.verifiedMcpMapping || current.connection.enabled === false || hashMcpLegacyConfig(current.connection) !== target.verifiedMcpMapping.configFingerprint) return deny();
          if (target.verifiedMcpMapping.definitionId) {
            const definitions = await (await import('@/app/lib/mcp/server-definitions')).listMcpServerDefinitions(authorization.resource.ownership.organizationId);
            const definition = definitions.find(item => item.id === target.verifiedMcpMapping!.definitionId);
            if (!definition?.enabled || definition.revision !== target.verifiedMcpMapping.definitionRevision) return deny();
          }
        }
        providerRef = createSharedIntegrationProviderRef(authorization.resource);
        descriptors.set(providerRef, await createSharedIntegrationPolicyDescriptor(metadataContext, authorization));
        permitted = intersectTools(toolCap, authorization.allowedToolNames);
        authorityRevisions.push([providerRef, authorization.authorizationRevision]);
      } else {
        if (!target.personalBinding || !target.boundProviderRef || !target.bindingFingerprint || target.ownerUserId !== actor.userId
          || target.personalBinding.source !== alternative.source || alternative.source === 'composio'
            && (target.personalBinding.source !== 'composio' || target.personalBinding.toolkit !== alternative.toolkit)) return deny();
        const proof = await verifyStoredPersonalWorkflowProviderTarget({ actor, target: { binding: target.personalBinding,
          baseProviderRef: target.providerRef, boundProviderRef: target.boundProviderRef, bindingFingerprint: target.bindingFingerprint } }, { checkProviderReadiness: false });
        const actual = getPreparedPersonalWorkflowProviderTarget(proof);
        providerRef = actual.boundProviderRef; prepared.push(proof);
        attachPersonalWorkflowProviderTargets(metadataContext, [proof]);
        const descriptor = getAttachedPersonalWorkflowProviderDescriptor(metadataContext, providerRef);
        if (!descriptor) return deny();
        descriptors.set(providerRef, descriptor);
        authorityRevisions.push([providerRef, actual.bindingFingerprint]);
      }
      const previous = rules.get(providerRef);
      const names = previous ? unionTools(previous.allowedToolNames, permitted) : permitted;
      rules.set(providerRef, { source: target.source, providerRef, allowedToolNames: names,
        allowedOperations: names?.length === 0 ? OPERATIONS.filter(operation => operation !== 'call') : [...OPERATIONS] });
      if (identity && focus) handled.set(identity, { providerRef, toolCap: focus.toolCap, required: focus.requirement === 'required' });
      const associated = associations.get(providerRef);
      associations.set(providerRef, { providerRef, aliases: [...new Set([...(associated?.aliases ?? []), entry.capability.application,
        entry.capability.capabilityId, ...(alternative.source === 'mcp' ? [alternative.connector] : [alternative.toolkit])])],
      pluginRefs: [...new Set([...(associated?.pluginRefs ?? []), ...(selection.snapshot.bindings.some(binding => binding.resourceType === 'plugin'
        && binding.configuration?.resourceRef === entry.pkg.resourceRef) || context.turnExtensions?.selections.some(selected =>
          selected.selection.kind === 'plugin' && selected.selection.package.resourceRef === entry.pkg.resourceRef)
          ? [entry.pkg.resourceRef] : [])])],
      skillRefs: [...new Set([...(associated?.skillRefs ?? []), ...entry.pkg.selectedSkills.map(skill => skill.name)])],
      capabilityRefs: [...new Set([...(associated?.capabilityRefs ?? []), agentWorkflowCapabilityKey(entry.pkg.resourceRef,
        entry.declaration.declarationPath, entry.capability.capabilityId)])] });
      if (entry.capability.required) requiredProviders.set(providerRef, { source: target.source, providerRef });
      if (entry.capability.required && alternative.requiredTools?.length) {
        const previousRequirement = requirements.get(providerRef);
        requirements.set(providerRef, { source: target.source, providerRef,
          names: [...new Set([...(previousRequirement?.names ?? []), ...alternative.requiredTools])].sort() });
      }
    } catch {
      if (entry.capability.required) { unavailable = true; break; }
    }
  }
  let packageFocus: HeldAgentWorkflowPackageTurnFocus | undefined;
  if (context.turnExtensionSource && handled.size) {
    packageFocus = Object.freeze({ kind: 'workflow_package_turn_focus' });
    packageTurnFocuses.set(packageFocus, { actorKey: JSON.stringify([actorKey(context), context.agentTurnId, context.turnExtensions]),
      selection, turnSource: context.turnExtensionSource, identities: Object.freeze([...handled.keys()]) });
  }
  const standalone = await resolveAgentStandaloneRuntimeProviders(context, selection, { skipProviderResolution: unavailable,
    ...(context.turnExtensionSource ? { turnSource: context.turnExtensionSource } : {}), ...(packageFocus ? { packageFocus } : {}) });
  unavailable ||= standalone.unavailable;
  if (!unavailable) for (const provider of standalone.providers) {
    const { descriptor, toolCap, selected } = provider;
    const previous = rules.get(descriptor.providerRef);
    if (previous && previous.source !== descriptor.source) return deny();
    const names = previous ? unionTools(previous.allowedToolNames, toolCap) : toolCap;
    rules.set(descriptor.providerRef, { source: descriptor.source, providerRef: descriptor.providerRef,
      allowedToolNames: names, allowedOperations: names?.length === 0 ? OPERATIONS.filter(operation => operation !== 'call') : [...OPERATIONS] });
    descriptors.set(descriptor.providerRef, descriptor);
    if (provider.personalProof) prepared.push(provider.personalProof);
    authorityRevisions.push([descriptor.providerRef, provider.authorityRevision, selected.slotRef]);
    if (selected.required) requiredProviders.set(descriptor.providerRef, { source: descriptor.source, providerRef: descriptor.providerRef });
    const associated = associations.get(descriptor.providerRef);
    associations.set(descriptor.providerRef, { providerRef: descriptor.providerRef,
      aliases: [...new Set([...(associated?.aliases ?? []), ...(descriptor.aliases ?? []), ...(descriptor.application ? [descriptor.application] : [])])],
      pluginRefs: [...(associated?.pluginRefs ?? [])], skillRefs: [...(associated?.skillRefs ?? [])],
      capabilityRefs: [...new Set([...(associated?.capabilityRefs ?? []), selected.slotRef])] });
  }
  if (!unavailable) for (const focus of handled.values()) {
    const rule = rules.get(focus.providerRef);
    if (!rule) return deny();
    const names = intersectTools(rule.allowedToolNames, focus.toolCap);
    rules.set(focus.providerRef, { ...rule, allowedToolNames: names,
      allowedOperations: names?.length === 0 ? OPERATIONS.filter(operation => operation !== 'call') : rule.allowedOperations });
    if (focus.required) requiredProviders.set(focus.providerRef, { source: rule.source, providerRef: focus.providerRef });
  }
  const matrix = unavailable ? [] : [...rules.values()].sort((left, right) => left.providerRef.localeCompare(right.providerRef));
  const policy: IntegrationPolicy = { allowedSources: null, allowedProviderRefs: null, allowedApplications: null,
    allowedToolNames: null, allowedOperations: null, providerToolRules: matrix };
  const projection = freeze({ policy, revision: schemaFingerprint({ agentRevision: selection.snapshot.agent.revision,
    workflowRevision: selection.workflowRevision, preferenceRevision: selection.snapshot.preferenceRevision,
    choices: selection.snapshot.choices, packages: selection.fingerprint, authorityRevisions,
    standaloneSelections: standalone.selections, unavailable, policy }),
    selectedProviders: unavailable ? [] : [...descriptors.values()], standaloneSelections: standalone.selections, unavailable });
  projections.set(projection, { actorKey: actorKey(context), prepared: unavailable ? [] : prepared,
    requiredTools: unavailable ? [] : [...requirements.values()], requiredProviders: unavailable ? [] : [...requiredProviders.values()],
    associations: unavailable ? [] : [...associations.values()], unavailable });
  return projection;
}

/** JSON clones and another session cannot attach a workflow's personal provider authority. */
export function attachAgentWorkflowRuntimeProjection(context: IntegrationExecutionContext, projection: AgentWorkflowRuntimeProjection | null | undefined): void {
  if (!projection) return;
  const proof = projections.get(projection);
  if (!proof || proof.actorKey !== actorKey(context) || !context.policyRevision.trim()) return deny();
  attachPersonalWorkflowProviderTargets(context, proof.prepared);
  attachWorkflowProviderAssociations(context, proof.associations);
}

/** Required tool existence is readiness only. It never changes the compiled tool grants. */
export async function assertAgentWorkflowRuntimeReady(input: { context: IntegrationExecutionContext; policy: IntegrationPolicy;
  projection?: AgentWorkflowRuntimeProjection | null; signal?: AbortSignal }): Promise<void> {
  if (!input.projection) return;
  const proof = projections.get(input.projection);
  if (!proof || proof.actorKey !== actorKey(input.context) || proof.unavailable) return deny();
  for (const requirement of proof.requiredProviders) {
    input.signal?.throwIfAborted();
    let descriptor: IntegrationProviderDescriptor | null;
    if (requirement.providerRef.includes(':shared:')) {
      const authorization = await findSharedIntegrationConnectionAuthorization(input.context, requirement.providerRef, 'inspect');
      if (!authorization?.access.canUse) return deny();
      descriptor = await createSharedIntegrationPolicyDescriptor(input.context, authorization);
    } else descriptor = getAttachedPersonalWorkflowProviderDescriptor(input.context, requirement.providerRef);
    if (!descriptor || !isIntegrationProviderVisible(input.context, input.policy, descriptor)) return deny();
    const adapter = requirement.source === 'mcp' ? (await import('@/app/lib/integration-tools/adapters/mcp-runtime')).mcpIntegrationToolAdapter
      : (await import('@/app/lib/integration-tools/adapters/composio-runtime')).composioIntegrationToolAdapter;
    const provider = await adapter.resolveProvider(input.context, requirement.providerRef);
    if (!provider.provider.canExecute || !isIntegrationProviderVisible(input.context, input.policy, provider.provider)) return deny();
  }
  for (const requirement of proof.requiredTools) {
    input.signal?.throwIfAborted();
    if (!isIntegrationProviderOperationAllowed(input.policy, requirement.source, requirement.providerRef, 'call')) return deny();
    const allowed = integrationPolicyAllowedToolNames(input.policy, requirement.source, requirement.providerRef);
    if (allowed !== null && requirement.names.some(name => !allowed.includes(name))) return deny();
    if (requirement.providerRef.includes(':shared:')) {
      const authorization = await findSharedIntegrationConnectionAuthorization(input.context, requirement.providerRef, 'use');
      if (!authorization || !isIntegrationProviderVisible(input.context, input.policy,
        await createSharedIntegrationPolicyDescriptor(input.context, authorization))) return deny();
    } else {
      const descriptor = getAttachedPersonalWorkflowProviderDescriptor(input.context, requirement.providerRef);
      if (!descriptor || !isIntegrationProviderVisible(input.context, input.policy, descriptor)) return deny();
    }
    const adapter = requirement.source === 'mcp' ? (await import('@/app/lib/integration-tools/adapters/mcp-runtime')).mcpIntegrationToolAdapter
      : (await import('@/app/lib/integration-tools/adapters/composio-runtime')).composioIntegrationToolAdapter;
    const provider = await adapter.resolveProvider(input.context, requirement.providerRef);
    if (!provider.provider.canExecute || !isIntegrationProviderVisible(input.context, input.policy, provider.provider)) return deny();
    if (requirement.source === 'mcp') {
      const { verifyMcpIntegrationToolsReady } = await import('@/app/lib/integration-tools/adapters/mcp-runtime');
      if (!await verifyMcpIntegrationToolsReady(input.context, provider, requirement.names, input.signal)) return deny();
      continue;
    }
    const found = new Set<string>(); let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await adapter.listTools(input.context, provider, { limit: 50, allowedToolNames: requirement.names, cursor, signal: input.signal });
      for (const tool of page.tools) if (requirement.names.includes(tool.name)) found.add(tool.name);
      if (found.size === requirement.names.length) break;
      if (!page.complete || !page.nextCursor || cursors.has(page.nextCursor)) return deny();
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    if (found.size !== requirement.names.length) return deny();
  }
}
