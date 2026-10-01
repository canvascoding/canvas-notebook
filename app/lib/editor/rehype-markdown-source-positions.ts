import type { Element, Parent, Root } from 'hast';

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'table', 'th', 'td', 'hr', 'img', 'details']);

/** Only enabled by document editors; offsets refer to their complete source including YAML. */
export function rehypeMarkdownSourcePositions({ offset = 0 }: { offset?: number }) {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      for (const child of parent.children) {
        if (child.type !== 'element') continue;
        const element = child as Element;
        const from = element.position?.start.offset;
        const to = element.position?.end.offset;
        if (BLOCKS.has(element.tagName) && from !== undefined && to !== undefined) {
          element.properties['data-markdown-source-from'] = from + offset;
          element.properties['data-markdown-source-to'] = to + offset;
        }
        visit(element);
      }
    };
    visit(tree);
  };
}
