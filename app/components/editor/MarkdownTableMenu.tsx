'use client';

import { useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { CellSelection, isInTable, selectedRect } from '@tiptap/pm/tables';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState } from '@tiptap/react';
import { AlignLeft, ChevronDown, Columns3, Rows3, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { moveMarkdownTablePart } from '@/app/lib/markdown/core/table-commands';

export function MarkdownTableMenu({ editor, suppressed }: { editor: Editor; suppressed: boolean }) {
  const t = useTranslations('notebook');
  const root = useRef<HTMLDivElement>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const activeMenuRef = useRef<string | null>(null);
  const setMenuOpen = (name: string, open: boolean) => {
    const next = open ? name : activeMenuRef.current === name ? null : activeMenuRef.current;
    activeMenuRef.current = next;
    setActiveMenu(next);
  };
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    if (!activeMenuRef.current) editor.commands.focus();
  };
  const context = useEditorState({ editor, selector: ({ editor: current }) => {
    if (!isInTable(current.state)) return null;
    const rect = selectedRect(current.state);
    return { row: rect.top + 1, column: rect.left + 1,
      moveUp: current.can().command((props) => moveMarkdownTablePart(props, 'row', -1)),
      moveDown: current.can().command((props) => moveMarkdownTablePart(props, 'row', 1)),
      moveLeft: current.can().command((props) => moveMarkdownTablePart(props, 'column', -1)),
      moveRight: current.can().command((props) => moveMarkdownTablePart(props, 'column', 1)),
    };
  } });
  const rowActions = [
    ['markdownEditorTableAddRowBefore', () => editor.chain().focus().addRowBefore().run(), true],
    ['markdownEditorTableAddRowAfter', () => editor.chain().focus().addRowAfter().run(), true],
    ['editorTableMoveUp', () => editor.chain().focus().command((props) => moveMarkdownTablePart(props, 'row', -1)).run(), context?.moveUp],
    ['editorTableMoveDown', () => editor.chain().focus().command((props) => moveMarkdownTablePart(props, 'row', 1)).run(), context?.moveDown],
    ['markdownEditorTableDeleteRow', () => editor.chain().focus().deleteRow().run(), true],
  ] as const;
  const columnActions = [
    ['markdownEditorTableAddColumnBefore', () => editor.chain().focus().addColumnBefore().run(), true],
    ['markdownEditorTableAddColumnAfter', () => editor.chain().focus().addColumnAfter().run(), true],
    ['editorTableMoveLeft', () => editor.chain().focus().command((props) => moveMarkdownTablePart(props, 'column', -1)).run(), context?.moveLeft],
    ['editorTableMoveRight', () => editor.chain().focus().command((props) => moveMarkdownTablePart(props, 'column', 1)).run(), context?.moveRight],
    ['markdownEditorTableDeleteColumn', () => editor.chain().focus().deleteColumn().run(), true],
  ] as const;
  const triggerClass = 'inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return <BubbleMenu editor={editor} pluginKey="canvas-table-menu" updateDelay={80} className="z-50"
    appendTo={() => editor.view.dom.closest<HTMLElement>('[role="dialog"]') ?? document.body}
    options={{ placement: 'top-start', strategy: 'fixed', offset: 10, shift: { padding: 8, boundary: editor.view.dom.closest<HTMLElement>('[data-testid="markdown-scroll-container"]') ?? 'clippingAncestors' }, flip: true }}
    shouldShow={({ state }) => !suppressed && editor.isEditable && isInTable(state)
      && (state.selection.empty || state.selection instanceof CellSelection)
      && (Boolean(activeMenu) || editor.isFocused || Boolean(root.current?.contains(document.activeElement)))}>
    <div ref={root} role="toolbar" aria-label={t('markdownEditorTableTools')} data-testid="markdown-table-menu"
      className="flex max-w-[calc(100vw-16px)] items-center rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); editor.commands.focus(); editor.commands.setMeta('canvas-table-menu', 'hide'); } }}>
      {[{ name: 'row', Icon: Rows3, label: `${t('editorTableRow')} ${context?.row ?? ''}`, actions: rowActions },
        { name: 'column', Icon: Columns3, label: `${t('editorTableColumn')} ${context?.column ?? ''}`, actions: columnActions }].map(({ name, Icon, label, actions }) =>
        <DropdownMenu key={name} modal={false} open={activeMenu === name} onOpenChange={(open) => setMenuOpen(name, open)}>
          <DropdownMenuTrigger className={triggerClass} aria-label={label}><Icon className="size-4" />{label}<ChevronDown className="size-3" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={restoreFocus}>
            {actions.map(([key, run, enabled]) => <DropdownMenuItem key={key} disabled={!enabled} onSelect={run}>{t(key)}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>)}
      <DropdownMenu modal={false} open={activeMenu === 'align'} onOpenChange={(open) => setMenuOpen('align', open)}>
        <DropdownMenuTrigger className={triggerClass} aria-label={t('editorTableColumnAlignment')}><AlignLeft className="size-4" /><ChevronDown className="size-3" /></DropdownMenuTrigger>
        <DropdownMenuContent align="start" onCloseAutoFocus={restoreFocus}>
          {(['left', 'center', 'right'] as const).map((align) => <DropdownMenuItem key={align}
            onSelect={() => editor.chain().focus().setCellAttribute('align', align).run()}>
            {t(`markdownEditorTableAlign${align[0].toUpperCase() + align.slice(1)}`)}
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button" aria-label={t('markdownEditorTableDelete')} title={t('markdownEditorTableDelete')} className={triggerClass}
        onPointerDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 className="size-4" /></button>
    </div>
  </BubbleMenu>;
}
