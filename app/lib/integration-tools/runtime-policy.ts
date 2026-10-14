import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { resolveAgentRuntimeSettings } from '@/app/lib/agents/effective-runtime-config';
import type { AgentWorkflowRuntimeProjection } from '@/app/lib/agents/workflow-runtime';
import { getRuntimeAgentWorkflowMode } from '@/app/lib/agents/workflow-runtime-mode';
import { isExplicitAgentWorkflowVersion } from '@/app/lib/agents/workflow-version';
import { isIssuedScopedIntegrationTurn } from '@/app/lib/capabilities/extensions/effective-context';
import { db } from '@/app/lib/db';
import { piDelegations, piSessions } from '@/app/lib/db/schema';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { getDelegatedWorkerToolsets } from '@/app/lib/pi/delegation-policy';
import { getDefaultEnabledToolNames, isLegacyEnabledToolsValue, resolveEnabledToolNames } from '@/app/lib/pi/enabled-tools';
import { resolveDelegatedWorkerToolNames } from '@/app/lib/pi/toolsets';
import { IntegrationContractError, type IntegrationPolicy } from './contracts';
import { createIntegrationPolicyFromLegacyTools, INTEGRATION_LEGACY_CAPABILITY_NAMES, intersectIntegrationPolicies } from './policy';
import { schemaFingerprint } from './schema';
import type { IntegrationDelegationTaskBinding } from './delegation-contracts';

export type ResolvedIntegrationRuntimePolicy = {
  policy: IntegrationPolicy;
  policyRevision: string;
  delegation: IntegrationDelegationTaskBinding | null;
  /** Private issued authority; never persisted or included in model/UI metadata. */
  workflowProjection?: AgentWorkflowRuntimeProjection | null;
};

/** Persisted task identity supplies the ceiling for either worker type; missing provenance never means unrestricted. */
async function currentDelegatedPermissions(context: AgentExecutionContext): Promise<{
  toolsets: string[] | null; taskBinding: string | null; delegation: IntegrationDelegationTaskBinding | null;
}> {
  const denied = { toolsets: [] as string[], taskBinding: null, delegation: null };
  const child = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.userId, context.userId), eq(piSessions.sessionId, context.sessionId), isNull(piSessions.archivedAt)),
    columns: { agentId: true, sessionKind: true, parentSessionId: true, workspaceId: true, organizationId: true },
  });
  if (!child || child.agentId !== context.agentId || child.workspaceId !== context.workspaceId
    || child.organizationId !== context.organizationId) return denied;
  const tasks = await db.query.piDelegations.findMany({
    where: and(eq(piDelegations.userId, context.userId), eq(piDelegations.workerSessionId, context.sessionId),
      eq(piDelegations.status, 'running'), isNull(piDelegations.cancelRequestedAt)),
    columns: { id: true, userId: true, sourceSessionId: true, sourceAgentId: true, sourceAgentTurnId: true, workerSessionId: true,
      targetAgentId: true, workerType: true, toolsetsJson: true, integrationBindingsJson: true },
    limit: 2,
  });
  if (child.sessionKind !== 'delegation_worker') return tasks.length ? denied : { toolsets: null, taskBinding: null, delegation: null };
  if (!child.parentSessionId || tasks.length !== 1) return denied;
  const parent = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.userId, context.userId), eq(piSessions.sessionId, child.parentSessionId), isNull(piSessions.archivedAt)),
    columns: { agentId: true, workspaceId: true, organizationId: true },
  });
  const task = tasks[0];
  if (!parent || parent.workspaceId !== child.workspaceId || parent.organizationId !== child.organizationId
    || task.sourceSessionId !== child.parentSessionId || task.sourceAgentId !== parent.agentId) return denied;
  const taskBinding = schemaFingerprint(task);
  if (task.workerType === 'managed') {
    if (task.targetAgentId !== child.agentId) return denied;
    const toolsets = await getDelegatedWorkerToolsets({ userId: context.userId, sessionId: context.sessionId });
    return { toolsets: toolsets ?? [], taskBinding, delegation: { ...task, workerType: 'managed' } };
  }
  if (task.workerType !== 'ephemeral' || task.targetAgentId || task.sourceAgentId !== child.agentId) return denied;
  try {
    const value: unknown = JSON.parse(task.toolsetsJson);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return denied;
    return { toolsets: value, taskBinding, delegation: { ...task, workerType: 'ephemeral' } };
  } catch { return denied; }
}

/** Fresh provenance only; neither missing/ambiguous tasks nor another user supplies a handoff. */
export async function resolveIntegrationDelegationTaskBinding(executionContext: AgentExecutionContext): Promise<IntegrationDelegationTaskBinding | null> {
  return (await currentDelegatedPermissions({ ...executionContext })).delegation;
}

/** Every call rereads agent preferences and the active delegated task; the registered ceiling can only restrict them. */
export async function resolveIntegrationRuntimePolicy(input: {
  executionContext: AgentExecutionContext;
  ceiling: IntegrationPolicy;
  planningMode?: boolean;
  emailEventAutomation?: boolean;
  restrictions?: readonly IntegrationPolicy[];
}): Promise<ResolvedIntegrationRuntimePolicy> {
  const executionContext = { ...input.executionContext };
  const ceiling = structuredClone(input.ceiling);
  const restrictions = structuredClone(input.restrictions ?? []);
  const planningMode = input.planningMode === true;
  const emailEventAutomation = input.emailEventAutomation === true;
  if (!executionContext.userId.trim() || !executionContext.sessionId.trim()
    || !executionContext.workspaceId.trim() || !executionContext.agentId?.trim()) {
    throw new IntegrationContractError('provider_denied', 'A server-bound agent execution context is required.');
  }

  let effectiveNames = new Set<string>();
  let workerToolsets: string[] | null = null;
  let delegationBinding: string | null = null;
  let delegationTask: IntegrationDelegationTaskBinding | null = null;
  let agentRevision: number | null = null;
  let workflowProjection: AgentWorkflowRuntimeProjection | null = null;
  let workflowPolicy: IntegrationPolicy | null = null;
  let parentPolicy: IntegrationPolicy | null = null;
  let parentPolicyRevision: string | null = null;
  const scopedTurn = isIssuedScopedIntegrationTurn(executionContext);
  if (!planningMode && !emailEventAutomation) {
    try {
      const settings = await resolveAgentRuntimeSettings(executionContext.agentId);
      if (settings.agentId !== executionContext.agentId) throw new Error('The selected agent changed.');
      agentRevision = settings.agent.revision;
      if (isExplicitAgentWorkflowVersion(await getRuntimeAgentWorkflowMode(executionContext)) || scopedTurn) {
        const { resolveAgentWorkflowRuntimeProjection } = await import('@/app/lib/agents/workflow-runtime');
        workflowProjection = await resolveAgentWorkflowRuntimeProjection(executionContext);
      }
      workflowPolicy = workflowProjection?.policy ?? null;
      const configured = settings.enabledTools.map((name) => name.trim());
      effectiveNames = configured.includes('__none__') ? new Set()
        : configured.length > 0 && !isLegacyEnabledToolsValue(configured)
          ? resolveEnabledToolNames(INTEGRATION_LEGACY_CAPABILITY_NAMES, configured)
          : getDefaultEnabledToolNames(INTEGRATION_LEGACY_CAPABILITY_NAMES);
      const delegation = await currentDelegatedPermissions(executionContext);
      workerToolsets = delegation.toolsets;
      delegationBinding = delegation.taskBinding;
      delegationTask = delegation.delegation;
      if (executionContext.delegatedExtensionSource) {
        if (!delegationTask) throw new Error('The delegated source has no active task.');
        const { readDelegatedTurnRuntimeParentSource } = await import('@/app/lib/capabilities/extensions/turn-runtime');
        const source = readDelegatedTurnRuntimeParentSource(executionContext, delegationTask.id);
        if (!source || source !== executionContext.delegatedExtensionSource) throw new Error('The delegated source changed.');
        const { readDelegatedExtensionSource, readDelegatedExtensionParentContext } = await import('@/app/lib/capabilities/extensions/delegation-source');
        const { resolveRuntimeIntegrationExecutionContext } = await import('./context');
        const parentContext = readDelegatedExtensionParentContext(source);
        const currentParent = await resolveRuntimeIntegrationExecutionContext({ executionContext: parentContext, policyRevision: 'delegation-parent-preflight' });
        const currentParentPolicy = await resolveIntegrationRuntimePolicy({ executionContext: currentParent.executionContext,
          ceiling: readDelegatedExtensionSource(source).parentPolicy });
        parentPolicy = currentParentPolicy.policy;
        parentPolicyRevision = currentParentPolicy.policyRevision;
      }
      if (workerToolsets !== null) {
        const delegated = resolveDelegatedWorkerToolNames(workerToolsets, INTEGRATION_LEGACY_CAPABILITY_NAMES);
        effectiveNames = new Set([...effectiveNames].filter((name) => delegated.has(name)));
      }
    } catch {
      throw new IntegrationContractError('provider_denied', 'The current agent integration permissions could not be verified. Reload its tools.');
    }
  } else if (isExplicitAgentWorkflowVersion(await getRuntimeAgentWorkflowMode(executionContext)) || scopedTurn) {
    // Planning and inbox construction never inspect provider accounts or tools.
    workflowPolicy = { allowedSources: null, allowedProviderRefs: null, allowedApplications: null,
      allowedToolNames: null, allowedOperations: null, providerToolRules: [] };
  }
  const policy = intersectIntegrationPolicies(createIntegrationPolicyFromLegacyTools({
    legacyToolNames: effectiveNames, planningMode, emailEventAutomation,
  }), ceiling, ...(workflowPolicy ? [workflowPolicy] : []), ...(parentPolicy ? [parentPolicy] : []), ...restrictions);
  return {
    policy,
    delegation: delegationTask,
    workflowProjection,
    policyRevision: `integration-policy:v1:${schemaFingerprint({
      actorUserId: executionContext.userId,
      organizationId: executionContext.organizationId,
      workspaceId: executionContext.workspaceId,
      agentId: executionContext.agentId,
      sessionId: executionContext.sessionId,
      scopedTurn: scopedTurn ? { turnId: executionContext.agentTurnId ?? null,
        selection: executionContext.turnExtensions ?? null, source: executionContext.turnExtensionSource?.fingerprint ?? null } : null,
      agentRevision,
      workflowRevision: workflowProjection?.revision ?? null,
      delegationBinding,
      delegatedSource: executionContext.delegatedExtensionSource?.fingerprint ?? null,
      parentPolicyRevision,
      workspacePermissions: { canWrite: executionContext.canWrite, canDelete: executionContext.canDelete, canShare: executionContext.canShare },
      policy,
      planningMode,
      emailEventAutomation,
      workerToolsets: workerToolsets === null ? null : [...workerToolsets].sort(),
    })}`,
  };
}
