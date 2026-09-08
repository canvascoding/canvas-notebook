import { Extension, type Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { CollaborationBlockTree } from './block-tree';
import { restoreBlockTreeSelection, type BlockTreeSelection } from './block-tree-anchors';
import { captureBlockTreeEditorSelection, isBlockTreeEditorReady } from './block-tree-editor';

const SELECTION_FIELD = 'canvasBlockSelection';
const caretPluginKey = new PluginKey<DecorationSet>('canvas-block-tree-carets');

type CaretUser = { name: string; color: string; colorLight?: string };
type CaretOptions = {
  document: Y.Doc;
  awareness: Awareness;
  user: CaretUser;
  render?: (user: CaretUser) => HTMLElement;
};

function serializeSelection(selection: BlockTreeSelection): unknown {
  if (selection.kind === 'node') return selection;
  return {
    kind: 'text',
    anchor: { blockId: selection.anchor.blockId, relative: Y.relativePositionToJSON(selection.anchor.relative) },
    head: { blockId: selection.head.blockId, relative: Y.relativePositionToJSON(selection.head.relative) },
  };
}

function parseSelection(value: unknown): BlockTreeSelection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<BlockTreeSelection>;
  if (candidate.kind === 'node') return typeof candidate.blockId === 'string' ? { kind: 'node', blockId: candidate.blockId } : null;
  if (candidate.kind !== 'text' || !candidate.anchor || !candidate.head
    || typeof candidate.anchor.blockId !== 'string' || typeof candidate.head.blockId !== 'string') return null;
  try {
    return { kind: 'text',
      anchor: { blockId: candidate.anchor.blockId, relative: Y.createRelativePositionFromJSON(candidate.anchor.relative) },
      head: { blockId: candidate.head.blockId, relative: Y.createRelativePositionFromJSON(candidate.head.relative) } };
  } catch { return null; }
}

function caretUser(value: unknown): CaretUser {
  const user = value && typeof value === 'object' ? value as Partial<CaretUser> : {};
  const color = (input: unknown, fallback: string) => typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input) ? input : fallback;
  return { name: typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, 120) : 'Collaborator',
    color: color(user.color, '#2563eb'), colorLight: color(user.colorLight, '#dbeafe') };
}

function renderCaret(user: CaretUser): HTMLElement {
  const cursor = document.createElement('span');
  cursor.className = 'collaboration-carets__caret';
  cursor.contentEditable = 'false';
  cursor.dataset.collaborationUser = user.name;
  cursor.style.setProperty('--collaboration-user-color', user.color);
  cursor.style.setProperty('--collaboration-user-color-light', user.colorLight ?? '#dbeafe');
  const needle = document.createElement('span');
  needle.className = 'collaboration-carets__needle';
  const label = document.createElement('span');
  label.className = 'collaboration-carets__label';
  label.textContent = user.name;
  cursor.append(needle, label);
  return cursor;
}

function decorations(state: EditorState, options: CaretOptions): DecorationSet {
  try {
    if (!options.document.share.has('canvas-block-tree-v1')) return DecorationSet.empty;
    const tree = new CollaborationBlockTree(options.document, state.schema);
    const values: Decoration[] = [];
    for (const [clientId, presence] of options.awareness.getStates()) {
      if (clientId === options.awareness.clientID) continue;
      const cursor = presence[SELECTION_FIELD];
      if (!cursor || cursor.version !== 1) continue;
      const saved = parseSelection(cursor.selection);
      const selection = saved ? restoreBlockTreeSelection(tree, state.doc, saved) : null;
      if (!selection) continue;
      const user = caretUser(presence.user);
      if (!selection.empty) {
        const attrs = { class: 'collaboration-carets__selection', style: `background-color: ${user.colorLight};` };
        values.push(selection instanceof NodeSelection
          ? Decoration.node(selection.from, selection.to, attrs)
          : Decoration.inline(selection.from, selection.to, attrs));
      }
      values.push(Decoration.widget(selection.head, () => (options.render ?? renderCaret)(user), {
        key: `${clientId}:${user.name}:${user.color}`, side: 1,
      }));
    }
    return DecorationSet.create(state.doc, values);
  } catch { return DecorationSet.empty; }
}

export function createBlockTreeCaretExtension(options: CaretOptions) {
  return Extension.create({
    name: 'canvasBlockTreeCarets',
    addProseMirrorPlugins() {
      const editor: Editor = this.editor;
      const owner = globalThis.crypto.randomUUID();
      let active = true;
      const clear = () => {
        if (options.awareness.getLocalState()?.[SELECTION_FIELD]?.owner === owner) options.awareness.setLocalStateField(SELECTION_FIELD, null);
      };
      const publish = () => {
        if (!active || !isBlockTreeEditorReady(editor) || !editor.view.hasFocus()) return;
        try {
          const saved = captureBlockTreeEditorSelection(editor);
          if (!saved) { clear(); return; }
          const value = { version: 1, owner, selection: serializeSelection(saved) };
          if (JSON.stringify(options.awareness.getLocalState()?.[SELECTION_FIELD]) !== JSON.stringify(value)) {
            options.awareness.setLocalStateField(SELECTION_FIELD, value);
          }
        } catch { clear(); }
      };
      return [new Plugin<DecorationSet>({
        key: caretPluginKey,
        state: {
          init: (_, state) => decorations(state, options),
          apply: (tr, previous, _old, state) => tr.docChanged || tr.getMeta(caretPluginKey) ? decorations(state, options) : previous,
        },
        props: {
          decorations: (state) => caretPluginKey.getState(state) ?? DecorationSet.empty,
          handleDOMEvents: {
            focus: () => { queueMicrotask(publish); return false; },
            blur: () => { clear(); return false; },
          },
        },
        view(view) {
          options.awareness.setLocalStateField('user', options.user);
          const update = () => {
            if (active && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(caretPluginKey, true));
          };
          options.awareness.on('change', update);
          return {
            update: (_view, previous) => {
              if (!previous.doc.eq(view.state.doc) || !previous.selection.eq(view.state.selection)) publish();
            },
            destroy: () => { active = false; options.awareness.off('change', update); clear(); },
          };
        },
      })];
    },
  });
}
