'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Link } from '@tiptap/extension-link';
import { Image } from '@tiptap/extension-image';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { CodeBlock } from '@tiptap/extension-code-block';
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
  Strikethrough,
  Table2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
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

const FRONTMATTER_REGEX = /^---\s*\n[\s\S]*?\n---(?:\s*\n|$)/;

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
          label="Bold"
          active={editor?.isActive('bold')}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold />
        </TooltipIconButton>
        <TooltipIconButton
          label="Italic"
          active={editor?.isActive('italic')}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic />
        </TooltipIconButton>
        <TooltipIconButton
          label="Strike"
          active={editor?.isActive('strike')}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <Strikethrough />
        </TooltipIconButton>
        <TooltipIconButton
          label="Inline code"
          active={editor?.isActive('code')}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleCode().run()}
        >
          <Code />
        </TooltipIconButton>

        <ToolbarDivider />

        <TooltipIconButton
          label="Heading 1"
          active={editor?.isActive('heading', { level: 1 })}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 />
        </TooltipIconButton>
        <TooltipIconButton
          label="Heading 2"
          active={editor?.isActive('heading', { level: 2 })}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 />
        </TooltipIconButton>
        <TooltipIconButton
          label="Heading 3"
          active={editor?.isActive('heading', { level: 3 })}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 />
        </TooltipIconButton>

        <ToolbarDivider />

        <TooltipIconButton
          label="Bullet list"
          active={editor?.isActive('bulletList')}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List />
        </TooltipIconButton>
        <TooltipIconButton
          label="Ordered list"
          active={editor?.isActive('orderedList')}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered />
        </TooltipIconButton>
        <TooltipIconButton
          label="Task list"
          active={editor?.isActive('taskList')}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
        >
          <ListChecks />
        </TooltipIconButton>
        <TooltipIconButton
          label="Quote"
          active={editor?.isActive('blockquote')}
          disabled={!canUseCommands}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote />
        </TooltipIconButton>

        <ToolbarDivider />

        <TooltipIconButton label="Link" active={editor?.isActive('link')} disabled={!canUseCommands} onClick={setLink}>
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
          active={editor?.isActive('codeBlock')}
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
