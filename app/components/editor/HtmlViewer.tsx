'use client';

import { CodeEditor } from './CodeEditorClient';
import { toHtmlPreviewUrl } from '@/app/lib/utils/media-url';
import { useWorkspaceStore } from '@/app/store/workspace-store';

interface HtmlViewerProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  viewMode: 'code' | 'preview';
  refreshKey: number;
  lastSavedAt: number | null;
}

export function HtmlViewer({ path, value, onChange, viewMode, refreshKey, lastSavedAt }: HtmlViewerProps) {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const previewUrl = toHtmlPreviewUrl(path, { workspaceId });

  if (viewMode === 'code') {
    return <CodeEditor value={value} onChange={onChange} readOnly={false} />;
  }

  return (
    <iframe
      key={`${lastSavedAt}-${refreshKey}`}
      src={previewUrl}
      sandbox="allow-scripts allow-same-origin"
      className="h-full w-full border-0 bg-white"
      title={`Preview: ${path}`}
    />
  );
}
