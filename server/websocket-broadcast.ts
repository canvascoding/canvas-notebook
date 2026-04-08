/**
 * WebSocket In-Memory Broadcasting
 * 
 * Manages WebSocket connections per session and broadcasts events.
 * No Redis - single server only (Phase 1).
 */

import WebSocket from 'ws';

/**
 * Global store for WebSocket connections
 * Maps sessionId -> Set of connected WebSocket clients
 */
interface WebSocketStore {
  connections: Map<string, Set<WebSocket>>;
  userIdToConnections: Map<string, Set<WebSocket>>;
}

const globalStore = globalThis as typeof globalThis & {
  __websocketStore?: WebSocketStore;
};

function getStore(): WebSocketStore {
  if (!globalStore.__websocketStore) {
    globalStore.__websocketStore = {
      connections: new Map<string, Set<WebSocket>>(),
      userIdToConnections: new Map<string, Set<WebSocket>>(),
    };
  }
  return globalStore.__websocketStore;
}

/**
 * Subscribe a WebSocket client to a session
 */
export function subscribeToSession(sessionId: string, ws: WebSocket): void {
  const store = getStore();
  
  if (!store.connections.has(sessionId)) {
    store.connections.set(sessionId, new Set());
  }
  
  store.connections.get(sessionId)!.add(ws);
}

/**
 * Unsubscribe a WebSocket client from a session
 */
export function unsubscribeFromSession(sessionId: string, ws: WebSocket): void {
  const store = getStore();
  
  const sessionClients = store.connections.get(sessionId);
  if (sessionClients) {
    sessionClients.delete(ws);
    
    // Clean up empty session
    if (sessionClients.size === 0) {
      store.connections.delete(sessionId);
    }
  }
  
  // Also remove from userId mapping
  for (const [userId, clients] of store.userIdToConnections.entries()) {
    clients.delete(ws);
    if (clients.size === 0) {
      store.userIdToConnections.delete(userId);
    }
  }
}

/**
 * Track WebSocket connection by userId
 */
export function trackUserConnection(userId: string, ws: WebSocket): void {
  const store = getStore();
  
  if (!store.userIdToConnections.has(userId)) {
    store.userIdToConnections.set(userId, new Set());
  }
  
  store.userIdToConnections.get(userId)!.add(ws);
}

/**
 * Broadcast event to all clients subscribed to a session
 */
export function broadcastToSession(
  sessionId: string,
  event: Record<string, unknown>,
  excludeWs?: WebSocket
): void {
  const store = getStore();
  const sessionClients = store.connections.get(sessionId);
  
  if (!sessionClients) {
    return;
  }
  
  const message = JSON.stringify(event);
  
  for (const ws of sessionClients) {
    if (ws === excludeWs) {
      continue;
    }
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * Broadcast event to all clients of a user
 */
export function broadcastToUser(
  userId: string,
  event: Record<string, unknown>,
  excludeWs?: WebSocket
): void {
  const store = getStore();
  const userClients = store.userIdToConnections.get(userId);
  
  if (!userClients) {
    return;
  }
  
  const message = JSON.stringify(event);
  
  for (const ws of userClients) {
    if (ws === excludeWs) {
      continue;
    }
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * Get number of clients subscribed to a session
 */
export function getSessionClientCount(sessionId: string): number {
  const store = getStore();
  const sessionClients = store.connections.get(sessionId);
  return sessionClients?.size || 0;
}

/**
 * Clean up all WebSocket connections for a user
 */
export function cleanupUserConnections(userId: string): void {
  const store = getStore();
  const userClients = store.userIdToConnections.get(userId);
  
  if (!userClients) {
    return;
  }
  
  // Close all connections
  for (const ws of userClients) {
    ws.close();
  }
  
  // Remove from store
  store.userIdToConnections.delete(userId);
  
  // Clean up session connections
  for (const [sessionId, clients] of store.connections.entries()) {
    for (const ws of userClients) {
      clients.delete(ws);
    }
    
    if (clients.size === 0) {
      store.connections.delete(sessionId);
    }
  }
}
