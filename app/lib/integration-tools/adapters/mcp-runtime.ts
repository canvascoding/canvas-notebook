import 'server-only';

import type { Tool } from '@modelcontextprotocol/client';

import { assertMcpConnectionAccess } from '@/app/lib/mcp/access';
import { filterMcpToolsForModel } from '@/app/lib/mcp/apps-metadata';
import { hashMcpAuthConfig } from '@/app/lib/mcp/connection-identity';
import { listMcpTools, callMcpToolWithCurrentMetadata, hashMcpServerConfig } from '@/app/lib/mcp/manager';
import { readMcpOAuthLifecycle } from '@/app/lib/mcp/oauth-lifecycle';
import { listMcpServerDefinitions } from '@/app/lib/mcp/server-definitions';
import type { McpScope } from '@/app/lib/mcp/scope';
import { prepareMcpToolInvocation } from '@/app/lib/mcp/tool-result';
import { assertUnifiedEnvReadable, readUnifiedEnvState } from '@/app/lib/secrets/unified-env-store';
import { IntegrationContractError, INTEGRATION_MAX_PAGE_SIZE, type IntegrationExecutionContext } from '../contracts';
import { readIntegrationContractErrorCode } from '../agent-errors';
import { createIntegrationProviderRef } from '../references';
import type { IntegrationAdapterTool, IntegrationAdapterToolSchema, IntegrationResolvedProvider, IntegrationToolAdapter } from '../runtime-contracts';
import { createIntegrationMetadataCacheKey, integrationMetadataCache } from '../metadata-cache';
import { schemaFingerprint } from '../schema';
import { listMcpIntegrationProviders, resolveSharedMcpIntegrationProvider } from './mcp';
import { findSharedIntegrationConnectionAuthorization, integrationProviderAllowedToolNames,
  revalidateIntegrationProviderAuthorization } from '../connections/provider-authorization';

const CURSOR_MAX_AGE_MS = 15 * 60_000;
type McpRuntimeBinding = {
  connectionId: string;
  serverName: string;
  scope: McpScope;
  configAuthHash: string;
  configHash: string;
  environmentRevision: string;
  workflowIdentity?: { ownerUserId: string; connectionId: string; serverDefinitionId: string | null; fingerprint: string };
};
type McpDescriptionCatalog = { tools: IntegrationAdapterTool[]; revision: string };

function denied(): IntegrationContractError {
  return new IntegrationContractError('provider_denied', 'This MCP connection is not available in the current integration context.');
}

async function resolveProvider(context: IntegrationExecutionContext, providerRef: string): Promise<IntegrationResolvedProvider> {
  if (providerRef.startsWith('mcp:v1:personal:')) {
    return (await import('../workflow-personal-bindings')).resolveAttachedPersonalWorkflowProvider(context, providerRef);
  }
  const authorization = await findSharedIntegrationConnectionAuthorization(context, providerRef);
  if (authorization) {
    const current = await resolveSharedMcpIntegrationProvider(context, authorization, 'use');
    const resource = current.resolved.authorization.resource;
    const { connection, scope, serverName, environmentRevision, authGeneration, authorizationState } = current.resolved;
    const configAuthHash = hashMcpAuthConfig(connection);
    const configHash = hashMcpServerConfig(connection);
    return { provider: current.provider,
      bindingRevision: schemaFingerprint([resource.connectionRef, resource.ownership,
        resource.metadataRevision, resource.grantsRevision, resource.bindingRevision,
        resource.allowedToolNames, current.resolved.authorization.backend,
        configAuthHash, configHash, connection.enabled, connection.authVersion, environmentRevision, authGeneration, authorizationState]),
      binding: { connectionId: connection.connectionId, serverName, scope, configAuthHash, configHash, environmentRevision } satisfies McpRuntimeBinding,
    };
  }
  const snapshot = await listMcpIntegrationProviders(context);
  const provider = snapshot.providers.find(item => item.providerRef === providerRef && item.configured && item.scope.type === 'user');
  if (!provider || provider.scope.type !== 'user' || provider.scope.ownerUserId !== context.actorUserId) throw denied();
  const requestedScope: McpScope = { userId: context.actorUserId, organizationId: context.organizationId || null };
  const { serverName, connection, actor } = await assertMcpConnectionAccess(provider.scope.resourceId, requestedScope, { allowDisabled: true });
  if (!actor || !connection.connectionId || connection.ownerUserId !== actor.userId) throw denied();
  const currentRef = createIntegrationProviderRef({ source: 'mcp', scope: {
    type: 'user', resourceId: connection.connectionId, ownerUserId: actor.userId,
  }, connectionId: connection.connectionId });
  if (currentRef !== providerRef) throw denied();
  const credentialScope: McpScope = { userId: actor.userId, organizationId: connection.organizationId || null };
  const [lifecycle, environment, definitions] = await Promise.all([
    readMcpOAuthLifecycle(connection.connectionId, credentialScope),
    readUnifiedEnvState({ secretScope: 'user', userId: actor.userId }),
    connection.serverDefinitionId && connection.organizationId ? listMcpServerDefinitions(connection.organizationId) : Promise.resolve([]),
  ]);
  assertUnifiedEnvReadable(environment);
  const definition = connection.serverDefinitionId ? definitions.find(item => item.id === connection.serverDefinitionId) : null;
  if (connection.serverDefinitionId && !definition?.enabled) throw denied();
  const configAuthHash = hashMcpAuthConfig(connection);
  const configHash = hashMcpServerConfig(connection);
  return {
    provider,
    bindingRevision: schemaFingerprint({
      context, connectionId: connection.connectionId, ownerUserId: connection.ownerUserId,
      organizationId: connection.organizationId || null, enabled: connection.enabled !== false,
      configAuthHash, configHash, authVersion: connection.authVersion || 1, authGeneration: lifecycle.generation,
      environmentRevision: environment.revision, definitionRevision: definition?.revision || null,
      definitionConfig: definition?.config || null,
    }),
    binding: { connectionId: connection.connectionId, serverName, scope: credentialScope, configAuthHash, configHash, environmentRevision: environment.revision,
      workflowIdentity: { ownerUserId: actor.userId, connectionId: connection.connectionId, serverDefinitionId: connection.serverDefinitionId || null,
        fingerprint: schemaFingerprint([connection.connectionId, actor.userId, connection.organizationId || null,
          configAuthHash, connection.enabled !== false, connection.authVersion || 1, lifecycle.generation,
          environment.revision, definition?.enabled ?? null, definition?.revision ?? null, definition?.config || null]) } } satisfies McpRuntimeBinding,
  };
}

export async function inspectPersonalMcpIntegrationProvider(context: IntegrationExecutionContext, providerRef: string) {
  if (!providerRef.startsWith('mcp:v1:') || providerRef.includes(':personal:') || providerRef.includes(':shared:')) throw denied();
  const resolved = await resolveProvider(context, providerRef);
  const identity = (resolved.binding as McpRuntimeBinding).workflowIdentity;
  if (!identity || identity.ownerUserId !== context.actorUserId) throw denied();
  return { resolved, identity };
}

async function freshProvider(context: IntegrationExecutionContext, previous: IntegrationResolvedProvider) {
  const current = await resolveProvider(context, previous.provider.providerRef);
  if (current.bindingRevision !== previous.bindingRevision) {
    throw new IntegrationContractError('binding_changed', 'This MCP connection or its credentials changed. Discover its tools and schema again.');
  }
  if (!current.provider.canExecute) throw new IntegrationContractError('provider_unavailable', 'This MCP connection requires configuration or authorization before execution.');
  return current;
}

function asToolSchema(tool: Tool): IntegrationAdapterToolSchema {
  return {
    name: tool.name, description: tool.description || '', effect: tool.annotations?.readOnlyHint === true ? 'read' : 'unknown',
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
    // MCP does not provide a standard per-tool version. The concrete schema is
    // fingerprinted instead of inventing a version from the server's label.
    toolVersion: null,
  };
}

function comparableSchema(tool: IntegrationAdapterToolSchema) {
  return { name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, toolVersion: tool.toolVersion, effect: tool.effect };
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

function cursorOffset(cursor: string | undefined, binding: string): number {
  if (!cursor) return 0;
  const invalid = () => new IntegrationContractError('invalid_cursor', 'This tool page expired or its connection, schema or search changed. Start the search again.');
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw invalid();
    const record = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (record.version !== 1 || !Number.isSafeInteger(record.offset) || Number(record.offset) < 1
      || !Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) < Date.now()
      || Number(record.expiresAt) > Date.now() + CURSOR_MAX_AGE_MS
      || record.proof !== schemaFingerprint([binding, record.offset, record.expiresAt])) throw invalid();
    return Number(record.offset);
  } catch { throw invalid(); }
}

function createCursor(offset: number, binding: string): string {
  const expiresAt = Date.now() + CURSOR_MAX_AGE_MS;
  return Buffer.from(JSON.stringify({ version: 1, offset, expiresAt, proof: schemaFingerprint([binding, offset, expiresAt]) })).toString('base64url');
}

async function currentTools(context: IntegrationExecutionContext, previous: IntegrationResolvedProvider, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const provider = await freshProvider(context, previous);
  const binding = provider.binding as McpRuntimeBinding;
  const tools = filterMcpToolsForModel(await listMcpTools(binding.connectionId, { scope: binding.scope, signal }));
  await freshProvider(context, provider);
  return { provider, binding, tools };
}

export const mcpIntegrationToolAdapter: IntegrationToolAdapter = {
  source: 'mcp',
  resolveProvider,
  async listTools(context, previous, input) {
    await revalidateIntegrationProviderAuthorization(context, previous.provider, 'use');
    input = { ...input, allowedToolNames: integrationProviderAllowedToolNames(context, previous.provider, input.allowedToolNames) };
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > INTEGRATION_MAX_PAGE_SIZE) {
      throw new IntegrationContractError('invalid_request', 'Choose a tool page size between 1 and 50.');
    }
    if (input.allowedToolNames?.length === 0) {
      if (input.cursor) throw new IntegrationContractError('invalid_cursor', 'The permitted MCP tools changed. Start the search again.');
      return { tools: [], complete: true, providerErrors: [], nextCursor: null };
    }
    input.signal?.throwIfAborted();
    const provider = await freshProvider(context, previous);
    const binding = provider.binding as McpRuntimeBinding;
    const metadataKey = createIntegrationMetadataCacheKey({ context, source: 'mcp', providerRef: provider.provider.providerRef,
      revision: provider.bindingRevision, kind: 'tool_catalog' });
    let catalogue = integrationMetadataCache.get<McpDescriptionCatalog>(metadataKey);
    if (!catalogue) {
      const tools = filterMcpToolsForModel(await listMcpTools(binding.connectionId, { scope: binding.scope, signal: input.signal }));
      await freshProvider(context, provider);
      catalogue = { tools: tools.map(tool => ({ name: tool.name, description: (tool.description || '').slice(0, 500), effect: asToolSchema(tool).effect })),
        revision: schemaFingerprint(tools) };
      integrationMetadataCache.set(metadataKey, catalogue, { complete: true, signal: input.signal });
    }
    const query = normalized(input.query || '');
    const permitted = input.allowedToolNames ? new Set(input.allowedToolNames) : null;
    const scored = catalogue.tools.filter(tool => permitted === null || permitted.has(tool.name)).map(tool => {
      const name = normalized(tool.name);
      const description = normalized(tool.description || '');
      const matches = !query || query.split(' ').every(part => name.includes(part) || description.includes(part));
      const score = !query ? 0 : name === query ? 3 : name.includes(query) ? 2 : description.includes(query) ? 1 : 0;
      return { tool, score, matches };
    }).filter(item => item.matches).sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0));
    const pageBinding = schemaFingerprint({ context, providerRef: provider.provider.providerRef,
      bindingRevision: provider.bindingRevision, query, limit: input.limit,
      allowedToolNames: permitted ? [...permitted].sort() : null, catalogueRevision: catalogue.revision, catalogue: scored.map(({ tool }) => tool) });
    const offset = cursorOffset(input.cursor, pageBinding);
    if (offset > scored.length) throw new IntegrationContractError('invalid_cursor', 'This tool page is no longer available. Start the search again.');
    const page = scored.slice(offset, offset + input.limit);
    return {
      tools: page.map(({ tool }) => tool),
      complete: true, providerErrors: [],
      nextCursor: offset + page.length < scored.length ? createCursor(offset + page.length, pageBinding) : null,
    };
  },
  async describeTool(context, previous, toolName, signal) {
    await revalidateIntegrationProviderAuthorization(context, previous.provider, 'use', toolName);
    const { tools } = await currentTools(context, previous, signal);
    const tool = tools.find(item => item.name === toolName);
    if (!tool) throw new IntegrationContractError('tool_not_found', 'This MCP tool is no longer visible on the selected connection.');
    return asToolSchema(tool);
  },
  async callTool(context, previous, expectedTool, args, input) {
    await revalidateIntegrationProviderAuthorization(context, previous.provider, 'use', expectedTool.name);
    input.signal?.throwIfAborted();
    const provider = await freshProvider(context, previous);
    const binding = provider.binding as McpRuntimeBinding;
    let invocationStarted = false;
    try {
      const invocation = await callMcpToolWithCurrentMetadata(binding.connectionId, expectedTool.name, args, input.signal, binding.scope, {
        expectedEnvironmentRevision: binding.environmentRevision,
        validateTool: async (tool, connection) => {
          await freshProvider(context, provider);
          if (connection.connectionId !== binding.connectionId || hashMcpServerConfig(connection) !== binding.configHash) {
            throw new IntegrationContractError('binding_changed', 'This MCP connection changed before execution. Discover its tools again.');
          }
          if (schemaFingerprint(comparableSchema(asToolSchema(tool))) !== schemaFingerprint(comparableSchema(expectedTool))) {
            throw new IntegrationContractError('schema_changed', 'This MCP tool schema changed before execution. Describe the tool again.');
          }
          input.signal?.throwIfAborted();
        },
        beforeDispatch: async () => {
          await input.beforeDispatch?.();
          await revalidateIntegrationProviderAuthorization(context, provider.provider, 'use', expectedTool.name);
          input.signal?.throwIfAborted();
          invocationStarted = true;
        },
      });
      return await prepareMcpToolInvocation(binding.serverName, expectedTool.name, invocation, args, input.toolCallId);
    } catch (error) {
      if (readIntegrationContractErrorCode(error)) throw error;
      if ((error as { code?: unknown } | null)?.code === 'mcp_environment_binding_changed') {
        throw new IntegrationContractError('binding_changed', 'This MCP account changed before dispatch. Discover its tools and schema again.');
      }
      if (invocationStarted && expectedTool.effect !== 'read') {
        throw new IntegrationContractError('outcome_unknown', 'The MCP action may have executed, but its result could not be confirmed. Do not repeat it automatically.');
      }
      throw new IntegrationContractError('provider_unavailable', 'This MCP tool could not complete. Review the connection and try again when it is available.');
    }
  },
};
