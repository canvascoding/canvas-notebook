import 'server-only';

import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { getSchema } from '@tiptap/core';
import type * as YTypes from 'yjs';

import {
  composeCanvasMarkdownDocument,
  splitCanvasMarkdownForRichEditor,
} from '@/app/lib/markdown/obsidian-metadata';
import {
  createRichMarkdownManager,
  richMarkdownCodecExtensions,
  restoreRichMarkdownFinalLineEnding,
} from '@/app/lib/markdown/rich-markdown-codec';
import { TiptapTransformer, Y, YProsemirror } from './server-runtime';
import { equivalentRichDocument } from '../markdown/core/equivalence';

export function richMarkdownSchemaExtensions() {
  return richMarkdownCodecExtensions();
}

function markdownManager() {
  return createRichMarkdownManager();
}

type RichMarkdownJsonNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: RichMarkdownJsonNode[];
  text?: string;
  marks?: unknown[];
};

const nodeFingerprintCache = new WeakMap<RichMarkdownJsonNode, string>();

function comparableNodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparableNodeValue);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(source).map(([key, entry]) => {
      if (key !== 'attrs' || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return [key, comparableNodeValue(entry)];
      }
      const { id: _id, ...attrs } = entry as Record<string, unknown>;
      return [key, comparableNodeValue(attrs)];
    }),
  );
}

function nodeFingerprint(node: RichMarkdownJsonNode): string {
  const cached = nodeFingerprintCache.get(node);
  if (cached) return cached;
  const fingerprint = JSON.stringify(comparableNodeValue(node));
  nodeFingerprintCache.set(node, fingerprint);
  return fingerprint;
}

function nodeText(node: RichMarkdownJsonNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content || []).map(nodeText).join('');
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const maximum = Math.max(left.length, right.length);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) suffix += 1;
  return (prefix + suffix) / maximum;
}

function nodeMatchScore(left: RichMarkdownJsonNode, right: RichMarkdownJsonNode): number {
  if (!left.type || left.type !== right.type) return Number.NEGATIVE_INFINITY;
  if (nodeFingerprint(left) === nodeFingerprint(right)) return 10_000;
  const leftChildTypes = (left.content || []).map((child) => child.type || '').join('\u0000');
  const rightChildTypes = (right.content || []).map((child) => child.type || '').join('\u0000');
  return 10 + (textSimilarity(nodeText(left), nodeText(right)) * 100)
    + (leftChildTypes === rightChildTypes ? 20 : 0);
}

function alignChangedNodePairs(
  current: RichMarkdownJsonNode[],
  next: RichMarkdownJsonNode[],
): Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> {
  if (current.length * next.length > 4_096) {
    const pairs: Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> = [];
    let currentIndex = 0;
    let nextIndex = 0;
    while (currentIndex < current.length && nextIndex < next.length) {
      const currentNode = current[currentIndex];
      const nextNode = next[nextIndex];
      if (currentNode.type === nextNode.type) {
        pairs.push([currentNode, nextNode]);
        currentIndex += 1;
        nextIndex += 1;
        continue;
      }
      const matchingNext = next.slice(nextIndex + 1, nextIndex + 9)
        .findIndex((candidate) => candidate.type === currentNode.type);
      const matchingCurrent = current.slice(currentIndex + 1, currentIndex + 9)
        .findIndex((candidate) => candidate.type === nextNode.type);
      if (matchingNext >= 0 && (matchingCurrent < 0 || matchingNext <= matchingCurrent)) {
        nextIndex += 1;
      } else if (matchingCurrent >= 0) {
        currentIndex += 1;
      } else {
        currentIndex += 1;
        nextIndex += 1;
      }
    }
    return pairs;
  }

  const scores = Array.from({ length: current.length + 1 }, () => (
    Array<number>(next.length + 1).fill(0)
  ));
  for (let currentIndex = 1; currentIndex <= current.length; currentIndex += 1) {
    for (let nextIndex = 1; nextIndex <= next.length; nextIndex += 1) {
      const matchScore = nodeMatchScore(current[currentIndex - 1], next[nextIndex - 1]);
      scores[currentIndex][nextIndex] = Math.max(
        scores[currentIndex - 1][nextIndex],
        scores[currentIndex][nextIndex - 1],
        Number.isFinite(matchScore)
          ? scores[currentIndex - 1][nextIndex - 1] + matchScore
          : Number.NEGATIVE_INFINITY,
      );
    }
  }

  const pairs: Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> = [];
  let currentIndex = current.length;
  let nextIndex = next.length;
  while (currentIndex > 0 && nextIndex > 0) {
    const matchScore = nodeMatchScore(current[currentIndex - 1], next[nextIndex - 1]);
    if (
      Number.isFinite(matchScore)
      && scores[currentIndex][nextIndex] === scores[currentIndex - 1][nextIndex - 1] + matchScore
    ) {
      pairs.push([current[currentIndex - 1], next[nextIndex - 1]]);
      currentIndex -= 1;
      nextIndex -= 1;
    } else if (scores[currentIndex][nextIndex] === scores[currentIndex][nextIndex - 1]) {
      nextIndex -= 1;
    } else {
      currentIndex -= 1;
    }
  }
  return pairs.reverse();
}

/**
 * Aligns sibling nodes without relying on the fresh IDs generated while parsing
 * the replacement Markdown. Exact unchanged subtrees dominate the alignment;
 * edited siblings fall back to type, text similarity, and document order.
 */
function alignedNodePairs(
  current: RichMarkdownJsonNode[],
  next: RichMarkdownJsonNode[],
): Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> {
  const currentByFingerprint = new Map<string, RichMarkdownJsonNode[]>();
  for (const node of current) {
    const fingerprint = nodeFingerprint(node);
    const matches = currentByFingerprint.get(fingerprint) || [];
    matches.push(node);
    currentByFingerprint.set(fingerprint, matches);
  }
  const exactPairs: Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> = [];
  const exactlyMatchedCurrent = new Set<RichMarkdownJsonNode>();
  const exactlyMatchedNext = new Set<RichMarkdownJsonNode>();
  for (const node of next) {
    const match = currentByFingerprint.get(nodeFingerprint(node))?.shift();
    if (!match) continue;
    exactPairs.push([match, node]);
    exactlyMatchedCurrent.add(match);
    exactlyMatchedNext.add(node);
  }
  const changedPairs = alignChangedNodePairs(
    current.filter((node) => !exactlyMatchedCurrent.has(node)),
    next.filter((node) => !exactlyMatchedNext.has(node)),
  );
  return [...exactPairs, ...changedPairs];
}

function stableIdCounts(node: RichMarkdownJsonNode, counts = new Map<string, number>()): Map<string, number> {
  const id = node.attrs?.id;
  if (typeof id === 'string' && id.trim()) counts.set(id, (counts.get(id) || 0) + 1);
  for (const child of node.content || []) stableIdCounts(child, counts);
  return counts;
}

function preserveAlignedStableIds(
  current: RichMarkdownJsonNode,
  next: RichMarkdownJsonNode,
  currentIdCounts: Map<string, number>,
): void {
  const id = current.attrs?.id;
  if (
    current.type !== 'doc'
    && current.type !== 'text'
    && typeof id === 'string'
    && id.trim()
    && currentIdCounts.get(id) === 1
  ) {
    next.attrs = { ...(next.attrs || {}), id };
  }
  for (const [currentChild, nextChild] of alignedNodePairs(current.content || [], next.content || [])) {
    preserveAlignedStableIds(currentChild, nextChild, currentIdCounts);
  }
}

export function createRichMarkdownYDoc(markdown: string): YTypes.Doc {
  const parts = splitCanvasMarkdownForRichEditor(markdown);
  const manager = markdownManager();
  const extensions = richMarkdownSchemaExtensions();
  const json = generateUniqueIds(manager.parse(parts.body), extensions);
  const doc = TiptapTransformer.toYdoc(json, 'body', extensions);
  if (parts.prefix) doc.getText('frontmatter').insert(0, parts.prefix);
  const finalLineEnding = parts.body.match(/((?:\r?\n)+)$/u)?.[1];
  if (finalLineEnding) doc.getText('bodyFinalLineEnding').insert(0, finalLineEnding);
  return doc;
}

export function richMarkdownFromYDoc(doc: YTypes.Doc): string {
  const json = TiptapTransformer.fromYdoc(doc, 'body');
  const serializedBody = markdownManager().serialize(json);
  const body = restoreRichMarkdownFinalLineEnding(
    doc.getText('bodyFinalLineEnding').toString(),
    serializedBody,
  );
  return composeCanvasMarkdownDocument(doc.getText('frontmatter').toString(), body);
}

/**
 * Applies a complete Markdown source edit to the authoritative rich Y.Doc.
 * y-prosemirror performs a structural diff against the existing fragment, so
 * connected web editors receive a normal collaborative transaction instead
 * of a destructive whole-file replacement.
 */
export function replaceRichMarkdownInYDoc(
  doc: YTypes.Doc,
  markdown: string,
  origin?: unknown,
): void {
  const replacement = createRichMarkdownYDoc(markdown);
  try {
    const currentJson = TiptapTransformer.fromYdoc(doc, 'body') as RichMarkdownJsonNode;
    const json = TiptapTransformer.fromYdoc(replacement, 'body') as RichMarkdownJsonNode;
    preserveAlignedStableIds(currentJson, json, stableIdCounts(currentJson));
    const schema = getSchema(richMarkdownSchemaExtensions());
    const proseMirrorDocument = schema.nodeFromJSON(json);
    const parts = splitCanvasMarkdownForRichEditor(markdown);
    doc.transact(() => {
      YProsemirror.updateYFragment(
        doc,
        doc.getXmlFragment('body'),
        proseMirrorDocument,
        { mapping: new Map(), isOMark: new Map() },
      );
      const frontmatter = doc.getText('frontmatter');
      if (frontmatter.length > 0) frontmatter.delete(0, frontmatter.length);
      if (parts.prefix) frontmatter.insert(0, parts.prefix);
      const bodyFinalLineEnding = doc.getText('bodyFinalLineEnding');
      if (bodyFinalLineEnding.length > 0) bodyFinalLineEnding.delete(0, bodyFinalLineEnding.length);
      const finalLineEnding = parts.body.match(/((?:\r?\n)+)$/u)?.[1];
      if (finalLineEnding) bodyFinalLineEnding.insert(0, finalLineEnding);
    }, origin);
  } finally {
    replacement.destroy();
  }
}

export type RichMarkdownValidation = {
  valid: boolean;
  code?: 'schema_invalid' | 'stable_id_missing' | 'stable_id_duplicate' | 'roundtrip_unstable';
  markdown?: string;
};

function stableIdsFromJson(value: unknown, ids: string[], missing: { value: boolean }): void {
  if (!value || typeof value !== 'object') return;
  const node = value as { type?: unknown; attrs?: Record<string, unknown> | null; content?: unknown[] };
  if (typeof node.type === 'string' && node.type !== 'doc' && node.type !== 'text') {
    const id = node.attrs?.id;
    if (typeof id !== 'string' || !id.trim()) missing.value = true;
    else ids.push(id);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) stableIdsFromJson(child, ids, missing);
  }
}

/** Validates the authoritative rich document without mutating it. */
export function validateRichMarkdownYDoc(doc: YTypes.Doc): RichMarkdownValidation {
  let json: unknown;
  let markdown: string;
  try {
    json = TiptapTransformer.fromYdoc(doc, 'body');
    const schemaDocument = getSchema(richMarkdownSchemaExtensions()).nodeFromJSON(json);
    // A new Y.Doc can be completely empty before the first editor mounts.
    if (schemaDocument.content.size > 0) schemaDocument.check();
    markdown = richMarkdownFromYDoc(doc);
  } catch {
    return { valid: false, code: 'schema_invalid' };
  }

  const ids: string[] = [];
  const missing = { value: false };
  stableIdsFromJson(json, ids, missing);
  if (missing.value) return { valid: false, code: 'stable_id_missing', markdown };
  if (new Set(ids).size !== ids.length) return { valid: false, code: 'stable_id_duplicate', markdown };

  let roundtrip: YTypes.Doc | null = null;
  try {
    roundtrip = createRichMarkdownYDoc(markdown);
    if (richMarkdownFromYDoc(roundtrip) !== markdown
      || !equivalentRichDocument(json, TiptapTransformer.fromYdoc(roundtrip, 'body'))) {
      return { valid: false, code: 'roundtrip_unstable', markdown };
    }
  } catch {
    return { valid: false, code: 'roundtrip_unstable', markdown };
  } finally {
    roundtrip?.destroy();
  }
  return { valid: true, markdown };
}

export function createPlainTextYDoc(content: string): YTypes.Doc {
  const doc = new Y.Doc({ gc: true });
  if (content) doc.getText('content').insert(0, content);
  return doc;
}
