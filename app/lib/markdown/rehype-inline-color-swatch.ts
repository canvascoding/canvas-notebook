import type { Root, Element, Text, Parent } from 'hast';
import { visit } from 'unist-util-visit';
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
    
    visit(tree, 'text', (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (index === undefined || parent === undefined) return;
      
      // Skip if inside <code>, <pre>, <a>, <script>, or <style> elements
      if (parent.type === 'element' && 'tagName' in parent && SKIPPED_TAGS.has((parent as Element).tagName)) return;

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

      replacements.push({ parent, index, nodes: newChildren });
    });

    // Apply replacements in reverse order so indices remain valid
    for (const { parent, index, nodes } of replacements.reverse()) {
      (parent.children as Array<Text | Element>).splice(index, 1, ...nodes);
    }
  };
}