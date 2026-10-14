import 'server-only';

import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import type { AgentWorkflowInternalSnapshot } from '@/app/lib/agents/workflow-contracts';
import type { HeldAgentWorkflowPackageTurnFocus } from '@/app/lib/agents/workflow-runtime';
import { agentWorkflowRuntimeActor } from '@/app/lib/agents/workflow-runtime-mode';
import {
  isAuthorizedAgentWorkflowPackageSelections,
  type AuthorizedAgentWorkflowPackageSelections,
} from '@/app/lib/capabilities/packages/runtime-bindings';
import {
  IntegrationContractError,
  type IntegrationExecutionContext,
  type IntegrationProviderDescriptor,
} from '@/app/lib/integration-tools/contracts';
import { authorizeIntegrationConnection, revalidateAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { createSharedIntegrationPolicyDescriptor } from '@/app/lib/integration-tools/connections/provider-policy';
import {
  attachPersonalWorkflowProviderTargets,
  getPreparedPersonalWorkflowProviderTarget,
  verifyStoredPersonalWorkflowProviderTarget,
  type PreparedPersonalWorkflowProviderTarget,
} from '@/app/lib/integration-tools/workflow-personal-bindings';
import { getAttachedPersonalWorkflowProviderDescriptor } from '@/app/lib/integration-tools/workflow-personal-provenance';
import { extensionSelectionIdentity, type StandaloneExtensionSelection } from './contracts';
import { createStandaloneExtensionSlotRef } from './standalone-reference';
import {
  freeze,
  parseStoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionTarget,
} from './stored-contracts';
import { readAcceptedTurnRuntimeSelection, type HeldAcceptedTurnRuntimeSelection } from './turn-runtime';

type StandaloneChoice = {
  selection: StandaloneExtensionSelection;
  target: StoredStandaloneExtensionTarget;
  toolCap: readonly string[] | null;
};
export type SelectedAgentStandaloneExtension = Readonly<{
  configurationId: string;
  slotRef: string;
  source: 'mcp' | 'composio';
  required: boolean;
  origin: 'fixed' | 'default' | 'user' | 'turn' | 'stale' | 'missing';
  choice: StandaloneChoice | null;
}>;
export type AgentStandaloneRuntimeSelection = Readonly<{
  configurationId: string;
  slotRef: string;
  source: 'mcp' | 'composio';
  required: boolean;
  origin: SelectedAgentStandaloneExtension['origin'];
  state: 'selected' | 'missing' | 'stale' | 'unavailable';
  selection?: StandaloneExtensionSelection;
  providerRef?: string;
}>;
export type AgentStandaloneRuntimeProvider = Readonly<{
  selected: SelectedAgentStandaloneExtension;
  descriptor: IntegrationProviderDescriptor;
  toolCap: readonly string[] | null;
  authorityRevision: string;
  personalProof?: PreparedPersonalWorkflowProviderTarget;
}>;
export type AgentStandaloneRuntimeProviders = Readonly<{
  providers: readonly AgentStandaloneRuntimeProvider[];
  selections: readonly AgentStandaloneRuntimeSelection[];
  unavailable: boolean;
}>;

function denied(): never {
  throw new IntegrationContractError('provider_denied', 'The configured standalone extensions cannot be verified in this agent session.');
}

/** Selection syntax only. The provider resolver additionally requires an issued, actor-bound package snapshot. */
export function selectAgentStandaloneExtension(configuration: StoredStandaloneExtensionBinding,
  snapshot: Pick<AgentWorkflowInternalSnapshot, 'agent' | 'workflowRevision' | 'choices'>,
  currentUserId: string): SelectedAgentStandaloneExtension {
  const config = parseStoredStandaloneExtensionBinding(configuration);
  const source = config.mode === 'fixed' ? config.entry.selection.source : config.source;
  const toolkit = config.mode === 'fixed'
    ? config.entry.selection.kind === 'composio' ? config.entry.selection.toolkit : undefined : config.toolkit;
  const slotRef = createStandaloneExtensionSlotRef({ configurationId: config.configurationId, source,
    ...(toolkit === undefined ? {} : { toolkit }) });
  const base = { configurationId: config.configurationId, slotRef, source,
    required: (config.mode === 'fixed' ? config.entry.requirement : config.requirement) === 'required' };
  const empty = (origin: 'stale' | 'missing') => freeze({ ...base, origin, choice: null });
  const centralChoice = (choice: StandaloneChoice, origin: 'fixed' | 'default' | 'user'): SelectedAgentStandaloneExtension => {
    if (choice.target.kind === 'personal' && (choice.target.ownerUserId !== currentUserId
      || snapshot.agent.scopeType === 'organization')) return empty('stale');
    return freeze({ ...base, origin, choice });
  };
  if (config.mode === 'fixed') return centralChoice(config.entry, 'fixed');
  const preference = snapshot.choices[slotRef];
  if (preference !== undefined) {
    if (!preference || preference.workflowRevision !== snapshot.workflowRevision) return empty('stale');
    if (preference.choiceId !== undefined) {
      if (preference.personalTarget !== undefined || preference.standaloneSelection !== undefined) return empty('stale');
      const choice = config.allowedChoices.find(entry => entry.choiceId === preference.choiceId);
      return choice ? centralChoice(choice, 'user') : empty('stale');
    }
    const policy = config.personalPolicy, target = preference.personalTarget, selection = preference.standaloneSelection;
    if (!policy || !selection || !target || target.kind !== 'personal' || target.ownerUserId !== currentUserId
      || selection.target.kind !== 'personal' || selection.source !== policy.source
      || policy.source === 'composio' && (selection.kind !== 'composio' || selection.toolkit !== policy.toolkit)
      || policy.source === 'mcp' && (target.personalBinding?.source !== 'mcp'
        || !target.personalBinding.serverDefinitionId || !policy.serverDefinitionIds.includes(target.personalBinding.serverDefinitionId))) {
      return empty('stale');
    }
    try {
      const checked = parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: config.configurationId,
        mode: 'fixed', entry: { selection, target, requirement: config.requirement, toolCap: policy.toolCap } });
      if (checked.mode !== 'fixed') return empty('stale');
      return freeze({ ...base, origin: 'user' as const, choice: checked.entry });
    } catch {
      return empty('stale');
    }
  }
  const selectedDefault = config.allowedChoices.find(choice => choice.choiceId === config.defaultChoiceId);
  return selectedDefault ? centralChoice(selectedDefault, 'default') : empty('missing');
}

function integrationContext(context: AgentExecutionContext): IntegrationExecutionContext {
  return { actorUserId: context.userId, organizationId: context.organizationId, workspaceId: context.workspaceId,
    agentId: context.agentId, sessionId: context.sessionId, policyRevision: 'agent-workflow-selection' };
}

function intersectToolCaps(left: readonly string[] | null, right: readonly string[] | null): readonly string[] | null {
  return left === null ? right === null ? null : [...right] : right === null ? [...left] : left.filter(name => right.includes(name));
}

function exactSelection(left: StandaloneExtensionSelection, right: StandaloneExtensionSelection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A turn may choose a permitted slot without changing its stored preference. */
function focusConfiguredSlot(configuration: StoredStandaloneExtensionBinding,
  entry: Extract<StoredStandaloneExtensionBinding, { mode: 'fixed' }>['entry'],
  snapshot: AgentWorkflowInternalSnapshot, userId: string): SelectedAgentStandaloneExtension | null {
  const config = parseStoredStandaloneExtensionBinding(configuration);
  let choice: StandaloneChoice;
  if (config.mode === 'fixed') {
    if (!exactSelection(config.entry.selection, entry.selection)) return null;
    if (config.entry.target.kind === 'personal' && (config.entry.target.ownerUserId !== userId || snapshot.agent.scopeType === 'organization')) return null;
    choice = { ...config.entry, toolCap: intersectToolCaps(config.entry.toolCap, entry.toolCap) };
  } else {
    if (entry.selection.source !== config.source || entry.selection.kind === 'composio' && entry.selection.toolkit !== config.toolkit) return null;
    const configuredChoice = config.allowedChoices.find(candidate => exactSelection(candidate.selection, entry.selection));
    if (configuredChoice) {
      if (configuredChoice.target.kind === 'personal' && (configuredChoice.target.ownerUserId !== userId
        || snapshot.agent.scopeType === 'organization')) return null;
      // Keep the actual configured target, including its revision/fingerprint.
      // An accepted turn is not permission to silently repair a stale binding.
      choice = { ...configuredChoice, toolCap: intersectToolCaps(configuredChoice.toolCap, entry.toolCap) };
    } else {
      const policy = config.personalPolicy, target = entry.target;
      if (!policy || target.kind !== 'personal' || target.ownerUserId !== userId || entry.selection.target.kind !== 'personal'
        || policy.source !== entry.selection.source || policy.source === 'composio'
          && (entry.selection.kind !== 'composio' || entry.selection.toolkit !== policy.toolkit)
        || policy.source === 'mcp' && (target.personalBinding.source !== 'mcp' || !target.personalBinding.serverDefinitionId
          || !policy.serverDefinitionIds.includes(target.personalBinding.serverDefinitionId))) return null;
      choice = { ...entry, toolCap: intersectToolCaps(policy.toolCap, entry.toolCap) };
    }
  }
  const base = selectAgentStandaloneExtension(config, snapshot, userId);
  return freeze({ ...base, origin: 'turn' as const,
    required: base.required || entry.requirement === 'required', choice });
}

/**
 * Metadata eligibility for a freshly verified parent-holder entry. This does not
 * issue source authority or resolve a provider. The caller must retain the real
 * parent provenance and independently revalidate the exact source for the child.
 */
export function getConfiguredStandaloneTurnFocus(context: AgentExecutionContext,
  packageSelection: AuthorizedAgentWorkflowPackageSelections,
  entry: Extract<StoredStandaloneExtensionBinding, { mode: 'fixed' }>['entry']): SelectedAgentStandaloneExtension | null {
  if (!isAuthorizedAgentWorkflowPackageSelections(packageSelection, context)) return denied();
  if (packageSelection.workflowVersion !== 2) return null;
  const matches: SelectedAgentStandaloneExtension[] = [];
  for (const binding of packageSelection.snapshot.bindings) {
    if (binding.resourceType !== 'connection') continue;
    if (!binding.standaloneConfiguration) return denied();
    const selected = focusConfiguredSlot(binding.standaloneConfiguration, entry, packageSelection.snapshot, context.userId);
    // Same public account/connection identity cannot replace the actual stored
    // fingerprint, owner, definition, source mode or shared binding revision.
    if (selected?.choice && JSON.stringify(selected.choice.target) === JSON.stringify(entry.target)) matches.push(selected);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function resolveSelectedProvider(context: AgentExecutionContext,
  selected: SelectedAgentStandaloneExtension): Promise<AgentStandaloneRuntimeProvider> {
  const choice = selected.choice;
  if (!choice) return denied();
  const actor = agentWorkflowRuntimeActor(context), target = choice.target;
  const currentContext = integrationContext(context);
  if (target.kind === 'shared') {
    const authorization = await authorizeIntegrationConnection({ userId: actor.userId, organizationId: actor.organizationId,
      workspaceId: actor.workspaceId, agentId: context.agentId, sessionId: context.sessionId,
      policyRevision: currentContext.policyRevision }, target.connectionRef, 'inspect');
    if (!authorization.access.canUse || authorization.resource.status !== 'active' || authorization.resource.source !== target.source
      || authorization.resource.bindingRevision !== target.bindingRevision
      || choice.selection.kind === 'composio' && (authorization.backend.source !== 'composio'
        || authorization.backend.toolkit !== choice.selection.toolkit || authorization.backend.accountBinding === 'pending')) return denied();
    const descriptor = await createSharedIntegrationPolicyDescriptor(currentContext, authorization);
    const actual = await revalidateAuthorizedIntegrationConnection(authorization, 'inspect');
    const toolCap = choice.toolCap === null ? actual.allowedToolNames
      : actual.allowedToolNames === null ? [...choice.toolCap] : choice.toolCap.filter(name => actual.allowedToolNames!.includes(name));
    return freeze({ selected, descriptor, toolCap, authorityRevision: actual.authorizationRevision });
  }
  if (target.ownerUserId !== actor.userId) return denied();
  const proof = await verifyStoredPersonalWorkflowProviderTarget({ actor, target: { binding: target.personalBinding,
    baseProviderRef: target.providerRef, boundProviderRef: target.boundProviderRef, bindingFingerprint: target.bindingFingerprint } },
  { checkProviderReadiness: false });
  const actual = getPreparedPersonalWorkflowProviderTarget(proof);
  attachPersonalWorkflowProviderTargets(currentContext, [proof]);
  const descriptor = getAttachedPersonalWorkflowProviderDescriptor(currentContext, actual.boundProviderRef);
  if (!descriptor || descriptor.source !== target.source || descriptor.providerRef !== actual.boundProviderRef) return denied();
  return freeze({ selected, descriptor, toolCap: choice.toolCap, authorityRevision: actual.bindingFingerprint, personalProof: proof });
}

/**
 * Resolve only stored selections from the same actual actor/session-issued package snapshot.
 * Initial compilation reads local identity/permission metadata; it never probes accounts or tools.
 */
export async function resolveAgentStandaloneRuntimeProviders(context: AgentExecutionContext,
  packageSelection: AuthorizedAgentWorkflowPackageSelections,
  options: { skipProviderResolution?: boolean; turnSource?: HeldAcceptedTurnRuntimeSelection;
    packageFocus?: HeldAgentWorkflowPackageTurnFocus } = {}): Promise<AgentStandaloneRuntimeProviders> {
  if (!isAuthorizedAgentWorkflowPackageSelections(packageSelection, context)) return denied();
  const turn = options.turnSource ? readAcceptedTurnRuntimeSelection(options.turnSource, context, packageSelection) : null;
  let packageFocusedIdentities: readonly string[] = [];
  if (options.packageFocus) {
    if (!options.turnSource) return denied();
    const { readAgentWorkflowPackageTurnFocus } = await import('@/app/lib/agents/workflow-runtime');
    packageFocusedIdentities = readAgentWorkflowPackageTurnFocus(options.packageFocus, context, packageSelection, options.turnSource);
  }
  const configurations = packageSelection.workflowVersion === 2 ? packageSelection.snapshot.bindings.filter(binding => binding.resourceType === 'connection')
    .map(binding => {
      if (!binding.standaloneConfiguration) return denied();
      return binding.standaloneConfiguration;
    }) : [];
  const configured = configurations.map(config => selectAgentStandaloneExtension(config, packageSelection.snapshot, context.userId));
  const focusedSlots = new Set<number>();
  for (const binding of turn?.privateFixedBindings ?? []) {
    // Only the actual package compiler can issue this paired exception. The
    // aggregate retains that provider and applies the turn cap after its union.
    if (packageFocusedIdentities.includes(extensionSelectionIdentity(binding.entry.selection))) continue;
    if (packageSelection.workflowVersion === null) {
      // Legacy/native tool ceilings remain outside this finite metadata selection.
      const entry = binding.entry;
      if (entry.target.kind === 'personal' && entry.target.ownerUserId !== context.userId) return denied();
      configured.push(freeze({ configurationId: binding.configurationId, source: entry.selection.source,
        slotRef: createStandaloneExtensionSlotRef({ configurationId: binding.configurationId, source: entry.selection.source,
          ...(entry.selection.kind === 'composio' ? { toolkit: entry.selection.toolkit } : {}) }),
        required: entry.requirement === 'required', origin: 'turn' as const,
        choice: { selection: entry.selection, target: entry.target, toolCap: entry.toolCap } }));
      continue;
    }
    const candidates = configurations.map((config, index) => ({ index,
      selected: focusConfiguredSlot(config, binding.entry, packageSelection.snapshot, context.userId) }))
      .filter(candidate => candidate.selected !== null);
    if (candidates.length !== 1 || focusedSlots.has(candidates[0].index)) return denied();
    focusedSlots.add(candidates[0].index);
    configured[candidates[0].index] = candidates[0].selected!;
  }
  const summaries: AgentStandaloneRuntimeSelection[] = configured.map(selected => ({ configurationId: selected.configurationId,
    slotRef: selected.slotRef, source: selected.source, required: selected.required, origin: selected.origin,
    state: selected.choice ? 'selected' : selected.origin === 'stale' ? 'stale' : 'missing',
    ...(selected.choice ? { selection: selected.choice.selection } : {}) }));
  // A missing required choice is known from SQL. Do not inspect unrelated providers to discover it.
  if (configured.some(selected => selected.required && !selected.choice)) {
    return freeze({ providers: [], selections: summaries, unavailable: true });
  }
  if (options.skipProviderResolution) return freeze({ providers: [], selections: summaries, unavailable: false });
  const providers: AgentStandaloneRuntimeProvider[] = [];
  let unavailable = false;
  for (let index = 0; index < configured.length; index += 1) {
    const selected = configured[index];
    if (!selected.choice) continue;
    try {
      const provider = await resolveSelectedProvider(context, selected);
      providers.push(provider);
      summaries[index] = { ...summaries[index], providerRef: provider.descriptor.providerRef };
    } catch {
      summaries[index] = { ...summaries[index], state: 'unavailable' };
      if (selected.required) unavailable = true;
    }
  }
  return freeze({ providers: unavailable ? [] : providers, selections: summaries, unavailable });
}
