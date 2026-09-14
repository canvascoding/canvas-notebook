import { applyExactTextEdits } from '@/app/lib/files/exact-text-patch';
import { composeCanvasMarkdownDocument, splitCanvasMarkdownForRichEditor } from './obsidian-metadata';

export type AgentMarkdownEdit =
  | { mode: 'append'; content: string }
  | { mode: 'replace'; oldText: string; content: string; expectedOccurrences?: number; replaceAll?: boolean }
  | { mode: 'insert_after_heading'; heading: string; content: string };

type MarkdownHeading = {
  end: number;
  line: number;
  title: string;
};

function lineEndingFor(markdown: string): '\n' | '\r\n' {
  return markdown.includes('\r\n') ? '\r\n' : '\n';
}

function withoutOuterLineEndings(value: string): string {
  return value.replace(/^(?:\r?\n)+|(?:\r?\n)+$/gu, '');
}

function finalLineEndings(value: string): string {
  return value.match(/((?:\r?\n)+)$/u)?.[1] ?? '';
}

function restoreFinalLineEndings(value: string, endings: string): string {
  return `${value.replace(/(?:\r?\n)+$/u, '')}${endings}`;
}

function headingTitle(value: string): string {
  const source = value.trim();
  const atx = source.match(/^#{1,6}[\t ]+(.+?)(?:[\t ]+#+)?$/u);
  return (atx?.[1] ?? source).trim();
}

function markdownHeadings(markdown: string): MarkdownHeading[] {
  const lines = markdown.match(/.*(?:\r\n|\n|$)/gu) ?? [];
  const headings: MarkdownHeading[] = [];
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = line.replace(/(?:\r\n|\n)$/u, '');
    const fenceMatch = text.match(/^[\t ]{0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
      offset += line.length;
      continue;
    }
    if (fence) {
      offset += line.length;
      continue;
    }

    const atx = text.match(/^[\t ]{0,3}#{1,6}[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/u);
    if (atx) {
      headings.push({ title: atx[1].trim(), line: index + 1, end: offset + text.length });
      offset += line.length;
      continue;
    }

    const underline = lines[index + 1]?.replace(/(?:\r\n|\n)$/u, '');
    if (text.trim() && underline && /^[\t ]{0,3}(?:=+|-+)[\t ]*$/u.test(underline)) {
      headings.push({ title: text.trim(), line: index + 1, end: offset + line.length + underline.length });
    }
    offset += line.length;
  }
  return headings;
}

function insertAfterHeading(markdown: string, heading: string, fragment: string, label: string): string {
  const target = headingTitle(heading);
  if (!target) throw new Error('insert_after_heading requires a non-empty heading.');
  const matches = markdownHeadings(markdown).filter((entry) => entry.title === target);
  if (matches.length === 0) {
    throw new Error(`Cannot edit ${label}: heading "${target}" was not found.`);
  }
  if (matches.length > 1) {
    throw new Error(`Cannot edit ${label}: heading "${target}" matched ${matches.length} headings at lines ${matches.map((entry) => entry.line).join(', ')}. Use a unique heading.`);
  }

  const match = matches[0];
  const eol = lineEndingFor(markdown);
  const suffix = markdown.slice(match.end);
  const suffixSeparator = suffix === '' || suffix.startsWith(`${eol}${eol}`)
    ? ''
    : suffix.startsWith(eol) ? eol : `${eol}${eol}`;
  return `${markdown.slice(0, match.end)}${eol}${eol}${fragment}${suffixSeparator}${suffix}`;
}

/** Applies one Markdown-aware document edit while preserving frontmatter and final line endings. */
export function applyAgentMarkdownEdit(markdown: string, edit: AgentMarkdownEdit, label: string): string {
  if (!edit || typeof edit !== 'object') throw new Error('A Markdown edit requires mode and content.');
  if (typeof edit.content !== 'string' || !withoutOuterLineEndings(edit.content)) {
    throw new Error(`Markdown ${edit.mode || 'edit'} requires non-empty content.`);
  }

  const { prefix, body } = splitCanvasMarkdownForRichEditor(markdown);
  const endings = finalLineEndings(body);
  const editableBody = endings ? body.slice(0, -endings.length) : body;
  const fragment = withoutOuterLineEndings(edit.content);
  let nextBody: string;

  if (edit.mode === 'append') {
    if (!editableBody) nextBody = fragment;
    else {
      const eol = lineEndingFor(body);
      const separator = editableBody.endsWith(`${eol}${eol}`) ? '' : editableBody.endsWith(eol) ? eol : `${eol}${eol}`;
      nextBody = `${editableBody}${separator}${fragment}`;
    }
  } else if (edit.mode === 'replace') {
    if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) {
      throw new Error('Markdown replace requires a non-empty oldText match.');
    }
    nextBody = applyExactTextEdits(editableBody, [{
      oldText: edit.oldText,
      newText: fragment,
      expectedOccurrences: edit.expectedOccurrences,
      replaceAll: edit.replaceAll,
    }], label);
  } else if (edit.mode === 'insert_after_heading') {
    if (typeof edit.heading !== 'string') throw new Error('insert_after_heading requires heading.');
    nextBody = insertAfterHeading(editableBody, edit.heading, fragment, label);
  } else {
    throw new Error(`Unsupported Markdown edit mode: ${String((edit as { mode?: unknown }).mode)}.`);
  }

  return composeCanvasMarkdownDocument(prefix, restoreFinalLineEndings(nextBody, endings));
}
