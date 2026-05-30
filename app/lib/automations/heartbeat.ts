import 'server-only';

import { db } from '@/app/lib/db';
import { channelUserBindings } from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { readManagedAgentFile } from '@/app/lib/agents/storage';
import { sendMessage } from '@/app/lib/pi/runtime-service';
import { createTelegramSession } from '@/app/lib/channels/telegram/session-resolver';
import { getChannelRegistry } from '@/app/lib/channels/registry';
import { getChannelDeliveryReadiness } from '@/app/lib/channels/availability';
import { TELEGRAM_CHANNEL_ID, telegramChannelSessionKey } from '@/app/lib/channels/constants';
import { buildDeliveryTarget } from '@/app/lib/channels/delivery-targets';
import type { AutomationJobRecord } from './types';

export interface HeartbeatResult {
  usersNotified: number;
  sessionIds: string[];
  errors: string[];
}

export async function executeHeartbeat(job: AutomationJobRecord): Promise<HeartbeatResult> {
  const startTime = Date.now();
  console.log('[Heartbeat] Starting heartbeat execution');

  const heartbeatContent = await readManagedAgentFile('HEARTBEAT.md', job.agentId);
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

  console.log(`[Heartbeat] Found ${bindings.length} linked Telegram user(s)`);

  const readiness = await getChannelDeliveryReadiness(TELEGRAM_CHANNEL_ID);
  if (!readiness.ok) {
    console.warn(`[Heartbeat] Telegram delivery unavailable: ${readiness.error}`);
    return { usersNotified: 0, sessionIds: [], errors: [readiness.error] };
  }

  const channel = getChannelRegistry().get('telegram');
  if (!channel) {
    console.warn('[Heartbeat] Telegram channel not available in registry');
    return { usersNotified: 0, sessionIds: [], errors: ['Telegram channel not available'] };
  }

  const sessionIds: string[] = [];
  const errors: string[] = [];
  let usersNotified = 0;

  const heartbeatPath = `/data/agents/${job.agentId || 'canvas-agent'}/HEARTBEAT.md`;
  const heartbeatPrompt = `Lies die Datei ${heartbeatPath} und führe die darin beschriebenen Instructions aus. Die Ergebnisse sollen direkt hier in diesem Chat kommuniziert werden.\n\nInhalt der HEARTBEAT.md:\n---\n${heartbeatContent}\n---`;

  for (const binding of bindings) {
    try {
      const chatId = binding.channelUserId;
      const userId = binding.userId;

      console.log(`[Heartbeat] Processing user ${userId} (chatId=${chatId})`);
      const sessionId = await createTelegramSession(chatId, userId);
      sessionIds.push(sessionId);

      const delivery = await channel.deliver(
        { content: '💓 Heartbeat: Starte neue Session...', role: 'assistant' },
        buildDeliveryTarget(TELEGRAM_CHANNEL_ID, telegramChannelSessionKey(chatId)),
      );
      if (!delivery.ok) {
        throw new Error(delivery.error || 'Telegram heartbeat delivery failed');
      }

      await sendMessage(sessionId, userId, {
        role: 'user',
        content: heartbeatPrompt,
        timestamp: Date.now(),
      }, {
        currentTime: new Date().toISOString(),
      });

      console.log(`[Heartbeat] Session created for user ${userId}: ${sessionId}`);
      usersNotified++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Heartbeat] Failed for user ${binding.userId}:`, errorMsg);
      errors.push(`User ${binding.userId}: ${errorMsg}`);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`[Heartbeat] Execution completed in ${duration}ms (${usersNotified} notified, ${errors.length} errors)`);
  return { usersNotified, sessionIds, errors };
}
