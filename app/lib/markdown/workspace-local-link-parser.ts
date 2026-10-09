import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

import { createObsidianSyntaxMask, parseObsidianWikiLinks } from './obsidian-flavored-markdown';
import { getCanvasNotebookMarkdownLinkTarget } from './obsidian-link-resolver';
import { parseCanvasMarkdownDocument } from './obsidian-metadata';
import { hasUnevaluatedWorkspaceHtmlLinks } from './workspace-html-link-safety';
import type { WorkspaceLinkSyntaxV1, WorkspaceLinkResolveStatusV1 } from './workspace-link-contract-v1';

export type ParsedWorkspaceLocalLink = {
  alias: string | null;
  embed: boolean;
  end: number;
  fragment: string | null;
  kind: 'wiki' | 'markdown';
  raw: string;
  sourcePath: string;
  start: number;
  syntax: WorkspaceLinkSyntaxV1;
  targetEnd: number;
  targetLiteral: string;
  targetPathText: string;
  targetStart: number;
  workspaceRootRelative: boolean;
};

export type WorkspaceLinkUnevaluated = {
  sourcePath: string;
  raw: string;
  reason: 'html' | 'unsupported-scheme' | 'query' | 'unparsed-target';
  start: number;
};

export type WorkspaceExactResolution = {
  candidates: string[];
  path: string | null;
  status: WorkspaceLinkResolveStatusV1;
};

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, '$1');
}

function decodeUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function targetParts(literal: string): { fragment: string | null; path: string } {
  let hash = -1;
  for (let index = 0; index < literal.length; index += 1) {
    if (literal[index] !== '#') continue;
    let escapes = 0;
    for (let before = index - 1; before >= 0 && literal[before] === '\\'; before -= 1) escapes += 1;
    if (escapes % 2 === 0) { hash = index; break; }
  }
  const path = hash >= 0 ? literal.slice(0, hash) : literal;
  return {
    fragment: hash >= 0 ? literal.slice(hash + 1) : null,
    path: decodeUrl(unescapeMarkdown(path)),
  };
}

export function parseWorkspaceMarkdownHref(href: string): {
  fragment: string | null;
  path: string;
} | null {
  const notebookTarget = getCanvasNotebookMarkdownLinkTarget(href);
  const { fragment, path } = targetParts(notebookTarget ?? href);
  if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(path) || path.includes('?')) return null;
  return { fragment, path: notebookTarget ? `/${path.replace(/^\/+/, '')}` : path };
}

/** Returns only the URL span, excluding delimiters and an optional title. */
function inlineTargetRange(markdown: string, start: number, end: number): [number, number] | null {
  let cursor = start + (markdown[start] === '!' ? 2 : 1);
  let brackets = 1;
  while (cursor < end && brackets > 0) {
    if (markdown[cursor] === '\\') { cursor += 2; continue; }
    if (markdown[cursor] === '[') brackets += 1;
    if (markdown[cursor] === ']') brackets -= 1;
    cursor += 1;
  }
  if (brackets !== 0 || markdown[cursor] !== '(') return null;
  cursor += 1;
  while (/[ \t\n]/u.test(markdown[cursor] ?? '') && cursor < end) cursor += 1;
  if (markdown[cursor] === '<') {
    const targetStart = cursor + 1;
    cursor += 1;
    while (cursor < end) {
      if (markdown[cursor] === '\\') { cursor += 2; continue; }
      if (markdown[cursor] === '>') return [targetStart, cursor];
      cursor += 1;
    }
    return null;
  }
  const targetStart = cursor;
  let parentheses = 0;
  while (cursor < end) {
    if (markdown[cursor] === '\\') { cursor += 2; continue; }
    if (markdown[cursor] === '(') parentheses += 1;
    if (markdown[cursor] === ')') {
      if (parentheses === 0) break;
      parentheses -= 1;
    }
    if (parentheses === 0 && /\s/u.test(markdown[cursor])) break;
    cursor += 1;
  }
  return cursor > targetStart ? [targetStart, cursor] : null;
}

function definitionTargetRange(markdown: string, start: number, end: number): [number, number] | null {
  let cursor = markdown.indexOf(']:', start);
  if (cursor < 0 || cursor >= end) return null;
  cursor += 2;
  while (/[ \t\n]/u.test(markdown[cursor] ?? '') && cursor < end) cursor += 1;
  if (markdown[cursor] === '<') {
    const targetStart = cursor + 1;
    cursor += 1;
    while (cursor < end) {
      if (markdown[cursor] === '\\') { cursor += 2; continue; }
      if (markdown[cursor] === '>') return [targetStart, cursor];
      cursor += 1;
    }
    return null;
  }
  const targetStart = cursor;
  let parentheses = 0;
  while (cursor < end) {
    if (markdown[cursor] === '\\') { cursor += 2; continue; }
    if (markdown[cursor] === '(') parentheses += 1;
    if (markdown[cursor] === ')') {
      if (parentheses === 0) break;
      parentheses -= 1;
    }
    if (parentheses === 0 && /\s/u.test(markdown[cursor])) break;
    cursor += 1;
  }
  return cursor > targetStart ? [targetStart, cursor] : null;
}

function unescapedPipe(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '|') continue;
    let slashCount = 0;
    for (let before = index - 1; before >= 0 && value[before] === '\\'; before -= 1) slashCount += 1;
    if (slashCount % 2 === 0) return index;
  }
  return -1;
}

export function parseWorkspaceLocalLinks(markdown: string, sourcePath: string): {
  links: ParsedWorkspaceLocalLink[];
  unevaluated: WorkspaceLinkUnevaluated[];
} {
  const links: ParsedWorkspaceLocalLink[] = [];
  const unevaluated: WorkspaceLinkUnevaluated[] = [];
  const document = parseCanvasMarkdownDocument(markdown);
  const visibleMarkdown = document.frontmatter
    ? document.frontmatterPrefix.replace(/[^\r\n]/gu, ' ') + document.body
    : markdown;
  const mask = createObsidianSyntaxMask(visibleMarkdown);
  const definitions = new Map<string, { node: Nodes; uses: Array<'link' | 'image'> }>();
  const textRanges: Array<{ start: number; end: number }> = [];

  const add = (node: Nodes, range: [number, number], syntax: WorkspaceLinkSyntaxV1): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const targetLiteral = markdown.slice(range[0], range[1]);
    const notebookTarget = getCanvasNotebookMarkdownLinkTarget(targetLiteral);
    const { fragment, path } = targetParts(notebookTarget ?? targetLiteral);
    const raw = markdown.slice(start, end);
    if (!path) return;
    if (!notebookTarget && /^(?:https?:|mailto:|data:|\/\/)/iu.test(path)) return;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) {
      unevaluated.push({ sourcePath, raw, reason: 'unsupported-scheme', start });
      return;
    }
    if (path.includes('?')) {
      unevaluated.push({ sourcePath, raw, reason: 'query', start });
      return;
    }
    links.push({
      alias: null,
      embed: syntax === 'inline-image' || syntax === 'reference-image',
      end,
      fragment,
      kind: 'markdown',
      raw,
      sourcePath,
      start,
      syntax,
      targetEnd: range[1],
      targetLiteral,
      targetPathText: notebookTarget ? `/${path.replace(/^\/+/, '')}` : path,
      targetStart: range[0],
      workspaceRootRelative: Boolean(notebookTarget) || path.startsWith('/'),
    });
  };

  const collect = (node: Nodes): void => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, { node, uses: [] });
    }
    if ('children' in node) node.children.forEach(collect);
  };
  const root = fromMarkdown(visibleMarkdown);
  collect(root);

  const visit = (node: Nodes): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'definition') return;
    if (
      ['html', 'link', 'image', 'linkReference', 'imageReference', 'text'].includes(node.type)
      && mask.slice(start, start + 1) !== markdown.slice(start, start + 1)
    ) return;
    if (node.type === 'html') {
      const raw = markdown.slice(start, end);
      if (hasUnevaluatedWorkspaceHtmlLinks(raw)) unevaluated.push({ sourcePath, raw, reason: 'html', start });
      return;
    }
    if (node.type === 'link' || node.type === 'image') {
      const range = inlineTargetRange(markdown, start, end);
      if (range) add(node, range, node.type === 'image' ? 'inline-image' : 'inline-link');
      else unevaluated.push({ sourcePath, raw: markdown.slice(start, end), reason: 'unparsed-target', start });
      return;
    }
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const definition = definitions.get(node.identifier);
      if (definition) definition.uses.push(node.type === 'imageReference' ? 'image' : 'link');
      return;
    }
    if (node.type === 'text') textRanges.push({ start, end });
    if ('children' in node) node.children.forEach(visit);
  };
  visit(root);

  for (const { node, uses } of definitions.values()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const range = definitionTargetRange(markdown, start, end);
    if (!range) {
      unevaluated.push({ sourcePath, raw: markdown.slice(start, end), reason: 'unparsed-target', start });
      continue;
    }
    add(node, range, uses.length === 1 && markdown[range[0] - 1] !== '<'
      ? uses[0] === 'image' ? 'reference-image' : 'reference-link'
      : 'reference-definition');
  }

  for (const wiki of parseObsidianWikiLinks(visibleMarkdown)) {
    if (!textRanges.some((range) => range.start <= wiki.start && range.end >= wiki.end)) continue;
    const innerStart = wiki.start + (wiki.embed ? 3 : 2);
    const inner = markdown.slice(innerStart, wiki.end - 2);
    const beforeAlias = inner.slice(0, unescapedPipe(inner) < 0 ? undefined : unescapedPipe(inner));
    const leading = beforeAlias.length - beforeAlias.trimStart().length;
    const targetLiteral = beforeAlias.trim();
    if (!targetLiteral) continue;
    const targetStart = innerStart + leading;
    const parts = targetParts(targetLiteral);
    links.push({
      alias: wiki.alias,
      embed: wiki.embed,
      end: wiki.end,
      fragment: parts.fragment,
      kind: 'wiki',
      raw: markdown.slice(wiki.start, wiki.end),
      sourcePath,
      start: wiki.start,
      syntax: wiki.embed ? 'wiki-embed' : 'wiki-link',
      targetEnd: targetStart + targetLiteral.length,
      targetLiteral,
      targetPathText: parts.path,
      targetStart,
      workspaceRootRelative: false,
    });
  }
  return { links: links.sort((a, b) => a.start - b.start), unevaluated };
}

/** Exact path lookup for Markdown URLs; it deliberately has no name or alias fallback. */
export function resolveExactWorkspaceLink(
  targetPathText: string,
  sourcePath: string,
  allPaths: ReadonlySet<string>,
): WorkspaceExactResolution {
  const path = targetPathText.replace(/\\/gu, '/');
  const relative = path.startsWith('/') ? path.slice(1) : `${sourcePath.split('/').slice(0, -1).join('/')}/${path}`;
  const segments: string[] = [];
  for (const segment of relative.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return { candidates: [], path: null, status: 'outside-workspace' };
      segments.pop();
    } else segments.push(segment);
  }
  const resolvedPath = segments.join('/');
  if (!resolvedPath) return { candidates: [], path: null, status: 'missing' };
  return allPaths.has(resolvedPath)
    ? { candidates: [resolvedPath], path: resolvedPath, status: 'resolved' }
    : { candidates: [], path: null, status: 'missing' };
}
