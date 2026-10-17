import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { parseChatBody, type ChatBodyV1, type ChatReferenceBundleV1 } from './chat-body-contracts';
import type { ExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { PluginExtensionAvatarIcon } from '@/app/components/plugins/PluginExtensionAvatar';

/** Public cursor offsets refer to the UTF-16 display projection, including reference captions. */
export type ChatInlineTextRange = { from: number; to: number };
export type ChatInlineReferenceIcons = Readonly<Record<string, PluginExtensionAvatarIcon | undefined>>;
export type ChatInlineBundleCache = ReadonlyMap<string, ChatReferenceBundleV1>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Presentation cache key uses the complete public selection, never its caption or a private receipt. */
export function chatInlineReferenceIconKey(selection: ExtensionSelection): string { return stableJson(selection); }

export function chatBodyToInlineEditorDocument(value: ChatBodyV1): JSONContent {
  const body = parseChatBody(value);
  const paragraphs: JSONContent[] = [{ type: 'paragraph', content: [] }];
  for (const part of body.parts) {
    if (part.type === 'extension_reference') {
      paragraphs.at(-1)!.content!.push({ type: 'extensionReference', attrs: { occurrenceId: part.occurrenceId, bundleId: part.bundleId } });
    } else {
      const lines = part.text.split('\n');
      lines.forEach((line, index) => {
        if (index) paragraphs.push({ type: 'paragraph', content: [] });
        if (line) paragraphs.at(-1)!.content!.push({ type: 'text', text: line });
      });
    }
  }
  return { type: 'doc', content: paragraphs };
}

/** Removed bundles stay in the editor's history cache, but never in the emitted body. */
export function inlineEditorDocumentToChatBody(document: JSONContent, cache: ChatInlineBundleCache): ChatBodyV1 {
  if (document.type !== 'doc' || !Array.isArray(document.content) || !document.content.length) throw new Error('An inline editor document is required.');
  const parts: ChatBodyV1['parts'] = [], reachable = new Map<string, ChatReferenceBundleV1>();
  const text = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.type === 'text') last.text += value;
    else parts.push({ type: 'text', text: value });
  };
  document.content.forEach((paragraph, index) => {
    if (paragraph.type !== 'paragraph') throw new Error('Only chat paragraphs are supported.');
    if (index) text('\n');
    for (const node of paragraph.content ?? []) {
      if (node.type === 'text' && typeof node.text === 'string' && !node.marks?.length) text(node.text);
      else if (node.type === 'hardBreak') text('\n');
      else if (node.type === 'extensionReference') {
        const { occurrenceId, bundleId } = node.attrs ?? {};
        if (typeof occurrenceId !== 'string' || typeof bundleId !== 'string') throw new Error('An inline reference needs its local identifiers.');
        const bundle = cache.get(bundleId);
        if (!bundle) throw new Error('The inline reference has no public bundle.');
        parts.push({ type: 'extension_reference', occurrenceId, bundleId }); reachable.set(bundleId, bundle);
      } else throw new Error('Unsupported chat editor content.');
    }
  });
  return parseChatBody({ version: 1, parts, bundles: [...reachable.values()] });
}

type ProjectionSegment = { from: number; to: number; textFrom: number; textTo: number; atom: boolean };
function projectionSegments(document: ProseMirrorNode, cache: ChatInlineBundleCache): ProjectionSegment[] {
  const segments: ProjectionSegment[] = [];
  let textOffset = 0, previousEnd: number | null = null;
  document.forEach((paragraph, paragraphOffset) => {
    const start = paragraphOffset + 1;
    if (previousEnd !== null) { segments.push({ from: previousEnd, to: start, textFrom: textOffset, textTo: textOffset + 1, atom: true }); textOffset++; }
    paragraph.forEach((node, offset) => {
      let length: number;
      if (node.isText) length = node.text?.length ?? 0;
      else if (node.type.name === 'hardBreak') length = 1;
      else if (node.type.name === 'extensionReference') {
        const bundle = cache.get(node.attrs.bundleId);
        if (!bundle) throw new Error('The inline reference has no public bundle.');
        length = bundle.caption.length;
      } else throw new Error('Unsupported chat editor content.');
      segments.push({ from: start + offset, to: start + offset + node.nodeSize, textFrom: textOffset, textTo: textOffset + length, atom: !node.isText });
      textOffset += length;
    });
    previousEnd = start + paragraph.content.size;
  });
  return segments;
}

export function inlineEditorPositionToTextOffset(document: ProseMirrorNode, cache: ChatInlineBundleCache, position: number): number {
  const segments = projectionSegments(document, cache);
  for (const segment of segments) {
    if (position <= segment.from) return segment.textFrom;
    if (position < segment.to) return segment.atom ? segment.textFrom : segment.textFrom + position - segment.from;
  }
  return segments.at(-1)?.textTo ?? 0;
}

/** A projected range touching an atom expands to its boundary; it never splits a reference. */
export function inlineEditorTextOffsetToPosition(document: ProseMirrorNode, cache: ChatInlineBundleCache, offset: number, association: -1 | 1 = 1): number {
  const segments = projectionSegments(document, cache), bounded = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);
  for (const segment of segments) {
    if (bounded <= segment.textFrom) return segment.from;
    if (bounded < segment.textTo) return segment.atom ? association < 0 ? segment.from : segment.to : segment.from + bounded - segment.textFrom;
    if (bounded === segment.textTo) return segment.to;
  }
  return Math.max(1, document.content.size - 1);
}

/** Plain insertion creates text nodes only; HTML, copied atoms and identifiers grant no selection. */
export function inlineEditorPlainTextContent(text: string): JSONContent[] {
  return text.split('\n').flatMap((line, index) => [
    ...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : []),
  ]);
}
