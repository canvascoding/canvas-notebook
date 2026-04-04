'use client';

import { useEffect, useState } from 'react';
import { CodeEditor } from './CodeEditor';
import { toMediaUrl } from '@/app/lib/utils/media-url';

interface HtmlViewerProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  viewMode: 'code' | 'preview';
  refreshKey: number;
  lastSavedAt: number | null;
}

export function HtmlViewer({ path, value, onChange, viewMode, refreshKey, lastSavedAt }: HtmlViewerProps) {
  const [iframeKey, setIframeKey] = useState(0);
  const previewUrl = toMediaUrl(path);

  useEffect(() => {
    setIframeKey((k) => k + 1);
  }, [lastSavedAt, refreshKey]);

  if (viewMode === 'code') {
    return <CodeEditor value={value} onChange={onChange} readOnly={false} />;
  }

  return (
    <iframe
      key={iframeKey}
      src={previewUrl}
      sandbox="allow-scripts allow-same-origin"
      className="h-full w-full border-0 bg-white"
      title={`Preview: ${path}`}
    />
  );
}
