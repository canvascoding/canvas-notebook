'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { synchronizeMarkdownTextSelection } from './MarkdownDomSelection';

export type PastedMarkdownLink = { href: string; text: string; canEditText: boolean };

/** A URL chooser consumes only a single plain URL, leaving code/rich/file paste alone. */
export function MarkdownUrlPaste({ editor, renderDialog }: {
  editor: Editor;
  renderDialog: (link: PastedMarkdownLink, close: () => void) => ReactNode;
}) {
  const [link, setLink] = useState<PastedMarkdownLink | null>(null);
  useEffect(() => {
    const element = editor.view.dom;
    const onPaste = (event: ClipboardEvent) => {
      if (editor.view.composing) return;
      synchronizeMarkdownTextSelection(editor.view);
      if (event.defaultPrevented || !editor.isEditable || event.clipboardData?.files.length
        || editor.isActive('link') || editor.isActive('code') || editor.isActive('codeBlock')) return;
      const href = event.clipboardData?.getData('text/plain').trim() ?? '';
      if (!/^https?:\/\/\S+$/iu.test(href) || href.length > 4096) return;
      try { new URL(href); } catch { return; }
      const { from, to, empty } = editor.state.selection;
      let containsCode = false;
      editor.state.doc.nodesBetween(from, to, (node) => {
        if (node.type.spec.code || node.marks.some((mark) => mark.type.spec.code)) containsCode = true;
      });
      if (containsCode) return;
      event.preventDefault();
      event.stopPropagation();
      setLink({ href, text: empty ? '' : editor.state.doc.textBetween(from, to, ' '), canEditText: empty });
    };
    element.addEventListener('paste', onPaste, true);
    return () => element.removeEventListener('paste', onPaste, true);
  }, [editor]);
  return link ? renderDialog(link, () => setLink(null)) : null;
}
