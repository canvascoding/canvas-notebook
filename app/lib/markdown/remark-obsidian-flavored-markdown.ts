import type { Blockquote, Content, Parent, PhrasingContent, Root, Text } from 'mdast';
import type { Properties } from 'hast';

import {
  getObsidianWikiDisplayLabel,
  parseObsidianWikiTarget,
} from './obsidian-flavored-markdown';
import { isMarkdownImagePath } from './markdown-image-types';

type MarkdownNode = Content | Root;
type NodeWithData = MarkdownNode & {
  data?: {
    hName?: string;
    hProperties?: Properties;
  };
};

type TransformState = {
  inComment: boolean;
  inlineFootnoteIndex: number;
};

function textNode(value: string): Text {
  return { type: 'text', value };
}

function wikiLinkNode(rawTarget: string, embed: boolean): PhrasingContent | null {
  const target = parseObsidianWikiTarget(rawTarget);
  if (!target) return null;

  const label = getObsidianWikiDisplayLabel(target);
  if (embed && target.path && isMarkdownImagePath(target.path)) {
    return {
      type: 'image',
      url: target.path,
      title: null,
      alt: label,
    };
  }

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

function inlineFootnoteNode(value: string, index: number): PhrasingContent {
  return {
    type: 'emphasis',
    children: [textNode(value)],
    data: {
      hName: 'sup',
      hProperties: {
        'data-inline-footnote': value,
        'data-inline-footnote-index': String(index),
      },
    },
  };
}

function mentionNode(label: string, userId: string): PhrasingContent {
  return {
    type: 'emphasis',
    children: [textNode(`@${label}`)],
    data: {
      hName: 'span',
      hProperties: {
        className: ['canvas-markdown-mention'],
        'data-canvas-mention-label': label,
        'data-canvas-mention-user-id': userId,
      },
    },
  };
}

function findEscapedWikiStarts(value: string, sourceValue: string): Set<number> {
  const starts = new Set<number>();
  let sourceIndex = 0;
  let valueIndex = 0;

  while (sourceIndex < sourceValue.length && valueIndex < value.length) {
    if (
      sourceValue[sourceIndex] === '\\'
      && sourceValue[sourceIndex + 1] === value[valueIndex]
    ) {
      const escapedValue = sourceValue.slice(sourceIndex + 1);
      if (
        escapedValue.startsWith('[[')
        || escapedValue.startsWith('![[')
        || escapedValue.startsWith('^[')
      ) {
        starts.add(valueIndex);
      }
      sourceIndex += 1;
      continue;
    }

    if (sourceValue[sourceIndex] === value[valueIndex]) {
      sourceIndex += 1;
      valueIndex += 1;
      continue;
    }

    sourceIndex += 1;
  }

  return starts;
}

function transformText(
  value: string,
  state: TransformState,
  escapedWikiStarts: Set<number> = new Set(),
): PhrasingContent[] {
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

    if (escapedWikiStarts.has(index)) {
      const openerLength = value.startsWith('![[', index) ? 3 : 2;
      plainText += value.slice(index, index + openerLength);
      index += openerLength;
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

    if (value.startsWith('^[', index)) {
      let footnoteEnd = index + 2;
      while (footnoteEnd < value.length) {
        if (value[footnoteEnd] === ']' && value[footnoteEnd - 1] !== '\\') break;
        footnoteEnd += 1;
      }
      if (footnoteEnd < value.length && footnoteEnd > index + 2) {
        flushPlainText();
        state.inlineFootnoteIndex += 1;
        result.push(inlineFootnoteNode(
          value.slice(index + 2, footnoteEnd).replace(/\\\]/gu, ']'),
          state.inlineFootnoteIndex,
        ));
        index = footnoteEnd + 1;
        continue;
      }
    }

    if (value.startsWith('@{', index)) {
      const separator = value.indexOf('|', index + 2);
      const mentionEnd = separator >= 0 ? value.indexOf('}', separator + 1) : -1;
      if (separator > index + 2 && mentionEnd > separator + 1) {
        const label = value.slice(index + 2, separator).trim();
        const userId = value.slice(separator + 1, mentionEnd).trim();
        if (label && userId && !/[\s|{}]/u.test(userId)) {
          flushPlainText();
          result.push(mentionNode(label, userId));
          index = mentionEnd + 1;
          continue;
        }
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
  firstInline.value = firstInline.value.slice(match[0].length).trimStart();
  if (!firstInline.value) firstBlock.children.shift();
  if (firstBlock.children.length === 0) node.children.shift();
  setNodeProperties(node, {
    className: ['canvas-callout', `canvas-callout-${type}`],
    'data-callout': type,
    'data-callout-fold': match[2] || undefined,
    'data-callout-title': title,
  });
}

function markStandaloneEmbed(node: Parent & NodeWithData): void {
  if (node.type !== 'paragraph' || node.children.length !== 1) return;
  const child = node.children[0] as NodeWithData;
  if (child.type !== 'link' || child.data?.hProperties?.['data-canvas-wiki-embed'] !== 'true') return;
  setNodeProperties(child, { 'data-canvas-wiki-transclude': 'true' });
  node.data = {
    ...node.data,
    hName: 'div',
    hProperties: {
      ...node.data?.hProperties,
      className: ['canvas-wiki-embed-container'],
    },
  };
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

function transformChildren(parent: Parent, state: TransformState, source: string): void {
  const transformed: Content[] = [];

  for (const child of parent.children) {
    if (child.type === 'text') {
      const startOffset = child.position?.start.offset;
      const endOffset = child.position?.end.offset;
      const sourceValue = typeof startOffset === 'number' && typeof endOffset === 'number'
        ? source.slice(startOffset, endOffset)
        : child.value;
      transformed.push(...transformText(
        child.value,
        state,
        findEscapedWikiStarts(child.value, sourceValue),
      ));
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
      transformChildren(child, state, source);
      markStandaloneEmbed(child);

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
  return (tree: Root, file: { value?: unknown }) => {
    transformChildren(
      tree,
      { inComment: false, inlineFootnoteIndex: 0 },
      typeof file.value === 'string' ? file.value : '',
    );
  };
}
