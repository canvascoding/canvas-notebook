import type { Root, Element, Text, Parent } from 'hast';
import { INLINE_HEX_REGEX } from './color-swatch';

const SKIPPED_TAGS = new Set(['code', 'a', 'pre', 'script', 'style']);

interface Replacement {
  parent: Parent;
  index: number;
  nodes: Array<Text | Element>;
}

export function rehypeInlineColorSwatch() {
  return (tree: Root) => {
    const replacements: Replacement[] = [];

    function collectReplacements(parent: Parent, skipped: boolean): void {
      parent.children.forEach((node, index) => {
        if (node.type === 'element') {
          const shouldSkip = skipped || SKIPPED_TAGS.has(node.tagName);
          collectReplacements(node, shouldSkip);
          return;
        }

        if (skipped || node.type !== 'text') return;

        const value = node.value;
        if (!value) return;

        const regex = new RegExp(INLINE_HEX_REGEX.source, INLINE_HEX_REGEX.flags);
        const matches = [...value.matchAll(regex)];
        if (matches.length === 0) return;

        const newChildren: Array<Text | Element> = [];
        let lastIndex = 0;

        for (const match of matches) {
          const matchStart = match.index!;
          const matchEnd = matchStart + match[0].length;

          if (matchStart > lastIndex) {
            newChildren.push({
              type: 'text',
              value: value.slice(lastIndex, matchStart),
            });
          }

          newChildren.push({
            type: 'element',
            tagName: 'span',
            properties: {
              className: ['color-swatch-container'],
              'data-color-code': match[0],
            },
            children: [],
          });

          lastIndex = matchEnd;
        }

        if (lastIndex < value.length) {
          newChildren.push({
            type: 'text',
            value: value.slice(lastIndex),
          });
        }

        replacements.push({ parent, index, nodes: newChildren });
      });
    }

    collectReplacements(tree, false);

    // Apply replacements in reverse order so indices remain valid
    for (const { parent, index, nodes } of replacements.reverse()) {
      (parent.children as Array<Text | Element>).splice(index, 1, ...nodes);
    }
  };
}
