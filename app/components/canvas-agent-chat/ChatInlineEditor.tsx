'use client';

import { createContext, forwardRef, useContext, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Extension, Node as TiptapNode, type Editor, type JSONContent } from '@tiptap/core';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Plugin } from '@tiptap/pm/state';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { parseChatBody, type ChatBodyV1, type ChatReferenceBundleV1 } from '@/app/lib/chat/chat-body-contracts';
import { chatBodyToInlineEditorDocument, chatInlineReferenceIconKey, inlineEditorDocumentToChatBody,
  inlineEditorPlainTextContent, inlineEditorPositionToTextOffset, inlineEditorTextOffsetToPosition,
  type ChatInlineReferenceIcons, type ChatInlineTextRange } from '@/app/lib/chat/inline-editor';
import { PluginExtensionAvatar } from '@/app/components/plugins/PluginExtensionAvatar';
import { cn } from '@/lib/utils';

export type ChatInlineEditorHandle = {
  focus: (options?: FocusOptions) => void;
  focusEnd: () => void;
  getSelection: () => ChatInlineTextRange;
  setSelection: (from: number, to?: number) => void;
  insertReference: (bundle: ChatReferenceBundleV1, range?: ChatInlineTextRange) => boolean;
  replaceText: (text: string, range?: ChatInlineTextRange) => boolean;
};
export type ChatInlineEditorProps = {
  body: ChatBodyV1;
  onBodyChange: (body: ChatBodyV1) => void;
  onSelectionChange?: (range: ChatInlineTextRange) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  icons?: ChatInlineReferenceIcons;
  onSubmit?: () => void;
  className?: string;
  'aria-label'?: string;
};

type ReferencePresentation = { bundles: ReadonlyMap<string, ChatReferenceBundleV1>; icons?: ChatInlineReferenceIcons };
const ReferencePresentationContext = createContext<ReferencePresentation>({ bundles: new Map() });

function InlineReferenceView({ node, selected }: NodeViewProps) {
  const { bundles, icons } = useContext(ReferencePresentationContext), bundle = bundles.get(node.attrs.bundleId);
  if (!bundle) return <NodeViewWrapper as="span" contentEditable={false} />;
  const identity = chatInlineReferenceIconKey(bundle.primary.selection);
  return <NodeViewWrapper as="span" contentEditable={false} data-type="extension-reference"
    data-occurrence-id={node.attrs.occurrenceId} data-bundle-id={node.attrs.bundleId}
    className={cn('mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-md border border-primary/15 bg-primary/8 px-1 py-0.5 align-baseline text-primary box-decoration-clone',
      selected && 'outline outline-2 outline-primary/40')}>
    <PluginExtensionAvatar name={bundle.caption} identity={identity} icon={icons?.[identity]} size="sm"
      className="!size-4 !rounded-sm !border-0 !bg-transparent !text-[8px] self-center [&_img]:!p-0" />
    <span className="break-words font-medium">{bundle.caption}</span>
  </NodeViewWrapper>;
}

function selectionOf(editor: Editor, bundles: ReadonlyMap<string, ChatReferenceBundleV1>): ChatInlineTextRange {
  return { from: inlineEditorPositionToTextOffset(editor.state.doc, bundles, editor.state.selection.from),
    to: inlineEditorPositionToTextOffset(editor.state.doc, bundles, editor.state.selection.to) };
}
function editorRange(editor: Editor, bundles: ReadonlyMap<string, ChatReferenceBundleV1>, range: ChatInlineTextRange) {
  const from = Math.min(range.from, range.to), to = Math.max(range.from, range.to);
  return { from: inlineEditorTextOffsetToPosition(editor.state.doc, bundles, from, from === to ? 1 : -1),
    to: inlineEditorTextOffsetToPosition(editor.state.doc, bundles, to, 1) };
}

/** A small plain-text editor with public, atomic inline references. Source validation happens at admission. */
export const ChatInlineEditor = forwardRef<ChatInlineEditorHandle, ChatInlineEditorProps>(function ChatInlineEditor(props, ref) {
  const parsedBody = parseChatBody(props.body);
  const bundles = useRef(new Map(parsedBody.bundles.map(bundle => [bundle.id, bundle])));
  const currentProps = useRef(props);
  useLayoutEffect(() => { currentProps.current = props; });
  const applyingExternal = useRef(false);
  const [visibleBundles, setVisibleBundles] = useState(() => new Map(parsedBody.bundles.map(bundle => [bundle.id, bundle])));
  const latestEmitted = useRef(JSON.stringify(parsedBody));
  const replacePlainText = useRef<(text: string, range?: ChatInlineTextRange) => boolean>(() => false);
  const extensions = useMemo(() => [
    StarterKit.configure({ blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false,
      dropcursor: false, gapcursor: false, heading: false, horizontalRule: false, italic: false, link: false,
      listItem: false, listKeymap: false, orderedList: false, strike: false, underline: false, trailingNode: false }),
    // Tiptap stores these callbacks; it invokes them during view/transaction work, outside React render.
    // eslint-disable-next-line react-hooks/refs
    Placeholder.configure({ placeholder: () => currentProps.current.placeholder ?? '' }),
    // eslint-disable-next-line react-hooks/refs
    TiptapNode.create({ name: 'extensionReference', group: 'inline', inline: true, atom: true, selectable: true, draggable: false,
      addAttributes: () => ({ occurrenceId: { default: null, rendered: false }, bundleId: { default: null, rendered: false } }),
      // HTML/clipboard attributes can never create a reference or supply its public selection.
      parseHTML: () => [],
      renderHTML: ({ node }) => ['span', { 'data-type': 'extension-reference', 'data-occurrence-id': node.attrs.occurrenceId,
        'data-bundle-id': node.attrs.bundleId, contenteditable: 'false' }, bundles.current.get(node.attrs.bundleId)?.caption ?? ''],
      renderText: ({ node }) => bundles.current.get(node.attrs.bundleId)?.caption ?? '',
      addNodeView: () => ReactNodeViewRenderer(InlineReferenceView),
    }),
    // eslint-disable-next-line react-hooks/refs
    Extension.create({ name: 'validChatBody', addProseMirrorPlugins: () => [new Plugin({
      filterTransaction: transaction => {
        if (!transaction.docChanged) return true;
        try { inlineEditorDocumentToChatBody(transaction.doc.toJSON(), bundles.current); return true; }
        catch { return false; }
      },
    })] }),
  ], []);
  const editor = useEditor({ extensions, content: chatBodyToInlineEditorDocument(parsedBody), immediatelyRender: false,
    editable: !props.disabled, enableInputRules: false, enablePasteRules: false,
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': props['aria-label'] ?? props.placeholder ?? 'Message',
        'aria-disabled': props.disabled ? 'true' : 'false',
        class: 'min-h-[1.5em] w-full whitespace-pre-wrap break-words outline-none [&_p]:m-0 [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_p.is-editor-empty:first-child]:before:pointer-events-none' },
      handleDOMEvents: { drop: (_view, event) => { event.preventDefault(); return true; } },
      handlePaste: (_view, event) => {
        if (currentProps.current.disabled) return true;
        if (event.defaultPrevented) return true;
        // React's capture handler has already offered attachment paste to the parent.
        const text = event.clipboardData?.getData('text/plain');
        event.preventDefault();
        if (text) replacePlainText.current(text);
        return true;
      },
      clipboardTextSerializer: slice => slice.content.textBetween(0, slice.content.size, '\n', node =>
        node.type.name === 'extensionReference' ? bundles.current.get(node.attrs.bundleId)?.caption ?? '' : '\n'),
    },
    onUpdate: ({ editor: changed }) => {
      if (applyingExternal.current) return;
      const body = inlineEditorDocumentToChatBody(changed.getJSON(), bundles.current);
      latestEmitted.current = JSON.stringify(body);
      setVisibleBundles(new Map(bundles.current));
      currentProps.current.onBodyChange(body);
    },
    onSelectionUpdate: ({ editor: changed }) => currentProps.current.onSelectionChange?.(selectionOf(changed, bundles.current)),
  });

  useLayoutEffect(() => {
    if (!editor) return;
    editor.setEditable(!props.disabled, false);
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: {
      ...editor.options.editorProps.attributes, 'aria-label': props['aria-label'] ?? props.placeholder ?? 'Message',
      'aria-disabled': props.disabled ? 'true' : 'false',
    } } });
    const serialized = JSON.stringify(parsedBody);
    if (serialized === latestEmitted.current) return;
    let active = true;
    // Leave React's commit before Tiptap synchronously mounts React NodeViews.
    // The microtask finishes before the next input event and stale replacements are discarded.
    queueMicrotask(() => {
      if (editor.isDestroyed || !active) return;
      applyingExternal.current = true;
      try {
        bundles.current.clear(); parsedBody.bundles.forEach(bundle => bundles.current.set(bundle.id, bundle));
        const document = editor.schema.nodeFromJSON(chatBodyToInlineEditorDocument(parsedBody));
        editor.view.updateState(EditorState.create({ schema: editor.schema, doc: document,
          selection: TextSelection.atEnd(document), plugins: editor.state.plugins }));
        latestEmitted.current = serialized;
        setVisibleBundles(new Map(bundles.current));
        currentProps.current.onSelectionChange?.(selectionOf(editor, bundles.current));
      } finally { applyingExternal.current = false; }
    });
    return () => { active = false; };
  });

  const replace = (content: JSONContent | JSONContent[], range?: ChatInlineTextRange): boolean => {
    if (!editor || editor.isDestroyed || currentProps.current.disabled) return false;
    const target = range ? editorRange(editor, bundles.current, range) : { from: editor.state.selection.from, to: editor.state.selection.to };
    // The schema filter checks the entire transaction before any part can be dispatched.
    const before = editor.state.doc;
    const chain = editor.chain().command(({ tr }) => { closeHistory(tr); return true; });
    if (Array.isArray(content) && !content.length) chain.deleteRange(target).run();
    else chain.insertContentAt(target, content, { updateSelection: true }).run();
    const changed = !editor.state.doc.eq(before);
    if (changed) editor.view.dispatch(closeHistory(editor.state.tr));
    return changed;
  };
  useLayoutEffect(() => {
    replacePlainText.current = (text, range) => {
      if (text === '') return replace([], range);
      // Explicit text/hardbreak nodes never interpret markup or add paragraph boundaries.
      return replace(text.includes('\n') ? inlineEditorPlainTextContent(text) : { type: 'text', text }, range);
    };
  });
  useImperativeHandle(ref, () => ({
    focus: options => editor?.view.dom.focus(options),
    focusEnd: () => { if (editor && !editor.isDestroyed) { editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.view.dom.focus(); } },
    getSelection: () => editor && !editor.isDestroyed ? selectionOf(editor, bundles.current) : { from: 0, to: 0 },
    setSelection: (from, to = from) => { if (editor && !editor.isDestroyed) editor.commands.setTextSelection(editorRange(editor, bundles.current, { from, to })); },
    replaceText: (text, range) => replacePlainText.current(text, range),
    insertReference: (input, range) => {
      if (!editor || props.disabled) return false;
      const id = bundles.current.has(input.id) && JSON.stringify(bundles.current.get(input.id)) !== JSON.stringify(input) ? crypto.randomUUID() : input.id;
      const occurrenceId = crypto.randomUUID();
      let bundle: ChatReferenceBundleV1;
      try { bundle = parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId, bundleId: id }], bundles: [{ ...input, id }] }).bundles[0]; }
      catch { return false; }
      const previous = bundles.current.get(id); bundles.current.set(id, bundle);
      const before = editor.state.doc;
      replace({ type: 'extensionReference', attrs: { occurrenceId, bundleId: id } }, range);
      const inserted = !editor.state.doc.eq(before);
      if (!inserted && !previous) bundles.current.delete(id);
      return inserted;
    },
  }));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || editor?.view.composing) {
      // Preserve the browser's composition commit, without letting the editor keymap split/send it.
      event.stopPropagation(); return;
    }
    props.onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault(); if (!props.disabled) props.onSubmit?.();
  };
  return <ReferencePresentationContext.Provider value={{ bundles: visibleBundles, icons: props.icons }}>
    <div className={cn('w-full min-w-0 text-sm', props.className)} onKeyDownCapture={handleKeyDown}
      onPasteCapture={props.onPaste} data-testid="chat-inline-editor">
      <EditorContent editor={editor} />
    </div>
  </ReferencePresentationContext.Provider>;
});
