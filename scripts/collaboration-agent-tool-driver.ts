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
  // Browser tests create the session through the normal authenticated API.
  // This worker must not manufacture a runtime/session configuration in SQL.
  const database = await openDb();
  try {
    const existing = await database.get(
      `SELECT 1 FROM pi_sessions
       WHERE session_id = $1 AND user_id = $2 AND agent_id = $3
         AND workspace_id = $4 AND archived_at IS NULL
       LIMIT 1`,
      [context.sessionId, context.userId, context.agentId || 'canvas-agent', context.workspaceId],
    );
    if (!existing) throw new Error('Create the scoped agent session through /api/sessions before running an E2E tool.');
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
