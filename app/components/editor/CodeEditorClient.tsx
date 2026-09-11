'use client';

import { Loader2 } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { CodeEditor as MountedCodeEditor, type CodeEditorProps } from './CodeEditor';

const subscribeToHydration = () => () => {};
const clientHydrationSnapshot = () => true;
const serverHydrationSnapshot = () => false;

export function CodeEditor(props: CodeEditorProps) {
  const mounted = useSyncExternalStore(subscribeToHydration, clientHydrationSnapshot, serverHydrationSnapshot);

  // The module ships with this view so a first Source switch also works offline.
  // Its DOM-dependent editor still mounts only after hydration.
  if (mounted) return <MountedCodeEditor {...props} />;
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
