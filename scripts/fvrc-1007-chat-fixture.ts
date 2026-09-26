import 'server-only';

import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { DEFAULT_AGENT_ID } from '../app/lib/channels/constants';
import { closeDatabaseConnections } from '../app/lib/db';
import { fileChangeGroupService } from '../app/lib/file-version-center/change-group-service';
import { createRuntimeFileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { fileChangeToolApp } from '../app/lib/tool-apps/types';
import { readPostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import type { WorkspaceUserRole } from '../app/lib/workspaces/types';

type Input = { userId: string; role: WorkspaceUserRole; workspaceId: string; documentId: string;
  lineageId: string; filePath: string; operationId: string; sessionId: string; fixtureTitle: string };
let stage = 'validate';

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded || process.argv.length !== 3 || process.env.COLLABORATION_E2E !== '1') {
    throw new Error('A dedicated local browser fixture identity is required.');
  }
  const databaseUrl = new URL(process.env.DATABASE_URL || '');
  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Input;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname) || databaseUrl.port !== '55433'
    || !/^fvrc-1006-[0-9a-f-]{36}\.md$/u.test(input.filePath)
    || !/^FVRC-1007 browser review [0-9a-f-]{36}$/u.test(input.fixtureTitle)
    || !['owner', 'admin', 'member', 'external'].includes(input.role)) {
    throw new Error('The fixture is restricted to its managed loopback test scope.');
  }
  const workspace = await readPostgresWorkspaceForActor({ userId: input.userId, role: input.role }, input.workspaceId);
  if (!workspace || workspace.legacy || !workspace.permissions.canRead || !workspace.permissions.canWrite
    || !workspace.permissions.canRunAgent) throw new Error('The fixture workspace is not writable.');
  const database = createRuntimeFileVersionCenterDatabase();
  stage = 'binding';
  const binding = await database.transaction(sql => sql.query(`
    SELECT proposal.proposal_id FROM file_change_proposals proposal
    JOIN file_proposal_graphs graph ON graph.graph_id=proposal.graph_id
    JOIN collaboration_agent_operations operation ON operation.operation_id=proposal.operation_id
    JOIN file_collaboration_lineages lineage ON lineage.id=graph.lineage_id AND lineage.workspace_id=graph.workspace_id
    WHERE graph.workspace_id=$1 AND graph.document_id=$2 AND graph.lineage_id=$3
      AND operation.operation_id=$4 AND operation.initiated_by_user_id=$5
      AND lineage.path=$6 AND lineage.status='active'`, [input.workspaceId, input.documentId, input.lineageId,
    input.operationId, input.userId, input.filePath]));
  if (binding.rows.length !== 1) throw new Error('The exact fixture operation does not belong to this document.');

  // The real authenticated HTTP session-creation route owns runtime and agent
  // authorization. Only this new, empty, exact test session may receive fixtures.
  const sessionId = input.sessionId;
  const sessionRows = await database.transaction(sql => sql.query<{ id: number }>(`
    SELECT session.id FROM pi_sessions session WHERE session.session_id=$1 AND session.user_id=$2
      AND session.workspace_id=$3 AND session.agent_id=$4 AND session.title=$5
      AND NOT EXISTS (SELECT 1 FROM pi_messages message WHERE message.pi_session_db_id=session.id)`,
  [sessionId, input.userId, input.workspaceId, DEFAULT_AGENT_ID, input.fixtureTitle]));
  if (sessionRows.rows.length !== 1) throw new Error('The fixture requires its exact empty HTTP-created chat.');
  const sessionDbId = sessionRows.rows[0]!.id;
  const toolCallId = `fvrc-1007-edit-${randomUUID()}`;
  const timestamp = Date.now();
  const messages: AgentMessage[] = [{ role: 'user', content: 'Review the dedicated FVRC-1007 fixture.', timestamp }];
  stage = 'create_group';
  const group = await fileChangeGroupService.create({
    access: { userId: input.userId, authenticatedWorkspaceId: input.workspaceId,
      requestedWorkspaceId: input.workspaceId, membership: 'active', permissionsResolved: true,
      canRead: true, canWrite: true, canRunAgent: true },
    sourceSessionId: sessionId, toolCallId, operation: 'edit_file',
    entries: [{ lineageId: input.lineageId, documentId: input.documentId, operationId: input.operationId,
      pathHint: input.filePath, outcome: 'review_required' }],
  });
  const app = fileChangeToolApp(group);
  // This is a deterministic persisted tool-result fixture, not an LLM run or
  // an in-browser fake response. Authorization and current projection are real.
  messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'edit_file',
    arguments: { path: input.filePath, oldText: 'A0', newText: 'A1' } }],
  api: 'ollama', provider: 'ollama', model: 'kimi-k2.6:cloud', stopReason: 'toolUse', timestamp: timestamp + 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AgentMessage);
  messages.push({ role: 'toolResult', toolCallId, toolName: 'edit_file',
    content: [{ type: 'text', text: 'Dedicated review proposal created.' }],
    details: { toolApp: app, changeGroup: group }, isError: false, timestamp: timestamp + 2 } as AgentMessage);
  stage = 'save_messages';
  await database.transaction(async sql => {
    for (const [index, message] of messages.entries()) {
      await sql.query(`INSERT INTO pi_messages (pi_session_db_id,role,content,timestamp,sequence)
        VALUES ($1,$2,$3,$4,$5)`, [sessionDbId, message.role, JSON.stringify(message), timestamp + index, index + 1]);
    }
    await sql.query('UPDATE pi_sessions SET last_message_at=$2,updated_at=$2 WHERE id=$1',
      [sessionDbId, timestamp + messages.length]);
  });
  process.stdout.write(`${JSON.stringify({ sessionId, agentId: DEFAULT_AGENT_ID, app, groupId: group.id })}\n`);
}

void main().catch((error: unknown) => {
  // Do not print database credentials, arguments, chat bodies or provider keys.
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : 'UNKNOWN';
  process.stderr.write(`FVRC_CHAT_FIXTURE_FAILED=${stage}:${code}\n`);
  process.exitCode = 1;
}).finally(() => closeDatabaseConnections());
