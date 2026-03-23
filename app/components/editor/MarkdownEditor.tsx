'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';

const MDEditor = dynamic(
  () => import('@uiw/react-md-editor').then((mod) => mod.default),
  { ssr: false }
);

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const { resolvedTheme } = useTheme();
  const colorMode = resolvedTheme === 'light' ? 'light' : 'dark';
  const [previewMode, setPreviewMode] = useState<'edit' | 'live' | 'preview'>('live');
  const hasSetPreview = useRef(false);

  // Switch to preview mode once content is available
  useEffect(() => {
    if (!hasSetPreview.current && value) {
      hasSetPreview.current = true;
      setPreviewMode('preview');
    }
  }, [value]);

  return (
    <div className="h-full overflow-hidden" data-color-mode={colorMode}>
      <MDEditor
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? '')}
        preview={previewMode}
        visibleDragbar={false}
        height="100%"
        style={{ height: '100%' }}
      />
    </div>
  );
}
