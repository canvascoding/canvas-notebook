import 'server-only';

import { createHash } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { authorizeIntegrationConnection, authorizeIntegrationConnectionBindingsOnConnection,
  lockIntegrationConnectionBindingsOnConnection, type IntegrationConnectionBindingAuthorization } from '@/app/lib/integration-tools/connections/store';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import type { AgentManagementActor } from './management-actions';
import { readManagedAgentWorkflow, readManagedAgentWorkflowOnConnection } from './workflow-configuration';
import { AgentWorkflowError, type AgentWorkflowInternalSnapshot } from './workflow-contracts';
import { EMAIL_MANAGED_AGENT_ID } from './storage';
import type { AgentExtensionOptionsTarget } from './extension-options-contracts';

export type AgentExtensionOptionsContext = {
  actor: AgentManagementActor;
  target: AgentExtensionOptionsTarget;
  organizationId: string | null;
  scopeType: 'user' | 'organization' | 'system';
  allowPersonal: boolean;
  contextKey: string;
  snapshot?: AgentWorkflowInternalSnapshot;
};

const proofKey = Symbol.for('canvas.agent.extension-options-context.v1');
const proofHost = globalThis as typeof globalThis & { [proofKey]?: WeakSet<object> };
const issuedContexts = proofHost[proofKey] ??= new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code: string, message: string, status = 409): never { throw new AgentWorkflowError(code, message, status); }

/** Resolve actual actor/target authority; a prospective target never creates an agent or a grant. */
export async function resolveAgentExtensionOptionsContext(actorInput: AgentManagementActor,
  targetInput: AgentExtensionOptionsTarget, options: { database?: SqlConnection } = {}): Promise<AgentExtensionOptionsContext> {
  const captured = structuredClone(actorInput), target = structuredClone(targetInput), database = options.database ?? await openDb();
  let organizationId: string | null, organizationRole: string | null, actor: AgentManagementActor;
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(captured, database);
    organizationId = verified.organizationId; organizationRole = verified.organizationRole;
    actor = { ...captured, organizationId, workspaceId: verified.context.workspaceId ?? null, projectId: verified.context.projectId ?? null };
  } finally { if (!options.database) await database.close(); }
  let snapshot: AgentWorkflowInternalSnapshot | undefined;
  if (target.kind === 'prospective') {
    if (target.scopeType === 'organization' && (!organizationId || !['owner', 'admin'].includes(organizationRole ?? ''))) {
      fail('AGENT_ORGANIZATION_ADMIN_REQUIRED', 'Organization administration is required to create an organization agent.', 403);
    }
  } else {
    snapshot = await readManagedAgentWorkflow(actor, target.agentId, options);
    if (target.kind === 'existing') {
      if (!snapshot.access.canEdit) fail('AGENT_ACCESS_DENIED', 'Current agent editing permission is required.', 403);
      if (snapshot.agent.type === 'main') fail('AGENT_MAIN_PROTECTED', 'The main agent is configured through organization policy.', 403);
      if (snapshot.agent.agentId === EMAIL_MANAGED_AGENT_ID && !['owner', 'admin'].includes(organizationRole ?? '')) {
        fail('AGENT_ORGANIZATION_ADMIN_REQUIRED', 'Organization administration is required to configure the email agent.', 403);
      }
      if (snapshot.agent.revision !== target.expectedRevision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent changed. Reload its configuration.');
    } else {
      if (!snapshot.access.canUse) fail('AGENT_ACCESS_DENIED', 'Current agent use is required to choose your own connection.', 403);
      if (snapshot.preferenceRevision !== target.expectedPreferenceRevision) fail('AGENT_WORKFLOW_PREFERENCE_CONFLICT', 'Your connection choice changed. Reload it.');
    }
    if (snapshot.workflowRevision !== target.expectedWorkflowRevision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed. Reload it.');
  }
  const scopeType = snapshot?.agent.scopeType ?? (target.kind === 'prospective' ? target.scopeType : 'user');
  const contextKey = createHash('sha256').update(JSON.stringify([actor.userId, organizationId, organizationRole,
    actor.workspaceId, actor.projectId, actor.sourceAgentId ?? null, actor.sessionId ?? null, target,
    snapshot?.agent.id ?? null, snapshot?.agent.revision ?? null, snapshot?.workflowRevision ?? null,
    snapshot?.preferenceRevision ?? null])).digest('base64url');
  const context = freeze({ actor, target, organizationId, scopeType,
    allowPersonal: scopeType === 'user' || target.kind === 'user_choice', contextKey, snapshot });
  issuedContexts.add(context);
  return context;
}

/** Metadata is rechecked after remote IO. Context fingerprints are cache keys, never permission tokens. */
export async function revalidateAgentExtensionOptionsContext(context: AgentExtensionOptionsContext,
  options: { database?: SqlConnection } = {}): Promise<void> {
  if (!issuedContexts.has(context)) fail('AGENT_ACCESS_DENIED', 'A current server-issued selection context is required.', 403);
  const fresh = await resolveAgentExtensionOptionsContext(context.actor, context.target, options);
  if (fresh.contextKey !== context.contextKey) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The current selection context changed. Start the selection again.');
}

/** Exact shared use for a real persisted target, or ordinary actor use before a target exists. */
export async function authorizeAgentExtensionSharedOption(context: AgentExtensionOptionsContext,
  reference: string): Promise<IntegrationConnectionBindingAuthorization> {
  await revalidateAgentExtensionOptionsContext(context);
  if (context.target.kind === 'prospective') {
    const actual = await authorizeIntegrationConnection({ userId: context.actor.userId,
      organizationId: context.organizationId, workspaceId: context.actor.workspaceId }, reference, 'use');
    await revalidateAgentExtensionOptionsContext(context);
    return { ...actual, canUse: actual.access.canUse, canManage: actual.access.canManage };
  }
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(context.actor, database, { lock: true });
    if (verified.organizationId !== context.organizationId) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The organization changed.');
    const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: context.actor.userId,
      organizationId: context.organizationId, ...verified.context }, [reference]);
    await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [context.target.agentId]);
    const current = await readManagedAgentWorkflowOnConnection(database, context.target.agentId);
    if (!context.snapshot || current.agent.id !== context.snapshot.agent.id || current.agent.revision !== context.snapshot.agent.revision
      || current.workflowRevision !== context.snapshot.workflowRevision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent changed. Reload its options.');
    const [binding] = await authorizeIntegrationConnectionBindingsOnConnection(database, batch, current.agent,
      context.target.kind === 'user_choice' ? 'read' : 'configure');
    await database.run('COMMIT');
    return binding;
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error; }
  finally { await database.close(); }
}

/** Candidate IDs stay private until actual target authorization succeeds, including target-only grants. */
export async function listAgentExtensionSharedOptions(context: AgentExtensionOptionsContext,
  source?: 'mcp' | 'composio'): Promise<IntegrationConnectionBindingAuthorization[]> {
  await revalidateAgentExtensionOptionsContext(context);
  if (context.target.kind === 'user_choice') fail('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose only from the exact stored slot.', 403);
  if (!context.organizationId) return [];
  const database = await openDb();
  let refs: string[];
  try {
    const rows = await database.all(`SELECT connection_ref FROM integration_connection_resources
      WHERE organization_id=$1 AND status='active'${source ? ' AND source=$2' : ''}
      ORDER BY connection_ref LIMIT 1025`, [context.organizationId, ...(source ? [source] : [])]) as Array<{ connection_ref: string }>;
    if (rows.length > 1024) fail('AGENT_WORKFLOW_OPTIONS_UNAVAILABLE', 'The shared connection catalogue exceeds this selection window.', 503);
    refs = rows.map(row => row.connection_ref);
  } finally { await database.close(); }
  const result: IntegrationConnectionBindingAuthorization[] = [];
  for (const reference of refs) {
    try { result.push(await authorizeAgentExtensionSharedOption(context, reference)); }
    catch (error) { if (!isIntegrationConnectionError(error) || ![403, 404].includes(error.status)) throw error; }
  }
  await revalidateAgentExtensionOptionsContext(context);
  return result;
}
