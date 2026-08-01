'use client';

import type { Editor } from '@tiptap/core';
import { ListTree, Pin, PinOff, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

import {
  activeMarkdownOutlineAnchor,
  collectMarkdownOutline,
  type MarkdownOutlineHeading,
} from '@/app/lib/editor/markdown-outline';
import { scrollToMarkdownHeadingAnchor } from '@/app/lib/markdown/heading-anchor';
import { cn } from '@/lib/utils';

type MarkdownOutlinePanelProps = {
  editor: Editor | null;
  onPinnedChange: (pinned: boolean) => void;
  pinned: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
};

export function MarkdownOutlinePanel({
  editor,
  onPinnedChange,
  pinned,
  scrollContainerRef,
}: MarkdownOutlinePanelProps) {
  const t = useTranslations('notebook');
  const [open, setOpen] = useState(false);
  const [headings, setHeadings] = useState<MarkdownOutlineHeading[]>([]);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);

  const refreshOutline = useCallback(() => {
    if (!editor || editor.isDestroyed) {
      setHeadings([]);
      setActiveAnchor(null);
      return;
    }
    const nextHeadings = collectMarkdownOutline(editor.state.doc);
    setHeadings(nextHeadings);
    setActiveAnchor(activeMarkdownOutlineAnchor(nextHeadings, editor.state.selection.from));
    if (nextHeadings.length < 2) {
      setOpen(false);
      onPinnedChange(false);
    }
  }, [editor, onPinnedChange]);

  useEffect(() => {
    queueMicrotask(refreshOutline);
    if (!editor) return undefined;
    editor.on('transaction', refreshOutline);
    return () => {
      editor.off('transaction', refreshOutline);
    };
  }, [editor, refreshOutline]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !editor || headings.length === 0) return undefined;

    let frame: number | null = null;
    const updateFromScroll = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const containerTop = container.getBoundingClientRect().top + 36;
        let visibleAnchor = headings[0]?.anchor ?? null;
        for (const heading of headings) {
          const element = editor.view.dom.querySelector<HTMLElement>(`#${CSS.escape(heading.anchor)}`);
          if (!element || element.getBoundingClientRect().top > containerTop) break;
          visibleAnchor = heading.anchor;
        }
        setActiveAnchor(visibleAnchor);
      });
    };
    container.addEventListener('scroll', updateFromScroll, { passive: true });
    updateFromScroll();
    return () => {
      container.removeEventListener('scroll', updateFromScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [editor, headings, scrollContainerRef]);

  const minimumLevel = useMemo(
    () => headings.reduce((minimum, heading) => Math.min(minimum, heading.level), 6),
    [headings],
  );

  const openHeading = useCallback((heading: MarkdownOutlineHeading) => {
    if (!editor) return;
    setActiveAnchor(heading.anchor);
    if (editor.isEditable) {
      editor.chain().focus().setTextSelection(heading.position).run();
    }
    scrollToMarkdownHeadingAnchor(editor.view.dom, `#${heading.anchor}`);
    if (!pinned) setOpen(false);
  }, [editor, pinned]);

  if (headings.length < 2) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-testid="markdown-outline-toggle"
        className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-background/90 text-muted-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('markdownEditorOutlineOpen')}
        title={t('markdownEditorOutlineOpen')}
        onClick={() => setOpen(true)}
      >
        <ListTree className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside
      data-testid="markdown-outline-panel"
      className="pointer-events-auto flex max-h-[min(70vh,34rem)] w-[min(18rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background/94 shadow-xl backdrop-blur md:w-64"
      aria-label={t('markdownEditorOutline')}
    >
      <div className="flex min-h-11 items-center gap-2 border-b border-border/60 px-3">
        <ListTree className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {t('markdownEditorOutline')}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {headings.length}
        </span>
        <button
          type="button"
          className={cn(
            'hidden h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex',
            pinned && 'bg-primary/10 text-primary',
          )}
          aria-pressed={pinned}
          aria-label={pinned ? t('markdownEditorOutlineUnpin') : t('markdownEditorOutlinePin')}
          title={pinned ? t('markdownEditorOutlineUnpin') : t('markdownEditorOutlinePin')}
          onClick={() => onPinnedChange(!pinned)}
        >
          {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('markdownEditorOutlineClose')}
          title={t('markdownEditorOutlineClose')}
          onClick={() => {
            setOpen(false);
            onPinnedChange(false);
          }}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <nav className="min-h-0 overflow-y-auto overscroll-contain p-2">
        {headings.map((heading) => (
          <button
            key={`${heading.anchor}:${heading.position}`}
            type="button"
            className={cn(
              'relative flex min-h-8 w-full items-center rounded-lg py-1.5 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              activeAnchor === heading.anchor && 'bg-primary/8 font-medium text-primary',
            )}
            style={{ paddingLeft: `${0.625 + Math.max(0, heading.level - minimumLevel) * 0.75}rem` }}
            aria-current={activeAnchor === heading.anchor ? 'location' : undefined}
            onClick={() => openHeading(heading)}
          >
            <span className="line-clamp-2 break-words">{heading.text}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
