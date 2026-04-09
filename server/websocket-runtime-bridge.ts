/**
 * WebSocket Runtime Bridge
 * 
 * Connects PI Runtime events to WebSocket clients via the global event emitter.
 * This avoids circular dependencies and server-only import issues.
 */

import { getPiRuntimeEventEmitter } from '@/app/lib/pi/runtime-event-emitter';
import { broadcastAgentEvent, broadcastNotification, broadcastSessionUpdateToUser } from './websocket-server';

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
  
  emitter.onAgentEvent((data) => {
    const { sessionId, userId, event } = data;
    
    console.log(`[WebSocket Bridge] Received event for session ${sessionId}:`, event.type);
    
    // Broadcast to all WebSocket clients subscribed to this session
    broadcastAgentEvent(sessionId, event);
    
    // Handle specific events
    if (event.type === 'message_end' && (event as unknown as { message?: { role?: string; content?: string } }).message?.role === 'assistant') {
      const assistantMessage = event as unknown as { message?: { role?: string; content?: string } };
      const messageContent = assistantMessage.message?.content || '';
      const messagePreview = messageContent.length > 70 ? messageContent.slice(0, 70) + '...' : messageContent;
      
      // Check if user is currently viewing this session
      const isUserViewing = isUserViewingSession(userId, sessionId);
      
      if (!isUserViewing) {
        // User is NOT viewing this session → mark as unread
        // Broadcast to USER (all tabs/devices)
        broadcastSessionUpdateToUser(userId, sessionId, new Date().toISOString());
        broadcastNotification(userId, sessionId, sessionId, 'new_response', messagePreview);
        console.log(`[WebSocket Bridge] AI response in session ${sessionId}: User ${userId} NOT viewing → marked as unread`);
      } else {
        // User IS viewing this session → no toast needed, but still update lastMessageAt
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
