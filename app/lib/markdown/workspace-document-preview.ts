import { parseCanvasMarkdownDocument } from './obsidian-metadata';
import { selectObsidianEmbedContent } from './obsidian-embed';

const MAX_PREVIEW_CHARACTERS = 12_000;
const MAX_PREVIEW_LINES = 100;

export type WorkspaceDocumentReference = {
  blockId?: string | null;
  focusOffset?: number | null;
  heading?: string | null;
  path: string;
  title: string;
};

export type WorkspaceDocumentPreviewContent = {
  content: string;
  truncated: boolean;
};

export function workspaceDocumentTitleFromPath(path: string): string {
  const fileName = path.replace(/\\/gu, '/').split('/').filter(Boolean).pop() || path;
  return fileName.replace(/\.(?:md|markdown)$/iu, '').replace(/[-_]+/gu, ' ').trim() || path;
}

export function buildWorkspaceDocumentPreviewTarget(
  reference: Pick<WorkspaceDocumentReference, 'blockId' | 'heading' | 'path'>,
): string {
  if (reference.blockId) return `${reference.path}#^${reference.blockId}`;
  if (reference.heading) return `${reference.path}#${reference.heading}`;
  return reference.path;
}

function findParagraphBoundary(
  markdown: string,
  offset: number,
  direction: 'before' | 'after',
  count: number,
): number {
  let cursor = Math.max(0, Math.min(offset, markdown.length));
  for (let index = 0; index < count; index += 1) {
    const next = direction === 'before'
      ? markdown.lastIndexOf('\n\n', Math.max(0, cursor - 1))
      : markdown.indexOf('\n\n', cursor);
    if (next < 0) return direction === 'before' ? 0 : markdown.length;
    cursor = direction === 'before' ? next : next + 2;
  }
  return cursor;
}

function selectFocusContext(markdown: string, focusOffset: number, minimumOffset: number): string {
  const safeOffset = Math.max(minimumOffset, Math.min(focusOffset, markdown.length));
  const start = Math.max(minimumOffset, findParagraphBoundary(markdown, safeOffset, 'before', 2));
  const end = findParagraphBoundary(markdown, safeOffset, 'after', 3);
  return markdown.slice(start, end).trim();
}

function closeOpenMarkdownFence(markdown: string): string {
  let openFence: { character: '`' | '~'; length: number } | null = null;
  for (const line of markdown.split('\n')) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (!match) continue;
    const marker = match[1];
    const character = marker[0] as '`' | '~';
    if (!openFence) {
      openFence = { character, length: marker.length };
    } else if (character === openFence.character && marker.length >= openFence.length) {
      openFence = null;
    }
  }
  return openFence ? `${markdown}\n${openFence.character.repeat(openFence.length)}` : markdown;
}

function truncateMarkdown(markdown: string): WorkspaceDocumentPreviewContent {
  const lines = markdown.split('\n');
  let characterCount = 0;
  let includedLines = 0;
  for (const line of lines) {
    const nextLength = line.length + (includedLines > 0 ? 1 : 0);
    if (
      includedLines >= MAX_PREVIEW_LINES
      || (includedLines > 0 && characterCount + nextLength > MAX_PREVIEW_CHARACTERS)
    ) {
      break;
    }
    characterCount += nextLength;
    includedLines += 1;
  }

  const truncated = includedLines < lines.length;
  if (!truncated) return { content: markdown.trim(), truncated: false };
  return {
    content: closeOpenMarkdownFence(lines.slice(0, includedLines).join('\n').trimEnd()),
    truncated: true,
  };
}

export function createWorkspaceDocumentPreviewContent(
  markdown: string,
  reference: Pick<WorkspaceDocumentReference, 'blockId' | 'focusOffset' | 'heading' | 'path'>,
): WorkspaceDocumentPreviewContent {
  const parsedDocument = parseCanvasMarkdownDocument(markdown);
  const body = parsedDocument.error ? markdown : parsedDocument.body;
  const bodyOffset = Math.max(0, markdown.length - body.length);
  const target = buildWorkspaceDocumentPreviewTarget(reference);
  const selected = reference.blockId || reference.heading
    ? selectObsidianEmbedContent(markdown, target)
    : typeof reference.focusOffset === 'number'
      ? selectFocusContext(markdown, reference.focusOffset, bodyOffset)
      : body;
  const selectedDocument = parseCanvasMarkdownDocument(selected);
  const content = (selectedDocument.error ? selected : selectedDocument.body).trim();
  return truncateMarkdown(content);
}
