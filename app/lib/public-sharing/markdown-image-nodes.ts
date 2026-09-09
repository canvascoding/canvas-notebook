import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Definition, Nodes } from 'mdast';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';

import {
  createObsidianSyntaxMask,
  getObsidianWikiDisplayLabel,
  parseObsidianWikiLinks,
} from '@/app/lib/markdown/obsidian-flavored-markdown';
import { isMarkdownImagePath } from '@/app/lib/markdown/markdown-image-types';
import { parseCanvasMarkdownDocument } from '@/app/lib/markdown/obsidian-metadata';

export type MarkdownImageSource = {
  source: string;
  index: number;
  end: number;
  replace: (url: string) => string;
};

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\[/gu, '\\[').replace(/\]/gu, '\\]');
}

function markdownImageMarkup(alt: string, url: string, title?: string | null): string {
  const suffix = title ? ` "${title.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"` : '';
  return `![${escapeMarkdownLabel(alt)}](${url}${suffix})`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;');
}

/**
 * Collection and rewriting share the same parsed nodes. Only rendered images
 * authorize assets: fenced/indented/inline code, comments, escaped syntax and
 * unused definitions must never expand a public link's file access.
 */
export function collectMarkdownImageNodes(markdown: string): MarkdownImageSource[] {
  const document = parseCanvasMarkdownDocument(markdown);
  // Keep source offsets while excluding metadata from the rendered body.
  const visibleMarkdown = document.frontmatter
    ? document.frontmatterPrefix.replace(/[^\r\n]/g, ' ') + document.body
    : markdown;
  const root = fromMarkdown(visibleMarkdown);
  const mask = createObsidianSyntaxMask(visibleMarkdown);
  const definitions = new Map<string, Definition>();
  const sources: MarkdownImageSource[] = [];
  const textRanges: Array<{ start: number; end: number }> = [];

  const visibleAt = (index: number, length: number) =>
    mask.slice(index, index + length) === markdown.slice(index, index + length);

  const collectDefinitions = (node: Nodes): void => {
    const start = node.position?.start.offset;
    if (node.type === 'definition' && start !== undefined && visibleAt(start, 1)
      && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if ('children' in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(root);

  const collectHtmlImages = (raw: string, offset: number): void => {
    const visitHtml = (node: DefaultTreeAdapterTypes.Node): void => {
      if ('tagName' in node && node.tagName === 'img') {
        const src = node.attrs.find((attribute) => attribute.name === 'src');
        const location = node.sourceCodeLocation?.attrs?.src;
        if (src && location && visibleAt(offset + location.startOffset, 3)) {
          sources.push({
            source: src.value,
            index: offset + location.startOffset,
            end: offset + location.endOffset,
            replace: (url) => `src="${escapeAttribute(url)}"`,
          });
        }
      }
      if ('childNodes' in node) node.childNodes.forEach(visitHtml);
    };
    visitHtml(parseFragment(raw, { sourceCodeLocationInfo: true }));
  };

  const visit = (node: Nodes): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'definition') return;
    if (node.type === 'image' || node.type === 'imageReference') {
      if (!visibleAt(start, 2)) return;
      const target = node.type === 'image' ? node : definitions.get(node.identifier);
      if (target) sources.push({
        source: target.url,
        index: start,
        end,
        replace: (url) => markdownImageMarkup(node.alt || '', url, target.title),
      });
      return;
    }
    if (node.type === 'html') {
      collectHtmlImages(markdown.slice(start, end), start);
      return;
    }
    if (node.type === 'text') textRanges.push({ start, end });
    if ('children' in node) node.children.forEach(visit);
  };
  visit(root);

  for (const link of parseObsidianWikiLinks(markdown)) {
    if (!link.embed || !isMarkdownImagePath(link.path)) continue;
    if (!textRanges.some((range) => range.start <= link.start && range.end >= link.end)) continue;
    let backslashes = 0;
    for (let index = link.start - 1; index >= 0 && markdown[index] === '\\'; index -= 1) backslashes += 1;
    if (backslashes % 2) continue;
    sources.push({
      source: link.path,
      index: link.start,
      end: link.end,
      replace: (url) => `![${escapeMarkdownLabel(getObsidianWikiDisplayLabel(link))}](<${url}>)`,
    });
  }
  return sources.sort((left, right) => left.index - right.index);
}
