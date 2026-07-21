/**
 * WebSocket Runtime Bridge
 *
 * Connects PI Runtime events to WebSocket clients via the global event emitter.
 * This avoids circular dependencies and server-only import issues.
 */

import { getPiRuntimeEventEmitter } from '@/app/lib/pi/runtime-event-emitter';
import {
  broadcastAgentEvent,
  broadcastNotification,
  broadcastSessionTitleUpdateToUser,
  broadcastSessionUpdateToUser,
} from './websocket-server';
import { deliverToLastActiveExternalChannel, sendTypingToLastActiveExternalChannel } from '@/app/lib/channels/delivery-router';
import { normalizeNotificationPreview } from '@/app/lib/chat/notification-preview';
import { db } from '@/app/lib/db';
import { piSessions, piMessages } from '@/app/lib/db/schema';
import { sendAgentResponseReadyPush } from '@/app/lib/mobile/push-devices';
import { eq, and, desc } from 'drizzle-orm';

const CHANNEL_TYPING_THROTTLE_MS = 4_000;
const CHANNEL_TYPING_MAX_AGE_MS = 30_000;
const channelTypingSentAt = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of channelTypingSentAt) {
    if (now - timestamp > CHANNEL_TYPING_MAX_AGE_MS) {
      channelTypingSentAt.delete(key);
    }
  }
}, 60_000).unref?.();

function extractTextPreview(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractTextPreview(entry))
      .find((entry) => entry.length > 0) || '';
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    if (typeof record.text === 'string') {
      return record.text;
    }

    if (record.content !== undefined) {
      return extractTextPreview(record.content);
    }
  }

  return '';
}

function extractAssistantNotificationPreview(eventMessage: unknown): string {
  if (!eventMessage || typeof eventMessage !== 'object') {
    return extractTextPreview(eventMessage);
  }

  const record = eventMessage as Record<string, unknown>;

  if (record.stopReason === 'error' && typeof record.errorMessage === 'string' && record.errorMessage) {
    return `[Error] ${record.errorMessage}`;
  }

  const contentPreview = 'content' in record
    ? extractTextPreview(record.content)
    : extractTextPreview(eventMessage);

  if (contentPreview) {
    return contentPreview;
  }

  if (typeof record.errorMessage === 'string' && record.errorMessage) {
    return `[Error] ${record.errorMessage}`;
  }

  return '';
}

function shouldSendTypingEvent(eventType: unknown): boolean {
  return eventType === 'message_update' ||
    eventType === 'tool_execution_start' ||
    eventType === 'tool_execution_update';
}

async function sendChannelTypingIndicator(sessionId: string, userId: string, eventType: unknown): Promise<void> {
  if (!shouldSendTypingEvent(eventType)) return;

  const now = Date.now();
  const lastSentAt = channelTypingSentAt.get(sessionId) ?? 0;
  if (now - lastSentAt < CHANNEL_TYPING_THROTTLE_MS) return;
  channelTypingSentAt.set(sessionId, now);

  try {
    await sendTypingToLastActiveExternalChannel(sessionId, userId);
  } catch (error) {
    console.warn('[WebSocket Bridge] Channel typing indicator failed:', error);
  }
}

/**
 * Initialize WebSocket event listener for PI Runtime events
 */
export function initializeWebSocketBridge(): void {
  const globalBridge = globalThis as typeof globalThis & { __canvasBridgeInitialized?: boolean };
  if (globalBridge.__canvasBridgeInitialized) {
    return;
  }
  globalBridge.__canvasBridgeInitialized = true;

  console.log('[WebSocket Bridge] Initializing event bridge...');

  const emitter = getPiRuntimeEventEmitter();

  emitter.onAgentEvent(async (data) => {
    const { sessionId, userId, event } = data;

    if (event.type !== 'message_update') {
      console.log(`[WebSocket Bridge] Received event for session ${sessionId}:`, event.type);
    }

    // Broadcast to all WebSocket clients subscribed to this session
    broadcastAgentEvent(sessionId, event);
    void sendChannelTypingIndicator(sessionId, userId, event.type);

    if (event.type === 'session_title_updated' && typeof event.title === 'string' && event.title.trim()) {
      broadcastSessionTitleUpdateToUser(
        userId,
        sessionId,
        event.title.trim(),
        typeof event.titleGenerationState === 'string' ? event.titleGenerationState : null,
      );
      return;
    }

    // Handle message_saved event - this is emitted AFTER the message is saved to DB
    if (event.type === 'message_saved') {
      console.log(`[WebSocket Bridge] Received message_saved event for session ${sessionId}`);

      try {
        const session = await db.query.piSessions.findFirst({
          where: and(
            eq(piSessions.sessionId, sessionId),
            eq(piSessions.userId, userId)
          ),
          columns: { title: true, id: true, lastMessageAt: true, workspaceId: true }
        });

        if (!session) {
          console.error(`[WebSocket Bridge] Session not found: ${sessionId}`);
          return;
        }

        const lastMessageAt = (session.lastMessageAt ?? new Date()).toISOString();

        let messagePreview = normalizeNotificationPreview(
          extractAssistantNotificationPreview(event.message)
        );

        if (!messagePreview) {
          const lastAssistantMessage = await db.query.piMessages.findFirst({
            where: and(
              eq(piMessages.piSessionDbId, session.id),
              eq(piMessages.role, 'assistant')
            ),
            orderBy: [desc(piMessages.sequence), desc(piMessages.id)],
            columns: { content: true }
          });

          if (lastAssistantMessage?.content) {
            try {
              messagePreview = normalizeNotificationPreview(
                extractTextPreview(JSON.parse(lastAssistantMessage.content))
              );
            } catch {
              messagePreview = normalizeNotificationPreview(lastAssistantMessage.content);
            }
          }
        }

        const sessionTitle = session.title || `Session ${sessionId.slice(0, 8)}`;

        console.log(`[WebSocket Bridge] Sending notification: userId=${userId}, sessionId=${sessionId}, title="${sessionTitle}", preview="${messagePreview}", lastMessageAt=${lastMessageAt}`);
        broadcastNotification(userId, sessionId, sessionTitle, 'new_response', messagePreview, lastMessageAt);

        console.log(`[WebSocket Bridge] Sending session_updated: userId=${userId}, sessionId=${sessionId}, lastMessageAt=${lastMessageAt}, title="${session.title ?? '(none)'}"`);
        broadcastSessionUpdateToUser(userId, sessionId, lastMessageAt, session.title ?? undefined);

        if (session.workspaceId) {
          void sendAgentResponseReadyPush({
            userId,
            workspaceId: session.workspaceId,
            sessionId,
          }).catch((pushError) => {
            console.warn('[WebSocket Bridge] Mobile push delivery failed:', pushError);
          });
        }

        console.log(
          `[WebSocket Bridge] AI response in session ${sessionId}: notification + session_updated dispatched`
        );

        try {
          const textPreview = extractAssistantNotificationPreview(event.message);
          if (textPreview) {
            await deliverToLastActiveExternalChannel(
              sessionId,
              userId,
              { content: textPreview, role: 'assistant' },
            );
          }
        } catch (err) {
          console.error('[WebSocket Bridge] Channel delivery failed:', err);
        }
      } catch (error) {
        console.error(`[WebSocket Bridge] Failed to fetch session/message data:`, error);
        broadcastNotification(userId, sessionId, sessionId, 'new_response', '');
      }
    }

    // Handle error events - deliver error messages to channel (e.g. Telegram)
    if (event.type === 'error' && typeof event.error === 'string') {
      console.log(`[WebSocket Bridge] Received error event for session ${sessionId}: ${event.error}`);

      try {
        const errorText = `[Error] ${event.error}`;
        await deliverToLastActiveExternalChannel(sessionId, userId, { content: errorText, role: 'assistant' });
      } catch (error) {
        console.error(`[WebSocket Bridge] Failed to handle error event for channel delivery:`, error);
      }
    }
  });

  console.log('[WebSocket Bridge] Event bridge initialized');
}
