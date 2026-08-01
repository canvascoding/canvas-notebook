import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export type MarkdownSearchMatch = {
  from: number;
  to: number;
};

export type MarkdownSearchState = {
  currentIndex: number;
  matches: MarkdownSearchMatch[];
  query: string;
};

type MarkdownSearchMeta = {
  currentIndex?: number;
  query?: string;
};

export const MARKDOWN_SEARCH_PLUGIN_KEY = new PluginKey<MarkdownSearchState>('markdownDocumentSearch');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function searchableTextWithPositions(doc: ProseMirrorNode): {
  positions: Array<number | null>;
  text: string;
} {
  const positions: Array<number | null> = [];
  let text = '';
  let previousTextEnd: number | null = null;

  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;

    if (previousTextEnd !== null && position !== previousTextEnd) {
      text += '\n';
      positions.push(null);
    }

    text += node.text;
    for (let index = 0; index < node.text.length; index += 1) {
      positions.push(position + index);
    }
    previousTextEnd = position + node.nodeSize;
  });

  return { positions, text };
}

export function findMarkdownDocumentMatches(
  doc: ProseMirrorNode,
  query: string,
): MarkdownSearchMatch[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const { positions, text } = searchableTextWithPositions(doc);
  const matches: MarkdownSearchMatch[] = [];
  const matcher = new RegExp(escapeRegExp(normalizedQuery), 'giu');

  for (const match of text.matchAll(matcher)) {
    const startIndex = match.index ?? -1;
    const endIndex = startIndex + match[0].length - 1;
    const from = positions[startIndex];
    const lastPosition = positions[endIndex];
    if (from === null || from === undefined || lastPosition === null || lastPosition === undefined) {
      continue;
    }
    matches.push({ from, to: lastPosition + 1 });
  }

  return matches;
}

function clampCurrentIndex(index: number, matches: MarkdownSearchMatch[]): number {
  if (matches.length === 0) return -1;
  return Math.min(matches.length - 1, Math.max(0, index));
}

function createSearchState(
  doc: ProseMirrorNode,
  query: string,
  currentIndex = 0,
): MarkdownSearchState {
  const matches = findMarkdownDocumentMatches(doc, query);
  return {
    currentIndex: clampCurrentIndex(currentIndex, matches),
    matches,
    query,
  };
}

function searchDecorations(doc: ProseMirrorNode, search: MarkdownSearchState): DecorationSet {
  if (search.matches.length === 0) return DecorationSet.empty;

  return DecorationSet.create(
    doc,
    search.matches.map((match, index) => Decoration.inline(match.from, match.to, {
      class: index === search.currentIndex
        ? 'markdown-search-match markdown-search-match-current'
        : 'markdown-search-match',
      'data-markdown-search-match': index === search.currentIndex ? 'current' : 'match',
    })),
  );
}

export const MarkdownSearchExtension = Extension.create({
  name: 'markdownDocumentSearch',

  addProseMirrorPlugins() {
    return [
      new Plugin<MarkdownSearchState>({
        key: MARKDOWN_SEARCH_PLUGIN_KEY,
        state: {
          init: (_config, state) => createSearchState(state.doc, ''),
          apply: (transaction, previous, _oldState, nextState) => {
            const meta = transaction.getMeta(MARKDOWN_SEARCH_PLUGIN_KEY) as MarkdownSearchMeta | undefined;
            const query = meta?.query ?? previous.query;
            const requestedIndex = meta?.currentIndex ?? previous.currentIndex;
            if (transaction.docChanged || query !== previous.query) {
              return createSearchState(nextState.doc, query, requestedIndex);
            }
            if (requestedIndex !== previous.currentIndex) {
              return {
                ...previous,
                currentIndex: clampCurrentIndex(requestedIndex, previous.matches),
              };
            }
            return previous;
          },
        },
        props: {
          decorations: (state) => {
            const search = MARKDOWN_SEARCH_PLUGIN_KEY.getState(state);
            return search ? searchDecorations(state.doc, search) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function getMarkdownSearchState(editor: Editor): MarkdownSearchState {
  return MARKDOWN_SEARCH_PLUGIN_KEY.getState(editor.state) ?? createSearchState(editor.state.doc, '');
}

export function setMarkdownSearchQuery(editor: Editor, query: string): MarkdownSearchState {
  editor.view.dispatch(editor.state.tr.setMeta(MARKDOWN_SEARCH_PLUGIN_KEY, {
    currentIndex: 0,
    query,
  } satisfies MarkdownSearchMeta));
  return getMarkdownSearchState(editor);
}

export function clearMarkdownSearch(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(MARKDOWN_SEARCH_PLUGIN_KEY, {
    currentIndex: -1,
    query: '',
  } satisfies MarkdownSearchMeta));
}

export function selectMarkdownSearchMatch(editor: Editor, index: number): MarkdownSearchState {
  const search = getMarkdownSearchState(editor);
  if (search.matches.length === 0) return search;

  const nextIndex = (index + search.matches.length) % search.matches.length;
  const match = search.matches[nextIndex];
  const transaction = editor.state.tr
    .setMeta(MARKDOWN_SEARCH_PLUGIN_KEY, { currentIndex: nextIndex } satisfies MarkdownSearchMeta)
    .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
    .scrollIntoView();
  editor.view.dispatch(transaction);
  return getMarkdownSearchState(editor);
}

export function moveMarkdownSearchSelection(editor: Editor, delta: number): MarkdownSearchState {
  const search = getMarkdownSearchState(editor);
  const startIndex = search.currentIndex < 0 ? 0 : search.currentIndex;
  return selectMarkdownSearchMatch(editor, startIndex + delta);
}
