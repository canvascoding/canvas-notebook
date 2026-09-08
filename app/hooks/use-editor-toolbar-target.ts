'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { createEditorSelectionTarget, resolveEditorSelectionTarget, type EditorSelectionTarget } from '../lib/editor/interaction-target';

/** Freeze on press/menu opening, so a remote transaction cannot replace the intended target. */
export function useEditorToolbarTarget(editor: Editor | null) {
  const state = useRef<{ editor: Editor; held: boolean; target: EditorSelectionTarget | null } | null>(null);
  useEffect(() => {
    if (!editor) return;
    const current = { editor, held: false, target: createEditorSelectionTarget(editor) };
    state.current = current;
    const capture = () => { if (!current.held) current.target = createEditorSelectionTarget(editor); };
    const destroy = () => { if (state.current === current) state.current = null; };
    editor.on('focus', capture);
    editor.on('selectionUpdate', capture);
    editor.on('transaction', capture);
    editor.on('destroy', destroy);
    return () => {
      destroy();
      editor.off('focus', capture);
      editor.off('selectionUpdate', capture);
      editor.off('transaction', capture);
      editor.off('destroy', destroy);
    };
  }, [editor]);
  const hold = useCallback(() => {
    const current = state.current;
    if (!editor || current?.editor !== editor) return;
    if (!current.held) current.target = createEditorSelectionTarget(editor);
    current.held = true;
  }, [editor]);
  const release = useCallback(() => {
    const current = state.current;
    if (editor && current?.editor === editor) current.held = false;
  }, [editor]);
  const restore = useCallback(() => {
    const current = state.current;
    if (!editor || current?.editor !== editor) return null;
    const selection = resolveEditorSelectionTarget(editor, current.target);
    if (!selection) return null;
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.commands.focus();
    return { from: selection.from, to: selection.to };
  }, [editor]);
  return { hold, release, restore };
}
