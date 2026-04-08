/**
 * React Hook for WebSocket Chat
 * 
 * Provides WebSocket connection management and event handling for React components.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { WebSocketClient, getWebSocketClient } from '@/app/lib/websocket/client';

interface UseWebSocketOptions {
  autoConnect?: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: { error: string; code?: string }) => void;
}

interface UseWebSocketReturn {
  connected: boolean;
  error: { error: string; code?: string } | null;
  client: WebSocketClient;
  subscribe: (sessionId: string) => void;
  unsubscribe: (sessionId: string) => void;
  sendMessage: (sessionId: string, message: Record<string, unknown>) => void;
  markAsRead: (sessionId: string) => void;
  getStatus: (sessionId: string) => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const {
    autoConnect = true,
    onConnected,
    onDisconnected,
    onError,
  } = options;

  const clientRef = useRef<WebSocketClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<{ error: string; code?: string } | null>(null);

  // Initialize client
  useEffect(() => {
    clientRef.current = getWebSocketClient();

    const client = clientRef.current;

    const handleConnected = () => {
      setConnected(true);
      setError(null);
      onConnected?.();
    };

    const handleDisconnected = () => {
      setConnected(false);
      onDisconnected?.();
    };

    const handleError = (event: CustomEvent<{ error: string; code?: string }>) => {
      setError(event.detail);
      onError?.(event.detail);
    };

    client.addEventListener('connected', handleConnected as EventListener);
    client.addEventListener('disconnected', handleDisconnected as EventListener);
    client.addEventListener('error', handleError as EventListener);

    if (autoConnect) {
      client.connect().catch(console.error);
    }

    return () => {
      client.removeEventListener('connected', handleConnected as EventListener);
      client.removeEventListener('disconnected', handleDisconnected as EventListener);
      client.removeEventListener('error', handleError as EventListener);
    };
  }, [autoConnect, onConnected, onDisconnected, onError]);

  // Subscribe to session
  const subscribe = useCallback((sessionId: string) => {
    clientRef.current?.subscribe(sessionId);
  }, []);

  // Unsubscribe from session
  const unsubscribe = useCallback((sessionId: string) => {
    clientRef.current?.unsubscribe(sessionId);
  }, []);

  // Send message
  const sendMessage = useCallback((sessionId: string, message: Record<string, unknown>) => {
    clientRef.current?.sendMessage(sessionId, message);
  }, []);

  // Mark as read
  const markAsRead = useCallback((sessionId: string) => {
    clientRef.current?.markAsRead(sessionId);
  }, []);

  // Get status
  const getStatus = useCallback((sessionId: string) => {
    clientRef.current?.getStatus(sessionId);
  }, []);

  return {
    connected,
    error,
    client: clientRef.current!,
    subscribe,
    unsubscribe,
    sendMessage,
    markAsRead,
    getStatus,
  };
}
