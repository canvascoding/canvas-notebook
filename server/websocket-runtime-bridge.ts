/**
 * WebSocket Runtime Bridge
 * 
 * Connects PI Runtime events to WebSocket clients.
 * This bridges the gap between the PI Runtime and WebSocket server.
 */

import { getExistingPiRuntime, getOrCreatePiRuntime } from '@/app/lib/pi/live-runtime';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { broadcastAgentEvent, broadcastNotification, broadcastSessionUpdate } from './websocket-server';

/**
 * Subscribe to PI Runtime events and broadcast to WebSocket clients
 */
export function subscribeToPiRuntimeEvents(sessionId: string, userId: string): void {
  console.log(`[WebSocket Bridge] Subscribing to PI Runtime events for session ${sessionId}`);
  
  // Get or create runtime
  const runtime = getOrCreatePiRuntime(sessionId, userId);
  
  // Store original event handler
  const originalOnAgentEvent = runtime.onAgentEvent.bind(runtime);
  
  // Override event handler to broadcast via WebSocket
  runtime.onAgentEvent = (event) => {
    // Call original handler
    originalOnAgentEvent(event);
    
    // Broadcast to WebSocket clients
    broadcastAgentEvent(sessionId, event as unknown as Record<string, unknown>);
    
    // Handle specific events for additional broadcasting
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      // Update lastMessageAt in database and broadcast
      void updateSessionLastMessageAt(sessionId, userId);
    }
  };
  
  console.log(`[WebSocket Bridge] Event subscription active for session ${sessionId}`);
}

/**
 * Update session lastMessageAt in database
 */
async function updateSessionLastMessageAt(sessionId: string, userId: string): Promise<void> {
  try {
    const { db } = await import('@/app/lib/db');
    const { piSessions } = await import('@/app/lib/db/schema');
    const { and, eq } = await import('drizzle-orm');
    
    const now = new Date();
    
    await db.update(piSessions)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(and(
        eq(piSessions.sessionId, sessionId),
        eq(piSessions.userId, userId)
      ));
    
    // Broadcast session update
    broadcastSessionUpdate(sessionId, now.toISOString());
    
    // Broadcast notification
    broadcastNotification(userId, sessionId, sessionId, 'new_response');
    
    console.log(`[WebSocket Bridge] Updated lastMessageAt for session ${sessionId}`);
  } catch (error) {
    console.error('[WebSocket Bridge] Error updating lastMessageAt:', error);
  }
}

/**
 * Send message via PI Runtime
 */
export async function sendMessageViaRuntime(
  sessionId: string,
  userId: string,
  message: Extract<AgentMessage, { role: 'user' }>
): Promise<void> {
  console.log(`[WebSocket Bridge] Sending message to session ${sessionId}`);
  
  const runtime = await getOrCreatePiRuntime(sessionId, userId);
  
  // Subscribe to events if not already done
  subscribeToPiRuntimeEvents(sessionId, userId);
  
  // Send message
  runtime.startPrompt(message);
  
  console.log(`[WebSocket Bridge] Message sent to PI Runtime for session ${sessionId}`);
}
