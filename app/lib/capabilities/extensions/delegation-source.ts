import 'server-only';

import { createHash } from 'node:crypto';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { AgentWorkflowError, agentWorkflowCapabilityKey, type StoredAgentWorkflowTarget } from '@/app/lib/agents/workflow-contracts';
import { getSelectedAgentWorkflowCapability } from '@/app/lib/agents/workflow-configuration';
import { isExplicitAgentWorkflowVersion } from '@/app/lib/agents/workflow-version';
import { isAuthorizedAgentWorkflowPackageSelections, type AuthorizedAgentWorkflowPackageSelections } from '@/app/lib/capabilities/packages/runtime-bindings';
import { readEffectiveExtensionContext, isIssuedScopedIntegrationTurn } from './effective-context';
import { readAcceptedTurnRuntimeSelection, assertPreparedDelegatedExtensionSourceFrame } from './turn-runtime';
import { selectAgentStandaloneExtension } from './standalone-runtime';
import { extensionSelectionIdentity, type ChatExtensionSelection, type StandaloneExtensionSelection } from './contracts';
import { freeze, parseStoredStandaloneExtensionBinding, type StoredStandaloneExtensionBinding } from './stored-contracts';
import type { IntegrationPolicy } from '@/app/lib/integration-tools/contracts';

export type HeldDelegatedExtensionSource = Readonly<{ kind: 'delegated_extension_source'; fingerprint: string }>;
export type DelegatedFixedExtensionBinding = Extract<StoredStandaloneExtensionBinding, { mode: 'fixed' }>;
/** Server-only issued data. Neither these targets nor their snapshots belong in a tool or HTTP DTO. */
export type DelegatedExtensionSourceData = Readonly<{
  parentContext: AgentExecutionContext;
  packageSelection: AuthorizedAgentWorkflowPackageSelections;
  publicSelection: ChatExtensionSelection;
  privateFixedBindings: readonly DelegatedFixedExtensionBinding[];
  parentPolicy: IntegrationPolicy;
}>;
type Record = { namespace: string; data: DelegatedExtensionSourceData };
const host = globalThis as typeof globalThis & { __canvasDelegatedExtensionSourcesV1?: WeakMap<object, Record> };
const records = host.__canvasDelegatedExtensionSourcesV1 ??= new WeakMap<object, Record>();

function denied(): never {
  throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The originating extension context is unavailable for this delegated task.', 403);
}
function namespace(context: AgentExecutionContext): string {
  return JSON.stringify([context.userId, context.sessionId, context.agentId, context.agentTurnId ?? null,
    context.organizationId, context.workspaceId, context.workspaceType, context.workspaceRoot, context.workspaceRootRelativePath,
    context.projectId, context.customerId, context.canWrite, context.canDelete, context.canShare, context.legacy,
    context.turnExtensions ?? null, context.turnExtensionSource?.fingerprint ?? null, context.effectiveExtensions?.fingerprint ?? null]);
}

/** Canonical public identity derives from a stored private target; no routing/account string comes from the model. */
function selectedTarget(target: StoredAgentWorkflowTarget, toolkit?: string): StandaloneExtensionSelection {
  if (target.kind === 'shared') {
    const publicTarget = { kind: 'shared' as const, connectionRef: target.connectionRef, bindingRevision: target.bindingRevision };
    if (target.source === 'mcp') return { kind: 'mcp', source: 'mcp', target: publicTarget };
    if (!toolkit) return denied();
    return { kind: 'composio', source: 'composio', toolkit, target: publicTarget };
  }
  const binding = target.personalBinding;
  if (binding?.source === 'mcp') return { kind: 'mcp', source: 'mcp', target: {
    kind: 'personal', connectionRef: `mcp-personal:${binding.connectionId}` } };
  if (binding?.source === 'composio') return { kind: 'composio', source: 'composio', toolkit: binding.toolkit,
    target: binding.accountBinding === 'no_auth' ? { kind: 'personal', profileId: binding.profileId, accountBinding: 'no_auth' }
      : { kind: 'personal', profileId: binding.profileId, accountBinding: 'account', accountId: binding.connectedAccountId!,
        connectionRef: `composio-personal:${binding.profileId}:${binding.connectedAccountId}` } };
  return denied();
}

/** A pointer issued from actual effective metadata, never a deserialized selection or caller-supplied policy. */
export async function captureDelegatedExtensionSource(contextInput: AgentExecutionContext): Promise<HeldDelegatedExtensionSource | null> {
  const context = { ...contextInput, skillReadRoots: Object.freeze([...(contextInput.skillReadRoots ?? [])]),
    skillPackageBindings: Object.freeze([...(contextInput.skillPackageBindings ?? [])]),
    ...(contextInput.turnExtensions ? { turnExtensions: freeze(structuredClone(contextInput.turnExtensions)) } : {}) };
  const effective = readEffectiveExtensionContext(context);
  const scoped = isIssuedScopedIntegrationTurn(context);
  if (!effective) return scoped ? denied() : null;
  const selection = effective.packageSelection;
  if (!isAuthorizedAgentWorkflowPackageSelections(selection, context)) return denied();
  if (!scoped && !isExplicitAgentWorkflowVersion(selection.workflowVersion)) return null;
  if (!context.agentTurnId?.trim()) return denied();
  const capturedNamespace = namespace(context);
  const { resolveIntegrationRuntimePolicy } = await import('@/app/lib/integration-tools/runtime-policy');
  const { UNRESTRICTED_INTEGRATION_POLICY } = await import('@/app/lib/integration-tools/policy');
  const parentRuntime = await resolveIntegrationRuntimePolicy({ executionContext: context, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
  if (namespace(contextInput) !== capturedNamespace) return denied();
  const bindings = new Map<string, DelegatedFixedExtensionBinding>();
  if (context.turnExtensionSource) for (const binding of readAcceptedTurnRuntimeSelection(context.turnExtensionSource, context, selection).privateFixedBindings) {
    bindings.set(extensionSelectionIdentity(binding.entry.selection), binding);
  }
  const projection = effective.workflowProjection;
  const add = (configurationId: string, target: StoredAgentWorkflowTarget, chosen: StandaloneExtensionSelection,
    required: boolean) => {
    const provider = projection?.selectedProviders.find(value => target.kind === 'shared'
      ? value.scope.resourceId === target.connectionRef && value.source === target.source : value.providerRef === target.boundProviderRef);
    const rule = provider && projection?.policy.providerToolRules?.find(value => value.providerRef === provider.providerRef && value.source === provider.source);
    if (!rule) return;
    const key = extensionSelectionIdentity(chosen), previous = bindings.get(key);
    if (previous && JSON.stringify(previous.entry.selection) !== JSON.stringify(chosen)) return denied();
    const privateTarget = target.kind === 'shared' ? { kind: 'shared', source: target.source,
      connectionRef: target.connectionRef, bindingRevision: target.bindingRevision } : target;
    const result = parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId, mode: 'fixed',
      entry: { selection: chosen, target: privateTarget, requirement: required || previous?.entry.requirement === 'required' ? 'required' : 'optional',
        // The actual compiler has already unioned permanent declarations and
        // intersected an explicit turn cap. Reintersecting individual slot caps
        // here would incorrectly erase permitted tools shared by two slots.
        toolCap: rule.allowedToolNames } });
    if (result.mode !== 'fixed') return denied();
    bindings.set(key, result);
  };
  if (isExplicitAgentWorkflowVersion(selection.workflowVersion)) {
    for (const pkg of selection.packages) for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
      const chosen = getSelectedAgentWorkflowCapability(selection.snapshot, pkg, declaration, capability);
      if (!chosen) continue;
      const alternative = capability.alternatives.find(value => `${value.source}:${value.source === 'mcp' ? value.connector : value.toolkit}` === chosen.alternativeKey);
      if (!alternative || alternative.source !== chosen.target.source) return denied();
      add(agentWorkflowCapabilityKey(pkg.resourceRef, declaration.declarationPath, capability.capabilityId), chosen.target,
        selectedTarget(chosen.target, alternative.source === 'composio' ? alternative.toolkit : undefined), capability.required);
    }
    for (const binding of selection.snapshot.bindings) if (binding.resourceType === 'connection') {
      if (!binding.standaloneConfiguration) return denied();
      const chosen = selectAgentStandaloneExtension(binding.standaloneConfiguration, selection.snapshot, context.userId);
      if (chosen.choice) add(chosen.configurationId, chosen.choice.target, chosen.choice.selection, chosen.required);
    }
  }
  const publicSelection = freeze(structuredClone(context.turnExtensions ?? { version: 1 as const, origin: 'turn_reference' as const, selections: [] }));
  const captured = Object.freeze(context);
  const data = Object.freeze({ parentContext: captured, packageSelection: selection, publicSelection,
    privateFixedBindings: Object.freeze([...bindings.values()]), parentPolicy: freeze(structuredClone(parentRuntime.policy)) });
  const sourceNamespace = namespace(context);
  const fingerprint = createHash('sha256').update(JSON.stringify([sourceNamespace, selection.fingerprint,
    projection?.revision ?? null, data.privateFixedBindings, data.parentPolicy])).digest('hex');
  const source = Object.freeze({ kind: 'delegated_extension_source' as const, fingerprint });
  records.set(source, { namespace: sourceNamespace, data });
  return source;
}

/** Internal metadata admission only. Fresh parent, child, task and provider authority remain mandatory. */
export function readDelegatedExtensionSource(source: HeldDelegatedExtensionSource,
  expectedParent?: AgentExecutionContext): DelegatedExtensionSourceData {
  const record = source && typeof source === 'object' ? records.get(source) : undefined;
  if (!record || namespace(record.data.parentContext) !== record.namespace
    || expectedParent && (namespace(expectedParent) !== record.namespace
      || expectedParent.effectiveExtensions !== record.data.parentContext.effectiveExtensions
      || expectedParent.turnExtensionSource !== record.data.parentContext.turnExtensionSource)) return denied();
  const effective = readEffectiveExtensionContext(record.data.parentContext);
  if (!effective || effective.packageSelection !== record.data.packageSelection
    || !isAuthorizedAgentWorkflowPackageSelections(record.data.packageSelection, record.data.parentContext)) return denied();
  if (record.data.parentContext.turnExtensionSource) readAcceptedTurnRuntimeSelection(record.data.parentContext.turnExtensionSource,
    record.data.parentContext, record.data.packageSelection);
  return record.data;
}

export function readDelegatedExtensionParentContext(source: HeldDelegatedExtensionSource): AgentExecutionContext {
  return readDelegatedExtensionSource(source).parentContext;
}

export function readDelegatedExtensionPublicSelection(source: HeldDelegatedExtensionSource): ChatExtensionSelection {
  return structuredClone(readDelegatedExtensionSource(source).publicSelection);
}

/** Original package pins are admitted only through an actual child preparation frame, then fresh child resource-use checks. */
export function readDelegatedExtensionPackageSource(source: HeldDelegatedExtensionSource,
  childContext: AgentExecutionContext): { selection: AuthorizedAgentWorkflowPackageSelections; context: AgentExecutionContext } | null {
  const data = readDelegatedExtensionSource(source);
  assertPreparedDelegatedExtensionSourceFrame(source, childContext);
  return { selection: data.packageSelection, context: data.parentContext };
}
