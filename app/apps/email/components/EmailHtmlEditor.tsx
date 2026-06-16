'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import {
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from 'lucide-react';

import { emailEditorHtmlToText, sanitizeEmailEditorHtml } from '@/app/lib/email/html-editor-content';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type EmailHtmlEditorProps = {
  disabled?: boolean;
  id?: string;
  onChange?: (value: { html: string; text: string }) => void;
  placeholder?: string;
  value: string;
};

type ToolbarState = {
  canRedo: boolean;
  canUndo: boolean;
  isBlockquote: boolean;
  isBold: boolean;
  isBulletList: boolean;
  isItalic: boolean;
  isLink: boolean;
  isOrderedList: boolean;
  isStrike: boolean;
};

const EMPTY_TOOLBAR_STATE: ToolbarState = {
  canRedo: false,
  canUndo: false,
  isBlockquote: false,
  isBold: false,
  isBulletList: false,
  isItalic: false,
  isLink: false,
  isOrderedList: false,
  isStrike: false,
};

function normalizeEmailLinkUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^(https?:|mailto:)/iu.test(trimmed)) return trimmed;
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/iu.test(trimmed)) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

function emailEditorText(html: string): string {
  return emailEditorHtmlToText(html);
}

function createEmailEditorExtensions() {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
    }),
    Link.configure({
      autolink: false,
      defaultProtocol: 'https',
      HTMLAttributes: {
        rel: 'noopener noreferrer',
        target: '_blank',
      },
      linkOnPaste: true,
      openOnClick: false,
    }),
  ];
}

function TooltipIconButton({
  active = false,
  children,
  disabled = false,
  label,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
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

function EmailHtmlToolbar({ disabled, editor }: { disabled: boolean; editor: Editor | null }) {
  const canUseCommands = Boolean(editor?.isEditable) && !disabled;
  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      if (!currentEditor) return EMPTY_TOOLBAR_STATE;

      return {
        canRedo: currentEditor.can().redo(),
        canUndo: currentEditor.can().undo(),
        isBlockquote: currentEditor.isActive('blockquote'),
        isBold: currentEditor.isActive('bold'),
        isBulletList: currentEditor.isActive('bulletList'),
        isItalic: currentEditor.isActive('italic'),
        isLink: currentEditor.isActive('link'),
        isOrderedList: currentEditor.isActive('orderedList'),
        isStrike: currentEditor.isActive('strike'),
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
    const rawUrl = window.prompt('URL', previousUrl || 'https://');
    if (rawUrl === null) return;

    const url = normalizeEmailLinkUrl(rawUrl);
    if (!url) {
      editor.chain().focus().unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
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
      </div>
    </TooltipProvider>
  );
}

export function EmailHtmlEditor({
  disabled = false,
  id,
  onChange,
  placeholder,
  value,
}: EmailHtmlEditorProps) {
  const extensions = useMemo(() => createEmailEditorExtensions(), []);
  const [initialValue] = useState(() => sanitizeEmailEditorHtml(value));
  const latestValueRef = useRef(initialValue);
  const applyingExternalValueRef = useRef(false);
  const isEmpty = !emailEditorText(value);

  const editor = useEditor({
    content: initialValue || '<p></p>',
    editable: !disabled,
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        ...(placeholder ? { 'aria-label': placeholder } : {}),
      },
    },
    extensions,
    immediatelyRender: false,
    onUpdate: ({ editor: updateEditor }) => {
      if (disabled || applyingExternalValueRef.current) return;

      const html = sanitizeEmailEditorHtml(updateEditor.isEmpty ? '' : updateEditor.getHTML());
      if (html === latestValueRef.current) return;
      latestValueRef.current = html;
      onChange?.({ html, text: emailEditorText(html) });
    },
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    const sanitizedValue = sanitizeEmailEditorHtml(value);
    latestValueRef.current = sanitizedValue;
    if (!editor) return;

    const currentValue = sanitizeEmailEditorHtml(editor.isEmpty ? '' : editor.getHTML());
    if (currentValue === sanitizedValue) return;

    applyingExternalValueRef.current = true;
    editor.commands.setContent(sanitizedValue || '<p></p>', { emitUpdate: false });
    applyingExternalValueRef.current = false;
  }, [editor, value]);

  return (
    <div
      className={cn(
        'flex min-h-52 flex-col overflow-hidden border border-input bg-background',
        disabled && 'opacity-70',
      )}
    >
      <EmailHtmlToolbar disabled={disabled} editor={editor} />
      <div className="relative min-h-0 flex-1">
        {isEmpty && placeholder ? (
          <div className="pointer-events-none absolute left-3 top-3 text-sm text-muted-foreground">
            {placeholder}
          </div>
        ) : null}
        <EditorContent editor={editor} className="email-html-editor-shell min-h-52" />
      </div>
    </div>
  );
}
