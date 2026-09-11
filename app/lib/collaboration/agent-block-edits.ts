import 'server-only';

import { createChainableState, getSchema, type CommandProps, type JSONContent, type RawCommands } from '@tiptap/core';
import { isAllowedUri } from '@tiptap/extension-link';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, CellSelection, deleteColumn, deleteRow, deleteTable, setCellAttr } from '@tiptap/pm/tables';
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { generateRichNodeIds } from '../editor/generate-rich-node-ids';
import { moveMarkdownTablePart, portableTableCommands } from '../markdown/core/table-commands';
import { richMarkdownCodecExtensions } from '../markdown/rich-markdown-codec';
import { hashAgentBlockJson, readAgentBlockStructure, validateAgentBlockDocument, type AgentBlockStructure } from './agent-block-structure';
import { BlockTreeConflict, CollaborationBlockTree } from './block-tree';
import type { BlockPlacementOperation } from './block-tree-placement';

export type AgentTableAction = 'addRowBefore' | 'addRowAfter' | 'deleteRow' | 'addColumnBefore' | 'addColumnAfter'
  | 'deleteColumn' | 'deleteTable' | 'alignLeft' | 'alignCenter' | 'alignRight' | 'alignNone'
  | 'moveRowUp' | 'moveRowDown' | 'moveColumnLeft' | 'moveColumnRight';
export type AgentBlockEditRequest =
  | { kind: 'move_block'; blockId: string; placementHash: string; parentId: string | null; beforeId: string | null }
  | { kind: 'delete_block'; blockId: string; subtreeHash: string }
  | { kind: 'insert_blocks'; parentId: string | null; beforeId: string | null; blocks: JSONContent[] }
  | { kind: 'format_block'; blockId: string; beforeAttrs: Record<string, unknown>; afterAttrs: Record<string, unknown> }
  | { kind: 'format_text'; blockId: string; subtreeHash: string; from: number; to: number;
    mark: 'bold' | 'italic' | 'strike' | 'code' | 'link'; enabled: boolean; href?: string }
  | { kind: 'table_operation'; cellId: string; subtreeHash: string; action: AgentTableAction };

type Condition = { id: string; type?: string; subtreeHash?: string; placementHash?: string;
  attrs?: Record<string, unknown>; absent?: boolean; parentId?: string | null; beforeId?: string | null };
type RecordData = { shape: { type: string; inline: boolean }; attrs: Record<string, unknown>; content: JSONContent[] };
type AttributeValue = { present: boolean; value?: unknown };
type RecordChange = { id: string; attrs: Record<string, { before: AttributeValue; after: AttributeValue }>;
  shape?: { before: RecordData['shape']; after: RecordData['shape'] };
  content?: { before: JSONContent[]; after: JSONContent[] } };
type ReverseDelta = { operations: BlockPlacementOperation[]; newRecords: Array<{ id: string; hash: string }>;
  newRoots: Condition[]; records: RecordChange[] };

/** Internal, server-prepared payload. Public tools accept AgentBlockEditRequest only. */
export type PreparedAgentBlockEdit = {
  version: 1;
  kind: 'forward' | 'reverse';
  beforeText: string;
  afterText: string;
  affectedBlockIds: string[];
  conditions: Condition[];
  postconditions: Condition[];
  updateBase64?: string;
  reverseDelta?: ReverseDelta;
};

export class AgentBlockEditError extends Error {
  constructor(readonly code: 'target_changed' | 'schema_invalid' | 'limit_exceeded') {
    super(`Structured agent edit failed: ${code}.`);
    this.name = 'AgentBlockEditError';
  }
}

const MAX_BYTES = 512 * 1024;
const MAX_REQUESTS = 32;
const MAX_NEW_BLOCKS = 256;
const equal = (left: unknown, right: unknown) => hashAgentBlockJson(left) === hashAgentBlockJson(right);
function fail(code: AgentBlockEditError['code']): never { throw new AgentBlockEditError(code); }
const schema = () => getSchema(richMarkdownCodecExtensions());
const treeFor = (doc: Y.Doc) => new CollaborationBlockTree(doc, schema());
const structure = (doc: Y.Doc) => new Map(readAgentBlockStructure(doc).map((entry) => [entry.id, entry]));

function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) fail('limit_exceeded');
}

function validateRequest(value: unknown): asserts value is AgentBlockEditRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('schema_invalid');
  const request = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512;
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const pointer = (value: unknown) => value === null || id(value);
  const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  let keys: string[];
  if (request.kind === 'move_block') {
    keys = ['kind', 'blockId', 'placementHash', 'parentId', 'beforeId'];
    if (!id(request.blockId) || !hash(request.placementHash) || !pointer(request.parentId) || !pointer(request.beforeId)
      || request.beforeId === request.blockId) fail('schema_invalid');
  } else if (request.kind === 'delete_block') {
    keys = ['kind', 'blockId', 'subtreeHash'];
    if (!id(request.blockId) || !hash(request.subtreeHash)) fail('schema_invalid');
  } else if (request.kind === 'insert_blocks') {
    keys = ['kind', 'parentId', 'beforeId', 'blocks'];
    if (!pointer(request.parentId) || !pointer(request.beforeId) || !Array.isArray(request.blocks)
      || request.blocks.length === 0) fail('schema_invalid');
  } else if (request.kind === 'format_block') {
    keys = ['kind', 'blockId', 'beforeAttrs', 'afterAttrs'];
    if (!id(request.blockId) || !object(request.beforeAttrs) || !object(request.afterAttrs)) fail('schema_invalid');
  } else if (request.kind === 'format_text') {
    keys = ['kind', 'blockId', 'subtreeHash', 'from', 'to', 'mark', 'enabled', 'href'];
    if (!id(request.blockId) || !hash(request.subtreeHash) || !Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to)
      || Number(request.from) < 0 || Number(request.to) <= Number(request.from) || typeof request.enabled !== 'boolean'
      || !['bold', 'italic', 'strike', 'code', 'link'].includes(String(request.mark))) fail('schema_invalid');
    if (request.mark === 'link' && request.enabled) {
      if (typeof request.href !== 'string' || !request.href.trim() || request.href.length > 2048 || !isAllowedUri(request.href)) fail('schema_invalid');
    } else if (request.href !== undefined) fail('schema_invalid');
  } else if (request.kind === 'table_operation') {
    keys = ['kind', 'cellId', 'subtreeHash', 'action'];
    if (!id(request.cellId) || !hash(request.subtreeHash) || !['addRowBefore', 'addRowAfter', 'deleteRow', 'addColumnBefore', 'addColumnAfter',
      'deleteColumn', 'deleteTable', 'alignLeft', 'alignCenter', 'alignRight', 'alignNone', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight']
      .includes(String(request.action))) fail('schema_invalid');
  } else fail('schema_invalid');
  if (Object.keys(request).some((key) => !keys.includes(key))) fail('schema_invalid');
}

function checked<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof AgentBlockEditError) throw error;
    if (error instanceof BlockTreeConflict && ['target_changed', 'identity_invalid'].includes(error.code)) fail('target_changed');
    fail('schema_invalid');
  }
}

function copy(doc: Y.Doc): Y.Doc {
  if (doc.store.pendingStructs || doc.store.pendingDs) fail('target_changed');
  const result = new Y.Doc();
  try { Y.applyUpdate(result, Y.encodeStateAsUpdate(doc)); return result; }
  catch (error) { result.destroy(); throw error; }
}

function validate(doc: Y.Doc): void {
  if (doc.store.pendingStructs || doc.store.pendingDs) fail('target_changed');
  const error = validateAgentBlockDocument(doc);
  if (error) fail(error);
}

function requireBlock(entries: Map<string, AgentBlockStructure>, id: string): AgentBlockStructure {
  const entry = entries.get(id);
  if (!entry) fail('target_changed');
  return entry;
}

function checkConditions(doc: Y.Doc, conditions: Condition[]): void {
  const entries = structure(doc);
  for (const condition of conditions) {
    const entry = entries.get(condition.id);
    if (condition.absent) { if (entry) fail('target_changed'); continue; }
    if (!entry || (condition.type !== undefined && condition.type !== entry.type)
      || (condition.subtreeHash !== undefined && condition.subtreeHash !== entry.subtreeHash)
      || (condition.placementHash !== undefined && condition.placementHash !== entry.placementHash)
      || (condition.parentId !== undefined && condition.parentId !== entry.parentId)
      || (condition.beforeId !== undefined && condition.beforeId !== entry.beforeId)) fail('target_changed');
    for (const [key, value] of Object.entries(condition.attrs ?? {})) if (!equal(entry.attrs[key], value)) fail('target_changed');
  }
}

function recordData(tree: CollaborationBlockTree, id: string): RecordData {
  const record = tree.records.get(id);
  if (!record) fail('target_changed');
  const content = yXmlFragmentToProsemirrorJSON(tree.content(id)).content as JSONContent[][] | undefined;
  return { shape: structuredClone(record.get('shape')) as RecordData['shape'],
    attrs: structuredClone((record.get('attributes') as Y.Map<unknown>).toJSON()), content: structuredClone((content ?? []).flat()) };
}

function recordSnapshot(tree: CollaborationBlockTree) {
  return new Map([...tree.records.keys()].map((id) => [id, recordData(tree, id)]));
}

function localPreview(doc: Y.Doc, affectedIds: string[]): string {
  const entries = structure(doc); const affected = new Set(affectedIds);
  const current = treeFor(doc).read(); const nodes = new Map<string, ProseMirrorNode>();
  current.descendants((node) => { if (!node.isText) nodes.set(node.attrs.id, node); });
  const roots = affectedIds.filter((id) => {
    let parent = entries.get(id)?.parentId;
    while (parent) {
      if (affected.has(parent)) return false;
      parent = entries.get(parent)?.parentId;
    }
    return true;
  });
  return JSON.stringify(roots.map((id) => {
    const entry = entries.get(id);
    return entry ? { id, parentId: entry.parentId, beforeId: entry.beforeId, block: nodes.get(id)?.toJSON() } : { id, absent: true };
  }), null, 2);
}

function changedRecords(before: Map<string, RecordData>, after: Map<string, RecordData>): RecordChange[] {
  const changes: RecordChange[] = [];
  for (const [id, previous] of before) {
    const next = after.get(id);
    if (!next) fail('schema_invalid');
    const change: RecordChange = { id, attrs: {} };
    for (const key of new Set([...Object.keys(previous.attrs), ...Object.keys(next.attrs)])) {
      const old = { present: Object.hasOwn(previous.attrs, key), ...(Object.hasOwn(previous.attrs, key) ? { value: previous.attrs[key] } : {}) };
      const value = { present: Object.hasOwn(next.attrs, key), ...(Object.hasOwn(next.attrs, key) ? { value: next.attrs[key] } : {}) };
      if (!equal(old, value)) change.attrs[key] = { before: old, after: value };
    }
    if (!equal(previous.shape, next.shape)) change.shape = { before: previous.shape, after: next.shape };
    if (!equal(previous.content, next.content)) change.content = { before: previous.content, after: next.content };
    if (change.shape || change.content || Object.keys(change.attrs).length) changes.push(change);
  }
  return changes;
}

function reverseFor(before: Y.Doc, after: Y.Doc, affectedBlockIds: string[]): PreparedAgentBlockEdit {
  const oldTree = treeFor(before); const nextTree = treeFor(after);
  const previous = recordSnapshot(oldTree); const next = recordSnapshot(nextTree);
  const newIds = new Set([...next.keys()].filter((id) => !previous.has(id)));
  const entries = structure(after);
  const delta: ReverseDelta = {
    operations: [...nextTree.operations.values()].filter((operation) => !oldTree.operations.has(operation.id)).map((operation) => structuredClone(operation)),
    newRecords: [...newIds].map((id) => ({ id, hash: hashAgentBlockJson(next.get(id)) })),
    newRoots: [...newIds].filter((id) => !newIds.has(entries.get(id)?.parentId ?? '')).map((id) => {
      const entry = requireBlock(entries, id);
      return { id, subtreeHash: entry.subtreeHash, placementHash: entry.placementHash, parentId: entry.parentId, beforeId: entry.beforeId };
    }),
    records: changedRecords(previous, next),
  };
  return { version: 1, kind: 'reverse', beforeText: localPreview(after, affectedBlockIds), afterText: localPreview(before, affectedBlockIds),
    affectedBlockIds, conditions: [], postconditions: [], reverseDelta: delta };
}

function applyReverse(doc: Y.Doc, delta: ReverseDelta): void {
  const tree = treeFor(doc);
  checkConditions(doc, delta.newRoots);
  for (const { id, hash } of delta.newRecords) if (hashAgentBlockJson(recordData(tree, id)) !== hash) fail('target_changed');
  for (const change of delta.records) {
    const current = recordData(tree, change.id);
    if ((change.shape && !equal(current.shape, change.shape.after)) || (change.content && !equal(current.content, change.content.after))) fail('target_changed');
    for (const [key, values] of Object.entries(change.attrs)) {
      if (!equal({ present: Object.hasOwn(current.attrs, key), ...(Object.hasOwn(current.attrs, key) ? { value: current.attrs[key] } : {}) }, values.after)) fail('target_changed');
    }
  }
  // This function only runs on disposable scratch. Its intermediate states need
  // not be schema-valid; the complete result is checked before live integration.
  doc.transact(() => {
    for (const change of delta.records) {
      const record = tree.records.get(change.id)!;
      const attrs = record.get('attributes') as Y.Map<unknown>;
      for (const [key, values] of Object.entries(change.attrs)) {
        if (values.before.present) attrs.set(key, values.before.value); else attrs.delete(key);
      }
      if (change.shape) record.set('shape', change.shape.before);
      if (change.content) {
        const shape = record.get('shape') as RecordData['shape'];
        const node = tree.schema.nodeFromJSON({ type: shape.type, attrs: attrs.toJSON(), content: change.content.before });
        updateYFragment(doc, tree.content(change.id), node, { mapping: new Map(), isOMark: new Map() });
      }
    }
    tree.revertPlacementOperations(delta.operations, 'agent-block-revert');
    if (delta.newRecords.length) {
      const insertedIds = new Set(delta.newRecords.map(({ id }) => id));
      const before = tree.read();
      const removeInserted = (node: ProseMirrorNode): ProseMirrorNode => {
        if (node.inlineContent || node.isLeaf) return node;
        const children: ProseMirrorNode[] = [];
        node.forEach((child) => { if (!insertedIds.has(child.attrs.id)) children.push(removeInserted(child)); });
        return node.type.createChecked(node.attrs, children, node.marks);
      };
      // One editor plan tombstones the whole insertion, including columns with
      // a cell in every row. Records and receipts continue to fence old retries.
      tree.applyDocumentChange(before, removeInserted(before), 'agent-block-revert');
    }
  }, 'agent-block-revert');
}

function positioned(doc: ProseMirrorNode, id: string) {
  let result: { node: ProseMirrorNode; pos: number } | undefined;
  doc.descendants((node, pos) => { if (node.attrs.id === id) result = { node, pos }; });
  if (!result) fail('target_changed');
  return result;
}

function destination(entries: Map<string, AgentBlockStructure>, parentId: string | null, beforeId: string | null): Condition[] {
  const conditions: Condition[] = [];
  if (parentId !== null) {
    const parent = requireBlock(entries, parentId);
    conditions.push({ id: parent.id, type: parent.type });
  }
  if (beforeId !== null) {
    const anchor = requireBlock(entries, beforeId);
    if (anchor.parentId !== parentId) fail('target_changed');
    conditions.push({ id: anchor.id, parentId });
  }
  return conditions;
}

function formatKeys(entry: AgentBlockStructure, request: Extract<AgentBlockEditRequest, { kind: 'format_block' }>): string[] {
  const allowed: Record<string, string> = { heading: 'level', taskItem: 'checked', orderedList: 'start', codeBlock: 'language' };
  const keys = Object.keys(request.afterAttrs);
  if (keys.length !== 1 || keys[0] !== allowed[entry.type] || !equal(Object.keys(request.beforeAttrs).sort(), keys.slice().sort())) fail('schema_invalid');
  const value = request.afterAttrs[keys[0]];
  if (entry.type === 'heading' && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 6)) fail('schema_invalid');
  if (entry.type === 'taskItem' && typeof value !== 'boolean') fail('schema_invalid');
  if (entry.type === 'orderedList' && (!Number.isSafeInteger(value) || Number(value) < 1)) fail('schema_invalid');
  if (entry.type === 'codeBlock' && value !== null && (typeof value !== 'string' || value.length > 64 || !/^[\w+-]*$/u.test(value))) fail('schema_invalid');
  return keys;
}

function containingTable(entries: Map<string, AgentBlockStructure>, cellId: string): AgentBlockStructure {
  let entry = requireBlock(entries, cellId);
  if (!['tableCell', 'tableHeader'].includes(entry.type)) fail('schema_invalid');
  while (entry.type !== 'table') {
    if (entry.parentId === null) fail('schema_invalid');
    entry = requireBlock(entries, entry.parentId);
  }
  return entry;
}

function formatText(doc: ProseMirrorNode, request: Extract<AgentBlockEditRequest, { kind: 'format_text' }>): ProseMirrorNode {
  const target = positioned(doc, request.blockId);
  if (!target.node.isTextblock || request.to > target.node.content.size) fail('schema_invalid');
  // Leaf placeholders preserve PM's one-position inline atoms while grapheme
  // boundaries remain continuous across differently marked text nodes.
  const text = target.node.textBetween(0, target.node.content.size, '', '\uFFFC');
  if (text.length !== target.node.content.size || new TextDecoder().decode(new TextEncoder().encode(text)) !== text) fail('schema_invalid');
  const boundaries = new Set([0, text.length]);
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) boundaries.add(part.index);
  if (!boundaries.has(request.from) || !boundaries.has(request.to)) fail('schema_invalid');
  const mark = doc.type.schema.marks[request.mark];
  if (!mark || !target.node.type.allowsMarkType(mark)) fail('schema_invalid');
  const state = EditorState.create({ doc });
  const from = target.pos + 1 + request.from; const to = target.pos + 1 + request.to;
  return (request.enabled ? state.tr.addMark(from, to, mark.create(request.mark === 'link' ? { href: request.href } : undefined))
    : state.tr.removeMark(from, to, mark)).doc;
}

function tableCommand(doc: ProseMirrorNode, cellId: string, action: AgentTableAction): ProseMirrorNode {
  const cell = positioned(doc, cellId);
  const state = EditorState.create({ doc, selection: CellSelection.create(doc, cell.pos) });
  const tr = state.tr;
  const parent: Partial<RawCommands> = {
    addRowBefore: () => ({ state, dispatch }) => addRowBefore(state, dispatch),
    addRowAfter: () => ({ state, dispatch }) => addRowAfter(state, dispatch),
    deleteRow: () => ({ state, dispatch }) => deleteRow(state, dispatch),
    addColumnBefore: () => ({ state, dispatch }) => addColumnBefore(state, dispatch),
    addColumnAfter: () => ({ state, dispatch }) => addColumnAfter(state, dispatch),
    deleteColumn: () => ({ state, dispatch }) => deleteColumn(state, dispatch),
    deleteTable: () => ({ state, dispatch }) => deleteTable(state, dispatch),
    setCellAttribute: (name, value) => ({ state, dispatch }) => setCellAttr(name, value)(state, dispatch),
  };
  const commands = portableTableCommands(parent);
  const props = { state: createChainableState({ state, transaction: tr }), tr, dispatch: () => undefined } as CommandProps;
  let changed = false;
  if (action.startsWith('align')) {
    const alignment = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right', alignNone: null }[action as 'alignLeft'];
    if (alignment === undefined) fail('schema_invalid');
    changed = commands.setCellAttribute!('align', alignment)(props);
  } else if (action.startsWith('move')) {
    const move = { moveRowUp: ['row', -1], moveRowDown: ['row', 1], moveColumnLeft: ['column', -1], moveColumnRight: ['column', 1] } as const;
    const value = move[action as keyof typeof move];
    if (!value) fail('schema_invalid');
    changed = moveMarkdownTablePart(props, value[0], value[1]);
  } else {
    const command = commands[action as 'addRowBefore'];
    if (typeof command !== 'function') fail('schema_invalid');
    changed = command()(props);
  }
  if (!changed) fail('target_changed');
  return doc.type.schema.nodeFromJSON(generateRichNodeIds(tr.doc.toJSON(), richMarkdownCodecExtensions()));
}

/** Prepare once on an isolated replica; block IDs and Yjs clocks are fixed here. */
export function prepareAgentBlockEdit(doc: Y.Doc, requests: AgentBlockEditRequest[]): PreparedAgentBlockEdit {
  return checked(() => {
    bounded(requests);
    if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_REQUESTS) fail('limit_exceeded');
    requests.forEach(validateRequest);
    const scratch = copy(doc);
    try {
      const initial = structure(scratch); const conditions: Condition[] = []; const affected = new Set<string>();
      const tableIds = new Set<string>(); const movedIds = new Set<string>(); const formatted = new Map<string, Record<string, unknown>>();
      const formattedTextIds = new Set<string>();
      const deletedIds = new Set<string>();
      for (const request of requests) {
        if (request.kind === 'move_block') {
          conditions.push({ id: request.blockId, placementHash: request.placementHash }, ...destination(initial, request.parentId, request.beforeId));
          affected.add(request.blockId); movedIds.add(request.blockId);
        } else if (request.kind === 'delete_block') {
          conditions.push({ id: request.blockId, subtreeHash: request.subtreeHash }); affected.add(request.blockId); deletedIds.add(request.blockId);
        } else if (request.kind === 'insert_blocks') {
          conditions.push(...destination(initial, request.parentId, request.beforeId));
          if (!Array.isArray(request.blocks) || request.blocks.length === 0) fail('schema_invalid');
        } else if (request.kind === 'format_block') {
          const entry = requireBlock(initial, request.blockId); formatKeys(entry, request);
          conditions.push({ id: request.blockId, type: entry.type, attrs: request.beforeAttrs });
          formatted.set(request.blockId, { ...formatted.get(request.blockId), ...request.afterAttrs }); affected.add(request.blockId);
        } else if (request.kind === 'format_text') {
          conditions.push({ id: request.blockId, subtreeHash: request.subtreeHash });
          formattedTextIds.add(request.blockId); affected.add(request.blockId);
        } else if (request.kind === 'table_operation') {
          const table = containingTable(initial, request.cellId);
          conditions.push({ id: table.id, subtreeHash: request.subtreeHash }); tableIds.add(table.id); affected.add(table.id);
        } else fail('schema_invalid');
      }
      checkConditions(scratch, conditions);
      const tree = treeFor(scratch);
      const beforeIds = new Set(tree.records.keys());
      const beforeOperationIds = new Set(tree.operations.keys());
      for (const request of requests) {
        const before = tree.read();
        if (request.kind === 'move_block') tree.move({ ...request, operationId: crypto.randomUUID() }, 'agent-block-prepare');
        else if (request.kind === 'delete_block') tree.delete(request.blockId, crypto.randomUUID(), 'agent-block-prepare');
        else if (request.kind === 'format_block') {
          const target = positioned(before, request.blockId);
          const state = EditorState.create({ doc: before });
          const next = state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, ...request.afterAttrs }).doc;
          tree.applyDocumentChange(before, next, 'agent-block-prepare');
        } else if (request.kind === 'format_text') {
          tree.applyDocumentChange(before, formatText(before, request), 'agent-block-prepare');
        } else if (request.kind === 'insert_blocks') {
          destination(structure(scratch), request.parentId, request.beforeId);
          const existingIds = new Set(tree.records.keys());
          const clearIds = (node: JSONContent): JSONContent => ({ ...node,
            ...(node.attrs ? { attrs: Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== 'id')) } : {}),
            ...(node.content ? { content: node.content.map(clearIds) } : {}) });
          const blocks = request.blocks.map(clearIds).map((node) => tree.schema.nodeFromJSON(node));
          if (blocks.some((node) => !node.isBlock)) fail('schema_invalid');
          const parent = request.parentId === null ? { node: before, pos: -1 } : positioned(before, request.parentId);
          if (parent.node.inlineContent || parent.node.isLeaf) fail('schema_invalid');
          const at = request.beforeId === null ? parent.pos + 1 + parent.node.content.size : positioned(before, request.beforeId).pos;
          const state = EditorState.create({ doc: before });
          const inserted = state.tr.insert(at, Fragment.fromArray(blocks)).doc;
          const next = tree.schema.nodeFromJSON(generateRichNodeIds(inserted.toJSON(), richMarkdownCodecExtensions()));
          tree.applyDocumentChange(before, next, 'agent-block-prepare');
          const actual = structure(scratch);
          const created = new Set([...tree.records.keys()].filter((id) => !existingIds.has(id)));
          const topLevel = [...created].filter((id) => !created.has(actual.get(id)?.parentId ?? ''));
          const ordered = (tree.project().children.get(request.parentId) ?? []).filter((id) => topLevel.includes(id));
          if (topLevel.length !== blocks.length || ordered.length !== blocks.length
            || ordered.some((id, index) => actual.get(id)?.type !== blocks[index].type.name)
            || actual.get(ordered.at(-1)!)?.beforeId !== request.beforeId) fail('schema_invalid');
        } else tree.applyDocumentChange(before, tableCommand(before, request.cellId, request.action), 'agent-block-prepare');
      }
      validate(scratch);
      const after = structure(scratch); const postconditions: Condition[] = [];
      // A batch can move an existing block into a container before deleting
      // that container. Guard the actual destruction set, not just the
      // container's original subtree named by the public request.
      const destructiveIds = new Set([...tree.operations.values()]
        .filter((operation) => !beforeOperationIds.has(operation.id))
        .flatMap((operation) => operation.kind === 'delete' ? operation.blockIds : []));
      for (const id of destructiveIds) if (beforeIds.has(id)) {
        const entry = requireBlock(initial, id);
        if (!conditions.some((condition) => condition.id === id && condition.subtreeHash === entry.subtreeHash)) {
          conditions.push({ id, subtreeHash: entry.subtreeHash });
        }
        affected.add(id);
      }
      const addedIds = [...tree.records.keys()].filter((id) => !beforeIds.has(id));
      if (addedIds.length > MAX_NEW_BLOCKS) fail('limit_exceeded');
      for (const id of addedIds) {
        affected.add(id); conditions.push({ id, absent: true });
        const entry = after.get(id);
        if (!entry) fail('schema_invalid');
        postconditions.push({ id, subtreeHash: entry.subtreeHash, parentId: entry.parentId, beforeId: entry.beforeId });
      }
      for (const id of movedIds) {
        const entry = after.get(id);
        postconditions.push(entry ? { id, parentId: entry.parentId, beforeId: entry.beforeId } : { id, absent: true });
      }
      for (const id of deletedIds) postconditions.push({ id, absent: true });
      for (const [id, attrs] of formatted) postconditions.push(after.has(id) ? { id, attrs } : { id, absent: true });
      for (const id of formattedTextIds) postconditions.push(after.has(id) ? { id, subtreeHash: after.get(id)!.subtreeHash } : { id, absent: true });
      for (const id of tableIds) postconditions.push(after.has(id) ? { id, subtreeHash: after.get(id)!.subtreeHash } : { id, absent: true });
      const prepared: PreparedAgentBlockEdit = { version: 1, kind: 'forward', beforeText: localPreview(doc, [...affected]), afterText: localPreview(scratch, [...affected]),
        affectedBlockIds: [...affected], conditions, postconditions,
        updateBase64: Buffer.from(Y.encodeStateAsUpdate(scratch, Y.encodeStateVector(doc))).toString('base64') };
      bounded(prepared);
      // Include the inverse's size in admission; never discover an oversized
      // rollback payload only after the authoritative operation has applied.
      bounded(reverseFor(doc, scratch, prepared.affectedBlockIds));
      return prepared;
    } finally { scratch.destroy(); }
  });
}

function candidateFor(doc: Y.Doc, prepared: PreparedAgentBlockEdit): Y.Doc {
  bounded(prepared);
  if (prepared.version !== 1 || !['forward', 'reverse'].includes(prepared.kind)) fail('schema_invalid');
  const candidate = copy(doc);
  try {
    if (prepared.kind === 'forward') {
      if (!prepared.updateBase64 || prepared.reverseDelta) fail('schema_invalid');
      checkConditions(candidate, prepared.conditions);
      const tree = treeFor(candidate);
      for (const condition of prepared.conditions) if (condition.absent && tree.records.has(condition.id)) fail('target_changed');
      const existingOperations = new Map(tree.operations);
      const conflictStatus = () => hashAgentBlockJson(tree.project().conflicts
        .filter((conflict) => conflict.operationId && existingOperations.has(conflict.operationId))
        .map((conflict) => hashAgentBlockJson(conflict)).sort());
      const beforeConflicts = conflictStatus();
      Y.applyUpdate(candidate, Buffer.from(prepared.updateBase64, 'base64'));
      if (candidate.store.pendingStructs || candidate.store.pendingDs) fail('target_changed');
      // An old clock can replay ahead of a later human placement and reject
      // (or reactivate) it. The agent's own postconditions alone cannot prove
      // that this preserved the already accepted foreign operation.
      for (const [id, operation] of existingOperations) {
        const current = tree.operations.get(id);
        if (!current || !equal(operation, current)) fail('target_changed');
      }
      if (conflictStatus() !== beforeConflicts) fail('target_changed');
      checkConditions(candidate, prepared.postconditions);
    } else {
      if (!prepared.reverseDelta || prepared.updateBase64) fail('schema_invalid');
      applyReverse(candidate, prepared.reverseDelta);
    }
    validate(candidate);
    return candidate;
  } catch (error) { candidate.destroy(); throw error; }
}

/** Preview current affected content; bind approval only to the checked plan. */
export function previewAgentBlockEdit(doc: Y.Doc, prepared: PreparedAgentBlockEdit): { beforeText: string; afterText: string; footprintHash: string } {
  return checked(() => {
    const candidate = candidateFor(doc, prepared);
    try {
      return { beforeText: localPreview(doc, prepared.affectedBlockIds), afterText: localPreview(candidate, prepared.affectedBlockIds),
        // candidateFor has checked these guards against the current document.
        // Context text displayed for a move is deliberately not an approval guard.
        footprintHash: hashAgentBlockJson({ version: prepared.version, kind: prepared.kind,
          conditions: prepared.conditions, postconditions: prepared.postconditions, reverseDelta: prepared.reverseDelta ?? null }) };
    } finally { candidate.destroy(); }
  });
}

/** Validate the entire current group, then integrate its delta as one live update. */
export function applyAgentBlockEdit(doc: Y.Doc, prepared: PreparedAgentBlockEdit, origin: unknown): { reverse: PreparedAgentBlockEdit | null } {
  return checked(() => {
    const candidate = candidateFor(doc, prepared);
    try {
      const reverse = prepared.kind === 'forward' ? reverseFor(doc, candidate, prepared.affectedBlockIds) : null;
      if (reverse) bounded(reverse);
      const update = Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(doc));
      Y.applyUpdate(doc, update, origin);
      return { reverse };
    } finally { candidate.destroy(); }
  });
}
