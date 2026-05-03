/**
 * WebSocket Runtime Bridge
 *
 * Connects PI Runtime events to WebSocket clients via the global event emitter.
 * This avoids circular dependencies and server-only import issues.
 */

import { getPiRuntimeEventEmitter } from '@/app/lib/pi/runtime-event-emitter';
import { broadcastAgentEvent, broadcastNotification, broadcastSessionUpdateToUser } from './websocket-server';
import { getChannelRegistry } from '@/app/lib/channels/registry';
import { db } from '@/app/lib/db';
import { piSessions, piMessages } from '@/app/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';

const CHANNEL_TYPING_THROTTLE_MS = 4_000;
const channelTypingSentAt = new Map<string, number>();

function normalizeNotificationPreview(value: string, maxLength = 500): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

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
    const session = await db.query.piSessions.findFirst({
      where: and(
        eq(piSessions.sessionId, sessionId),
        eq(piSessions.userId, userId)
      ),
      columns: { channelId: true, channelSessionKey: true }
    });

    if (!session?.channelId || session.channelId === 'app' || !session.channelSessionKey) {
      return;
    }

    const channel = getChannelRegistry().get(session.channelId);
    const typingChannel = channel as typeof channel & {
      sendTyping?: (target: { chatId: string }) => Promise<void>;
    };

    if (!typingChannel?.sendTyping) return;

    const chatId = session.channelSessionKey.replace(/^telegram:/, '');
    await typingChannel.sendTyping({ chatId });
  } catch (error) {
    console.warn('[WebSocket Bridge] Channel typing indicator failed:', error);
  }
}

// Track which sessions are subscribed
const subscribedSessions = new Map<string, Set<string>>(); // sessionId -> Set of userIds

/**
 * Initialize WebSocket event listener for PI Runtime events
 */
export function initializeWebSocketBridge(): void {
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

    // Handle message_saved event - this is emitted AFTER the message is saved to DB
    if (event.type === 'message_saved') {
      console.log(`[WebSocket Bridge] Received message_saved event for session ${sessionId}`);

      try {
        const session = await db.query.piSessions.findFirst({
          where: and(
            eq(piSessions.sessionId, sessionId),
            eq(piSessions.userId, userId)
          ),
          columns: { title: true, id: true, channelId: true, channelSessionKey: true }
        });

        if (!session) {
          console.error(`[WebSocket Bridge] Session not found: ${sessionId}`);
          return;
        }

        const lastMessageAt = new Date().toISOString();

        let messagePreview = normalizeNotificationPreview(
          extractAssistantNotificationPreview(event.message)
        );

        if (!messagePreview) {
          const lastAssistantMessage = await db.query.piMessages.findFirst({
            where: and(
              eq(piMessages.piSessionDbId, session.id),
              eq(piMessages.role, 'assistant')
            ),
            orderBy: [desc(piMessages.timestamp)],
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

        console.log(
          `[WebSocket Bridge] AI response in session ${sessionId}: notification + session_updated dispatched`
        );

        // Channel routing: deliver to Telegram if session belongs to a channel
        if (session.channelId && session.channelId !== 'app' && session.channelSessionKey) {
          const channel = getChannelRegistry().get(session.channelId);
          if (channel) {
            try {
              const textPreview = extractAssistantNotificationPreview(event.message);
              if (textPreview) {
                const chatId = session.channelSessionKey.replace(/^telegram:/, '');
                await channel.deliver(
                  { content: textPreview, role: 'assistant' },
                  { chatId }
                );
              }
            } catch (err) {
              console.error(`[WebSocket Bridge] Channel delivery failed for ${session.channelId}:`, err);
            }
          }
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
        const session = await db.query.piSessions.findFirst({
          where: and(
            eq(piSessions.sessionId, sessionId),
            eq(piSessions.userId, userId)
          ),
          columns: { channelId: true, channelSessionKey: true }
        });

        const errorText = `[Error] ${event.error}`;

        if (session?.channelId && session.channelId !== 'app' && session.channelSessionKey) {
          const channel = getChannelRegistry().get(session.channelId);
          if (channel) {
            try {
              const chatId = session.channelSessionKey.replace(/^telegram:/, '');
              await channel.deliver(
                { content: errorText, role: 'assistant' },
                { chatId }
              );
            } catch (err) {
              console.error(`[WebSocket Bridge] Error delivery failed for ${session.channelId}:`, err);
            }
          }
        }
      } catch (error) {
        console.error(`[WebSocket Bridge] Failed to handle error event for channel delivery:`, error);
      }
    }
  });

  console.log('[WebSocket Bridge] Event bridge initialized');
}

/**
 * Subscribe to PI Runtime events for a session
 */
export async function subscribeToPiRuntimeEvents(sessionId: string, userId: string): Promise<void> {
  console.log(`[WebSocket Bridge] Subscription requested for session ${sessionId}, user ${userId}`);

  if (!subscribedSessions.has(sessionId)) {
    subscribedSessions.set(sessionId, new Set());
  }

  subscribedSessions.get(sessionId)!.add(userId);

  console.log(`[WebSocket Bridge] Active subscribers for session ${sessionId}:`, subscribedSessions.get(sessionId)!.size);
}

/**
 * Unsubscribe from PI Runtime events
 */
export function unsubscribeFromPiRuntimeEvents(sessionId: string, userId: string): void {
  const subscribers = subscribedSessions.get(sessionId);

  if (subscribers) {
    subscribers.delete(userId);

    if (subscribers.size === 0) {
      subscribedSessions.delete(sessionId);
    }

    console.log(`[WebSocket Bridge] Unsubscribed user ${userId} from session ${sessionId}`);
  }
}
