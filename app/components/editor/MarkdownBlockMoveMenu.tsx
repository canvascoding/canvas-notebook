'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { blockMoveSibling, captureBlockMoveSource, moveBlockInDirection, type BlockMoveDirection } from '@/app/lib/editor/block-move-command';
import type { ReorderableBlockRange } from '@/app/lib/editor/reorderable-blocks';

type MoveIntent = { scope: { editor: Editor | null }; source: ReorderableBlockRange };

export function MarkdownBlockMoveMenu({ editor, mobile = false }: { editor: Editor | null; mobile?: boolean }) {
  const t = useTranslations('notebook');
  const scope = useMemo(() => ({ editor }), [editor]);
  const [intent, setIntent] = useState<MoveIntent | null>(null);
  const active = useRef<MoveIntent | null>(null);
  const focusEditorOnClose = useRef(false);
  const state = useEditorState({ editor, selector: ({ editor: current }) => {
    const source = current && (intent?.scope === scope ? intent.source : captureBlockMoveSource(current));
    const writable = Boolean(current && !current.isDestroyed && current.isEditable && !current.view.composing);
    return { writable, available: Boolean(source),
      up: Boolean(current && source && blockMoveSibling(current, source, 'up')),
      down: Boolean(current && source && blockMoveSibling(current, source, 'down')) };
  } });
  const writable = state?.writable ?? false;
  useEffect(() => {
    active.current = writable && intent?.scope === scope ? intent : null;
    return () => { active.current = null; };
  }, [scope, intent, writable]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const close = () => { active.current = null; setIntent(null); };
    const check = () => { if (editor.isDestroyed || !editor.isEditable || editor.view.composing) close(); };
    const element = editor.view.dom;
    editor.on('transaction', check);
    editor.on('update', check);
    editor.on('destroy', close);
    element.addEventListener('compositionstart', close);
    return () => {
      editor.off('transaction', check);
      editor.off('update', check);
      editor.off('destroy', close);
      element.removeEventListener('compositionstart', close);
    };
  }, [editor]);

  const changeOpen = (open: boolean) => {
    active.current = null;
    if (open) focusEditorOnClose.current = false;
    const source = open && editor ? captureBlockMoveSource(editor) : null;
    setIntent(source && editor ? { scope, source } : null);
  };
  const move = (direction: BlockMoveDirection) => {
    if (!intent || active.current !== intent || intent.scope !== scope || !editor) return;
    active.current = null;
    setIntent(null);
    const result = moveBlockInDirection(editor, direction, intent.source);
    focusEditorOnClose.current = result.ok;
    if (!result.ok && result.reason !== 'no_change') toast.info(t('markdownEditorBlockMoveCancelled'));
  };
  return <DropdownMenu open={Boolean(intent?.scope === scope && writable)} onOpenChange={changeOpen}>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="ghost" size={mobile ? 'icon-sm' : 'icon-xs'}
        className={mobile ? 'h-10 w-10 shrink-0 rounded-md text-muted-foreground' : undefined}
        disabled={!writable || !state?.available} aria-label={t('markdownEditorMoveBlock')}
        title={t('markdownEditorMoveBlock')} data-testid={mobile ? 'markdown-mobile-move-block' : 'markdown-toolbar-move-block'}>
        <ArrowUpDown className={mobile ? 'h-5 w-5' : 'size-4'} />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" onCloseAutoFocus={event => {
      if (focusEditorOnClose.current) event.preventDefault();
      focusEditorOnClose.current = false;
    }}>
      <DropdownMenuItem disabled={!state?.up} onSelect={() => move('up')}>
        <ChevronUp />{t('markdownEditorMoveBlockUp')}<span className="ml-auto pl-4 text-xs text-muted-foreground">Alt+Shift+↑</span>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!state?.down} onSelect={() => move('down')}>
        <ChevronDown />{t('markdownEditorMoveBlockDown')}<span className="ml-auto pl-4 text-xs text-muted-foreground">Alt+Shift+↓</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
