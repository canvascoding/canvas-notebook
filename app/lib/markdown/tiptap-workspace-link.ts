import type { Editor, Range } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import {
  getObsidianWikiDisplayLabel,
  parseObsidianWikiTarget,
} from './obsidian-flavored-markdown';

export type ActiveWorkspaceWikiLink = {
  displayText: string;
  range: Range;
  target: string;
  text: string;
};

export function getActiveWorkspaceWikiLink(editor: Editor): ActiveWorkspaceWikiLink | null {
  const { selection } = editor.state;
  const selectedNode = (selection as typeof selection & { node?: ProseMirrorNode }).node
    ?? selection.$from.nodeAfter;
  if (
    !selectedNode
    || selectedNode.type.name !== 'obsidianWikiLink'
    || selection.empty
    || selection.to - selection.from !== selectedNode.nodeSize
  ) {
    return null;
  }

  const rawTarget = typeof selectedNode.attrs.target === 'string'
    ? selectedNode.attrs.target.trim()
    : '';
  const parsedTarget = parseObsidianWikiTarget(rawTarget);
  if (!parsedTarget) return null;

  return {
    displayText: getObsidianWikiDisplayLabel(parsedTarget),
    range: { from: selection.from, to: selection.to },
    target: parsedTarget.target,
    text: parsedTarget.alias ?? '',
  };
}
