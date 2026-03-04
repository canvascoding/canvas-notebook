'use client';

import { AlertCircle, FileText, Loader2 } from 'lucide-react';
import { useFileStore } from '@/app/store/file-store';

export function FilePreview() {
  const { currentFile, isLoadingFile, fileError } = useFileStore();

  if (isLoadingFile) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (fileError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <AlertCircle className="h-6 w-6 text-red-400" />
        <p className="text-sm text-red-500">{fileError}</p>
      </div>
    );
  }

  if (!currentFile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <FileText className="h-6 w-6" />
        <p className="text-sm">Select a file to preview.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-sm text-muted-foreground">
        {currentFile.path}
      </div>
      <pre className="flex-1 overflow-auto p-4 text-sm text-foreground">
        {currentFile.content}
      </pre>
    </div>
  );
}
