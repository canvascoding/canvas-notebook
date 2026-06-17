'use client';

import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Extension, type Editor, type Range } from '@tiptap/core';
import {
  EditorContent,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  ReactRenderer,
  useEditor,
  useEditorState,
  type NodeViewProps,
} from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Link } from '@tiptap/extension-link';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Code2,
  Columns3,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  Redo2,
  Rows3,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
import { createInlineColorRegex, isColorCode } from '@/app/lib/markdown/color-code';
import { resolveMarkdownImageUrl } from '@/app/lib/markdown/markdown-image-url';
import { cn } from '@/lib/utils';

import { CodeEditor } from './CodeEditor';

interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  filePath?: string;
}

type EditorMode = 'rich' | 'source';

type MarkdownEditorWithMarkdown = Editor & {
  getMarkdown: () => string;
};

type ToolbarState = {
  canUndo: boolean;
  canRedo: boolean;
  isBold: boolean;
  isItalic: boolean;
  isStrike: boolean;
  isCode: boolean;
  isHeading1: boolean;
  isHeading2: boolean;
  isHeading3: boolean;
  isBulletList: boolean;
  isOrderedList: boolean;
  isTaskList: boolean;
  isBlockquote: boolean;
  isLink: boolean;
  isCodeBlock: boolean;
  isTable: boolean;
  cellAlign: 'left' | 'center' | 'right' | null;
};

type SlashCommandActions = {
  openTableDialog?: (editor: Editor, range: Range) => void;
};

type SlashCommandContext = {
  editor: Editor;
  labels: SlashCommandLabels;
  range: Range;
  actions?: SlashCommandActions;
};

type SlashCommandItemId =
  | 'text'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'taskList'
  | 'quote'
  | 'codeBlock'
  | 'table'
  | 'image'
  | 'divider'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode';

type SlashCommandItemLabel = {
  title: string;
  description: string;
};

type SlashCommandLabels = {
  addBlock: string;
  empty: string;
  group: string;
  imageAltPrompt: string;
  imageSrcPrompt: string;
  items: Record<SlashCommandItemId, SlashCommandItemLabel>;
  placeholder: string;
};

type SlashCommandDefinition = {
  id: SlashCommandItemId;
  keywords: string[];
  Icon: React.ComponentType;
  command: (context: SlashCommandContext) => void;
};

type SlashCommandItem = SlashCommandDefinition & SlashCommandItemLabel;

type SlashCommandListHandle = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type SlashCommandListProps = SuggestionProps<SlashCommandItem, SlashCommandItem> & {
  labels: Pick<SlashCommandLabels, 'empty' | 'group'>;
};

const EMPTY_TOOLBAR_STATE: ToolbarState = {
  canUndo: false,
  canRedo: false,
  isBold: false,
  isItalic: false,
  isStrike: false,
  isCode: false,
  isHeading1: false,
  isHeading2: false,
  isHeading3: false,
  isBulletList: false,
  isOrderedList: false,
  isTaskList: false,
  isBlockquote: false,
  isLink: false,
  isCodeBlock: false,
  isTable: false,
  cellAlign: null,
};

const FRONTMATTER_REGEX = /^---\s*\n[\s\S]*?\n---(?:\s*\n|$)/;
const SLASH_COMMAND_PLUGIN_KEY = new PluginKey('markdownSlashCommands');
const COLOR_SWATCH_PLUGIN_KEY = new PluginKey('markdownColorSwatches');

function shouldDefaultToSource(value: string, readOnly: boolean, filePath?: string) {
  if (readOnly) return false;
  if (!filePath) return true;
  if (/\.mdx$/i.test(filePath)) return true;
  return FRONTMATTER_REGEX.test(value.trimStart());
}

function asMarkdownEditor(editor: Editor | null): MarkdownEditorWithMarkdown | null {
  if (!editor || typeof (editor as Partial<MarkdownEditorWithMarkdown>).getMarkdown !== 'function') {
    return null;
  }

  return editor as MarkdownEditorWithMarkdown;
}

function getActiveTableCellAlign(editor: Editor): ToolbarState['cellAlign'] {
  const align = (
    editor.getAttributes('tableCell').align ||
    editor.getAttributes('tableHeader').align ||
    null
  ) as string | null;

  return align === 'left' || align === 'center' || align === 'right' ? align : null;
}

function TooltipIconButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-label={label}
          title={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

function copyTextToClipboard(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => {});
}

function createColorSwatchWidget(colorCode: string) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'tiptap-color-swatch-widget';
  swatch.style.backgroundColor = colorCode;
  swatch.title = `Copy ${colorCode}`;
  swatch.setAttribute('aria-label', `Copy color ${colorCode}`);
  swatch.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    copyTextToClipboard(colorCode);
  });
  return swatch;
}

const ColorSwatchDecorations = Extension.create({
  name: 'colorSwatchDecorations',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: COLOR_SWATCH_PLUGIN_KEY,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];

            state.doc.descendants((node, pos, parent) => {
              if (!node.isText || !node.text || parent?.type.name === 'codeBlock') {
                return;
              }

              const isInlineCode = node.marks.some((mark) => mark.type.name === 'code');

              if (isInlineCode) {
                const colorCode = node.text.trim();
                if (isColorCode(colorCode)) {
                  decorations.push(Decoration.widget(
                    pos + node.nodeSize,
                    () => createColorSwatchWidget(colorCode),
                    {
                      key: `color-swatch-${pos}-${colorCode}`,
                      side: 1,
                      ignoreSelection: true,
                      stopEvent: () => true,
                    },
                  ));
                }
                return;
              }

              const colorRegex = createInlineColorRegex();
              for (const match of node.text.matchAll(colorRegex)) {
                const colorCode = match[0];
                const matchIndex = match.index ?? 0;
                decorations.push(Decoration.widget(
                  pos + matchIndex + colorCode.length,
                  () => createColorSwatchWidget(colorCode),
                  {
                    key: `color-swatch-${pos + matchIndex}-${colorCode}`,
                    side: 1,
                    ignoreSelection: true,
                    stopEvent: () => true,
                  },
                ));
              }
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

function runAfterSlashDelete({ editor, range }: SlashCommandContext) {
  return editor.chain().focus().deleteRange(range);
}

const SLASH_COMMAND_DEFINITIONS: SlashCommandDefinition[] = [
  {
    id: 'text',
    keywords: ['paragraph', 'plain'],
    Icon: Type,
    command: (context) => runAfterSlashDelete(context).setParagraph().run(),
  },
  {
    id: 'heading1',
    keywords: ['h1', 'title'],
    Icon: Heading1,
    command: (context) => runAfterSlashDelete(context).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'heading2',
    keywords: ['h2', 'subtitle'],
    Icon: Heading2,
    command: (context) => runAfterSlashDelete(context).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'heading3',
    keywords: ['h3'],
    Icon: Heading3,
    command: (context) => runAfterSlashDelete(context).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'bulletList',
    keywords: ['ul', 'list'],
    Icon: List,
    command: (context) => runAfterSlashDelete(context).toggleBulletList().run(),
  },
  {
    id: 'numberedList',
    keywords: ['ol', 'ordered'],
    Icon: ListOrdered,
    command: (context) => runAfterSlashDelete(context).toggleOrderedList().run(),
  },
  {
    id: 'taskList',
    keywords: ['todo', 'checklist'],
    Icon: ListChecks,
    command: (context) => runAfterSlashDelete(context).toggleTaskList().run(),
  },
  {
    id: 'quote',
    keywords: ['blockquote', 'citation'],
    Icon: Quote,
    command: (context) => runAfterSlashDelete(context).toggleBlockquote().run(),
  },
  {
    id: 'codeBlock',
    keywords: ['pre', 'fence'],
    Icon: Code2,
    command: (context) => runAfterSlashDelete(context).setCodeBlock().run(),
  },
  {
    id: 'table',
    keywords: ['grid'],
    Icon: Table2,
    command: (context) => {
      if (context.actions?.openTableDialog) {
        context.actions.openTableDialog(context.editor, context.range);
        return;
      }

      runAfterSlashDelete(context).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    },
  },
  {
    id: 'image',
    keywords: ['photo', 'picture'],
    Icon: ImageIcon,
    command: ({ editor, labels, range }) => {
      const src = window.prompt(labels.imageSrcPrompt);
      if (!src?.trim()) {
        editor.chain().focus().deleteRange(range).run();
        return;
      }

      const alt = window.prompt(labels.imageAltPrompt) || '';
      editor.chain().focus().deleteRange(range).setImage({ src: src.trim(), alt: alt.trim() }).run();
    },
  },
  {
    id: 'divider',
    keywords: ['hr', 'separator', 'line'],
    Icon: Minus,
    command: (context) => runAfterSlashDelete(context).setHorizontalRule().run(),
  },
  {
    id: 'bold',
    keywords: ['strong'],
    Icon: Bold,
    command: (context) => runAfterSlashDelete(context).toggleBold().run(),
  },
  {
    id: 'italic',
    keywords: ['emphasis'],
    Icon: Italic,
    command: (context) => runAfterSlashDelete(context).toggleItalic().run(),
  },
  {
    id: 'strike',
    keywords: ['delete', 'cross'],
    Icon: Strikethrough,
    command: (context) => runAfterSlashDelete(context).toggleStrike().run(),
  },
  {
    id: 'inlineCode',
    keywords: ['monospace'],
    Icon: Code,
    command: (context) => runAfterSlashDelete(context).toggleCode().run(),
  },
];

function getSlashCommandItems(query: string, labels: SlashCommandLabels): SlashCommandItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const localizedItems = SLASH_COMMAND_DEFINITIONS.map((definition) => ({
    ...definition,
    ...labels.items[definition.id],
  }));

  if (!normalizedQuery) {
    return localizedItems.slice(0, 10);
  }

  return localizedItems
    .filter((item) => {
      const searchableText = [item.title, item.description, ...item.keywords].join(' ').toLowerCase();
      return searchableText.includes(normalizedQuery);
    })
    .slice(0, 10);
}

const SlashCommandList = React.forwardRef<SlashCommandListHandle, SlashCommandListProps>(
  ({ items, command, labels }, ref) => {
    const [selectionState, setSelectionState] = useState({ index: 0, itemKey: '' });
    const itemKey = items.map((item) => item.id).join('|');
    const selectedIndex = selectionState.itemKey === itemKey ? selectionState.index : 0;
    const activeIndex = items.length ? selectedIndex % items.length : 0;

    const selectItem = useCallback((index: number) => {
      const item = items[index];
      if (!item) return;
      command(item);
    }, [command, items]);

    const selectPrevious = useCallback(() => {
      setSelectionState((current) => ({
        itemKey,
        index: ((current.itemKey === itemKey ? current.index : 0) + items.length - 1) % items.length,
      }));
    }, [itemKey, items.length]);

    const selectNext = useCallback(() => {
      setSelectionState((current) => ({
        itemKey,
        index: ((current.itemKey === itemKey ? current.index : 0) + 1) % items.length,
      }));
    }, [itemKey, items.length]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (!items.length) return false;

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          selectPrevious();
          return true;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          selectNext();
          return true;
        }

        if (event.key === 'Enter') {
          event.preventDefault();
          selectItem(activeIndex);
          return true;
        }

        return false;
      },
    }), [activeIndex, items.length, selectItem, selectNext, selectPrevious]);

    return (
      <Command className="w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-lg" shouldFilter={false}>
        <CommandList className="max-h-72">
          <CommandEmpty>{labels.empty}</CommandEmpty>
          <CommandGroup heading={labels.group}>
            {items.map((item, index) => (
              <CommandItem
                key={item.id}
                value={item.title}
                aria-selected={index === activeIndex}
                data-selected={index === activeIndex ? 'true' : undefined}
                ref={(element) => {
                  if (index === activeIndex) {
                    element?.scrollIntoView({ block: 'nearest' });
                  }
                }}
                onMouseEnter={() => setSelectionState({ index, itemKey })}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectItem(index);
                }}
              >
                <item.Icon />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    );
  },
);

SlashCommandList.displayName = 'SlashCommandList';

function updateSlashCommandPosition(element: HTMLElement, props: SuggestionProps<SlashCommandItem, SlashCommandItem>) {
  const rect = props.clientRect?.();
  if (!rect) return;

  const menuWidth = 288;
  const menuHeight = 288;
  const padding = 8;
  const left = Math.max(padding, Math.min(rect.left, window.innerWidth - menuWidth - padding));
  const opensBelow = rect.bottom + menuHeight + padding <= window.innerHeight;
  const top = opensBelow
    ? rect.bottom + 6
    : Math.max(padding, rect.top - menuHeight - 6);

  Object.assign(element.style, {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    width: `${menuWidth}px`,
  });
}

function createSlashCommands(labels: SlashCommandLabels, actions?: SlashCommandActions) {
  return Extension.create({
    name: 'slashCommands',

    addProseMirrorPlugins() {
      return [
        Suggestion<SlashCommandItem, SlashCommandItem>({
          editor: this.editor,
          pluginKey: SLASH_COMMAND_PLUGIN_KEY,
          char: '/',
          startOfLine: true,
          allowedPrefixes: null,
          decorationClass: 'tiptap-slash-suggestion',
          items: ({ query }) => getSlashCommandItems(query, labels),
          allow: ({ editor, range }) => {
            if (!editor.isEditable || editor.isActive('codeBlock')) return false;

            const $from = editor.state.doc.resolve(range.from);
            return $from.parent.type.name === 'paragraph';
          },
          command: ({ editor, range, props }) => {
            props.command({ editor, labels, range, actions });
          },
          render: () => {
            let component: ReactRenderer<SlashCommandListHandle, SlashCommandListProps> | null = null;

            return {
              onStart: (props) => {
                component = new ReactRenderer(SlashCommandList, {
                  props: { ...props, labels },
                  editor: props.editor,
                });

                component.element.classList.add('tiptap-slash-menu');
                document.body.appendChild(component.element);
                updateSlashCommandPosition(component.element, props);
              },
              onUpdate: (props) => {
                component?.updateProps({ ...props, labels });

                if (component) {
                  updateSlashCommandPosition(component.element, props);
                }
              },
              onKeyDown: (props) => component?.ref?.onKeyDown(props) ?? false,
              onExit: () => {
                component?.element.remove();
                component?.destroy();
                component = null;
              },
            };
          },
        }),
      ];
    },
  });
}

function MarkdownImageNodeView({
  node,
  selected,
  filePath,
}: NodeViewProps & { filePath?: string }) {
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
  const resolvedImage = resolveMarkdownImageUrl(src, filePath);

  return (
    <NodeViewWrapper
      as="figure"
      className={cn(
        'my-4 max-w-full rounded-md border border-transparent p-1',
        selected && 'border-primary/60 bg-primary/5',
      )}
      contentEditable={false}
    >
      {resolvedImage.ok ? (
        <SafeMarkdownImage
          src={src}
          previewSrc={resolvedImage.src}
          alt={alt}
          imageClassName="max-h-[60vh] w-auto max-w-full rounded-md object-contain"
          showError
          errorLabel={`Image could not be loaded: ${src}`}
        />
      ) : (
        <div
          role="img"
          aria-label={resolvedImage.error}
          title={src}
          className="inline-flex max-w-full items-center rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {resolvedImage.error}
        </div>
      )}
      {alt ? <figcaption className="mt-1 text-center text-xs text-muted-foreground">{alt}</figcaption> : null}
    </NodeViewWrapper>
  );
}

function createMarkdownImageExtension(filePath?: string) {
  return Image.extend({
    addNodeView() {
      return ReactNodeViewRenderer((props) => <MarkdownImageNodeView {...props} filePath={filePath} />);
    },
  });
}

function MermaidCodeBlockNodeView({ node }: NodeViewProps) {
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
  const isMermaid = language.toLowerCase() === 'mermaid';
  const [editingLanguage, setEditingLanguage] = useState<string | null>(null);
  const isEditing = !isMermaid || editingLanguage === language;

  if (!isMermaid || isEditing) {
    return (
      <NodeViewWrapper as="pre" className="tiptap-code-block">
        <NodeViewContent spellCheck={false} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="div"
      className="tiptap-mermaid-node"
      contentEditable={false}
      role="button"
      tabIndex={0}
      onClick={() => setEditingLanguage(language)}
      onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setEditingLanguage(language);
        }
      }}
    >
      <MermaidDiagram code={node.textContent} interactive={false} />
    </NodeViewWrapper>
  );
}

const CodeBlockWithMermaid = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockNodeView);
  },
});

function createSlashCommandLabels(t: (key: string) => string): SlashCommandLabels {
  const itemLabels = Object.fromEntries(
    SLASH_COMMAND_DEFINITIONS.map((definition) => [
      definition.id,
      {
        title: t(`markdownEditorCommands.${definition.id}.title`),
        description: t(`markdownEditorCommands.${definition.id}.description`),
      },
    ]),
  ) as Record<SlashCommandItemId, SlashCommandItemLabel>;

  return {
    addBlock: t('markdownEditorAddBlock'),
    empty: t('markdownEditorNoCommandFound'),
    group: t('markdownEditorSlashGroup'),
    imageAltPrompt: t('markdownEditorImageAltPrompt'),
    imageSrcPrompt: t('markdownEditorImageSrcPrompt'),
    items: itemLabels,
    placeholder: t('markdownEditorPlaceholder'),
  };
}

function findActiveTextblockDepth(editor: Editor): number | null {
  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).isTextblock) return depth;
  }

  return null;
}

function openSlashMenuFromCurrentBlock(editor: Editor) {
  if (!editor.isEditable || editor.isActive('codeBlock')) return;

  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  if (!textblockDepth) return;

  const node = $from.node(textblockDepth);
  if (node.type.name === 'paragraph' && node.content.size === 0) {
    editor.chain().focus().setTextSelection($from.start(textblockDepth)).insertContent('/').run();
    return;
  }

  const insertPosition = $from.after(textblockDepth);
  editor
    .chain()
    .focus()
    .insertContentAt(insertPosition, {
      type: 'paragraph',
      content: [{ type: 'text', text: '/' }],
    })
    .setTextSelection(insertPosition + 2)
    .run();
}

function getBlockInsertButtonPosition(editor: Editor, container: HTMLDivElement): { top: number } | null {
  if (!editor.isEditable || editor.isActive('codeBlock')) return null;

  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  if (!textblockDepth) return null;

  const blockStart = $from.before(textblockDepth);
  const positionForCoords = Math.min(blockStart + 1, editor.state.doc.content.size);
  const coords = editor.view.coordsAtPos(positionForCoords);
  const containerRect = container.getBoundingClientRect();

  return {
    top: Math.max(6, coords.top - containerRect.top + container.scrollTop - 2),
  };
}

function MarkdownBlockInsertButton({
  editor,
  label,
  scrollContainerRef,
}: {
  editor: Editor | null;
  label: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [position, setPosition] = useState<{ top: number } | null>(null);

  const updatePosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!editor || !container) {
      setPosition(null);
      return;
    }

    setPosition(getBlockInsertButtonPosition(editor, container));
  }, [editor, scrollContainerRef]);

  useEffect(() => {
    if (!editor) return;

    const frame = window.requestAnimationFrame(updatePosition);
    editor.on('selectionUpdate', updatePosition);
    editor.on('transaction', updatePosition);
    editor.on('focus', updatePosition);

    return () => {
      window.cancelAnimationFrame(frame);
      editor.off('selectionUpdate', updatePosition);
      editor.off('transaction', updatePosition);
      editor.off('focus', updatePosition);
    };
  }, [editor, updatePosition]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', updatePosition, { passive: true });
    window.addEventListener('resize', updatePosition);

    return () => {
      container.removeEventListener('scroll', updatePosition);
      window.removeEventListener('resize', updatePosition);
    };
  }, [scrollContainerRef, updatePosition]);

  if (!editor?.isEditable || !position) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          title={label}
          className="absolute left-1 z-10 opacity-70 hover:opacity-100"
          style={{ top: position.top }}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openSlashMenuFromCurrentBlock(editor);
          }}
        >
          <Plus />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function createEditorExtensions(filePath: string | undefined, labels: SlashCommandLabels, actions?: SlashCommandActions) {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: false,
    }),
    Placeholder.configure({
      placeholder: ({ node }) => node.type.name === 'paragraph' ? labels.placeholder : '',
      showOnlyCurrent: true,
    }),
    CodeBlockWithMermaid,
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: true,
    }),
    createMarkdownImageExtension(filePath),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    TableKit.configure({
      table: {
        resizable: false,
      },
    }),
    ColorSwatchDecorations,
    createSlashCommands(labels, actions),
    Markdown.configure({
      markedOptions: {
        gfm: true,
        breaks: false,
      },
      indentation: {
        style: 'space',
        size: 2,
      },
    }),
  ];
}

function MarkdownSourceToolbar({ onRichMode }: { onRichMode: () => void }) {
  return (
    <TooltipProvider>
      <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-border bg-background px-2">
        <TooltipIconButton label="WYSIWYG" onClick={onRichMode}>
          <Eye />
        </TooltipIconButton>
      </div>
    </TooltipProvider>
  );
}

type LinkPreviewState =
  | { status: 'idle'; error?: undefined; imageUrl?: undefined; host?: undefined }
  | { status: 'loading'; error?: undefined; imageUrl?: undefined; host?: undefined }
  | { status: 'loaded'; error?: undefined; imageUrl: string | null; host: string }
  | { status: 'error'; error: string; imageUrl?: undefined; host?: undefined };

type LinkDialogSeed = {
  id: number;
  href: string;
  text: string;
  canEditText: boolean;
};

type TableInsertOptions = {
  rows: number;
  cols: number;
  withHeaderRow: boolean;
};

function normalizeLinkHref(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z\d+.-]*:/iu.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function getSelectedText(editor: Editor) {
  const { from, to, empty } = editor.state.selection;
  if (empty) return '';
  return editor.state.doc.textBetween(from, to, ' ');
}

function MarkdownLinkDialog({
  editor,
  open,
  onOpenChange,
  initialHref,
  initialText,
  canEditText,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialHref: string;
  initialText: string;
  canEditText: boolean;
}) {
  const t = useTranslations('notebook');
  const [href, setHref] = useState(initialHref);
  const [text, setText] = useState(initialText);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [previewState, setPreviewState] = useState<LinkPreviewState>({ status: 'idle' });
  const linkActive = Boolean(editor?.isActive('link'));

  useEffect(() => {
    if (!open || !previewEnabled) return;

    const previewUrl = normalizeLinkHref(href);
    if (!/^https?:\/\//iu.test(previewUrl)) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setPreviewState({ status: 'loading' });
      try {
        const response = await fetch(`/api/markdown/link-preview?url=${encodeURIComponent(previewUrl)}`, {
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as
          | { success?: boolean; data?: { imageUrl?: string | null; host?: string }; error?: string }
          | null;

        if (!response.ok || !payload?.success) {
          throw new Error(payload?.error || t('markdownEditorLinkPreviewError'));
        }

        setPreviewState({
          status: 'loaded',
          imageUrl: payload.data?.imageUrl ?? null,
          host: payload.data?.host ?? new URL(previewUrl).hostname,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreviewState({
          status: 'error',
          error: error instanceof Error ? error.message : t('markdownEditorLinkPreviewError'),
        });
      }
    }, 350);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [href, open, previewEnabled, t]);

  const applyLink = useCallback(() => {
    if (!editor) return;

    const normalizedHref = normalizeLinkHref(href);
    if (!normalizedHref) {
      editor.chain().focus().unsetLink().run();
      onOpenChange(false);
      return;
    }

    if (editor.isActive('link') || !editor.state.selection.empty) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: normalizedHref }).run();
    } else {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: text.trim() || normalizedHref,
          marks: [{ type: 'link', attrs: { href: normalizedHref } }],
        })
        .run();
    }

    onOpenChange(false);
  }, [editor, href, onOpenChange, text]);

  const removeLink = useCallback(() => {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    onOpenChange(false);
  }, [editor, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('markdownEditorLinkDialogTitle')}</DialogTitle>
          <DialogDescription>{t('markdownEditorLinkDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="markdown-link-url">{t('markdownEditorLinkUrl')}</Label>
            <Input
              id="markdown-link-url"
              value={href}
              placeholder="https://example.com"
              onChange={(event) => {
                setHref(event.target.value);
                setPreviewState({ status: 'idle' });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyLink();
                }
              }}
            />
          </div>

          {canEditText ? (
            <div className="grid gap-2">
              <Label htmlFor="markdown-link-text">{t('markdownEditorLinkText')}</Label>
              <Input
                id="markdown-link-text"
                value={text}
                placeholder={t('markdownEditorLinkTextPlaceholder')}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="markdown-link-preview-toggle">{t('markdownEditorLinkPreviewToggle')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('markdownEditorLinkPreviewHint')}</p>
            </div>
            <Switch
              id="markdown-link-preview-toggle"
              checked={previewEnabled}
              onCheckedChange={(checked) => {
                setPreviewEnabled(checked);
                if (!checked) setPreviewState({ status: 'idle' });
              }}
            />
          </div>

          {previewEnabled ? (
            <div className="min-h-20 rounded-md border bg-muted/20 p-2">
              {previewState.status === 'loading' ? (
                <div className="flex h-16 items-center text-sm text-muted-foreground">
                  {t('markdownEditorLinkPreviewLoading')}
                </div>
              ) : null}

              {previewState.status === 'loaded' ? (
                previewState.imageUrl ? (
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={previewState.imageUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-16 w-24 shrink-0 rounded-sm border bg-background object-cover"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{previewState.host}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {t('markdownEditorLinkPreviewImageLoaded')}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-16 items-center text-sm text-muted-foreground">
                    {t('markdownEditorLinkPreviewNoImage')}
                  </div>
                )
              ) : null}

              {previewState.status === 'error' ? (
                <div className="flex h-16 items-center text-sm text-destructive">{previewState.error}</div>
              ) : null}

              {previewState.status === 'idle' ? (
                <div className="flex h-16 items-center text-sm text-muted-foreground">
                  {t('markdownEditorLinkPreviewIdle')}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {linkActive ? (
            <Button type="button" variant="outline" onClick={removeLink}>
              {t('markdownEditorLinkRemove')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={applyLink}>
            {t('markdownEditorLinkApply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MarkdownTableDialog({
  open,
  onOpenChange,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (options: TableInsertOptions) => void;
}) {
  const t = useTranslations('notebook');
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [withHeaderRow, setWithHeaderRow] = useState(true);

  const submit = useCallback(() => {
    onInsert({
      rows: Math.min(20, Math.max(1, rows || 1)),
      cols: Math.min(12, Math.max(1, cols || 1)),
      withHeaderRow,
    });
  }, [cols, onInsert, rows, withHeaderRow]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('markdownEditorTableDialogTitle')}</DialogTitle>
          <DialogDescription>{t('markdownEditorTableDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="markdown-table-rows">{t('markdownEditorTableRows')}</Label>
              <Input
                id="markdown-table-rows"
                type="number"
                min={1}
                max={20}
                value={rows}
                onChange={(event) => setRows(Number(event.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="markdown-table-cols">{t('markdownEditorTableColumns')}</Label>
              <Input
                id="markdown-table-cols"
                type="number"
                min={1}
                max={12}
                value={cols}
                onChange={(event) => setCols(Number(event.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <Label htmlFor="markdown-table-header-row">{t('markdownEditorTableHeaderRow')}</Label>
            <Switch
              id="markdown-table-header-row"
              checked={withHeaderRow}
              onCheckedChange={setWithHeaderRow}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={submit}>
            {t('markdownEditorTableInsert')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MarkdownToolbar({
  editor,
  onSourceMode,
  onOpenTableDialog,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  onSourceMode: () => void;
  onOpenTableDialog: () => void;
}) {
  const t = useTranslations('notebook');
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkDialogSeed, setLinkDialogSeed] = useState<LinkDialogSeed>({
    id: 0,
    href: '',
    text: '',
    canEditText: true,
  });
  const canUseCommands = Boolean(editor?.isEditable);
  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      if (!currentEditor) return EMPTY_TOOLBAR_STATE;

      return {
        canUndo: currentEditor.can().undo(),
        canRedo: currentEditor.can().redo(),
        isBold: currentEditor.isActive('bold'),
        isItalic: currentEditor.isActive('italic'),
        isStrike: currentEditor.isActive('strike'),
        isCode: currentEditor.isActive('code'),
        isHeading1: currentEditor.isActive('heading', { level: 1 }),
        isHeading2: currentEditor.isActive('heading', { level: 2 }),
        isHeading3: currentEditor.isActive('heading', { level: 3 }),
        isBulletList: currentEditor.isActive('bulletList'),
        isOrderedList: currentEditor.isActive('orderedList'),
        isTaskList: currentEditor.isActive('taskList'),
        isBlockquote: currentEditor.isActive('blockquote'),
        isLink: currentEditor.isActive('link'),
        isCodeBlock: currentEditor.isActive('codeBlock'),
        isTable: currentEditor.isActive('table'),
        cellAlign: getActiveTableCellAlign(currentEditor),
      };
    },
  }) ?? EMPTY_TOOLBAR_STATE;

  const setLink = useCallback(() => {
    if (!editor) return;
    setLinkDialogSeed((current) => ({
      id: current.id + 1,
      href: (editor.getAttributes('link').href as string | undefined) || '',
      text: getSelectedText(editor),
      canEditText: editor.state.selection.empty && !editor.isActive('link'),
    }));
    setLinkDialogOpen(true);
  }, [editor]);

  const setImage = useCallback(() => {
    if (!editor) return;

    const src = window.prompt('Image URL or workspace path');
    if (!src?.trim()) return;

    const alt = window.prompt('Alt text') || '';
    editor.chain().focus().setImage({ src: src.trim(), alt: alt.trim() }).run();
  }, [editor]);

  return (
    <TooltipProvider>
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2">
        <TooltipIconButton
          label="Undo"
          disabled={!canUseCommands || !toolbarState.canUndo}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 />
        </TooltipIconButton>
        <TooltipIconButton
          label="Redo"
          disabled={!canUseCommands || !toolbarState.canRedo}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 />
        </TooltipIconButton>

        <ToolbarDivider />

        <TooltipIconButton
          label="Bold"
          active={toolbarState.isBold}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold />
        </TooltipIconButton>
        <TooltipIconButton
          label="Italic"
          active={toolbarState.isItalic}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic />
        </TooltipIconButton>
        <TooltipIconButton
          label="Strike"
          active={toolbarState.isStrike}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <Strikethrough />
        </TooltipIconButton>
        <TooltipIconButton
          label="Inline code"
          active={toolbarState.isCode}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleCode().run()}
        >
          <Code />
        </TooltipIconButton>

        <ToolbarDivider />

        <TooltipIconButton
          label="Heading 1"
          active={toolbarState.isHeading1}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 />
        </TooltipIconButton>
        <TooltipIconButton
          label="Heading 2"
          active={toolbarState.isHeading2}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 />
        </TooltipIconButton>
        <TooltipIconButton
          label="Heading 3"
          active={toolbarState.isHeading3}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 />
        </TooltipIconButton>

        <ToolbarDivider />

        <TooltipIconButton
          label="Bullet list"
          active={toolbarState.isBulletList}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List />
        </TooltipIconButton>
        <TooltipIconButton
          label="Ordered list"
          active={toolbarState.isOrderedList}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered />
        </TooltipIconButton>
        <TooltipIconButton
          label="Task list"
          active={toolbarState.isTaskList}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
        >
          <ListChecks />
        </TooltipIconButton>
        <TooltipIconButton
          label="Quote"
          active={toolbarState.isBlockquote}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote />
        </TooltipIconButton>

        <ToolbarDivider />

        <TooltipIconButton label="Link" active={toolbarState.isLink} disabled={!canUseCommands} onClick={setLink}>
          <LinkIcon />
        </TooltipIconButton>
        <TooltipIconButton label="Image" disabled={!canUseCommands} onClick={setImage}>
          <ImageIcon />
        </TooltipIconButton>
        <TooltipIconButton
          label={t('markdownEditorTableInsert')}
          disabled={!canUseCommands}
          onClick={onOpenTableDialog}
        >
          <Table2 />
        </TooltipIconButton>
        <TooltipIconButton
          label="Code block"
          active={toolbarState.isCodeBlock}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        >
          <Code2 />
        </TooltipIconButton>
        <TooltipIconButton
          label="Horizontal rule"
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
        >
          <Minus />
        </TooltipIconButton>

        <div className="ml-auto shrink-0">
          <TooltipIconButton label="Markdown source" onClick={onSourceMode}>
            <Code2 />
          </TooltipIconButton>
        </div>
      </div>
      {toolbarState.isTable ? (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2">
          <span className="mr-1 shrink-0 text-xs font-medium text-muted-foreground">
            {t('markdownEditorTableTools')}
          </span>
          <TooltipIconButton
            label={t('markdownEditorTableAddColumnBefore')}
            disabled={!canUseCommands || !editor?.can().addColumnBefore()}
            onClick={() => editor?.chain().focus().addColumnBefore().run()}
          >
            <Columns3 />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('markdownEditorTableAddColumnAfter')}
            disabled={!canUseCommands || !editor?.can().addColumnAfter()}
            onClick={() => editor?.chain().focus().addColumnAfter().run()}
          >
            <Plus />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('markdownEditorTableDeleteColumn')}
            disabled={!canUseCommands || !editor?.can().deleteColumn()}
            onClick={() => editor?.chain().focus().deleteColumn().run()}
          >
            <Trash2 />
          </TooltipIconButton>

          <ToolbarDivider />

          <TooltipIconButton
            label={t('markdownEditorTableAddRowBefore')}
            disabled={!canUseCommands || !editor?.can().addRowBefore()}
            onClick={() => editor?.chain().focus().addRowBefore().run()}
          >
            <Rows3 />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('markdownEditorTableAddRowAfter')}
            disabled={!canUseCommands || !editor?.can().addRowAfter()}
            onClick={() => editor?.chain().focus().addRowAfter().run()}
          >
            <Plus />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('markdownEditorTableDeleteRow')}
            disabled={!canUseCommands || !editor?.can().deleteRow()}
            onClick={() => editor?.chain().focus().deleteRow().run()}
          >
            <Trash2 />
          </TooltipIconButton>

          <ToolbarDivider />

          <TooltipIconButton
            label={t('markdownEditorTableToggleHeaderRow')}
            disabled={!canUseCommands || !editor?.can().toggleHeaderRow()}
            onClick={() => editor?.chain().focus().toggleHeaderRow().run()}
          >
            <Table2 />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('markdownEditorTableAlignLeft')}
            active={toolbarState.cellAlign === 'left'}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().setCellAttribute('align', 'left').run()}
          >
            <AlignLeft />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('markdownEditorTableAlignCenter')}
            active={toolbarState.cellAlign === 'center'}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().setCellAttribute('align', 'center').run()}
          >
            <AlignCenter />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('markdownEditorTableAlignRight')}
            active={toolbarState.cellAlign === 'right'}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().setCellAttribute('align', 'right').run()}
          >
            <AlignRight />
          </TooltipIconButton>

          <ToolbarDivider />

          <TooltipIconButton
            label={t('markdownEditorTableDelete')}
            disabled={!canUseCommands || !editor?.can().deleteTable()}
            onClick={() => editor?.chain().focus().deleteTable().run()}
          >
            <Trash2 />
          </TooltipIconButton>
        </div>
      ) : null}
      <MarkdownLinkDialog
        key={linkDialogSeed.id}
        editor={editor}
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        initialHref={linkDialogSeed.href}
        initialText={linkDialogSeed.text}
        canEditText={linkDialogSeed.canEditText}
      />
    </TooltipProvider>
  );
}

function RichMarkdownEditor({
  value,
  onChange,
  readOnly,
  filePath,
  onSourceMode,
}: MarkdownEditorProps & { onSourceMode: () => void }) {
  const t = useTranslations('notebook');
  const latestValueRef = useRef(value);
  const applyingExternalValueRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const labels = useMemo(() => createSlashCommandLabels(t), [t]);
  const openTableDialogFromSlash = useCallback((slashEditor: Editor, range: Range) => {
    slashEditor.chain().focus().deleteRange(range).run();
    setTableDialogOpen(true);
  }, []);
  const extensions = useMemo(
    () => createEditorExtensions(filePath, labels, { openTableDialog: openTableDialogFromSlash }),
    [filePath, labels, openTableDialogFromSlash],
  );

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  const editor = useEditor({
    extensions,
    content: value,
    contentType: 'markdown',
    editable: !readOnly,
    immediatelyRender: false,
    onUpdate: ({ editor: updateEditor }) => {
      if (readOnly || applyingExternalValueRef.current) return;

      const markdownEditor = asMarkdownEditor(updateEditor);
      const markdown = markdownEditor?.getMarkdown() ?? '';
      if (markdown !== latestValueRef.current) {
        latestValueRef.current = markdown;
        onChange?.(markdown);
      }
    },
  });

  const markdownEditor = asMarkdownEditor(editor);

  const insertTable = useCallback((options: TableInsertOptions) => {
    if (!editor) return;
    editor.chain().focus().insertTable(options).run();
    setTableDialogOpen(false);
  }, [editor]);

  useEffect(() => {
    if (!markdownEditor) return;

    const currentMarkdown = markdownEditor.getMarkdown();
    if (currentMarkdown === value) return;

    applyingExternalValueRef.current = true;
    markdownEditor.commands.setContent(value, {
      contentType: 'markdown',
      emitUpdate: false,
    });
    applyingExternalValueRef.current = false;
  }, [markdownEditor, value]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {!readOnly ? (
        <MarkdownToolbar
          editor={markdownEditor}
          onSourceMode={onSourceMode}
          onOpenTableDialog={() => setTableDialogOpen(true)}
        />
      ) : null}
      {!readOnly ? (
        <MarkdownTableDialog open={tableDialogOpen} onOpenChange={setTableDialogOpen} onInsert={insertTable} />
      ) : null}
      <div ref={scrollContainerRef} className="relative min-h-0 flex-1 overflow-auto">
        {!readOnly ? (
          <TooltipProvider>
            <MarkdownBlockInsertButton editor={editor} label={labels.addBlock} scrollContainerRef={scrollContainerRef} />
          </TooltipProvider>
        ) : null}
        <EditorContent editor={editor} className="tiptap-editor-shell" />
      </div>
    </div>
  );
}

function SourceMarkdownEditor({
  value,
  onChange,
  readOnly,
  filePath,
  onRichMode,
}: MarkdownEditorProps & { onRichMode: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {!readOnly ? <MarkdownSourceToolbar onRichMode={onRichMode} /> : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeEditor
          value={value}
          onChange={(nextValue) => {
            if (!readOnly) onChange?.(nextValue);
          }}
          readOnly={readOnly}
          path={filePath ?? 'document.md'}
        />
      </div>
    </div>
  );
}

export function MarkdownEditor({ value, onChange, readOnly = false, filePath }: MarkdownEditorProps) {
  const defaultMode = shouldDefaultToSource(value, readOnly, filePath) ? 'source' : 'rich';
  const [mode, setMode] = useState<EditorMode>(defaultMode);

  if (mode === 'source') {
    return (
      <SourceMarkdownEditor
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        filePath={filePath}
        onRichMode={() => setMode('rich')}
      />
    );
  }

  return (
    <RichMarkdownEditor
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      filePath={filePath}
      onSourceMode={() => setMode('source')}
    />
  );
}
