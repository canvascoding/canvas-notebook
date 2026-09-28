'use client';

import { useEffect, useState, type ComponentType } from 'react';

import { captureClientException } from '@/app/lib/observability/capture-client-exception';
import { EditorFailureNotice } from './EditorErrorBoundary';
import { DocumentLoadingSkeleton } from './DocumentLoadingSkeleton';
import type { MarkdownEditorProps } from './MarkdownEditor';

let cachedEditor: ComponentType<MarkdownEditorProps> | null = null;

export function MarkdownEditor(props: MarkdownEditorProps) {
  const [loadAttempt, setLoadAttempt] = useState(0);

  return (
    <MarkdownEditorLoader
      key={`${props.documentKey ?? props.filePath ?? ''}:${loadAttempt}`}
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
  const [Editor, setEditor] = useState<ComponentType<MarkdownEditorProps> | null>(() => cachedEditor);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (Editor) return;
    let active = true;

    void import('./MarkdownEditor')
      .then((module) => {
        cachedEditor = module.MarkdownEditor;
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
  }, [Editor]);

  if (Editor) return <Editor {...props} />;
  if (loadError) {
    return <EditorFailureNotice onRetry={onRetry} />;
  }

  return <DocumentLoadingSkeleton path={props.filePath} label="Loading Markdown editor" />;
}
