import 'server-only';

import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { getIntegrationProviderCatalog, type IntegrationCatalogAdapters } from './catalog';
import {
  INTEGRATION_CONTRACT_VERSION,
  IntegrationContractError,
  parseIntegrationRequest,
  type IntegrationExecutionContext,
  type IntegrationPolicy,
  type IntegrationProviderPage,
  type IntegrationSource,
  type IntegrationToolDescriptor,
  type IntegrationToolPage,
  type IntegrationToolSchema,
} from './contracts';
import { isIntegrationOperationAllowed, isIntegrationProviderVisible, isIntegrationToolAllowed } from './policy';
import { IntegrationReferenceCache } from './reference-cache';
import { createIntegrationToolRef } from './references';
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
  return schemaFingerprint([context.actorUserId, context.organizationId || null, context.workspaceId || null, context.agentId || null]);
}

function currentPolicyFingerprint(context: IntegrationExecutionContext, policy: IntegrationPolicy): string {
  return schemaFingerprint({ context, policy });
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

/** The adapter owns authentication; a loaded route or schema never grants execution rights. */
export class IntegrationDispatcher {
  private readonly routes: IntegrationReferenceCache<ToolRoute>;
  private readonly schemas: IntegrationReferenceCache<IssuedSchema>;

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

  async execute(input: {
    context: IntegrationExecutionContext;
    policy: IntegrationPolicy;
    request: unknown;
    toolCallId: string;
    signal?: AbortSignal;
    preferredSource?: IntegrationSource;
    confirmedProviderRefs?: readonly string[];
  }): Promise<IntegrationDispatchResult> {
    const parsedRequest = parseIntegrationRequest(input.request);
    const request = parsedRequest.action === 'call'
      ? { ...parsedRequest, arguments: cloneIntegrationArguments(parsedRequest.arguments) }
      : { ...parsedRequest };
    // Capture a single server-resolved context and policy; do not accept either from tool arguments.
    const context = { ...input.context };
    const policy = structuredClone(input.policy);
    const signal = input.signal;
    const toolCallId = input.toolCallId;
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
      if (!isIntegrationOperationAllowed(policy, source, operation)) {
        throw new IntegrationContractError('tool_denied', 'Tool discovery is not enabled for this integration source.');
      }
      const adapter = await this.adapter(source);
      const resolved = await adapter.resolveProvider(context, request.providerRef);
      assertProviderAllowed(context, policy, resolved, request.providerRef);
      const page = await adapter.listTools(context, resolved, {
        query: request.action === 'search' ? request.query : undefined,
        limit: request.limit ?? 12, cursor: request.cursor, signal, allowedToolNames: policy.allowedToolNames,
      });
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
    if (!isIntegrationOperationAllowed(policy, route.source, request.action)) {
      throw new IntegrationContractError('tool_denied', 'This tool operation is not enabled for the current agent.');
    }
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
        context, policy, providerRef: route.providerRef, bindingRevision: resolved.bindingRevision,
        toolName: route.toolName, toolVersion: tool.toolVersion,
        inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
      });
      this.schemas.set(`${namespace}:${schemaRef}`, {
        route: { ...route }, schemaRef, bindingRevision: resolved.bindingRevision,
        contextFingerprint: currentPolicyFingerprint(context, policy), tool: structuredClone(tool),
      });
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
    signal?.throwIfAborted();
    const result = await adapter.callTool(context, resolved, current, args, { toolCallId, signal });
    return {
      version: INTEGRATION_CONTRACT_VERSION, target: 'result', toolRef: request.toolRef,
      providerRef: route.providerRef, source: route.source, displayName: resolved.provider.displayName, result,
    };
  }
}

/** References survive successive tool calls/turns, but expire and are re-authorized on every use. */
const dispatcherHost = globalThis as typeof globalThis & { __canvasIntegrationDispatcherV1?: IntegrationDispatcher };
export const integrationDispatcher = dispatcherHost.__canvasIntegrationDispatcherV1 ??= new IntegrationDispatcher();
