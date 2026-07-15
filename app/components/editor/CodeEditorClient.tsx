'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';

import type { CodeEditorProps } from './CodeEditor';

export function CodeEditor(props: CodeEditorProps) {
  const [Editor, setEditor] = useState<ComponentType<CodeEditorProps> | null>(null);

  useEffect(() => {
    let active = true;
    void import('./CodeEditor').then((module) => {
      if (active) setEditor(() => module.CodeEditor);
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
      aria-label="Loading code editor"
    >
      <Loader2
        className="h-5 w-5 animate-spin text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}
