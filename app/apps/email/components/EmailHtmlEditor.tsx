'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { TableKit } from '@tiptap/extension-table';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Columns3,
  Italic,
  Image as ImageIcon,
  Link as LinkIcon,
  List,
  ListOrdered,
  Plus,
  Quote,
  Redo2,
  Rows3,
  Strikethrough,
  Table2,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { emailEditorHtmlToText, sanitizeEmailEditorHtml } from '@/app/lib/email/html-editor-content';
import {
  EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
  emailAttachmentLimitUsageBytes,
  type EmailAttachmentDraft,
} from '@/app/lib/email/attachment-types';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type EmailHtmlEditorProps = {
  attachments?: EmailAttachmentDraft[];
  disabled?: boolean;
  id?: string;
  onChange?: (value: { html: string; text: string }) => void;
  onAttachmentsChange?: (attachments: EmailAttachmentDraft[]) => void;
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
  isTable: boolean;
  cellAlign: 'left' | 'center' | 'right' | null;
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
  isTable: false,
  cellAlign: null,
};

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

type EmailImageUploadResponse = {
  success?: boolean;
  files?: EmailAttachmentDraft[];
  error?: string;
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

function getSelectedText(editor: Editor) {
  const { from, to, empty } = editor.state.selection;
  if (empty) return '';
  return editor.state.doc.textBetween(from, to, ' ');
}

function getActiveTableCellAlign(editor: Editor): ToolbarState['cellAlign'] {
  const align = (
    editor.getAttributes('tableCell').align ||
    editor.getAttributes('tableHeader').align ||
    null
  ) as string | null;

  return align === 'left' || align === 'center' || align === 'right' ? align : null;
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
    Image.configure({
      allowBase64: false,
    }),
    TableKit.configure({
      table: {
        resizable: false,
        HTMLAttributes: {
          border: '1',
          cellpadding: '6',
          cellspacing: '0',
        },
      },
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

function EmailLinkDialog({
  editor,
  open,
  onOpenChange,
  initialHref,
  initialText,
  canEditText,
}: {
  editor: Editor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialHref: string;
  initialText: string;
  canEditText: boolean;
}) {
  const t = useTranslations('emails');
  const [href, setHref] = useState(initialHref);
  const [text, setText] = useState(initialText);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [previewState, setPreviewState] = useState<LinkPreviewState>({ status: 'idle' });
  const linkActive = Boolean(editor?.isActive('link'));

  useEffect(() => {
    if (!open || !previewEnabled) return;

    const previewUrl = normalizeEmailLinkUrl(href);
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
          throw new Error(t('editorLinkPreviewError'));
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
          error: t('editorLinkPreviewError'),
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

    const url = normalizeEmailLinkUrl(href);
    if (!url) {
      editor.chain().focus().unsetLink().run();
      onOpenChange(false);
      return;
    }

    if (editor.isActive('link') || !editor.state.selection.empty) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    } else {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: text.trim() || url,
          marks: [{ type: 'link', attrs: { href: url } }],
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
          <DialogTitle>{t('editorLinkDialogTitle')}</DialogTitle>
          <DialogDescription>{t('editorLinkDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email-editor-link-url">{t('editorLinkUrl')}</Label>
            <Input
              id="email-editor-link-url"
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
              <Label htmlFor="email-editor-link-text">{t('editorLinkText')}</Label>
              <Input
                id="email-editor-link-text"
                value={text}
                placeholder={t('editorLinkTextPlaceholder')}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="email-editor-link-preview-toggle">{t('editorLinkPreviewToggle')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('editorLinkPreviewHint')}</p>
            </div>
            <Switch
              id="email-editor-link-preview-toggle"
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
                  {t('editorLinkPreviewLoading')}
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
                      <div className="truncate text-xs text-muted-foreground">{t('editorLinkPreviewImageLoaded')}</div>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-16 items-center text-sm text-muted-foreground">
                    {t('editorLinkPreviewNoImage')}
                  </div>
                )
              ) : null}

              {previewState.status === 'error' ? (
                <div className="flex h-16 items-center text-sm text-destructive">{previewState.error}</div>
              ) : null}

              {previewState.status === 'idle' ? (
                <div className="flex h-16 items-center text-sm text-muted-foreground">
                  {t('editorLinkPreviewIdle')}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {linkActive ? (
            <Button type="button" variant="outline" onClick={removeLink}>
              {t('editorLinkRemove')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('composeCancel')}
          </Button>
          <Button type="button" onClick={applyLink}>
            {t('editorLinkApply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function createInlineContentId(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || 'image';
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${base}.${random}@canvas-inline`;
}

function insertInlineImages(editor: Editor, attachments: EmailAttachmentDraft[], alt: string) {
  const content = attachments
    .filter((attachment) => attachment.contentId)
    .map((attachment) => ({
      type: 'image',
      attrs: {
        alt: alt.trim() || attachment.name,
        src: `cid:${attachment.contentId}`,
      },
    }));

  if (content.length === 0) return;
  editor.chain().focus().insertContent(content).run();
}

function EmailImageDialog({
  attachments,
  editor,
  onAttachmentsChange,
  open,
  onOpenChange,
}: {
  attachments: EmailAttachmentDraft[];
  editor: Editor | null;
  onAttachmentsChange?: (attachments: EmailAttachmentDraft[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('emails');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'upload' | 'url'>('upload');
  const [source, setSource] = useState('');
  const [alt, setAlt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!editor || !onAttachmentsChange || submitting) return;

    setError(null);

    const formData = new FormData();
    if (mode === 'upload') {
      const files = Array.from(fileInputRef.current?.files || []);
      if (files.length === 0) {
        setError(t('editorImageNoFile'));
        return;
      }
      files.forEach((file) => formData.append('files', file));
    } else {
      const trimmedSource = source.trim();
      if (!trimmedSource) {
        setError(t('editorImageSourceRequired'));
        return;
      }
      formData.set('url', trimmedSource);
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/email/attachments/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => null) as EmailImageUploadResponse | null;

      if (!response.ok || !payload?.success || !payload.files?.length) {
        throw new Error(payload?.error || t('editorImageImportError'));
      }

      const inlineAttachments = payload.files
        .filter((attachment) => attachment.mimeType.toLowerCase().startsWith('image/'))
        .map((attachment) => ({
          ...attachment,
          contentId: createInlineContentId(attachment.name),
          disposition: 'inline' as const,
        }));

      if (inlineAttachments.length === 0) {
        throw new Error(t('editorImageImportError'));
      }

      if (emailAttachmentLimitUsageBytes([...attachments, ...inlineAttachments]) > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
        throw new Error(t('attachmentsLimitExceeded'));
      }

      onAttachmentsChange([...attachments, ...inlineAttachments]);
      insertInlineImages(editor, inlineAttachments, alt);
      onOpenChange(false);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('editorImageImportError'));
    } finally {
      setSubmitting(false);
    }
  }, [alt, attachments, editor, mode, onAttachmentsChange, onOpenChange, source, submitting, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('editorImageDialogTitle')}</DialogTitle>
          <DialogDescription>{t('editorImageDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Tabs value={mode} onValueChange={(value) => setMode(value as 'upload' | 'url')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="upload">{t('editorImageTabUpload')}</TabsTrigger>
              <TabsTrigger value="url">{t('editorImageTabUrl')}</TabsTrigger>
            </TabsList>
            <TabsContent value="upload" className="mt-4">
              <div className="grid gap-2">
                <Label htmlFor="email-editor-image-upload">{t('editorImageUploadLabel')}</Label>
                <Input
                  id="email-editor-image-upload"
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={submitting}
                />
              </div>
            </TabsContent>
            <TabsContent value="url" className="mt-4">
              <div className="grid gap-2">
                <Label htmlFor="email-editor-image-source">{t('editorImageUrlLabel')}</Label>
                <Input
                  id="email-editor-image-source"
                  value={source}
                  disabled={submitting}
                  placeholder="https://example.com/image.png"
                  onChange={(event) => setSource(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
              </div>
            </TabsContent>
          </Tabs>

          <div className="grid gap-2">
            <Label htmlFor="email-editor-image-alt">{t('editorImageAltLabel')}</Label>
            <Input
              id="email-editor-image-alt"
              value={alt}
              disabled={submitting}
              placeholder={t('editorImageAltPlaceholder')}
              onChange={(event) => setAlt(event.target.value)}
            />
          </div>

          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t('composeCancel')}
          </Button>
          <Button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? t('editorImageImporting') : t('editorImageInsert')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmailTableDialog({
  open,
  onOpenChange,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (options: TableInsertOptions) => void;
}) {
  const t = useTranslations('emails');
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
          <DialogTitle>{t('editorTableDialogTitle')}</DialogTitle>
          <DialogDescription>{t('editorTableDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="email-editor-table-rows">{t('editorTableRows')}</Label>
              <Input
                id="email-editor-table-rows"
                type="number"
                min={1}
                max={20}
                value={rows}
                onChange={(event) => setRows(Number(event.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email-editor-table-cols">{t('editorTableColumns')}</Label>
              <Input
                id="email-editor-table-cols"
                type="number"
                min={1}
                max={12}
                value={cols}
                onChange={(event) => setCols(Number(event.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <Label htmlFor="email-editor-table-header-row">{t('editorTableHeaderRow')}</Label>
            <Switch
              id="email-editor-table-header-row"
              checked={withHeaderRow}
              onCheckedChange={setWithHeaderRow}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('composeCancel')}
          </Button>
          <Button type="button" onClick={submit}>
            {t('editorTableInsert')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmailHtmlToolbar({
  attachments,
  disabled,
  editor,
  onAttachmentsChange,
}: {
  attachments: EmailAttachmentDraft[];
  disabled: boolean;
  editor: Editor | null;
  onAttachmentsChange?: (attachments: EmailAttachmentDraft[]) => void;
}) {
  const t = useTranslations('emails');
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [linkDialogSeed, setLinkDialogSeed] = useState<LinkDialogSeed>({
    id: 0,
    href: '',
    text: '',
    canEditText: true,
  });
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

  const insertTable = useCallback((options: TableInsertOptions) => {
    editor?.chain().focus().insertTable(options).run();
    setTableDialogOpen(false);
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
        <TooltipIconButton
          label={t('editorImageDialogTitle')}
          disabled={!canUseCommands || !onAttachmentsChange}
          onClick={() => setImageDialogOpen(true)}
        >
          <ImageIcon />
        </TooltipIconButton>
        <TooltipIconButton
          label={t('editorTableInsert')}
          disabled={!canUseCommands}
          onClick={() => setTableDialogOpen(true)}
        >
          <Table2 />
        </TooltipIconButton>
      </div>
      {toolbarState.isTable ? (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2">
          <span className="mr-1 shrink-0 text-xs font-medium text-muted-foreground">
            {t('editorTableTools')}
          </span>
          <TooltipIconButton
            label={t('editorTableAddColumnBefore')}
            disabled={!canUseCommands || !editor?.can().addColumnBefore()}
            onClick={() => editor?.chain().focus().addColumnBefore().run()}
          >
            <Columns3 />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('editorTableAddColumnAfter')}
            disabled={!canUseCommands || !editor?.can().addColumnAfter()}
            onClick={() => editor?.chain().focus().addColumnAfter().run()}
          >
            <Plus />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('editorTableDeleteColumn')}
            disabled={!canUseCommands || !editor?.can().deleteColumn()}
            onClick={() => editor?.chain().focus().deleteColumn().run()}
          >
            <Trash2 />
          </TooltipIconButton>

          <ToolbarDivider />

          <TooltipIconButton
            label={t('editorTableAddRowBefore')}
            disabled={!canUseCommands || !editor?.can().addRowBefore()}
            onClick={() => editor?.chain().focus().addRowBefore().run()}
          >
            <Rows3 />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('editorTableAddRowAfter')}
            disabled={!canUseCommands || !editor?.can().addRowAfter()}
            onClick={() => editor?.chain().focus().addRowAfter().run()}
          >
            <Plus />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('editorTableDeleteRow')}
            disabled={!canUseCommands || !editor?.can().deleteRow()}
            onClick={() => editor?.chain().focus().deleteRow().run()}
          >
            <Trash2 />
          </TooltipIconButton>

          <ToolbarDivider />

          <TooltipIconButton
            label={t('editorTableToggleHeaderRow')}
            disabled={!canUseCommands || !editor?.can().toggleHeaderRow()}
            onClick={() => editor?.chain().focus().toggleHeaderRow().run()}
          >
            <Table2 />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('editorTableAlignLeft')}
            active={toolbarState.cellAlign === 'left'}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().setCellAttribute('align', 'left').run()}
          >
            <AlignLeft />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('editorTableAlignCenter')}
            active={toolbarState.cellAlign === 'center'}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().setCellAttribute('align', 'center').run()}
          >
            <AlignCenter />
          </TooltipIconButton>
          <TooltipIconButton
            label={t('editorTableAlignRight')}
            active={toolbarState.cellAlign === 'right'}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().setCellAttribute('align', 'right').run()}
          >
            <AlignRight />
          </TooltipIconButton>

          <ToolbarDivider />

          <TooltipIconButton
            label={t('editorTableDelete')}
            disabled={!canUseCommands || !editor?.can().deleteTable()}
            onClick={() => editor?.chain().focus().deleteTable().run()}
          >
            <Trash2 />
          </TooltipIconButton>
        </div>
      ) : null}
      <EmailLinkDialog
        key={linkDialogSeed.id}
        editor={editor}
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        initialHref={linkDialogSeed.href}
        initialText={linkDialogSeed.text}
        canEditText={linkDialogSeed.canEditText}
      />
      <EmailImageDialog
        attachments={attachments}
        editor={editor}
        onAttachmentsChange={onAttachmentsChange}
        open={imageDialogOpen}
        onOpenChange={setImageDialogOpen}
      />
      <EmailTableDialog open={tableDialogOpen} onOpenChange={setTableDialogOpen} onInsert={insertTable} />
    </TooltipProvider>
  );
}

export function EmailHtmlEditor({
  attachments = [],
  disabled = false,
  id,
  onAttachmentsChange,
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
      <EmailHtmlToolbar
        attachments={attachments}
        disabled={disabled}
        editor={editor}
        onAttachmentsChange={onAttachmentsChange}
      />
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
