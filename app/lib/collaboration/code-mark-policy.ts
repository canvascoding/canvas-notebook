import type * as YTypes from 'yjs';
import { Y } from './yjs-runtime';
import { BLOCK_TREE_KEY } from './block-tree';

export const CODE_MARK_CONFLICT_POLICY = 'code-wins-v1';
const policyOrigin = Object.freeze({ policy: CODE_MARK_CONFLICT_POLICY });
// Unknown attributes remain visible to schema validation, never silently lost.
const excludedSchemaMarks = new Set(['canvasHighlight', 'link', 'bold', 'italic', 'strike', 'underline']);
type Conflict = { text: YTypes.XmlText; offset: number; length: number; marks: string[] };

/** Inspect rich text only; frontmatter and block records are never rewritten. */
function conflicts(doc: YTypes.Doc): Conflict[] {
  const found: Conflict[] = [];
  const visit = (fragment: YTypes.XmlFragment) => {
    for (const child of fragment.toArray()) {
      if (child instanceof Y.XmlText) {
        let offset = 0;
        for (const part of child.toDelta()) {
          const length = typeof part.insert === 'string' ? part.insert.length : 1;
          const marks = Object.keys(part.attributes ?? {}).filter((mark) => mark !== 'code');
          if (part.attributes?.code != null && marks.length) found.push({ text: child, offset, length, marks });
          offset += length;
        }
      } else if (child instanceof Y.XmlElement) visit(child);
    }
  };
  if (doc.share.has(BLOCK_TREE_KEY)) {
    const records = doc.getMap(BLOCK_TREE_KEY).get('records');
    if (records instanceof Y.Map) for (const record of records.values()) {
      const content = record instanceof Y.Map ? record.get('content') : null;
      if (content instanceof Y.XmlFragment) visit(content);
    }
  } else if (doc.share.has('body')) visit(doc.getXmlFragment('body'));
  return found;
}

export function hasCodeMarkConflicts(doc: YTypes.Doc): boolean { return conflicts(doc).length > 0; }

/** Code excludes every other mark in the existing schema. Formatting is lost. */
export function normalizeCodeMarkConflicts(doc: YTypes.Doc): { mark: string; utf16Units: number }[] {
  const pending = conflicts(doc);
  const losses = new Map<string, number>();
  if (pending.length) doc.transact(() => {
    for (const conflict of pending) {
      const marks = conflict.marks.filter((mark) => excludedSchemaMarks.has(mark));
      if (!marks.length) continue;
      const attributes = Object.fromEntries(marks.map((mark) => [mark, null]));
      conflict.text.format(conflict.offset, conflict.length, attributes);
      for (const mark of marks) losses.set(mark, (losses.get(mark) ?? 0) + conflict.length);
    }
  }, policyOrigin);
  return [...losses].sort(([a], [b]) => a.localeCompare(b)).map(([mark, utf16Units]) => ({ mark, utf16Units }));
}

/** Never repair an already-conflicting stored baseline during ordinary saves. */
export function normalizeNewCodeMarkConflicts(current: Uint8Array, candidate: Uint8Array) {
  const baseline = new Y.Doc({ gc: false }); const merged = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(baseline, current);
    if (hasCodeMarkConflicts(baseline)) return null;
    Y.applyUpdate(merged, candidate);
    if (!normalizeCodeMarkConflicts(merged).length) return null;
    const update = Y.encodeStateAsUpdate(merged);
    if (update.byteLength > 64 * 1024 * 1024) throw new RangeError('Normalized Yjs state exceeds the persistence limit.');
    return { update, stateVector: Y.encodeStateVector(merged) };
  } finally { baseline.destroy(); merged.destroy(); }
}

/** Registered before editor bindings; activation observes rather than repairs. */
export function installCodeMarkConflictPolicy(doc: YTypes.Doc, options: { canNormalize: () => boolean; signal: AbortSignal }) {
  let active = false; let healthyBaseline = false;
  const observe = (transaction: YTypes.Transaction) => {
    if (!active || transaction.origin === policyOrigin || !options.canNormalize()) return;
    if (!healthyBaseline) { healthyBaseline = !hasCodeMarkConflicts(doc); return; }
    normalizeCodeMarkConflicts(doc);
  };
  const dispose = () => { doc.off('afterTransaction', observe); options.signal.removeEventListener('abort', dispose); };
  doc.on('afterTransaction', observe);
  options.signal.addEventListener('abort', dispose, { once: true });
  return { activate() { active = true; healthyBaseline = !hasCodeMarkConflicts(doc); }, dispose };
}
