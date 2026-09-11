import { generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import createDOMPurify from 'dompurify';
import katex from 'katex';

import { richMarkdownCodecExtensions } from '../markdown/rich-markdown-codec';
import { CANVAS_KATEX_OPTIONS } from '../markdown/katex-options';
import type { CollaborationAgentOperation } from './agent-operations-client';

export type AgentReviewTarget = NonNullable<CollaborationAgentOperation['reviewTargets']>[number];
export type AgentPreviewBlock = { id: string; parentId?: string | null; beforeId?: string | null; absent?: true; block?: JSONContent };
const extensions = richMarkdownCodecExtensions();
const schema = getSchema(extensions);

export function parseAgentPreviewBlocks(value: string): AgentPreviewBlock[] | null {
  try {
    if (value.length > 5 * 1024 * 1024) return null;
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows) || rows.length > 512) return null;
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || ids.has(row.id)) return null;
      ids.add(row.id);
      if (row.absent === true) { if (row.block !== undefined) return null; continue; }
      if (!row.block || typeof row.block !== 'object' || ![null, 'string'].includes(row.parentId === null ? null : typeof row.parentId)
        || ![null, 'string'].includes(row.beforeId === null ? null : typeof row.beforeId)) return null;
      schema.nodeFromJSON(row.block).check();
    }
    return rows as AgentPreviewBlock[];
  } catch { return null; }
}

export function canDisplayAgentReviewTarget(target: AgentReviewTarget): boolean {
  if (target.currentText === null) return false;
  if (target.previewFormat === 'text' || target.previewFormat === 'markdown') return true;
  return target.previewFormat === 'blocks' && parseAgentPreviewBlocks(target.currentText) !== null
    && parseAgentPreviewBlocks(target.proposedReplacement) !== null
    && Array.isArray(target.blockLocations?.before) && Array.isArray(target.blockLocations?.after);
}

function blockContent(value: JSONContent): string {
  return JSON.stringify(value, (key, entry) => key === 'id' ? undefined : entry);
}

function descendants(rows: AgentPreviewBlock[]): Map<string, JSONContent> {
  const result = new Map<string, JSONContent>();
  const visit = (node: JSONContent) => {
    if (typeof node.attrs?.id === 'string') result.set(node.attrs.id, node);
    node.content?.forEach(visit);
  };
  rows.forEach((row) => { if (row.block) { result.set(row.id, row.block); visit(row.block); } });
  return result;
}

export function agentPreviewChanges(target: AgentReviewTarget): Array<{
  id: string; type: string; kinds: Array<'inserted' | 'deleted' | 'moved' | 'edited'>;
}> {
  const before = parseAgentPreviewBlocks(target.currentText ?? '');
  const after = parseAgentPreviewBlocks(target.proposedReplacement);
  if (!before || !after) return [];
  const beforeNodes = descendants(before); const afterNodes = descendants(after);
  const beforeRoots = new Map(before.map((entry) => [entry.id, entry]));
  const afterRoots = new Map(after.map((entry) => [entry.id, entry]));
  return [...new Set([...before.map((row) => row.id), ...after.map((row) => row.id)])].map((id) => {
    const left = beforeNodes.get(id); const right = afterNodes.get(id);
    const kinds: Array<'inserted' | 'deleted' | 'moved' | 'edited'> = [];
    if (!left && right) kinds.push('inserted');
    else if (left && !right) kinds.push('deleted');
    else if (left && right) {
      const beforeRoot = beforeRoots.get(id); const afterRoot = afterRoots.get(id);
      if (!beforeRoot || !afterRoot || beforeRoot.parentId !== afterRoot.parentId || beforeRoot.beforeId !== afterRoot.beforeId) kinds.push('moved');
      if (blockContent(left) !== blockContent(right)) kinds.push('edited');
    }
    return { id, type: right?.type ?? left?.type ?? 'paragraph', kinds };
  }).filter((entry) => entry.kinds.length > 0);
}

export function agentPreviewAttributeChanges(target: AgentReviewTarget): Array<{ type: string; key: string; before: unknown; after: unknown }> {
  const before = descendants(parseAgentPreviewBlocks(target.currentText ?? '') ?? []);
  const after = descendants(parseAgentPreviewBlocks(target.proposedReplacement) ?? []);
  return [...before].flatMap(([id, left]) => {
    const right = after.get(id); if (!right) return [];
    return [...new Set([...Object.keys(left.attrs ?? {}), ...Object.keys(right.attrs ?? {})])]
      .filter((key) => key !== 'id' && JSON.stringify(left.attrs?.[key]) !== JSON.stringify(right.attrs?.[key]))
      .map((key) => ({ type: right.type ?? left.type ?? 'paragraph', key, before: left.attrs?.[key], after: right.attrs?.[key] }));
  });
}

/** Use the editor's own serializer; remove request-bearing attributes before creating any DOM. */
export function renderAgentPreviewBlocks(rows: AgentPreviewBlock[], labels: { image: string; link: string }): string {
  if (typeof window === 'undefined') return '';
  const assets: Array<{ kind: 'image' | 'link'; value: string; alt?: string }> = [];
  const clone = (node: JSONContent): JSONContent => {
    const attrs = { ...node.attrs }; delete attrs.id;
    if (node.type === 'image') {
      assets.push({ kind: 'image', value: String(attrs.src ?? ''), alt: String(attrs.alt ?? '') });
      attrs.src = '';
    }
    const marks = node.marks?.map((mark) => {
      if (mark.type !== 'link') return mark;
      assets.push({ kind: 'link', value: String(mark.attrs?.href ?? '') });
      return { ...mark, attrs: { ...mark.attrs, href: `#preview-link-${assets.length}` } };
    });
    return { ...node, attrs, marks, content: node.content?.map(clone) };
  };
  const content = rows.flatMap((row) => row.block ? [clone(row.block)] : []);
  const html = generateHTML({ type: 'doc', content }, extensions);
  const purifier = createDOMPurify(window);
  const fragment = purifier.sanitize(html, { RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'video', 'audio', 'source'],
    FORBID_ATTR: ['id', 'contenteditable', 'tabindex', 'src', 'srcset', 'href', 'target'],
  });
  const images = assets.filter((asset) => asset.kind === 'image');
  fragment.querySelectorAll('img').forEach((element, index) => {
    const asset = images[index]; const replacement = document.createElement('span');
    replacement.className = 'block rounded border border-dashed px-2 py-2 text-xs';
    replacement.textContent = `${labels.image}: ${asset?.alt || ''}${asset?.value ? ` (${asset.value})` : ''}`;
    const width = element.getAttribute('width'); const height = element.getAttribute('height');
    if (width || height) replacement.append(` · ${width ?? 'auto'} × ${height ?? 'auto'}`);
    replacement.style.cssText = element.getAttribute('style') ?? '';
    element.replaceWith(replacement);
  });
  const links = assets.filter((asset) => asset.kind === 'link');
  fragment.querySelectorAll('a').forEach((element, index) => {
    const annotation = document.createElement('small');
    annotation.textContent = links[index]?.value ? ` (${labels.link}: ${links[index].value})` : '';
    element.append(annotation);
  });
  fragment.querySelectorAll('[data-type="inline-math"], [data-type="block-math"]').forEach((element) => {
    const latex = element.getAttribute('data-latex') ?? '';
    element.innerHTML = purifier.sanitize(katex.renderToString(latex, { ...CANVAS_KATEX_OPTIONS,
      displayMode: element.getAttribute('data-type') === 'block-math' }));
  });
  fragment.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    const previous = element.style;
    const safe: Array<[string, string]> = [];
    for (const property of Array.from(previous)) {
      const value = previous.getPropertyValue(property).trim();
      if ((property === 'text-align' && /^(left|center|right|justify)$/u.test(value))
        || (/^(width|height|min-width|max-width|min-height|max-height|top|bottom|left|right|font-size|vertical-align|margin(?:-(?:left|right|top|bottom))?|padding(?:-(?:left|right|top|bottom))?|border-(?:bottom|top)-width)$/u.test(property)
          && /^(auto|0|-?\d+(?:\.\d+)?(?:px|%|em|rem|ex|pt))$/u.test(value))
        || (property === 'position' && /^(relative|absolute)$/u.test(value))
        || (/^border-(?:bottom|top)-style$/u.test(property) && value === 'solid')
        || (property === 'display' && /^(block|inline|inline-block)$/u.test(value))) safe.push([property, value]);
    }
    element.removeAttribute('style');
    safe.forEach(([property, value]) => element.style.setProperty(property, value));
  });
  fragment.querySelectorAll('input').forEach((element) => { element.disabled = true; });
  fragment.querySelectorAll('details').forEach((element) => { element.open = true; });
  const wrapper = document.createElement('div'); wrapper.append(fragment);
  return wrapper.innerHTML;
}
