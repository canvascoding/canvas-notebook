'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';

import { captureClientException } from '@/app/lib/observability/capture-client-exception';
import { EditorFailureNotice } from './EditorErrorBoundary';
import type { MarkdownEditorProps } from './MarkdownEditor';

export function MarkdownEditor(props: MarkdownEditorProps) {
  const [loadAttempt, setLoadAttempt] = useState(0);

  return (
    <MarkdownEditorLoader
      key={loadAttempt}
      props={props}
      onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
    />
  );
}

function MarkdownEditorLoader({
  props,
  onRetry,
}: {
  props: MarkdownEditorProps;
  onRetry: () => void;
}) {
  const [Editor, setEditor] = useState<ComponentType<MarkdownEditorProps> | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;

    void import('./MarkdownEditor')
      .then((module) => {
        if (active) setEditor(() => module.MarkdownEditor);
      })
      .catch((error: unknown) => {
        const loadFailure = error instanceof Error
          ? error
          : new Error('Unable to load the Markdown editor.');
        captureClientException(loadFailure, {
          boundary: 'markdown-editor-dynamic-import',
          tags: { 'editor.kind': 'markdown' },
        });
        if (active) setLoadError(loadFailure);
      });

    return () => {
      active = false;
    };
  }, []);

  if (Editor) return <Editor {...props} />;
  if (loadError) {
    return <EditorFailureNotice onRetry={onRetry} />;
  }

  return (
    <div
      className="flex h-full min-h-24 items-center justify-center bg-background"
      role="status"
      aria-label="Loading Markdown editor"
    >
      <Loader2
        className="h-5 w-5 animate-spin text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}
