import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { createMarkdownHeadingAnchorFactory } from '@/app/lib/markdown/heading-anchor';

export type MarkdownOutlineHeading = {
  anchor: string;
  level: number;
  position: number;
  text: string;
};

export function collectMarkdownOutline(document: ProseMirrorNode): MarkdownOutlineHeading[] {
  const headings: MarkdownOutlineHeading[] = [];
  const nextAnchor = createMarkdownHeadingAnchorFactory();

  document.descendants((node, position) => {
    if (node.type.name !== 'heading') return true;

    const text = node.textContent.trim();
    headings.push({
      anchor: nextAnchor(text),
      level: Number(node.attrs.level) || 1,
      position: position + 1,
      text: text || 'Untitled section',
    });
    return true;
  });

  return headings;
}

export function activeMarkdownOutlineAnchor(
  headings: readonly MarkdownOutlineHeading[],
  selectionPosition: number,
): string | null {
  let active: MarkdownOutlineHeading | null = null;
  for (const heading of headings) {
    if (heading.position > selectionPosition) break;
    active = heading;
  }
  return active?.anchor ?? headings[0]?.anchor ?? null;
}
