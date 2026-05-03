import 'server-only';

import { db } from '@/app/lib/db';
import { channelUserBindings } from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { readManagedAgentFile } from '@/app/lib/agents/storage';
import { sendMessage } from '@/app/lib/pi/runtime-service';
import { createTelegramSession } from '@/app/lib/channels/telegram/session-resolver';
import { deliverToTelegram } from '@/app/lib/channels/telegram/outbound';
import { getChannelRegistry } from '@/app/lib/channels/registry';
import type { AutomationJobRecord } from './types';

export interface HeartbeatResult {
  usersNotified: number;
  sessionIds: string[];
  errors: string[];
}

export async function executeHeartbeat(_job: AutomationJobRecord): Promise<HeartbeatResult> {
  const heartbeatContent = await readManagedAgentFile('HEARTBEAT.md');
  if (!heartbeatContent || heartbeatContent.trim().length === 0) {
    console.warn('[Heartbeat] HEARTBEAT.md is empty, skipping execution');
    return { usersNotified: 0, sessionIds: [], errors: ['HEARTBEAT.md is empty'] };
  }

  const bindings = await db.query.channelUserBindings.findMany({
    where: eq(channelUserBindings.channelId, 'telegram'),
  });

  if (bindings.length === 0) {
    console.log('[Heartbeat] No linked Telegram users, skipping execution');
    return { usersNotified: 0, sessionIds: [], errors: ['No linked Telegram users'] };
  }

  const channel = getChannelRegistry().get('telegram');
  if (!channel) {
    console.warn('[Heartbeat] Telegram channel not available in registry');
    return { usersNotified: 0, sessionIds: [], errors: ['Telegram channel not available'] };
  }

  const bot = 'getBot' in channel && typeof (channel as Record<string, unknown>).getBot === 'function'
    ? ((channel as unknown as { getBot: () => unknown }).getBot() as import('grammy').Bot)
    : null;

  if (!bot) {
    console.warn('[Heartbeat] Cannot get Telegram bot instance');
    return { usersNotified: 0, sessionIds: [], errors: ['Cannot get Telegram bot instance'] };
  }

  const sessionIds: string[] = [];
  const errors: string[] = [];
  let usersNotified = 0;

  const heartbeatPrompt = `Lies die Datei /data/canvas-agent/HEARTBEAT.md und führe die darin beschriebenen Instructions aus. Die Ergebnisse sollen direkt hier in diesem Chat kommuniziert werden.\n\nInhalt der HEARTBEAT.md:\n---\n${heartbeatContent}\n---`;

  for (const binding of bindings) {
    try {
      const chatId = binding.channelUserId;
      const userId = binding.userId;

      const sessionId = await createTelegramSession(chatId, userId);
      sessionIds.push(sessionId);

      await deliverToTelegram(
        bot,
        { content: '💓 Heartbeat: Starte neue Session...', role: 'assistant' },
        { chatId },
      );

      await sendMessage(sessionId, userId, {
        role: 'user',
        content: heartbeatPrompt,
        timestamp: Date.now(),
      }, {
        currentTime: new Date().toISOString(),
      });

      usersNotified++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Heartbeat] Failed for user ${binding.userId}:`, errorMsg);
      errors.push(`User ${binding.userId}: ${errorMsg}`);
    }
  }

  console.log(`[Heartbeat] Completed: ${usersNotified} users notified, ${errors.length} errors`);
  return { usersNotified, sessionIds, errors };
}