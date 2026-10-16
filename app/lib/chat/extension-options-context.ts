import 'server-only';
import { createHash } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import type { AgentManagementActor } from '@/app/lib/agents/management-actions';
import { readManagedAgentWorkflow } from '@/app/lib/agents/workflow-configuration';
import { AgentWorkflowError, type AgentWorkflowInternalSnapshot } from '@/app/lib/agents/workflow-contracts';
import { readStoredAgentWorkspaceOnConnection } from '@/app/lib/pi/session-workspace-context';
import { lockIntegrationConnectionBindingsOnConnection, authorizeIntegrationConnectionBindingsOnConnection,
  type IntegrationConnectionBindingAuthorization } from '@/app/lib/integration-tools/connections/store';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { chatExtensionOptionsTargetSchema, type ChatExtensionOptionsTarget, type ChatExtensionOptionsHeader } from './extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS } from '@/app/lib/capabilities/extensions/contracts';

export type ChatExtensionOptionsContext = {
  actor: AgentManagementActor; target: ChatExtensionOptionsTarget; organizationId: string | null;
  scopeType: 'user' | 'organization' | 'system'; allowPersonal: true; contextKey: string;
  snapshot: AgentWorkflowInternalSnapshot;
};
const key = Symbol.for('canvas.chat.extension-options-context.v1');
const host = globalThis as typeof globalThis & { [key]?: WeakSet<object> };
const issued = host[key] ??= new WeakSet<object>();
const deny = (message: string): never => { throw new AgentWorkflowError('CHAT_EXTENSION_CONTEXT_DENIED', message, 403); };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** A real Use-only metadata frame. It creates neither a Session nor runtime authority. */
export async function resolveChatExtensionOptionsContext(actorInput: AgentManagementActor, targetInput: ChatExtensionOptionsTarget,
  options: { database?: SqlConnection } = {}): Promise<ChatExtensionOptionsContext> {
  const actor = structuredClone(actorInput), target = chatExtensionOptionsTargetSchema.parse(structuredClone(targetInput));
  const workspaceId = target.kind === 'draft_turn' ? target.workspaceId : target.expectedWorkspaceId;
  const agentId = target.kind === 'draft_turn' ? target.agentId : target.expectedAgentId;
  if (actor.workspaceId != null && actor.workspaceId !== workspaceId) deny('The requested workspace changed.');
  actor.workspaceId = workspaceId;
  const database = options.database ?? await openDb();
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(actor, database);
    if (!verified.workspacePermissions?.canRunAgent) deny('Current workspace agent execution permission is required.');
    if (target.kind === 'turn') {
      await readStoredAgentWorkspaceOnConnection(database, { userId: actor.userId, sessionId: target.sessionId, agentId, workspaceId, permissions: ['canRead', 'canRunAgent'] });
    }
    const scopedActor: AgentManagementActor = { ...actor, organizationId: verified.organizationId,
      workspaceId, projectId: verified.context.projectId ?? null };
    const snapshot = await readManagedAgentWorkflow(scopedActor, agentId, { database });
    if (!snapshot.access.canUse) deny('Current agent use is required.');
    const contextKey = createHash('sha256').update(JSON.stringify([actor.userId, actor.sessionId ?? null,
      verified.organizationId, verified.organizationRole, verified.workspacePermissions, workspaceId, scopedActor.projectId,
      target, snapshot.agent.id, snapshot.agent.revision, snapshot.workflowRevision, snapshot.preferenceRevision])).digest('base64url');
    const context = freeze({ actor: scopedActor, target, organizationId: verified.organizationId,
      scopeType: snapshot.agent.scopeType, allowPersonal: true as const, contextKey, snapshot });
    issued.add(context); return context;
  } finally { if (!options.database) await database.close(); }
}
export function isChatExtensionOptionsContext(context: unknown): context is ChatExtensionOptionsContext {
  return Boolean(context && typeof context === 'object' && issued.has(context));
}
export async function revalidateChatExtensionOptionsContext(context: ChatExtensionOptionsContext,
  options: { database?: SqlConnection } = {}): Promise<void> {
  if (!isChatExtensionOptionsContext(context)) deny('A genuine current Chat selection context is required.');
  const fresh = await resolveChatExtensionOptionsContext(context.actor, context.target, options);
  if (fresh.contextKey !== context.contextKey) throw new AgentWorkflowError('CHAT_EXTENSION_CONTEXT_CHANGED', 'The agent or current workspace changed. Reload the selection.', 409);
}
/** Target-only Use grants remain usable; editing and mapping-management are not requested for a turn. */
export async function authorizeChatExtensionSharedOption(context: ChatExtensionOptionsContext, reference: string): Promise<IntegrationConnectionBindingAuthorization> {
  await revalidateChatExtensionOptionsContext(context);
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(context.actor, database, { lock: true });
    const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: context.actor.userId,
      organizationId: verified.organizationId, ...verified.context }, [reference]);
    await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [context.snapshot.agent.agentId]);
    await revalidateChatExtensionOptionsContext(context, { database });
    const [authorization] = await authorizeIntegrationConnectionBindingsOnConnection(database, batch, context.snapshot.agent, 'read');
    await database.run('COMMIT'); return authorization;
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error; }
  finally { await database.close(); }
}
export async function listChatExtensionSharedOptions(context: ChatExtensionOptionsContext, source?: 'mcp' | 'composio') {
  await revalidateChatExtensionOptionsContext(context);
  if (!context.organizationId) return [];
  const database = await openDb();
  let rows: Array<{ connection_ref: string }>;
  try { rows = await database.all(`SELECT connection_ref FROM integration_connection_resources WHERE organization_id=$1 AND status='active'
    ${source ? 'AND source=$2' : ''} ORDER BY connection_ref LIMIT 1025`, [context.organizationId, ...(source ? [source] : [])]) as typeof rows; }
  finally { await database.close(); }
  if (rows.length > 1024) throw new AgentWorkflowError('CHAT_EXTENSION_OPTIONS_UNAVAILABLE', 'Narrow the shared source catalogue.', 503);
  const result: IntegrationConnectionBindingAuthorization[] = [];
  for (const row of rows) try { result.push(await authorizeChatExtensionSharedOption(context, row.connection_ref)); }
  catch (error) { if (!isIntegrationConnectionError(error) || ![403, 404].includes(error.status)) throw error; }
  await revalidateChatExtensionOptionsContext(context); return result;
}
export function chatExtensionOptionsHeader(context: ChatExtensionOptionsContext): ChatExtensionOptionsHeader {
  return { schemaVersion: 1, target: context.target, contextKey: context.contextKey,
    agentRevision: context.snapshot.agent.revision, workflowRevision: context.snapshot.workflowRevision,
    preferenceRevision: context.snapshot.preferenceRevision, coverage: [], limits: EXTENSION_SELECTION_LIMITS,
    finalSendValidationRequired: true };
}
