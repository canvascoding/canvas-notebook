import { Buffer } from 'node:buffer';

import { openDb } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { runWithAgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { piTools } from '../app/lib/pi/core-tools';

type DriverInput = {
  toolName: 'read' | 'edit_file' | 'apply_patch' | 'edit_excalidraw_scene';
  toolCallId: string;
  params: Record<string, unknown>;
  context: AgentExecutionContext;
};

function input(): DriverInput {
  const encoded = process.argv[2]?.trim();
  if (!encoded) throw new Error('Expected a base64url-encoded collaboration agent tool payload.');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as DriverInput;
}

async function ensureStoredAgentSession(context: AgentExecutionContext): Promise<void> {
  // This driver is used only by the collaboration E2E suite. The production
  // accept path deliberately requires an already-persisted PI session.
  const database = await openDb();
  try {
    const existing = await database.get(
      `SELECT 1 FROM pi_sessions
       WHERE session_id = ? AND user_id = ? AND agent_id = ?
       LIMIT 1`,
      [context.sessionId, context.userId, context.agentId || 'canvas-agent'],
    );
    if (existing) return;

    const now = Date.now();
    await database.run(
      `INSERT INTO pi_sessions (
         session_id, user_id, agent_id, provider, model, title,
         created_at, updated_at, channel_id, session_kind, delegation_depth,
         organization_id, customer_id, project_id, workspace_id, workspace_type,
         workspace_name, workspace_root_relative_path
       ) VALUES (?, ?, ?, 'test', 'test', 'Collaboration E2E agent',
         ?, ?, 'app', 'conversation', 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        context.sessionId,
        context.userId,
        context.agentId || 'canvas-agent',
        now,
        now,
        context.organizationId,
        context.customerId,
        context.projectId,
        context.workspaceId,
        context.workspaceType,
        context.workspaceName,
        context.workspaceRootRelativePath,
      ],
    );
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  const request = input();
  const tool = piTools.find((candidate) => candidate.name === request.toolName);
  if (!tool) throw new Error(`Unknown tool: ${request.toolName}`);
  await ensureStoredAgentSession(request.context);
  const result = await runWithAgentExecutionContext(
    request.context,
    () => tool.execute(request.toolCallId, request.params),
  );
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
