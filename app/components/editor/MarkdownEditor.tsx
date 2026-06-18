'use client';

import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Extension, getMarkRange, type Editor, type JSONContent, type Range } from '@tiptap/core';
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
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
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
  Copy,
  Eye,
  ExternalLink,
  GripVertical,
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
  Pencil,
  Quote,
  Redo2,
  Rows3,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  Undo2,
  Unlink,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
import {
  clampEditorRangeToDoc,
  isEditorPositionInsideDoc,
} from '@/app/lib/editor/prosemirror-ranges';
import { createInlineColorRegex, isColorCode } from '@/app/lib/markdown/color-code';
import { makeLinkPreviewImageAlt, parseLinkPreviewImageAlt } from '@/app/lib/markdown/link-preview-markdown';
import {
  getWorkspaceTargetDirForMarkdown,
  markdownImageSrcForWorkspacePath,
} from '@/app/lib/markdown/markdown-image-path';
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
  openImageDialog?: (editor: Editor, range: Range) => void;
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
  addBlockAboveHint: string;
  addBlockBelowHint: string;
  dragBlockHint: string;
  empty: string;
  group: string;
  imageAltPrompt: string;
  imageSrcPrompt: string;
  items: Record<SlashCommandItemId, SlashCommandItemLabel>;
  openBlockMenuHint: string;
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
  onKeyDown: (event: KeyboardEvent | React.KeyboardEvent) => boolean;
};

type SlashCommandListProps = {
  command: (item: SlashCommandItem) => void;
  items: SlashCommandItem[];
  labels: Pick<SlashCommandLabels, 'empty' | 'group'>;
};

type BlockCommandMenuState = {
  id: number;
  range: Range;
  position: {
    left: number;
    top: number;
    width: number;
  };
};

type BlockInsertPlacement = 'above' | 'below';

type TopLevelBlockRange = {
  from: number;
  node: ProseMirrorNode;
  to: number;
};

type BlockControlPosition = {
  blockRange: TopLevelBlockRange;
  menuRange: Range;
  top: number;
};

type ImageDialogSeed = {
  id: number;
  range?: Range;
};

type ColorSwatchWidgetHost = HTMLSpanElement & {
  colorSwatchRoot?: Root;
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
  if (filePath && /\.mdx$/i.test(filePath)) return true;
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

function getCopyActionLabel() {
  const language = document.documentElement.lang || navigator.language || '';
  return language.toLowerCase().startsWith('de') ? 'Kopieren' : 'Copy';
}

function MarkdownColorSwatchWidget({ colorCode }: { colorCode: string }) {
  const actionLabel = getCopyActionLabel();

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="tiptap-color-swatch-widget"
            style={{ backgroundColor: colorCode }}
            aria-label={`${actionLabel}: ${colorCode}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              copyTextToClipboard(colorCode);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          />
        </TooltipTrigger>
        <TooltipContent>{actionLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function createColorSwatchWidget(colorCode: string) {
  const host = document.createElement('span') as ColorSwatchWidgetHost;
  host.className = 'tiptap-color-swatch-widget-root';
  host.colorSwatchRoot = createRoot(host);
  host.colorSwatchRoot.render(<MarkdownColorSwatchWidget colorCode={colorCode} />);
  return host;
}

function destroyColorSwatchWidget(node: Node) {
  if (!(node instanceof HTMLSpanElement)) return;
  (node as ColorSwatchWidgetHost).colorSwatchRoot?.unmount();
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
                      destroy: destroyColorSwatchWidget,
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
                    destroy: destroyColorSwatchWidget,
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
  const chain = editor.chain().focus();
  const safeRange = clampEditorRangeToDoc(editor, range);

  if (!safeRange || safeRange.from === safeRange.to) {
    return chain;
  }

  return chain.deleteRange(safeRange);
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
    command: ({ actions, editor, labels, range }) => {
      if (actions?.openImageDialog) {
        actions.openImageDialog(editor, range);
        return;
      }

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
      onKeyDown: (event) => {
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
                  event.stopPropagation();
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

function getSlashCommandMenuPosition(rect: Pick<DOMRect, 'bottom' | 'left' | 'top'>) {
  const menuWidth = 288;
  const menuHeight = 288;
  const padding = 8;
  const left = Math.max(padding, Math.min(rect.left, window.innerWidth - menuWidth - padding));
  const opensBelow = rect.bottom + menuHeight + padding <= window.innerHeight;
  const top = opensBelow
    ? rect.bottom + 6
    : Math.max(padding, rect.top - menuHeight - 6);

  return {
    left,
    top,
    width: menuWidth,
  };
}

function updateSlashCommandPosition(element: HTMLElement, props: SuggestionProps<SlashCommandItem, SlashCommandItem>) {
  const rect = props.clientRect?.();
  if (!rect) return;
  const position = getSlashCommandMenuPosition(rect);

  Object.assign(element.style, {
    position: 'fixed',
    left: `${position.left}px`,
    top: `${position.top}px`,
    width: `${position.width}px`,
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
          startOfLine: false,
          allowedPrefixes: null,
          decorationClass: 'tiptap-slash-suggestion',
          items: ({ query }) => getSlashCommandItems(query, labels),
          allow: ({ editor, state, range }) => {
            if (!editor.isEditable || editor.isActive('codeBlock')) return false;
            if (
              !Number.isInteger(range.from) ||
              !Number.isInteger(range.to) ||
              range.from < 0 ||
              range.to < range.from ||
              range.to > state.doc.content.size
            ) {
              return false;
            }

            const $from = state.doc.resolve(range.from);
            if ($from.marks().some((mark) => mark.type.name === 'link')) return false;

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
              onKeyDown: ({ event }) => component?.ref?.onKeyDown(event) ?? false,
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
  const linkPreviewLabel = parseLinkPreviewImageAlt(alt);

  if (linkPreviewLabel) {
    return (
      <NodeViewWrapper
        as="span"
        className={cn(
          'tiptap-link-preview-node',
          selected && 'tiptap-link-preview-node-selected',
        )}
        contentEditable={false}
        title={linkPreviewLabel}
      >
        {resolvedImage.ok ? (
          <SafeMarkdownImage
            src={src}
            previewSrc={resolvedImage.src}
            alt={alt}
            wrapperClassName="tiptap-link-preview-image-wrap"
            imageClassName="tiptap-link-preview-image"
            showError
            errorClassName="tiptap-link-preview-error"
            errorLabel={`Preview could not be loaded: ${src}`}
          />
        ) : (
          <span className="tiptap-link-preview-error" title={src}>
            {resolvedImage.error}
          </span>
        )}
      </NodeViewWrapper>
    );
  }

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
    addBlockAboveHint: t('markdownEditorAddBlockAboveHint'),
    addBlockBelowHint: t('markdownEditorAddBlockBelowHint'),
    dragBlockHint: t('markdownEditorDragBlockHint'),
    empty: t('markdownEditorNoCommandFound'),
    group: t('markdownEditorSlashGroup'),
    imageAltPrompt: t('markdownEditorImageAltPrompt'),
    imageSrcPrompt: t('markdownEditorImageSrcPrompt'),
    items: itemLabels,
    openBlockMenuHint: t('markdownEditorOpenBlockMenuHint'),
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

function getTopLevelBlockRangeAt(editor: Editor, position: number): TopLevelBlockRange | null {
  const docEnd = editor.state.doc.content.size;
  const safePosition = Math.max(0, Math.min(position, docEnd));
  let range: TopLevelBlockRange | null = null;

  editor.state.doc.forEach((node, offset) => {
    if (range) return;

    const from = offset;
    const to = offset + node.nodeSize;
    const isInsideNode = safePosition >= from && safePosition < to;
    const isAtDocumentEnd = safePosition === docEnd && safePosition === to;

    if (isInsideNode || isAtDocumentEnd) {
      range = { from, node, to };
    }
  });

  return range;
}

function createInsertedBlockCommandTarget(
  editor: Editor,
  placement: BlockInsertPlacement,
  blockRange?: TopLevelBlockRange,
): Range | null {
  if (!editor.isEditable || editor.isActive('codeBlock')) return null;

  if (blockRange) {
    const insertPosition = placement === 'above' ? blockRange.from : blockRange.to;
    const cursorPosition = insertPosition + 1;
    editor
      .chain()
      .focus()
      .insertContentAt(insertPosition, { type: 'paragraph' })
      .setTextSelection(cursorPosition)
      .run();

    return { from: cursorPosition, to: cursorPosition };
  }

  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  if (!textblockDepth) return null;

  const topLevelDepth = $from.depth >= 1 ? 1 : textblockDepth;
  const insertPosition = placement === 'above' ? $from.before(topLevelDepth) : $from.after(topLevelDepth);
  const cursorPosition = insertPosition + 1;
  editor
    .chain()
    .focus()
    .insertContentAt(insertPosition, { type: 'paragraph' })
    .setTextSelection(cursorPosition)
    .run();

  return { from: cursorPosition, to: cursorPosition };
}

function createCurrentBlockCommandTarget(editor: Editor, menuRange?: Range): Range | null {
  if (!editor.isEditable || editor.isActive('codeBlock')) return null;

  if (menuRange) {
    editor.chain().focus().setTextSelection(menuRange.from).run();
    return menuRange;
  }

  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  if (!textblockDepth) return null;

  const position = $from.start(textblockDepth);
  editor.chain().focus().setTextSelection(position).run();
  return { from: position, to: position };
}

function createBlockCommandMenuState(editor: Editor, range: Range): BlockCommandMenuState | null {
  try {
    const coords = editor.view.coordsAtPos(range.from);
    return {
      id: Date.now(),
      range,
      position: getSlashCommandMenuPosition(coords),
    };
  } catch {
    return null;
  }
}

function getBlockInsertButtonPosition(editor: Editor, container: HTMLDivElement): BlockControlPosition | null {
  if (!editor.isEditable || editor.isActive('codeBlock')) return null;

  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  if (!textblockDepth) return null;

  const blockRange = getTopLevelBlockRangeAt(editor, editor.state.selection.from);
  if (!blockRange) return null;

  const blockStart = $from.before(textblockDepth);
  const blockDom = editor.view.nodeDOM(blockStart);
  const containerRect = container.getBoundingClientRect();
  const menuPosition = $from.start(textblockDepth);
  const menuRange = { from: menuPosition, to: menuPosition };

  if (blockDom instanceof HTMLElement) {
    const blockRect = blockDom.getBoundingClientRect();
    return {
      blockRange,
      menuRange,
      top: Math.max(6, blockRect.top - containerRect.top + container.scrollTop + (blockRect.height / 2) - 12),
    };
  }

  const positionForCoords = Math.min(blockStart + 1, editor.state.doc.content.size);
  const coords = editor.view.coordsAtPos(positionForCoords);

  return {
    blockRange,
    menuRange,
    top: Math.max(6, coords.top - containerRect.top + container.scrollTop),
  };
}

function getBlockDropInsertPosition(
  editor: Editor,
  event: DragEvent,
  source: TopLevelBlockRange,
): number | null {
  const positionAtCoords = editor.view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });

  if (!positionAtCoords) {
    return editor.state.doc.content.size;
  }

  const target = getTopLevelBlockRangeAt(editor, positionAtCoords.pos);
  if (!target) {
    return editor.state.doc.content.size;
  }

  const targetDom = editor.view.nodeDOM(target.from);
  const targetRect = targetDom instanceof HTMLElement ? targetDom.getBoundingClientRect() : null;
  const insertPosition = targetRect
    ? event.clientY < targetRect.top + targetRect.height / 2
      ? target.from
      : target.to
    : positionAtCoords.pos <= target.from
      ? target.from
      : target.to;

  if (insertPosition >= source.from && insertPosition <= source.to) {
    return null;
  }

  return insertPosition;
}

function moveTopLevelBlock(editor: Editor, source: TopLevelBlockRange, insertPosition: number) {
  const sourceSize = source.to - source.from;
  const adjustedInsertPosition = insertPosition > source.from ? insertPosition - sourceSize : insertPosition;

  if (adjustedInsertPosition === source.from) return;

  const transaction = editor.state.tr
    .delete(source.from, source.to)
    .insert(adjustedInsertPosition, source.node)
    .scrollIntoView();

  editor.view.dispatch(transaction);
  editor.commands.focus();
}

function MarkdownBlockControls({
  editor,
  labels,
  onAddBlock,
  onOpenCommandMenu,
  scrollContainerRef,
}: {
  editor: Editor | null;
  labels: SlashCommandLabels;
  onAddBlock: (editor: Editor, placement: BlockInsertPlacement, blockRange: TopLevelBlockRange) => void;
  onOpenCommandMenu: (editor: Editor, menuRange: Range) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [position, setPosition] = useState<BlockControlPosition | null>(null);
  const dragStateRef = useRef<TopLevelBlockRange | null>(null);

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

  useEffect(() => {
    if (!editor) return;

    const editorElement = editor.view.dom;

    const handleDragOver = (event: DragEvent) => {
      if (!dragStateRef.current) return;

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    };

    const handleDrop = (event: DragEvent) => {
      const source = dragStateRef.current;
      dragStateRef.current = null;

      if (!source) return;

      event.preventDefault();
      event.stopPropagation();

      const insertPosition = getBlockDropInsertPosition(editor, event, source);
      if (insertPosition === null) return;

      moveTopLevelBlock(editor, source, insertPosition);
    };

    editorElement.addEventListener('dragover', handleDragOver);
    editorElement.addEventListener('drop', handleDrop);

    return () => {
      editorElement.removeEventListener('dragover', handleDragOver);
      editorElement.removeEventListener('drop', handleDrop);
    };
  }, [editor]);

  if (!editor?.isEditable || !position) return null;

  return (
    <div
      className="tiptap-block-controls absolute z-10 flex items-center gap-1 opacity-70 hover:opacity-100 focus-within:opacity-100"
      style={{ top: position.top }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={labels.addBlock}
            className="tiptap-block-control-button"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onAddBlock(editor, event.altKey ? 'above' : 'below', position.blockRange);
            }}
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex flex-col gap-1 text-left">
          <span>{labels.addBlockBelowHint}</span>
          <span>{labels.addBlockAboveHint}</span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={labels.openBlockMenuHint}
            className="tiptap-block-control-button tiptap-block-drag-handle"
            draggable
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenCommandMenu(editor, position.menuRange);
            }}
            onDragEnd={() => {
              dragStateRef.current = null;
            }}
            onDragStart={(event) => {
              const source = position.blockRange;
              if (!source || !event.dataTransfer) {
                event.preventDefault();
                return;
              }

              dragStateRef.current = source;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', 'canvas-editor-block');
            }}
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
          >
            <GripVertical />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex flex-col gap-1 text-left">
          <span>{labels.dragBlockHint}</span>
          <span>{labels.openBlockMenuHint}</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function MarkdownBlockCommandMenu({
  actions,
  editor,
  labels,
  menu,
  onClose,
}: {
  actions?: SlashCommandActions;
  editor: Editor;
  labels: SlashCommandLabels;
  menu: BlockCommandMenuState;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<SlashCommandListHandle>(null);
  const items = useMemo(() => getSlashCommandItems('', labels), [labels]);

  const runCommand = useCallback((item: SlashCommandItem) => {
    onClose();
    item.command({
      actions,
      editor,
      labels,
      range: menu.range,
    });
  }, [actions, editor, labels, menu.range, onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        editor.chain().focus().run();
        return;
      }

      if (listRef.current?.onKeyDown(event)) {
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [editor, onClose]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="tiptap-slash-menu"
      style={{
        left: menu.position.left,
        position: 'fixed',
        top: menu.position.top,
        width: menu.position.width,
      }}
    >
      <SlashCommandList
        ref={listRef}
        command={runCommand}
        items={items}
        labels={{ empty: labels.empty, group: labels.group }}
      />
    </div>
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
  const t = useTranslations('notebook');

  return (
    <TooltipProvider>
      <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-border bg-background px-2">
        <TooltipIconButton label={t('markdownEditorEditVisually')} onClick={onRichMode}>
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

type LinkPopoverState = {
  id: number;
  href: string;
  text: string;
  range: Range;
  position: {
    left: number;
    top: number;
    width: number;
  };
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

function isEditorRangeInsideCurrentDoc(editor: Editor, range: Range) {
  return (
    Number.isInteger(range.from) &&
    Number.isInteger(range.to) &&
    range.from >= 0 &&
    range.to >= range.from &&
    range.to <= editor.state.doc.content.size
  );
}

function getActiveLinkDetails(editor: Editor): Pick<LinkPopoverState, 'href' | 'text' | 'range'> | null {
  const linkMarkType = editor.schema.marks.link;
  if (!linkMarkType) return null;

  const { selection } = editor.state;
  let range = getMarkRange(selection.$from, linkMarkType);
  if (!range && selection.empty && selection.from > 0) {
    range = getMarkRange(editor.state.doc.resolve(selection.from - 1), linkMarkType);
  }

  if (!range || !isEditorRangeInsideCurrentDoc(editor, range)) return null;

  let href = typeof editor.getAttributes('link').href === 'string'
    ? (editor.getAttributes('link').href as string)
    : '';

  if (!href) {
    editor.state.doc.nodesBetween(range.from, range.to, (node) => {
      const linkMark = node.marks.find((mark) => mark.type === linkMarkType && typeof mark.attrs.href === 'string');
      if (!linkMark) return true;

      href = linkMark.attrs.href as string;
      return false;
    });
  }

  if (!href) return null;

  return {
    href,
    text: editor.state.doc.textBetween(range.from, range.to, ' '),
    range,
  };
}

function getEditorRangeRect(editor: Editor, range: Range) {
  if (!isEditorRangeInsideCurrentDoc(editor, range)) return null;

  try {
    const start = editor.view.coordsAtPos(range.from);
    const end = editor.view.coordsAtPos(range.to);
    return {
      left: Math.min(start.left, end.left),
      right: Math.max(start.right, end.right),
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom),
    };
  } catch {
    return null;
  }
}

function getLinkPopoverPosition(rect: Pick<DOMRect, 'bottom' | 'left' | 'top'>) {
  const width = 344;
  const height = 148;
  const padding = 8;
  const left = Math.max(padding, Math.min(rect.left, window.innerWidth - width - padding));
  const opensBelow = rect.bottom + height + padding <= window.innerHeight;
  const top = opensBelow
    ? rect.bottom + 8
    : Math.max(padding, rect.top - height - 8);

  return {
    left,
    top,
    width,
  };
}

function getLinkPreviewInsertPosition(editor: Editor) {
  const { selection, schema } = editor.state;
  if (!selection.empty) return selection.to;

  const linkRange = getMarkRange(selection.$from, schema.marks.link);
  return linkRange?.to ?? selection.to;
}

function createLinkPreviewImageContent(imageUrl: string, label: string): JSONContent {
  return {
    type: 'image',
    attrs: {
      src: imageUrl,
      alt: makeLinkPreviewImageAlt(label),
    },
  };
}

function findAdjacentLinkPreviewImageRange(editor: Editor, from: number): Range | null {
  if (!isEditorPositionInsideDoc(editor, from)) return null;

  const { doc } = editor.state;
  const $from = doc.resolve(from);
  const parent = $from.parent;
  const parentStart = $from.start();
  const parentEnd = $from.end();
  let whitespaceStart: number | null = null;
  let offset = 0;

  for (let index = 0; index < parent.childCount; index += 1) {
    const child = parent.child(index);
    const childStart = parentStart + offset;
    const childEnd = childStart + child.nodeSize;
    offset += child.nodeSize;

    if (childEnd <= from) continue;
    if (childStart >= parentEnd) break;

    if (child.isText) {
      const text = child.text ?? '';
      const textOffset = Math.max(0, from - childStart);
      const trailingText = text.slice(textOffset);

      if (!trailingText) continue;
      if (trailingText.trim().length > 0) return null;

      whitespaceStart ??= childStart + textOffset;
      continue;
    }

    if (child.type.name === 'image' && parseLinkPreviewImageAlt(child.attrs.alt)) {
      return {
        from: whitespaceStart ?? childStart,
        to: childEnd,
      };
    }

    return null;
  }

  return null;
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
          throw new Error(t('markdownEditorLinkPreviewError'));
        }

        setPreviewState({
          status: 'loaded',
          imageUrl: payload.data?.imageUrl ?? null,
          host: payload.data?.host ?? new URL(previewUrl).hostname,
        });
      } catch {
        if (controller.signal.aborted) return;
        setPreviewState({
          status: 'error',
          error: t('markdownEditorLinkPreviewError'),
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

    const previewImage = previewEnabled && previewState.status === 'loaded' && previewState.imageUrl
      ? createLinkPreviewImageContent(previewState.imageUrl, previewState.host)
      : null;

    if (editor.isActive('link') || !editor.state.selection.empty) {
      const insertPosition = getLinkPreviewInsertPosition(editor);
      const existingPreviewRange = findAdjacentLinkPreviewImageRange(editor, insertPosition);
      const previewInsertPosition = existingPreviewRange?.from ?? insertPosition;
      const previewContent: JSONContent[] = [{ type: 'text', text: ' ' }];

      if (previewImage) {
        previewContent.push(previewImage);
      }

      const chain = editor.chain().focus().extendMarkRange('link').setLink({ href: normalizedHref });

      if (existingPreviewRange) {
        chain.deleteRange(existingPreviewRange);
      }

      if (previewImage) {
        chain.insertContentAt(previewInsertPosition, previewContent);
      }

      chain.run();
    } else {
      const content: JSONContent[] = [
        {
          type: 'text',
          text: text.trim() || normalizedHref,
          marks: [{ type: 'link', attrs: { href: normalizedHref } }],
        },
      ];

      if (previewImage) {
        content.push({ type: 'text', text: ' ' }, previewImage);
      }

      editor.chain().focus().insertContent(content).run();
    }

    onOpenChange(false);
  }, [editor, href, onOpenChange, previewEnabled, previewState, text]);

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

function MarkdownLinkPopover({
  editor,
  state,
  onClose,
  onEdit,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  state: LinkPopoverState | null;
  onClose: () => void;
  onEdit: (state: LinkPopoverState) => void;
}) {
  const t = useTranslations('notebook');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) return;
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, state]);

  const openLink = useCallback(() => {
    if (!state?.href) return;
    const openedWindow = window.open(state.href, '_blank', 'noopener,noreferrer');
    if (openedWindow) openedWindow.opener = null;
  }, [state]);

  const copyLink = useCallback(() => {
    if (!state?.href) return;
    copyTextToClipboard(state.href);
  }, [state]);

  const removeLink = useCallback(() => {
    if (!editor || !state || !isEditorRangeInsideCurrentDoc(editor, state.range)) {
      onClose();
      return;
    }

    editor.chain().focus().setTextSelection(state.range).unsetLink().run();
    onClose();
  }, [editor, onClose, state]);

  if (!state) return null;

  return (
    <div
      ref={containerRef}
      className="fixed z-50 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg"
      style={{
        left: state.position.left,
        top: state.position.top,
        width: state.position.width,
      }}
      role="dialog"
      aria-label={t('markdownEditorLinkMenu')}
    >
      <div className="truncate px-1 pb-2 text-xs text-muted-foreground" title={state.href}>
        {state.href}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="sm" onClick={openLink}>
          <ExternalLink />
          {t('markdownEditorLinkOpen')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onEdit(state)}>
          <Pencil />
          {t('markdownEditorLinkEdit')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={copyLink}>
          <Copy />
          {t('markdownEditorLinkCopy')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={removeLink}>
          <Unlink />
          {t('markdownEditorLinkRemove')}
        </Button>
      </div>
    </div>
  );
}

type ImportedMarkdownImageResult = {
  markdownSrc: string;
  name: string;
};

type MarkdownImageImportResponse = {
  success?: boolean;
  files?: ImportedMarkdownImageResult[];
  error?: string;
};

function isRemoteImageImportSource(value: string) {
  return /^https?:\/\//iu.test(value);
}

function directMarkdownImageSrc(value: string, filePath?: string) {
  const source = value.trim();
  if (!source.startsWith('/')) return source;
  return markdownImageSrcForWorkspacePath(source.slice(1), filePath);
}

function insertMarkdownImagesIntoEditor(
  editor: Editor,
  images: ImportedMarkdownImageResult[],
  alt: string,
  range?: Range,
) {
  const content = images
    .filter((image) => image.markdownSrc)
    .map<JSONContent>((image) => ({
      type: 'image',
      attrs: {
        alt: alt.trim() || image.name,
        src: image.markdownSrc,
      },
    }));

  if (content.length === 0) return;

  const chain = editor.chain().focus();
  const safeRange = range ? clampEditorRangeToDoc(editor, range) : null;

  if (safeRange) {
    if (safeRange.from < safeRange.to) {
      chain.deleteRange(safeRange);
    }
    chain.insertContentAt(safeRange.from, content).run();
    return;
  }

  chain.insertContent(content).run();
}

function MarkdownImageDialog({
  editor,
  filePath,
  open,
  onOpenChange,
  range,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  filePath?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  range?: Range;
}) {
  const t = useTranslations('notebook');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'upload' | 'url'>('upload');
  const [source, setSource] = useState('');
  const [alt, setAlt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!editor || submitting) return;

    setError(null);

    try {
      if (mode === 'url') {
        const trimmedSource = source.trim();
        if (!trimmedSource) {
          setError(t('markdownEditorImageSourceRequired'));
          return;
        }

        if (!isRemoteImageImportSource(trimmedSource)) {
          insertMarkdownImagesIntoEditor(
            editor,
            [{ markdownSrc: directMarkdownImageSrc(trimmedSource, filePath), name: trimmedSource.split('/').pop() || 'image' }],
            alt,
            range,
          );
          onOpenChange(false);
          return;
        }
      } else if (!fileInputRef.current?.files?.length) {
        setError(t('markdownEditorImageNoFile'));
        return;
      }

      setSubmitting(true);
      const formData = new FormData();
      formData.set('targetDir', getWorkspaceTargetDirForMarkdown(filePath));
      if (filePath) formData.set('markdownPath', filePath);

      if (mode === 'upload') {
        Array.from(fileInputRef.current?.files || []).forEach((file) => {
          formData.append('files', file);
        });
      } else {
        formData.set('url', source.trim());
      }

      const response = await fetch('/api/markdown/images/import', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => null) as MarkdownImageImportResponse | null;

      if (!response.ok || !payload?.success || !payload.files?.length) {
        throw new Error(payload?.error || t('markdownEditorImageImportError'));
      }

      insertMarkdownImagesIntoEditor(editor, payload.files, alt, range);
      onOpenChange(false);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : t('markdownEditorImageImportError'));
    } finally {
      setSubmitting(false);
    }
  }, [alt, editor, filePath, mode, onOpenChange, range, source, submitting, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('markdownEditorImageDialogTitle')}</DialogTitle>
          <DialogDescription>{t('markdownEditorImageDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Tabs value={mode} onValueChange={(value) => setMode(value as 'upload' | 'url')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="upload">{t('markdownEditorImageTabUpload')}</TabsTrigger>
              <TabsTrigger value="url">{t('markdownEditorImageTabUrl')}</TabsTrigger>
            </TabsList>
            <TabsContent value="upload" className="mt-4">
              <div className="grid gap-2">
                <Label htmlFor="markdown-image-upload">{t('markdownEditorImageUploadLabel')}</Label>
                <Input
                  id="markdown-image-upload"
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={submitting}
                />
                <p className="text-xs text-muted-foreground">{t('markdownEditorImageUploadHint')}</p>
              </div>
            </TabsContent>
            <TabsContent value="url" className="mt-4">
              <div className="grid gap-2">
                <Label htmlFor="markdown-image-source">{t('markdownEditorImageUrlLabel')}</Label>
                <Input
                  id="markdown-image-source"
                  value={source}
                  disabled={submitting}
                  placeholder={t('markdownEditorImageUrlPlaceholder')}
                  onChange={(event) => setSource(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('markdownEditorImageUrlHint')}</p>
              </div>
            </TabsContent>
          </Tabs>

          <div className="grid gap-2">
            <Label htmlFor="markdown-image-alt">{t('markdownEditorImageAltLabel')}</Label>
            <Input
              id="markdown-image-alt"
              value={alt}
              disabled={submitting}
              placeholder={t('markdownEditorImageAltPlaceholder')}
              onChange={(event) => setAlt(event.target.value)}
            />
          </div>

          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? t('markdownEditorImageImporting') : t('markdownEditorImageInsert')}
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
  filePath,
  imageDialogSeed,
  imageDialogOpen,
  onSourceMode,
  onImageDialogOpenChange,
  onOpenTableDialog,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  filePath?: string;
  imageDialogSeed: ImageDialogSeed;
  imageDialogOpen: boolean;
  onSourceMode: () => void;
  onImageDialogOpenChange: (open: boolean) => void;
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
  const [linkPopover, setLinkPopover] = useState<LinkPopoverState | null>(null);
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

  const closeLinkPopover = useCallback(() => {
    setLinkPopover(null);
  }, []);

  const handleLinkDialogOpenChange = useCallback((open: boolean) => {
    setLinkDialogOpen(open);
    if (open) setLinkPopover(null);
  }, []);

  const openToolbarLinkDialog = useCallback(() => {
    if (!editor) return;
    const activeLink = getActiveLinkDetails(editor);
    setLinkDialogSeed((current) => ({
      id: current.id + 1,
      href: activeLink?.href || (editor.getAttributes('link').href as string | undefined) || '',
      text: activeLink?.text || getSelectedText(editor),
      canEditText: editor.state.selection.empty && !activeLink,
    }));
    handleLinkDialogOpenChange(true);
  }, [editor, handleLinkDialogOpenChange]);

  const openLinkPopoverFromSelection = useCallback(() => {
    if (!editor || linkDialogOpen) return;

    const activeLink = getActiveLinkDetails(editor);
    const rect = activeLink ? getEditorRangeRect(editor, activeLink.range) : null;
    if (!activeLink || !rect) {
      setLinkPopover(null);
      return;
    }

    setLinkPopover((current) => ({
      id: (current?.id ?? 0) + 1,
      ...activeLink,
      position: getLinkPopoverPosition(rect),
    }));
  }, [editor, linkDialogOpen]);

  const editLinkFromPopover = useCallback((state: LinkPopoverState) => {
    if (!editor || !isEditorRangeInsideCurrentDoc(editor, state.range)) return;

    editor.chain().focus().setTextSelection(state.range).run();
    setLinkDialogSeed((current) => ({
      id: current.id + 1,
      href: state.href,
      text: state.text,
      canEditText: false,
    }));
    handleLinkDialogOpenChange(true);
  }, [editor, handleLinkDialogOpenChange]);

  useEffect(() => {
    if (!editor) return;

    const editorElement = editor.view.dom;

    const handleEditorClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest('a[href]');
      if (!anchor || !editorElement.contains(anchor)) return;

      event.preventDefault();
      event.stopPropagation();

      const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!position) return;

      editor.chain().focus().setTextSelection(position.pos).run();
      window.requestAnimationFrame(openLinkPopoverFromSelection);
    };

    const handleSelectionUpdate = () => {
      if (!editor.isActive('link')) setLinkPopover(null);
    };

    editorElement.addEventListener('click', handleEditorClick);
    editor.on('selectionUpdate', handleSelectionUpdate);

    return () => {
      editorElement.removeEventListener('click', handleEditorClick);
      editor.off('selectionUpdate', handleSelectionUpdate);
    };
  }, [editor, openLinkPopoverFromSelection]);

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

        <TooltipIconButton
          label="Link"
          active={toolbarState.isLink}
          disabled={!canUseCommands}
          onClick={openToolbarLinkDialog}
        >
          <LinkIcon />
        </TooltipIconButton>
        <TooltipIconButton
          label={t('markdownEditorImageDialogTitle')}
          disabled={!canUseCommands}
          onClick={() => onImageDialogOpenChange(true)}
        >
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
          <TooltipIconButton label={t('markdownEditorEditAsText')} onClick={onSourceMode}>
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
      <MarkdownLinkPopover
        editor={editor}
        state={editor ? linkPopover : null}
        onClose={closeLinkPopover}
        onEdit={editLinkFromPopover}
      />
      <MarkdownLinkDialog
        key={linkDialogSeed.id}
        editor={editor}
        open={linkDialogOpen}
        onOpenChange={handleLinkDialogOpenChange}
        initialHref={linkDialogSeed.href}
        initialText={linkDialogSeed.text}
        canEditText={linkDialogSeed.canEditText}
      />
      <MarkdownImageDialog
        key={imageDialogSeed.id}
        editor={editor}
        filePath={filePath}
        open={imageDialogOpen}
        onOpenChange={onImageDialogOpenChange}
        range={imageDialogSeed.range}
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
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [imageDialogSeed, setImageDialogSeed] = useState<ImageDialogSeed>({ id: 0 });
  const [blockCommandMenu, setBlockCommandMenu] = useState<BlockCommandMenuState | null>(null);
  const labels = useMemo(() => createSlashCommandLabels(t), [t]);
  const openImageDialogFromToolbar = useCallback((open: boolean) => {
    if (open) {
      setImageDialogSeed((current) => ({ id: current.id + 1 }));
    }
    setImageDialogOpen(open);
  }, []);
  const openImageDialogFromSlash = useCallback((slashEditor: Editor, range: Range) => {
    const safeRange = clampEditorRangeToDoc(slashEditor, range);
    const insertPosition = safeRange?.from ?? slashEditor.state.selection.from;

    if (safeRange && safeRange.from !== safeRange.to) {
      slashEditor.chain().focus().deleteRange(safeRange).run();
    } else {
      slashEditor.chain().focus().setTextSelection(insertPosition).run();
    }

    setImageDialogSeed((current) => ({
      id: current.id + 1,
      range: { from: insertPosition, to: insertPosition },
    }));
    setImageDialogOpen(true);
  }, []);
  const openTableDialogFromSlash = useCallback((slashEditor: Editor, range: Range) => {
    const safeRange = clampEditorRangeToDoc(slashEditor, range);

    if (safeRange && safeRange.from !== safeRange.to) {
      slashEditor.chain().focus().deleteRange(safeRange).run();
    } else if (safeRange) {
      slashEditor.chain().focus().setTextSelection(safeRange.from).run();
    }

    setTableDialogOpen(true);
  }, []);
  const slashCommandActions = useMemo<SlashCommandActions>(
    () => ({
      openImageDialog: openImageDialogFromSlash,
      openTableDialog: openTableDialogFromSlash,
    }),
    [openImageDialogFromSlash, openTableDialogFromSlash],
  );
  const extensions = useMemo(
    () => createEditorExtensions(filePath, labels, slashCommandActions),
    [filePath, labels, slashCommandActions],
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

  const closeBlockCommandMenu = useCallback(() => {
    setBlockCommandMenu(null);
  }, []);

  const openBlockCommandMenuAtRange = useCallback((blockEditor: Editor, range: Range) => {
    window.requestAnimationFrame(() => {
      const menuState = createBlockCommandMenuState(blockEditor, range);
      if (menuState) {
        setBlockCommandMenu(menuState);
      }
    });
  }, []);

  const openInsertedBlockCommandMenu = useCallback((
    blockEditor: Editor,
    placement: BlockInsertPlacement,
    blockRange?: TopLevelBlockRange,
  ) => {
    const range = createInsertedBlockCommandTarget(blockEditor, placement, blockRange);
    if (!range) return;

    openBlockCommandMenuAtRange(blockEditor, range);
  }, [openBlockCommandMenuAtRange]);

  const openCurrentBlockCommandMenu = useCallback((blockEditor: Editor, menuRange?: Range) => {
    const range = createCurrentBlockCommandTarget(blockEditor, menuRange);
    if (!range) return;

    openBlockCommandMenuAtRange(blockEditor, range);
  }, [openBlockCommandMenuAtRange]);

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

  useEffect(() => {
    if (!editor || readOnly) return undefined;

    const editorElement = editor.view.dom;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== '/') return;

      event.preventDefault();
      event.stopPropagation();
      openCurrentBlockCommandMenu(editor);
    };

    editorElement.addEventListener('keydown', handleKeyDown, true);
    return () => editorElement.removeEventListener('keydown', handleKeyDown, true);
  }, [editor, openCurrentBlockCommandMenu, readOnly]);

  useEffect(() => {
    if (!readOnly) return undefined;

    const frame = window.requestAnimationFrame(() => {
      setBlockCommandMenu(null);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [readOnly]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {!readOnly ? (
        <MarkdownToolbar
          editor={markdownEditor}
          filePath={filePath}
          imageDialogOpen={imageDialogOpen}
          imageDialogSeed={imageDialogSeed}
          onSourceMode={onSourceMode}
          onImageDialogOpenChange={openImageDialogFromToolbar}
          onOpenTableDialog={() => setTableDialogOpen(true)}
        />
      ) : null}
      {!readOnly ? (
        <MarkdownTableDialog open={tableDialogOpen} onOpenChange={setTableDialogOpen} onInsert={insertTable} />
      ) : null}
      <div ref={scrollContainerRef} className="relative min-h-0 flex-1 overflow-auto">
        {!readOnly ? (
          <TooltipProvider>
            <MarkdownBlockControls
              editor={editor}
              labels={labels}
              onAddBlock={openInsertedBlockCommandMenu}
              onOpenCommandMenu={openCurrentBlockCommandMenu}
              scrollContainerRef={scrollContainerRef}
            />
          </TooltipProvider>
        ) : null}
        <EditorContent editor={editor} className="tiptap-editor-shell" />
        {!readOnly && editor && blockCommandMenu ? (
          <MarkdownBlockCommandMenu
            key={blockCommandMenu.id}
            actions={slashCommandActions}
            editor={editor}
            labels={labels}
            menu={blockCommandMenu}
            onClose={closeBlockCommandMenu}
          />
        ) : null}
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
