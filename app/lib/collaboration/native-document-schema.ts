import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import type * as YTypes from 'yjs';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from './block-tree';
import { YProsemirror } from './yjs-runtime';

export class NativeDocumentSchemaError extends Error {
  readonly code = 'schema_invalid';
  constructor() { super('The native document contains unsupported schema fields.'); this.name = 'NativeDocumentSchemaError'; }
}

function reject(): never { throw new NativeDocumentSchemaError(); }

/** Root types decode as AbstractType. Declaring the XML type must not hide Map
 * fields or their history: an XML fragment root has no legal Map attributes. */
export function readNativeXmlBody(doc: YTypes.Doc): YTypes.XmlFragment | null {
  if (!doc.share.has('body')) return null;
  try {
    const body = doc.getXmlFragment('body');
    if (body._map.size) reject();
    return body;
  } catch { return reject(); }
}
function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) reject();
}

function assertKnownRichJson(node: JSONContent, schema: Schema): void {
  assertKnownKeys(node as Record<string, unknown>, ['type', 'attrs', 'content', 'marks', 'text']);
  const type = node.type && schema.nodes[node.type];
  if (!type) reject();
  if (node.attrs) assertKnownKeys(node.attrs, Object.keys(type.spec.attrs ?? {}));
  for (const mark of node.marks ?? []) {
    assertKnownKeys(mark as Record<string, unknown>, ['type', 'attrs']);
    const markType = schema.marks[mark.type];
    if (!markType) reject();
    if (mark.attrs) assertKnownKeys(mark.attrs, Object.keys(markType.spec.attrs ?? {}));
  }
  for (const child of node.content ?? []) {
    // y-prosemirror groups text-only fragment content in one array.
    if (Array.isArray(child)) for (const inline of child) assertKnownRichJson(inline, schema);
    else assertKnownRichJson(child, schema);
  }
}

/** Read raw storage BEFORE PM fills defaults or drops unsupported fields.
 * Caller supplies the schema; this module has no Markdown reader/serializer dependency. */
export function assertNativeDocumentSchema(doc: YTypes.Doc,
  representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks', schema: Schema): void {
  const rootKeys = representation === 'plain_text' ? ['content']
    : [representation === 'tiptap_blocks' ? BLOCK_TREE_KEY : 'body', 'frontmatter', 'bodyFinalLineEnding'];
  if ([...doc.share.keys()].some(key => !rootKeys.includes(key))) reject();
  if (representation === 'plain_text') return;
  if (representation === 'tiptap_xml') {
    const body = readNativeXmlBody(doc);
    assertKnownRichJson(body ? YProsemirror.yXmlFragmentToProsemirrorJSON(body) : { type: 'doc' }, schema);
    return;
  }
  const tree = new CollaborationBlockTree(doc, schema);
  assertKnownKeys(Object.fromEntries(tree.root.entries()), ['version', 'records', 'operations', 'receipts']);
  for (const record of tree.records.values()) {
    assertKnownKeys(Object.fromEntries(record.entries()), ['initial', 'shape', 'attributes', 'content']);
    const shape = record.get('shape') as { type: string; inline: boolean };
    assertKnownKeys(shape, ['type', 'inline']);
    const type = schema.nodes[shape.type];
    if (!type) reject();
    assertKnownKeys((record.get('attributes') as YTypes.Map<unknown>).toJSON(), Object.keys(type.spec.attrs ?? {}));
    assertKnownKeys(record.get('initial') as Record<string, unknown>, ['id', 'parentId', 'order']);
    assertKnownRichJson(YProsemirror.yXmlFragmentToProsemirrorJSON(record.get('content') as YTypes.XmlFragment), schema);
  }
  for (const operation of [...tree.operations.values(), ...tree.receipts.values()]) {
    assertKnownKeys(operation, ['id', 'clock', 'actor', 'transactionId', 'ordinal', 'kind', 'blockId', 'parentId', 'beforeId', 'blockIds']);
  }
}
