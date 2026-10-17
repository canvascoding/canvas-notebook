import 'server-only';

import { createHash } from 'node:crypto';
import type { JSONContent } from '@tiptap/core';
import type * as YTypes from 'yjs';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from '../collaboration/block-tree';
import { inspectPersistedNativeCollaborationSnapshot, type NativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { getCanvasNotebookExactLinkTarget } from './obsidian-link-resolver';
import { getObsidianWikiDisplayLabel, parseObsidianBlockIds, parseObsidianWikiTarget } from './obsidian-flavored-markdown';
import { parseCanvasMarkdownDocument } from './obsidian-metadata';
import { extractWorkspaceMarkdownHeadings } from './workspace-link-index-core';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';
import { parseWorkspaceLocalLinks } from './workspace-local-link-parser';
import type { NativeDocumentLink, NativeDocumentLinkInventory, NativeLinkCoverageGap, NativeLinkReference, NativeLinkTextReference } from './workspace-link-contract-v2';

const NODE_TYPES = new Set(['doc', 'paragraph', 'heading', 'text', 'hardBreak', 'codeBlock', 'horizontalRule',
  'blockquote', 'orderedList', 'bulletList', 'listItem', 'taskList', 'taskItem', 'table', 'tableRow', 'tableCell',
  'tableHeader', 'obsidianWikiLink', 'image', 'inlineMath', 'blockMath', 'markdownMention', 'markdownFootnoteReference',
  'markdownFootnoteDefinition', 'canvasCallout', 'canvasCalloutTitle', 'canvasDetails', 'canvasDetailsSummary', 'canvasDetailsContent']);
const MARK_TYPES = new Set(['link', 'bold', 'italic', 'strike', 'underline', 'canvasHighlight', 'code']);
const MAX_LINKS = 20_000;

export function nativeLinkJsonProof(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => !entry || typeof entry !== 'object' || Array.isArray(entry)
    ? entry : Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  return createHash('sha256').update(canonical ?? 'null').digest('hex');
}

function anchor(doc: YTypes.Text | YTypes.XmlFragment, index: number, assoc = 0): string {
  return Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc, index, assoc))).toString('base64');
}

function textReference(text: YTypes.Text, start: number, end: number, blockId: string | null): NativeLinkTextReference {
  return { blockId, startAnchor: anchor(text, start), endAnchor: anchor(text, end, -1) };
}

function refIdentity(ref: NativeLinkReference): unknown {
  if (ref.kind === 'node-attribute') return { kind: ref.kind, ownerBlockId: ref.ownerBlockId,
    nodeId: ref.nodeId, attribute: ref.attribute, membershipAnchor: ref.membershipAnchor };
  return { kind: ref.kind, text: ref.text };
}

/** URL attributes have already passed Markdown delimiter decoding. Decode percent
 * escapes once; never perform Markdown backslash-unescaping on a native href/src. */
function attributeTarget(value: string): { classification: NativeDocumentLink['classification']; path: string; fragment: string | null } | null {
  const notebook = getCanvasNotebookExactLinkTarget(value);
  if (notebook) return notebook.path.includes('\0') ? null
    : { classification: 'local', path: `/${notebook.path.replace(/^\/+/, '')}`, fragment: notebook.fragment };
  const input = value;
  if (/^(?:https?:|mailto:|data:|\/\/)/iu.test(input)) return { classification: 'external', path: '', fragment: null };
  if (/^[a-z][a-z0-9+.-]*:/iu.test(input) || input.includes('?') || input.includes('\0')) return null;
  const hash = input.indexOf('#');
  const path = hash < 0 ? input : input.slice(0, hash);
  const fragment = hash < 0 ? null : input.slice(hash + 1);
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  return { classification: decoded ? 'local' : 'anchor-only',
    path: decoded, fragment };
}

function headingText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'obsidianWikiLink') {
    const parsed = parseObsidianWikiTarget(String(node.attrs?.target ?? ''));
    return parsed ? getObsidianWikiDisplayLabel(parsed) : '';
  }
  if (node.type === 'image') return String(node.attrs?.alt ?? '');
  if (node.type === 'markdownMention') return `@${String(node.attrs?.label ?? '')}`;
  if (node.type === 'inlineMath') return String(node.attrs?.latex ?? '');
  return (node.content ?? []).map(headingText).join('');
}

/** Called only inside the Foundation's verified same-binary inspection seam.
 * No serializer, file read, room write, or reinitialization occurs here. */
export function inspectNativeDocumentLinks(
  doc: YTypes.Doc,
  snapshot: NativeCollaborationSnapshot,
): NativeDocumentLinkInventory {
  const gaps: NativeLinkCoverageGap[] = [];
  const links: NativeDocumentLink[] = [];
  const { documentId, workspaceId, organizationId, path, lifecycleGeneration, representation, schemaVersion } = snapshot;
  const document = { documentId, workspaceId, organizationId, path, lifecycleGeneration, representation, schemaVersion };
  const gap = (code: NativeLinkCoverageGap['code'], detail: Omit<NativeLinkCoverageGap, 'code' | 'path'> = {}) => gaps.push({ code, path, ...detail });
  const content = snapshot.content;
  const roots = representation === 'plain_text' ? ['content']
    : [representation === 'tiptap_blocks' ? BLOCK_TREE_KEY : 'body', 'frontmatter', 'bodyFinalLineEnding'];
  for (const key of doc.share.keys()) if (!roots.includes(key)) gap('unknown-node', { attribute: `root.${key}` });
  const metadataSource = content.kind === 'plain_text' ? content.text : content.frontmatter;
  const parsedMetadata = parseCanvasMarkdownDocument(metadataSource);
  if (parsedMetadata.error || content.kind === 'rich_text'
    && (metadataSource.trim() && !parsedMetadata.hasFrontmatter || parsedMetadata.body.trim())) gap('invalid-frontmatter');
  const headings = content.kind === 'plain_text' ? extractWorkspaceMarkdownHeadings(content.text) : [];
  if (content.kind === 'rich_text') {
    const headingsIn = (node: JSONContent) => {
      if (node.type === 'heading') headings.push({ depth: Number(node.attrs?.level ?? 1), text: headingText(node) });
      for (const child of node.content ?? []) headingsIn(child);
    };
    headingsIn(content.document);
  }
  const metadata = { path, aliases: parsedMetadata.frontmatter?.aliases ?? [],
    tags: parsedMetadata.frontmatter?.tags ?? [], title: parsedMetadata.frontmatter?.title || headings[0]?.text
      || path.split('/').at(-1)!.replace(/\.(?:md|markdown)$/iu, ''),
    hasExplicitTitle: Boolean(parsedMetadata.frontmatter?.title), headings,
    blockIds: content.kind === 'plain_text' ? parseObsidianBlockIds(content.text).map((entry) => entry.id) : [] };
  const result = () => ({ contractVersion: 2 as const, parserVersion: 2 as const, document,
    version: { ...snapshot.version }, metadata, links, coverage: { complete: gaps.length === 0, gaps } });
  if (Buffer.byteLength(content.kind === 'plain_text' ? content.text : JSON.stringify(content), 'utf8') > MAX_INDEXED_MARKDOWN_BYTES) {
    gap('limit-exceeded'); return result();
  }
  const ordinals = new Map<string, number>();
  const add = (input: Omit<NativeDocumentLink, 'id' | 'cloneLocator'>) => {
    if (links.length >= MAX_LINKS) { if (!gaps.some((entry) => entry.code === 'limit-exceeded')) gap('limit-exceeded'); return; }
    const ownerBlockId = input.ref.kind === 'node-attribute' ? input.ref.ownerBlockId : input.ref.text.blockId;
    const nodeId = input.ref.kind === 'node-attribute' ? input.ref.nodeId : null;
    const key = `${ownerBlockId ?? ''}:${nodeId ?? ''}:${input.ref.kind}`;
    const ordinal = ordinals.get(key) ?? 0; ordinals.set(key, ordinal + 1);
    links.push({ ...input, cloneLocator: { ownerBlockId, nodeId, ordinal },
      id: `${documentId}:${lifecycleGeneration}:${nativeLinkJsonProof(refIdentity(input.ref))}` });
  };
  if (content.kind === 'plain_text') {
    const text = doc.getText('content');
    const parsed = parseWorkspaceLocalLinks(content.text, path, { notebookPaths: 'exact' });
    for (const link of parsed.links) add({ kind: link.kind, syntax: link.syntax, literal: link.targetLiteral,
      targetPathText: link.targetPathText, fragment: link.fragment, alias: link.alias, embed: link.embed,
      classification: 'local', ref: { kind: 'plain-target', text: textReference(text, link.targetStart, link.targetEnd, null),
        syntaxText: textReference(text, link.start, link.end, null),
        expected: link.targetLiteral, syntaxStart: link.start, syntaxEnd: link.end, targetStart: link.targetStart,
        targetEnd: link.targetEnd, raw: link.raw } });
    for (const ignored of parsed.unevaluated) gap(ignored.reason === 'html' ? 'uninspected-html' : 'unsupported-target',
      { raw: ignored.raw, ...(ignored.htmlTargets ? { htmlTargets: ignored.htmlTargets } : {}) });
    return result();
  }

  const schema = getNativeInspectionSchema();
  const inspectAttrs = (type: string, attrs: Record<string, unknown>, nodeId?: string, mark = false) => {
    const knownType = mark ? MARK_TYPES.has(type) : NODE_TYPES.has(type);
    if (!knownType) { gap(mark ? 'unknown-mark' : 'unknown-node', { nodeId, attribute: type }); return; }
    const declared = (mark ? schema.marks[type] : schema.nodes[type])?.spec.attrs ?? {};
    for (const name of Object.keys(attrs)) if (!(name in declared)) gap('unknown-attribute', { nodeId, attribute: `${type}.${name}` });
  };
  const emitAttribute = (type: string, attrs: Record<string, unknown>, ownerBlockId: string | null, membershipAnchor: string | null) => {
    const nodeId = typeof attrs.id === 'string' ? attrs.id : '';
    inspectAttrs(type, attrs, nodeId);
    if (type !== 'obsidianWikiLink' && type !== 'image') return;
    const attribute = type === 'obsidianWikiLink' ? 'target' : 'src';
    const value = attrs[attribute];
    if (typeof value !== 'string' || !value) { gap('invalid-target', { nodeId, attribute }); return; }
    const ref: NativeLinkReference = { kind: 'node-attribute', ownerBlockId, nodeId, attribute,
      expected: value, membershipAnchor };
    if (type === 'obsidianWikiLink') {
      const parsed = parseObsidianWikiTarget(value);
      if (!parsed) { gap('invalid-target', { nodeId, attribute }); return; }
      const fragment = parsed.heading ?? (parsed.blockId ? `^${parsed.blockId}` : null);
      // The parsed target excludes the display alias, unlike the full stored attribute.
      add({ kind: 'wiki', syntax: attrs.embed === true ? 'wiki-embed' : 'wiki-link', literal: parsed.target,
        targetPathText: parsed.path, fragment, alias: parsed.alias, embed: attrs.embed === true,
        classification: parsed.path ? 'local' : 'anchor-only', ref });
    } else {
      const parsed = attributeTarget(value);
      if (!parsed) { gap('unsupported-target', { nodeId, attribute }); return; }
      add({ kind: 'markdown', syntax: 'inline-image', literal: value, targetPathText: parsed.path,
        fragment: parsed.fragment, alias: null, embed: true, classification: parsed.classification, ref });
    }
  };
  const inspectText = (text: YTypes.XmlText, ownerBlockId: string | null) => {
    let offset = 0;
    let pending: { from: number; to: number; attrs: Record<string, unknown> } | null = null;
    const flush = () => {
      if (!pending) return;
      const href = pending.attrs.href;
      if (typeof href !== 'string') { gap('invalid-target', { nodeId: ownerBlockId ?? undefined, attribute: 'link.href' }); pending = null; return; }
      const parsed = attributeTarget(href);
      if (!parsed) gap('unsupported-target', { nodeId: ownerBlockId ?? undefined, attribute: 'link.href' });
      else add({ kind: 'markdown', syntax: 'inline-link', literal: href, targetPathText: parsed.path,
        fragment: parsed.fragment, alias: null, embed: false, classification: parsed.classification,
        ref: { kind: 'link-mark', text: textReference(text, pending.from, pending.to, ownerBlockId),
          expected: structuredClone(pending.attrs) } });
      pending = null;
    };
    for (const part of text.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
      if (typeof part.insert !== 'string') { gap('unknown-node', { nodeId: ownerBlockId ?? undefined }); flush(); continue; }
      const length = part.insert.length;
      for (const [mark, attrs] of Object.entries(part.attributes ?? {})) {
        if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) gap('unknown-attribute', { attribute: mark });
        else inspectAttrs(mark, attrs as Record<string, unknown>, ownerBlockId ?? undefined, true);
      }
      const link = part.attributes?.link;
      if (link && typeof link === 'object' && !Array.isArray(link)) {
        const attrs = link as Record<string, unknown>;
        if (pending && pending.to === offset && nativeLinkJsonProof(pending.attrs) === nativeLinkJsonProof(attrs)) pending.to += length;
        else { flush(); pending = { from: offset, to: offset + length, attrs }; }
      } else flush();
      offset += length;
    }
    flush();
  };
  const inspectFragment = (fragment: YTypes.XmlFragment, ownerBlockId: string | null) => {
    for (const [index, child] of fragment.toArray().entries()) {
      if (child instanceof Y.XmlText) inspectText(child, ownerBlockId);
      else if (child instanceof Y.XmlElement) {
        emitAttribute(child.nodeName, child.getAttributes() as Record<string, unknown>, ownerBlockId, anchor(fragment, index));
        inspectFragment(child, ownerBlockId);
      } else gap('unknown-node', { nodeId: ownerBlockId ?? undefined });
    }
  };
  if (representation === 'tiptap_blocks') {
    const tree = new CollaborationBlockTree(doc, schema);
    const projection = tree.project();
    for (const key of tree.root.keys()) if (!['version', 'records', 'operations', 'receipts'].includes(key)) gap('unknown-attribute', { attribute: `block-tree.${key}` });
    for (const [id, record] of tree.records) {
      if (projection.deleted.has(id) || !projection.parents.has(id)) continue;
      for (const key of record.keys()) if (!['initial', 'shape', 'attributes', 'content'].includes(key)) gap('unknown-attribute', { nodeId: id, attribute: `record.${key}` });
      const shape = record.get('shape') as { type: string; inline: boolean };
      for (const key of Object.keys(shape)) if (!['type', 'inline'].includes(key)) gap('unknown-attribute', { nodeId: id, attribute: `shape.${key}` });
      const attrs = (record.get('attributes') as YTypes.Map<unknown>).toJSON();
      emitAttribute(shape.type, attrs, id, null);
      if (shape.inline) inspectFragment(tree.content(id), id);
    }
  } else inspectFragment(doc.getXmlFragment('body'), null);
  return result();
}

export function inspectPersistedDocumentLinks(state: PersistedCollaborationState): NativeDocumentLinkInventory {
  return inspectPersistedNativeCollaborationSnapshot(state, inspectNativeDocumentLinks);
}
