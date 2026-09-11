import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import {
  isBlockPlacementOperation,
  projectBlockPlacements,
  type BlockPlacementOperation,
  type BlockPlacementProjection,
  type InitialBlockPlacement,
} from './block-tree-placement';
import { RICH_BLOCK_TREE_FORMAT_VERSION } from './types';

export const BLOCK_TREE_FORMAT_VERSION = RICH_BLOCK_TREE_FORMAT_VERSION;
export const BLOCK_TREE_KEY = 'canvas-block-tree-v1';

type BlockProperties = { type: string; attrs: Record<string, unknown>; inline: boolean };
type BlockRecord = Y.Map<unknown>;

type DocumentBlock = InitialBlockPlacement & { node: ProseMirrorNode };
export type BlockMoveIntent = { blockId: string; parentId: string | null; beforeId: string | null };

function documentBlocks(doc: ProseMirrorNode): Map<string, DocumentBlock> {
  const blocks = new Map<string, DocumentBlock>();
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.isText) return;
    const id = node.attrs.id;
    if (typeof id !== 'string' || !id || ids.has(id)) throw new BlockTreeConflict('identity_invalid');
    ids.add(id);
  });
  const visit = (parent: ProseMirrorNode, parentId: string | null) => {
    parent.forEach((node, _offset, order) => {
      const id = node.attrs.id as string;
      blocks.set(id, { id, parentId, order, node });
      if (!node.inlineContent && !node.isLeaf) visit(node, id);
    });
  };
  visit(doc, null);
  return blocks;
}

function properties(record: BlockRecord): BlockProperties {
  const shape = record.get('shape') as { type: string; inline: boolean };
  const attrs = record.get('attributes') as Y.Map<unknown>;
  return { ...shape, attrs: attrs.toJSON() };
}

export class BlockTreeConflict extends Error {
  constructor(readonly code: 'format_mismatch' | 'identity_invalid' | 'target_changed' | 'structure_invalid') {
    super(`Block structure operation failed: ${code}.`);
    this.name = 'BlockTreeConflict';
  }
}

/**
 * Versioned storage candidate. It is deliberately not a second writer to the
 * legacy body fragment. Production activation requires a fenced migration and
 * the editor/agent adapters for this representation.
 */
export class CollaborationBlockTree {
  readonly root: Y.Map<unknown>;
  readonly records: Y.Map<BlockRecord>;
  readonly operations: Y.Map<BlockPlacementOperation>;
  readonly receipts: Y.Map<BlockPlacementOperation>;

  constructor(readonly doc: Y.Doc, readonly schema: Schema) {
    this.root = doc.getMap(BLOCK_TREE_KEY);
    if (this.root.get('version') !== BLOCK_TREE_FORMAT_VERSION
      || doc.share.has('body') || !(this.root.get('records') instanceof Y.Map)
      || !(this.root.get('operations') instanceof Y.Map) || !(this.root.get('receipts') instanceof Y.Map)) {
      throw new BlockTreeConflict('format_mismatch');
    }
    this.records = this.root.get('records') as Y.Map<BlockRecord>;
    this.operations = this.root.get('operations') as Y.Map<BlockPlacementOperation>;
    this.receipts = this.root.get('receipts') as Y.Map<BlockPlacementOperation>;
  }

  static create(doc: Y.Doc, initial: ProseMirrorNode): CollaborationBlockTree {
    if (doc.share.has(BLOCK_TREE_KEY) || doc.share.has('body')) throw new BlockTreeConflict('format_mismatch');
    initial.check();
    const blocks = documentBlocks(initial);
    const root = doc.getMap(BLOCK_TREE_KEY);
    const records = new Y.Map<BlockRecord>();
    const operations = new Y.Map<BlockPlacementOperation>();
    doc.transact(() => {
      root.set('version', BLOCK_TREE_FORMAT_VERSION);
      root.set('records', records);
      root.set('operations', operations);
      root.set('receipts', new Y.Map<BlockPlacementOperation>());
      const tree = new CollaborationBlockTree(doc, initial.type.schema);
      for (const block of blocks.values()) tree.addRecord(block);
    }, 'block-tree-import');
    return new CollaborationBlockTree(doc, initial.type.schema);
  }

  private addRecord(block: DocumentBlock): void {
    const { id, parentId, order, node } = block;
    const record = new Y.Map<unknown>();
    record.set('initial', { id, parentId, order } satisfies InitialBlockPlacement);
    record.set('shape', { type: node.type.name, inline: node.inlineContent });
    record.set('attributes', new Y.Map(Object.entries(node.attrs)));
    const content = new Y.XmlFragment();
    record.set('content', content);
    this.records.set(id, record);
    if (node.inlineContent) updateYFragment(this.doc, content, node, { mapping: new Map(), isOMark: new Map() });
  }

  project(): BlockPlacementProjection {
    const initial = [...this.records.entries()].map(([id, record]) => {
      if (!(record instanceof Y.Map)) throw new BlockTreeConflict('format_mismatch');
      const placement = record.get('initial') as InitialBlockPlacement | undefined;
      if (!placement || placement.id !== id) throw new BlockTreeConflict('identity_invalid');
      return placement;
    });
    for (const [id, operation] of this.operations) {
      if (!operation || operation.id !== id) throw new BlockTreeConflict('identity_invalid');
    }
    return projectBlockPlacements(initial, [...this.operations.values()]);
  }

  createUndoManager(origin: unknown): Y.UndoManager {
    // Receipts are durable even when the corresponding operation is undone:
    // retrying that operation must not silently redo it.
    return new Y.UndoManager([this.records, this.operations], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  }

  content(blockId: string): Y.XmlFragment {
    const record = this.records.get(blockId);
    const content = record?.get('content');
    if (!(content instanceof Y.XmlFragment)) throw new BlockTreeConflict('target_changed');
    return content;
  }

  read(schema: Schema = this.schema, projection = this.project()): ProseMirrorNode {
    if (projection.conflicts.some((conflict) => conflict.reason === 'orphan')) throw new BlockTreeConflict('structure_invalid');
    const build = (id: string): ProseMirrorNode => {
      const record = this.records.get(id)!;
      const props = properties(record);
      if (props.attrs.id !== id) throw new BlockTreeConflict('identity_invalid');
      if (props.inline && (projection.children.get(id)?.length ?? 0) > 0) throw new BlockTreeConflict('structure_invalid');
      const children = props.inline
        ? (yXmlFragmentToProsemirrorJSON(this.content(id)).content as unknown[][]).flat().map((json) => schema.nodeFromJSON(json))
        : (projection.children.get(id) ?? []).map(build);
      const type = schema.nodes[props.type];
      if (!type || type.inlineContent !== props.inline) throw new BlockTreeConflict('structure_invalid');
      return type.createChecked(props.attrs, children);
    };
    const result = schema.topNodeType.createChecked(null, (projection.children.get(null) ?? []).map(build));
    documentBlocks(result);
    result.descendants((node) => {
      // Table schemas accept rows with different cell counts. Concurrent row
      // and column edits must not trigger a view-local automatic repair that
      // invents new cells or writes a lossy checkpoint. Keep all CRDT records
      // available for recovery and require resolution of the invalid geometry.
      if (node.type.spec.tableRole === 'table' && TableMap.get(node).problems?.length) {
        throw new BlockTreeConflict('structure_invalid');
      }
    });
    return result;
  }

  private stamp(id: string) {
    if (typeof id !== 'string' || !id) throw new BlockTreeConflict('identity_invalid');
    // The integrated state vector is monotonic even when an operation is undone
    // or a process restarts. Summing it yields a causal logical clock.
    const clock = [...Y.decodeStateVector(Y.encodeStateVector(this.doc)).values()].reduce((sum, value) => sum + value, 1);
    if (!Number.isSafeInteger(clock)) throw new BlockTreeConflict('structure_invalid');
    return { id, clock, actor: this.doc.clientID, transactionId: id, ordinal: 0 };
  }

  move(input: { blockId: string; parentId: string | null; beforeId: string | null; operationId: string }, origin: unknown): void {
    const existing = this.receipts.get(input.operationId);
    if (existing) {
      if (existing.kind !== 'move' || existing.blockId !== input.blockId
        || existing.parentId !== input.parentId || existing.beforeId !== input.beforeId) {
        throw new BlockTreeConflict('identity_invalid');
      }
      return;
    }
    const operation: BlockPlacementOperation = { ...this.stamp(input.operationId), kind: 'move',
      blockId: input.blockId, parentId: input.parentId, beforeId: input.beforeId };
    const initial = [...this.records.values()].map((record) => record.get('initial') as InitialBlockPlacement);
    const next = projectBlockPlacements(initial, [...this.operations.values(), operation]);
    if (next.conflicts.some((conflict) => conflict.operationId === operation.id || conflict.reason === 'orphan')) {
      throw new BlockTreeConflict('target_changed');
    }
    try { this.read(this.schema, next); } catch { throw new BlockTreeConflict('structure_invalid'); }
    this.doc.transact(() => { this.recordOperation(operation); }, origin);
  }

  private recordOperation(operation: BlockPlacementOperation): void {
    this.operations.set(operation.id, operation);
    this.receipts.set(operation.id, operation);
  }

  delete(blockId: string, operationId: string, origin: unknown): void {
    const existing = this.receipts.get(operationId);
    if (existing) {
      if (existing.kind !== 'delete' || existing.blockIds[0] !== blockId) throw new BlockTreeConflict('identity_invalid');
      return;
    }
    const projection = this.project();
    if (!projection.parents.has(blockId) || projection.deleted.has(blockId)) throw new BlockTreeConflict('target_changed');
    if (this.operations.has(operationId)) throw new BlockTreeConflict('identity_invalid');
    const blockIds: string[] = [];
    const collect = (id: string) => {
      blockIds.push(id);
      for (const child of projection.children.get(id) ?? []) collect(child);
    };
    collect(blockId);
    const operation: BlockPlacementOperation = { ...this.stamp(operationId), kind: 'delete', blockIds };
    const initial = [...this.records.values()].map((record) => record.get('initial') as InitialBlockPlacement);
    const next = projectBlockPlacements(initial, [...this.operations.values(), operation]);
    try { this.read(this.schema, next); } catch { throw new BlockTreeConflict('structure_invalid'); }
    this.doc.transact(() => { this.recordOperation(operation); }, origin);
  }

  /** Remove only the recorded placements, retaining content and retry receipts. */
  revertPlacementOperations(expectedOperations: BlockPlacementOperation[], origin: unknown): void {
    const fingerprint = (operation: BlockPlacementOperation) => JSON.stringify(
      Object.entries(operation).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    );
    const expectedIds = new Set<string>();
    const active: BlockPlacementOperation[] = [];
    for (const expected of expectedOperations) {
      if (!isBlockPlacementOperation(expected) || expectedIds.has(expected.id)) throw new BlockTreeConflict('identity_invalid');
      expectedIds.add(expected.id);
      const receipt = this.receipts.get(expected.id);
      const current = this.operations.get(expected.id);
      if (!receipt || !isBlockPlacementOperation(receipt) || fingerprint(receipt) !== fingerprint(expected)
        || (current !== undefined && (!isBlockPlacementOperation(current) || fingerprint(current) !== fingerprint(expected)))) {
        throw new BlockTreeConflict('target_changed');
      }
      if (current !== undefined) active.push(current);
    }
    // Missing operations with matching receipts were already undone. Their
    // receipts must survive, including across a binary save and process restart.
    if (active.length === 0) return;
    if (this.doc.store.pendingStructs || this.doc.store.pendingDs) throw new BlockTreeConflict('target_changed');

    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(this.doc));
      const candidate = new CollaborationBlockTree(scratch, this.schema);
      const before = candidate.project();
      candidate.read(this.schema, before);
      scratch.transact(() => { for (const operation of active) candidate.operations.delete(operation.id); });
      const after = candidate.project();
      candidate.read(this.schema, after);

      const affected = new Set(active.flatMap((operation) => operation.kind === 'delete' ? operation.blockIds : [operation.blockId]));
      // Moving a container also moves its descendants. A later operation can
      // depend on one of those IDs without naming the container itself.
      const collect = (id: string, projection: BlockPlacementProjection) => {
        for (const child of projection.children.get(id) ?? []) {
          affected.add(child);
          collect(child, projection);
        }
      };
      for (const operation of active) if (operation.kind === 'move') {
        collect(operation.blockId, before);
        collect(operation.blockId, after);
      }
      const firstClock = Math.min(...active.map((operation) => operation.clock));
      for (const operation of candidate.operations.values()) {
        if (operation.kind === 'delete') {
          // A different deletion remains authoritative regardless of its clock.
          if (operation.blockIds.some((id) => affected.has(id))) throw new BlockTreeConflict('target_changed');
        } else if (operation.clock >= firstClock && [operation.blockId, operation.parentId, operation.beforeId]
          .some((id) => id !== null && affected.has(id))) {
          throw new BlockTreeConflict('target_changed');
        }
      }
      const foreignConflicts = (projection: BlockPlacementProjection) => JSON.stringify(projection.conflicts
        .filter((conflict) => !conflict.operationId || !expectedIds.has(conflict.operationId))
        .map((conflict) => JSON.stringify(conflict)).sort());
      if (foreignConflicts(before) !== foreignConflicts(after)) throw new BlockTreeConflict('target_changed');
    } catch (error) {
      if (error instanceof BlockTreeConflict) throw error;
      throw new BlockTreeConflict('structure_invalid');
    } finally { scratch.destroy(); }

    // Yjs transactions cannot roll back. Everything that can reject the whole
    // group ran on scratch; this final synchronous transaction only removes ops.
    this.doc.transact(() => { for (const operation of active) this.operations.delete(operation.id); }, origin);
  }

  updateInlineContent(blockId: string, next: ProseMirrorNode, origin: unknown): void {
    const projection = this.project();
    if (projection.deleted.has(blockId) || !projection.parents.has(blockId) || next.attrs.id !== blockId) {
      throw new BlockTreeConflict('target_changed');
    }
    const props = properties(this.records.get(blockId)!);
    if (!props.inline || !next.inlineContent || props.type !== next.type.name) throw new BlockTreeConflict('structure_invalid');
    next.check();
    this.doc.transact(() => {
      updateYFragment(this.doc, this.content(blockId), next, { mapping: new Map(), isOMark: new Map() });
    }, origin);
  }

  /** Applies an editor transaction by identity, including native list/table commands. */
  applyDocumentChange(before: ProseMirrorNode, next: ProseMirrorNode, origin: unknown, move?: BlockMoveIntent): void {
    if (before.eq(next)) return;
    next.check();
    if (!this.read().eq(before)) throw new BlockTreeConflict('target_changed');
    const previous = documentBlocks(before);
    const following = documentBlocks(next);
    for (const id of following.keys()) {
      if (!previous.has(id) && this.records.has(id)) throw new BlockTreeConflict('identity_invalid');
    }
    const structural = previous.size !== following.size || [...following.values()].some((block) => {
      const old = previous.get(block.id);
      return !old || old.parentId !== block.parentId || old.order !== block.order || old.node.type !== block.node.type;
    });
    const operationPrefix = globalThis.crypto.randomUUID();
    if (structural) {
      // Yjs transactions do not roll back exceptions. Validate a structural plan
      // on an isolated replica first, then apply the same plan synchronously.
      const scratch = new Y.Doc();
      try {
        Y.applyUpdate(scratch, Y.encodeStateAsUpdate(this.doc));
        scratch.clientID = this.doc.clientID;
        const candidate = new CollaborationBlockTree(scratch, this.schema);
        candidate.applyChanges(previous, following, operationPrefix, origin, structural, move);
        if (!candidate.read().eq(next)) throw new BlockTreeConflict('structure_invalid');
      } finally { scratch.destroy(); }
    }
    this.applyChanges(previous, following, operationPrefix, origin, structural, move);
  }

  private applyChanges(
    before: Map<string, DocumentBlock>,
    next: Map<string, DocumentBlock>,
    prefix: string,
    origin: unknown,
    structural: boolean,
    move?: BlockMoveIntent,
  ): void {
    // Stamp the whole plan before any content/record writes change the clock.
    // One table-column action can contain many moves across different rows.
    const transaction = structural ? this.stamp(prefix) : null;
    let ordinal = 0;
    const operationStamp = (id: string) => ({ ...transaction!, id, ordinal: ordinal++ });
    this.doc.transact(() => {
      for (const block of next.values()) {
        const old = before.get(block.id);
        if (!old) { this.addRecord(block); continue; }
        if (old.node === block.node) continue;
        const record = this.records.get(block.id)!;
        const attrs = record.get('attributes') as Y.Map<unknown>;
        for (const key of new Set([...Object.keys(old.node.attrs), ...Object.keys(block.node.attrs)])) {
          if (JSON.stringify(old.node.attrs[key]) === JSON.stringify(block.node.attrs[key])) continue;
          if (block.node.attrs[key] === undefined) attrs.delete(key);
          else attrs.set(key, block.node.attrs[key]);
        }
        if (old.node.type !== block.node.type) record.set('shape', { type: block.node.type.name, inline: block.node.inlineContent });
        if (block.node.inlineContent && !old.node.content.eq(block.node.content)) {
          updateYFragment(this.doc, this.content(block.id), block.node, { mapping: new Map(), isOMark: new Map() });
        }
      }
      if (!structural) return;
      const removed = [...before.keys()].filter((id) => !next.has(id));
      if (removed.length) {
        const id = `${prefix}:delete`;
        this.recordOperation({ ...operationStamp(id), kind: 'delete', blockIds: removed });
      }
      if (move) {
        const id = `${prefix}:intent`;
        this.recordOperation({ ...operationStamp(id), kind: 'move', ...move });
      }
      const targetChildren = new Map<string | null, string[]>();
      for (const block of next.values()) {
        const children = targetChildren.get(block.parentId) ?? [];
        children.push(block.id);
        targetChildren.set(block.parentId, children);
      }
      let moveIndex = 0;
      let current = this.project();
      const place = (blockId: string, parentId: string | null, beforeId: string | null) => {
        const id = `${prefix}:move:${moveIndex++}`;
        this.recordOperation({ ...operationStamp(id), kind: 'move', blockId, parentId, beforeId });
        current = this.project();
      };
      for (const [parentId, children] of targetChildren) {
        const placedNew = new Set<string>();
        // A new record can initially tie an existing sibling's numeric order.
        // Place inserts first so that tie-breaking cannot invent moves of
        // unchanged siblings. Reparented anchors may not have arrived yet;
        // those inserts still use the complete reconciliation pass below.
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const blockId = children[index];
          const beforeId = children[index + 1] ?? null;
          if (before.has(blockId) || (beforeId !== null && current.parents.get(beforeId) !== parentId)) continue;
          place(blockId, parentId, beforeId);
          placedNew.add(blockId);
        }
        let indexedProjection: typeof current | null = null;
        let successors = new Map<string, string | null>();
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const blockId = children[index];
          const beforeId = children[index + 1] ?? null;
          if (indexedProjection !== current) {
            const siblings = current.children.get(parentId) ?? [];
            // Reuse adjacency while checking this unchanged projection. A move
            // replaces the projection, so the next iteration rebuilds it.
            successors = new Map(siblings.map((id, offset) => [id, siblings[offset + 1] ?? null]));
            indexedProjection = current;
          }
          // New blocks need an explicit placement even when their initial
          // numeric position happens to match. Concurrent insertions can share
          // that position; only the transaction keeps a whole column aligned.
          if ((before.has(blockId) || placedNew.has(blockId)) && current.parents.get(blockId) === parentId
            && successors.get(blockId) === beforeId) continue;
          place(blockId, parentId, beforeId);
        }
      }
    }, origin);
  }
}
