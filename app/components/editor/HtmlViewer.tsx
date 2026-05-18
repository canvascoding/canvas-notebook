'use client';

import { useState } from 'react';
import { CodeEditor } from './CodeEditor';
import { toHtmlPreviewUrl } from '@/app/lib/utils/media-url';
import { HtmlPreviewBlocked, HtmlPreviewConsent } from './HtmlPreviewConsent';

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
  const fileName = path.split('/').pop() || path;
  const [acceptedPreviewPath, setAcceptedPreviewPath] = useState<string | null>(null);
  const [declinedPreviewPath, setDeclinedPreviewPath] = useState<string | null>(null);
  const hasAcceptedPreview = acceptedPreviewPath === path;
  const hasDeclinedPreview = declinedPreviewPath === path;

  if (viewMode === 'code') {
    return <CodeEditor value={value} onChange={onChange} readOnly={false} />;
  }

  if (!hasAcceptedPreview) {
    return (
      <>
        <HtmlPreviewBlocked
          fileName={fileName}
          onOpen={() => {
            setDeclinedPreviewPath(null);
            setAcceptedPreviewPath(path);
          }}
        />
        <HtmlPreviewConsent
          open={!hasDeclinedPreview}
          fileName={fileName}
          onAccept={() => setAcceptedPreviewPath(path)}
          onDecline={() => setDeclinedPreviewPath(path)}
        />
      </>
    );
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
