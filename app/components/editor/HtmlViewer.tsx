'use client';

import { useRef } from 'react';
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
  onNavigationChange?: (navigated: boolean) => void;
}

export function HtmlViewer({ path, value, onChange, viewMode, refreshKey, onNavigationChange }: HtmlViewerProps) {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const previewUrl = withDocumentRevision(toHtmlPreviewUrl(path, { workspaceId }), String(refreshKey));
  const iframeLoads = useRef<{ element: HTMLIFrameElement; count: number } | null>(null);

  if (viewMode === 'code') {
    return <CodeEditor value={value} onChange={onChange} readOnly={false} />;
  }

  return (
    <iframe
      key={previewUrl}
      src={previewUrl}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
      title={`Preview: ${path}`}
      onLoad={(event) => {
        const element = event.currentTarget;
        const count = iframeLoads.current?.element === element ? iframeLoads.current.count + 1 : 1;
        iframeLoads.current = { element, count };
        onNavigationChange?.(count > 1);
      }}
    />
  );
}
