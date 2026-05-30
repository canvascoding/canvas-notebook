'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';

interface FileWatcherContextValue {
  isConnected: boolean;
  lastEvent: FileEvent | null;
}

export function FileWatcherProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const client = getFileWatcherClient();
    client.acquire();

    return () => {
      client.releaseConnection();
    };
  }, []);

  return <>{children}</>;
}

export function useFileWatcherContext(): FileWatcherContextValue {
  const [isConnected, setIsConnected] = useState(() => getFileWatcherClient().isConnected);
  const [lastEvent, setLastEvent] = useState<FileEvent | null>(null);

  useEffect(() => {
    const client = getFileWatcherClient();

    const onConnected = () => setIsConnected(true);
    const onDisconnected = () => setIsConnected(false);
    const onFileChange = (e: Event) => {
      const customEvent = e as CustomEvent<FileEvent>;
      setLastEvent(customEvent.detail);
    };

    client.addEventListener('connected', onConnected);
    client.addEventListener('disconnected', onDisconnected);
    client.addEventListener('filechange', onFileChange);

    client.acquire();

    return () => {
      client.removeEventListener('connected', onConnected);
      client.removeEventListener('disconnected', onDisconnected);
      client.removeEventListener('filechange', onFileChange);
      client.releaseConnection();
    };
  }, []);

  return { isConnected, lastEvent };
}
