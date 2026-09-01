import {
  Mark,
  Node,
  markInputRule,
  mergeAttributes,
  nodeInputRule,
  nodePasteRule,
  type AnyExtension,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
  type Range,
} from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import { TextSelection } from '@tiptap/pm/state';

import { ObsidianWikiLink } from './tiptap-obsidian-wiki-link';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    canvasRichMarkdown: {
      insertCanvasCallout: (options?: {
        title?: string;
        type?: string;
        content?: string;
        range?: Range;
      }) => ReturnType;
      insertCanvasDetails: (options?: {
        summary?: string;
        content?: string;
        open?: boolean;
        range?: Range;
      }) => ReturnType;
      insertMarkdownFootnote: (options?: { content?: string; range?: Range }) => ReturnType;
      insertMarkdownMention: (options: { label: string; userId: string }) => ReturnType;
      toggleCanvasHighlight: () => ReturnType;
    };
  }
}

type CalloutToken = MarkdownToken & {
  calloutFold?: string | null;
  calloutTitle?: string;
  calloutTitleTokens?: MarkdownToken[];
  calloutType?: string;
};

type DetailsToken = MarkdownToken & {
  detailsOpen?: boolean;
  detailsSummary?: string;
  detailsSummaryTokens?: MarkdownToken[];
};

type FootnoteToken = MarkdownToken & {
  footnoteId?: string;
};

type MentionToken = MarkdownToken & {
  mentionLabel?: string;
  mentionUserId?: string;
};

function safeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function blockContent(
  token: MarkdownToken,
  helpers: MarkdownParseHelpers,
): JSONContent[] {
  const parsed = helpers.parseChildren(token.tokens ?? []);
  return parsed.length > 0 ? parsed : [helpers.createNode('paragraph')];
}

function quoteMarkdown(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line ? `> ${line}` : '>')
    .join('\n');
}

const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;';
const THEMATIC_BREAK_PARAGRAPH_PATTERN = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;

// Rich Markdown tokenizers need to run before generic block tokenizers, which
// gives their nodes a high schema priority. Keep paragraph above those block
// nodes so ProseMirror fills empty containers (especially table cells) with an
// editable paragraph instead of an empty callout.
export const CanvasParagraph = Paragraph.extend({
  priority: 1200,

  renderMarkdown(node, helpers, context) {
    if (!node) return '';

    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 0) {
      const previousContent = Array.isArray(context?.previousNode?.content)
        ? context.previousNode.content
        : [];
      const previousNodeIsEmptyParagraph = context?.previousNode?.type === 'paragraph'
        && previousContent.length === 0;
      return previousNodeIsEmptyParagraph ? EMPTY_PARAGRAPH_MARKDOWN : '';
    }

    const rendered = helpers.renderChildren(content);
    return THEMATIC_BREAK_PARAGRAPH_PATTERN.test(rendered)
      ? `\\${rendered}`
      : rendered;
  },
});

export const CanvasHighlight = Mark.create({
  name: 'canvasHighlight',
  priority: 1100,

  parseHTML() {
    return [{ tag: 'mark' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes, { 'data-type': 'canvas-highlight' }), 0];
  },

  parseMarkdown(token, helpers) {
    return helpers.applyMark('canvasHighlight', helpers.parseInline(token.tokens ?? []));
  },

  renderMarkdown(node, helpers) {
    return `==${helpers.renderChildren(node)}==`;
  },

  markdownTokenizer: {
    name: 'canvasHighlight',
    level: 'inline',
    start: (source) => source.indexOf('=='),
    tokenize: (source, _tokens, lexer) => {
      const match = source.match(/^==([^=\r\n]+)==/u);
      if (!match) return undefined;
      return {
        type: 'canvasHighlight',
        raw: match[0],
        text: match[1],
        tokens: lexer.inlineTokens(match[1]),
      };
    },
  },

  addCommands() {
    return {
      toggleCanvasHighlight: () => ({ commands }) => commands.toggleMark(this.name),
    };
  },

  addInputRules() {
    return [markInputRule({ find: /(?:^|\s)(==([^=\r\n]+)==)$/u, type: this.type })];
  },
});

const MENTION_INPUT_REGEX = /(?:^|\s)(@\{([^|{}\r\n]+)\|([^|{}\s\r\n]+)\})$/u;
const MENTION_PASTE_REGEX = /@\{([^|{}\r\n]+)\|([^|{}\s\r\n]+)\}/gu;

export const MarkdownMention = Node.create({
  name: 'markdownMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  priority: 1150,

  addAttributes() {
    return {
      label: { default: 'Member' },
      userId: { default: '' },
    };
  },

  parseHTML() {
    return [{
      tag: 'span[data-type="markdown-mention"]',
      getAttrs: (element) => element instanceof HTMLElement ? {
        label: element.dataset.mentionLabel || 'Member',
        userId: element.dataset.mentionUserId || '',
      } : false,
    }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const label = safeText(node.attrs.label, 'Member');
    const userId = safeText(node.attrs.userId);
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-type': 'markdown-mention',
      'data-mention-label': label,
      'data-mention-user-id': userId,
      class: 'canvas-markdown-mention',
      contenteditable: 'false',
    }), `@${label}`];
  },

  parseMarkdown(token: MentionToken, helpers) {
    return helpers.createNode('markdownMention', {
      label: safeText(token.mentionLabel, 'Member'),
      userId: safeText(token.mentionUserId),
    });
  },

  renderMarkdown(node) {
    const label = safeText(node.attrs?.label, 'Member').replace(/[|{}\r\n]/gu, ' ').trim();
    const userId = safeText(node.attrs?.userId).replace(/[|{}\s\r\n]/gu, '').trim();
    return `@{${label || 'Member'}|${userId}}`;
  },

  markdownTokenizer: {
    name: 'markdownMention',
    level: 'inline',
    start: (source) => source.indexOf('@{'),
    tokenize: (source) => {
      const match = source.match(/^@\{([^|{}\r\n]+)\|([^|{}\s\r\n]+)\}/u);
      if (!match) return undefined;
      return {
        type: 'markdownMention',
        raw: match[0],
        mentionLabel: match[1].trim(),
        mentionUserId: match[2],
      } satisfies MentionToken;
    },
  },

  addCommands() {
    return {
      insertMarkdownMention: (options) => ({ commands }) => commands.insertContent({
        type: this.name,
        attrs: {
          label: options.label,
          userId: options.userId,
        },
      }),
    };
  },

  addInputRules() {
    return [nodeInputRule({
      find: MENTION_INPUT_REGEX,
      type: this.type,
      getAttributes: (match) => ({ label: match[2].trim(), userId: match[3] }),
    })];
  },

  addPasteRules() {
    return [nodePasteRule({
      find: MENTION_PASTE_REGEX,
      type: this.type,
      getAttributes: (match) => ({ label: match[1].trim(), userId: match[2] }),
    })];
  },
});

export const CanvasCalloutTitle = Node.create({
  name: 'canvasCalloutTitle',
  content: 'inline*',
  defining: true,
  selectable: false,

  parseHTML() {
    return [{ tag: '[data-type="canvas-callout-title"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-type': 'canvas-callout-title',
      role: 'heading',
      'aria-level': '3',
    }), 0];
  },
});

export const CanvasCallout = Node.create({
  name: 'canvasCallout',
  group: 'block',
  // A collaborative Yjs restore can temporarily expose only part of the
  // wrapper. Keep intermediate states schema-valid so plugins such as UniqueID
  // can safely update the node while its children are synchronizing.
  content: 'canvasCalloutTitle? block*',
  defining: true,
  isolating: true,
  priority: 1100,

  addAttributes() {
    return {
      calloutType: { default: 'note' },
      fold: { default: null },
    };
  },

  parseHTML() {
    return [{
      tag: '[data-type="canvas-callout"]',
      getAttrs: (element) => element instanceof HTMLElement ? {
        calloutType: element.dataset.calloutType || 'note',
        fold: element.dataset.calloutFold || null,
      } : false,
    }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const calloutType = safeText(node.attrs.calloutType, 'note').toLowerCase();
    const fold = node.attrs.fold === '+' || node.attrs.fold === '-' ? node.attrs.fold : null;
    return [
      'aside',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'canvas-callout',
        'data-callout-type': calloutType,
        'data-callout-fold': fold,
        class: `canvas-rich-callout canvas-rich-callout-${calloutType}`,
      }),
      0,
    ];
  },

  parseMarkdown(token: CalloutToken, helpers) {
    const title = safeText(token.calloutTitle, 'Note');
    const titleContent = helpers.parseInline(
      token.calloutTitleTokens
      ?? helpers.tokenizeInline?.(title)
      ?? [{ type: 'text', raw: title, text: title }],
    );
    return helpers.createNode('canvasCallout', {
      calloutType: safeText(token.calloutType, 'note').toLowerCase(),
      fold: token.calloutFold === '+' || token.calloutFold === '-' ? token.calloutFold : null,
    }, [
      helpers.createNode('canvasCalloutTitle', {}, titleContent),
      ...blockContent(token, helpers),
    ]);
  },

  renderMarkdown(node, helpers) {
    const titleNode = node.content?.find((child) => child.type === 'canvasCalloutTitle');
    const bodyNodes = node.content?.filter((child) => child.type !== 'canvasCalloutTitle') ?? [];
    const title = titleNode ? helpers.renderChildren(titleNode.content ?? []) : 'Note';
    const type = safeText(node.attrs?.calloutType, 'note').toLowerCase();
    const fold = node.attrs?.fold === '+' || node.attrs?.fold === '-' ? node.attrs.fold : '';
    const header = `> [!${type}]${fold}${title ? ` ${title}` : ''}`;
    const body = helpers.renderChildren(bodyNodes, '\n\n');
    return body ? `${header}\n${quoteMarkdown(body)}` : header;
  },

  markdownTokenizer: {
    name: 'canvasCallout',
    level: 'block',
    start: (source) => source.search(/^ {0,3}>[ \t]*\[!/mu),
    tokenize: (source, _tokens, lexer) => {
      const match = source.match(/^(?: {0,3}>[^\r\n]*(?:\r?\n|$))+/u);
      if (!match) return undefined;
      const raw = match[0];
      const lines = raw.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
      const unquoted = lines.map((line) => line.replace(/^ {0,3}>[ \t]?/u, ''));
      const header = unquoted[0]?.match(/^\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+(.*))?$/u);
      if (!header) return undefined;

      const type = header[1].toLowerCase();
      const title = header[3]?.trim() || type[0].toUpperCase() + type.slice(1);
      const body = unquoted.slice(1).join('\n').trim();
      return {
        type: 'canvasCallout',
        raw,
        calloutType: type,
        calloutFold: header[2] || null,
        calloutTitle: title,
        calloutTitleTokens: lexer.inlineTokens(title),
        tokens: body ? lexer.blockTokens(body) : [],
      } satisfies CalloutToken;
    },
  },

  addCommands() {
    return {
      insertCanvasCallout: (options = {}) => ({ commands, state }) => commands.insertContentAt(
        options.range ?? { from: state.selection.from, to: state.selection.to },
        {
          type: this.name,
          attrs: { calloutType: options.type || 'note', fold: null },
          content: [
            {
              type: 'canvasCalloutTitle',
              content: options.title ? [{ type: 'text', text: options.title }] : [],
            },
            {
              type: 'paragraph',
              content: options.content ? [{ type: 'text', text: options.content }] : [],
            },
          ],
        },
      ),
    };
  },
});

export const CanvasDetailsSummary = Node.create({
  name: 'canvasDetailsSummary',
  content: 'inline*',
  defining: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'summary[data-type="canvas-details-summary"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['summary', mergeAttributes(HTMLAttributes, {
      'data-type': 'canvas-details-summary',
    }), 0];
  },
});

export const CanvasDetailsContent = Node.create({
  name: 'canvasDetailsContent',
  content: 'block*',
  defining: true,
  selectable: false,

  parseHTML() {
    return [{ tag: '[data-type="canvas-details-content"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-type': 'canvas-details-content',
    }), 0];
  },
});

export const CanvasDetails = Node.create({
  name: 'canvasDetails',
  group: 'block',
  content: 'canvasDetailsSummary? canvasDetailsContent?',
  defining: true,
  isolating: true,
  priority: 1100,

  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (element) => element instanceof HTMLElement && element.hasAttribute('open'),
        renderHTML: (attributes) => attributes.open ? { open: 'open' } : {},
      },
    };
  },

  parseHTML() {
    return [{
      tag: 'details[data-type="canvas-details"]',
      getAttrs: (element) => element instanceof HTMLElement ? { open: element.hasAttribute('open') } : false,
    }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['details', mergeAttributes(HTMLAttributes, {
      'data-type': 'canvas-details',
      ...(node.attrs.open ? { open: 'open' } : {}),
    }), 0];
  },

  parseMarkdown(token: DetailsToken, helpers) {
    const summary = safeText(token.detailsSummary, 'Details');
    const summaryContent = helpers.parseInline(
      token.detailsSummaryTokens
      ?? helpers.tokenizeInline?.(summary)
      ?? [{ type: 'text', raw: summary, text: summary }],
    );
    return helpers.createNode('canvasDetails', { open: Boolean(token.detailsOpen) }, [
      helpers.createNode('canvasDetailsSummary', {}, summaryContent),
      helpers.createNode('canvasDetailsContent', {}, blockContent(token, helpers)),
    ]);
  },

  renderMarkdown(node, helpers) {
    const summaryNode = node.content?.find((child) => child.type === 'canvasDetailsSummary');
    const contentNode = node.content?.find((child) => child.type === 'canvasDetailsContent');
    const summary = summaryNode ? helpers.renderChildren(summaryNode.content ?? []) : 'Details';
    const body = contentNode ? helpers.renderChildren(contentNode.content ?? [], '\n\n') : '';
    const open = node.attrs?.open ? ' open' : '';
    return `<details${open}>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
  },

  markdownTokenizer: {
    name: 'canvasDetails',
    level: 'block',
    start: (source) => source.search(/^<details(?:\s+open(?:=(?:"open"|'open'|open))?)?>[ \t]*$/mu),
    tokenize: (source, _tokens, lexer) => {
      const match = source.match(
        /^<details(?:\s+(open)(?:=(?:"open"|'open'|open))?)?>[ \t]*\r?\n<summary>([^\r\n]*)<\/summary>[ \t]*\r?\n([\s\S]*?)\r?\n<\/details>(?:\r?\n|$)/u,
      );
      if (!match) return undefined;
      const summary = match[2].trim() || 'Details';
      const body = match[3].trim();
      return {
        type: 'canvasDetails',
        raw: match[0],
        detailsOpen: Boolean(match[1]),
        detailsSummary: summary,
        detailsSummaryTokens: lexer.inlineTokens(summary),
        tokens: body ? lexer.blockTokens(body) : [],
      } satisfies DetailsToken;
    },
  },

  addCommands() {
    return {
      insertCanvasDetails: (options = {}) => ({ commands, state }) => commands.insertContentAt(
        options.range ?? { from: state.selection.from, to: state.selection.to },
        {
          type: this.name,
          attrs: { open: Boolean(options.open) },
          content: [
            {
              type: 'canvasDetailsSummary',
              content: options.summary ? [{ type: 'text', text: options.summary }] : [],
            },
            {
              type: 'canvasDetailsContent',
              content: [{
                type: 'paragraph',
                content: options.content ? [{ type: 'text', text: options.content }] : [],
              }],
            },
          ],
        },
      ),
    };
  },
});

export const MarkdownFootnoteReference = Node.create({
  name: 'markdownFootnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  priority: 1100,

  addAttributes() {
    return { footnoteId: { default: '1' } };
  },

  parseHTML() {
    return [{
      tag: 'sup[data-type="markdown-footnote-reference"]',
      getAttrs: (element) => element instanceof HTMLElement
        ? { footnoteId: element.dataset.footnoteId || '1' }
        : false,
    }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const id = safeText(node.attrs.footnoteId, '1');
    return ['sup', mergeAttributes(HTMLAttributes, {
      'data-type': 'markdown-footnote-reference',
      'data-footnote-id': id,
      contenteditable: 'false',
      role: 'button',
      tabindex: '0',
      'aria-label': `Footnote ${id}`,
    }), `[${id}]`];
  },

  parseMarkdown(token: FootnoteToken, helpers) {
    return helpers.createNode('markdownFootnoteReference', {
      footnoteId: safeText(token.footnoteId, '1'),
    });
  },

  renderMarkdown(node) {
    return `[^${safeText(node.attrs?.footnoteId, '1')}]`;
  },

  markdownTokenizer: {
    name: 'markdownFootnoteReference',
    level: 'inline',
    start: (source) => source.indexOf('[^'),
    tokenize: (source) => {
      const match = source.match(/^\[\^([^\]\s\r\n]+)\]/u);
      if (!match) return undefined;
      return {
        type: 'markdownFootnoteReference',
        raw: match[0],
        footnoteId: match[1],
      } satisfies FootnoteToken;
    },
  },
});

export const MarkdownFootnoteDefinition = Node.create({
  name: 'markdownFootnoteDefinition',
  group: 'block',
  content: 'block*',
  defining: true,
  isolating: true,
  priority: 1100,

  addAttributes() {
    return { footnoteId: { default: '1' } };
  },

  parseHTML() {
    return [{
      tag: '[data-type="markdown-footnote-definition"]',
      getAttrs: (element) => element instanceof HTMLElement
        ? { footnoteId: element.dataset.footnoteId || '1' }
        : false,
    }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const id = safeText(node.attrs.footnoteId, '1');
    return ['aside', mergeAttributes(HTMLAttributes, {
      'data-type': 'markdown-footnote-definition',
      'data-footnote-id': id,
    }), 0];
  },

  parseMarkdown(token: FootnoteToken, helpers) {
    return helpers.createNode('markdownFootnoteDefinition', {
      footnoteId: safeText(token.footnoteId, '1'),
    }, blockContent(token, helpers));
  },

  renderMarkdown(node, helpers) {
    const id = safeText(node.attrs?.footnoteId, '1');
    const body = helpers.renderChildren(node.content ?? [], '\n\n');
    const lines = body.split('\n');
    const first = lines.shift() ?? '';
    const remainder = lines.map((line) => `    ${line}`).join('\n');
    return `[^${id}]: ${first}${remainder ? `\n${remainder}` : ''}`;
  },

  markdownTokenizer: {
    name: 'markdownFootnoteDefinition',
    level: 'block',
    start: (source) => source.search(/^\[\^[^\]\r\n]+\]:/mu),
    tokenize: (source, _tokens, lexer) => {
      const match = source.match(
        /^\[\^([^\]\s\r\n]+)\]:[ \t]*([^\r\n]*)(?:\r?\n((?:(?: {2,}|\t)[^\r\n]*(?:\r?\n|$))*))?/u,
      );
      if (!match) return undefined;
      const continuation = (match[3] || '')
        .replace(/^(?: {2,}|\t)/gmu, '')
        .replace(/\r?\n$/u, '');
      const body = [match[2], continuation].filter(Boolean).join('\n').trim();
      return {
        type: 'markdownFootnoteDefinition',
        raw: match[0],
        footnoteId: match[1],
        tokens: lexer.blockTokens(body || 'Footnote'),
      } satisfies FootnoteToken;
    },
  },

  addCommands() {
    return {
      insertMarkdownFootnote: (options = {}) => ({ state, dispatch }) => {
        const usedIds = new Set<string>();
        state.doc.descendants((node) => {
          if (
            node.type.name === 'markdownFootnoteReference'
            || node.type.name === 'markdownFootnoteDefinition'
          ) {
            usedIds.add(safeText(node.attrs.footnoteId));
          }
          return true;
        });
        let sequence = 1;
        while (usedIds.has(String(sequence))) sequence += 1;
        const footnoteId = String(sequence);
        if (!dispatch) return true;

        const range = options.range ?? {
          from: state.selection.from,
          to: state.selection.to,
        };
        const from = Math.min(Math.max(range.from, 0), state.doc.content.size);
        const to = Math.min(Math.max(range.to, from), state.doc.content.size);
        const reference = state.schema.nodes.markdownFootnoteReference.create({ footnoteId });
        const paragraph = state.schema.nodes.paragraph.create(
          null,
          options.content ? state.schema.text(options.content) : undefined,
        );
        const definition = this.type.create({ footnoteId }, paragraph);
        const transaction = state.tr.replaceWith(from, to, reference);
        const referenceEnd = transaction.mapping.map(from, 1) + reference.nodeSize;
        transaction.insert(transaction.doc.content.size, definition);
        transaction.setSelection(TextSelection.create(transaction.doc, referenceEnd));
        dispatch(transaction.scrollIntoView());
        return true;
      },
    };
  },
});

export function canvasRichMarkdownExtensions(options?: { obsidianWikiLink?: AnyExtension }) {
  return [
    CanvasParagraph,
    CanvasHighlight,
    options?.obsidianWikiLink ?? ObsidianWikiLink,
    CanvasCalloutTitle,
    CanvasCallout,
    CanvasDetailsSummary,
    CanvasDetailsContent,
    CanvasDetails,
    MarkdownFootnoteReference,
    MarkdownFootnoteDefinition,
    MarkdownMention,
  ];
}
