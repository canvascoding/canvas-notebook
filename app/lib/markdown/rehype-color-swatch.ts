import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';
import { isColorCode } from './color-swatch';

function extractText(node: Element | { type: string; value?: unknown; children?: unknown[] }): string {
  if (!node) return '';
  const n = node as { type?: string; value?: unknown; children?: unknown[] };
  if (n.value !== undefined) {
    return String(n.value);
  }
  if (Array.isArray(n.children)) {
    return n.children
      .map((child) => extractText(child as Element))
      .join('');
  }
  return '';
}

/**
 * Rehype plugin that transforms inline color codes in <code> elements
 * into <span data-color-code="..."> BEFORE rehype-prism-plus processes them.
 * Only processes inline code (no language-* class) that contains valid color codes.
 */
export function rehypeColorSwatch() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      // Only process <code> elements without language-* class (inline code)
      if (node.tagName === 'code') {
        const classNames = (node.properties?.className as string[]) || [];
        const hasLanguageClass = classNames.some(c => c.startsWith('language-'));
        
        // Skip if it's a code block (has language-* class)
        if (hasLanguageClass) {
          return;
        }
        
        const rawCode = extractText(node);
        
        // Only transform if it's actually a color code
        if (isColorCode(rawCode)) {
          // Transform to span with color code data attribute
          node.tagName = 'span';
          node.properties = {
            ...node.properties,
            className: ['color-swatch-container'],
            'data-color-code': rawCode,
          };
          // Clear children - the actual rendering will be done by component
          node.children = [];
        }
      }
    });
  };
}
