import type { Root, Element, Text, Parent } from 'hast';
import { visit } from 'unist-util-visit';
import { INLINE_HEX_REGEX } from './color-swatch';

const SKIPPED_TAGS = new Set(['code', 'a', 'pre', 'script', 'style']);

function isInsideSkippedNode(node: Text): boolean {
  let current = node as unknown as Record<string, unknown> | undefined;
  while (current) {
    if (current.tagName && typeof current.tagName === 'string') {
      if (SKIPPED_TAGS.has(current.tagName as string)) return true;
    }
    current = (current as Record<string, unknown>).parent as Record<string, unknown> | undefined;
  }
  return false;
}

export function rehypeInlineColorSwatch() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (index === undefined || parent === undefined) return;
      if (isInsideSkippedNode(node)) return;

      const value = node.value;
      if (!value) return;

      INLINE_HEX_REGEX.lastIndex = 0;
      const matches = [...value.matchAll(INLINE_HEX_REGEX)];
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
            dataColorCode: match[0],
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

      (parent.children as Array<Text | Element>).splice(index, 1, ...newChildren);
    });
  };
}