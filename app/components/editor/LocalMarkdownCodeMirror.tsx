'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EditorState, StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getDefaultExtensions, type BasicSetupOptions } from '@uiw/react-codemirror';

import type { LocalMarkdownDocument } from '@/app/lib/editor/local-markdown-document';
import { createLocalMarkdownSourceBinding } from '@/app/lib/editor/local-markdown-source-binding';

/** The regular UIW setup with the document-owned dispatch entry point. */
export function LocalMarkdownCodeMirror({ document, extensions, readOnly, theme, basicSetup, style, onCreateEditor }: {
  document: LocalMarkdownDocument; extensions: Extension[]; readOnly: boolean; theme: 'light' | 'dark';
  basicSetup: BasicSetupOptions; style: CSSProperties; onCreateEditor: (view: EditorView) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const binding = useMemo(() => createLocalMarkdownSourceBinding(document), [document]);
  const [view, setView] = useState<EditorView | null>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    const next = new EditorView({ parent: host.current,
      state: EditorState.create({ doc: document.getSnapshot().markdown, extensions: binding.extensions }),
      dispatchTransactions: binding.dispatchTransactions });
    setView(next);
    return () => { next.destroy(); };
  }, [binding, document]);
  useLayoutEffect(() => {
    if (!view) return;
    view.dispatch({ effects: StateEffect.reconfigure.of([
      ...getDefaultExtensions({ basicSetup: { ...basicSetup, history: false, historyKeymap: false },
        theme, editable: !readOnly, readOnly }),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
      ...extensions, ...binding.extensions,
    ]) });
  }, [basicSetup, binding, extensions, readOnly, theme, view]);
  useEffect(() => { if (view) onCreateEditor(view); }, [onCreateEditor, view]);
  return <div ref={host} style={style} className="codemirror-wrapper" />;
}
