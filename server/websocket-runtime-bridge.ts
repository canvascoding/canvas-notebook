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

// Track which sessions are subscribed
const subscribedSessions = new Map<string, Set<string>>(); // sessionId -> Set of userIds

// Track which session each user is currently viewing
const userActiveSessions = new Map<string, string>(); // userId -> sessionId they're viewing

/**
 * Check if user is currently viewing a specific session
 */
export function isUserViewingSession(userId: string, sessionId: string): boolean {
  return userActiveSessions.get(userId) === sessionId;
}

/**
 * Set user's active session
 */
export function setUserActiveSession(userId: string, sessionId: string | null): void {
  if (sessionId === null) {
    userActiveSessions.delete(userId);
  } else {
    userActiveSessions.set(userId, sessionId);
  }
}

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
      
      // Check if user is currently viewing this session
      const isUserViewing = isUserViewingSession(userId, sessionId);
      
      if (!isUserViewing) {
        // User is NOT viewing this session → mark as unread and send notification
        // Broadcast to USER (all tabs/devices)
        broadcastSessionUpdateToUser(userId, sessionId, new Date().toISOString());
        
        // Fetch session info and last assistant message from database
        try {
          // Get session info
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
          
          // Get the last assistant message from this session
          const lastAssistantMessage = await db.query.piMessages.findFirst({
            where: and(
              eq(piMessages.piSessionDbId, session.id),
              eq(piMessages.role, 'assistant')
            ),
            orderBy: [desc(piMessages.timestamp)],
            columns: { content: true }
          });
          
          // Extract message content from JSON
          let messagePreview = '';
          if (lastAssistantMessage?.content) {
            try {
              const parsedContent = JSON.parse(lastAssistantMessage.content);
              // Handle both string content and object with content property
              const rawContent = typeof parsedContent === 'string' 
                ? parsedContent 
                : parsedContent.content || '';
              messagePreview = rawContent.length > 70 
                ? rawContent.slice(0, 70) + '...' 
                : rawContent;
            } catch {
              // Fallback: use raw content if JSON parsing fails
              messagePreview = lastAssistantMessage.content.slice(0, 70);
            }
          }
          
          const sessionTitle = session.title || `Session ${sessionId.slice(0, 8)}`;
          broadcastNotification(userId, sessionId, sessionTitle, 'new_response', messagePreview);
          
          console.log(`[WebSocket Bridge] AI response in session ${sessionId}: User ${userId} NOT viewing → notification sent with preview: "${messagePreview}"`);
        } catch (error) {
          console.error(`[WebSocket Bridge] Failed to fetch session/message data:`, error);
          // Fallback: use sessionId as title and empty preview
          broadcastNotification(userId, sessionId, sessionId, 'new_response', '');
        }
      } else {
        // User IS viewing this session → no toast needed
        console.log(`[WebSocket Bridge] AI response in session ${sessionId}: User ${userId} IS viewing → live update only`);
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
  console.log(`[WebSocket Bridge] Sending message to session ${sessionId} via HTTP API`);
  
  try {
    // Forward to existing /api/stream endpoint with full context
    const response = await fetch('http://localhost:3000/api/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        userId,
        message,
        ...context,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    console.log(`[WebSocket Bridge] Message sent to session ${sessionId} with context:`, context);
  } catch (error) {
    console.error('[WebSocket Bridge] Error sending message:', error);
    throw error;
  }
}
