'use client';

import { useEffect, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';

/** Body-mounted bubbles only own their editor, menu and explicit child portals. */
export function useMarkdownBubbleMenuFocus(
  editor: Editor,
  pluginKey: string,
  root: RefObject<HTMLElement | null>,
  portals?: RefObject<ReadonlyMap<string, HTMLElement>>,
) {
  useEffect(() => {
    const editorElement = editor.view.dom;
    const ownerDocument = editorElement.ownerDocument;
    const ownsFocus = (target: EventTarget | null) => target instanceof Node
      && (editorElement.contains(target) || Boolean(root.current?.contains(target))
        || Boolean(portals && Array.from(portals.current.values()).some(portal => portal.contains(target))));
    const hideOutside = (target: EventTarget | null) => {
      if (editor.isDestroyed || !root.current?.isConnected || ownsFocus(target)) return;
      // Do not restore focus: the header or another control now owns it. This
      // presentation metadata never changes document content or selection.
      editor.commands.setMeta(pluginKey, 'hide');
    };
    const onBlur = ({ event }: { event: FocusEvent }) => hideOutside(event.relatedTarget);
    const onFocusIn = (event: FocusEvent) => hideOutside(event.target);
    editor.on('blur', onBlur);
    ownerDocument.addEventListener('focusin', onFocusIn, true);
    return () => {
      editor.off('blur', onBlur);
      ownerDocument.removeEventListener('focusin', onFocusIn, true);
    };
  }, [editor, pluginKey, root, portals]);
}
