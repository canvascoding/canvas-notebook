import 'server-only';

import { getAgentExecutionContext, type AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { requireDelegationSource } from '@/app/lib/pi/delegation-policy';
import { readIntegrationToolGatewayAvailability } from '@/app/lib/integration-tool-gateway-availability';
import { IntegrationContractError, type IntegrationExecutionContext, type IntegrationPolicy, type IntegrationToolSchema } from './contracts';
import { resolveIntegrationExecutionContext, resolveRuntimeIntegrationExecutionContext } from './context';
import { integrationDispatcher, type IntegrationDispatcher } from './dispatcher';
import {
  parseIntegrationBindingSelections, readPrivateDelegatedIntegrationSnapshot,
  type IntegrationBindingSelection, type IntegrationDelegationTaskBinding, type PrivateDelegatedIntegrationSnapshot,
} from './delegation-contracts';
import { resolveIntegrationDelegationTaskBinding, resolveIntegrationRuntimePolicy } from './runtime-policy';
import { UNRESTRICTED_INTEGRATION_POLICY } from './policy';
import { schemaFingerprint } from './schema';
import { isIntegrationTurnUncertain } from './uncertain-turns';
import { isPersistedIntegrationTurnUncertain } from './uncertain-turn-store';
import { getRuntimeAgentWorkflowMode } from '@/app/lib/agents/workflow-runtime-mode';
import { isExplicitAgentWorkflowVersion } from '@/app/lib/agents/workflow-version';
import { isIssuedScopedIntegrationTurn } from '@/app/lib/capabilities/extensions/effective-context';
import { readDelegatedTurnRuntimeParentSource } from '@/app/lib/capabilities/extensions/turn-runtime';
import { readDelegatedExtensionParentContext } from '@/app/lib/capabilities/extensions/delegation-source';
import { attachAgentWorkflowRuntimeProjection } from '@/app/lib/agents/workflow-runtime';
import { transferPersonalWorkflowProviderTargets } from './workflow-personal-bindings';
import { transferWorkflowProviderAssociations } from './workflow-provider-associations';

function reject(code: 'provider_denied' | 'schema_changed' = 'provider_denied'): never {
  throw new IntegrationContractError(code, 'The approved integration binding changed or is unavailable. Ask the delegating agent to refresh it.');
}

async function parentAuthority(input: {
  actorUserId: string; sessionId: string; agentId: string; ceiling: IntegrationPolicy; executionContext?: AgentExecutionContext;
}) {
  if (input.executionContext && (input.executionContext.userId !== input.actorUserId
    || input.executionContext.sessionId !== input.sessionId || input.executionContext.agentId !== input.agentId)) reject();
  const stored = input.executionContext ? { executionContext: input.executionContext }
    : await resolveIntegrationExecutionContext({ ...input, policyRevision: 'integration-handoff-preflight' });
  const resolved = await resolveRuntimeIntegrationExecutionContext({ executionContext: stored.executionContext, policyRevision: 'integration-handoff-preflight' });
  const runtimePolicy = await resolveIntegrationRuntimePolicy({ executionContext: resolved.executionContext, ceiling: input.ceiling });
  const context = { ...resolved.integrationContext, policyRevision: runtimePolicy.policyRevision };
  if (runtimePolicy.workflowProjection) attachAgentWorkflowRuntimeProjection(context, runtimePolicy.workflowProjection);
  return { executionContext: resolved.executionContext,
    context, policy: runtimePolicy.policy };
}

async function requireHandoffGateway(context?: AgentExecutionContext): Promise<void> {
  // This validates issued provenance even when the global preference is on.
  const scoped = context ? isIssuedScopedIntegrationTurn(context) : false;
  const fixed = context ? isExplicitAgentWorkflowVersion(await getRuntimeAgentWorkflowMode(context)) : false;
  if (!scoped && !fixed && !readIntegrationToolGatewayAvailability().integrationToolGatewayEnabled) reject();
}

/** Only opaque issued references are selectable. No schema, slug, URL or provider identity comes from the model. */
export async function captureDelegatedIntegrationBindings(input: {
  actorUserId: string;
  sourceSessionId: string;
  sourceAgentId: string;
  selections?: readonly IntegrationBindingSelection[];
  dispatcher?: IntegrationDispatcher;
  signal?: AbortSignal;
}): Promise<PrivateDelegatedIntegrationSnapshot | null> {
  const actorUserId = input.actorUserId;
  const sourceSessionId = input.sourceSessionId;
  const sourceAgentId = input.sourceAgentId;
  const selections = parseIntegrationBindingSelections(input.selections);
  const dispatcher = input.dispatcher ?? integrationDispatcher;
  const signal = input.signal;
  const ambient = getAgentExecutionContext();
  const issuingContext = ambient ? { ...ambient } : undefined;
  if (selections.length === 0) return null;
  if (issuingContext && (issuingContext.userId !== actorUserId || issuingContext.sessionId !== sourceSessionId
    || issuingContext.agentId !== sourceAgentId)) reject();
  if (issuingContext && (isIntegrationTurnUncertain(issuingContext) || await isPersistedIntegrationTurnUncertain(issuingContext))) {
    throw new IntegrationContractError('outcome_unknown', 'The originating turn has an uncertain external result. Do not delegate another attempt.');
  }
  await requireHandoffGateway(issuingContext);
  signal?.throwIfAborted();
  await requireDelegationSource({ userId: actorUserId, sourceSessionId, sourceAgentId });
  const authority = await parentAuthority({ actorUserId, sessionId: sourceSessionId, agentId: sourceAgentId,
    ceiling: UNRESTRICTED_INTEGRATION_POLICY, executionContext: issuingContext });
  if (issuingContext && (issuingContext.workspaceId !== authority.executionContext.workspaceId
    || issuingContext.organizationId !== authority.executionContext.organizationId)) reject();
  const bindings = [];
  for (const selection of selections) bindings.push(await dispatcher.exportDelegatedComposioSchema({ ...authority, selection, signal }));
  const confirmed = await parentAuthority({ actorUserId, sessionId: sourceSessionId, agentId: sourceAgentId,
    ceiling: authority.policy, executionContext: authority.executionContext });
  if (schemaFingerprint(confirmed.context) !== schemaFingerprint(authority.context)
    || schemaFingerprint(confirmed.policy) !== schemaFingerprint(authority.policy)) reject('schema_changed');
  if (issuingContext && (isIntegrationTurnUncertain(issuingContext) || await isPersistedIntegrationTurnUncertain(issuingContext))) {
    throw new IntegrationContractError('outcome_unknown', 'The originating turn has an uncertain external result. Do not delegate another attempt.');
  }
  return readPrivateDelegatedIntegrationSnapshot({ version: 1, parent: {
    actorUserId, sessionId: sourceSessionId, agentId: sourceAgentId,
    organizationId: authority.context.organizationId ?? null, workspaceId: authority.executionContext.workspaceId,
    policyRevision: authority.context.policyRevision, policy: authority.policy,
    agentTurnId: issuingContext?.agentTurnId ?? null,
  }, bindings });
}

/** Rebuild exact task-bound references from approved metadata; never broadens the worker's current policy. */
export async function prepareDelegatedIntegrationBindings(input: {
  executionContext: AgentExecutionContext;
  context: IntegrationExecutionContext;
  policy: IntegrationPolicy;
  delegation: IntegrationDelegationTaskBinding | null;
  dispatcher?: IntegrationDispatcher;
  signal?: AbortSignal;
}): Promise<readonly IntegrationToolSchema[]> {
  const executionContext = { ...input.executionContext };
  const context = { ...input.context };
  transferPersonalWorkflowProviderTargets(input.context, context);
  transferWorkflowProviderAssociations(input.context, context);
  const policy = structuredClone(input.policy);
  const delegation = input.delegation ? { ...input.delegation } : null;
  const dispatcher = input.dispatcher ?? integrationDispatcher;
  const signal = input.signal;
  if (!delegation || delegation.integrationBindingsJson === null) return [];
  await requireHandoffGateway(executionContext);
  if (context.actorUserId !== executionContext.userId || context.sessionId !== executionContext.sessionId
    || context.agentId !== executionContext.agentId || context.workspaceId !== executionContext.workspaceId
    || (context.organizationId ?? null) !== (executionContext.organizationId ?? null)) reject();
  const snapshot = readPrivateDelegatedIntegrationSnapshot(delegation.integrationBindingsJson);
  if (snapshot.parent.actorUserId !== executionContext.userId || delegation.userId !== executionContext.userId
    || snapshot.parent.sessionId !== delegation.sourceSessionId || snapshot.parent.agentId !== delegation.sourceAgentId
    || snapshot.parent.workspaceId !== executionContext.workspaceId
    || snapshot.parent.organizationId !== (executionContext.organizationId ?? null)
    || delegation.workerSessionId !== executionContext.sessionId) reject();
  if (delegation.sourceAgentTurnId !== null && snapshot.parent.agentTurnId !== delegation.sourceAgentTurnId) reject();
  const parentTurn = { userId: snapshot.parent.actorUserId, sessionId: snapshot.parent.sessionId,
    agentId: snapshot.parent.agentId, workspaceId: snapshot.parent.workspaceId, agentTurnId: snapshot.parent.agentTurnId ?? undefined };

  const checkAuthority = async () => {
    signal?.throwIfAborted();
    await requireHandoffGateway(executionContext);
    if (isIntegrationTurnUncertain(parentTurn) || await isPersistedIntegrationTurnUncertain(parentTurn)) {
      throw new IntegrationContractError('outcome_unknown', 'The originating turn has an uncertain external result. Do not execute a delegated attempt.');
    }
    const currentTask = await resolveIntegrationDelegationTaskBinding(executionContext);
    if (!currentTask || schemaFingerprint(currentTask) !== schemaFingerprint(delegation)) reject();
    await requireDelegationSource({ userId: executionContext.userId,
      sourceSessionId: delegation.sourceSessionId, sourceAgentId: delegation.sourceAgentId });
    const source = readDelegatedTurnRuntimeParentSource(executionContext, delegation.id);
    const parent = await parentAuthority({ actorUserId: executionContext.userId, sessionId: delegation.sourceSessionId,
      agentId: delegation.sourceAgentId, ceiling: snapshot.parent.policy,
      ...(source ? { executionContext: readDelegatedExtensionParentContext(source) } : {}) });
    if (parent.context.policyRevision !== snapshot.parent.policyRevision
      || schemaFingerprint(parent.policy) !== schemaFingerprint(snapshot.parent.policy)
      || parent.context.workspaceId !== snapshot.parent.workspaceId
      || (parent.context.organizationId ?? null) !== snapshot.parent.organizationId) reject('schema_changed');
    const child = await resolveRuntimeIntegrationExecutionContext({ executionContext, policyRevision: context.policyRevision });
    const childPolicy = await resolveIntegrationRuntimePolicy({ executionContext: child.executionContext, ceiling: policy });
    if (childPolicy.policyRevision !== context.policyRevision
      || schemaFingerprint(childPolicy.policy) !== schemaFingerprint(policy)) reject('schema_changed');
    return parent;
  };

  const parent = await checkAuthority();
  // Export reuses the parent's exact approved metadata. Its reference cache may
  // expire while a queued task waits, so verify the persisted snapshot directly
  // under describe rights and reissue only in the child's namespace.
  const schemas: IntegrationToolSchema[] = [];
  for (const binding of snapshot.bindings) {
    await dispatcher.verifyDelegatedComposioSchema({ context: parent.context, policy: parent.policy, binding, operation: 'describe', signal });
    schemas.push(await dispatcher.seedDelegatedComposioSchema({ context, policy, binding, signal }));
  }
  await checkAuthority();
  return schemas;
}

/** Used only after the child session is persisted and its task is running. */
export async function prepareIntegrationBindingsForDelegatedRuntime(input: {
  executionContext: AgentExecutionContext;
  dispatcher?: IntegrationDispatcher;
  signal?: AbortSignal;
}): Promise<readonly IntegrationToolSchema[]> {
  const resolved = await resolveRuntimeIntegrationExecutionContext({ executionContext: input.executionContext, policyRevision: 'integration-handoff-preflight' });
  const current = await resolveIntegrationRuntimePolicy({ executionContext: resolved.executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
  const context = { ...resolved.integrationContext, policyRevision: current.policyRevision };
  if (current.workflowProjection) attachAgentWorkflowRuntimeProjection(context, current.workflowProjection);
  return prepareDelegatedIntegrationBindings({ executionContext: resolved.executionContext,
    context, policy: current.policy,
    delegation: current.delegation, dispatcher: input.dispatcher, signal: input.signal });
}
