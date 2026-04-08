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
      
      // Update session title if AI generated one
      void updateSessionTitle(sessionId, userId, event.message);
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
 * Update session title in database when AI generates one
 */
async function updateSessionTitle(
  sessionId: string,
  userId: string,
  message: AgentMessage
): Promise<void> {
  try {
    // Check if message contains title generation
    const messageText = JSON.stringify(message.content);
    
    // Look for title in message metadata or content
    // This is a placeholder - actual implementation depends on how AI generates titles
    if (messageText.includes('title') || messageText.includes('Title')) {
      const { db } = await import('@/app/lib/db');
      const { piSessions } = await import('@/app/lib/db/schema');
      const { and, eq } = await import('drizzle-orm');
      
      // Extract title from message (simplified - would need proper parsing)
      const potentialTitle = messageText.slice(0, 120); // Limit to 120 chars
      
      await db.update(piSessions)
        .set({ 
          title: potentialTitle,
          updatedAt: new Date()
        })
        .where(and(
          eq(piSessions.sessionId, sessionId),
          eq(piSessions.userId, userId)
        ));
      
      console.log(`[WebSocket Bridge] Updated session title for session ${sessionId}`);
    }
  } catch (error) {
    console.error('[WebSocket Bridge] Error updating session title:', error);
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
