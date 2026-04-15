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
      
      // Broadcast to USER (all tabs/devices). The client decides whether to suppress
      // the in-app notification when the matching session is already visible and focused.
      broadcastSessionUpdateToUser(userId, sessionId, new Date().toISOString());

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

        const lastAssistantMessage = await db.query.piMessages.findFirst({
          where: and(
            eq(piMessages.piSessionDbId, session.id),
            eq(piMessages.role, 'assistant')
          ),
          orderBy: [desc(piMessages.timestamp)],
          columns: { content: true }
        });

        let messagePreview = '';
        if (lastAssistantMessage?.content) {
          try {
            messagePreview = normalizeNotificationPreview(
              extractTextPreview(JSON.parse(lastAssistantMessage.content))
            );
          } catch {
            messagePreview = normalizeNotificationPreview(lastAssistantMessage.content);
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
  context?: {
    activeFilePath?: string | null;
    userTimeZone?: string;
    currentTime?: string;
    workingDirectory?: string;
  }
): Promise<void> {
  console.log(`[WebSocket Bridge] Sending message to session ${sessionId} via PI Runtime directly`);

  try {
    // Import dynamically to avoid circular dependencies
    const { getOrCreatePiRuntime } = await import('@/app/lib/pi/live-runtime');

    // Get or create the runtime instance
    const runtimeInstance = await getOrCreatePiRuntime(sessionId, userId);

    // Set timezone context if provided
    if (context?.userTimeZone && context?.currentTime) {
      runtimeInstance.setTimeZoneContext(context.userTimeZone, context.currentTime);
    }

    // Set active file context if provided
    if (context?.activeFilePath) {
      runtimeInstance.setActiveFileContext(context.activeFilePath);
    }

    // Validate message is user message
    const userMessage = message as Extract<import('@mariozechner/pi-agent-core').AgentMessage, { role: 'user' }>;
    if (userMessage.role !== 'user') {
      throw new Error('Message role must be "user"');
    }

    // Start the prompt directly in the runtime
    runtimeInstance.startPrompt(userMessage);

    console.log(`[WebSocket Bridge] Message sent to session ${sessionId} with context:`, context);
  } catch (error) {
    console.error('[WebSocket Bridge] Error sending message:', error);
    throw error;
  }
}
