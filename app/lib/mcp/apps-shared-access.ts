import 'server-only';

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piMessages, piSessions } from '@/app/lib/db/schema';
import { resolveIntegrationExecutionContext } from '@/app/lib/integration-tools/context';
import type { IntegrationExecutionContext, IntegrationPolicy } from '@/app/lib/integration-tools/contracts';
import { mcpIntegrationToolAdapter } from '@/app/lib/integration-tools/adapters/mcp-runtime';
import { findSharedIntegrationConnectionAuthorization, getIntegrationProviderAuthorization,
  revalidateIntegrationProviderAuthorization } from '@/app/lib/integration-tools/connections/provider-authorization';
import { createSharedIntegrationPolicyDescriptor } from '@/app/lib/integration-tools/connections/provider-policy';
import { isIntegrationProviderToolRulesValid, isIntegrationToolAllowed } from '@/app/lib/integration-tools/policy';
import { resolveIntegrationRuntimePolicy } from '@/app/lib/integration-tools/runtime-policy';
import { schemaFingerprint } from '@/app/lib/integration-tools/schema';
import { readIntegrationToolGatewayAvailability } from '@/app/lib/integration-tool-gateway-availability';
import { attachAgentWorkflowRuntimeProjection, assertAgentWorkflowRuntimeReady } from '@/app/lib/agents/workflow-runtime';
import { McpAccessError } from './access';
import { readMcpAppDescriptor } from './apps-contracts';
import type { McpAppChat } from './apps-host';
import type { SharedMcpAppDescriptor } from './apps-types';
import { sharedMcpScope } from './shared-access';
import { sharedMcpAppBindingRevision } from './apps-shared-binding';

/** Stored only with the server-produced tool result. This is never browser authority. */
export type SharedMcpAppAuthority = {
  version: 1;
  context: IntegrationExecutionContext;
  policy: IntegrationPolicy;
  providerRef: string;
  bindingRevision: string;
};

function readSharedMcpAppAuthority(value: unknown): SharedMcpAppAuthority | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proof = value as Partial<SharedMcpAppAuthority>;
  const context = proof.context;
  const policy = proof.policy;
  const names = (items: unknown) => items === null || Array.isArray(items) && items.length <= 2048
    && items.every(item => typeof item === 'string' && item.trim() && item.length <= 256);
  if (proof.version !== 1 || typeof proof.providerRef !== 'string' || !proof.providerRef.startsWith('mcp:v1:shared:')
    || proof.providerRef.length > 256 || typeof proof.bindingRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(proof.bindingRevision)
    || !context || !policy || typeof context.actorUserId !== 'string' || !context.actorUserId
    || typeof context.sessionId !== 'string' || !context.sessionId || typeof context.agentId !== 'string' || !context.agentId
    || typeof context.workspaceId !== 'string' || !context.workspaceId
    || typeof context.policyRevision !== 'string' || !context.policyRevision.startsWith('integration-policy:v1:')
    || !names(policy.allowedSources) || !names(policy.allowedProviderRefs) || !names(policy.allowedApplications)
    || !names(policy.allowedToolNames) || !names(policy.allowedOperations) || !isIntegrationProviderToolRulesValid(policy.providerToolRules)) return null;
  return proof as SharedMcpAppAuthority;
}

/** Bind browser references to a successful saved invocation and fresh runtime authority before provider I/O. */
export async function requireSharedMcpAppAccess(chat: McpAppChat, app: SharedMcpAppDescriptor, targetToolName?: string, signal?: AbortSignal) {
  chat = { ...chat }; app = { ...app };
  signal?.throwIfAborted();
  if (!readIntegrationToolGatewayAvailability().integrationToolGatewayEnabled) throw new McpAccessError('Integrations are disabled.', 404);
  const session = await db.query.piSessions.findFirst({ where: and(eq(piSessions.sessionId, chat.sessionId),
    eq(piSessions.userId, chat.userId), eq(piSessions.agentId, chat.agentId), isNull(piSessions.archivedAt)) });
  if (!session) throw new McpAccessError('Chat is unavailable.', 403);
  const rows = await db.select({ content: piMessages.content }).from(piMessages).where(and(
    eq(piMessages.piSessionDbId, session.id), eq(piMessages.role, 'toolResult'),
    sql`${piMessages.content}::jsonb ->> 'toolCallId' = ${app.toolCallId}`,
  )).orderBy(desc(piMessages.id)).limit(1);
  if (!rows[0]) throw new McpAccessError('The tool result is not saved yet. Reload shortly.', 425);
  let authority: SharedMcpAppAuthority | null = null;
  try {
    const message = JSON.parse(rows[0].content);
    const details = message.details;
    const stored = readMcpAppDescriptor(details?.mcpApp);
    if (message.role === 'toolResult' && message.toolCallId === app.toolCallId && message.isError !== true
      && details?.isError !== true && details?.error === undefined && details?.result?.isError !== true
      && stored?.version === 2 && schemaFingerprint(stored) === schemaFingerprint(app)) {
      authority = readSharedMcpAppAuthority(details.mcpAppAuthority);
    }
  } catch { /* Invalid saved results never grant widget access. */ }
  if (!authority || authority.context.actorUserId !== chat.userId || authority.context.sessionId !== chat.sessionId
    || authority.context.agentId !== chat.agentId || authority.context.workspaceId !== session.workspaceId
    || authority.bindingRevision !== app.bindingRevision) throw new McpAccessError('App does not belong to this tool result.', 403);
  try {
    const resolved = await resolveIntegrationExecutionContext({ actorUserId: chat.userId, sessionId: chat.sessionId,
      agentId: chat.agentId, policyRevision: 'mcp-app-preflight' });
    const runtime = await resolveIntegrationRuntimePolicy({ executionContext: resolved.executionContext, ceiling: authority.policy });
    const context = { ...resolved.integrationContext, sessionId: chat.sessionId, policyRevision: runtime.policyRevision };
    if (schemaFingerprint(context) !== schemaFingerprint(authority.context)) {
      throw new McpAccessError('The agent or chat permissions changed. Run the tool again.', 409);
    }
    if (runtime.workflowProjection) attachAgentWorkflowRuntimeProjection(context, runtime.workflowProjection);
    const source = await findSharedIntegrationConnectionAuthorization(context, authority.providerRef, 'use', app.toolName);
    if (!source || source.resource.connectionRef !== app.connectionRef || source.backend.source !== 'mcp') {
      throw new McpAccessError('Shared app connection is unavailable.', 403);
    }
    const descriptor = await createSharedIntegrationPolicyDescriptor(context, source);
    for (const name of new Set([app.toolName, ...(targetToolName ? [targetToolName] : [])])) {
      if (!isIntegrationToolAllowed(context, runtime.policy, descriptor, name, 'call')) throw new McpAccessError('This app tool is not permitted.', 403);
      await revalidateIntegrationProviderAuthorization(context, descriptor, 'use', name);
    }
    // A current issued provider supplies the private backend; client IDs never select it.
    const provider = await mcpIntegrationToolAdapter.resolveProvider(context, authority.providerRef);
    const authorization = getIntegrationProviderAuthorization(context, provider.provider);
    if (!authorization || !provider.provider.canExecute || sharedMcpAppBindingRevision(provider.bindingRevision) !== app.bindingRevision
      || authorization.resource.connectionRef !== app.connectionRef || authorization.backend.source !== 'mcp') {
      throw new McpAccessError('The shared connection changed. Run the tool again.', 409);
    }
    await assertAgentWorkflowRuntimeReady({ context, policy: runtime.policy, projection: runtime.workflowProjection, signal });
    // Readiness can await other providers. Hold neither its earlier runtime
    // policy nor an account snapshot through that I/O without checking again.
    const currentProvider = await mcpIntegrationToolAdapter.resolveProvider(context, authority.providerRef);
    if (sharedMcpAppBindingRevision(currentProvider.bindingRevision) !== app.bindingRevision || !currentProvider.provider.canExecute) {
      throw new McpAccessError('The shared connection changed. Run the tool again.', 409);
    }
    const current = await resolveIntegrationExecutionContext({ actorUserId: chat.userId, sessionId: chat.sessionId,
      agentId: chat.agentId, policyRevision: 'mcp-app-final-preflight' });
    const finalRuntime = await resolveIntegrationRuntimePolicy({ executionContext: current.executionContext, ceiling: authority.policy });
    if (schemaFingerprint({ ...current.integrationContext, sessionId: chat.sessionId, policyRevision: finalRuntime.policyRevision })
      !== schemaFingerprint(authority.context)) throw new McpAccessError('The agent or chat permissions changed. Run the tool again.', 409);
    signal?.throwIfAborted();
    const binding = currentProvider.binding as { environmentRevision?: unknown };
    if (typeof binding.environmentRevision !== 'string' || !binding.environmentRevision) throw new McpAccessError('Shared app credentials are unavailable.', 409);
    return { connectionId: authorization.backend.connectionId, scope: sharedMcpScope(authorization, app.toolName),
      workspaceId: resolved.executionContext.workspaceId, environmentRevision: binding.environmentRevision };
  } catch (error) {
    if (error instanceof McpAccessError) throw error;
    throw new McpAccessError('Current shared app permissions could not be verified.',
      (error as { code?: unknown })?.code === 'binding_changed' ? 409 : 403);
  }
}
