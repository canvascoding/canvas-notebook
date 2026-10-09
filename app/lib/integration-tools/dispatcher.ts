import 'server-only';

import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { getIntegrationProviderCatalog, type IntegrationCatalogAdapters } from './catalog';
import {
  INTEGRATION_CONTRACT_VERSION,
  IntegrationContractError,
  parseIntegrationRequest,
  type IntegrationExecutionContext,
  type IntegrationOperation,
  type IntegrationPolicy,
  type IntegrationProviderPage,
  type IntegrationSource,
  type IntegrationToolDescriptor,
  type IntegrationToolPage,
  type IntegrationToolSchema,
} from './contracts';
import { integrationPolicyAllowedToolNames, isIntegrationProviderOperationAllowed, isIntegrationProviderReferenceAllowed, isIntegrationProviderVisible, isIntegrationToolAllowed } from './policy';
import { findSharedIntegrationConnectionAuthorization, getIntegrationProviderAuthorization, integrationProviderAllowedToolNames,
  revalidateIntegrationProviderAuthorization } from './connections/provider-authorization';
import type { AuthorizedIntegrationConnection } from './connections/contracts';
import { createSharedIntegrationPolicyDescriptor } from './connections/provider-policy';
import { IntegrationReferenceCache } from './reference-cache';
import { transferPersonalWorkflowProviderTargets } from './workflow-personal-bindings';
import { transferWorkflowProviderAssociations } from './workflow-provider-associations';
import { getAttachedPersonalWorkflowProviderDescriptor } from './workflow-personal-provenance';
import { createIntegrationToolRef } from './references';
import type { DelegatedComposioToolBinding, IntegrationBindingSelection } from './delegation-contracts';
import type {
  IntegrationAdapterToolSchema,
  IntegrationResolvedProvider,
  IntegrationToolAdapter,
  IntegrationToolAdapters,
} from './runtime-contracts';
import {
  cloneIntegrationArguments,
  createIntegrationSchemaRef,
  schemaFingerprint,
  validateIntegrationArguments,
  validateIntegrationSchema,
} from './schema';

type ToolRoute = { source: IntegrationSource; providerRef: string; toolName: string };
type IssuedSchema = {
  route: ToolRoute;
  schemaRef: string;
  contextFingerprint: string;
  bindingRevision: string;
  authorizationRevision?: string;
  application?: string;
  tool: IntegrationAdapterToolSchema;
};

export type IntegrationCallResult = {
  version: typeof INTEGRATION_CONTRACT_VERSION;
  target: 'result';
  toolRef: string;
  providerRef: string;
  source: IntegrationSource;
  displayName: string;
  result: AgentToolResult<unknown>;
};

export type IntegrationDispatchResult = IntegrationProviderPage | IntegrationToolPage | IntegrationToolSchema | IntegrationCallResult;

function contextNamespace(context: IntegrationExecutionContext): string {
  return schemaFingerprint([context.actorUserId, context.organizationId || null, context.workspaceId || null, context.agentId || null, context.sessionId || null]);
}

function currentPolicyFingerprint(context: IntegrationExecutionContext, policy: IntegrationPolicy): string {
  return schemaFingerprint({ context, policy });
}

function schemaBindingRevision(context: IntegrationExecutionContext, provider: IntegrationResolvedProvider): string {
  const authorization = getIntegrationProviderAuthorization(context, provider.provider);
  return authorization ? schemaFingerprint([provider.bindingRevision, authorization.authorizationRevision]) : provider.bindingRevision;
}

function sourceFromProviderRef(providerRef: string): IntegrationSource {
  if (providerRef.startsWith('mcp:v1:')) return 'mcp';
  if (providerRef.startsWith('composio:v1:')) return 'composio';
  throw new IntegrationContractError('provider_denied', 'Choose an integration reference from the current catalogue.');
}

function assertProviderAllowed(context: IntegrationExecutionContext, policy: IntegrationPolicy, provider: IntegrationResolvedProvider, providerRef: string): void {
  if (provider.provider.providerRef !== providerRef || provider.provider.source !== sourceFromProviderRef(providerRef)
    || !provider.bindingRevision.trim() || !isIntegrationProviderVisible(context, policy, provider.provider)) {
    throw new IntegrationContractError('provider_denied', 'This integration is not available to the current agent.');
  }
}

/** Resource metadata is sufficient to apply routing restrictions before provider discovery. */
async function assertSharedProviderPolicy(context: IntegrationExecutionContext, policy: IntegrationPolicy,
  authorization: AuthorizedIntegrationConnection | null, providerRef: string, operation: IntegrationOperation, toolName?: string): Promise<void> {
  if (!authorization) return;
  const provider = await createSharedIntegrationPolicyDescriptor(context, authorization);
  if (provider.providerRef !== providerRef || !isIntegrationProviderVisible(context, policy, provider)) {
    throw new IntegrationContractError('provider_denied', 'This integration is not available to the current agent.');
  }
  if (toolName ? !isIntegrationToolAllowed(context, policy, provider, toolName, operation)
    : integrationProviderAllowedToolNames(context, provider, integrationPolicyAllowedToolNames(policy, provider.source, providerRef))?.length === 0) {
    throw new IntegrationContractError('tool_denied', 'No requested tools are enabled for this shared connection.');
  }
}

function assertPersonalProviderPolicy(context: IntegrationExecutionContext, policy: IntegrationPolicy,
  providerRef: string, operation: IntegrationOperation, toolName?: string): void {
  if (!/^(mcp|composio):v1:personal:/u.test(providerRef)) return;
  const provider = getAttachedPersonalWorkflowProviderDescriptor(context, providerRef);
  if (!provider || !isIntegrationProviderVisible(context, policy, provider)) {
    throw new IntegrationContractError('provider_denied', 'This integration is not available to the current agent.');
  }
  if (!isIntegrationProviderOperationAllowed(policy, provider.source, providerRef, operation)
    || (toolName ? !isIntegrationToolAllowed(context, policy, provider, toolName, operation)
      : integrationPolicyAllowedToolNames(policy, provider.source, providerRef)?.length === 0)) {
    throw new IntegrationContractError('tool_denied', 'The requested tools are not enabled for this workflow connection.');
  }
}

/** The adapter owns authentication; a loaded route or schema never grants execution rights. */
export class IntegrationDispatcher {
  private readonly routes: IntegrationReferenceCache<ToolRoute>;
  private readonly schemas: IntegrationReferenceCache<IssuedSchema>;

  inspectIssuedToolIdentity(context: IntegrationExecutionContext, policy: IntegrationPolicy, toolRef: string, schemaRef: string) {
    const namespace = contextNamespace(context);
    const route = this.routes.get(`${namespace}:${toolRef}`);
    const issued = this.schemas.get(`${namespace}:${schemaRef}`);
    if (!route || !issued || issued.route.providerRef !== route.providerRef || issued.route.toolName !== route.toolName
      || issued.route.source !== route.source || issued.contextFingerprint !== currentPolicyFingerprint(context, policy)) {
      throw new IntegrationContractError('schema_changed', 'Load the current tool schema before executing.');
    }
    return { source: route.source, providerRef: route.providerRef, toolName: route.toolName,
      ...(issued.application ? { application: issued.application } : {}) };
  }

  constructor(private readonly dependencies: {
    adapters?: IntegrationToolAdapters;
    catalogAdapters?: IntegrationCatalogAdapters;
    now?: () => number;
  } = {}) {
    this.routes = new IntegrationReferenceCache(2048, 15 * 60_000, dependencies.now);
    this.schemas = new IntegrationReferenceCache(256, 15 * 60_000, dependencies.now);
  }

  private async adapter(source: IntegrationSource): Promise<IntegrationToolAdapter> {
    const adapter = this.dependencies.adapters?.[source] ?? (source === 'mcp'
      ? (await import('./adapters/mcp-runtime')).mcpIntegrationToolAdapter
      : (await import('./adapters/composio-runtime')).composioIntegrationToolAdapter);
    if (adapter.source !== source) throw new IntegrationContractError('provider_unavailable', 'This integration source is temporarily unavailable.');
    return adapter;
  }

  /** Server-only handoff: a reference is selected from a schema actually issued to this parent session. */
  async exportDelegatedComposioSchema(input: {
    context: IntegrationExecutionContext;
    policy: IntegrationPolicy;
    selection: IntegrationBindingSelection;
    signal?: AbortSignal;
  }): Promise<DelegatedComposioToolBinding> {
    const context = { ...input.context };
    transferPersonalWorkflowProviderTargets(input.context, context);
    transferWorkflowProviderAssociations(input.context, context);
    const policy = structuredClone(input.policy);
    const selection = { ...input.selection };
    if (!context.sessionId?.trim()) throw new IntegrationContractError('provider_denied', 'An owned parent session is required for integration handoff.');
    const namespace = contextNamespace(context);
    const route = this.routes.get(`${namespace}:${selection.toolRef}`);
    const issued = this.schemas.get(`${namespace}:${selection.schemaRef}`);
    if (!route || route.source !== 'composio' || !issued
      || issued.route.providerRef !== route.providerRef || issued.route.toolName !== route.toolName
      || issued.contextFingerprint !== currentPolicyFingerprint(context, policy)) {
      throw new IntegrationContractError('schema_changed', 'Describe the selected Composio operation in the current parent session before handing it off.');
    }
    const binding = { providerRef: route.providerRef, toolName: route.toolName,
      bindingRevision: issued.bindingRevision, tool: structuredClone(issued.tool) };
    await this.checkDelegatedComposioSchema(context, policy, binding, 'describe', input.signal);
    return binding;
  }

  private async checkDelegatedComposioSchema(context: IntegrationExecutionContext, policy: IntegrationPolicy,
    binding: DelegatedComposioToolBinding, operation: 'describe' | 'call', signal?: AbortSignal): Promise<IntegrationResolvedProvider> {
    signal?.throwIfAborted();
    if (sourceFromProviderRef(binding.providerRef) !== 'composio'
      || binding.tool.name !== binding.toolName || !binding.tool.toolVersion
      || !isIntegrationProviderOperationAllowed(policy, 'composio', binding.providerRef, operation)
      || integrationPolicyAllowedToolNames(policy, 'composio', binding.providerRef)?.includes(binding.toolName) === false) {
      throw new IntegrationContractError('tool_denied', 'The approved Composio operation is not available to this agent.');
    }
    const shared = await findSharedIntegrationConnectionAuthorization(context, binding.providerRef, 'use', binding.toolName);
    await assertSharedProviderPolicy(context, policy, shared, binding.providerRef, operation, binding.toolName);
    assertPersonalProviderPolicy(context, policy, binding.providerRef, operation, binding.toolName);
    const adapter = await this.adapter('composio');
    const resolved = await adapter.resolveProvider(context, binding.providerRef);
    assertProviderAllowed(context, policy, resolved, binding.providerRef);
    if (!isIntegrationToolAllowed(context, policy, resolved.provider, binding.toolName, operation)) {
      throw new IntegrationContractError('tool_denied', 'The approved Composio operation is not available to this agent.');
    }
    if (resolved.bindingRevision !== binding.bindingRevision) {
      throw new IntegrationContractError('binding_changed', 'The approved Composio connection changed. Ask the delegating agent to refresh it.');
    }
    if (!resolved.provider.canExecute) throw new IntegrationContractError('provider_unavailable', 'The approved Composio connection is unavailable.');
    const current = structuredClone(await adapter.describeTool(context, resolved, binding.toolName, signal));
    await validateIntegrationSchema(current.inputSchema);
    if (current.outputSchema !== undefined) await validateIntegrationSchema(current.outputSchema);
    if (schemaFingerprint(current) !== schemaFingerprint(binding.tool)) {
      throw new IntegrationContractError('schema_changed', 'The approved Composio operation changed. Ask the delegating agent to refresh it.');
    }
    return resolved;
  }

  /** Persisted, bounded metadata can be revalidated after a parent reference cache expires. */
  async verifyDelegatedComposioSchema(input: {
    context: IntegrationExecutionContext; policy: IntegrationPolicy; binding: DelegatedComposioToolBinding;
    operation: 'describe' | 'call'; signal?: AbortSignal;
  }): Promise<void> {
    const context = { ...input.context };
    transferPersonalWorkflowProviderTargets(input.context, context);
    transferWorkflowProviderAssociations(input.context, context);
    const policy = structuredClone(input.policy);
    const binding = structuredClone(input.binding);
    await this.checkDelegatedComposioSchema(context, policy, binding, input.operation, input.signal);
  }

  /** Internal validation uses call rights; it does not grant or perform public tool discovery/describe. */
  async seedDelegatedComposioSchema(input: {
    context: IntegrationExecutionContext;
    policy: IntegrationPolicy;
    binding: DelegatedComposioToolBinding;
    signal?: AbortSignal;
  }): Promise<IntegrationToolSchema> {
    const context = { ...input.context };
    transferPersonalWorkflowProviderTargets(input.context, context);
    transferWorkflowProviderAssociations(input.context, context);
    const policy = structuredClone(input.policy);
    const binding = structuredClone(input.binding);
    if (!context.sessionId?.trim()) throw new IntegrationContractError('provider_denied', 'An owned worker session is required for integration handoff.');
    const resolved = await this.checkDelegatedComposioSchema(context, policy, binding, 'call', input.signal);
    const toolRef = createIntegrationToolRef(binding.providerRef, binding.toolName);
    const schemaRef = createIntegrationSchemaRef({ context, policy, ...binding,
      bindingRevision: schemaBindingRevision(context, resolved),
      toolVersion: binding.tool.toolVersion, inputSchema: binding.tool.inputSchema, outputSchema: binding.tool.outputSchema });
    const route: ToolRoute = { source: 'composio', providerRef: binding.providerRef, toolName: binding.toolName };
    const namespace = contextNamespace(context);
    this.routes.set(`${namespace}:${toolRef}`, route);
    this.schemas.set(`${namespace}:${schemaRef}`, { route, schemaRef, bindingRevision: binding.bindingRevision,
      authorizationRevision: getIntegrationProviderAuthorization(context, resolved.provider)?.authorizationRevision,
      contextFingerprint: currentPolicyFingerprint(context, policy), tool: binding.tool });
    return { version: INTEGRATION_CONTRACT_VERSION, toolRef, providerRef: binding.providerRef, schemaRef,
      toolVersion: binding.tool.toolVersion, inputSchema: structuredClone(binding.tool.inputSchema),
      ...(binding.tool.outputSchema === undefined ? {} : { outputSchema: structuredClone(binding.tool.outputSchema) }),
      skillRefs: resolved.provider.skillRefs,
      nextActions: [{ kind: 'input_required', label: 'Execute the operation approved for this delegated task',
        request: { action: 'call', toolRef, schemaRef }, requiredArguments: typeof binding.tool.inputSchema === 'object'
          && Array.isArray(binding.tool.inputSchema.required) ? binding.tool.inputSchema.required.filter((key): key is string => typeof key === 'string') : [] }],
    };
  }

  async execute(input: {
    context: IntegrationExecutionContext;
    policy: IntegrationPolicy;
    request: unknown;
    toolCallId: string;
    signal?: AbortSignal;
    preferredSource?: IntegrationSource;
    confirmedProviderRefs?: readonly string[];
    beforeToolCall?: () => Promise<void>;
  }): Promise<IntegrationDispatchResult> {
    const parsedRequest = parseIntegrationRequest(input.request);
    const request = parsedRequest.action === 'call'
      ? { ...parsedRequest, arguments: cloneIntegrationArguments(parsedRequest.arguments) }
      : { ...parsedRequest };
    // Capture a single server-resolved context and policy; do not accept either from tool arguments.
    const context = { ...input.context };
    transferPersonalWorkflowProviderTargets(input.context, context);
    transferWorkflowProviderAssociations(input.context, context);
    const policy = structuredClone(input.policy);
    const signal = input.signal;
    const toolCallId = input.toolCallId;
    const beforeToolCall = input.beforeToolCall;
    if (!context.actorUserId.trim() || !context.policyRevision.trim()) {
      throw new IntegrationContractError('provider_denied', 'A current authenticated integration context is required.');
    }
    signal?.throwIfAborted();
    if ('target' in request && request.target === 'providers') {
      return getIntegrationProviderCatalog({
        context, policy, request, adapters: this.dependencies.catalogAdapters,
        preferredSource: input.preferredSource, confirmedProviderRefs: input.confirmedProviderRefs,
      });
    }
    const namespace = contextNamespace(context);
    if ('target' in request && request.target === 'tools') {
      const source = sourceFromProviderRef(request.providerRef);
      const operation = request.action === 'list' ? 'list_tools' : 'search_tools';
      if (!isIntegrationProviderReferenceAllowed(policy, source, request.providerRef)) {
        throw new IntegrationContractError('provider_denied', 'This integration is not available to the current agent.');
      }
      if (!isIntegrationProviderOperationAllowed(policy, source, request.providerRef, operation)) {
        throw new IntegrationContractError('tool_denied', 'Tool discovery is not enabled for this integration source.');
      }
      const shared = await findSharedIntegrationConnectionAuthorization(context, request.providerRef, 'use');
      await assertSharedProviderPolicy(context, policy, shared, request.providerRef, operation);
      assertPersonalProviderPolicy(context, policy, request.providerRef, operation);
      const adapter = await this.adapter(source);
      const resolved = await adapter.resolveProvider(context, request.providerRef);
      assertProviderAllowed(context, policy, resolved, request.providerRef);
      const page = await adapter.listTools(context, resolved, {
        query: request.action === 'search' ? request.query : undefined,
        limit: request.limit ?? 12, cursor: request.cursor, signal,
        allowedToolNames: integrationProviderAllowedToolNames(context, resolved.provider, integrationPolicyAllowedToolNames(policy, source, request.providerRef)),
      });
      await revalidateIntegrationProviderAuthorization(context, resolved.provider, 'use');
      const tools: IntegrationToolDescriptor[] = page.tools
        .filter((tool) => isIntegrationToolAllowed(context, policy, resolved.provider, tool.name, operation))
        .map((tool) => {
          const toolRef = createIntegrationToolRef(request.providerRef, tool.name);
          this.routes.set(`${namespace}:${toolRef}`, { source, providerRef: request.providerRef, toolName: tool.name });
          return {
            toolRef, providerRef: request.providerRef, name: tool.name, description: tool.description,
            effect: tool.effect, skillRefs: resolved.provider.skillRefs,
            matchReasons: [request.action === 'search' ? 'provider_tool_search' : 'available'],
            nextActions: isIntegrationToolAllowed(context, policy, resolved.provider, tool.name, 'describe')
              ? [{ kind: 'gateway' as const, label: 'Load the tool schema', request: { action: 'describe' as const, toolRef } }]
              : [],
          };
        });
      return {
        version: INTEGRATION_CONTRACT_VERSION, target: 'tools', providerRef: request.providerRef,
        tools, complete: page.complete, providerErrors: [...page.providerErrors], nextCursor: page.nextCursor,
        nextActions: page.nextCursor
          ? [{ kind: 'gateway', label: 'Show more tools', request: { ...request, cursor: page.nextCursor } }]
          : [],
      };
    }

    const route = this.routes.get(`${namespace}:${request.toolRef}`);
    if (!route) throw new IntegrationContractError('tool_not_found', 'Find this tool in the current integration context before loading its schema.');
    if (!isIntegrationProviderReferenceAllowed(policy, route.source, route.providerRef)) {
      throw new IntegrationContractError('provider_denied', 'This integration is not available to the current agent.');
    }
    if (!isIntegrationProviderOperationAllowed(policy, route.source, route.providerRef, request.action)
      || integrationPolicyAllowedToolNames(policy, route.source, route.providerRef)?.includes(route.toolName) === false) {
      throw new IntegrationContractError('tool_denied', 'This tool operation is not enabled for the current agent.');
    }
    const shared = await findSharedIntegrationConnectionAuthorization(context, route.providerRef, 'use', route.toolName);
    await assertSharedProviderPolicy(context, policy, shared, route.providerRef, request.action, route.toolName);
    assertPersonalProviderPolicy(context, policy, route.providerRef, request.action, route.toolName);
    const adapter = await this.adapter(route.source);
    const resolved = await adapter.resolveProvider(context, route.providerRef);
    assertProviderAllowed(context, policy, resolved, route.providerRef);
    if (!isIntegrationToolAllowed(context, policy, resolved.provider, route.toolName, request.action)) {
      throw new IntegrationContractError('tool_denied', 'This tool is not available to the current agent.');
    }

    if (request.action === 'describe') {
      const tool = structuredClone(await adapter.describeTool(context, resolved, route.toolName, signal));
      if (tool.name !== route.toolName) throw new IntegrationContractError('tool_not_found', 'The selected tool is no longer available.');
      await validateIntegrationSchema(tool.inputSchema);
      if (tool.outputSchema !== undefined) await validateIntegrationSchema(tool.outputSchema);
      const schemaRef = createIntegrationSchemaRef({
        context, policy, providerRef: route.providerRef, bindingRevision: schemaBindingRevision(context, resolved),
        toolName: route.toolName, toolVersion: tool.toolVersion,
        inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
      });
      this.schemas.set(`${namespace}:${schemaRef}`, {
        route: { ...route }, schemaRef, bindingRevision: resolved.bindingRevision,
        authorizationRevision: getIntegrationProviderAuthorization(context, resolved.provider)?.authorizationRevision,
        application: resolved.provider.application,
        contextFingerprint: currentPolicyFingerprint(context, policy), tool: structuredClone(tool),
      });
      await revalidateIntegrationProviderAuthorization(context, resolved.provider, 'use', route.toolName);
      return {
        version: INTEGRATION_CONTRACT_VERSION, toolRef: request.toolRef, providerRef: route.providerRef,
        schemaRef, toolVersion: tool.toolVersion, inputSchema: structuredClone(tool.inputSchema),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: structuredClone(tool.outputSchema) }),
        skillRefs: resolved.provider.skillRefs,
        nextActions: tool.inputSchema !== false && resolved.provider.canExecute && isIntegrationToolAllowed(context, policy, resolved.provider, route.toolName, 'call')
          ? [{ kind: 'input_required', label: 'Supply the schema arguments and execute this tool',
            request: { action: 'call', toolRef: request.toolRef, schemaRef },
            requiredArguments: typeof tool.inputSchema === 'object' && Array.isArray(tool.inputSchema.required)
              ? tool.inputSchema.required.filter((key): key is string => typeof key === 'string') : [] }]
          : [],
      };
    }

    const issued = this.schemas.get(`${namespace}:${request.schemaRef}`);
    if (!issued || issued.route.providerRef !== route.providerRef || issued.route.toolName !== route.toolName
      || issued.contextFingerprint !== currentPolicyFingerprint(context, policy)) {
      throw new IntegrationContractError('schema_changed', 'Load the current tool schema before executing.');
    }
    if (issued.bindingRevision !== resolved.bindingRevision) {
      throw new IntegrationContractError('binding_changed', 'The selected connection changed. Load the tool schema again.');
    }
    if (issued.authorizationRevision !== getIntegrationProviderAuthorization(context, resolved.provider)?.authorizationRevision) {
      throw new IntegrationContractError('binding_changed', 'The shared integration grants changed. Load the tool schema again.');
    }
    if (!resolved.provider.canExecute) {
      throw new IntegrationContractError('provider_unavailable', 'Complete the selected integration connection before executing.');
    }
    const current = structuredClone(await adapter.describeTool(context, resolved, route.toolName, signal));
    await validateIntegrationSchema(current.inputSchema);
    if (current.outputSchema !== undefined) await validateIntegrationSchema(current.outputSchema);
    if (schemaFingerprint(current) !== schemaFingerprint(issued.tool)) {
      throw new IntegrationContractError('schema_changed', 'The provider changed this tool. Load its schema again.');
    }
    const args = request.arguments;
    await validateIntegrationArguments(current.inputSchema, args);
    const beforeDispatch = async () => {
      await beforeToolCall?.();
      if (!isIntegrationToolAllowed(context, policy, resolved.provider, route.toolName, 'call')) {
        throw new IntegrationContractError('tool_denied', 'This tool is not available to the current agent.');
      }
      await revalidateIntegrationProviderAuthorization(context, resolved.provider, 'use', route.toolName);
    };
    await beforeDispatch();
    signal?.throwIfAborted();
    const result = await adapter.callTool(context, resolved, current, args, { toolCallId, signal, beforeDispatch, policy });
    return {
      version: INTEGRATION_CONTRACT_VERSION, target: 'result', toolRef: request.toolRef,
      providerRef: route.providerRef, source: route.source, displayName: resolved.provider.displayName, result,
    };
  }
}

/** References survive successive tool calls/turns, but expire and are re-authorized on every use. */
const dispatcherHost = globalThis as typeof globalThis & { __canvasIntegrationDispatcherV1?: IntegrationDispatcher };
export const integrationDispatcher = dispatcherHost.__canvasIntegrationDispatcherV1 ??= new IntegrationDispatcher();
