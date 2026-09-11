import { Extension, type Editor } from '@tiptap/core';
import { AllSelection, NodeSelection, Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { CollaborationBlockTree } from './block-tree';
import { restoreBlockTreeSelection, type BlockTreeSelection } from './block-tree-anchors';
import { captureBlockTreeEditorSelection, isBlockTreeEditorReady } from './block-tree-editor';

const SELECTION_FIELD = 'canvasBlockSelection';
const caretPluginKey = new PluginKey<DecorationSet>('canvas-block-tree-carets');

type CaretUser = { name: string; color: string; colorLight?: string };
type CaretSelection = BlockTreeSelection | { kind: 'all' };
type CaretOptions = {
  document: Y.Doc;
  awareness: Awareness;
  user: CaretUser;
  render?: (user: CaretUser) => HTMLElement;
  selectionRender?: (user: CaretUser) => Record<string, string>;
};

function serializeSelection(selection: CaretSelection): unknown {
  if (selection.kind !== 'text') return selection;
  return {
    kind: 'text',
    anchor: { blockId: selection.anchor.blockId, relative: Y.relativePositionToJSON(selection.anchor.relative) },
    head: { blockId: selection.head.blockId, relative: Y.relativePositionToJSON(selection.head.relative) },
  };
}

function parseSelection(value: unknown): CaretSelection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CaretSelection>;
  if (candidate.kind === 'all') return { kind: 'all' };
  if (candidate.kind === 'node') return typeof candidate.blockId === 'string' ? { kind: 'node', blockId: candidate.blockId } : null;
  if (candidate.kind === 'cells') {
    const { tableId, anchorId, headId, cellIds } = candidate;
    return typeof tableId === 'string' && typeof anchorId === 'string' && typeof headId === 'string'
      && Array.isArray(cellIds) && cellIds.length > 0 && cellIds.length <= 10000 && cellIds.every((id) => typeof id === 'string')
      ? { kind: 'cells', tableId, anchorId, headId, cellIds } : null;
  }
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
      const selection = saved?.kind === 'all' ? new AllSelection(state.doc)
        : saved ? restoreBlockTreeSelection(tree, state.doc, saved) : null;
      if (!selection) continue;
      const user = caretUser(presence.user);
      if (!selection.empty) {
        const attrs = options.selectionRender?.(user)
          ?? { class: 'collaboration-carets__selection', style: `--collaboration-user-color: ${user.color}; background-color: ${user.colorLight};` };
        // Inline renderers may request a span. Structural selections decorate the
        // existing node so table cells remain direct children of their rows.
        const nodeAttrs: Record<string, string> = { ...attrs };
        delete nodeAttrs.nodeName;
        if (selection instanceof AllSelection) {
          state.doc.forEach((node, position) => values.push(Decoration.node(position, position + node.nodeSize, nodeAttrs)));
        } else if (selection instanceof CellSelection) {
          selection.forEachCell((cell, position) => values.push(Decoration.node(position, position + cell.nodeSize, nodeAttrs)));
        } else values.push(selection instanceof NodeSelection
          ? Decoration.node(selection.from, selection.to, nodeAttrs)
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
      let mounted: { publish: () => void; clear: () => void } | null = null;
      return [new Plugin<DecorationSet>({
        key: caretPluginKey,
        state: {
          init: (_, state) => decorations(state, options),
          apply: (tr, previous, _old, state) => tr.docChanged || tr.getMeta(caretPluginKey) ? decorations(state, options) : previous,
        },
        props: {
          decorations: (state) => caretPluginKey.getState(state) ?? DecorationSet.empty,
          handleDOMEvents: {
            focus: () => { const current = mounted; queueMicrotask(() => current?.publish()); return false; },
            blur: () => { mounted?.clear(); return false; },
          },
        },
        view(view) {
          // Registering a menu recreates plugin views without recreating the plugin.
          // Every mount must own its callbacks and its awareness cleanup separately.
          const owner = globalThis.crypto.randomUUID();
          let active = true;
          const clear = () => {
            if (options.awareness.getLocalState()?.[SELECTION_FIELD]?.owner === owner) options.awareness.setLocalStateField(SELECTION_FIELD, null);
          };
          const publish = () => {
            if (!active || view.isDestroyed || !isBlockTreeEditorReady(editor) || !view.hasFocus()) return;
            try {
              const saved: CaretSelection | null = view.state.selection instanceof AllSelection
                ? { kind: 'all' } : captureBlockTreeEditorSelection(editor);
              if (!saved) { clear(); return; }
              const value = { version: 1, owner, selection: serializeSelection(saved) };
              if (JSON.stringify(options.awareness.getLocalState()?.[SELECTION_FIELD]) !== JSON.stringify(value)) {
                options.awareness.setLocalStateField(SELECTION_FIELD, value);
              }
            } catch { clear(); }
          };
          const current = { publish, clear };
          mounted = current;
          options.awareness.setLocalStateField('user', options.user);
          const update = () => {
            if (active && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(caretPluginKey, true));
          };
          options.awareness.on('change', update);
          // Wait for every plugin view's queued initialization, including the block
          // binding, even when that binding comes after this view in plugin order.
          queueMicrotask(() => queueMicrotask(publish));
          return {
            update: (_view, previous) => {
              if (!previous.doc.eq(view.state.doc) || !previous.selection.eq(view.state.selection)) publish();
            },
            destroy: () => {
              active = false;
              options.awareness.off('change', update);
              clear();
              if (mounted === current) mounted = null;
            },
          };
        },
      })];
    },
  });
}
