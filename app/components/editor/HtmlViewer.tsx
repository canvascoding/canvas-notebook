'use client';

import { CodeEditor } from './CodeEditor';
import { toHtmlPreviewUrl } from '@/app/lib/utils/media-url';

interface HtmlViewerProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  viewMode: 'code' | 'preview';
  refreshKey: number;
  lastSavedAt: number | null;
}

export function HtmlViewer({ path, value, onChange, viewMode, refreshKey, lastSavedAt }: HtmlViewerProps) {
  const previewUrl = toHtmlPreviewUrl(path);

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
