'use client';

import { Extension } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  ReactRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import {
  Suggestion,
  type SuggestionMatch,
  type SuggestionProps,
  type Trigger,
} from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { FileText, Hash, Heading } from 'lucide-react';
import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from 'react';

import { ObsidianWikiLink } from '@/app/components/shared/ObsidianWikiLink';
import {
  getObsidianWikiDisplayLabel,
  parseObsidianWikiTarget,
} from '@/app/lib/markdown/obsidian-flavored-markdown';
import { ObsidianWikiLink as ObsidianWikiLinkNode } from '@/app/lib/markdown/tiptap-obsidian-wiki-link';
import { findObsidianWikiCompletionContext } from '@/app/lib/markdown/obsidian-link-resolver';
import {
  getWorkspaceWikiCompletionItems,
  loadWorkspaceLinkIndex,
  type WorkspaceWikiCompletionItem,
} from '@/app/lib/markdown/workspace-link-index-client';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

type WikiSuggestionLabels = {
  empty: string;
  group: string;
};

type WikiSuggestionHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

type WikiSuggestionListProps = SuggestionProps<WorkspaceWikiCompletionItem, WorkspaceWikiCompletionItem> & {
  labels: WikiSuggestionLabels;
};

type CreateObsidianWikiLinkExtensionsOptions = {
  filePath?: string;
  labels: WikiSuggestionLabels;
  workspaceId: string | null;
};

const WIKI_SUGGESTION_PLUGIN_KEY = new PluginKey('markdownWikiLinkSuggestions');
function isEscapedAt(value: string, start: number): boolean {
  let backslashes = 0;
  for (let index = start - 1; index >= 0 && value[index] === '\\'; index -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function wikiLinkLabel(target: string): string {
  const parsed = parseObsidianWikiTarget(target);
  return parsed ? getObsidianWikiDisplayLabel(parsed) : target;
}

function ObsidianWikiLinkNodeView({
  editor,
  getPos,
  node,
  selected,
  filePath,
}: NodeViewProps & { filePath?: string }) {
  const target = typeof node.attrs.target === 'string' ? node.attrs.target : '';
  const embed = node.attrs.embed === true;

  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className={cn('tiptap-wiki-link-node', selected && 'tiptap-wiki-link-node-selected')}
      onPointerDownCapture={() => {
        const position = getPos();
        if (typeof position === 'number' && editor.isEditable) {
          editor.chain().focus().setNodeSelection(position).run();
        }
      }}
    >
      <ObsidianWikiLink target={target} sourcePath={filePath} embed={embed} preferDocumentTitle>
        {wikiLinkLabel(target)}
      </ObsidianWikiLink>
    </NodeViewWrapper>
  );
}

export function createObsidianWikiLinkNode(filePath?: string) {
  return ObsidianWikiLinkNode.extend({
    addNodeView() {
      return ReactNodeViewRenderer((props) => (
        <ObsidianWikiLinkNodeView {...props} filePath={filePath} />
      ));
    },
  });
}

function findRichWikiSuggestionMatch({ $position }: Trigger): SuggestionMatch {
  const text = $position.nodeBefore?.isText ? $position.nodeBefore.text ?? '' : '';
  if (!text) return null;
  const openingIndex = text.lastIndexOf('[[');
  if (openingIndex < 0 || isEscapedAt(text, openingIndex)) return null;

  const query = text.slice(openingIndex + 2);
  if (query.includes(']]') || query.includes('|') || query.includes('\n')) return null;
  const from = $position.pos - (text.length - openingIndex);
  if (from >= $position.pos) return null;

  return {
    range: { from, to: $position.pos },
    query,
    text: text.slice(openingIndex),
  };
}

const WikiSuggestionList = forwardRef<WikiSuggestionHandle, WikiSuggestionListProps>(
  function WikiSuggestionList({ command, items, labels }, ref) {
    const itemKey = useMemo(() => items.map((item) => `${item.kind}:${item.target}`).join('\0'), [items]);
    const [selection, setSelection] = useState({ index: 0, itemKey });
    const activeIndex = selection.itemKey === itemKey
      ? Math.min(selection.index, Math.max(0, items.length - 1))
      : 0;

    const selectItem = useCallback((index: number) => {
      const item = items[index];
      if (item) command(item);
    }, [command, items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event) => {
        if (!items.length) return false;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const direction = event.key === 'ArrowUp' ? -1 : 1;
          setSelection({
            index: (activeIndex + direction + items.length) % items.length,
            itemKey,
          });
          return true;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          selectItem(activeIndex);
          return true;
        }
        return false;
      },
    }), [activeIndex, itemKey, items.length, selectItem]);

    return (
      <Command className="rounded-md border border-border bg-popover text-popover-foreground shadow-lg" shouldFilter={false}>
        <CommandList className="max-h-72 overflow-y-auto">
          <CommandEmpty>{labels.empty}</CommandEmpty>
          <CommandGroup heading={labels.group}>
            {items.map((item, index) => {
              const Icon = item.kind === 'document' ? FileText : item.kind === 'heading' ? Heading : Hash;
              return (
                <CommandItem
                  key={`${item.kind}:${item.target}`}
                  value={item.target}
                  aria-selected={index === activeIndex}
                  data-selected={index === activeIndex ? 'true' : undefined}
                  ref={(element) => {
                    if (index === activeIndex) element?.scrollIntoView({ block: 'nearest' });
                  }}
                  onMouseEnter={() => setSelection({ index, itemKey })}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectItem(index);
                  }}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{item.displayLabel}</span>
                    <span className="truncate text-xs text-muted-foreground">{item.detail}</span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    );
  },
);

function createObsidianWikiSuggestions({
  filePath,
  labels,
  workspaceId,
}: CreateObsidianWikiLinkExtensionsOptions) {
  return Extension.create({
    name: 'obsidianWikiLinkSuggestions',

    addProseMirrorPlugins() {
      return [Suggestion<WorkspaceWikiCompletionItem, WorkspaceWikiCompletionItem>({
        editor: this.editor,
        pluginKey: WIKI_SUGGESTION_PLUGIN_KEY,
        char: '[[',
        allowedPrefixes: null,
        allowSpaces: true,
        decorationClass: 'tiptap-wiki-link-suggestion',
        findSuggestionMatch: findRichWikiSuggestionMatch,
        allow: ({ editor, state, range }) => {
          if (!workspaceId || !editor.isEditable || editor.isActive('codeBlock')) return false;
          const $from = state.doc.resolve(range.from);
          return !$from.marks().some((mark) => mark.type.name === 'link');
        },
        items: async ({ query, signal }) => {
          if (!workspaceId) return [];
          const completionContext = findObsidianWikiCompletionContext(`[[${query}`, query.length + 2);
          if (!completionContext) return [];
          const index = await loadWorkspaceLinkIndex(workspaceId);
          if (signal.aborted) return [];
          return getWorkspaceWikiCompletionItems(index, completionContext, filePath, 100);
        },
        command: ({ editor, range, props }) => {
          let from = range.from;
          const hasEmbedPrefix = from > 0 && editor.state.doc.textBetween(from - 1, from) === '!';
          if (hasEmbedPrefix) from -= 1;
          editor.chain()
            .focus()
            .insertContentAt({ from, to: range.to }, {
              type: 'obsidianWikiLink',
              attrs: { embed: hasEmbedPrefix, target: props.target },
            })
            .setTextSelection(from + 1)
            .run();
        },
        render: () => {
          let component: ReactRenderer<WikiSuggestionHandle, WikiSuggestionListProps> | null = null;
          let unmount: (() => void) | null = null;

          return {
            onStart: (props) => {
              component = new ReactRenderer(WikiSuggestionList, {
                editor: props.editor,
                props: { ...props, labels },
              });
              component.element.classList.add('tiptap-wiki-link-menu');
              unmount = props.mount(component.element);
            },
            onUpdate: (props) => component?.updateProps({ ...props, labels }),
            onKeyDown: ({ event }) => component?.ref?.onKeyDown(event) ?? false,
            onExit: () => {
              unmount?.();
              component?.destroy();
              component = null;
              unmount = null;
            },
          };
        },
      })];
    },
  });
}

export function createObsidianWikiLinkExtensions(
  options: CreateObsidianWikiLinkExtensionsOptions,
) {
  return [
    createObsidianWikiSuggestions(options),
  ];
}
