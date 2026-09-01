import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import type { CollaborationAgentOperation } from './agent-operations-client';

const VISIBLE_OPERATION_STATUSES = new Set<CollaborationAgentOperation['operationStatus']>([
  'preparing',
  'ready',
  'applying',
  'applied_to_ydoc',
  'persisted_yjs',
  'partially_applied',
  'needs_review',
  'semantic_conflict',
  'cancel_requested',
]);

export interface CollaborationAgentTargetAnchor {
  operationId: string;
  targetId: string;
  groupId: string;
  startAnchor: string;
  endAnchor: string;
}

export interface CollaborationAgentTargetRange extends CollaborationAgentTargetAnchor {
  from: number;
  to: number;
}

export function visibleAgentTargetAnchors(
  operations: CollaborationAgentOperation[],
): CollaborationAgentTargetAnchor[] {
  return operations.flatMap((operation) => (
    VISIBLE_OPERATION_STATUSES.has(operation.operationStatus)
      ? operation.targetAnchors.map((target) => ({
          operationId: operation.operationId,
          ...target,
        }))
      : []
  ));
}

function decodeRelativePosition(value: string): Y.RelativePosition | null {
  try {
    const binary = globalThis.atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return Y.decodeRelativePosition(bytes);
  } catch {
    return null;
  }
}

export function resolveAgentTextTargetRanges(
  doc: Y.Doc,
  textName: string,
  targets: CollaborationAgentTargetAnchor[],
): CollaborationAgentTargetRange[] {
  const text = doc.getText(textName);
  return targets.flatMap((target) => {
    const start = decodeRelativePosition(target.startAnchor);
    const end = decodeRelativePosition(target.endAnchor);
    const absoluteStart = start ? Y.createAbsolutePositionFromRelativePosition(start, doc) : null;
    const absoluteEnd = end ? Y.createAbsolutePositionFromRelativePosition(end, doc) : null;
    if (
      !absoluteStart
      || !absoluteEnd
      || absoluteStart.type !== text
      || absoluteEnd.type !== text
      || absoluteStart.index > absoluteEnd.index
    ) return [];
    return [{ ...target, from: absoluteStart.index, to: absoluteEnd.index }];
  });
}

interface AgentTargetDecorationState {
  targets: CollaborationAgentTargetAnchor[];
  decorations: DecorationSet;
}

export const agentTargetDecorationPluginKey = new PluginKey<AgentTargetDecorationState>('canvas-agent-targets');

function createRichTargetDecorations(
  doc: Y.Doc,
  editorState: EditorState,
  targets: CollaborationAgentTargetAnchor[],
): DecorationSet {
  const syncState = ySyncPluginKey.getState(editorState) as {
    binding?: { mapping?: Parameters<typeof relativePositionToAbsolutePosition>[3] };
  } | undefined;
  const mapping = syncState?.binding?.mapping;
  if (!mapping) return DecorationSet.empty;

  const fragment = doc.getXmlFragment('body');
  const maxPosition = editorState.doc.content.size;
  const decorations = targets.flatMap((target) => {
    const start = decodeRelativePosition(target.startAnchor);
    const end = decodeRelativePosition(target.endAnchor);
    const from = start ? relativePositionToAbsolutePosition(doc, fragment, start, mapping) : null;
    const to = end ? relativePositionToAbsolutePosition(doc, fragment, end, mapping) : null;
    if (from === null || to === null || from > to || from < 0 || to > maxPosition) return [];

    const attributes = {
      class: 'collaboration-agent-target',
      'data-agent-operation-id': target.operationId,
      'data-agent-target-id': target.targetId,
    };
    if (from < to) return [Decoration.inline(from, to, attributes)];
    return [Decoration.widget(from, () => {
      const marker = document.createElement('span');
      marker.className = 'collaboration-agent-target collaboration-agent-target-caret';
      marker.dataset.agentOperationId = target.operationId;
      marker.dataset.agentTargetId = target.targetId;
      marker.setAttribute('aria-hidden', 'true');
      return marker;
    })];
  });
  return DecorationSet.create(editorState.doc, decorations);
}

export function createAgentTargetDecorationPlugin(doc: Y.Doc) {
  return new Plugin<AgentTargetDecorationState>({
    key: agentTargetDecorationPluginKey,
    state: {
      init: (_, editorState) => ({
        targets: [],
        decorations: createRichTargetDecorations(doc, editorState, []),
      }),
      apply: (transaction, previous, _oldState, editorState) => {
        const nextTargets = transaction.getMeta(agentTargetDecorationPluginKey) as CollaborationAgentTargetAnchor[] | undefined;
        const targets = nextTargets ?? previous.targets;
        if (!nextTargets && !transaction.docChanged) return previous;
        return {
          targets,
          decorations: createRichTargetDecorations(doc, editorState, targets),
        };
      },
    },
    props: {
      decorations: (editorState) => agentTargetDecorationPluginKey.getState(editorState)?.decorations ?? DecorationSet.empty,
    },
  });
}

export function createAgentTargetDecorationExtension(doc: Y.Doc) {
  return Extension.create({
    name: 'canvasAgentTargetDecorations',
    addProseMirrorPlugins: () => [createAgentTargetDecorationPlugin(doc)],
  });
}

export function updateAgentTargetDecorations(
  editor: Editor,
  targets: CollaborationAgentTargetAnchor[],
) {
  editor.view.dispatch(editor.state.tr.setMeta(agentTargetDecorationPluginKey, targets));
}
