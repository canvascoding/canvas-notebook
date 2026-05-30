'use client';

import { FileBrowser } from '@/app/components/file-browser/FileBrowser';
import { FileWatcherProvider } from '@/app/hooks/FileWatcherContext';

export function FilesContainer() {
  return (
    <FileWatcherProvider>
      <FileBrowser variant="fullscreen" />
    </FileWatcherProvider>
  );
}
