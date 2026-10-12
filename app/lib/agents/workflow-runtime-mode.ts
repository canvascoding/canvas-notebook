import 'server-only';

import { openDb } from '@/app/lib/db';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import type { AgentManagementActor } from './management-actions';
import { AgentWorkflowError } from './workflow-contracts';
import { normalizeManagedAgentId } from './registry';

/** Server actor identity, never taken from tool arguments or user preferences. */
export function agentWorkflowRuntimeActor(context: AgentExecutionContext): AgentManagementActor {
  if (!context.userId.trim() || !context.agentId?.trim() || !context.sessionId.trim() || !context.workspaceId.trim()) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_ACCESS_DENIED', 'A current agent session and workspace are required.', 403);
  }
  return { userId: context.userId, sessionId: context.sessionId, source: 'system', sourceAgentId: context.agentId,
    organizationId: context.organizationId, workspaceId: context.workspaceId, projectId: context.projectId };
}

/** SQL authority only. Registry construction must not discover provider accounts or tools. */
export async function getRuntimeAgentWorkflowMode(context: AgentExecutionContext): Promise<1 | null> {
  const agentId = normalizeManagedAgentId(context.agentId);
  const database = await openDb();
  try {
    const row = await database.get('SELECT workflow_version,workflow_revision FROM agents WHERE agent_id=$1', [agentId]) as
      { workflow_version?: unknown; workflow_revision?: unknown } | undefined;
    if (!row || !Number.isSafeInteger(Number(row.workflow_revision)) || Number(row.workflow_revision) < 0
      || row.workflow_version !== null && Number(row.workflow_version) !== 1) {
      throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The current agent workflow cannot be verified.', 409);
    }
    if (row.workflow_version === null) {
      const inconsistent = await database.get('SELECT id FROM agent_capability_bindings WHERE agent_id=$1 AND configuration_json IS NOT NULL LIMIT 1', [agentId]);
      if (inconsistent) throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The current agent workflow cannot be verified.', 409);
      return null;
    }
  } finally { await database.close(); }
  const { readManagedAgentWorkflow, isManagedAgentWorkflowSnapshot } = await import('./workflow-configuration');
  const snapshot = await readManagedAgentWorkflow(agentWorkflowRuntimeActor(context), agentId);
  if (!isManagedAgentWorkflowSnapshot(snapshot) || !snapshot.access.canUse || snapshot.agent.agentId !== agentId
    || ![null, 1].includes(snapshot.workflowVersion)) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The current agent workflow cannot be verified.', 409);
  }
  return snapshot.workflowVersion;
}
