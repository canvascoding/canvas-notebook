'use client';

import { useSyncExternalStore } from 'react';
import { DocumentLoadingSkeleton } from './DocumentLoadingSkeleton';

import { CodeEditor as MountedCodeEditor, type CodeEditorProps } from './CodeEditor';

const subscribeToHydration = () => () => {};
const clientHydrationSnapshot = () => true;
const serverHydrationSnapshot = () => false;

export function CodeEditor(props: CodeEditorProps) {
  const mounted = useSyncExternalStore(subscribeToHydration, clientHydrationSnapshot, serverHydrationSnapshot);

  // The module ships with this view so a first Source switch also works offline.
  // Its DOM-dependent editor still mounts only after hydration.
  if (mounted) return <MountedCodeEditor {...props} />;
  return <DocumentLoadingSkeleton path={props.path} label="Loading code editor" />;
}
