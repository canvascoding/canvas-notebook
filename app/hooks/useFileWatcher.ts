import { useEffect, useRef, useCallback, useState } from 'react';
import { useFileStore } from '@/app/store/file-store';

interface FileEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  relativePath: string;
  dir: string;
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

async function syncExpandedDirs(clientId: string, expandedDirs: Set<string>) {
  const dirs = Array.from(expandedDirs);
  try {
    await fetch('/api/files/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ clientId, dirs }),
    });
  } catch {
    // Non-critical: server will fall back to broadcasting all events
  }
}

export function useFileWatcher(options: UseFileWatcherOptions = {}): UseFileWatcherReturn {
  const {
    enabled = true,
    debounceMs = 1000,
    maxDebounceMs = 5000,
    onEvent,
  } = options;

  const { loadSubdirectory, refreshRootTree } = useFileStore();

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingDirRef = useRef<string>('.');
  const lastReloadRef = useRef<number>(0);
  const reconnectAttemptsRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(false);
  const connectRef = useRef<() => void>(() => {});
  const clientIdRef = useRef<string | null>(null);
  const syncTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [lastEvent, setLastEvent] = useState<FileEvent | null>(null);

  const enabledRef = useRef(enabled);
  const onEventRef = useRef(onEvent);
  const optionsRef = useRef({ debounceMs, maxDebounceMs });

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { optionsRef.current = { debounceMs, maxDebounceMs }; }, [debounceMs, maxDebounceMs]);

  const scheduleSync = useCallback(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      const clientId = clientIdRef.current;
      if (!clientId) return;
      const expanded = useFileStore.getState().expandedDirs;
      syncExpandedDirs(clientId, expanded);
    }, 200);
  }, []);

  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    clientIdRef.current = null;
    reconnectAttemptsRef.current = 0;
  }, []);

  const debouncedReload = useCallback((dir: string = '.') => {
    const now = Date.now();
    const timeSinceLastReload = now - lastReloadRef.current;

    pendingDirRef.current = dir;

    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    const waitTime = Math.max(0, optionsRef.current.debounceMs - timeSinceLastReload);
    const finalWaitTime = Math.min(waitTime, optionsRef.current.maxDebounceMs);

    debounceTimeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        const targetDir = pendingDirRef.current;
        const currentExpanded = useFileStore.getState().expandedDirs;
        if (targetDir === '.') {
          refreshRootTree(true);
        } else if (currentExpanded.has(targetDir)) {
          loadSubdirectory(targetDir, true);
        }
        lastReloadRef.current = Date.now();
      }
    }, finalWaitTime);
  }, [loadSubdirectory, refreshRootTree]);

  const handleFileChange = useCallback((event: FileEvent) => {
    const dir = event.dir || (event.relativePath.includes('/')
      ? event.relativePath.substring(0, event.relativePath.lastIndexOf('/'))
      : '.');

    setLastEvent(event);
    onEventRef.current?.(event);
    debouncedReload(dir);
  }, [debouncedReload]);

  const connect = useCallback(() => {
    if (eventSourceRef.current) return;

    const eventSource = new EventSource('/api/files/watch', {
      withCredentials: true,
    });

    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setIsConnected(true);
    };

    eventSource.addEventListener('connected', (message: MessageEvent) => {
      try {
        const data = JSON.parse(message.data);
        if (data.clientId) {
          clientIdRef.current = data.clientId;
          const expanded = useFileStore.getState().expandedDirs;
          syncExpandedDirs(data.clientId, expanded);
        }
      } catch {
        // fallback: no clientId, server broadcasts all
      }
    });

    eventSource.addEventListener('filechange', (message: MessageEvent) => {
      try {
        const event: FileEvent = JSON.parse(message.data);
        handleFileChange(event);
      } catch (error) {
        console.warn('[useFileWatcher] Failed to parse event:', error);
      }
    });

    eventSource.addEventListener('heartbeat', () => {});

    eventSource.onerror = () => {
      setIsConnected(false);
      clientIdRef.current = null;

      eventSource.close();
      eventSourceRef.current = null;

      const maxReconnectDelay = 30000;
      const reconnectDelay = Math.min(
        1000 * Math.pow(2, reconnectAttemptsRef.current),
        maxReconnectDelay
      );

      reconnectAttemptsRef.current++;

      reconnectTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current && enabledRef.current && !eventSourceRef.current) {
          connectRef.current();
        }
      }, reconnectDelay);
    };
  }, [handleFileChange]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  const disconnect = useCallback(() => {
    cleanup();
    setIsConnected(false);
  }, [cleanup]);

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

  useEffect(() => {
    if (!isConnected) return;
    const expanded = useFileStore.getState().expandedDirs;
    if (clientIdRef.current && expanded.size > 0) {
      scheduleSync();
    }
  }, [isConnected, scheduleSync]);

  useEffect(() => {
    if (!isConnected) return;
    return useFileStore.subscribe(
      (state, prevState) => {
        if (state.expandedDirs === prevState.expandedDirs) return;
        if (!clientIdRef.current) return;
        scheduleSync();
      }
    );
  }, [isConnected, scheduleSync]);

  return {
    isConnected,
    lastEvent,
    connect,
    disconnect,
  };
}

export type { FileEvent, UseFileWatcherOptions, UseFileWatcherReturn };
