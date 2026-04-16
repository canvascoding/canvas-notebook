/**
 * WebSocket Runtime Bridge
 *
 * Connects PI Runtime events to WebSocket clients via the global event emitter.
 * This avoids circular dependencies and server-only import issues.
 */

import { getPiRuntimeEventEmitter } from '@/app/lib/pi/runtime-event-emitter';
import { broadcastAgentEvent, broadcastNotification, broadcastSessionUpdateToUser } from './websocket-server';
import { db } from '@/app/lib/db';
import { piSessions, piMessages } from '@/app/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { getCanvasInternalToken } from '@/app/lib/internal-auth';

function normalizeNotificationPreview(value: string, maxLength = 140): string {
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
  const directPreview = extractTextPreview(eventMessage);
  if (directPreview) {
    return directPreview;
  }

  if (!eventMessage || typeof eventMessage !== 'object') {
    return '';
  }

  const record = eventMessage as Record<string, unknown>;
  if ('content' in record) {
    return extractTextPreview(record.content);
  }

  return '';
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

    console.log(`[WebSocket Bridge] Received event for session ${sessionId}:`, event.type);

    // Broadcast to all WebSocket clients subscribed to this session
    broadcastAgentEvent(sessionId, event);

    // Handle message_saved event - this is emitted AFTER the message is saved to DB
    if (event.type === 'message_saved') {
      console.log(`[WebSocket Bridge] Received message_saved event for session ${sessionId}`);

      try {
        const session = await db.query.piSessions.findFirst({
          where: and(
            eq(piSessions.sessionId, sessionId),
            eq(piSessions.userId, userId)
          ),
          columns: { title: true, id: true }
        });

        if (!session) {
          console.error(`[WebSocket Bridge] Session not found: ${sessionId}`);
          return;
        }

        // Broadcast session update with title so all tabs can update the sidebar and
        // session title immediately (before the toast notification fires).
        broadcastSessionUpdateToUser(userId, sessionId, new Date().toISOString(), session.title ?? undefined);

        // Use the event payload as the primary source to avoid race conditions where
        // the DB write hasn't completed yet when we query for the preview.
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
        broadcastNotification(userId, sessionId, sessionTitle, 'new_response', messagePreview);

        console.log(
          `[WebSocket Bridge] AI response in session ${sessionId}: notification payload sent with title "${sessionTitle}" and preview "${messagePreview}"`
        );
      } catch (error) {
        console.error(`[WebSocket Bridge] Failed to fetch session/message data:`, error);
        broadcastNotification(userId, sessionId, sessionId, 'new_response', '');
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

/**
 * Send message via PI Runtime HTTP API
 * Forwards message with full context (activeFilePath, timezone, etc.)
 */
export async function sendMessageViaRuntime(
  sessionId: string,
  userId: string,
  message: { role: 'user'; content: unknown; timestamp: number },
  context?: ChatRequestContext
): Promise<void> {
  // Use 127.0.0.1 explicitly (IPv4) to avoid IPv6 resolution issues in Docker
  const port = process.env.PORT || '3000';
  const apiUrl = `http://127.0.0.1:${port}/api/stream`;

  console.log(`[WebSocket Bridge] Sending message to session ${sessionId} via ${apiUrl}`);

  const maxRetries = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-canvas-internal-token': getCanvasInternalToken(),
        },
        body: JSON.stringify({
          sessionId,
          userId,
          message,
          context,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log(`[WebSocket Bridge] Message sent to session ${sessionId} with context:`, context);
      return;
    } catch (error) {
      lastError = error;
      const isConnError = error instanceof Error && /ECONNREFUSED|fetch failed/i.test(error.message);

      if (isConnError && attempt < maxRetries) {
        const delay = Math.min(500 * attempt, 2000);
        console.warn(`[WebSocket Bridge] Connection failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      break;
    }
  }

  console.error('[WebSocket Bridge] Error sending message after retries:', lastError);
  throw lastError;
}
