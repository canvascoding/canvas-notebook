import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';

function extractText(node: Element | unknown): string {
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
 * Rehype plugin that transforms mermaid code blocks BEFORE rehype-prism-plus
 * processes them. Converts <pre><code class="language-mermaid">...</code></pre>
 * into <div data-mermaid-code="raw code here"></div>
 */
export function rehypeMermaid() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (
        node.tagName === 'pre' &&
        node.children &&
        node.children.length > 0 &&
        (node.children[0] as Element).tagName === 'code'
      ) {
        const codeNode = node.children[0] as Element;
        const classNames = (codeNode.properties?.className as string[]) || [];
        
        if (classNames.includes('language-mermaid')) {
          const rawCode = extractText(codeNode);
          
          node.tagName = 'div';
          node.properties = {
            className: ['mermaid-container'],
            'data-mermaid-code': rawCode,
          };
          node.children = [];
        }
      }
    });
  };
}