import type { Element, Parent, Root, Text } from 'hast';

import { createMarkdownHeadingAnchorFactory } from './heading-anchor';

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function textContent(node: Element | Text): string {
  if (node.type === 'text') return node.value;
  return node.children
    .filter((child): child is Element | Text => child.type === 'element' || child.type === 'text')
    .map(textContent)
    .join('');
}

export function rehypeHeadingAnchors() {
  return (tree: Root) => {
    const nextAnchor = createMarkdownHeadingAnchorFactory();

    function addHeadingAnchors(parent: Parent): void {
      for (const node of parent.children) {
        if (node.type !== 'element') continue;
        if (HEADING_TAGS.has(node.tagName)) {
          node.properties.id = nextAnchor(textContent(node));
        }
        addHeadingAnchors(node);
      }
    }

    addHeadingAnchors(tree);
  };
}
