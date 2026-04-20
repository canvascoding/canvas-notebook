import { visit } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';

function extractText(node: any): string {
  if (!node) return '';
  if (node.value !== undefined) {
    return String(node.value);
  }
  if (Array.isArray(node.children)) {
    return node.children
      .map((child: any) => extractText(child))
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