'use client';

import { Extension } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion';
import { UserRound } from 'lucide-react';
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';

import {
  filterWorkspaceMentionCandidates,
  loadWorkspaceMentionCandidates,
  type WorkspaceMentionCandidate,
} from '@/app/lib/editor/workspace-mention-candidates-client';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';

type MentionSuggestionLabels = {
  empty: string;
  group: string;
};

type MentionSuggestionHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

type MentionSuggestionListProps = SuggestionProps<
  WorkspaceMentionCandidate,
  WorkspaceMentionCandidate
> & {
  labels: MentionSuggestionLabels;
};

const MARKDOWN_MENTION_SUGGESTION_KEY = new PluginKey('markdownMentionSuggestions');

const MentionSuggestionList = forwardRef<MentionSuggestionHandle, MentionSuggestionListProps>(
  function MentionSuggestionList({ command, items, labels }, ref) {
    const itemKey = useMemo(() => items.map((item) => item.userId).join('\0'), [items]);
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
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          selectItem(activeIndex);
          return true;
        }
        return false;
      },
    }), [activeIndex, itemKey, items.length, selectItem]);

    return (
      <Command
        className="rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        shouldFilter={false}
        data-testid="markdown-mention-menu"
      >
        <CommandList className="max-h-64 overflow-y-auto">
          <CommandEmpty>{labels.empty}</CommandEmpty>
          <CommandGroup heading={labels.group}>
            {items.map((item, index) => (
              <CommandItem
                key={item.userId}
                value={item.userId}
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
                <UserRound className="size-4" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">@{item.label}</span>
                  {item.detail ? (
                    <span className="truncate text-xs text-muted-foreground">{item.detail}</span>
                  ) : null}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    );
  },
);

export function createMarkdownMentionSuggestions({
  labels,
  workspaceId,
}: {
  labels: MentionSuggestionLabels;
  workspaceId: string | null;
}) {
  return Extension.create({
    name: 'markdownMentionSuggestions',

    addProseMirrorPlugins() {
      return [Suggestion<WorkspaceMentionCandidate, WorkspaceMentionCandidate>({
        editor: this.editor,
        pluginKey: MARKDOWN_MENTION_SUGGESTION_KEY,
        char: '@',
        allowSpaces: false,
        decorationClass: 'tiptap-mention-suggestion',
        allow: ({ editor, state, range }) => {
          if (!workspaceId || !editor.isEditable || editor.isActive('codeBlock')) return false;
          const $from = state.doc.resolve(range.from);
          return !$from.marks().some((mark) => mark.type.name === 'link');
        },
        items: async ({ query, signal }) => {
          if (!workspaceId) return [];
          const candidates = await loadWorkspaceMentionCandidates(workspaceId);
          if (signal.aborted) return [];
          return filterWorkspaceMentionCandidates(candidates, query);
        },
        command: ({ editor, range, props }) => {
          editor.chain()
            .focus()
            .insertContentAt(range, [
              {
                type: 'markdownMention',
                attrs: {
                  label: props.label,
                  userId: props.userId,
                },
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: () => {
          let component: ReactRenderer<MentionSuggestionHandle, MentionSuggestionListProps> | null = null;
          let unmount: (() => void) | null = null;

          return {
            onStart: (props) => {
              component = new ReactRenderer(MentionSuggestionList, {
                editor: props.editor,
                props: { ...props, labels },
              });
              component.element.classList.add('tiptap-mention-menu');
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
