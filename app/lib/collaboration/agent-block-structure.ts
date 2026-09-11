import 'server-only';

import { createHash } from 'node:crypto';
import { getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';

import { richMarkdownCodecExtensions } from '../markdown/rich-markdown-codec';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from './block-tree';
import type { BlockPlacementOperation } from './block-tree-placement';

export type AgentBlockStructure = {
  id: string;
  type: string;
  parentId: string | null;
  beforeId: string | null;
  attrs: Record<string, unknown>;
  text: string;
  subtreeHash: string;
  placementHash: string;
};

/** Stable JSON fingerprints preserve array order and all authored IDs/attrs. */
export function hashAgentBlockJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  if (encoded === undefined) throw new Error('A block fingerprint requires a JSON value.');
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/** Admission for a live block edit; Markdown projection has its own validation. */
export function validateAgentBlockDocument(doc: Y.Doc): 'schema_invalid' | 'limit_exceeded' | null {
  try {
    if (!doc.share.has(BLOCK_TREE_KEY) || doc.share.has('body') || doc.store.pendingStructs || doc.store.pendingDs) return 'schema_invalid';
    const schema = getSchema(richMarkdownCodecExtensions());
    // read verifies IDs, placement, schema and supported table geometry.
    const current = new CollaborationBlockTree(doc, schema).read();
    current.check();
    const serialized = JSON.stringify(current.toJSON());
    // Resolve the same top-level types as the editor, including after binary
    // hydration; an incompatible explicitly materialized type must still fail.
    const prefix = doc.getText('frontmatter').toString();
    const ending = doc.getText('bodyFinalLineEnding').toString();
    if (Buffer.byteLength(serialized, 'utf8') + Buffer.byteLength(prefix, 'utf8')
      + Buffer.byteLength(ending, 'utf8') > 5 * 1024 * 1024) return 'limit_exceeded';
    // JSON stringification escapes unmatched surrogates, so inspect text nodes
    // and frontmatter before serialization instead of mistaking them for ASCII.
    let invalidText = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(prefix);
    current.descendants((node) => {
      if (node.isText && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(node.text ?? '')) invalidText = true;
    });
    return invalidText ? 'schema_invalid' : null;
  } catch { return 'schema_invalid'; }
}

/** Read the visible authoritative block tree; never imports or migrates a document. */
export function readAgentBlockStructure(doc: Y.Doc): AgentBlockStructure[] {
  if (!doc.share.has(BLOCK_TREE_KEY) || doc.share.has('body')) {
    throw new Error('Structured agent operations require a tiptap_blocks document.');
  }
  if (doc.store.pendingStructs || doc.store.pendingDs) {
    throw new Error('The collaborative block document has incomplete updates.');
  }
  const schema = getSchema(richMarkdownCodecExtensions());
  const tree = new CollaborationBlockTree(doc, schema);
  const projection = tree.project();
  const current = tree.read(schema, projection);
  const nextSiblings = new Map<string, string | null>();
  for (const children of projection.children.values()) {
    children.forEach((id, index) => nextSiblings.set(id, children[index + 1] ?? null));
  }
  const placements = new Map<string, BlockPlacementOperation[]>();
  // Delivery order is irrelevant. Receipts deliberately remain excluded:
  // undoing a move restores its prior placement condition despite its receipt.
  const operations = [...tree.operations.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  for (const operation of operations) {
    for (const id of operation.kind === 'move' ? [operation.blockId] : operation.blockIds) {
      const entries = placements.get(id) ?? [];
      entries.push(operation);
      placements.set(id, entries);
    }
  }
  const result: AgentBlockStructure[] = [];
  const visit = (parent: ProseMirrorNode) => {
    parent.forEach((node) => {
      const id = node.attrs.id as string;
      if (!projection.parents.has(id) || projection.deleted.has(id)) return;
      result.push({
        id, type: node.type.name, parentId: projection.parents.get(id) ?? null,
        beforeId: nextSiblings.get(id) ?? null,
        attrs: structuredClone(node.attrs), text: node.textContent,
        subtreeHash: hashAgentBlockJson(node.toJSON()),
        placementHash: hashAgentBlockJson({
          initial: tree.records.get(id)!.get('initial'), operations: placements.get(id) ?? [],
        }),
      });
      if (!node.inlineContent && !node.isLeaf) visit(node);
    });
  };
  visit(current);
  return result;
}
