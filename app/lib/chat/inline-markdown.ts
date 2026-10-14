import type { Element, Root, RootContent } from 'hast';
import { parseChatBody, projectChatBodyText, type ChatBodyV1, type ChatReferenceBundleV1 } from './chat-body-contracts';

export type ChatInlineMarkdownPresentation = {
  markdown: string;
  rehypePlugin: () => (tree: Root) => void;
  /** Only nodes minted by the final transform are reference presentation, never HTML attributes. */
  referenceForNode: (node: unknown) => ChatReferenceBundleV1 | undefined;
};

/**
 * Keep ordinary Markdown around opaque inline references. Captions never enter
 * the Markdown parser. Unsupported syntax falls back to the literal stored body.
 */
export function createChatInlineMarkdownPresentation(value: ChatBodyV1): ChatInlineMarkdownPresentation {
  const body = parseChatBody(value), projected = projectChatBodyText(body);
  const taken = new Set([...projected.matchAll(/CanvasInlineReference([0-9]+)Token/gi)].map(match => match[1]));
  let seed = 0; while (taken.has(String(seed))) seed++;
  const prefix = `CanvasInlineReference${seed}Token`;
  const bundles = new Map(body.bundles.map(bundle => [bundle.id, bundle]));
  const occurrences: ChatReferenceBundleV1[] = [];
  const markdown = body.parts.map(part => {
    if (part.type === 'text') return part.text;
    const index = occurrences.length; occurrences.push(bundles.get(part.bundleId)!);
    return `${prefix}Ref${index}End`;
  }).join('');
  const references = new WeakMap<object, ChatReferenceBundleV1>();
  const referenceNode = (bundle: ChatReferenceBundleV1): Element => {
    const element: Element = { type: 'element', tagName: 'span', properties: {}, children: [{ type: 'text', value: bundle.caption }] };
    references.set(element, bundle); return element;
  };
  const literalFallback = (tree: Root) => {
    tree.children = [{ type: 'element', tagName: 'p', properties: { className: ['whitespace-pre-wrap'] },
      children: body.parts.map(part => part.type === 'text' ? { type: 'text' as const, value: part.text } : referenceNode(bundles.get(part.bundleId)!)) }];
  };
  const rehypePlugin = () => (tree: Root) => {
    const seen = new Array<number>(occurrences.length).fill(0);
    let unsupported = false;
    const containsMarker = (value: unknown): boolean => typeof value === 'string' ? value.toLowerCase().includes(prefix.toLowerCase())
      : Array.isArray(value) ? value.some(containsMarker) : false;
    const walk = (parent: Root | Element, inCode = false) => {
      const next: RootContent[] = [];
      for (const node of parent.children) {
        if (node.type === 'text') {
          const matches = [...node.value.matchAll(new RegExp(`${prefix}Ref([0-9]+)End`, 'g'))];
          if (!matches.length) { if (containsMarker(node.value)) unsupported = true; next.push(node); continue; }
          // Code, math and raw/link-destination syntax must not execute or swallow a caption.
          if (inCode) unsupported = true;
          let start = 0;
          for (const match of matches) {
            const index = Number(match[1]), bundle = occurrences[index];
            if (!bundle) { unsupported = true; continue; }
            seen[index]++;
            if (match.index! > start) next.push({ type: 'text', value: node.value.slice(start, match.index) });
            next.push(referenceNode(bundle)); start = match.index! + match[0].length;
          }
          if (start < node.value.length) next.push({ type: 'text', value: node.value.slice(start) });
        } else if (node.type === 'element') {
          for (const [key, property] of Object.entries(node.properties)) {
            if (!containsMarker(property)) continue;
            if (key === 'id') delete node.properties[key]; // Generated heading anchors must never leak an internal marker.
            else unsupported = true;
          }
          const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
          walk(node, inCode || node.tagName === 'code' || node.tagName === 'pre' || node.tagName === 'math'
            || classes.includes('katex') || classes.includes('katex-display')); next.push(node);
        } else {
          if ('value' in node && containsMarker(node.value)) unsupported = true;
          next.push(node);
        }
      }
      parent.children = next as Element['children'];
    };
    walk(tree);
    if (unsupported || seen.some(count => count !== 1)) literalFallback(tree);
  };
  return { markdown, rehypePlugin, referenceForNode: node => node && typeof node === 'object' ? references.get(node) : undefined };
}
