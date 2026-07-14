import type { Blockquote, Content, Parent, PhrasingContent, Root, Text } from 'mdast';
import type { Properties } from 'hast';

import {
  getObsidianWikiDisplayLabel,
  parseObsidianWikiTarget,
} from './obsidian-flavored-markdown';

type MarkdownNode = Content | Root;
type NodeWithData = MarkdownNode & {
  data?: {
    hName?: string;
    hProperties?: Properties;
  };
};

type TransformState = {
  inComment: boolean;
};

function textNode(value: string): Text {
  return { type: 'text', value };
}

function wikiLinkNode(rawTarget: string, embed: boolean): PhrasingContent | null {
  const target = parseObsidianWikiTarget(rawTarget);
  if (!target) return null;

  const label = getObsidianWikiDisplayLabel(target);
  return {
    type: 'link',
    url: target.path || '#',
    title: null,
    children: [textNode(embed ? `Embed: ${label}` : label)],
    data: {
      hProperties: {
        className: embed ? ['canvas-wiki-embed'] : ['canvas-wiki-link'],
        'data-canvas-wiki-block': target.blockId || undefined,
        'data-canvas-wiki-embed': embed ? 'true' : undefined,
        'data-canvas-wiki-heading': target.heading || undefined,
        'data-canvas-wiki-path': target.path,
        'data-canvas-wiki-target': target.target,
      },
    },
  };
}

function highlightNode(value: string): PhrasingContent {
  return {
    type: 'emphasis',
    children: [textNode(value)],
    data: {
      hName: 'mark',
      hProperties: { className: ['canvas-markdown-highlight'] },
    },
  };
}

function transformText(value: string, state: TransformState): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  let plainText = '';
  let index = 0;

  const flushPlainText = () => {
    if (!plainText) return;
    result.push(textNode(plainText));
    plainText = '';
  };

  while (index < value.length) {
    if (state.inComment) {
      const commentEnd = value.indexOf('%%', index);
      if (commentEnd < 0) return result;
      state.inComment = false;
      index = commentEnd + 2;
      continue;
    }

    if (value.startsWith('%%', index)) {
      flushPlainText();
      state.inComment = true;
      index += 2;
      continue;
    }

    const embed = value.startsWith('![[', index);
    const wikiLink = embed || value.startsWith('[[', index);
    if (wikiLink) {
      const contentStart = index + (embed ? 3 : 2);
      const linkEnd = value.indexOf(']]', contentStart);
      if (linkEnd >= 0) {
        const node = wikiLinkNode(value.slice(contentStart, linkEnd), embed);
        if (node) {
          flushPlainText();
          result.push(node);
          index = linkEnd + 2;
          continue;
        }
      }
    }

    if (value.startsWith('==', index)) {
      const highlightEnd = value.indexOf('==', index + 2);
      if (highlightEnd > index + 2) {
        flushPlainText();
        result.push(highlightNode(value.slice(index + 2, highlightEnd)));
        index = highlightEnd + 2;
        continue;
      }
    }

    plainText += value[index];
    index += 1;
  }

  flushPlainText();
  return result;
}

function setNodeProperties(node: NodeWithData, properties: Properties): void {
  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      ...properties,
    },
  };
}

function transformCallout(node: Blockquote): void {
  const firstBlock = node.children[0];
  if (firstBlock?.type !== 'paragraph') return;

  const firstInline = firstBlock.children[0];
  if (firstInline?.type !== 'text') return;

  const match = firstInline.value.match(/^\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+([^\r\n]*))?/);
  if (!match) return;

  const type = match[1].toLowerCase();
  const title = match[3]?.trim() || type[0].toUpperCase() + type.slice(1);
  firstInline.value = `${title}${firstInline.value.slice(match[0].length)}`;
  setNodeProperties(node, {
    className: ['canvas-callout', `canvas-callout-${type}`],
    'data-callout': type,
    'data-callout-fold': match[2] || undefined,
  });
}

function transformBlockId(node: Parent & NodeWithData): void {
  const lastChild = node.children[node.children.length - 1];
  if (lastChild?.type !== 'text') return;

  const match = lastChild.value.match(/(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/);
  if (!match) return;

  lastChild.value = lastChild.value.slice(0, match.index).trimEnd();
  if (!lastChild.value) node.children.pop();
  setNodeProperties(node, {
    id: `block-${match[1]}`,
    'data-block-id': match[1],
  });
}

function transformChildren(parent: Parent, state: TransformState): void {
  const transformed: Content[] = [];

  for (const child of parent.children) {
    if (child.type === 'text') {
      transformed.push(...transformText(child.value, state));
      continue;
    }

    if (child.type === 'inlineCode' || child.type === 'code' || child.type === 'html') {
      if (!state.inComment) transformed.push(child);
      continue;
    }

    if (child.type === 'link' || child.type === 'image' || child.type === 'definition') {
      if (!state.inComment) transformed.push(child);
      continue;
    }

    if ('children' in child && Array.isArray(child.children)) {
      if (child.type === 'blockquote') transformCallout(child);
      if (child.type === 'paragraph' || child.type === 'heading') transformBlockId(child);
      transformChildren(child, state);

      if (child.children.length > 0 || child.type === 'paragraph') {
        transformed.push(child);
      }
      continue;
    }

    if (!state.inComment) transformed.push(child);
  }

  parent.children = transformed;
}

export function remarkObsidianFlavoredMarkdown() {
  return (tree: Root) => {
    transformChildren(tree, { inComment: false });
  };
}
