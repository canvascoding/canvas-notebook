import { Buffer } from 'node:buffer';

import { openDb } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { runWithAgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { piTools } from '../app/lib/pi/core-tools';

type DriverInput = {
  toolName: 'read' | 'write' | 'edit_file' | 'apply_patch' | 'edit_excalidraw_scene';
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
  if (process.argv[2] === '--persistent') {
    await persistentMain();
    process.exit(0);
  }
  const request = input();
  const result = await executeTool(request);
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

async function executeTool(request: DriverInput): Promise<unknown> {
  const tool = piTools.find((candidate) => candidate.name === request.toolName);
  if (!tool) throw new Error(`Unknown tool: ${request.toolName}`);
  await ensureStoredAgentSession(request.context);
  return runWithAgentExecutionContext(
    request.context,
    () => tool.execute(request.toolCallId, request.params),
  );
}

async function writeProtocol(value: unknown): Promise<void> {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error('Persistent driver output limit exceeded.');
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve());
  });
}

async function persistentMain(): Promise<void> {
  // Test-only stdin transport: sequential calls, one fixed execution scope,
  // bounded records and bytes. Each call still verifies its real API session.
  await writeProtocol({ driverProtocol: 1, type: 'ready' });
  let pending = '';
  let count = 0;
  let contextKey: string | undefined;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    pending += chunk;
    if (Buffer.byteLength(pending) > 2 * 1024 * 1024) throw new Error('Persistent driver input limit exceeded.');
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) throw new Error('Persistent driver requires an NDJSON request.');
      if (++count > 64) throw new Error('Persistent driver request limit exceeded.');
      const request = JSON.parse(line) as DriverInput;
      if (!request || typeof request !== 'object' || !request.context
        || typeof request.toolCallId !== 'string' || !/^version-center-browser-[a-f0-9-]{36}$/u.test(request.toolCallId)
        || !['read', 'edit_file'].includes(request.toolName)
        || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
        throw new Error('Invalid persistent driver request.');
      }
      const nextContextKey = JSON.stringify(request.context);
      if (contextKey !== undefined && contextKey !== nextContextKey) throw new Error('Persistent driver scope changed.');
      contextKey = nextContextKey;
      const result = await executeTool(request);
      await writeProtocol({ driverProtocol: 1, type: 'result', toolCallId: request.toolCallId, result });
    }
  }
  if (pending.length) throw new Error('Persistent driver request must end with a newline.');
}

void main().catch((error) => {
  console.error(process.argv[2] === '--persistent'
    ? 'Persistent collaboration test driver failed.'
    : error instanceof Error ? error.message : String(error));
  process.exit(1);
});
