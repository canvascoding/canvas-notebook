import 'server-only';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { readIntegrationToolGatewayAvailability } from '@/app/lib/integration-tool-gateway-availability';
import { INTEGRATION_GATEWAY_ERROR_MESSAGES as ERROR_MESSAGES, readIntegrationContractErrorCode } from '@/app/lib/integration-tools/agent-errors';
import {
  INTEGRATION_CONTRACT_VERSION, IntegrationContractError, IntegrationRequestSchema, parseIntegrationRequest,
  type IntegrationErrorCode, type IntegrationErrorResult, type IntegrationPolicy, type IntegrationRequest,
} from '@/app/lib/integration-tools/contracts';
import { resolveRuntimeIntegrationExecutionContext } from '@/app/lib/integration-tools/context';
import { prepareDelegatedIntegrationBindings } from '@/app/lib/integration-tools/delegation';
import { readPrivateDelegatedIntegrationSnapshot } from '@/app/lib/integration-tools/delegation-contracts';
import { integrationDispatcher, type IntegrationDispatchResult } from '@/app/lib/integration-tools/dispatcher';
import { createIntegrationPolicyFromLegacyTools, INTEGRATION_LEGACY_CAPABILITY_NAMES, intersectIntegrationPolicies } from '@/app/lib/integration-tools/policy';
import { readIntegrationToolReceipt, type IntegrationToolReceipt } from '@/app/lib/integration-tools/receipt';
import { IntegrationReferenceCache } from '@/app/lib/integration-tools/reference-cache';
import { resolveIntegrationRuntimePolicy } from '@/app/lib/integration-tools/runtime-policy';
import { isIntegrationTurnUncertain, markIntegrationTurnUncertain, type IntegrationUncertainTurnContext } from '@/app/lib/integration-tools/uncertain-turns';
import { isPersistedIntegrationTurnUncertain, persistIntegrationTurnUncertain } from '@/app/lib/integration-tools/uncertain-turn-store';
import { cloneIntegrationArguments, schemaFingerprint } from '@/app/lib/integration-tools/schema';
import { getAgentExecutionContext, type AgentExecutionContext } from './agent-execution-context';

export { getIntegrationGatewayErrorOverride } from '@/app/lib/integration-tools/agent-errors';

export type IntegrationGatewayOptions = {
  userId?: string;
  agentId?: string | null;
  sessionId?: string | null;
  executionContext?: AgentExecutionContext;
  policyCeiling?: IntegrationPolicy;
  planningMode?: boolean;
  emailEventAutomation?: boolean;
};

export type IntegrationGatewayDependencies = {
  dispatcher: Pick<typeof integrationDispatcher, 'execute'>;
  resolveContext: typeof resolveRuntimeIntegrationExecutionContext;
  resolvePolicy: typeof resolveIntegrationRuntimePolicy;
  prepareDelegation: typeof prepareDelegatedIntegrationBindings;
  isPersistedUncertain: typeof isPersistedIntegrationTurnUncertain;
  persistUncertain: typeof persistIntegrationTurnUncertain;
  recordAudit: typeof recordAuditEvent;
  isEnabled: () => boolean;
};

export type IntegrationGatewayAgentTool = AgentTool<typeof IntegrationRequestSchema> & {
  integrationGateway: {
    readonly policyCeiling: IntegrationPolicy;
    withPolicyCeiling: (policy: IntegrationPolicy) => IntegrationGatewayAgentTool;
  };
};

type ReceiptLabels = Pick<IntegrationToolReceipt, 'source' | 'providerName' | 'connectionName' | 'toolName'>;
const gatewayHost = globalThis as typeof globalThis & {
  __canvasIntegrationReceiptLabelsV1?: IntegrationReferenceCache<ReceiptLabels>;
};
const receiptLabels = gatewayHost.__canvasIntegrationReceiptLabelsV1 ??= new IntegrationReferenceCache(2048, 15 * 60_000);

function freezePolicy(policy: IntegrationPolicy): IntegrationPolicy {
  const copy = structuredClone(policy);
  for (const value of Object.values(copy)) if (Array.isArray(value)) Object.freeze(value);
  return Object.freeze(copy);
}

function sameIdentity(expected: AgentExecutionContext, actual: AgentExecutionContext): boolean {
  return ['userId', 'sessionId', 'agentId', 'workspaceId', 'workspaceType', 'organizationId', 'customerId', 'projectId']
    .every((key) => expected[key as keyof AgentExecutionContext] === actual[key as keyof AgentExecutionContext]);
}

function errorCode(error: unknown, providerCallMayStart: boolean): IntegrationErrorCode {
  const knownCode = readIntegrationContractErrorCode(error);
  if (knownCode) return knownCode;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'AGENT_ACCESS_DENIED') return 'provider_denied';
  return providerCallMayStart ? 'outcome_unknown' : 'provider_unavailable';
}

function errorResult(code: IntegrationErrorCode, request?: IntegrationRequest, delegatedCall = false): IntegrationErrorResult {
  const nextActions: IntegrationErrorResult['nextActions'] = [];
  if (delegatedCall) {
    // The parent supplies this schema; a call-only worker has no discovery grant.
  } else if (['binding_changed', 'schema_changed', 'invalid_arguments'].includes(code) && request && 'toolRef' in request) {
    nextActions.push({ kind: 'gateway', label: 'Load the current tool schema', request: { action: 'describe', toolRef: request.toolRef } });
  } else if (code === 'invalid_cursor' && request && 'target' in request) {
    const freshRequest = { ...request };
    delete freshRequest.cursor;
    nextActions.push({ kind: 'gateway', label: 'Start a current catalogue search', request: freshRequest });
  } else if (code === 'tool_not_found') {
    nextActions.push({ kind: 'gateway', label: 'Find an available integration', request: { action: 'list', target: 'providers' } });
  } else if (code === 'provider_unavailable') {
    nextActions.push({ kind: 'setup', label: 'Check integration setup', href: '/settings?tab=integrations' });
  }
  return { version: INTEGRATION_CONTRACT_VERSION, error: { code, message: ERROR_MESSAGES[code], retryable: false }, nextActions };
}

function requestReceipt(request?: IntegrationRequest): IntegrationToolReceipt | undefined {
  if (!request) return undefined;
  return { version: 1, action: request.action, ...('target' in request ? { target: request.target } : {}) };
}

function resultReceipt(namespace: string, request: IntegrationRequest, result: IntegrationDispatchResult): IntegrationToolReceipt {
  if ('target' in result && result.target === 'providers') {
    for (const provider of result.providers) {
      const labels = {
        source: provider.source, providerName: provider.displayName,
        ...(provider.connection?.displayName ? { connectionName: provider.connection.displayName } : {}),
      };
      if (readIntegrationToolReceipt({ integrationReceipt: { version: 1, action: request.action, ...labels } })) {
        receiptLabels.set(namespace + ':' + provider.providerRef, labels);
      }
    }
  } else if ('target' in result && result.target === 'tools') {
    const labels = receiptLabels.get(namespace + ':' + result.providerRef);
    for (const tool of result.tools) receiptLabels.set(namespace + ':' + tool.toolRef, { ...labels, toolName: tool.name });
  }
  const ref = 'toolRef' in result ? result.toolRef : 'providerRef' in result ? result.providerRef : null;
  const labels = ref ? receiptLabels.get(namespace + ':' + ref) : undefined;
  const candidate = {
    ...requestReceipt(request), ...labels,
    ...('target' in result && result.target === 'result' ? { source: result.source, providerName: result.displayName } : {}),
  };
  return readIntegrationToolReceipt({ integrationReceipt: candidate }) ?? requestReceipt(request)!;
}

/** Construction exposes only the contract. Provider discovery happens on a separately authorized invocation. */
export function createIntegrationGatewayTool(
  input: IntegrationGatewayOptions = {},
  overrides: Partial<IntegrationGatewayDependencies> = {},
): IntegrationGatewayAgentTool {
  const executionContext = input.executionContext ? { ...input.executionContext } : undefined;
  const options = {
    userId: input.userId, agentId: input.agentId, sessionId: input.sessionId, executionContext,
    planningMode: input.planningMode === true, emailEventAutomation: input.emailEventAutomation === true,
  };
  const ceiling = freezePolicy(intersectIntegrationPolicies(createIntegrationPolicyFromLegacyTools({
    legacyToolNames: INTEGRATION_LEGACY_CAPABILITY_NAMES,
  }), input.policyCeiling ?? createIntegrationPolicyFromLegacyTools({ legacyToolNames: INTEGRATION_LEGACY_CAPABILITY_NAMES })));
  const dependencies: IntegrationGatewayDependencies = {
    dispatcher: integrationDispatcher, resolveContext: resolveRuntimeIntegrationExecutionContext,
    resolvePolicy: resolveIntegrationRuntimePolicy, prepareDelegation: prepareDelegatedIntegrationBindings, recordAudit: recordAuditEvent,
    isPersistedUncertain: isPersistedIntegrationTurnUncertain, persistUncertain: persistIntegrationTurnUncertain,
    isEnabled: () => readIntegrationToolGatewayAvailability().integrationToolGatewayEnabled, ...overrides,
  };
  return {
    name: 'integrations',
    label: 'Integrations',
    description: 'Find available MCP and Composio integrations, then discover their tools. Use list/search with target providers first; choose the returned providerRef, list/search its tools, describe a returned toolRef, and call with the returned schemaRef and arguments matching its inputSchema. Follow nextActions and pagination. References select one exact account; never invent identities, schemas or references. Native Canvas email tools remain the email workflow. If outcome_unknown is returned, inspect the provider outcome before repeating; never retry or switch providers automatically.',
    parameters: IntegrationRequestSchema,
    replay: 'never',
    executionMode: 'sequential',
    integrationGateway: {
      policyCeiling: ceiling,
      withPolicyCeiling: (policy) => createIntegrationGatewayTool({ ...options, policyCeiling: intersectIntegrationPolicies(ceiling, policy) }, dependencies),
    },
    async execute(toolCallId, params, signal) {
      let request: IntegrationRequest | undefined;
      let trustedContext: AgentExecutionContext | undefined;
      let providerCallMayStart = false;
      let uncertainTurn: IntegrationUncertainTurnContext | undefined;
      let delegatedCall = false;
      let delegatedParentTurn: IntegrationUncertainTurnContext | undefined;
      const startedAt = Date.now();
      try {
        const parsed = parseIntegrationRequest(params);
        request = parsed.action === 'call' ? { ...parsed, arguments: cloneIntegrationArguments(parsed.arguments) } : { ...parsed };
        const ambient = getAgentExecutionContext();
        trustedContext = ambient ? { ...ambient } : executionContext ? { ...executionContext } : undefined;
        if (!options.userId || !options.sessionId || !trustedContext
          || trustedContext.userId !== options.userId || trustedContext.sessionId !== options.sessionId
          || (options.agentId && trustedContext.agentId !== options.agentId)
          || (executionContext && !sameIdentity(executionContext, trustedContext))) {
          throw new IntegrationContractError('provider_denied', ERROR_MESSAGES.provider_denied);
        }
        const capturedContext = { ...trustedContext };
        uncertainTurn = { ...capturedContext };
        signal?.throwIfAborted();
        const authorize = async () => {
          if (!dependencies.isEnabled()) throw new IntegrationContractError('tool_denied', ERROR_MESSAGES.tool_denied);
          const resolved = await dependencies.resolveContext({ executionContext: capturedContext, policyRevision: 'integration-preflight' });
          const runtimePolicy = await dependencies.resolvePolicy({
            executionContext: resolved.executionContext, ceiling,
            planningMode: options.planningMode, emailEventAutomation: options.emailEventAutomation,
          });
          if (runtimePolicy.policy.allowedSources?.length === 0 || runtimePolicy.policy.allowedOperations?.length === 0) {
            throw new IntegrationContractError('tool_denied', ERROR_MESSAGES.tool_denied);
          }
          const authority = {
            context: { ...resolved.integrationContext, policyRevision: runtimePolicy.policyRevision },
            policy: runtimePolicy.policy, executionContext: resolved.executionContext,
          };
          const task = runtimePolicy.delegation;
          if (request?.action === 'call' && task) {
            delegatedParentTurn = {
              userId: capturedContext.userId, sessionId: task.sourceSessionId, agentId: task.sourceAgentId,
              workspaceId: resolved.executionContext.workspaceId, agentTurnId: task.sourceAgentTurnId ?? undefined,
            };
            if (isIntegrationTurnUncertain(delegatedParentTurn)
              || await dependencies.isPersistedUncertain(delegatedParentTurn)) {
              throw new IntegrationContractError('outcome_unknown', ERROR_MESSAGES.outcome_unknown);
            }
          }
          if (request?.action === 'call' && runtimePolicy.delegation?.integrationBindingsJson !== null
            && runtimePolicy.delegation?.integrationBindingsJson !== undefined) {
            delegatedCall = true;
            await dependencies.prepareDelegation({
              ...authority, delegation: runtimePolicy.delegation, signal,
            });
            const parent = readPrivateDelegatedIntegrationSnapshot(runtimePolicy.delegation.integrationBindingsJson).parent;
            delegatedParentTurn = {
              userId: parent.actorUserId, sessionId: parent.sessionId, agentId: parent.agentId,
              workspaceId: parent.workspaceId, agentTurnId: parent.agentTurnId ?? undefined,
            };
          }
          return authority;
        };
        const authority = await authorize();
        const checkCurrentAuthority = async () => {
          signal?.throwIfAborted();
          if (request?.action === 'call' && (isIntegrationTurnUncertain(uncertainTurn!)
            || await dependencies.isPersistedUncertain(uncertainTurn!))) {
            throw new IntegrationContractError('outcome_unknown', ERROR_MESSAGES.outcome_unknown);
          }
          const current = await authorize();
          if (schemaFingerprint({ context: current.context, policy: current.policy })
            !== schemaFingerprint({ context: authority.context, policy: authority.policy })) {
            throw new IntegrationContractError('schema_changed', ERROR_MESSAGES.schema_changed);
          }
        };
        if (request.action === 'call' && (isIntegrationTurnUncertain(uncertainTurn)
          || await dependencies.isPersistedUncertain(uncertainTurn))) {
          throw new IntegrationContractError('outcome_unknown', ERROR_MESSAGES.outcome_unknown);
        }
        const result = await dependencies.dispatcher.execute({
          context: authority.context, policy: authority.policy, request, toolCallId, signal,
          beforeToolCall: async () => { await checkCurrentAuthority(); providerCallMayStart = true; },
        });
        if (request.action !== 'call') await checkCurrentAuthority();
        const namespace = schemaFingerprint(authority.context);
        const integrationReceipt = resultReceipt(namespace, request, result);
        const details = {
          integrations: { version: 1, action: request.action,
            ...('providerRef' in result ? { providerRef: result.providerRef } : {}),
            ...('toolRef' in result ? { toolRef: result.toolRef } : {}),
            ...('schemaRef' in result ? { schemaRef: result.schemaRef } : {}),
            ...('source' in result ? { source: result.source } : {}),
          },
          integrationReceipt,
        };
        await dependencies.recordAudit({
          organizationId: authority.executionContext.organizationId, workspaceId: authority.executionContext.workspaceId,
          customerId: authority.executionContext.customerId, projectId: authority.executionContext.projectId,
          userId: capturedContext.userId, sessionId: capturedContext.sessionId, agentId: capturedContext.agentId,
          source: 'agent_tool', eventType: 'integration', entityType: 'integration_tool',
          entityId: 'providerRef' in result ? result.providerRef : null,
          action: 'integrations.' + request.action, status: 'success', summary: 'Integration action completed.',
          metadata: { ...details.integrations, toolCallId, durationMs: Date.now() - startedAt },
        }).catch(() => null);
        if ('target' in result && result.target === 'result') {
          const providerDetails = result.result.details;
          const normalizedDetails = providerDetails !== null && typeof providerDetails === 'object' && !Array.isArray(providerDetails)
            ? providerDetails as Record<string, unknown> : { providerDetails };
          return { ...result.result, details: { ...normalizedDetails, ...details, integrationError: undefined } };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { ...result, ...details } };
      } catch (error) {
        const code = errorCode(error, providerCallMayStart);
        if (code === 'outcome_unknown' && uncertainTurn) {
          markIntegrationTurnUncertain(uncertainTurn);
          if (delegatedParentTurn) markIntegrationTurnUncertain(delegatedParentTurn);
          await dependencies.persistUncertain(uncertainTurn).catch(() => undefined);
          if (delegatedParentTurn) await dependencies.persistUncertain(delegatedParentTurn).catch(() => undefined);
        }
        const result = errorResult(code, request, delegatedCall);
        const refreshDelegation = delegatedCall && ['binding_changed', 'schema_changed', 'provider_denied', 'tool_denied', 'tool_not_found'].includes(code);
        const integrationReceipt = requestReceipt(request);
        if (trustedContext && trustedContext.userId === options.userId && trustedContext.sessionId === options.sessionId) {
          await dependencies.recordAudit({
            organizationId: trustedContext.organizationId, workspaceId: trustedContext.workspaceId,
            userId: trustedContext.userId, sessionId: trustedContext.sessionId, agentId: trustedContext.agentId,
            source: 'agent_tool', eventType: 'integration', entityType: 'integration_tool',
            action: 'integrations.' + (request?.action ?? 'invalid'), status: code === 'outcome_unknown' ? 'error' : 'blocked',
            summary: result.error.message, metadata: { code, toolCallId, durationMs: Date.now() - startedAt },
          }).catch(() => null);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }, ...(refreshDelegation
            ? [{ type: 'text' as const, text: 'Ask the delegating agent to refresh the approved integration binding before continuing.' }] : [])],
          details: { integrationError: result, error: result.error.message, ...(integrationReceipt ? { integrationReceipt } : {}) },
          ...(code === 'outcome_unknown' ? { terminate: true } : {}),
        };
      }
    },
  };
}

export function isIntegrationGatewayTool(tool: AgentTool): tool is IntegrationGatewayAgentTool {
  return tool.name === 'integrations' && 'integrationGateway' in tool
    && typeof (tool as IntegrationGatewayAgentTool).integrationGateway?.withPolicyCeiling === 'function';
}
