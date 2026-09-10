import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piMessages, piSessions } from '@/app/lib/db/schema';
import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import { assertCanAccessAutomationJob } from '@/app/lib/automations/policy';
import { getAutomationJob } from '@/app/lib/automations/store';
import { McpAccessError } from '@/app/lib/mcp/access';
import type { McpAppChat } from '@/app/lib/mcp/apps-host';
import { readBuiltinToolAppMessage, type BuiltinToolAppDescriptor } from './types';

/** Re-authorize the stored operation and its entity, never the browser's snapshot. */
export async function requireBuiltinToolAppAccess(chat: McpAppChat, app: BuiltinToolAppDescriptor) {
  await assertUserSeatAccess({ userId: chat.userId });
  const session = await db.query.piSessions.findFirst({ where: and(
    eq(piSessions.sessionId, chat.sessionId), eq(piSessions.userId, chat.userId), eq(piSessions.agentId, chat.agentId),
  ) });
  if (!session) throw new McpAccessError('Chat is unavailable.', 403);
  const rows = await db.select({ content: piMessages.content }).from(piMessages).where(and(
    eq(piMessages.piSessionDbId, session.id), eq(piMessages.role, 'toolResult'),
    sql`${piMessages.content}::jsonb ->> 'toolCallId' = ${app.toolCallId}`,
  )).orderBy(desc(piMessages.id)).limit(1);
  // Live results can arrive before savePiSession finishes. No synthetic binding.
  if (!rows[0]) throw new McpAccessError('The tool result is not saved yet. Reload shortly.', 425);
  let stored: BuiltinToolAppDescriptor | null = null;
  try { stored = readBuiltinToolAppMessage(JSON.parse(rows[0].content)); } catch { /* fail closed */ }
  if (!stored || stored.entityId !== app.entityId || stored.resourceUri !== app.resourceUri
    || stored.operation !== app.operation || stored.toolCallId !== app.toolCallId) {
    throw new McpAccessError('Widget does not belong to this tool result.', 403);
  }
  const job = await getAutomationJob(stored.entityId);
  if (!job || job.deletedAt) throw new McpAccessError('Automation is unavailable.', 404);
  try { await assertCanAccessAutomationJob(chat.userId, job); }
  catch { throw new McpAccessError('Automation is unavailable.', 404); }
  return job;
}
