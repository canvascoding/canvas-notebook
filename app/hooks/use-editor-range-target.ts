'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor, Range } from '@tiptap/core';
import { createEditorRangeTarget, resolveEditorRangeTarget, type EditorRangeTarget } from '../lib/editor/interaction-target';

/** A dialog owns its initial target; reopening for another action remounts it. */
export function useEditorRangeTarget(editor: Editor | null, open: boolean, range?: Range, prepared?: EditorRangeTarget | null) {
  const [target] = useState(() => prepared !== undefined ? prepared : (editor && open ? createEditorRangeTarget(editor, range) : null));
  const activeEditor = useRef<Editor | null>(null);
  useEffect(() => {
    activeEditor.current = open ? editor : null;
    return () => { activeEditor.current = null; };
  }, [editor, open]);
  return useCallback(() => editor && activeEditor.current === editor ? resolveEditorRangeTarget(editor, target) : null, [editor, target]);
}
