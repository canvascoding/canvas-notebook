/**
 * React Hook for WebSocket Chat
 * 
 * Provides WebSocket connection management and event handling for React components.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { WebSocketClient, getWebSocketClient } from '@/app/lib/websocket/client';
import type { ChatRequestContext } from '@/app/lib/chat/types';

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
  sendMessage: (sessionId: string, message: Record<string, unknown>, context?: ChatRequestContext) => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}): Omit<UseWebSocketReturn, 'client'> & { client: () => WebSocketClient } {
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
    const isAlreadyConnected = client.isConnected();

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

    // If the shared singleton is already open, hydrate local state immediately.
    // This avoids missing the one-time `connected` event when a component mounts
    // after the provider has already established the WebSocket connection.
    setConnected(isAlreadyConnected);
    if (isAlreadyConnected) {
      setError(null);
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
  const sendMessage = useCallback((sessionId: string, message: Record<string, unknown>, context?: ChatRequestContext) => {
    clientRef.current?.sendMessage(sessionId, message, context);
  }, []);

  const getClient = () => {
    if (!clientRef.current) {
      throw new Error('WebSocket client not initialized');
    }
    return clientRef.current;
  };

  return {
    connected,
    error,
    client: getClient,
    subscribe,
    unsubscribe,
    sendMessage,
  };
}
