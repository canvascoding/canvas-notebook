import 'server-only';

import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import type { AgentWorkflowInternalSnapshot } from '@/app/lib/agents/workflow-contracts';
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
import type { StandaloneExtensionSelection } from './contracts';
import { createStandaloneExtensionSlotRef } from './standalone-reference';
import {
  freeze,
  parseStoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionTarget,
} from './stored-contracts';

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
  origin: 'fixed' | 'default' | 'user' | 'stale' | 'missing';
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
  options: { skipProviderResolution?: boolean } = {}): Promise<AgentStandaloneRuntimeProviders> {
  if (!isAuthorizedAgentWorkflowPackageSelections(packageSelection, context)) return denied();
  if (packageSelection.workflowVersion !== 2) return freeze({ providers: [], selections: [], unavailable: false });
  const configured = packageSelection.snapshot.bindings.filter(binding => binding.resourceType === 'connection')
    .map(binding => {
      if (!binding.standaloneConfiguration) return denied();
      return selectAgentStandaloneExtension(binding.standaloneConfiguration, packageSelection.snapshot, context.userId);
    });
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
