'use client';

import { FileBrowser } from '@/app/components/file-browser/FileBrowser';

interface FilesContainerProps {
  username: string;
}

export function FilesContainer({ username }: FilesContainerProps) {
  return <FileBrowser variant="fullscreen" username={username} />;
}