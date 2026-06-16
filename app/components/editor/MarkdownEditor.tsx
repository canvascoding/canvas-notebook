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
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  Bold,
  Code,
  Code2,
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
  Quote,
  Redo2,
  Strikethrough,
  Table2,
  Type,
  Undo2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
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
};

type SlashCommandContext = {
  editor: Editor;
  range: Range;
};

type SlashCommandItem = {
  title: string;
  description: string;
  keywords: string[];
  Icon: React.ComponentType;
  command: (context: SlashCommandContext) => void;
};

type SlashCommandListHandle = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type SlashCommandListProps = SuggestionProps<SlashCommandItem, SlashCommandItem>;

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

const SLASH_COMMAND_ITEMS: SlashCommandItem[] = [
  {
    title: 'Text',
    description: 'Plain paragraph',
    keywords: ['paragraph', 'plain'],
    Icon: Type,
    command: (context) => runAfterSlashDelete(context).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    description: 'Large section heading',
    keywords: ['h1', 'title'],
    Icon: Heading1,
    command: (context) => runAfterSlashDelete(context).setNode('heading', { level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    description: 'Medium section heading',
    keywords: ['h2', 'subtitle'],
    Icon: Heading2,
    command: (context) => runAfterSlashDelete(context).setNode('heading', { level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    description: 'Small section heading',
    keywords: ['h3'],
    Icon: Heading3,
    command: (context) => runAfterSlashDelete(context).setNode('heading', { level: 3 }).run(),
  },
  {
    title: 'Bullet list',
    description: 'Unordered list',
    keywords: ['ul', 'list'],
    Icon: List,
    command: (context) => runAfterSlashDelete(context).toggleBulletList().run(),
  },
  {
    title: 'Numbered list',
    description: 'Ordered list',
    keywords: ['ol', 'ordered'],
    Icon: ListOrdered,
    command: (context) => runAfterSlashDelete(context).toggleOrderedList().run(),
  },
  {
    title: 'Task list',
    description: 'Checklist',
    keywords: ['todo', 'checklist'],
    Icon: ListChecks,
    command: (context) => runAfterSlashDelete(context).toggleTaskList().run(),
  },
  {
    title: 'Quote',
    description: 'Blockquote',
    keywords: ['blockquote', 'citation'],
    Icon: Quote,
    command: (context) => runAfterSlashDelete(context).toggleBlockquote().run(),
  },
  {
    title: 'Code block',
    description: 'Fenced code block',
    keywords: ['pre', 'fence'],
    Icon: Code2,
    command: (context) => runAfterSlashDelete(context).setCodeBlock().run(),
  },
  {
    title: 'Table',
    description: '3 x 3 table',
    keywords: ['grid'],
    Icon: Table2,
    command: (context) => runAfterSlashDelete(context).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    title: 'Image',
    description: 'Image by URL or workspace path',
    keywords: ['photo', 'picture'],
    Icon: ImageIcon,
    command: ({ editor, range }) => {
      const src = window.prompt('Image URL or workspace path');
      if (!src?.trim()) {
        editor.chain().focus().deleteRange(range).run();
        return;
      }

      const alt = window.prompt('Alt text') || '';
      editor.chain().focus().deleteRange(range).setImage({ src: src.trim(), alt: alt.trim() }).run();
    },
  },
  {
    title: 'Divider',
    description: 'Horizontal rule',
    keywords: ['hr', 'separator', 'line'],
    Icon: Minus,
    command: (context) => runAfterSlashDelete(context).setHorizontalRule().run(),
  },
  {
    title: 'Bold',
    description: 'Bold text from here',
    keywords: ['strong'],
    Icon: Bold,
    command: (context) => runAfterSlashDelete(context).toggleBold().run(),
  },
  {
    title: 'Italic',
    description: 'Italic text from here',
    keywords: ['emphasis'],
    Icon: Italic,
    command: (context) => runAfterSlashDelete(context).toggleItalic().run(),
  },
  {
    title: 'Strike',
    description: 'Strikethrough text from here',
    keywords: ['delete', 'cross'],
    Icon: Strikethrough,
    command: (context) => runAfterSlashDelete(context).toggleStrike().run(),
  },
  {
    title: 'Inline code',
    description: 'Inline code from here',
    keywords: ['monospace'],
    Icon: Code,
    command: (context) => runAfterSlashDelete(context).toggleCode().run(),
  },
];

function getSlashCommandItems(query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return SLASH_COMMAND_ITEMS.slice(0, 10);
  }

  return SLASH_COMMAND_ITEMS
    .filter((item) => {
      const searchableText = [item.title, item.description, ...item.keywords].join(' ').toLowerCase();
      return searchableText.includes(normalizedQuery);
    })
    .slice(0, 10);
}

const SlashCommandList = React.forwardRef<SlashCommandListHandle, SlashCommandListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const activeIndex = items.length ? selectedIndex % items.length : 0;

    const selectItem = useCallback((index: number) => {
      const item = items[index];
      if (!item) return;
      command(item);
    }, [command, items]);

    const selectPrevious = useCallback(() => {
      setSelectedIndex((currentIndex) => (currentIndex + items.length - 1) % items.length);
    }, [items.length]);

    const selectNext = useCallback(() => {
      setSelectedIndex((currentIndex) => (currentIndex + 1) % items.length);
    }, [items.length]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (!items.length) return false;

        if (event.key === 'ArrowUp') {
          selectPrevious();
          return true;
        }

        if (event.key === 'ArrowDown') {
          selectNext();
          return true;
        }

        if (event.key === 'Enter') {
          selectItem(activeIndex);
          return true;
        }

        return false;
      },
    }), [activeIndex, items.length, selectItem, selectNext, selectPrevious]);

    return (
      <Command className="w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-lg" shouldFilter={false}>
        <CommandList className="max-h-72">
          <CommandEmpty>No command found.</CommandEmpty>
          <CommandGroup heading="Markdown">
            {items.map((item, index) => (
              <CommandItem
                key={item.title}
                value={item.title}
                data-selected={index === activeIndex ? 'true' : undefined}
                onMouseEnter={() => setSelectedIndex(index)}
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

function updateSlashCommandPosition(element: HTMLElement, props: SlashCommandListProps) {
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

const SlashCommands = Extension.create({
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
        items: ({ query }) => getSlashCommandItems(query),
        allow: ({ editor, range }) => {
          if (!editor.isEditable || editor.isActive('codeBlock')) return false;

          const $from = editor.state.doc.resolve(range.from);
          return $from.parent.type.name === 'paragraph';
        },
        command: ({ editor, range, props }) => {
          props.command({ editor, range });
        },
        render: () => {
          let component: ReactRenderer<SlashCommandListHandle, SlashCommandListProps> | null = null;

          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashCommandList, {
                props,
                editor: props.editor,
              });

              component.element.classList.add('tiptap-slash-menu');
              document.body.appendChild(component.element);
              updateSlashCommandPosition(component.element, props);
            },
            onUpdate: (props) => {
              component?.updateProps(props);

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

function createEditorExtensions(filePath?: string) {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: false,
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
    SlashCommands,
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

function MarkdownToolbar({
  editor,
  onSourceMode,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  onSourceMode: () => void;
}) {
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
      };
    },
  }) ?? EMPTY_TOOLBAR_STATE;

  const setLink = useCallback(() => {
    if (!editor) return;

    if (editor.isActive('link')) {
      editor.chain().focus().unsetLink().run();
      return;
    }

    const previousUrl = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('URL', previousUrl || 'https://');
    if (url === null) return;

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      editor.chain().focus().unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: trimmedUrl }).run();
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
          label="Table"
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
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
  const latestValueRef = useRef(value);
  const applyingExternalValueRef = useRef(false);
  const extensions = useMemo(() => createEditorExtensions(filePath), [filePath]);

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
      {!readOnly ? <MarkdownToolbar editor={markdownEditor} onSourceMode={onSourceMode} /> : null}
      <div className="min-h-0 flex-1 overflow-auto">
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
