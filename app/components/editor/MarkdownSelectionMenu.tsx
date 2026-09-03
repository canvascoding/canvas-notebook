'use client';

import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState } from '@tiptap/react';
import { Bold, Code, Highlighter, Italic, Link, Strikethrough } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Reuses the rich editor's commands; no Markdown conversion or parallel state. */
export function MarkdownSelectionMenu({ editor, suppressed, onLink }: {
  editor: Editor;
  suppressed: boolean;
  onLink: () => void;
}) {
  const t = useTranslations('notebook.editorSelection');
  const root = useRef<HTMLDivElement>(null);
  const dismissed = useRef(false);
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current.isActive('bold'), italic: current.isActive('italic'), strike: current.isActive('strike'),
    code: current.isActive('code'), highlight: current.isActive('canvasHighlight'), link: current.isActive('link'),
  }) });

  useEffect(() => {
    const reset = () => { dismissed.current = false; };
    const focusMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && root.current?.isConnected) {
        event.preventDefault(); dismissed.current = true;
        editor.commands.setMeta('canvas-selection-menu', 'hide');
        return;
      }
      if (!event.altKey || event.key !== 'F10' || !editor.isEditable || editor.state.selection.empty) return;
      event.preventDefault();
      dismissed.current = false;
      editor.commands.setMeta('canvas-selection-menu', 'show');
      requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    };
    const editorElement = editor.view.dom;
    editor.on('selectionUpdate', reset);
    editorElement.addEventListener('keydown', focusMenu);
    return () => {
      editor.off('selectionUpdate', reset);
      editorElement.removeEventListener('keydown', focusMenu);
    };
  }, [editor]);

  const actions = [
    { key: 'bold', Icon: Bold, active: state.bold, run: () => editor.chain().focus().toggleBold().run() },
    { key: 'italic', Icon: Italic, active: state.italic, run: () => editor.chain().focus().toggleItalic().run() },
    { key: 'strike', Icon: Strikethrough, active: state.strike, run: () => editor.chain().focus().toggleStrike().run() },
    { key: 'highlight', Icon: Highlighter, active: state.highlight, run: () => editor.chain().focus().toggleCanvasHighlight().run() },
    { key: 'code', Icon: Code, active: state.code, run: () => editor.chain().focus().toggleCode().run() },
    { key: 'link', Icon: Link, active: state.link, run: onLink },
  ];

  return <BubbleMenu editor={editor} pluginKey="canvas-selection-menu" updateDelay={80}
    appendTo={() => editor.view.dom.closest<HTMLElement>('[role="dialog"]') ?? document.body}
    options={{ placement: 'top-start', strategy: 'fixed', offset: 10, shift: { padding: 8 }, flip: true }}
    shouldShow={({ state: current }) => !suppressed && !dismissed.current && editor.isEditable
      && current.selection instanceof TextSelection && !current.selection.empty && !editor.isActive('codeBlock')
      && Boolean(current.doc.textBetween(current.selection.from, current.selection.to).trim())
      && (editor.isFocused || Boolean(root.current?.contains(document.activeElement)))}
    className="z-50">
    <div ref={root} role="toolbar" aria-label={t('title')} data-testid="markdown-selection-menu"
    className="z-50 flex max-w-[calc(100vw-16px)] items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    onPointerDown={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault(); dismissed.current = true;
        editor.commands.focus(); editor.commands.setMeta('canvas-selection-menu', 'hide');
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    {actions.map(({ key, Icon, active, run }) => <button key={key} type="button" aria-label={t(key)}
      aria-pressed={active} title={t(key)} onClick={run}
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${active ? 'bg-accent text-accent-foreground' : ''}`}>
      <Icon className="size-4" />
    </button>)}
    </div>
  </BubbleMenu>;
}
