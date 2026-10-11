import { EditorView, ViewPlugin } from '@codemirror/view';
import { createMobileEditorViewport } from './mobile-editor-viewport';

const mobileViewport = ViewPlugin.define(view => {
  const pane = view.dom.closest<HTMLElement>('.markdown-editor-pane');
  const viewport = pane ? createMobileEditorViewport({ pane, scroller: view.scrollDOM, content: view.contentDOM,
    readCaret: () => view.coordsAtPos(view.state.selection.main.head), isComposing: () => view.composing }) : null;
  return { viewport, destroy: () => viewport?.destroy() };
});

export const mobileMarkdownSourceViewport = [
  mobileViewport,
  EditorView.scrollHandler.of((view, range, options) => {
    // Mode handoffs and explicit start/center navigation retain their own policy.
    if (options.y !== 'nearest') return false;
    return view.plugin(mobileViewport)?.viewport?.scrollToCaret(view.coordsAtPos(range.head)) ?? false;
  }),
];
