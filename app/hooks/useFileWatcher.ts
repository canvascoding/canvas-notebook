/**
 * useFileWatcher Hook
 *
 * React Hook für File Watching über Server-Sent Events (SSE).
 * Verbindet sich automatisch mit dem Server und aktualisiert
 * den File-Tree bei Änderungen.
 *
 * Features:
 * - Automatische SSE-Verbindung
 * - Reconnect mit Exponential Backoff
 * - Debounced file tree reload (min 1000ms, max 5000ms)
 * - Manuelle Steuerung (connect/disconnect)
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useFileStore } from '@/app/store/file-store';

interface FileEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  relativePath: string;
  timestamp: number;
}

interface UseFileWatcherOptions {
  enabled?: boolean;
  debounceMs?: number;
  maxDebounceMs?: number;
  onEvent?: (event: FileEvent) => void;
}

interface UseFileWatcherReturn {
  isConnected: boolean;
  lastEvent: FileEvent | null;
  connect: () => void;
  disconnect: () => void;
}

export function useFileWatcher(options: UseFileWatcherOptions = {}): UseFileWatcherReturn {
  const {
    enabled = true,
    debounceMs = 1000,
    maxDebounceMs = 5000,
    onEvent,
  } = options;

  const { loadFileTree } = useFileStore();
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastReloadRef = useRef<number>(0);
  const reconnectAttemptsRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(false);
  const connectRef = useRef<() => void>(() => {});
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [lastEvent, setLastEvent] = useState<FileEvent | null>(null);

  // Refs für werte die sich ändern können aber nicht re-render auslösen sollen
  const enabledRef = useRef(enabled);
  const onEventRef = useRef(onEvent);
  const optionsRef = useRef({ debounceMs, maxDebounceMs });

  // Update refs when values change
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    optionsRef.current = { debounceMs, maxDebounceMs };
  }, [debounceMs, maxDebounceMs]);

  // Cleanup function - stable reference
  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
  }, []);

  // Debounced reload function - stable reference
  const debouncedReload = useCallback(() => {
    const now = Date.now();
    const timeSinceLastReload = now - lastReloadRef.current;

    // Clear existing timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // If we reloaded recently, wait for the debounce period
    const waitTime = Math.max(0, optionsRef.current.debounceMs - timeSinceLastReload);

    // Cap at maxDebounceMs
    const finalWaitTime = Math.min(waitTime, optionsRef.current.maxDebounceMs);

    debounceTimeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        console.log('[useFileWatcher] Reloading file tree due to changes');
        loadFileTree('.', undefined, true);
        lastReloadRef.current = Date.now();
      }
    }, finalWaitTime);
  }, [loadFileTree]);

  // Handle file change event - stable reference
  const handleFileChange = useCallback((event: FileEvent) => {
    console.log('[useFileWatcher] File change detected:', event);

    // Update last event
    setLastEvent(event);
    
    // Call optional callback via ref
    onEventRef.current?.(event);

    // Trigger debounced reload
    debouncedReload();
  }, [debouncedReload]);

  // Connect function - stable reference
  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      return; // Already connected
    }

    console.log('[useFileWatcher] Connecting to file watcher SSE...');

    const eventSource = new EventSource('/api/files/watch', {
      withCredentials: true,
    });

    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      console.log('[useFileWatcher] SSE connection established');
      reconnectAttemptsRef.current = 0;
      setIsConnected(true);
    };

    // Use addEventListener for named events instead of onmessage
    eventSource.addEventListener('connected', () => {
      console.log('[useFileWatcher] Connected to file watcher');
    });

    eventSource.addEventListener('filechange', (message: MessageEvent) => {
      try {
        const event: FileEvent = JSON.parse(message.data);
        handleFileChange(event);
      } catch (error) {
        console.warn('[useFileWatcher] Failed to parse event:', error);
      }
    });

    eventSource.addEventListener('heartbeat', () => {
      // Heartbeat received - connection is alive
    });

    eventSource.onerror = () => {
      console.warn('[useFileWatcher] SSE connection error');
      setIsConnected(false);

      // Close current connection
      eventSource.close();
      eventSourceRef.current = null;

      // Attempt reconnect with exponential backoff
      const maxReconnectDelay = 30000;
      const reconnectDelay = Math.min(
        1000 * Math.pow(2, reconnectAttemptsRef.current),
        maxReconnectDelay
      );

      reconnectAttemptsRef.current++;

      console.log(`[useFileWatcher] Reconnecting in ${reconnectDelay}ms (attempt ${reconnectAttemptsRef.current})`);

      reconnectTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current && enabledRef.current && !eventSourceRef.current) {
          connectRef.current();
        }
      }, reconnectDelay);
    };
  }, [handleFileChange]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Disconnect function
  const disconnect = useCallback(() => {
    console.log('[useFileWatcher] Disconnecting from file watcher SSE');
    cleanup();
    setIsConnected(false);
  }, [cleanup]);

  // Effect for auto-connect/disconnect - depends only on enabled
  useEffect(() => {
    isMountedRef.current = true;

    if (enabled) {
      connect();
    } else {
      cleanup();
    }

    return () => {
      isMountedRef.current = false;
      cleanup();
    };
  }, [enabled, connect, cleanup]);

  // Return values
  return {
    isConnected,
    lastEvent,
    connect,
    disconnect,
  };
}

export type { FileEvent, UseFileWatcherOptions, UseFileWatcherReturn };
