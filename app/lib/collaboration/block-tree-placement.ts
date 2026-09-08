/** Placement is independent of the CRDT types that hold a block's contents. */
export type InitialBlockPlacement = { id: string; parentId: string | null; order: number };

type StructuralOperationStamp = { id: string; clock: number; actor: number };
export type BlockPlacementOperation = StructuralOperationStamp & (
  | { kind: 'move'; blockId: string; parentId: string | null; beforeId: string | null }
  | { kind: 'delete'; blockIds: string[] }
);

export type BlockPlacementConflict = {
  operationId?: string;
  blockId: string;
  reason: 'source_deleted' | 'target_deleted' | 'target_changed' | 'cycle' | 'orphan';
};

export type BlockPlacementProjection = {
  children: Map<string | null, string[]>;
  parents: Map<string, string | null>;
  deleted: Set<string>;
  conflicts: BlockPlacementConflict[];
};

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isBlockPlacementOperation(value: unknown): value is BlockPlacementOperation {
  if (!value || typeof value !== 'object') return false;
  const op = value as Partial<BlockPlacementOperation>;
  if (!validId(op.id) || !Number.isSafeInteger(op.clock) || (op.clock ?? 0) < 1
    || !Number.isInteger(op.actor) || (op.actor ?? -1) < 0 || (op.actor ?? 0) > 0xffffffff) return false;
  if (op.kind === 'delete') return Array.isArray(op.blockIds) && op.blockIds.length > 0 && op.blockIds.every(validId);
  return op.kind === 'move' && validId(op.blockId) && (op.parentId === null || validId(op.parentId))
    && (op.beforeId === null || validId(op.beforeId));
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Causal operations sort after what they observed; concurrent intentions use a
 * fixed actor/operation tie-break. Replay never copies content or duplicates a
 * block. Rejected intentions remain in the log for diagnosis/review.
 */
export function projectBlockPlacements(
  initial: InitialBlockPlacement[],
  operations: BlockPlacementOperation[],
): BlockPlacementProjection {
  if (initial.some((block) => !validId(block.id) || (block.parentId !== null && !validId(block.parentId))
    || !Number.isSafeInteger(block.order) || block.order < 0) || !operations.every(isBlockPlacementOperation)) {
    throw new Error('Invalid block placement data.');
  }
  const children = new Map<string | null, string[]>([[null, []]]);
  const parents = new Map<string, string | null>();
  const deleted = new Set(operations.flatMap((op) => op.kind === 'delete' ? op.blockIds : []));
  const conflicts: BlockPlacementConflict[] = [];
  for (const block of [...initial].sort((a, b) => a.order - b.order || compareIds(a.id, b.id))) {
    if (parents.has(block.id)) throw new Error('Duplicate block identity in placement projection.');
    parents.set(block.id, block.parentId);
    if (!children.has(block.id)) children.set(block.id, []);
    const siblings = children.get(block.parentId) ?? [];
    if (!deleted.has(block.id)) siblings.push(block.id);
    children.set(block.parentId, siblings);
  }

  const wouldCycle = (id: string, parentId: string | null) => {
    const seen = new Set([id]);
    for (let parent = parentId; parent !== null;) {
      if (seen.has(parent)) return true;
      seen.add(parent);
      parent = parents.get(parent) ?? null;
    }
    return false;
  };
  const ordered = [...operations].sort((a, b) => a.clock - b.clock || a.actor - b.actor || compareIds(a.id, b.id));
  for (const op of ordered) {
    if (op.kind === 'delete') continue;
    let reason: BlockPlacementConflict['reason'] | undefined;
    if (deleted.has(op.blockId) || !parents.has(op.blockId)) reason = 'source_deleted';
    else if ((op.parentId !== null && deleted.has(op.parentId)) || (op.beforeId !== null && deleted.has(op.beforeId))) reason = 'target_deleted';
    else if ((op.parentId !== null && !parents.has(op.parentId)) || (op.beforeId !== null && (!parents.has(op.beforeId) || parents.get(op.beforeId) !== op.parentId))) reason = 'target_changed';
    else if (wouldCycle(op.blockId, op.parentId)) reason = 'cycle';
    if (reason) {
      conflicts.push({ operationId: op.id, blockId: op.blockId, reason });
      continue;
    }
    if (op.beforeId === op.blockId) continue;
    const oldSiblings = children.get(parents.get(op.blockId) ?? null)!;
    const oldIndex = oldSiblings.indexOf(op.blockId);
    if (oldIndex >= 0) oldSiblings.splice(oldIndex, 1);
    const siblings = children.get(op.parentId)!;
    const index = op.beforeId === null ? siblings.length : siblings.indexOf(op.beforeId);
    siblings.splice(index, 0, op.blockId);
    parents.set(op.blockId, op.parentId);
  }

  // Concurrent insertion into a deleted container is retained in storage and
  // reported, never silently checkpointed as a successful invisible edit.
  const reachable = new Set<string>();
  const visit = (parent: string | null) => {
    for (const child of children.get(parent) ?? []) {
      if (reachable.has(child) || deleted.has(child)) continue;
      reachable.add(child);
      visit(child);
    }
  };
  visit(null);
  for (const id of parents.keys()) {
    if (!deleted.has(id) && !reachable.has(id)) conflicts.push({ blockId: id, reason: 'orphan' });
  }
  return { children, parents, deleted, conflicts };
}
