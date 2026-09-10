import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import { piMessages, piSessions } from '@/app/lib/db/schema';
import type { AutomationStoreTransaction } from '@/app/lib/automations/store';
import type { AutomationJobRecord } from '@/app/lib/automations/types';
import { updateAutomationJobForUser } from '@/app/lib/automations/job-actions';
import { McpAccessError } from '@/app/lib/mcp/access';
import { requireMcpAppChatAccess, type McpAppChat } from '@/app/lib/mcp/apps-host';
import { requireBuiltinToolAppAccess } from './builtin-access';
import { presentAutomationAppData } from './automation-data';
import type { BuiltinToolAppDescriptor } from './types';

/** Caller reserves the idle runtime; DB writes share the automation transaction. */
export async function appendToolAppActionEvent(tx: AutomationStoreTransaction, chat: McpAppChat,
  app: BuiltinToolAppDescriptor, job: AutomationJobRecord, locale: string) {
  const [session] = await tx.select({ id: piSessions.id }).from(piSessions).where(and(
    eq(piSessions.sessionId, chat.sessionId), eq(piSessions.userId, chat.userId), eq(piSessions.agentId, chat.agentId),
  )).limit(1).for('update');
  if (!session) throw new McpAccessError('Chat is unavailable.', 403);
  const [history] = await tx.select({
    count: sql<number>`count(*)`, unique: sql<number>`count(distinct ${piMessages.sequence})`,
    min: sql<number>`coalesce(min(${piMessages.sequence}), 0)`, max: sql<number>`coalesce(max(${piMessages.sequence}), 0)`,
  }).from(piMessages).where(eq(piMessages.piSessionDbId, session.id));
  const count = Number(history.count);
  if (Number(history.unique) !== count || Number(history.max) !== count || (count > 0 && Number(history.min) !== 1)) {
    throw new McpAccessError('Chat history has changed. Reload before trying again.', 409);
  }
  const text = locale === 'de'
    ? `Über die Automationskarte habe ich die Automation ${job.id} ${job.status === 'paused' ? 'pausiert' : 'aktiviert'} (Revision ${job.revision}). Die Aktion ist bereits ausgeführt.`
    : `Using the automation card, I ${job.status === 'paused' ? 'paused' : 'activated'} automation ${job.id} (revision ${job.revision}). This action has already completed.`;
  const timestamp = Date.now();
  await tx.insert(piMessages).values({ piSessionDbId: session.id, role: 'user', timestamp, sequence: count + 1,
    content: JSON.stringify({ role: 'user', content: [{ type: 'text', text }], timestamp,
      source: 'tool-app-action', toolCallId: app.toolCallId, entityId: job.id, revision: job.revision }),
  });
  await tx.update(piSessions).set({ updatedAt: new Date(timestamp) }).where(eq(piSessions.id, session.id));
}

export async function changeAutomationAppStatus(chat: McpAppChat, app: BuiltinToolAppDescriptor,
  status: 'active' | 'paused', expectedRevision: number, locale: string, expectedUpdatedAt?: string) {
  const { withExclusivePiSessionExecution, PiSessionBusyError } = await import('@/app/lib/pi/session-exclusive-execution');
  try {
    const data = await withExclusivePiSessionExecution({ ...chat,
      beforeRuntimeCheck: async () => {
        await requireMcpAppChatAccess(chat);
        await requireBuiltinToolAppAccess(chat, app);
      },
      operation: ({ runReserved }) => runReserved(new AbortController().signal, async () => {
        const job = await updateAutomationJobForUser(app.entityId, { status }, chat.userId, {
          expectedRevision, expectedUpdatedAt,
          onUpdated: (updated, tx) => appendToolAppActionEvent(tx, chat, app, updated, locale),
        });
        return presentAutomationAppData(job, chat.userId);
      }),
    });
    const { getPiRuntimeEventEmitter } = await import('@/app/lib/pi/runtime-event-emitter');
    getPiRuntimeEventEmitter().emitEvent(chat.sessionId, chat.userId, { type: 'message_saved' });
    return data;
  } catch (error) {
    if (error instanceof PiSessionBusyError) throw new McpAccessError('Wait until this chat has finished, then try again.', 409, 'TOOL_APP_CHAT_BUSY');
    throw error;
  }
}
