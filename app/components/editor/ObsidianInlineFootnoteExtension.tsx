'use client';

import { mergeAttributes, Node, nodeInputRule } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import React from 'react';

import { ObsidianInlineFootnote } from '@/app/components/shared/ObsidianMarkdownElements';

const INLINE_FOOTNOTE_INPUT_REGEX = /(?:^|\s)(\^\[([^\]\r\n]+)\])$/;

function isEscapedAt(value: string, start: number): boolean {
  let backslashes = 0;
  for (let index = start - 1; index >= 0 && value[index] === '\\'; index -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function findInlineFootnoteStart(source: string): number {
  let index = source.indexOf('^[');
  while (index >= 0) {
    if (!isEscapedAt(source, index)) return index;
    index = source.indexOf('^[', index + 2);
  }
  return -1;
}

function InlineFootnoteNodeView({ node, selected }: NodeViewProps) {
  const content = typeof node.attrs.content === 'string' ? node.attrs.content : '';
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className={selected ? 'rounded-sm outline outline-2 outline-primary/50' : undefined}
    >
      <ObsidianInlineFootnote content={content} index="*" />
    </NodeViewWrapper>
  );
}

export const ObsidianInlineFootnoteExtension = Node.create({
  name: 'obsidianInlineFootnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { content: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'sup[data-type="obsidian-inline-footnote"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { 'data-type': 'obsidian-inline-footnote' }), '*'];
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineFootnoteNodeView);
  },

  parseMarkdown: (token) => ({
    type: 'obsidianInlineFootnote',
    attrs: { content: typeof token.content === 'string' ? token.content : '' },
  }),

  renderMarkdown: (node) => {
    const content = typeof node.attrs?.content === 'string' ? node.attrs.content : '';
    return `^[${content.replace(/\\/gu, '\\\\').replace(/\]/gu, '\\]')}]`;
  },

  markdownTokenizer: {
    name: 'obsidianInlineFootnote',
    level: 'inline',
    start: findInlineFootnoteStart,
    tokenize: (source) => {
      const match = source.match(/^\^\[((?:\\\]|[^\]\r\n])+)\]/);
      if (!match) return undefined;
      return {
        type: 'obsidianInlineFootnote',
        raw: match[0],
        content: match[1].replace(/\\\]/gu, ']'),
      };
    },
  },

  addInputRules() {
    return [nodeInputRule({
      find: INLINE_FOOTNOTE_INPUT_REGEX,
      type: this.type,
      getAttributes: (match) => ({ content: match[2] }),
    })];
  },
});
