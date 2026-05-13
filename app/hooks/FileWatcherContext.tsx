'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getFileWatcherClient, type FileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';

interface FileWatcherContextValue {
  isConnected: boolean;
  lastEvent: FileEvent | null;
}

const FileWatcherContext = createContext<FileWatcherContextValue | null>(null);

export function FileWatcherProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<FileEvent | null>(null);
  const clientRef = useRef<FileWatcherClient | null>(null);

  useEffect(() => {
    const client = getFileWatcherClient();
    clientRef.current = client;

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
      clientRef.current = null;
    };
  }, []);

  return (
    <FileWatcherContext.Provider value={{ isConnected, lastEvent }}>
      {children}
    </FileWatcherContext.Provider>
  );
}

export function useFileWatcherContext(): FileWatcherContextValue | null {
  return useContext(FileWatcherContext);
}