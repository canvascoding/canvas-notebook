import { types } from 'node:util';
import type { Doc } from 'yjs';
import { DocumentReadError } from '../documents/contracts';

/** Internal downward-only limits. Absence keeps every existing reader default. */
export type NativeDocumentReadBudget = Readonly<{
  maxStateBytes: number;
  maxVectorBytes: number;
  maxClients: number;
  maxStructs: number;
  maxNodes: number;
  maxDepth: number;
  maxStringBytes: number;
  maxBinaryBytes: number;
}>;
export const NATIVE_SEARCH_DOCUMENT_BUDGET: NativeDocumentReadBudget = Object.freeze({
  maxStateBytes: 2 * 1024 * 1024, maxVectorBytes: 128 * 1024, maxClients: 1024,
  maxStructs: 16_384, maxNodes: 32_768, maxDepth: 32,
  maxStringBytes: 512 * 1024, maxBinaryBytes: 2 * 1024 * 1024,
});
const maxima: NativeDocumentReadBudget = Object.freeze({ maxStateBytes: 64 * 1024 * 1024,
  maxVectorBytes: 1024 * 1024, maxClients: 262_144, maxStructs: 262_144,
  maxNodes: 262_144, maxDepth: 64, maxStringBytes: 64 * 1024 * 1024, maxBinaryBytes: 64 * 1024 * 1024 });
const keys = Object.keys(maxima) as (keyof NativeDocumentReadBudget)[];
function invalid(): never { throw new DocumentReadError('INVALID_REQUEST'); }
function stateInvalid(): never { throw new DocumentReadError('DOCUMENT_STATE_INVALID'); }
function tooLarge(): never { throw new DocumentReadError('DOCUMENT_TOO_LARGE'); }

export function captureNativeDocumentReadBudget(value: unknown): NativeDocumentReadBudget {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), result = {} as Record<keyof NativeDocumentReadBudget, number>;
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  for (const key of keys) {
    const descriptor = Object.prototype.hasOwnProperty.call(descriptors, key) ? descriptors[key] : undefined;
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof descriptor.value !== 'number' || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 1 || descriptor.value > maxima[key]) invalid();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function contentCounter(budget: NativeDocumentReadBudget) {
  let nodes = 0, stringBytes = 0, binaryBytes = 0;
  const string = (value: unknown) => {
    if (typeof value !== 'string') stateInvalid();
    if (value.length > budget.maxStringBytes - stringBytes) tooLarge();
    // byteLength measures without copying/encoding the complete string.
    stringBytes += Buffer.byteLength(value, 'utf8');
    if (stringBytes > budget.maxStringBytes) tooLarge();
    if (Buffer.from(value, 'utf8').toString('utf8') !== value) stateInvalid();
  };
  const binary = (value: unknown) => {
    if (!(value instanceof Uint8Array) || types.isProxy(value)) stateInvalid();
    binaryBytes += value.byteLength;
    if (binaryBytes > budget.maxBinaryBytes) tooLarge();
  };
  const data = (initial: unknown) => {
    const beforeNodes = nodes, beforeStrings = stringBytes;
    const pending: Array<{ value: unknown; depth: number; exit?: object }> = [{ value: initial, depth: 0 }];
    const ancestors = new Set<object>();
    while (pending.length) {
      const { value, depth, exit } = pending.pop()!;
      if (exit) { ancestors.delete(exit); continue; }
      if (++nodes > budget.maxNodes || depth > budget.maxDepth) tooLarge();
      if (typeof value === 'string') { string(value); continue; }
      if (value === null || value === undefined || typeof value === 'boolean') continue;
      if (typeof value === 'number') { if (!Number.isFinite(value)) stateInvalid(); continue; }
      if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) stateInvalid();
      if (value instanceof Uint8Array) stateInvalid(); // Native JSON attrs are JSON, not typed binary containers.
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) stateInvalid();
      ancestors.add(value); pending.push({ value: null, depth, exit: value });
      if (Array.isArray(value) && value.length > budget.maxNodes - nodes) tooLarge();
      let children = 0;
      // Avoid our own unbounded Object.keys/descriptors result. V8's internal
      // enumeration allocation is not an exact heap or execution-time bound.
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) stateInvalid();
        if (++children + nodes + pending.length > budget.maxNodes * 2) tooLarge();
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) stateInvalid();
        if (Array.isArray(value) && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) stateInvalid();
        if (!Array.isArray(value)) string(key);
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
      if (Array.isArray(value) && children !== value.length) stateInvalid();
    }
    return { nodes: nodes - beforeNodes, stringBytes: stringBytes - beforeStrings };
  };
  return { string, binary, data };
}

/** Bounds native JSON before PM materialization in the optional search path. */
export function assertNativeSearchContentWithinBudget(content: unknown): void {
  if (!content || typeof content !== 'object' || types.isProxy(content)
    || Object.getPrototypeOf(content) !== Object.prototype) stateInvalid();
  const kind = Object.getOwnPropertyDescriptor(content, 'kind');
  if (!kind?.enumerable || !Object.prototype.hasOwnProperty.call(kind, 'value')) stateInvalid();
  const expected = kind.value === 'plain_text' ? ['kind', 'text']
    : kind.value === 'rich_text' ? ['kind', 'document', 'frontmatter', 'bodyFinalLineEnding'] : null;
  if (!expected || Reflect.ownKeys(content).length !== expected.length) stateInvalid();
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(content, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) stateInvalid();
  }
  contentCounter(NATIVE_SEARCH_DOCUMENT_BUDGET).data(content);
}

/** Budget facts on the actual trusted Y.Doc; not schema validation or authority.
 * Stable Yjs content refs/fields work across the server/compiled package copies.
 * Never call ContentString.getContent(), toJSON(), toDelta() or encode the Doc. */
export function assertNativeDocumentWithinReadBudget(doc: Doc, selected: NativeDocumentReadBudget): void {
  const budget = captureNativeDocumentReadBudget(selected);
  if (doc.store.pendingStructs || doc.store.pendingDs) stateInvalid();
  if (doc.store.clients.size > budget.maxClients) tooLarge();
  let structs = 0;
  const { string, binary, data } = contentCounter(budget);
  type Formats = { segments: number; nodes: number; strings: number;
    keys: Map<string, { nodes: number; strings: number }> };
  const formats = new Map<object, Formats>();
  let expandedNodes = 0, expandedStrings = 0;
  const formatWork = (parent: unknown, update: (state: Formats) => void) => {
    if (!parent || typeof parent !== 'object' || types.isProxy(parent)) stateInvalid();
    let state = formats.get(parent);
    if (!state) { state = { segments: 0, nodes: 0, strings: 0, keys: new Map() }; formats.set(parent, state); }
    expandedNodes -= state.nodes * state.segments; expandedStrings -= state.strings * state.segments;
    update(state);
    expandedNodes += state.nodes * state.segments; expandedStrings += state.strings * state.segments;
    if (expandedNodes > budget.maxNodes || expandedStrings > budget.maxStringBytes) tooLarge();
  };
  const parentDepth = (struct: { parent?: unknown }) => {
    let parent = struct.parent, depth = 0;
    const seen = new Set<object>();
    while (parent !== null && typeof parent === 'object') {
      if (++depth > budget.maxDepth) tooLarge();
      if (seen.has(parent) || types.isProxy(parent)) stateInvalid();
      seen.add(parent);
      const item = (parent as { _item?: { parent?: unknown } | null })._item;
      if (item == null) break;
      parent = item.parent;
    }
  };
  // Root names are not omitted from the total string budget.
  if (doc.share.size > budget.maxNodes) tooLarge();
  for (const key of doc.share.keys()) string(key);
  for (const entries of doc.store.clients.values()) {
    if (entries.length > budget.maxStructs - structs) tooLarge();
    for (const stored of entries) {
      if (++structs > budget.maxStructs) tooLarge();
      const struct = stored as typeof stored & { parent?: unknown; parentSub?: unknown;
        content?: { getRef(): number; len?: unknown; str?: unknown; arr?: unknown; content?: unknown;
          embed?: unknown; key?: unknown; value?: unknown; type?: unknown } };
      parentDepth(struct);
      if (struct.parentSub !== null && struct.parentSub !== undefined) string(struct.parentSub);
      const content = struct.content;
      if (!content) continue; // GC has no retained content; counted as a struct.
      if (typeof content.getRef !== 'function') stateInvalid();
      const reference = content.getRef();
      if (reference !== 1 && reference !== 6) formatWork(struct.parent, state => { state.segments++; });
      switch (reference) {
        case 1: if (!Number.isSafeInteger(content.len) || Number(content.len) < 0) stateInvalid(); break;
        case 2: case 8: data(content.arr); break;
        case 3: binary(content.content); break;
        case 4: string(content.str); break;
        case 5: data(content.embed); break;
        case 6: {
          string(content.key); const weight = data(content.value), key = content.key as string;
          // textBetween/toDelta/PM can repeat the current format attributes at
          // every text segment. Charge conservative historical maxima before
          // any such materialization, including nested attribute JSON values.
          formatWork(struct.parent, state => {
            const old = state.keys.get(key) ?? { nodes: 0, strings: 0 };
            const next = { nodes: Math.max(old.nodes, weight.nodes + 1),
              strings: Math.max(old.strings, weight.stringBytes + Buffer.byteLength(key, 'utf8')) };
            state.nodes += next.nodes - old.nodes; state.strings += next.strings - old.strings; state.keys.set(key, next);
          });
          break;
        }
        case 7: {
          if (!content.type || typeof content.type !== 'object') stateInvalid();
          const nativeType = content.type as { nodeName?: unknown; hookName?: unknown };
          if (nativeType.nodeName !== undefined) string(nativeType.nodeName);
          if (nativeType.hookName !== undefined) string(nativeType.hookName);
          break;
        }
        default: stateInvalid(); // Subdocuments/unknown retained formats are not searchable native text.
      }
    }
  }
}
