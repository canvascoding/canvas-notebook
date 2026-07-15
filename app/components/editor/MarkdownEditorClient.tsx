'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';

import type { MarkdownEditorProps } from './MarkdownEditor';

export function MarkdownEditor(props: MarkdownEditorProps) {
  const [Editor, setEditor] = useState<ComponentType<MarkdownEditorProps> | null>(null);

  useEffect(() => {
    let active = true;
    void import('./MarkdownEditor').then((module) => {
      if (active) setEditor(() => module.MarkdownEditor);
    });
    return () => {
      active = false;
    };
  }, []);

  if (Editor) return <Editor {...props} />;
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
