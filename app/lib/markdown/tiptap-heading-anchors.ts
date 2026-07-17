import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { createMarkdownHeadingAnchorFactory } from './heading-anchor';

const MARKDOWN_HEADING_ANCHORS_PLUGIN_KEY = new PluginKey('markdownHeadingAnchors');

export const MarkdownHeadingAnchors = Extension.create({
  name: 'markdownHeadingAnchors',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: MARKDOWN_HEADING_ANCHORS_PLUGIN_KEY,
        props: {
          decorations: (state) => {
            const decorations: Decoration[] = [];
            const nextAnchor = createMarkdownHeadingAnchorFactory();

            state.doc.descendants((node, position) => {
              if (node.type.name === 'heading') {
                decorations.push(Decoration.node(position, position + node.nodeSize, {
                  id: nextAnchor(node.textContent),
                }));
              }
              return true;
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
