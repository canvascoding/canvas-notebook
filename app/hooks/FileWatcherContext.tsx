'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useFileWatcher, type UseFileWatcherReturn } from '@/app/hooks/useFileWatcher';

const FileWatcherContext = createContext<UseFileWatcherReturn | null>(null);

export function FileWatcherProvider({ children }: { children: ReactNode }) {
  const watcher = useFileWatcher({ enabled: true, debounceMs: 1000, maxDebounceMs: 5000 });

  return (
    <FileWatcherContext.Provider value={watcher}>
      {children}
    </FileWatcherContext.Provider>
  );
}

export function useFileWatcherContext(): UseFileWatcherReturn | null {
  return useContext(FileWatcherContext);
}