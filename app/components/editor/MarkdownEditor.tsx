'use client';

import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Extension, getMarkRange, type Editor, type JSONContent, type Range } from '@tiptap/core';
import katex from 'katex';
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
import { Link } from '@tiptap/extension-link';
import { Mathematics } from '@tiptap/extension-mathematics';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AtSign,
  Bold,
  BadgeInfo,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Code,
  Code2,
  Columns3,
  Copy,
  Eye,
  ExternalLink,
  FileText,
  Globe2,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Keyboard,
  Link as LinkIcon,
  Layers,
  List,
  ListChecks,
  ListCollapse,
  ListOrdered,
  Minus,
  MoreHorizontal,
  Plus,
  Pencil,
  Quote,
  Redo2,
  Rows3,
  Search,
  Sigma,
  SmilePlus,
  SquareSigma,
  Strikethrough,
  Superscript,
  Table2,
  Trash2,
  Type,
  Undo2,
  Unlink,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
import { MarkdownRenderer } from '@/app/components/shared/MarkdownRenderer';
import {
  clampEditorRangeToDoc,
  getSlashCommandDeletionRange,
  isEditorRangeInsideDoc,
  isEditorPositionInsideDoc,
} from '@/app/lib/editor/prosemirror-ranges';
import { getMarkdownDocumentStats } from '@/app/lib/editor/markdown-document-stats';
import { filterCanvasEmoji } from '@/app/lib/editor/emoji-catalog';
import {
  clearMarkdownSearch,
  getMarkdownSearchState,
  MarkdownSearchExtension,
  moveMarkdownSearchSelection,
  selectMarkdownSearchMatch,
  setMarkdownSearchQuery,
  type MarkdownSearchState,
} from '@/app/lib/editor/markdown-search';
import {
  hasMobileToolbarPressMoved,
  isMobileToolbarReleaseInside,
} from '@/app/lib/editor/mobile-toolbar-gesture';
import {
  createCurrentBlockCommandTarget,
  createInsertedBlockCommandTarget,
  getBlockDropIndicatorTop,
  getBlockDropTarget,
  getBlockInsertButtonPosition,
  getBlockOverlayRect,
  hasCanvasBlockDragData,
  moveReorderableBlock,
  setCanvasBlockDragData,
  type BlockControlPosition,
  type BlockDropTarget,
  type BlockInsertPlacement,
  type BlockOverlayRect,
  type ReorderableBlockRange,
} from '@/app/lib/editor/reorderable-blocks';
import { createInlineColorRegex, isColorCode } from '@/app/lib/markdown/color-code';
import { CANVAS_KATEX_OPTIONS } from '@/app/lib/markdown/canvas-markdown';
import { createCanvasMarkdownExtension } from '@/app/lib/markdown/canvas-marked';
import { canvasRichMarkdownExtensions } from '@/app/lib/markdown/canvas-rich-markdown-extensions';
import {
  createMarkdownHeadingAnchorFactory,
  markdownHeadingAnchorFromHref,
  scrollToMarkdownHeadingAnchor,
} from '@/app/lib/markdown/heading-anchor';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { MarkdownHeadingAnchors } from '@/app/lib/markdown/tiptap-heading-anchors';
import {
  buildObsidianWikiLinkTarget,
  findObsidianWikiCompletionContext,
  getWorkspaceMarkdownNavigationTarget,
} from '@/app/lib/markdown/obsidian-link-resolver';
import {
  composeCanvasMarkdownDocument,
  parseCanvasMarkdownDocument,
  splitCanvasMarkdownForRichEditor,
} from '@/app/lib/markdown/obsidian-metadata';
import {
  analyzeMarkdownRichMode,
  restoreRichMarkdownFinalLineEnding,
  type MarkdownRichModeReason,
} from '@/app/lib/markdown/rich-markdown-codec';
import { getMarkdownSourceModeNotice } from '@/app/lib/markdown/source-mode-notice';
import { openWorkspaceMarkdownTarget } from '@/app/lib/markdown/workspace-markdown-navigation-client';
import {
  getWorkspaceWikiCompletionItems,
  loadWorkspaceLinkIndex,
} from '@/app/lib/markdown/workspace-link-index-client';
import type { WorkspaceLinkIndex } from '@/app/lib/markdown/workspace-link-index-core';
import {
  consumeWorkspaceMarkdownLocation,
  getWorkspaceMarkdownLocationFromEvent,
  WORKSPACE_MARKDOWN_LOCATION_EVENT,
  type WorkspaceMarkdownLocation,
} from '@/app/lib/markdown/workspace-markdown-navigation';
import { makeLinkPreviewImageAlt, parseLinkPreviewImageAlt } from '@/app/lib/markdown/link-preview-markdown';
import { getActiveWorkspaceWikiLink } from '@/app/lib/markdown/tiptap-workspace-link';
import {
  getWorkspaceTargetDirForMarkdown,
  markdownImageSrcForWorkspacePath,
} from '@/app/lib/markdown/markdown-image-path';
import { resolveMarkdownImageUrl } from '@/app/lib/markdown/markdown-image-url';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cn } from '@/lib/utils';

import { CodeEditor } from './CodeEditorClient';
import { MarkdownBacklinksPanel } from './MarkdownBacklinksPanel';
import { createMarkdownMentionSuggestions } from './MarkdownMentionSuggestions';
import { MarkdownOutlinePanel } from './MarkdownOutlinePanel';
import { MarkdownPropertiesPanel } from './MarkdownPropertiesPanel';
import {
  createObsidianWikiLinkExtensions,
  createObsidianWikiLinkNode,
} from './ObsidianWikiLinkExtension';
import { ObsidianInlineFootnoteExtension } from './ObsidianInlineFootnoteExtension';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import {
  useCollaborationDocument,
  useTextCollaborationSession,
  type CollaborationDocument,
} from '@/app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '@/app/lib/collaboration/types';
import {
  createAgentTargetDecorationExtension,
  updateAgentTargetDecorations,
  type CollaborationAgentTargetAnchor,
} from '@/app/lib/collaboration/agent-target-decorations';

export interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  filePath?: string;
  externalValueSync?: 'always' | 'when-blurred';
  collaborationEnabled?: boolean;
  collaborationSession?: CollaborationSessionResponse | null;
  onCollaborationChange?: (document: CollaborationDocument | null) => void;
  agentTargets?: CollaborationAgentTargetAnchor[];
  showNotebookMetadata?: boolean;
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
  isHighlight: boolean;
  isCode: boolean;
  isHeading1: boolean;
  isHeading2: boolean;
  isHeading3: boolean;
  isBulletList: boolean;
  isOrderedList: boolean;
  isTaskList: boolean;
  isBlockquote: boolean;
  isCallout: boolean;
  isDetails: boolean;
  isLink: boolean;
  isCodeBlock: boolean;
  isTable: boolean;
  cellAlign: 'left' | 'center' | 'right' | null;
};

type SlashCommandActions = {
  editMath?: (kind: 'inline' | 'block', latex: string, pos: number) => void;
  openRichBlockDialog?: (kind: RichBlockKind, editor: Editor, range: Range) => void;
  openEmojiDialog?: (editor: Editor, range: Range) => void;
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
  | 'callout'
  | 'details'
  | 'footnote'
  | 'codeBlock'
  | 'inlineMath'
  | 'blockMath'
  | 'table'
  | 'image'
  | 'emoji'
  | 'mention'
  | 'divider'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'highlight'
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

type ImageDialogSeed = {
  id: number;
  range?: Range;
};

type EmojiDialogSeed = {
  id: number;
  range?: Range;
};

type RichBlockKind = 'callout' | 'details' | 'footnote' | 'inlineMath' | 'blockMath';

type RichBlockDialogSeed = {
  id: number;
  kind: RichBlockKind;
  range?: Range;
  footnoteId?: string;
  nodePosition?: number;
  initialCalloutType?: string;
  initialContent?: string;
  initialTitle?: string;
  initialLatex?: string;
  initialOpen?: boolean;
};

type RichBlockDialogSubmission =
  | { kind: 'callout'; title: string; calloutType: string; content: string }
  | { kind: 'details'; title: string; content: string; open: boolean }
  | { kind: 'footnote'; content: string }
  | { kind: 'inlineMath' | 'blockMath'; latex: string };

type ColorSwatchWidgetHost = HTMLSpanElement & {
  colorSwatchRoot?: Root;
};

const EMPTY_TOOLBAR_STATE: ToolbarState = {
  canUndo: false,
  canRedo: false,
  isBold: false,
  isItalic: false,
  isStrike: false,
  isHighlight: false,
  isCode: false,
  isHeading1: false,
  isHeading2: false,
  isHeading3: false,
  isBulletList: false,
  isOrderedList: false,
  isTaskList: false,
  isBlockquote: false,
  isCallout: false,
  isDetails: false,
  isLink: false,
  isCodeBlock: false,
  isTable: false,
  cellAlign: null,
};

const SLASH_COMMAND_PLUGIN_KEY = new PluginKey('markdownSlashCommands');
const COLOR_SWATCH_PLUGIN_KEY = new PluginKey('markdownColorSwatches');
const CANVAS_BLOCK_DRAG_DROP_GUARD_PLUGIN_KEY = new PluginKey('canvasBlockDragDropGuard');
const MOBILE_KEYBOARD_RECHECK_DELAYS_MS = [60, 180, 360, 720];
const MOBILE_TOOLBAR_INTERACTION_GRACE_MS = 1_000;

function shouldDefaultToSource(readOnly: boolean, filePath?: string) {
  if (readOnly) return false;
  if (filePath && /\.mdx$/i.test(filePath)) return true;
  return false;
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

function getMarkdownToolbarState(editor: Editor | null): ToolbarState {
  if (!editor || editor.isDestroyed) return EMPTY_TOOLBAR_STATE;
  const availableCommands = editor.can() as ReturnType<Editor['can']> & {
    undo?: () => boolean;
    redo?: () => boolean;
  };

  return {
    canUndo: availableCommands.undo?.() ?? false,
    canRedo: availableCommands.redo?.() ?? false,
    isBold: editor.isActive('bold'),
    isItalic: editor.isActive('italic'),
    isStrike: editor.isActive('strike'),
    isHighlight: editor.isActive('canvasHighlight'),
    isCode: editor.isActive('code'),
    isHeading1: editor.isActive('heading', { level: 1 }),
    isHeading2: editor.isActive('heading', { level: 2 }),
    isHeading3: editor.isActive('heading', { level: 3 }),
    isBulletList: editor.isActive('bulletList'),
    isOrderedList: editor.isActive('orderedList'),
    isTaskList: editor.isActive('taskList'),
    isBlockquote: editor.isActive('blockquote'),
    isCallout: editor.isActive('canvasCallout'),
    isDetails: editor.isActive('canvasDetails'),
    isLink: editor.isActive('link') || editor.isActive('obsidianWikiLink'),
    isCodeBlock: editor.isActive('codeBlock'),
    isTable: editor.isActive('table'),
    cellAlign: getActiveTableCellAlign(editor),
  };
}

function useMarkdownToolbarState(editor: MarkdownEditorWithMarkdown | null) {
  return useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => getMarkdownToolbarState(currentEditor),
  }) ?? EMPTY_TOOLBAR_STATE;
}

function useVisualViewportBottomOffset() {
  useEffect(() => {
    const updateViewportOffset = () => {
      const viewport = window.visualViewport;
      const bottomOffset = viewport
        // On iOS, offsetTop can change when Safari scrolls a focused contenteditable
        // caret into view. Tying the toolbar to that value makes it drift downward
        // as the document scrolls, so only use the keyboard-induced height loss.
        ? Math.max(0, window.innerHeight - viewport.height)
        : 0;

      document.documentElement.style.setProperty(
        '--canvas-visual-viewport-bottom-offset',
        `${Math.round(bottomOffset)}px`,
      );
    };
    let recheckFrame: number | null = null;
    let recheckTimeouts: number[] = [];

    const clearScheduledRechecks = () => {
      if (recheckFrame !== null) {
        window.cancelAnimationFrame(recheckFrame);
        recheckFrame = null;
      }
      recheckTimeouts.forEach((timeout) => window.clearTimeout(timeout));
      recheckTimeouts = [];
    };

    const scheduleViewportOffsetRechecks = () => {
      clearScheduledRechecks();
      updateViewportOffset();
      recheckFrame = window.requestAnimationFrame(() => {
        recheckFrame = null;
        updateViewportOffset();
      });
      recheckTimeouts = MOBILE_KEYBOARD_RECHECK_DELAYS_MS.map((delay) => (
        window.setTimeout(updateViewportOffset, delay)
      ));
    };

    const visualViewport = window.visualViewport;

    updateViewportOffset();
    window.addEventListener('focusin', scheduleViewportOffsetRechecks);
    window.addEventListener('focusout', scheduleViewportOffsetRechecks);
    window.addEventListener('resize', scheduleViewportOffsetRechecks);
    visualViewport?.addEventListener('resize', updateViewportOffset);
    visualViewport?.addEventListener('scroll', updateViewportOffset);

    return () => {
      clearScheduledRechecks();
      window.removeEventListener('focusin', scheduleViewportOffsetRechecks);
      window.removeEventListener('focusout', scheduleViewportOffsetRechecks);
      window.removeEventListener('resize', scheduleViewportOffsetRechecks);
      visualViewport?.removeEventListener('resize', updateViewportOffset);
      visualViewport?.removeEventListener('scroll', updateViewportOffset);
      document.documentElement.style.removeProperty('--canvas-visual-viewport-bottom-offset');
    };
  }, []);
}

function useMobileKeyboardActive() {
  const [isKeyboardActive, setIsKeyboardActive] = useState(false);
  const largestViewportHeightRef = useRef(0);
  const viewportWidthRef = useRef(0);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px), (hover: none) and (pointer: coarse)');

    const updateKeyboardState = () => {
      const viewport = window.visualViewport;
      const viewportWidth = Math.round(viewport?.width ?? window.innerWidth);
      const viewportHeight = Math.round(viewport?.height ?? window.innerHeight);
      const widthChanged = viewportWidthRef.current > 0 && Math.abs(viewportWidth - viewportWidthRef.current) > 80;

      if (viewportWidthRef.current === 0 || widthChanged) {
        viewportWidthRef.current = viewportWidth;
        largestViewportHeightRef.current = Math.max(viewportHeight, window.innerHeight);
      } else {
        largestViewportHeightRef.current = Math.max(
          largestViewportHeightRef.current,
          viewportHeight,
          window.innerHeight,
        );
      }

      const viewportHeightLoss = Math.max(0, largestViewportHeightRef.current - viewportHeight);
      const bottomOffset = viewport
        ? Math.max(0, window.innerHeight - viewport.height)
        : 0;
      const keyboardOffset = Math.max(viewportHeightLoss, bottomOffset);

      setIsKeyboardActive(mediaQuery.matches && keyboardOffset >= 80);
    };
    let recheckFrame: number | null = null;
    let recheckTimeouts: number[] = [];

    const clearScheduledRechecks = () => {
      if (recheckFrame !== null) {
        window.cancelAnimationFrame(recheckFrame);
        recheckFrame = null;
      }
      recheckTimeouts.forEach((timeout) => window.clearTimeout(timeout));
      recheckTimeouts = [];
    };

    const scheduleKeyboardStateRechecks = () => {
      clearScheduledRechecks();
      updateKeyboardState();
      recheckFrame = window.requestAnimationFrame(() => {
        recheckFrame = null;
        updateKeyboardState();
      });
      recheckTimeouts = MOBILE_KEYBOARD_RECHECK_DELAYS_MS.map((delay) => (
        window.setTimeout(updateKeyboardState, delay)
      ));
    };

    const visualViewport = window.visualViewport;

    updateKeyboardState();
    window.addEventListener('focusin', scheduleKeyboardStateRechecks);
    window.addEventListener('focusout', scheduleKeyboardStateRechecks);
    window.addEventListener('resize', scheduleKeyboardStateRechecks);
    window.addEventListener('orientationchange', scheduleKeyboardStateRechecks);
    visualViewport?.addEventListener('resize', updateKeyboardState);
    visualViewport?.addEventListener('scroll', updateKeyboardState);
    mediaQuery.addEventListener('change', scheduleKeyboardStateRechecks);

    return () => {
      clearScheduledRechecks();
      window.removeEventListener('focusin', scheduleKeyboardStateRechecks);
      window.removeEventListener('focusout', scheduleKeyboardStateRechecks);
      window.removeEventListener('resize', scheduleKeyboardStateRechecks);
      window.removeEventListener('orientationchange', scheduleKeyboardStateRechecks);
      visualViewport?.removeEventListener('resize', updateKeyboardState);
      visualViewport?.removeEventListener('scroll', updateKeyboardState);
      mediaQuery.removeEventListener('change', scheduleKeyboardStateRechecks);
    };
  }, []);

  return isKeyboardActive;
}

function getBodyPortalElement() {
  return typeof document === 'undefined' ? null : document.body;
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
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse') {
              event.preventDefault();
            }
          }}
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

type ToolbarDropdownTriggerProps = {
  active?: boolean;
  children: React.ReactNode;
  label: string;
  testId?: string;
} & Omit<React.ComponentPropsWithoutRef<typeof Button>, 'aria-label' | 'children' | 'size' | 'type' | 'variant'>;

const ToolbarDropdownTrigger = React.forwardRef<HTMLButtonElement, ToolbarDropdownTriggerProps>(function ToolbarDropdownTrigger({
  active = false,
  children,
  className,
  disabled = false,
  label,
  testId,
  ...triggerProps
}, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      className={cn('h-7 shrink-0 gap-1.5 px-2 text-xs font-medium', className)}
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      {...triggerProps}
    >
      {children}
      <ChevronDown className="size-3.5 text-muted-foreground" />
    </Button>
  );
});

ToolbarDropdownTrigger.displayName = 'ToolbarDropdownTrigger';

function ToolbarDropdownItem({
  active = false,
  disabled = false,
  Icon,
  label,
  onSelect,
}: {
  active?: boolean;
  disabled?: boolean;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      className={cn('min-w-48', active && 'bg-accent text-accent-foreground')}
      disabled={disabled}
      onSelect={onSelect}
    >
      <Icon className="size-4" />
      <span>{label}</span>
      {active ? <Check className="ml-auto size-3.5" /> : null}
    </DropdownMenuItem>
  );
}

function MarkdownDocumentStatus({
  onSearch,
  searchActive = false,
  value,
}: {
  onSearch?: () => void;
  searchActive?: boolean;
  value: string;
}) {
  const t = useTranslations('notebook');
  const stats = useMemo(() => getMarkdownDocumentStats(value), [value]);

  return (
    <div
      className="flex h-7 shrink-0 items-center justify-end gap-2 border-t border-border bg-background px-2 text-[11px] text-muted-foreground"
      role="status"
      aria-label={t('markdownEditorDocumentStatistics')}
    >
      {onSearch ? (
        <Button
          type="button"
          variant={searchActive ? 'secondary' : 'ghost'}
          size="xs"
          className="mr-auto"
          aria-label={t('markdownEditorFind')}
          aria-pressed={searchActive}
          onClick={onSearch}
        >
          <Search />
          <span>{t('markdownEditorFind')}</span>
        </Button>
      ) : null}
      <span>{t('markdownEditorWords', { count: stats.words })}</span>
      <span aria-hidden="true">·</span>
      <span>{t('markdownEditorCharacters', { count: stats.characters })}</span>
    </div>
  );
}

function MarkdownFindBar({
  editor,
  onOpenChange,
  open,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const t = useTranslations('notebook');
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<MarkdownSearchState>({
    currentIndex: -1,
    matches: [],
    query: '',
  });

  const syncSearchState = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    setSearch(getMarkdownSearchState(editor));
  }, [editor]);

  useEffect(() => {
    if (!editor) return undefined;
    editor.on('transaction', syncSearchState);
    return () => {
      editor.off('transaction', syncSearchState);
    };
  }, [editor, syncSearchState]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (open) {
      const nextSearch = setMarkdownSearchQuery(editor, queryRef.current);
      setSearch(nextSearch.matches.length > 0
        ? selectMarkdownSearchMatch(editor, nextSearch.currentIndex)
        : nextSearch);
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return;
    }
    clearMarkdownSearch(editor);
  }, [editor, open]);

  const updateQuery = useCallback((nextQuery: string) => {
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    if (editor && !editor.isDestroyed) {
      const nextSearch = setMarkdownSearchQuery(editor, nextQuery);
      setSearch(nextSearch.matches.length > 0
        ? selectMarkdownSearchMatch(editor, nextSearch.currentIndex)
        : nextSearch);
    }
  }, [editor]);

  const moveSelection = useCallback((delta: number) => {
    if (!editor || editor.isDestroyed) return;
    setSearch(moveMarkdownSearchSelection(editor, delta));
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [editor]);

  if (!open) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2 py-1.5"
      role="search"
      data-testid="markdown-find-bar"
    >
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input
        ref={inputRef}
        className="h-7 min-w-0 flex-1 md:max-w-sm"
        value={query}
        placeholder={t('markdownEditorFindPlaceholder')}
        aria-label={t('markdownEditorFind')}
        onChange={(event) => updateQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            moveSelection(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onOpenChange(false);
            editor?.commands.focus();
          }
        }}
      />
      <span
        className="min-w-14 text-center text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {search.matches.length > 0
          ? t('markdownEditorFindPosition', {
            current: search.currentIndex + 1,
            total: search.matches.length,
          })
          : t('markdownEditorFindNoMatches')}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('markdownEditorFindPrevious')}
        disabled={search.matches.length === 0}
        onClick={() => moveSelection(-1)}
      >
        <ChevronUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('markdownEditorFindNext')}
        disabled={search.matches.length === 0}
        onClick={() => moveSelection(1)}
      >
        <ChevronDown />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('markdownEditorFindClose')}
        onClick={() => onOpenChange(false)}
      >
        <X />
      </Button>
    </div>
  );
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
  const host = node as ColorSwatchWidgetHost;
  const root = host.colorSwatchRoot;
  if (!root) return;

  host.colorSwatchRoot = undefined;
  queueMicrotask(() => root.unmount());
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

const CanvasBlockDragDropGuard = Extension.create({
  name: 'canvasBlockDragDropGuard',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: CANVAS_BLOCK_DRAG_DROP_GUARD_PLUGIN_KEY,
        props: {
          handleDrop(_view, event) {
            if (!hasCanvasBlockDragData(event.dataTransfer)) return false;

            event.preventDefault();
            return true;
          },
          handlePaste(_view, event) {
            if (!hasCanvasBlockDragData(event.clipboardData)) return false;

            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});

function runAfterSlashDelete({ editor, range }: SlashCommandContext) {
  const chain = editor.chain().focus();
  if (!isEditorRangeInsideDoc(editor, range)) {
    return chain;
  }

  if (range.from === range.to) {
    return chain.setTextSelection(range.from);
  }

  const slashRange = getSlashCommandDeletionRange(editor, range);
  return slashRange ? chain.deleteRange(slashRange) : chain.setTextSelection(range.from);
}

function prepareCommandDialogInsertionRange(editor: Editor, range: Range): Range | null {
  if (!isEditorRangeInsideDoc(editor, range)) {
    return null;
  }

  const slashRange = getSlashCommandDeletionRange(editor, range);
  const chain = editor.chain().focus();

  if (slashRange) {
    chain.deleteRange(slashRange).run();
  } else {
    chain.setTextSelection(range.from).run();
  }

  return clampEditorRangeToDoc(editor, {
    from: editor.state.selection.from,
    to: editor.state.selection.to,
  });
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
    id: 'callout',
    keywords: ['note', 'warning', 'admonition', 'info'],
    Icon: BadgeInfo,
    command: (context) => {
      if (context.actions?.openRichBlockDialog) {
        context.actions.openRichBlockDialog('callout', context.editor, context.range);
        return;
      }

      runAfterSlashDelete(context).insertCanvasCallout({
        title: context.labels.items.callout.title,
        type: 'note',
      }).run();
    },
  },
  {
    id: 'details',
    keywords: ['collapse', 'toggle', 'summary', 'expand'],
    Icon: ListCollapse,
    command: (context) => {
      if (context.actions?.openRichBlockDialog) {
        context.actions.openRichBlockDialog('details', context.editor, context.range);
        return;
      }

      runAfterSlashDelete(context).insertCanvasDetails({
        summary: context.labels.items.details.title,
      }).run();
    },
  },
  {
    id: 'footnote',
    keywords: ['reference', 'citation', 'annotation'],
    Icon: Superscript,
    command: (context) => {
      if (context.actions?.openRichBlockDialog) {
        context.actions.openRichBlockDialog('footnote', context.editor, context.range);
        return;
      }

      runAfterSlashDelete(context).insertMarkdownFootnote().run();
    },
  },
  {
    id: 'codeBlock',
    keywords: ['pre', 'fence'],
    Icon: Code2,
    command: (context) => runAfterSlashDelete(context).setCodeBlock().run(),
  },
  {
    id: 'inlineMath',
    keywords: ['latex', 'katex', 'formula', 'equation'],
    Icon: Sigma,
    command: (context) => {
      if (context.actions?.openRichBlockDialog) {
        context.actions.openRichBlockDialog('inlineMath', context.editor, context.range);
        return;
      }

      runAfterSlashDelete(context).run();
    },
  },
  {
    id: 'blockMath',
    keywords: ['latex', 'katex', 'formula', 'equation', 'display'],
    Icon: SquareSigma,
    command: (context) => {
      if (context.actions?.openRichBlockDialog) {
        context.actions.openRichBlockDialog('blockMath', context.editor, context.range);
        return;
      }

      runAfterSlashDelete(context).run();
    },
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
        runAfterSlashDelete({ actions, editor, labels, range }).run();
        return;
      }

      const alt = window.prompt(labels.imageAltPrompt) || '';
      runAfterSlashDelete({ actions, editor, labels, range }).setImage({ src: src.trim(), alt: alt.trim() }).run();
    },
  },
  {
    id: 'emoji',
    keywords: ['smile', 'icon', 'reaction'],
    Icon: SmilePlus,
    command: (context) => {
      if (context.actions?.openEmojiDialog) {
        context.actions.openEmojiDialog(context.editor, context.range);
        return;
      }
      runAfterSlashDelete(context).insertContent('😀').run();
    },
  },
  {
    id: 'mention',
    keywords: ['person', 'member', 'user'],
    Icon: AtSign,
    command: (context) => runAfterSlashDelete(context).insertContent('@').run(),
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
    id: 'highlight',
    keywords: ['mark', 'marker'],
    Icon: Highlighter,
    command: (context) => runAfterSlashDelete(context).toggleCanvasHighlight().run(),
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

function getLocalizedSlashCommandItems(labels: SlashCommandLabels): SlashCommandItem[] {
  return SLASH_COMMAND_DEFINITIONS.map((definition) => ({
    ...definition,
    ...labels.items[definition.id],
  }));
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
      <Command
        className="tiptap-slash-command rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        shouldFilter={false}
        onTouchMove={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <CommandList className="tiptap-slash-command-list">
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

function getVisualViewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;

  return {
    bottom: top + height,
    left,
    right: left + width,
    top,
    width,
  };
}

function getSlashCommandMenuPosition(rect: Pick<DOMRect, 'bottom' | 'left' | 'top'>) {
  const viewport = getVisualViewportBounds();
  const padding = 8;
  const menuWidth = Math.max(224, Math.min(288, viewport.width - padding * 2));
  const availableBelow = Math.max(0, viewport.bottom - rect.bottom - padding - 6);
  const availableAbove = Math.max(0, rect.top - viewport.top - padding - 6);
  const opensBelow = availableBelow >= 176 || availableBelow >= availableAbove;
  const maxHeight = Math.max(112, Math.min(288, opensBelow ? availableBelow : availableAbove));
  const left = Math.max(
    viewport.left + padding,
    Math.min(rect.left, viewport.right - menuWidth - padding),
  );
  const top = opensBelow
    ? rect.bottom + 6
    : Math.max(viewport.top + padding, rect.top - maxHeight - 6);

  return {
    left,
    maxHeight,
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
    maxHeight: `${position.maxHeight}px`,
    top: `${position.top}px`,
    width: `${position.width}px`,
  });
}

function getSlashCommandMountElement(editor: Editor) {
  const editorElement = editor.options.element;
  const overlayHost = editorElement instanceof Element
    ? editorElement.closest('[data-slot="dialog-content"], [data-slot="sheet-content"]')
    : null;
  return overlayHost instanceof HTMLElement ? overlayHost : document.body;
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
            let latestProps: SuggestionProps<SlashCommandItem, SlashCommandItem> | null = null;

            const updatePosition = () => {
              if (component && latestProps) {
                updateSlashCommandPosition(component.element, latestProps);
              }
            };

            return {
              onStart: (props) => {
                latestProps = props;
                component = new ReactRenderer(SlashCommandList, {
                  props: { ...props, labels },
                  editor: props.editor,
                });

                component.element.classList.add('tiptap-slash-menu');
                getSlashCommandMountElement(props.editor).appendChild(component.element);
                updatePosition();
                window.visualViewport?.addEventListener('resize', updatePosition);
                window.visualViewport?.addEventListener('scroll', updatePosition);
                window.addEventListener('resize', updatePosition);
              },
              onUpdate: (props) => {
                latestProps = props;
                component?.updateProps({ ...props, labels });
                updatePosition();
              },
              onKeyDown: ({ event }) => component?.ref?.onKeyDown(event) ?? false,
              onExit: () => {
                window.visualViewport?.removeEventListener('resize', updatePosition);
                window.visualViewport?.removeEventListener('scroll', updatePosition);
                window.removeEventListener('resize', updatePosition);
                component?.element.remove();
                component?.destroy();
                component = null;
                latestProps = null;
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
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const resolvedImage = resolveMarkdownImageUrl(src, filePath, { workspaceId });
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

function createBlockCommandMenuState(editor: Editor, range: Range): BlockCommandMenuState | null {
  if (!isEditorRangeInsideDoc(editor, range)) return null;

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

function stopNativeBlockDragEvent(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
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
  onAddBlock: (editor: Editor, placement: BlockInsertPlacement, blockRange: ReorderableBlockRange) => void;
  onOpenCommandMenu: (editor: Editor, menuRange: Range) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [position, setPosition] = useState<BlockControlPosition | null>(null);
  const [dropIndicatorTop, setDropIndicatorTop] = useState<number | null>(null);
  const [dragSourceOverlay, setDragSourceOverlay] = useState<BlockOverlayRect | null>(null);
  const [dropTargetOverlay, setDropTargetOverlay] = useState<BlockOverlayRect | null>(null);
  const [propertiesInteractionActive, setPropertiesInteractionActive] = useState(false);
  const dragStateRef = useRef<ReorderableBlockRange | null>(null);

  const clearDragState = useCallback(() => {
    dragStateRef.current = null;
    setDragSourceOverlay(null);
    setDropIndicatorTop(null);
    setDropTargetOverlay(null);
  }, []);

  const updateDragSourceOverlay = useCallback(() => {
    const container = scrollContainerRef.current;
    const source = dragStateRef.current;
    if (!editor || !container || !source) {
      setDragSourceOverlay(null);
      return;
    }

    setDragSourceOverlay(getBlockOverlayRect(editor, container, source));
  }, [editor, scrollContainerRef]);

  const updateDropTarget = useCallback((event: DragEvent): BlockDropTarget | null => {
    const container = scrollContainerRef.current;
    const source = dragStateRef.current;
    if (!editor || !container || !source) {
      setDropIndicatorTop(null);
      setDropTargetOverlay(null);
      return null;
    }

    const dropTarget = getBlockDropTarget(editor, event, source);
    const nextTop = dropTarget ? getBlockDropIndicatorTop(editor, container, dropTarget) : null;
    const nextTargetOverlay = dropTarget ? getBlockOverlayRect(editor, container, dropTarget.target) : null;
    setDropIndicatorTop(nextTop);
    setDropTargetOverlay(nextTargetOverlay);
    updateDragSourceOverlay();

    return dropTarget;
  }, [editor, scrollContainerRef, updateDragSourceOverlay]);

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

    const handleScroll = () => {
      updatePosition();
      updateDragSourceOverlay();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', updatePosition);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', updatePosition);
    };
  }, [scrollContainerRef, updateDragSourceOverlay, updatePosition]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let pointerInsideProperties = false;
    let focusInsideProperties = false;
    const isPropertiesTarget = (target: EventTarget | null) => (
      target instanceof Element && Boolean(target.closest('[data-markdown-properties-panel]'))
    );
    const updateInteractionState = () => {
      setPropertiesInteractionActive(pointerInsideProperties || focusInsideProperties);
    };
    const handlePointerOver = (event: PointerEvent) => {
      pointerInsideProperties = isPropertiesTarget(event.target);
      updateInteractionState();
    };
    const handlePointerLeave = () => {
      pointerInsideProperties = false;
      updateInteractionState();
    };
    const handleFocusIn = (event: FocusEvent) => {
      focusInsideProperties = isPropertiesTarget(event.target);
      updateInteractionState();
    };
    const handleFocusOut = (event: FocusEvent) => {
      focusInsideProperties = isPropertiesTarget(event.relatedTarget);
      updateInteractionState();
    };

    container.addEventListener('pointerover', handlePointerOver);
    container.addEventListener('pointerleave', handlePointerLeave);
    container.addEventListener('focusin', handleFocusIn);
    container.addEventListener('focusout', handleFocusOut);

    return () => {
      container.removeEventListener('pointerover', handlePointerOver);
      container.removeEventListener('pointerleave', handlePointerLeave);
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('focusout', handleFocusOut);
    };
  }, [scrollContainerRef]);

  useEffect(() => {
    if (!editor) return;

    const editorElement = editor.options.element;
    if (!(editorElement instanceof HTMLElement)) return;

    const handleDragOver = (event: DragEvent) => {
      const isInternalBlockDrag = hasCanvasBlockDragData(event.dataTransfer);
      if (!dragStateRef.current && !isInternalBlockDrag) return;

      stopNativeBlockDragEvent(event);
      const dropTarget = updateDropTarget(event);
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = dropTarget ? 'move' : 'none';
      }
    };

    const handleDrop = (event: DragEvent) => {
      const source = dragStateRef.current;
      const isInternalBlockDrag = hasCanvasBlockDragData(event.dataTransfer);

      if (!source && !isInternalBlockDrag) return;

      stopNativeBlockDragEvent(event);

      const dropTarget = source ? updateDropTarget(event) : null;
      clearDragState();
      if (!source || !dropTarget) return;

      moveReorderableBlock(editor, source, dropTarget.insertPosition);
    };

    const handleDragLeave = (event: DragEvent) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && editorElement.contains(nextTarget)) return;
      setDropIndicatorTop(null);
      setDropTargetOverlay(null);
    };

    const handleGlobalDragEnd = () => {
      clearDragState();
    };

    editorElement.addEventListener('dragover', handleDragOver, true);
    editorElement.addEventListener('dragleave', handleDragLeave);
    editorElement.addEventListener('drop', handleDrop, true);
    window.addEventListener('dragend', handleGlobalDragEnd);
    window.addEventListener('drop', handleGlobalDragEnd);

    return () => {
      editorElement.removeEventListener('dragover', handleDragOver, true);
      editorElement.removeEventListener('dragleave', handleDragLeave);
      editorElement.removeEventListener('drop', handleDrop, true);
      window.removeEventListener('dragend', handleGlobalDragEnd);
      window.removeEventListener('drop', handleGlobalDragEnd);
    };
  }, [clearDragState, editor, updateDropTarget]);

  if (!editor?.isEditable || (!position && !dragSourceOverlay && !dropTargetOverlay && dropIndicatorTop === null)) return null;

  return (
    <>
      {dragSourceOverlay ? (
        <div
          className="tiptap-block-drag-overlay tiptap-block-drag-overlay-source absolute z-10"
          style={{ height: dragSourceOverlay.height, top: dragSourceOverlay.top }}
        />
      ) : null}
      {dropTargetOverlay ? (
        <div
          className="tiptap-block-drag-overlay tiptap-block-drag-overlay-target absolute z-10"
          style={{ height: dropTargetOverlay.height, top: dropTargetOverlay.top }}
        />
      ) : null}
      {dropIndicatorTop !== null ? (
        <div className="tiptap-block-drop-indicator absolute z-10" style={{ top: dropIndicatorTop }} />
      ) : null}
      {position && !propertiesInteractionActive ? (
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
                onDragEnd={clearDragState}
                onDragStart={(event) => {
                  const source = position.blockRange;
                  if (!source || !event.dataTransfer) {
                    event.preventDefault();
                    return;
                  }

                  dragStateRef.current = source;
                  const container = scrollContainerRef.current;
                  if (container) {
                    setDragSourceOverlay(getBlockOverlayRect(editor, container, source));
                  }
                  event.dataTransfer.effectAllowed = 'move';
                  setCanvasBlockDragData(event.dataTransfer);
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
      ) : null}
    </>
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

function createEditorExtensions(
  filePath: string | undefined,
  labels: SlashCommandLabels,
  actions?: SlashCommandActions,
  workspaceId: string | null = null,
  wikiLabels: { empty: string; group: string } = { empty: '', group: '' },
  mentionLabels: { empty: string; group: string } = { empty: '', group: '' },
  collaboration: CollaborationDocument | null = null,
  remoteCaretLabel?: (name: string) => string,
) {
  const extensions = [
    StarterKit.configure({
      codeBlock: false,
      link: false,
      paragraph: false,
      undoRedo: collaboration ? false : undefined,
    }),
    Placeholder.configure({
      placeholder: ({ node }) => node.type.name === 'paragraph' ? labels.placeholder : '',
      showOnlyCurrent: true,
    }),
    CodeBlockWithMermaid,
    Mathematics.configure({
      inlineOptions: {
        onClick: (node, pos) => actions?.editMath?.('inline', String(node.attrs.latex ?? ''), pos),
      },
      blockOptions: {
        onClick: (node, pos) => actions?.editMath?.('block', String(node.attrs.latex ?? ''), pos),
      },
      katexOptions: CANVAS_KATEX_OPTIONS,
    }),
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: true,
    }),
    createMarkdownImageExtension(filePath),
    TaskList,
    TaskItem.configure({
      HTMLAttributes: {
        'data-type': 'taskItem',
      },
      nested: true,
    }),
    TableKit.configure({
      table: {
        cellMinWidth: 144,
        resizable: false,
      },
    }),
    UniqueID.configure({
      types: 'all',
      filterTransaction: (transaction) => !isChangeOrigin(transaction),
    }),
    MarkdownHeadingAnchors,
    MarkdownSearchExtension,
    ColorSwatchDecorations,
    CanvasBlockDragDropGuard,
    createSlashCommands(labels, actions),
    ...canvasRichMarkdownExtensions({
      obsidianWikiLink: createObsidianWikiLinkNode(filePath),
    }),
    createMarkdownMentionSuggestions({ labels: mentionLabels, workspaceId }),
    ...createObsidianWikiLinkExtensions({ filePath, labels: wikiLabels, workspaceId }),
    ObsidianInlineFootnoteExtension,
    createCanvasMarkdownExtension(),
  ];
  if (collaboration?.provider && collaboration.session) {
    extensions.push(
      Collaboration.configure({ document: collaboration.doc, field: 'body' }),
      CollaborationCaret.configure({
        provider: collaboration.provider,
        user: {
          name: collaboration.session.user.name,
          color: collaboration.session.user.color,
          colorLight: collaboration.session.user.colorLight,
        },
        render: (user) => {
          const name = typeof user.name === 'string' && user.name.trim()
            ? user.name.trim().slice(0, 120)
            : 'Collaborator';
          const color = typeof user.color === 'string' ? user.color : '#2563eb';
          const colorLight = typeof user.colorLight === 'string' ? user.colorLight : '#dbeafe';
          const cursor = document.createElement('span');
          cursor.classList.add('collaboration-carets__caret');
          cursor.dataset.collaborationUser = name;
          cursor.setAttribute('aria-label', remoteCaretLabel?.(name) || `${name} is editing here`);
          cursor.setAttribute('contenteditable', 'false');
          cursor.style.setProperty('--collaboration-user-color', color);
          cursor.style.setProperty('--collaboration-user-color-light', colorLight);

          const needle = document.createElement('span');
          needle.classList.add('collaboration-carets__needle');
          needle.setAttribute('aria-hidden', 'true');

          const label = document.createElement('span');
          label.classList.add('collaboration-carets__label');
          label.setAttribute('aria-hidden', 'true');

          const activity = document.createElement('span');
          activity.classList.add('collaboration-carets__activity');
          activity.setAttribute('aria-hidden', 'true');
          label.append(activity, document.createTextNode(name));
          cursor.append(needle, label);

          const updateLabelPlacement = () => {
            const boundary = cursor.closest<HTMLElement>('.tiptap-editor-shell')
              || cursor.closest<HTMLElement>('[data-testid="markdown-scroll-container"]');
            if (!boundary) return;
            const cursorRect = cursor.getBoundingClientRect();
            const boundaryRect = boundary.getBoundingClientRect();
            const labelWidth = label.getBoundingClientRect().width;
            const spaceLeft = cursorRect.left - boundaryRect.left;
            const spaceRight = boundaryRect.right - cursorRect.right;
            const labelSide = spaceRight >= labelWidth + 12 || spaceRight >= spaceLeft
              ? 'right'
              : 'left';
            cursor.dataset.labelSide = labelSide;
            cursor.classList.toggle('collaboration-carets__caret--label-left', labelSide === 'left');
          };
          cursor.addEventListener('pointerenter', updateLabelPlacement);
          window.requestAnimationFrame(updateLabelPlacement);
          return cursor;
        },
        selectionRender: (user) => ({
          nodeName: 'span',
          class: 'collaboration-carets__selection',
          'data-collaboration-user': typeof user.name === 'string' ? user.name.slice(0, 120) : '',
          style: `--collaboration-user-color: ${typeof user.color === 'string' ? user.color : '#2563eb'};`,
        }),
      }),
      createAgentTargetDecorationExtension(collaboration.doc),
    );
  }
  return extensions;
}

function MarkdownSourceToolbar({
  richModeAvailable,
  showRichModeSwitch,
  mobileVisible,
  onMobilePointerCancel,
  onMobilePointerDown,
  onMobilePointerUp,
  onRichMode,
}: {
  richModeAvailable: boolean;
  showRichModeSwitch: boolean;
  mobileVisible: boolean;
  onMobilePointerCancel: () => void;
  onMobilePointerDown: () => void;
  onMobilePointerUp: () => void;
  onRichMode: () => void;
}) {
  const t = useTranslations('notebook');
  const portalElement = getBodyPortalElement();

  const hideKeyboard = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  const mobileToolbar = (
    <div
      className={cn('tiptap-mobile-toolbar', mobileVisible && 'tiptap-mobile-toolbar-visible')}
      role="toolbar"
      aria-label={t('markdownEditorMobileToolbar')}
      onPointerDownCapture={onMobilePointerDown}
      onPointerUpCapture={onMobilePointerUp}
      onPointerCancelCapture={onMobilePointerCancel}
    >
      {showRichModeSwitch ? (
        <MobileToolbarButton label={t('markdownEditorEditVisually')} disabled={!richModeAvailable} onClick={onRichMode}>
          <Eye className="h-5 w-5" />
        </MobileToolbarButton>
      ) : null}
      <MobileToolbarButton label={t('markdownEditorMobileHideKeyboard')} onClick={hideKeyboard}>
        <Keyboard className="h-5 w-5" />
      </MobileToolbarButton>
    </div>
  );

  return (
    <>
      {showRichModeSwitch ? (
        <TooltipProvider>
          <div className="tiptap-desktop-editor-toolbar hidden h-9 shrink-0 items-center justify-end gap-1 border-b border-border bg-background px-2 md:flex">
            <TooltipIconButton label={t('markdownEditorEditVisually')} disabled={!richModeAvailable} onClick={onRichMode}>
              <Eye />
            </TooltipIconButton>
          </div>
        </TooltipProvider>
      ) : null}
      {portalElement ? createPortal(mobileToolbar, portalElement) : null}
    </>
  );
}

type LinkPreviewState =
  | { status: 'idle'; error?: undefined; imageUrl?: undefined; host?: undefined }
  | { status: 'loading'; error?: undefined; imageUrl?: undefined; host?: undefined }
  | { status: 'loaded'; error?: undefined; imageUrl: string | null; host: string }
  | { status: 'error'; error: string; imageUrl?: undefined; host?: undefined };

type LinkDialogMode = 'workspace' | 'web';

type WorkspaceLinkIndexState =
  | { status: 'idle'; index?: undefined; workspaceId?: undefined }
  | { status: 'loaded'; index: WorkspaceLinkIndex; workspaceId: string }
  | { status: 'error'; index?: undefined; workspaceId: string };

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

function findSelectedRichBlockPosition(editor: Editor, typeName: string): number | null {
  const selectedNode = editor.state.doc.nodeAt(editor.state.selection.from);
  if (selectedNode?.type.name === typeName) return editor.state.selection.from;

  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === typeName) {
      return $from.before(depth);
    }
  }

  return null;
}

function getRichBlockTitle(editor: Editor, position: number, titleType: string) {
  const node = editor.state.doc.nodeAt(position);
  const titleNode = node?.firstChild?.type.name === titleType ? node.firstChild : null;
  return titleNode?.textContent ?? '';
}

function findFootnoteDefinitionPosition(editor: Editor, footnoteId: string): number | null {
  let definitionPosition: number | null = null;
  editor.state.doc.descendants((node, position) => {
    if (
      node.type.name === 'markdownFootnoteDefinition'
      && String(node.attrs.footnoteId ?? '') === footnoteId
    ) {
      definitionPosition = position;
      return false;
    }
    return definitionPosition === null;
  });
  return definitionPosition;
}

function getSelectedFootnoteId(editor: Editor): string | null {
  const { from, empty } = editor.state.selection;
  const candidates = [editor.state.doc.nodeAt(from)];
  if (empty && from > 0) candidates.push(editor.state.doc.nodeAt(from - 1));

  const reference = candidates.find((node) => node?.type.name === 'markdownFootnoteReference');
  return reference ? String(reference.attrs.footnoteId ?? '') : null;
}

function replaceRichBlockTitle(
  editor: Editor,
  position: number,
  blockType: string,
  titleType: string,
  title: string,
  attrs: Record<string, unknown>,
) {
  const node = editor.state.doc.nodeAt(position);
  if (!node || node.type.name !== blockType) return false;

  const transaction = editor.state.tr.setNodeMarkup(position, node.type, {
    ...node.attrs,
    ...attrs,
  });
  const currentTitle = node.firstChild?.type.name === titleType ? node.firstChild : null;
  const titleNodeType = editor.schema.nodes[titleType];
  const content = title ? editor.schema.text(title) : undefined;

  if (currentTitle) {
    transaction.replaceWith(
      position + 1,
      position + 1 + currentTitle.nodeSize,
      currentTitle.type.create(currentTitle.attrs, content),
    );
  } else if (titleNodeType) {
    transaction.insert(position + 1, titleNodeType.create(null, content));
  }

  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

function updateFootnoteDefinition(editor: Editor, footnoteId: string, content: string) {
  const position = findFootnoteDefinitionPosition(editor, footnoteId);
  if (position === null) return false;

  const definition = editor.state.doc.nodeAt(position);
  if (!definition) return false;

  const firstBlock = definition.firstChild;
  const paragraphType = editor.schema.nodes.paragraph;
  if (!paragraphType) return false;

  const paragraph = paragraphType.create(
    firstBlock?.type.name === 'paragraph' ? firstBlock.attrs : null,
    content ? editor.schema.text(content) : undefined,
  );
  const transaction = editor.state.tr;
  if (firstBlock) {
    transaction.replaceWith(position + 1, position + 1 + firstBlock.nodeSize, paragraph);
  } else {
    transaction.insert(position + 1, paragraph);
  }
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

function insertMathAtRange(
  editor: Editor,
  kind: Extract<RichBlockKind, 'inlineMath' | 'blockMath'>,
  latex: string,
  range?: Range,
) {
  const safeRange = range ? clampEditorRangeToDoc(editor, range) : null;
  if (safeRange) {
    const chain = editor.chain().focus();
    if (safeRange.from < safeRange.to) {
      chain.deleteRange(safeRange).run();
    } else {
      chain.setTextSelection(safeRange.from).run();
    }
  }

  const position = editor.state.selection.from;
  return kind === 'inlineMath'
    ? editor.chain().focus().insertInlineMath({ latex, pos: position }).run()
    : editor.chain().focus().insertBlockMath({ latex, pos: position }).run();
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
  sourcePath,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialHref: string;
  initialText: string;
  canEditText: boolean;
  sourcePath?: string;
}) {
  const t = useTranslations('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const initialWorkspaceTarget = getWorkspaceMarkdownNavigationTarget(initialHref, sourcePath) ?? '';
  const [mode, setMode] = useState<LinkDialogMode>(
    initialHref && !initialWorkspaceTarget ? 'web' : 'workspace',
  );
  const [href, setHref] = useState(initialHref);
  const [workspaceTarget, setWorkspaceTarget] = useState(initialWorkspaceTarget);
  const [text, setText] = useState(initialText);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [previewState, setPreviewState] = useState<LinkPreviewState>({ status: 'idle' });
  const [workspaceIndexState, setWorkspaceIndexState] = useState<WorkspaceLinkIndexState>({ status: 'idle' });
  const linkActive = Boolean(editor?.isActive('link') || editor?.isActive('obsidianWikiLink'));

  useEffect(() => {
    if (!open || mode !== 'web' || !previewEnabled) return;

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
  }, [href, mode, open, previewEnabled, t]);

  useEffect(() => {
    if (!open || mode !== 'workspace') return;
    if (!activeWorkspaceId) return;

    let cancelled = false;
    void loadWorkspaceLinkIndex(activeWorkspaceId)
      .then((index) => {
        if (!cancelled) setWorkspaceIndexState({ status: 'loaded', index, workspaceId: activeWorkspaceId });
      })
      .catch(() => {
        if (!cancelled) setWorkspaceIndexState({ status: 'error', workspaceId: activeWorkspaceId });
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, mode, open]);

  const workspaceIndexStatus = !activeWorkspaceId
    ? 'error'
    : workspaceIndexState.workspaceId !== activeWorkspaceId
      ? 'loading'
      : workspaceIndexState.status;

  const workspaceSuggestions = useMemo(() => {
    if (
      workspaceIndexState.status !== 'loaded'
      || workspaceIndexState.workspaceId !== activeWorkspaceId
    ) return [];

    const unwrappedQuery = workspaceTarget
      .trim()
      .replace(/^!?\[\[/u, '')
      .replace(/\]\]$/u, '')
      .split('|', 1)[0];
    const source = `[[${unwrappedQuery}`;
    const context = findObsidianWikiCompletionContext(source, source.length);
    if (!context) return [];

    return getWorkspaceWikiCompletionItems(
      workspaceIndexState.index,
      context,
      sourcePath,
      8,
    );
  }, [activeWorkspaceId, sourcePath, workspaceIndexState, workspaceTarget]);

  const workspaceWikiTarget = useMemo(
    () => buildObsidianWikiLinkTarget(workspaceTarget, text),
    [text, workspaceTarget],
  );

  const applyWorkspaceLink = useCallback(() => {
    if (!editor || !workspaceWikiTarget) return;

    const activeLink = getActiveLinkDetails(editor);
    const activeWorkspaceLink = getActiveWorkspaceWikiLink(editor);
    const replacementRange = activeWorkspaceLink?.range ?? activeLink?.range ?? {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    const existingPreviewRange = activeLink
      ? findAdjacentLinkPreviewImageRange(editor, activeLink.range.to)
      : null;
    const chain = editor.chain().focus();

    if (existingPreviewRange) chain.deleteRange(existingPreviewRange);
    chain.insertContentAt(replacementRange, {
      type: 'obsidianWikiLink',
      attrs: { embed: false, target: workspaceWikiTarget },
    }).run();
    onOpenChange(false);
  }, [editor, onOpenChange, workspaceWikiTarget]);

  const applyWebLink = useCallback(() => {
    if (!editor) return;

    const normalizedHref = normalizeLinkHref(href);
    const activeWorkspaceLink = getActiveWorkspaceWikiLink(editor);
    if (!normalizedHref) {
      if (activeWorkspaceLink) {
        editor.chain().focus().insertContentAt(activeWorkspaceLink.range, activeWorkspaceLink.displayText).run();
      } else {
        editor.chain().focus().unsetLink().run();
      }
      onOpenChange(false);
      return;
    }

    const previewImage = previewEnabled && previewState.status === 'loaded' && previewState.imageUrl
      ? createLinkPreviewImageContent(previewState.imageUrl, previewState.host)
      : null;
    if (activeWorkspaceLink) {
      const content: JSONContent[] = [{
        type: 'text',
        text: text.trim() || activeWorkspaceLink.displayText || normalizedHref,
        marks: [{ type: 'link', attrs: { href: normalizedHref } }],
      }];
      if (previewImage) content.push({ type: 'text', text: ' ' }, previewImage);
      editor.chain().focus().insertContentAt(activeWorkspaceLink.range, content).run();
      onOpenChange(false);
      return;
    }

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

  const applyLink = mode === 'workspace' ? applyWorkspaceLink : applyWebLink;

  const removeLink = useCallback(() => {
    if (!editor) return;
    const activeWorkspaceLink = getActiveWorkspaceWikiLink(editor);
    if (activeWorkspaceLink) {
      editor.chain().focus().insertContentAt(activeWorkspaceLink.range, activeWorkspaceLink.displayText).run();
    } else {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    onOpenChange(false);
  }, [editor, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(90dvh,44rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('markdownEditorLinkDialogTitle')}</DialogTitle>
          <DialogDescription>{t('markdownEditorLinkDialogDescription')}</DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(value) => setMode(value as LinkDialogMode)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="workspace" className="gap-2">
              <FileText className="h-4 w-4" />
              {t('markdownEditorLinkWorkspaceTab')}
            </TabsTrigger>
            <TabsTrigger value="web" className="gap-2">
              <Globe2 className="h-4 w-4" />
              {t('markdownEditorLinkWebTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="workspace" className="mt-4 grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="markdown-link-workspace-target">{t('markdownEditorLinkWorkspaceTarget')}</Label>
              <Input
                id="markdown-link-workspace-target"
                autoComplete="off"
                value={workspaceTarget}
                placeholder={t('markdownEditorLinkWorkspacePlaceholder')}
                onChange={(event) => setWorkspaceTarget(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && workspaceWikiTarget) {
                    event.preventDefault();
                    applyWorkspaceLink();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">{t('markdownEditorLinkWorkspaceHint')}</p>
            </div>

            <div className="overflow-hidden rounded-md border bg-muted/10">
              <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                {t('markdownEditorWikiSuggestions')}
              </div>
              <Command shouldFilter={false} className="bg-transparent">
                <CommandList className="max-h-48">
                  {workspaceIndexStatus === 'loading' ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">
                      {t('markdownEditorLinkWorkspaceLoading')}
                    </div>
                  ) : null}
                  {workspaceIndexStatus === 'error' ? (
                    <div className="px-3 py-4 text-sm text-destructive">
                      {t('markdownEditorLinkWorkspaceUnavailable')}
                    </div>
                  ) : null}
                  {workspaceIndexStatus === 'loaded' && workspaceSuggestions.length === 0 ? (
                    <CommandEmpty>{t('markdownEditorWikiNoMatch')}</CommandEmpty>
                  ) : null}
                  {workspaceSuggestions.length > 0 ? (
                    <CommandGroup>
                      {workspaceSuggestions.map((item, index) => (
                        <CommandItem
                          key={`${item.kind}:${item.target}:${index}`}
                          value={`${item.displayLabel} ${item.detail}`}
                          onSelect={() => setWorkspaceTarget(item.target)}
                          className="items-start gap-3 py-2.5"
                        >
                          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{item.displayLabel}</span>
                            <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null}
                </CommandList>
              </Command>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="markdown-link-workspace-text">{t('markdownEditorLinkWorkspaceAlias')}</Label>
              <Input
                id="markdown-link-workspace-text"
                value={text}
                placeholder={t('markdownEditorLinkWorkspaceAliasPlaceholder')}
                onChange={(event) => setText(event.target.value)}
              />
            </div>

            <div className="rounded-md border bg-muted/30 px-3 py-2.5">
              <div className="text-xs font-medium text-muted-foreground">
                {t('markdownEditorLinkWorkspaceSyntax')}
              </div>
              <code className="mt-1 block break-all text-sm">
                {workspaceWikiTarget
                  ? `[[${workspaceWikiTarget}]]`
                  : `[[${t('markdownEditorLinkWorkspaceExample')}]]`}
              </code>
            </div>
          </TabsContent>

          <TabsContent value="web" className="mt-4 grid gap-4">
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
                    applyWebLink();
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
          </TabsContent>
        </Tabs>

        <DialogFooter>
          {linkActive ? (
            <Button type="button" variant="outline" onClick={removeLink}>
              {t('markdownEditorLinkRemove')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" disabled={mode === 'workspace' && !workspaceWikiTarget} onClick={applyLink}>
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

const CALLOUT_TYPE_OPTIONS = ['note', 'info', 'warning', 'success', 'danger'] as const;

function MarkdownLatexPreview({ latex, displayMode }: { latex: string; displayMode: boolean }) {
  const rendered = useMemo(() => {
    const value = latex.trim() || String.raw`\text{LaTeX}`;
    return katex.renderToString(value, {
      ...CANVAS_KATEX_OPTIONS,
      displayMode,
    });
  }, [displayMode, latex]);

  return (
    <div
      aria-live="polite"
      className="min-h-14 overflow-x-auto rounded-lg border bg-muted/35 px-3 py-3 text-center text-sm"
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  );
}

function MarkdownRichBlockDialog({
  open,
  onOpenChange,
  seed,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed: RichBlockDialogSeed;
  onSubmit: (submission: RichBlockDialogSubmission) => void;
}) {
  const t = useTranslations('notebook');
  const isEditing = seed.nodePosition !== undefined || seed.footnoteId !== undefined;
  const [title, setTitle] = useState(seed.initialTitle ?? '');
  const [content, setContent] = useState(seed.initialContent ?? '');
  const [calloutType, setCalloutType] = useState(seed.initialCalloutType ?? 'note');
  const [latex, setLatex] = useState(seed.initialLatex ?? '');
  const [detailsOpen, setDetailsOpen] = useState(Boolean(seed.initialOpen));
  const [error, setError] = useState<string | null>(null);
  const isMath = seed.kind === 'inlineMath' || seed.kind === 'blockMath';
  const [mathKind, setMathKind] = useState<Extract<RichBlockKind, 'inlineMath' | 'blockMath'>>(
    seed.kind === 'blockMath' ? 'blockMath' : 'inlineMath',
  );
  const dialogTitle = isMath
    ? t('markdownEditorFormulaDialogTitle')
    : seed.kind === 'callout'
    ? t('markdownEditorCalloutDialogTitle')
    : seed.kind === 'details'
      ? t('markdownEditorDetailsDialogTitle')
      : seed.kind === 'footnote'
        ? t('markdownEditorFootnoteDialogTitle')
        : t('markdownEditorFormulaDialogTitle');
  const dialogDescription = seed.kind === 'callout'
    ? t('markdownEditorCalloutDialogDescription')
    : seed.kind === 'details'
      ? t('markdownEditorDetailsDialogDescription')
      : seed.kind === 'footnote'
        ? t('markdownEditorFootnoteDialogDescription')
        : t('markdownEditorMathDialogDescription');

  const submit = useCallback(() => {
    const nextTitle = title.trim();
    const nextContent = content.trim();
    const nextLatex = latex.trim();

    if (isMath && !nextLatex) {
      setError(t('markdownEditorFormulaRequired'));
      return;
    }
    if (seed.kind === 'footnote' && !nextContent) {
      setError(t('markdownEditorFootnoteRequired'));
      return;
    }

    if (seed.kind === 'callout') {
      onSubmit({
        kind: 'callout',
        title: nextTitle || t('markdownEditorCommands.callout.title'),
        calloutType,
        content: nextContent,
      });
    } else if (seed.kind === 'details') {
      onSubmit({
        kind: 'details',
        title: nextTitle || t('markdownEditorCommands.details.title'),
        content: nextContent,
        open: detailsOpen,
      });
    } else if (seed.kind === 'footnote') {
      onSubmit({ kind: 'footnote', content: nextContent });
    } else {
      onSubmit({ kind: mathKind, latex: nextLatex });
    }
  }, [calloutType, content, detailsOpen, isMath, latex, mathKind, onSubmit, seed.kind, t, title]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="markdown-rich-block-dialog">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          {seed.kind === 'callout' ? (
            <>
              <div className="grid gap-2">
                <Label>{t('markdownEditorCalloutType')}</Label>
                <div className="grid grid-cols-5 gap-2" role="group" aria-label={t('markdownEditorCalloutType')}>
                  {CALLOUT_TYPE_OPTIONS.map((option) => (
                    <Button
                      key={option}
                      type="button"
                      size="sm"
                      variant={calloutType === option ? 'secondary' : 'outline'}
                      className="capitalize"
                      onClick={() => setCalloutType(option)}
                    >
                      {t(`markdownEditorCalloutType${option[0].toUpperCase()}${option.slice(1)}`)}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="markdown-callout-title">{t('markdownEditorCalloutTitleLabel')}</Label>
                <Input
                  autoFocus
                  id="markdown-callout-title"
                  value={title}
                  placeholder={t('markdownEditorCommands.callout.title')}
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
              </div>
              {!isEditing ? (
                <div className="grid gap-2">
                  <Label htmlFor="markdown-callout-content">{t('markdownEditorInitialContentLabel')}</Label>
                  <Textarea
                    id="markdown-callout-content"
                    value={content}
                    placeholder={t('markdownEditorInitialContentPlaceholder')}
                    onChange={(event) => setContent(event.target.value)}
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {seed.kind === 'details' ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="markdown-details-summary">{t('markdownEditorDetailsSummaryLabel')}</Label>
                <Input
                  autoFocus
                  id="markdown-details-summary"
                  value={title}
                  placeholder={t('markdownEditorCommands.details.title')}
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
              </div>
              {!isEditing ? (
                <div className="grid gap-2">
                  <Label htmlFor="markdown-details-content">{t('markdownEditorInitialContentLabel')}</Label>
                  <Textarea
                    id="markdown-details-content"
                    value={content}
                    placeholder={t('markdownEditorInitialContentPlaceholder')}
                    onChange={(event) => setContent(event.target.value)}
                  />
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/25 px-3 py-2.5">
                <div className="grid gap-0.5">
                  <Label htmlFor="markdown-details-open">{t('markdownEditorDetailsInitiallyOpen')}</Label>
                  <p className="text-xs text-muted-foreground">{t('markdownEditorDetailsInitiallyOpenHint')}</p>
                </div>
                <Switch id="markdown-details-open" checked={detailsOpen} onCheckedChange={setDetailsOpen} />
              </div>
            </>
          ) : null}

          {seed.kind === 'footnote' ? (
            <div className="grid gap-2">
              <Label htmlFor="markdown-footnote-content">{t('markdownEditorFootnoteContentLabel')}</Label>
              <Textarea
                autoFocus
                id="markdown-footnote-content"
                value={content}
                placeholder={t('markdownEditorFootnoteContentPlaceholder')}
                onChange={(event) => setContent(event.target.value)}
              />
            </div>
          ) : null}

          {isMath ? (
            <Tabs
              value={mathKind}
              onValueChange={(value) => {
                if (value === 'inlineMath' || value === 'blockMath') setMathKind(value);
              }}
              className="gap-4"
            >
              <div className="grid gap-2">
                <Label>{t('markdownEditorFormulaType')}</Label>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="inlineMath" disabled={seed.nodePosition !== undefined && seed.kind !== 'inlineMath'}>
                    <Sigma />
                    {t('markdownEditorInlineMathDialogTitle')}
                  </TabsTrigger>
                  <TabsTrigger value="blockMath" disabled={seed.nodePosition !== undefined && seed.kind !== 'blockMath'}>
                    <SquareSigma />
                    {t('markdownEditorBlockMathDialogTitle')}
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value={mathKind} className="mt-0 grid gap-5">
                <div className="grid gap-2">
                  <Label htmlFor="markdown-latex">{t('markdownEditorLatexLabel')}</Label>
                  <Textarea
                    autoFocus
                    id="markdown-latex"
                    value={latex}
                    className="min-h-24 font-mono"
                    placeholder={String.raw`E = mc^2`}
                    spellCheck={false}
                    onChange={(event) => setLatex(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault();
                        submit();
                      }
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>{t('markdownEditorMathPreview')}</Label>
                  <MarkdownLatexPreview latex={latex} displayMode={mathKind === 'blockMath'} />
                </div>
              </TabsContent>
            </Tabs>
          ) : null}

          {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={submit}>
            {isEditing ? t('markdownEditorRichBlockUpdate') : t('markdownEditorRichBlockInsert')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MarkdownEmojiDialog({
  editor,
  onOpenChange,
  open,
  range,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  range?: Range;
}) {
  const t = useTranslations('notebook');
  const [query, setQuery] = useState('');
  const items = useMemo(() => filterCanvasEmoji(query), [query]);

  const insertEmoji = useCallback((emoji: string) => {
    if (!editor || editor.isDestroyed || !editor.isEditable) return;
    const insertionRange = range ? clampEditorRangeToDoc(editor, range) : null;
    const chain = editor.chain().focus();
    if (insertionRange) {
      chain.insertContentAt(insertionRange, emoji).run();
    } else {
      chain.insertContent(emoji).run();
    }
    onOpenChange(false);
  }, [editor, onOpenChange, range]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="markdown-emoji-dialog">
        <DialogHeader>
          <DialogTitle>{t('markdownEditorEmojiTitle')}</DialogTitle>
          <DialogDescription>{t('markdownEditorEmojiDescription')}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          placeholder={t('markdownEditorEmojiSearch')}
          aria-label={t('markdownEditorEmojiSearch')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {items.length > 0 ? (
          <div className="grid max-h-72 grid-cols-6 gap-1 overflow-y-auto pr-1 sm:grid-cols-8">
            {items.map((item) => (
              <Button
                key={`${item.emoji}-${item.label}`}
                type="button"
                variant="ghost"
                size="icon"
                className="text-xl"
                aria-label={item.label}
                title={item.label}
                onClick={() => insertEmoji(item.emoji)}
              >
                <span aria-hidden="true">{item.emoji}</span>
              </Button>
            ))}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('markdownEditorEmojiNoMatch')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MarkdownToolbar({
  editor,
  filePath,
  imageDialogSeed,
  imageDialogOpen,
  labels,
  onSourceMode,
  showSourceModeSwitch,
  onOpenEmojiDialog,
  onImageDialogOpenChange,
  onOpenRichBlockDialog,
  onOpenTableDialog,
}: {
  editor: MarkdownEditorWithMarkdown | null;
  filePath?: string;
  imageDialogSeed: ImageDialogSeed;
  imageDialogOpen: boolean;
  labels: SlashCommandLabels;
  onSourceMode: () => void;
  showSourceModeSwitch: boolean;
  onOpenEmojiDialog: (range?: Range) => void;
  onImageDialogOpenChange: (open: boolean, range?: Range) => void;
  onOpenRichBlockDialog: (kind: RichBlockKind, range?: Range) => void;
  onOpenTableDialog: (range?: Range | null) => void;
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
  const canUseCommands = Boolean(editor && !editor.isDestroyed && editor.isEditable);
  const toolbarState = useMarkdownToolbarState(editor);

  const closeLinkPopover = useCallback(() => {
    setLinkPopover(null);
  }, []);

  const getCurrentToolbarRange = useCallback((): Range | undefined => {
    if (!editor) return undefined;
    return {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
  }, [editor]);

  const handleLinkDialogOpenChange = useCallback((open: boolean) => {
    setLinkDialogOpen(open);
    if (open) setLinkPopover(null);
  }, []);

  const openToolbarLinkDialog = useCallback(() => {
    if (!editor) return;
    const activeLink = getActiveLinkDetails(editor);
    const activeWorkspaceLink = getActiveWorkspaceWikiLink(editor);
    setLinkDialogSeed((current) => ({
      id: current.id + 1,
      href: activeWorkspaceLink?.target || activeLink?.href || (editor.getAttributes('link').href as string | undefined) || '',
      text: activeWorkspaceLink?.text || activeLink?.text || getSelectedText(editor),
      canEditText: editor.state.selection.empty && !activeLink && !activeWorkspaceLink,
    }));
    handleLinkDialogOpenChange(true);
  }, [editor, handleLinkDialogOpenChange]);

  const insertMath = useCallback((kind: 'inline' | 'block') => {
    if (!editor) return;

    onOpenRichBlockDialog(kind === 'inline' ? 'inlineMath' : 'blockMath', getCurrentToolbarRange());
  }, [editor, getCurrentToolbarRange, onOpenRichBlockDialog]);

  const insertCallout = useCallback(() => {
    if (!editor) return;
    onOpenRichBlockDialog('callout', getCurrentToolbarRange());
  }, [editor, getCurrentToolbarRange, onOpenRichBlockDialog]);

  const insertDetails = useCallback(() => {
    if (!editor) return;
    onOpenRichBlockDialog('details', getCurrentToolbarRange());
  }, [editor, getCurrentToolbarRange, onOpenRichBlockDialog]);

  const insertFootnote = useCallback(() => {
    if (!editor) return;
    onOpenRichBlockDialog('footnote', getCurrentToolbarRange());
  }, [editor, getCurrentToolbarRange, onOpenRichBlockDialog]);

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

    const editorElement = editor.options.element;
    if (!(editorElement instanceof HTMLElement)) return;

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

  const activeTextStyle = toolbarState.isHeading1
    ? labels.items.heading1.title
    : toolbarState.isHeading2
      ? labels.items.heading2.title
      : toolbarState.isHeading3
        ? labels.items.heading3.title
        : labels.items.text.title;

  return (
    <TooltipProvider>
      <div
        className="tiptap-desktop-editor-toolbar tiptap-markdown-format-toolbar hidden h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2 md:flex"
        role="toolbar"
        aria-label={t('markdownEditorToolbar')}
        data-testid="markdown-desktop-toolbar"
      >
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarDropdownTrigger label={t('markdownEditorToolbarTextStyle')} disabled={!canUseCommands} active={toolbarState.isHeading1 || toolbarState.isHeading2 || toolbarState.isHeading3} testId="markdown-toolbar-text-style">
              <Type className="size-4" />
              <span className="max-w-24 truncate">{activeTextStyle}</span>
            </ToolbarDropdownTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('markdownEditorToolbarTextStyle')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <ToolbarDropdownItem
              Icon={Type}
              label={labels.items.text.title}
              active={!toolbarState.isHeading1 && !toolbarState.isHeading2 && !toolbarState.isHeading3}
              disabled={!canUseCommands}
              onSelect={() => editor?.chain().focus().setParagraph().run()}
            />
            <ToolbarDropdownItem
              Icon={Heading1}
              label={labels.items.heading1.title}
              active={toolbarState.isHeading1}
              disabled={!canUseCommands}
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
            />
            <ToolbarDropdownItem
              Icon={Heading2}
              label={labels.items.heading2.title}
              active={toolbarState.isHeading2}
              disabled={!canUseCommands}
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            />
            <ToolbarDropdownItem
              Icon={Heading3}
              label={labels.items.heading3.title}
              active={toolbarState.isHeading3}
              disabled={!canUseCommands}
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
            />
          </DropdownMenuContent>
        </DropdownMenu>

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

        <div className="tiptap-toolbar-secondary-inline">
          <TooltipIconButton
            label="Strike"
            active={toolbarState.isStrike}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
          >
            <Strikethrough />
          </TooltipIconButton>
          <TooltipIconButton
            label={labels.items.highlight.title}
            active={toolbarState.isHighlight}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().toggleCanvasHighlight().run()}
          >
            <Highlighter />
          </TooltipIconButton>
          <TooltipIconButton
            label="Inline code"
            active={toolbarState.isCode}
            disabled={!canUseCommands}
            onClick={() => editor?.chain().focus().toggleCode().run()}
          >
            <Code />
          </TooltipIconButton>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarDropdownTrigger label={t('markdownEditorToolbarLists')} disabled={!canUseCommands} active={toolbarState.isBulletList || toolbarState.isOrderedList || toolbarState.isTaskList} testId="markdown-toolbar-lists">
              <List className="size-4" />
            </ToolbarDropdownTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('markdownEditorToolbarLists')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <ToolbarDropdownItem Icon={List} label={labels.items.bulletList.title} active={toolbarState.isBulletList} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().toggleBulletList().run()} />
            <ToolbarDropdownItem Icon={ListOrdered} label={labels.items.numberedList.title} active={toolbarState.isOrderedList} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().toggleOrderedList().run()} />
            <ToolbarDropdownItem Icon={ListChecks} label={labels.items.taskList.title} active={toolbarState.isTaskList} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().toggleTaskList().run()} />
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarDropdownTrigger label={t('markdownEditorToolbarBlocks')} disabled={!canUseCommands} active={toolbarState.isBlockquote || toolbarState.isCallout || toolbarState.isDetails || toolbarState.isCodeBlock} testId="markdown-toolbar-blocks">
              <Layers className="size-4" />
            </ToolbarDropdownTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('markdownEditorToolbarBlocks')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <ToolbarDropdownItem Icon={Quote} label={labels.items.quote.title} active={toolbarState.isBlockquote} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().toggleBlockquote().run()} />
            <ToolbarDropdownItem Icon={BadgeInfo} label={labels.items.callout.title} active={toolbarState.isCallout} disabled={!canUseCommands} onSelect={insertCallout} />
            <ToolbarDropdownItem Icon={ListCollapse} label={labels.items.details.title} active={toolbarState.isDetails} disabled={!canUseCommands} onSelect={insertDetails} />
            <ToolbarDropdownItem Icon={Superscript} label={labels.items.footnote.title} disabled={!canUseCommands} onSelect={insertFootnote} />
            <ToolbarDropdownItem Icon={Code2} label={labels.items.codeBlock.title} active={toolbarState.isCodeBlock} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().toggleCodeBlock().run()} />
            <ToolbarDropdownItem Icon={Minus} label={labels.items.divider.title} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().setHorizontalRule().run()} />
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarDropdownTrigger label={t('markdownEditorToolbarInsert')} disabled={!canUseCommands} active={toolbarState.isLink} testId="markdown-toolbar-insert">
              <Plus className="size-4" />
            </ToolbarDropdownTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('markdownEditorToolbarInsert')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <ToolbarDropdownItem Icon={LinkIcon} label="Link" active={toolbarState.isLink} disabled={!canUseCommands} onSelect={openToolbarLinkDialog} />
            <ToolbarDropdownItem Icon={ImageIcon} label={labels.items.image.title} disabled={!canUseCommands} onSelect={() => onImageDialogOpenChange(true, getCurrentToolbarRange())} />
            <ToolbarDropdownItem Icon={Table2} label={labels.items.table.title} disabled={!canUseCommands} onSelect={() => onOpenTableDialog(getCurrentToolbarRange())} />
            <ToolbarDropdownItem Icon={SmilePlus} label={labels.items.emoji.title} disabled={!canUseCommands} onSelect={() => onOpenEmojiDialog(getCurrentToolbarRange())} />
            <ToolbarDropdownItem Icon={AtSign} label={labels.items.mention.title} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().insertContent('@').run()} />
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarDropdownTrigger label={t('markdownEditorToolbarFormula')} disabled={!canUseCommands} testId="markdown-toolbar-formula">
              <Sigma className="size-4" />
            </ToolbarDropdownTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('markdownEditorToolbarFormula')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <ToolbarDropdownItem Icon={Sigma} label={labels.items.inlineMath.title} disabled={!canUseCommands} onSelect={() => insertMath('inline')} />
            <ToolbarDropdownItem Icon={SquareSigma} label={labels.items.blockMath.title} disabled={!canUseCommands} onSelect={() => insertMath('block')} />
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarDropdownTrigger label={t('markdownEditorToolbarMore')} disabled={!canUseCommands} testId="markdown-toolbar-more">
              <MoreHorizontal className="size-4" />
            </ToolbarDropdownTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('markdownEditorToolbarMore')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <ToolbarDropdownItem Icon={Strikethrough} label="Strike" active={toolbarState.isStrike} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().toggleStrike().run()} />
            <ToolbarDropdownItem Icon={Highlighter} label={labels.items.highlight.title} active={toolbarState.isHighlight} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().toggleCanvasHighlight().run()} />
            <ToolbarDropdownItem Icon={Code} label="Inline code" active={toolbarState.isCode} disabled={!canUseCommands} onSelect={() => editor?.chain().focus().toggleCode().run()} />
            {showSourceModeSwitch ? (
              <>
                <DropdownMenuSeparator />
                <ToolbarDropdownItem Icon={Code2} label={t('markdownEditorEditAsText')} onSelect={onSourceMode} />
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {toolbarState.isTable ? (
        <div className="tiptap-desktop-editor-toolbar hidden h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2 md:flex">
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
        key={`link-${linkDialogSeed.id}`}
        editor={editor}
        open={linkDialogOpen}
        onOpenChange={handleLinkDialogOpenChange}
        initialHref={linkDialogSeed.href}
        initialText={linkDialogSeed.text}
        canEditText={linkDialogSeed.canEditText}
        sourcePath={filePath}
      />
      <MarkdownImageDialog
        key={`image-${imageDialogSeed.id}`}
        editor={editor}
        filePath={filePath}
        open={imageDialogOpen}
        onOpenChange={onImageDialogOpenChange}
        range={imageDialogSeed.range}
      />
    </TooltipProvider>
  );
}

type MobileMarkdownSheet = 'blocks' | 'styles' | null;

const MOBILE_BLOCK_COMMAND_IDS = new Set<SlashCommandItemId>([
  'text',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'numberedList',
  'taskList',
  'quote',
  'callout',
  'details',
  'footnote',
  'codeBlock',
  'inlineMath',
  'blockMath',
  'table',
  'image',
  'divider',
]);

const MOBILE_STYLE_COMMAND_IDS = new Set<SlashCommandItemId>([
  'text',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'numberedList',
  'taskList',
  'quote',
  'codeBlock',
  'highlight',
  'emoji',
  'mention',
]);

function preserveEditorSelectionOnPointerDown(event: React.PointerEvent<HTMLElement>) {
  event.preventDefault();
}

function useMobileToolbarPress(onPress: () => void, disabled = false) {
  const pressRef = useRef<{
    cancelled: boolean;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const ignoreClickRef = useRef(false);
  const ignoreClickResetRef = useRef<number | null>(null);

  const clearIgnoredClick = useCallback(() => {
    ignoreClickRef.current = false;
    if (ignoreClickResetRef.current !== null) {
      window.clearTimeout(ignoreClickResetRef.current);
      ignoreClickResetRef.current = null;
    }
  }, []);

  useEffect(() => clearIgnoredClick, [clearIgnoredClick]);

  return {
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      if (ignoreClickRef.current && event.detail !== 0) {
        clearIgnoredClick();
        return;
      }
      if (!disabled) onPress();
    },
    onMouseDown: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      if (disabled || event.pointerType === 'mouse' || !event.isPrimary) return;

      pressRef.current = {
        cancelled: false,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement; release validation still prevents stray taps.
      }
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId || press.cancelled) return;

      if (hasMobileToolbarPressMoved(
        { clientX: press.startX, clientY: press.startY },
        { clientX: event.clientX, clientY: event.clientY },
      )) {
        press.cancelled = true;
      }
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      pressRef.current = null;

      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Some WebViews release capture before React receives pointerup.
      }

      const moved = press.cancelled || hasMobileToolbarPressMoved(
        { clientX: press.startX, clientY: press.startY },
        { clientX: event.clientX, clientY: event.clientY },
      );
      const releasedInside = isMobileToolbarReleaseInside(
        event.currentTarget.getBoundingClientRect(),
        { clientX: event.clientX, clientY: event.clientY },
      );
      if (disabled || moved || !releasedInside) return;

      ignoreClickRef.current = true;
      if (ignoreClickResetRef.current !== null) {
        window.clearTimeout(ignoreClickResetRef.current);
      }
      ignoreClickResetRef.current = window.setTimeout(clearIgnoredClick, 0);
      onPress();
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      if (pressRef.current?.pointerId === event.pointerId) {
        pressRef.current = null;
      }
    },
  };
}

function MobileToolbarButton({
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
  const pressHandlers = useMobileToolbarPress(onClick, disabled);

  return (
    <Button
      type="button"
      variant={active ? 'secondary' : 'ghost'}
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(
        'h-10 w-10 shrink-0 rounded-md text-muted-foreground',
        active && 'text-foreground',
      )}
      {...pressHandlers}
    >
      {children}
    </Button>
  );
}

function MobileCommandTile({
  item,
  onPress,
}: {
  item: SlashCommandItem;
  onPress: () => void;
}) {
  const pressHandlers = useMobileToolbarPress(onPress);

  return (
    <button
      type="button"
      className="tiptap-mobile-command-tile"
      {...pressHandlers}
    >
      <item.Icon />
      <span className="min-w-0 truncate">{item.title}</span>
    </button>
  );
}

function MobileMarkdownToolbar({
  actions,
  editor,
  filePath,
  keyboardActive,
  labels,
  onImageDialogOpenChange,
  onOpenEmojiDialog,
  onOpenTableDialog,
  onSourceMode,
  showSourceModeSwitch,
  visible,
}: {
  actions?: SlashCommandActions;
  editor: MarkdownEditorWithMarkdown | null;
  filePath?: string;
  keyboardActive: boolean;
  labels: SlashCommandLabels;
  onImageDialogOpenChange: (open: boolean, range?: Range) => void;
  onOpenEmojiDialog: (range?: Range) => void;
  onOpenTableDialog: (range?: Range | null) => void;
  onSourceMode: () => void;
  showSourceModeSwitch: boolean;
  visible: boolean;
}) {
  const t = useTranslations('notebook');
  const [sheet, setSheet] = useState<MobileMarkdownSheet>(null);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkDialogSeed, setLinkDialogSeed] = useState<LinkDialogSeed>({
    id: 0,
    href: '',
    text: '',
    canEditText: true,
  });
  const savedRangeRef = useRef<Range | null>(null);
  const releaseInteractionTimeoutRef = useRef<number | null>(null);
  const [isInteractingWithToolbar, setIsInteractingWithToolbar] = useState(false);
  const canUseCommands = Boolean(editor?.isEditable);
  const toolbarState = useMarkdownToolbarState(editor);
  const portalElement = getBodyPortalElement();

  const saveCurrentRange = useCallback(() => {
    if (!editor) {
      savedRangeRef.current = null;
      return null;
    }

    const { from, to } = editor.state.selection;
    const range = { from, to };
    savedRangeRef.current = range;
    return range;
  }, [editor]);

  const holdToolbarVisibility = useCallback(() => {
    saveCurrentRange();
    if (releaseInteractionTimeoutRef.current !== null) {
      window.clearTimeout(releaseInteractionTimeoutRef.current);
      releaseInteractionTimeoutRef.current = null;
    }
    setIsInteractingWithToolbar(true);
  }, [saveCurrentRange]);

  const releaseToolbarVisibility = useCallback(() => {
    if (releaseInteractionTimeoutRef.current !== null) {
      window.clearTimeout(releaseInteractionTimeoutRef.current);
    }
    releaseInteractionTimeoutRef.current = window.setTimeout(() => {
      setIsInteractingWithToolbar(false);
      releaseInteractionTimeoutRef.current = null;
    }, MOBILE_TOOLBAR_INTERACTION_GRACE_MS);
  }, []);

  useEffect(() => () => {
    if (releaseInteractionTimeoutRef.current !== null) {
      window.clearTimeout(releaseInteractionTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (keyboardActive) return;
    const frame = window.requestAnimationFrame(() => {
      setSheet(null);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [keyboardActive]);

  useEffect(() => {
    if (!editor) {
      savedRangeRef.current = null;
      return undefined;
    }

    const updateSavedRange = () => {
      if (!editor.isEditable) return;
      saveCurrentRange();
    };

    updateSavedRange();
    editor.on('focus', updateSavedRange);
    editor.on('selectionUpdate', updateSavedRange);
    editor.on('transaction', updateSavedRange);

    return () => {
      editor.off('focus', updateSavedRange);
      editor.off('selectionUpdate', updateSavedRange);
      editor.off('transaction', updateSavedRange);
    };
  }, [editor, saveCurrentRange]);

  const restoreSavedRange = useCallback(() => {
    if (!editor) return null;
    const range = savedRangeRef.current ?? {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    const safeRange = clampEditorRangeToDoc(editor, range);
    if (!safeRange) return null;

    editor.chain().focus().setTextSelection(safeRange).run();
    return safeRange;
  }, [editor]);

  const openSheet = useCallback((nextSheet: Exclude<MobileMarkdownSheet, null>) => {
    saveCurrentRange();
    setSheet((current) => current === nextSheet ? null : nextSheet);
  }, [saveCurrentRange]);

  const runInlineCommand = useCallback((command: (editor: MarkdownEditorWithMarkdown) => void) => {
    if (!editor) return;
    restoreSavedRange();
    command(editor);
  }, [editor, restoreSavedRange]);

  const openLinkDialog = useCallback(() => {
    if (!editor) return;
    const selectedWorkspaceLink = getActiveWorkspaceWikiLink(editor);
    if (!selectedWorkspaceLink) restoreSavedRange();
    const activeLink = getActiveLinkDetails(editor);
    const activeWorkspaceLink = selectedWorkspaceLink ?? getActiveWorkspaceWikiLink(editor);
    setLinkDialogSeed((current) => ({
      id: current.id + 1,
      href: activeWorkspaceLink?.target || activeLink?.href || (editor.getAttributes('link').href as string | undefined) || '',
      text: activeWorkspaceLink?.text || activeLink?.text || getSelectedText(editor),
      canEditText: editor.state.selection.empty && !activeLink && !activeWorkspaceLink,
    }));
    setSheet(null);
    setLinkDialogOpen(true);
  }, [editor, restoreSavedRange]);

  const runCommandItem = useCallback((item: SlashCommandItem) => {
    if (!editor) return;
    const range = restoreSavedRange() ?? { from: editor.state.selection.from, to: editor.state.selection.to };
    setSheet(null);
    item.command({
      actions,
      editor,
      labels,
      range,
    });
  }, [actions, editor, labels, restoreSavedRange]);

  const commandItems = useMemo(() => getLocalizedSlashCommandItems(labels), [labels]);
  const blockItems = useMemo(
    () => commandItems.filter((item) => MOBILE_BLOCK_COMMAND_IDS.has(item.id)),
    [commandItems],
  );
  const styleItems = useMemo(
    () => commandItems.filter((item) => MOBILE_STYLE_COMMAND_IDS.has(item.id)),
    [commandItems],
  );
  const inlineMathItem = useMemo(
    () => commandItems.find((item) => item.id === 'inlineMath'),
    [commandItems],
  );
  const activeSheet = keyboardActive || isInteractingWithToolbar ? sheet : null;
  const sheetItems = activeSheet === 'styles' ? styleItems : blockItems;
  const sheetTitle = activeSheet === 'styles' ? t('markdownEditorMobileTextStyle') : labels.addBlock;
  const toolbarVisible = (keyboardActive && visible)
    || isInteractingWithToolbar
    || activeSheet !== null
    || linkDialogOpen;

  const mobileToolbarOverlay = (
    <>
      {activeSheet ? (
        <div
          className="tiptap-mobile-sheet"
          role="dialog"
          aria-label={sheetTitle}
          onPointerDownCapture={holdToolbarVisibility}
          onPointerUpCapture={releaseToolbarVisibility}
          onPointerCancelCapture={releaseToolbarVisibility}
          onTouchStartCapture={holdToolbarVisibility}
          onTouchEndCapture={releaseToolbarVisibility}
          onTouchCancelCapture={releaseToolbarVisibility}
        >
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <div className="text-sm font-medium text-muted-foreground">{sheetTitle}</div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('markdownEditorMobileCloseTools')}
              onPointerDown={preserveEditorSelectionOnPointerDown}
              onClick={() => setSheet(null)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {sheetItems.map((item) => (
              <MobileCommandTile
                key={item.id}
                item={item}
                onPress={() => runCommandItem(item)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div
        className={cn('tiptap-mobile-toolbar', toolbarVisible && 'tiptap-mobile-toolbar-visible')}
        role="toolbar"
        aria-label={t('markdownEditorMobileToolbar')}
        onPointerDownCapture={holdToolbarVisibility}
        onPointerUpCapture={releaseToolbarVisibility}
        onPointerCancelCapture={releaseToolbarVisibility}
        onTouchStartCapture={holdToolbarVisibility}
        onTouchEndCapture={releaseToolbarVisibility}
        onTouchCancelCapture={releaseToolbarVisibility}
      >
        <MobileToolbarButton label={labels.addBlock} disabled={!canUseCommands} active={activeSheet === 'blocks'} onClick={() => openSheet('blocks')}>
          <Plus className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={t('markdownEditorMobileTextStyle')} disabled={!canUseCommands} active={activeSheet === 'styles'} onClick={() => openSheet('styles')}>
          <span className="text-base font-semibold leading-none">Aa</span>
        </MobileToolbarButton>
        <MobileToolbarButton label={labels.items.bold.title} active={toolbarState.isBold} disabled={!canUseCommands} onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().toggleBold().run())}>
          <Bold className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={labels.items.italic.title} active={toolbarState.isItalic} disabled={!canUseCommands} onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().toggleItalic().run())}>
          <Italic className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={labels.items.strike.title} active={toolbarState.isStrike} disabled={!canUseCommands} onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().toggleStrike().run())}>
          <Strikethrough className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={labels.items.highlight.title} active={toolbarState.isHighlight} disabled={!canUseCommands} onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().toggleCanvasHighlight().run())}>
          <Highlighter className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={t('markdownEditorLinkDialogTitle')} active={toolbarState.isLink} disabled={!canUseCommands} onClick={openLinkDialog}>
          <LinkIcon className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton
          label={labels.items.emoji.title}
          disabled={!canUseCommands}
          onClick={() => {
            const range = restoreSavedRange() ?? saveCurrentRange();
            setSheet(null);
            onOpenEmojiDialog(range ?? undefined);
          }}
        >
          <SmilePlus className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton
          label={labels.items.mention.title}
          disabled={!canUseCommands}
          onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().insertContent('@').run())}
        >
          <AtSign className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton
          label={labels.items.inlineMath.title}
          disabled={!canUseCommands || !inlineMathItem}
          onClick={() => {
            if (inlineMathItem) runCommandItem(inlineMathItem);
          }}
        >
          <Sigma className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={labels.items.inlineCode.title} active={toolbarState.isCode} disabled={!canUseCommands} onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().toggleCode().run())}>
          <Code className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton
          label={labels.items.image.title}
          disabled={!canUseCommands}
          onClick={() => {
            const range = restoreSavedRange() ?? saveCurrentRange();
            setSheet(null);
            onImageDialogOpenChange(true, range ?? undefined);
          }}
        >
          <ImageIcon className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={t('markdownEditorMobileUndo')} disabled={!canUseCommands || !toolbarState.canUndo} onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().undo().run())}>
          <Undo2 className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={t('markdownEditorMobileRedo')} disabled={!canUseCommands || !toolbarState.canRedo} onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().redo().run())}>
          <Redo2 className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton label={labels.items.codeBlock.title} active={toolbarState.isCodeBlock} disabled={!canUseCommands} onClick={() => runInlineCommand((currentEditor) => currentEditor.chain().focus().toggleCodeBlock().run())}>
          <Code2 className="h-5 w-5" />
        </MobileToolbarButton>
        <MobileToolbarButton
          label={labels.items.table.title}
          disabled={!canUseCommands}
          onClick={() => {
            const range = restoreSavedRange();
            setSheet(null);
            onOpenTableDialog(range);
          }}
        >
          <Table2 className="h-5 w-5" />
        </MobileToolbarButton>
        {showSourceModeSwitch ? (
          <MobileToolbarButton label={t('markdownEditorEditAsText')} disabled={!canUseCommands} onClick={onSourceMode}>
            <Type className="h-5 w-5" />
          </MobileToolbarButton>
        ) : null}
        <MobileToolbarButton
          label={t('markdownEditorMobileHideKeyboard')}
          disabled={!canUseCommands}
          onClick={() => {
            setSheet(null);
            editor?.commands.blur();
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
          }}
        >
          <Keyboard className="h-5 w-5" />
        </MobileToolbarButton>
      </div>
    </>
  );

  return (
    <>
      {portalElement ? createPortal(mobileToolbarOverlay, portalElement) : null}
      <MarkdownLinkDialog
        key={`link-${linkDialogSeed.id}`}
        editor={editor}
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        initialHref={linkDialogSeed.href}
        initialText={linkDialogSeed.text}
        canEditText={linkDialogSeed.canEditText}
        sourcePath={filePath}
      />
    </>
  );
}

function RichMarkdownEditor({
  value,
  onChange,
  readOnly,
  filePath,
  externalValueSync = 'always',
  isMobileKeyboardActive,
  onSourceMode,
  markdownNavigationTarget,
  collaborationEnabled = false,
  collaborationDocument,
  agentTargets = [],
  showNotebookMetadata = false,
}: MarkdownEditorProps & {
  isMobileKeyboardActive: boolean;
  markdownNavigationTarget?: WorkspaceMarkdownLocation | null;
  onSourceMode: () => void;
  collaborationDocument?: CollaborationDocument | null;
}) {
  const t = useTranslations('notebook');
  const documentParts = useMemo(() => splitCanvasMarkdownForRichEditor(value), [value]);
  const latestValueRef = useRef(value);
  const acceptedExternalValueRef = useRef(documentParts.body);
  const applyingExternalValueRef = useRef(false);
  const pendingBlockCommandMenuFrameRef = useRef<number | null>(null);
  const appliedNavigationRequestRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableDialogRange, setTableDialogRange] = useState<Range | null>(null);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [imageDialogSeed, setImageDialogSeed] = useState<ImageDialogSeed>({ id: 0 });
  const [emojiDialogOpen, setEmojiDialogOpen] = useState(false);
  const [emojiDialogSeed, setEmojiDialogSeed] = useState<EmojiDialogSeed>({ id: 0 });
  const [richBlockDialog, setRichBlockDialog] = useState<RichBlockDialogSeed | null>(null);
  const [blockCommandMenu, setBlockCommandMenu] = useState<BlockCommandMenuState | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [outlinePinned, setOutlinePinned] = useState(false);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const collaboration = collaborationDocument;
  const collaborationReadOnly = collaborationEnabled && (
    !collaboration?.session
    || collaboration.session.permission !== 'write'
    || collaboration.status === 'degraded'
  );
  const effectiveReadOnly = readOnly || collaborationReadOnly;
  const labels = useMemo(() => createSlashCommandLabels(t), [t]);
  const wikiLabels = useMemo(() => ({
    empty: t('markdownEditorWikiNoMatch'),
    group: t('markdownEditorWikiSuggestions'),
  }), [t]);
  const mentionLabels = useMemo(() => ({
    empty: t('markdownEditorMentionNoMatch'),
    group: t('markdownEditorMentionSuggestions'),
  }), [t]);
  const openImageDialogFromToolbar = useCallback((open: boolean, range?: Range) => {
    if (open) {
      setImageDialogSeed((current) => ({ id: current.id + 1, range }));
    }
    setImageDialogOpen(open);
  }, []);
  const openEmojiDialogFromToolbar = useCallback((range?: Range) => {
    setEmojiDialogSeed((current) => ({ id: current.id + 1, range }));
    setEmojiDialogOpen(true);
  }, []);
  const openTableDialogAtRange = useCallback((range?: Range | null) => {
    setTableDialogRange(range ?? null);
    setTableDialogOpen(true);
  }, []);
  const handleTableDialogOpenChange = useCallback((open: boolean) => {
    setTableDialogOpen(open);
    if (!open) setTableDialogRange(null);
  }, []);
  const openRichBlockDialog = useCallback((
    kind: RichBlockKind,
    targetEditor: Editor,
    range?: Range,
  ) => {
    const safeRange = range ? clampEditorRangeToDoc(targetEditor, range) ?? undefined : undefined;
    const selectedText = safeRange ? targetEditor.state.doc.textBetween(safeRange.from, safeRange.to, ' ') : '';
    const selectedNodePosition = kind === 'callout'
      ? findSelectedRichBlockPosition(targetEditor, 'canvasCallout')
      : kind === 'details'
        ? findSelectedRichBlockPosition(targetEditor, 'canvasDetails')
        : null;

    if (kind === 'callout' && selectedNodePosition !== null) {
      const node = targetEditor.state.doc.nodeAt(selectedNodePosition);
      setRichBlockDialog((current) => ({
        id: (current?.id ?? 0) + 1,
        kind,
        nodePosition: selectedNodePosition,
        initialCalloutType: String(node?.attrs.calloutType ?? 'note'),
        initialTitle: getRichBlockTitle(targetEditor, selectedNodePosition, 'canvasCalloutTitle'),
      }));
      return;
    }

    if (kind === 'details' && selectedNodePosition !== null) {
      const node = targetEditor.state.doc.nodeAt(selectedNodePosition);
      setRichBlockDialog((current) => ({
        id: (current?.id ?? 0) + 1,
        kind,
        nodePosition: selectedNodePosition,
        initialOpen: Boolean(node?.attrs.open),
        initialTitle: getRichBlockTitle(targetEditor, selectedNodePosition, 'canvasDetailsSummary'),
      }));
      return;
    }

    if (kind === 'footnote') {
      const footnoteId = getSelectedFootnoteId(targetEditor);
      if (footnoteId) {
        const definitionPosition = findFootnoteDefinitionPosition(targetEditor, footnoteId);
        const definition = definitionPosition === null ? null : targetEditor.state.doc.nodeAt(definitionPosition);
        setRichBlockDialog((current) => ({
          id: (current?.id ?? 0) + 1,
          kind,
          footnoteId,
          initialContent: definition?.textContent ?? '',
        }));
        return;
      }
    }

    setRichBlockDialog((current) => ({
      id: (current?.id ?? 0) + 1,
      kind,
      range: safeRange,
      initialContent: kind === 'callout' || kind === 'details' || kind === 'footnote' ? selectedText : undefined,
      initialLatex: kind === 'inlineMath' || kind === 'blockMath' ? selectedText : undefined,
    }));
  }, []);
  const openRichBlockDialogFromSlash = useCallback((kind: RichBlockKind, slashEditor: Editor, range: Range) => {
    const insertionRange = prepareCommandDialogInsertionRange(slashEditor, range);
    if (!insertionRange) return;
    openRichBlockDialog(kind, slashEditor, insertionRange);
  }, [openRichBlockDialog]);
  const openImageDialogFromSlash = useCallback((slashEditor: Editor, range: Range) => {
    const insertionRange = prepareCommandDialogInsertionRange(slashEditor, range);
    const insertPosition = insertionRange?.from ?? slashEditor.state.selection.from;

    setImageDialogSeed((current) => ({
      id: current.id + 1,
      range: { from: insertPosition, to: insertPosition },
    }));
    setImageDialogOpen(true);
  }, []);
  const openEmojiDialogFromSlash = useCallback((slashEditor: Editor, range: Range) => {
    const insertionRange = prepareCommandDialogInsertionRange(slashEditor, range);
    const insertPosition = insertionRange?.from ?? slashEditor.state.selection.from;
    setEmojiDialogSeed((current) => ({
      id: current.id + 1,
      range: { from: insertPosition, to: insertPosition },
    }));
    setEmojiDialogOpen(true);
  }, []);
  const openTableDialogFromSlash = useCallback((slashEditor: Editor, range: Range) => {
    const insertionRange = prepareCommandDialogInsertionRange(slashEditor, range);
    const insertPosition = insertionRange?.from ?? slashEditor.state.selection.from;

    openTableDialogAtRange({ from: insertPosition, to: insertPosition });
  }, [openTableDialogAtRange]);
  const editMath = useCallback((kind: 'inline' | 'block', latex: string, pos: number) => {
    setRichBlockDialog((current) => ({
      id: (current?.id ?? 0) + 1,
      kind: kind === 'inline' ? 'inlineMath' : 'blockMath',
      nodePosition: pos,
      initialLatex: latex,
    }));
  }, []);
  const slashCommandActions = useMemo<SlashCommandActions>(
    () => ({
      editMath,
      openRichBlockDialog: openRichBlockDialogFromSlash,
      openEmojiDialog: openEmojiDialogFromSlash,
      openImageDialog: openImageDialogFromSlash,
      openTableDialog: openTableDialogFromSlash,
    }),
    [editMath, openEmojiDialogFromSlash, openImageDialogFromSlash, openRichBlockDialogFromSlash, openTableDialogFromSlash],
  );
  const remoteCaretLabel = useCallback(
    (name: string) => t('collaboration.remoteCaretLabel', { name }),
    [t],
  );
  const extensions = useMemo(
    () => createEditorExtensions(
      filePath,
      labels,
      slashCommandActions,
      activeWorkspaceId,
      wikiLabels,
      mentionLabels,
      collaboration,
      remoteCaretLabel,
    ),
    [
      activeWorkspaceId,
      collaboration,
      filePath,
      labels,
      mentionLabels,
      remoteCaretLabel,
      slashCommandActions,
      wikiLabels,
    ],
  );

  const editor = useEditor({
    extensions,
    content: collaborationEnabled ? undefined : documentParts.body,
    contentType: 'markdown',
    editable: !effectiveReadOnly,
    immediatelyRender: false,
    // Tiptap's createView reads editorProps synchronously; passing an explicit
    // undefined during the pre-session render overrides its default object.
    editorProps: collaboration ? {
      handleDOMEvents: {
        compositionstart: (view) => {
          const selection = view.state.selection;
          collaboration.setComposition({
            textName: 'body',
            from: selection.from,
            to: selection.to,
          });
          return false;
        },
        compositionend: () => {
          collaboration.setComposition(null);
          return false;
        },
        blur: () => {
          collaboration.setComposition(null);
          return false;
        },
      },
    } : {},
    onUpdate: ({ editor: updateEditor }) => {
      if (effectiveReadOnly || applyingExternalValueRef.current) return;

      const markdownEditor = asMarkdownEditor(updateEditor);
      const markdown = markdownEditor?.getMarkdown() ?? '';
      const currentParts = splitCanvasMarkdownForRichEditor(latestValueRef.current);
      const nextValue = composeCanvasMarkdownDocument(
        currentParts.prefix,
        restoreRichMarkdownFinalLineEnding(currentParts.body, markdown),
      );
      if (nextValue !== latestValueRef.current) {
        latestValueRef.current = nextValue;
        onChange?.(nextValue);
      }
    },
  }, [collaboration?.provider]);

  useEffect(() => {
    if (!editor || !collaboration) return;
    updateAgentTargetDecorations(editor, agentTargets);
  }, [agentTargets, collaboration, editor]);

  const openRichBlockDialogFromToolbar = useCallback((kind: RichBlockKind, range?: Range) => {
    if (!editor) return;
    openRichBlockDialog(kind, editor, range ?? {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    });
  }, [editor, openRichBlockDialog]);

  const handlePropertiesChange = useCallback((nextValue: string) => {
    if (collaborationEnabled && collaboration) {
      const prefix = splitCanvasMarkdownForRichEditor(nextValue).prefix;
      const frontmatter = collaboration.doc.getText('frontmatter');
      collaboration.doc.transact(() => {
        if (frontmatter.length) frontmatter.delete(0, frontmatter.length);
        if (prefix) frontmatter.insert(0, prefix);
      }, 'canvas-properties');
    }
    latestValueRef.current = nextValue;
    onChange?.(nextValue);
  }, [collaboration, collaborationEnabled, onChange]);

  useEffect(() => {
    if (!collaboration) return;
    const frontmatter = collaboration.doc.getText('frontmatter');
    const updateValue = () => {
      const currentParts = splitCanvasMarkdownForRichEditor(latestValueRef.current);
      const body = restoreRichMarkdownFinalLineEnding(
        currentParts.body,
        asMarkdownEditor(editor)?.getMarkdown() ?? '',
      );
      const nextValue = composeCanvasMarkdownDocument(frontmatter.toString(), body);
      latestValueRef.current = nextValue;
      onChange?.(nextValue);
    };
    frontmatter.observe(updateValue);
    return () => frontmatter.unobserve(updateValue);
  }, [collaboration, editor, onChange]);

  const markdownEditor = asMarkdownEditor(editor);
  const submitRichBlockDialog = useCallback((submission: RichBlockDialogSubmission) => {
    if (!editor || !richBlockDialog || editor.isDestroyed || !editor.isEditable) return;

    const seed = richBlockDialog;
    if (submission.kind === 'callout') {
      if (seed.nodePosition !== undefined) {
        replaceRichBlockTitle(
          editor,
          seed.nodePosition,
          'canvasCallout',
          'canvasCalloutTitle',
          submission.title,
          { calloutType: submission.calloutType },
        );
      } else {
        editor.chain().focus().insertCanvasCallout({
          title: submission.title,
          type: submission.calloutType,
          content: submission.content,
          range: seed.range,
        }).run();
      }
    } else if (submission.kind === 'details') {
      if (seed.nodePosition !== undefined) {
        replaceRichBlockTitle(
          editor,
          seed.nodePosition,
          'canvasDetails',
          'canvasDetailsSummary',
          submission.title,
          { open: submission.open },
        );
      } else {
        editor.chain().focus().insertCanvasDetails({
          summary: submission.title,
          content: submission.content,
          open: submission.open,
          range: seed.range,
        }).run();
      }
    } else if (submission.kind === 'footnote') {
      if (seed.footnoteId) {
        updateFootnoteDefinition(editor, seed.footnoteId, submission.content);
      } else {
        editor.chain().focus().insertMarkdownFootnote({
          content: submission.content,
          range: seed.range,
        }).run();
      }
    } else if (seed.nodePosition !== undefined) {
      if (submission.kind === 'inlineMath') {
        editor.chain().focus().updateInlineMath({ latex: submission.latex, pos: seed.nodePosition }).run();
      } else {
        editor.chain().focus().updateBlockMath({ latex: submission.latex, pos: seed.nodePosition }).run();
      }
    } else {
      insertMathAtRange(editor, submission.kind, submission.latex, seed.range);
    }

    setRichBlockDialog(null);
  }, [editor, richBlockDialog]);
  useEffect(() => {
    if (
      !editor
      || !markdownNavigationTarget?.heading
      || appliedNavigationRequestRef.current === markdownNavigationTarget.requestId
    ) return;

    const wantedHeading = markdownNavigationTarget.heading.trim().toLocaleLowerCase();
    const nextAnchor = createMarkdownHeadingAnchorFactory();
    let headingPosition: number | null = null;
    editor.state.doc.descendants((node, position) => {
      const headingAnchor = node.type.name === 'heading' ? nextAnchor(node.textContent) : null;
      if (
        headingPosition === null
        && node.type.name === 'heading'
        && (
          node.textContent.trim().toLocaleLowerCase() === wantedHeading
          || headingAnchor === wantedHeading
        )
      ) {
        headingPosition = position + 1;
        return false;
      }
      return headingPosition === null;
    });
    if (headingPosition === null) return;

    appliedNavigationRequestRef.current = markdownNavigationTarget.requestId;
    editor.chain().focus().setTextSelection(headingPosition).scrollIntoView().run();
  }, [editor, markdownNavigationTarget]);
  const isRichEditorFocused = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => Boolean(currentEditor?.isFocused),
  }) ?? false;
  const isMobileToolbarVisible = Boolean(isRichEditorFocused && isMobileKeyboardActive);

  const insertTable = useCallback((options: TableInsertOptions) => {
    if (!editor) return;
    const safeRange = tableDialogRange ? clampEditorRangeToDoc(editor, tableDialogRange) : null;
    const chain = editor.chain().focus();
    if (safeRange) {
      chain.setTextSelection(safeRange);
    }
    chain.insertTable(options).run();
    handleTableDialogOpenChange(false);
  }, [editor, handleTableDialogOpenChange, tableDialogRange]);

  const cancelPendingBlockCommandMenu = useCallback(() => {
    if (pendingBlockCommandMenuFrameRef.current === null) return;
    window.cancelAnimationFrame(pendingBlockCommandMenuFrameRef.current);
    pendingBlockCommandMenuFrameRef.current = null;
  }, []);

  const closeBlockCommandMenu = useCallback(() => {
    cancelPendingBlockCommandMenu();
    setBlockCommandMenu(null);
  }, [cancelPendingBlockCommandMenu]);

  const openBlockCommandMenuAtRange = useCallback((blockEditor: Editor, range: Range) => {
    cancelPendingBlockCommandMenu();
    setBlockCommandMenu(null);

    if (!isEditorRangeInsideDoc(blockEditor, range)) return;

    pendingBlockCommandMenuFrameRef.current = window.requestAnimationFrame(() => {
      pendingBlockCommandMenuFrameRef.current = null;
      if (!blockEditor.isEditable || !isEditorRangeInsideDoc(blockEditor, range)) return;

      const menuState = createBlockCommandMenuState(blockEditor, range);
      if (menuState) {
        setBlockCommandMenu(menuState);
      }
    });
  }, [cancelPendingBlockCommandMenu]);

  const openInsertedBlockCommandMenu = useCallback((
    blockEditor: Editor,
    placement: BlockInsertPlacement,
    blockRange?: ReorderableBlockRange,
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

  useEffect(() => () => {
    cancelPendingBlockCommandMenu();
  }, [cancelPendingBlockCommandMenu]);

  useEffect(() => {
    if (collaborationEnabled) return;
    if (!markdownEditor) return;

    const currentMarkdown = markdownEditor.getMarkdown();
    const hasLocalChanges = currentMarkdown !== acceptedExternalValueRef.current;
    const parentAcceptedLocalChanges = value === latestValueRef.current;
    const shouldDeferExternalSync =
      externalValueSync === 'when-blurred' &&
      !readOnly &&
      markdownEditor.isFocused &&
      hasLocalChanges &&
      !parentAcceptedLocalChanges;

    if (shouldDeferExternalSync) return;

    acceptedExternalValueRef.current = documentParts.body;
    latestValueRef.current = value;

    if (currentMarkdown === documentParts.body) return;

    applyingExternalValueRef.current = true;
    markdownEditor.commands.setContent(documentParts.body, {
      contentType: 'markdown',
      emitUpdate: false,
    });
    applyingExternalValueRef.current = false;
  }, [collaborationEnabled, documentParts.body, externalValueSync, markdownEditor, readOnly, value]);

  useEffect(() => {
    editor?.setEditable(!effectiveReadOnly);
  }, [editor, effectiveReadOnly]);

  useEffect(() => {
    if (!editor) return undefined;
    const editorElement = editor.options.element;
    if (!(editorElement instanceof HTMLElement)) return undefined;

    const handleWorkspaceLinkClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!anchor || !editorElement.contains(anchor)) return;

      const href = anchor.getAttribute('href') ?? '';
      if (markdownHeadingAnchorFromHref(href)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        scrollToMarkdownHeadingAnchor(editorElement, href);
        return;
      }
      const workspaceTarget = getWorkspaceMarkdownNavigationTarget(href, filePath);
      if (!workspaceTarget) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      void openWorkspaceMarkdownTarget({
        sourcePath: filePath,
        target: workspaceTarget,
        workspaceId: activeWorkspaceId,
      }).then((result) => {
        if (!['opened', 'superseded'].includes(result.status)) {
          toast.error(result.error ?? t('markdownEditorLinkOpenError'));
        }
      });
    };

    editorElement.addEventListener('click', handleWorkspaceLinkClick, true);
    return () => editorElement.removeEventListener('click', handleWorkspaceLinkClick, true);
  }, [activeWorkspaceId, editor, filePath, t]);

  useEffect(() => {
    if (!editor) return undefined;
    const editorElement = editor.options.element;
    if (!(editorElement instanceof HTMLElement)) return undefined;

    const getDetailsPosition = (details: HTMLDetailsElement) => {
      const detailsId = details.dataset.id;
      if (detailsId) {
        let matchingPosition: number | null = null;
        editor.state.doc.descendants((node, position) => {
          if (node.type.name === 'canvasDetails' && String(node.attrs.id ?? '') === detailsId) {
            matchingPosition = position;
            return false;
          }
          return true;
        });
        if (matchingPosition !== null) return matchingPosition;
      }

      try {
        const resolved = editor.state.doc.resolve(editor.view.posAtDOM(details, 0));
        for (let depth = resolved.depth; depth > 0; depth -= 1) {
          if (resolved.node(depth).type.name === 'canvasDetails') {
            return resolved.before(depth);
          }
        }
      } catch {
        // Ignore clicks while ProseMirror is reconciling a DOM update.
      }
      return null;
    };

    const setDetailsOpen = (details: HTMLDetailsElement, open: boolean) => {
      const position = getDetailsPosition(details);
      if (position === null) return;

      const node = editor.state.doc.nodeAt(position);
      if (!node || node.type.name !== 'canvasDetails' || Boolean(node.attrs.open) === open) return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(position, node.type, {
        ...node.attrs,
        open,
      }));
    };

    const handleDetailsToggle = (event: Event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !editorElement.contains(details)) return;
      if (details.dataset.type !== 'canvas-details') return;
      setDetailsOpen(details, details.open);
    };

    const handleDetailsSummaryClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const summary = target.closest('summary[data-type="canvas-details-summary"]');
      if (!summary || !editorElement.contains(summary)) return;
      const details = summary.closest('details[data-type="canvas-details"]');
      if (!(details instanceof HTMLDetailsElement)) return;

      event.preventDefault();
      const position = getDetailsPosition(details);
      if (position === null) return;
      const node = editor.state.doc.nodeAt(position);
      if (!node || node.type.name !== 'canvasDetails') return;
      setDetailsOpen(details, !Boolean(node.attrs.open));
    };

    editorElement.addEventListener('toggle', handleDetailsToggle, true);
    editorElement.addEventListener('click', handleDetailsSummaryClick, true);
    return () => {
      editorElement.removeEventListener('toggle', handleDetailsToggle, true);
      editorElement.removeEventListener('click', handleDetailsSummaryClick, true);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return undefined;
    const editorElement = editor.options.element;
    if (!(editorElement instanceof HTMLElement)) return undefined;

    const focusFootnoteDefinition = (reference: Element) => {
      const footnoteId = reference.getAttribute('data-footnote-id');
      if (!footnoteId) return;
      const definitionPosition = findFootnoteDefinitionPosition(editor, footnoteId);
      if (definitionPosition === null) return;
      editor.chain().focus().setTextSelection(definitionPosition + 1).scrollIntoView().run();
    };

    const handleFootnoteClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const reference = target.closest('sup[data-type="markdown-footnote-reference"]');
      if (!reference || !editorElement.contains(reference)) return;

      event.preventDefault();
      event.stopPropagation();
      focusFootnoteDefinition(reference);
    };
    const handleFootnoteKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target;
      if (!(target instanceof Element) || !target.matches('sup[data-type="markdown-footnote-reference"]')) return;

      event.preventDefault();
      focusFootnoteDefinition(target);
    };

    editorElement.addEventListener('click', handleFootnoteClick, true);
    editorElement.addEventListener('keydown', handleFootnoteKeyDown, true);
    return () => {
      editorElement.removeEventListener('click', handleFootnoteClick, true);
      editorElement.removeEventListener('keydown', handleFootnoteKeyDown, true);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return undefined;

    const editorElement = editor.options.element;
    if (!(editorElement instanceof HTMLElement)) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();

      if (key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        setFindOpen(true);
        return;
      }

      if (key === 'g' && findOpen) {
        event.preventDefault();
        event.stopPropagation();
        moveMarkdownSearchSelection(editor, event.shiftKey ? -1 : 1);
        return;
      }

      if (event.key !== '/' || effectiveReadOnly) return;

      event.preventDefault();
      event.stopPropagation();
      openCurrentBlockCommandMenu(editor);
    };

    editorElement.addEventListener('keydown', handleKeyDown, true);
    return () => editorElement.removeEventListener('keydown', handleKeyDown, true);
  }, [editor, effectiveReadOnly, findOpen, openCurrentBlockCommandMenu]);

  useEffect(() => {
    if (!effectiveReadOnly) return undefined;

    const frame = window.requestAnimationFrame(() => {
      closeBlockCommandMenu();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [closeBlockCommandMenu, effectiveReadOnly]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {!effectiveReadOnly ? (
        <MarkdownToolbar
          editor={markdownEditor}
          filePath={filePath}
          imageDialogOpen={imageDialogOpen}
          imageDialogSeed={imageDialogSeed}
          labels={labels}
          onOpenEmojiDialog={openEmojiDialogFromToolbar}
          onOpenRichBlockDialog={openRichBlockDialogFromToolbar}
          onSourceMode={onSourceMode}
          showSourceModeSwitch={!collaborationEnabled}
          onImageDialogOpenChange={openImageDialogFromToolbar}
          onOpenTableDialog={openTableDialogAtRange}
        />
      ) : null}
      {!effectiveReadOnly ? (
        <MarkdownTableDialog open={tableDialogOpen} onOpenChange={handleTableDialogOpenChange} onInsert={insertTable} />
      ) : null}
      {!effectiveReadOnly && richBlockDialog ? (
        <MarkdownRichBlockDialog
          key={`rich-block-${richBlockDialog.id}`}
          open
          onOpenChange={(open) => {
            if (!open) setRichBlockDialog(null);
          }}
          seed={richBlockDialog}
          onSubmit={submitRichBlockDialog}
        />
      ) : null}
      {!effectiveReadOnly ? (
        <MarkdownEmojiDialog
          key={emojiDialogSeed.id}
          editor={markdownEditor}
          onOpenChange={setEmojiDialogOpen}
          open={emojiDialogOpen}
          range={emojiDialogSeed.range}
        />
      ) : null}
      {!effectiveReadOnly ? (
        <MobileMarkdownToolbar
          actions={slashCommandActions}
          editor={markdownEditor}
          filePath={filePath}
          keyboardActive={isMobileKeyboardActive}
          labels={labels}
          onImageDialogOpenChange={openImageDialogFromToolbar}
          onOpenEmojiDialog={openEmojiDialogFromToolbar}
          onOpenTableDialog={openTableDialogAtRange}
          onSourceMode={onSourceMode}
          showSourceModeSwitch={!collaborationEnabled}
          visible={isMobileToolbarVisible}
        />
      ) : null}
      <MarkdownFindBar editor={markdownEditor} onOpenChange={setFindOpen} open={findOpen} />
      <div ref={scrollContainerRef} data-testid="markdown-scroll-container" className="relative min-h-0 flex-1 overflow-auto">
        <div className="pointer-events-none sticky top-2 z-30 ml-auto flex h-0 w-fit items-start gap-2 pr-3">
          {collaborationEnabled ? (
            <div className="rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground shadow-sm" role="status">
              {collaboration?.status === 'degraded'
                ? collaboration.error || t('collaboration.degraded')
                : collaboration?.status === 'saved' || collaboration?.status === 'live'
                  ? t('collaboration.live')
                  : collaboration?.status === 'persisting'
                    ? t('collaboration.persisting')
                    : collaboration?.status === 'offline' || collaboration?.status === 'reconnecting'
                      ? t('collaboration.offline')
                  : collaboration?.status === 'read_only'
                    ? t('collaboration.readOnly')
                    : collaboration?.status || t('collaboration.connecting')}
            </div>
          ) : null}
          <MarkdownOutlinePanel
            editor={editor}
            onPinnedChange={setOutlinePinned}
            pinned={outlinePinned}
            scrollContainerRef={scrollContainerRef}
          />
        </div>
        <div className={cn('min-w-0 transition-[padding] duration-200', outlinePinned && 'md:pr-[17.5rem]')}>
          {!effectiveReadOnly ? (
            <div className="hidden md:block">
              <TooltipProvider>
                <MarkdownBlockControls
                  editor={editor}
                  labels={labels}
                  onAddBlock={openInsertedBlockCommandMenu}
                  onOpenCommandMenu={openCurrentBlockCommandMenu}
                  scrollContainerRef={scrollContainerRef}
                />
              </TooltipProvider>
            </div>
          ) : null}
          {showNotebookMetadata ? (
            <MarkdownPropertiesPanel
              filePath={filePath}
              onChange={handlePropertiesChange}
              readOnly={effectiveReadOnly}
              value={value}
            />
          ) : null}
          <EditorContent editor={editor} className="tiptap-editor-shell" />
          <MarkdownBacklinksPanel filePath={filePath} />
          {!effectiveReadOnly && editor && blockCommandMenu ? (
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
      <MarkdownDocumentStatus
        onSearch={() => setFindOpen((current) => !current)}
        searchActive={findOpen}
        value={value}
      />
    </div>
  );
}

function SourceMarkdownEditor({
  initiallyShowMobileToolbar = false,
  richModeAvailable,
  value,
  onChange,
  readOnly,
  filePath,
  isMobileKeyboardActive,
  onRichMode,
  markdownNavigationTarget,
  collaborationEnabled = false,
  collaborationSession,
  collaborationDocument,
  agentTargets = [],
  sourceModeReason,
  normalizationAvailable,
  onNormalizeToRichMode,
  isPresentationDocument,
}: MarkdownEditorProps & {
  initiallyShowMobileToolbar?: boolean;
  richModeAvailable: boolean;
  isMobileKeyboardActive: boolean;
  markdownNavigationTarget?: WorkspaceMarkdownLocation | null;
  onRichMode: () => void;
  sourceModeReason?: MarkdownRichModeReason;
  normalizationAvailable: boolean;
  onNormalizeToRichMode: () => void;
  isPresentationDocument: boolean;
  collaborationDocument?: CollaborationDocument | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const t = useTranslations('notebook');
  const releaseInteractionTimeoutRef = useRef<number | null>(null);
  const [isSourceFocused, setIsSourceFocused] = useState(initiallyShowMobileToolbar);
  const [isInteractingWithToolbar, setIsInteractingWithToolbar] = useState(false);
  const mobileToolbarVisible = isMobileKeyboardActive && (isSourceFocused || isInteractingWithToolbar);
  const sourceModeNotice = sourceModeReason
    ? getMarkdownSourceModeNotice(sourceModeReason, isPresentationDocument)
    : null;

  const holdToolbarVisibility = useCallback(() => {
    if (releaseInteractionTimeoutRef.current !== null) {
      window.clearTimeout(releaseInteractionTimeoutRef.current);
      releaseInteractionTimeoutRef.current = null;
    }
    setIsInteractingWithToolbar(true);
  }, []);

  const releaseToolbarVisibility = useCallback(() => {
    if (releaseInteractionTimeoutRef.current !== null) {
      window.clearTimeout(releaseInteractionTimeoutRef.current);
    }
    releaseInteractionTimeoutRef.current = window.setTimeout(() => {
      setIsInteractingWithToolbar(false);
      releaseInteractionTimeoutRef.current = null;
    }, 350);
  }, []);

  useEffect(() => () => {
    if (releaseInteractionTimeoutRef.current !== null) {
      window.clearTimeout(releaseInteractionTimeoutRef.current);
    }
  }, []);

  const handleBlurCapture = useCallback(() => {
    window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      setIsSourceFocused(Boolean(
        activeElement instanceof Node &&
        containerRef.current?.contains(activeElement),
      ));
    });
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      onBlurCapture={handleBlurCapture}
      onFocusCapture={() => setIsSourceFocused(true)}
    >
      {!readOnly ? (
        <MarkdownSourceToolbar
          richModeAvailable={richModeAvailable}
          showRichModeSwitch={!collaborationEnabled}
          mobileVisible={mobileToolbarVisible}
          onMobilePointerCancel={releaseToolbarVisibility}
          onMobilePointerDown={holdToolbarVisibility}
          onMobilePointerUp={releaseToolbarVisibility}
          onRichMode={onRichMode}
        />
      ) : null}
      {sourceModeReason ? (
        <div
          className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
          data-testid="markdown-source-preservation-warning"
          role="status"
        >
          <BadgeInfo aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <span>{t(sourceModeNotice === 'presentation'
            ? 'markdownEditorPresentationSourcePreservationNotice'
            : 'markdownEditorSourcePreservationNotice')}</span>
        </div>
      ) : null}
      {normalizationAvailable ? (
        <div
          className="mx-3 mt-3 flex flex-col gap-2 rounded-md border border-primary/35 bg-primary/8 px-3 py-2.5 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between"
          data-testid="markdown-safe-normalization-notice"
          role="status"
        >
          <div className="flex min-w-0 items-start gap-2">
            <BadgeInfo aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>{t('markdownEditorSafeNormalizationNotice')}</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 self-start bg-background/80 sm:self-auto"
            data-testid="markdown-normalize-rich-text"
            onClick={onNormalizeToRichMode}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
            {t('markdownEditorNormalizeAndOpenRichText')}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeEditor
          value={value}
          onChange={(nextValue) => {
            if (!readOnly) onChange?.(nextValue);
          }}
          readOnly={readOnly}
          path={filePath ?? 'document.md'}
          markdownNavigationTarget={markdownNavigationTarget}
          collaborationEnabled={collaborationEnabled}
          collaborationSession={collaborationSession}
          collaborationDocument={collaborationDocument}
          agentTargets={agentTargets}
        />
      </div>
      <MarkdownDocumentStatus value={value} />
    </div>
  );
}

export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  filePath,
  externalValueSync = 'always',
  collaborationEnabled = false,
  onCollaborationChange,
  agentTargets = [],
  showNotebookMetadata = false,
}: MarkdownEditorProps) {
  useVisualViewportBottomOffset();

  const t = useTranslations('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const collaborationSession = useTextCollaborationSession({
    enabled: collaborationEnabled,
    workspaceId: activeWorkspaceId,
    path: filePath,
  });
  const resolvedCollaborationSession = collaborationSession.session;
  const collaborationDocument = useCollaborationDocument({
    enabled: collaborationEnabled && Boolean(resolvedCollaborationSession),
    workspaceId: activeWorkspaceId,
    path: filePath,
    representation: resolvedCollaborationSession?.representation === 'plain_text'
      ? 'plain_text'
      : 'tiptap_xml',
    session: resolvedCollaborationSession,
  });
  const isMobileKeyboardActive = useMobileKeyboardActive();
  const parsedDocument = useMemo(() => parseCanvasMarkdownDocument(value), [value]);
  const richModeAnalysis = useMemo(() => analyzeMarkdownRichMode(value), [value]);
  const sourceModeRequired = richModeAnalysis.mode !== 'rich';
  const isPresentationDocument = useMemo(
    () => Boolean(filePath && isMarpMarkdown(filePath, value)),
    [filePath, value],
  );
  const [mode, setMode] = useState<EditorMode>(() => (
    sourceModeRequired || shouldDefaultToSource(readOnly, filePath) ? 'source' : 'rich'
  ));
  const [sourceModeRequested, setSourceModeRequested] = useState(false);
  const [markdownNavigationTarget, setMarkdownNavigationTarget] = useState<WorkspaceMarkdownLocation | null>(() => (
    filePath ? consumeWorkspaceMarkdownLocation(filePath) : null
  ));
  const authoritativeRepresentation = collaborationSession.session?.representation;
  const effectiveMode: EditorMode = collaborationEnabled && authoritativeRepresentation
    ? authoritativeRepresentation === 'plain_text' ? 'source' : 'rich'
    : sourceModeRequired ? 'source' : mode;

  useEffect(() => {
    onCollaborationChange?.(collaborationDocument);
    return () => onCollaborationChange?.(null);
  }, [collaborationDocument, onCollaborationChange]);

  useEffect(() => {
    if (!filePath) return;
    const normalizedFilePath = filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    let cancelled = false;
    queueMicrotask(() => {
      const pendingLocation = consumeWorkspaceMarkdownLocation(normalizedFilePath);
      if (!cancelled && pendingLocation) setMarkdownNavigationTarget(pendingLocation);
    });

    const handleLocation = (event: Event) => {
      const location = getWorkspaceMarkdownLocationFromEvent(event);
      if (location?.path === normalizedFilePath) setMarkdownNavigationTarget(location);
    };
    window.addEventListener(WORKSPACE_MARKDOWN_LOCATION_EVENT, handleLocation);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKSPACE_MARKDOWN_LOCATION_EVENT, handleLocation);
    };
  }, [filePath]);

  const switchToSourceMode = useCallback(() => {
    if (collaborationEnabled) return;
    setSourceModeRequested(true);
    setMode('source');
  }, [collaborationEnabled]);

  const switchToRichMode = useCallback(() => {
    if (sourceModeRequired || collaborationEnabled) return;
    setSourceModeRequested(false);
    setMode('rich');
  }, [collaborationEnabled, sourceModeRequired]);

  const normalizeToRichMode = useCallback(() => {
    if (readOnly || collaborationEnabled || richModeAnalysis.mode !== 'normalizable') return;
    onChange?.(composeCanvasMarkdownDocument(
      richModeAnalysis.prefix,
      richModeAnalysis.normalizedBody,
    ));
    setSourceModeRequested(false);
    setMode('rich');
    toast.success(t('markdownEditorNormalizedForRichText'));
  }, [collaborationEnabled, onChange, readOnly, richModeAnalysis, t]);

  if (collaborationEnabled && (!collaborationSession.session || !collaborationDocument?.ready)) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <p className="text-sm text-muted-foreground" role="status">
          {collaborationSession.error || t('collaboration.connecting')}
        </p>
        {collaborationSession.error ? (
          <Button size="sm" variant="outline" onClick={collaborationSession.retry}>
            {t('externalChangeReload')}
          </Button>
        ) : null}
      </div>
    );
  }

  if (readOnly && effectiveMode === 'source') {
    return (
      <div className="h-full min-h-0 overflow-auto bg-background">
        {showNotebookMetadata && !parsedDocument.error ? (
          <MarkdownPropertiesPanel
            filePath={filePath}
            readOnly
            value={value}
          />
        ) : null}
        <MarkdownRenderer
          content={parsedDocument.error ? value : parsedDocument.body}
          sourcePath={filePath}
          className="min-h-full p-5 text-base leading-relaxed md:pl-[4.75rem] [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-xl [&_h3]:font-semibold"
        />
        <MarkdownBacklinksPanel filePath={filePath} />
      </div>
    );
  }

  if (effectiveMode === 'source') {
    return (
      <SourceMarkdownEditor
        initiallyShowMobileToolbar={sourceModeRequested}
        richModeAvailable={!sourceModeRequired && !collaborationEnabled}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        filePath={filePath}
        isMobileKeyboardActive={isMobileKeyboardActive}
        onRichMode={switchToRichMode}
        markdownNavigationTarget={markdownNavigationTarget}
        collaborationEnabled={collaborationEnabled}
        collaborationSession={collaborationSession.session}
        collaborationDocument={collaborationDocument}
        agentTargets={agentTargets}
        sourceModeReason={richModeAnalysis.mode === 'source' ? richModeAnalysis.reason : undefined}
        normalizationAvailable={richModeAnalysis.mode === 'normalizable' && !readOnly && !collaborationEnabled}
        onNormalizeToRichMode={normalizeToRichMode}
        isPresentationDocument={isPresentationDocument}
      />
    );
  }

  return (
    <RichMarkdownEditor
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      filePath={filePath}
      externalValueSync={externalValueSync}
      isMobileKeyboardActive={isMobileKeyboardActive}
      onSourceMode={switchToSourceMode}
      markdownNavigationTarget={markdownNavigationTarget}
      collaborationEnabled={collaborationEnabled}
      collaborationDocument={collaborationDocument}
      agentTargets={agentTargets}
      showNotebookMetadata={showNotebookMetadata}
    />
  );
}
