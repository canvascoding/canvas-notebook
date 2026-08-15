import {
  mergeAttributes,
  Node,
  nodeInputRule,
  nodePasteRule,
  type MarkdownToken,
} from '@tiptap/core';

import {
  getObsidianWikiDisplayLabel,
  parseObsidianWikiTarget,
} from './obsidian-flavored-markdown';

type ObsidianWikiLinkToken = MarkdownToken & {
  embed?: boolean;
  target?: string;
};

const WIKI_INPUT_REGEX = /(?:^|\s)((!)?\[\[([^\]\r\n]+)\]\])$/;
const WIKI_PASTE_REGEX = /(!)?\[\[([^\]\r\n]+)\]\]/g;

function isEscapedAt(value: string, start: number): boolean {
  let backslashes = 0;
  for (let index = start - 1; index >= 0 && value[index] === '\\'; index -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

export function findUnescapedRichWikiLinkStart(source: string): number {
  const pattern = /!?\[\[/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (!isEscapedAt(source, start)) return start;
  }
  return -1;
}

function displayLabel(rawTarget: string): string {
  const target = parseObsidianWikiTarget(rawTarget);
  return target ? getObsidianWikiDisplayLabel(target) : rawTarget;
}

/**
 * The transport-safe core for a Canvas `[[wiki link]]`. Browser-only node
 * views and suggestions extend this node, while the collaboration renderer
 * uses it directly. Keep its name and attributes stable across clients.
 */
export const ObsidianWikiLink = Node.create({
  name: 'obsidianWikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      embed: { default: false },
      target: { default: '' },
    };
  },

  parseHTML() {
    return [{
      tag: 'span[data-type="obsidian-wiki-link"]',
      getAttrs: (element) => element instanceof HTMLElement ? {
        embed: element.dataset.wikiEmbed === 'true',
        target: element.dataset.target || '',
      } : false,
    }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const target = typeof node.attrs.target === 'string' ? node.attrs.target : '';
    const embed = node.attrs.embed === true;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'obsidian-wiki-link',
        'data-target': target,
        'data-wiki-embed': embed ? 'true' : undefined,
        class: 'canvas-obsidian-wiki-link',
        contenteditable: 'false',
      }),
      `${embed ? 'Embed: ' : ''}${displayLabel(target)}`,
    ];
  },

  parseMarkdown(token: ObsidianWikiLinkToken, helpers) {
    return helpers.createNode('obsidianWikiLink', {
      embed: token.embed === true,
      target: typeof token.target === 'string' ? token.target : '',
    });
  },

  renderMarkdown(node) {
    const target = typeof node.attrs?.target === 'string' ? node.attrs.target : '';
    return `${node.attrs?.embed === true ? '!' : ''}[[${target}]]`;
  },

  markdownTokenizer: {
    name: 'obsidianWikiLink',
    level: 'inline',
    start: findUnescapedRichWikiLinkStart,
    tokenize: (source) => {
      const match = source.match(/^(!)?\[\[([^\]\r\n]+)\]\]/);
      if (!match) return undefined;
      return {
        type: 'obsidianWikiLink',
        raw: match[0],
        embed: Boolean(match[1]),
        target: match[2].trim(),
      } satisfies ObsidianWikiLinkToken;
    },
  },

  addInputRules() {
    return [nodeInputRule({
      find: WIKI_INPUT_REGEX,
      type: this.type,
      getAttributes: (match) => ({
        embed: Boolean(match[2]),
        target: match[3].trim(),
      }),
    })];
  },

  addPasteRules() {
    return [nodePasteRule({
      find: WIKI_PASTE_REGEX,
      type: this.type,
      getAttributes: (match) => ({
        embed: Boolean(match[1]),
        target: match[2].trim(),
      }),
    })];
  },
});
