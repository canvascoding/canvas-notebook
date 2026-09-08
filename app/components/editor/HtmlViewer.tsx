'use client';

import { withDocumentRevision } from '@/app/lib/files/document-capabilities';
import { CodeEditor } from './CodeEditorClient';
import { toHtmlPreviewUrl } from '@/app/lib/utils/media-url';
import { useWorkspaceStore } from '@/app/store/workspace-store';

interface HtmlViewerProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  viewMode: 'code' | 'preview';
  refreshKey: number;
  revision?: string;
  lastSavedAt: number | null;
}

export function HtmlViewer({ path, value, onChange, viewMode, refreshKey, lastSavedAt, revision }: HtmlViewerProps) {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const previewUrl = withDocumentRevision(toHtmlPreviewUrl(path, { workspaceId }), `${revision ?? ''}:${lastSavedAt ?? ''}:${refreshKey}`);

  if (viewMode === 'code') {
    return <CodeEditor value={value} onChange={onChange} readOnly={false} />;
  }

  return (
    <iframe
      key={previewUrl}
      src={previewUrl}
      sandbox="allow-scripts allow-same-origin"
      className="h-full w-full border-0 bg-white"
      title={`Preview: ${path}`}
    />
  );
}
