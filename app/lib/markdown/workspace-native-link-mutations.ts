import 'server-only';

import type * as YTypes from 'yjs';
import { CollaborationBlockTree } from '../collaboration/block-tree';
import type { BlockPlacementOperation } from '../collaboration/block-tree-placement';
import { inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import { getObsidianWikiDisplayLabel, parseObsidianWikiTarget } from './obsidian-flavored-markdown';
import { inspectPersistedDocumentLinks, inspectPersistedDocumentLinksV4, nativeLinkJsonProof,
  type NativeDocumentLinkInventoryV4 } from './workspace-native-link-inventory';
import { inspectWorkspaceMarkdownHtmlV4 } from './workspace-local-link-parser';
import { inspectWorkspaceStaticHtmlLinks } from './workspace-html-link-safety';
import type { NativeLinkDocumentIdentity, NativeLinkMutationRecipe, NativeLinkReference, NativeLinkTextReference } from './workspace-link-contract-v2';

type NativeInverseCommand =
  | { kind: 'rewrite-target'; reference: NativeLinkReference; nextValue: string }
  | { kind: 'restore-mark'; text: NativeLinkTextReference; attrs: Record<string, unknown> }
  | { kind: 'restore-plain-syntax'; text: NativeLinkTextReference; value: string }
  | { kind: 'restore-inline-node'; parentAnchor: string; text: NativeLinkTextReference | null;
      nodeType: string; attrs: Record<string, unknown> }
  | { kind: 'revert-block-delete'; blockId: string; operation: BlockPlacementOperation };

export type NativeLinkInverseRecipe = {
  contractVersion: 2;
  originalLinkId: string;
  source: NativeLinkDocumentIdentity;
  /** Exact native target/span/marks guard; independent paragraphs are outside this scope. */
  expectedScopeProof: string;
  command: NativeInverseCommand;
  authorizedForwardRecipeProof: string;
};

export type PreparedNativeLinkUpdate = {
  contractVersion: 2;
  operationId: string;
  source: NativeLinkDocumentIdentity;
  before: { stateProof: string; stateVector: string; documentSequence: number };
  /** Proposed CRDT proof, deliberately without an uncommitted durable sequence. */
  after: { stateProof: string; stateVector: string };
  update: Uint8Array;
  inverseRecipes: NativeLinkInverseRecipe[];
};

/** Separate durable inspection profile. The historical contract-2 prepared
 * record and its serialized proof remain unchanged. This is not an HTML
 * operation authorization: the caller must bind the operation assessment. */
export type PreparedNativeLinkUpdateV4 = Omit<PreparedNativeLinkUpdate, 'contractVersion'> & {
  contractVersion: 4;
  parserVersion: 4;
  /** Ordered actual HTML syntax and decoded targets, excluding movable offsets. */
  htmlSourceProof: string;
};
export type AnyPreparedNativeLinkUpdate = PreparedNativeLinkUpdate | PreparedNativeLinkUpdateV4;

export class NativeLinkMutationConflict extends Error {
  constructor(readonly code: 'source-changed' | 'target-changed' | 'incomplete-coverage' | 'unsupported-unlink' | 'invalid-recipe') {
    super(`Native link mutation is unavailable: ${code}.`); this.name = 'NativeLinkMutationConflict';
  }
}
const conflict = (code: NativeLinkMutationConflict['code']): never => { throw new NativeLinkMutationConflict(code); };

function absolute(doc: YTypes.Doc, encoded: string): YTypes.AbsolutePosition {
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return conflict('invalid-recipe');
    const relative = Y.decodeRelativePosition(bytes);
    if (relative.item && Y.getItem(doc.store, relative.item).deleted
      || relative.type && Y.getItem(doc.store, relative.type).deleted) return conflict('target-changed');
    const resolved = Y.createAbsolutePositionFromRelativePosition(relative, doc);
    if (!resolved) return conflict('target-changed');
    return resolved;
  } catch { return conflict('target-changed'); }
}

function encodeAt(type: YTypes.Text | YTypes.XmlFragment, index: number, assoc = 0): string {
  return Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, index, assoc))).toString('base64');
}

function textRef(text: YTypes.Text, start: number, end: number, blockId: string | null): NativeLinkTextReference {
  return { blockId, startAnchor: encodeAt(text, start), endAnchor: encodeAt(text, end, -1) };
}

function treeFor(doc: YTypes.Doc): CollaborationBlockTree {
  return new CollaborationBlockTree(doc, getNativeInspectionSchema());
}

function range(doc: YTypes.Doc, source: NativeLinkDocumentIdentity, ref: NativeLinkTextReference): { text: YTypes.Text; start: number; end: number } {
  const start = absolute(doc, ref.startAnchor); const end = absolute(doc, ref.endAnchor);
  if (start.type !== end.type || !(start.type instanceof Y.Text) || start.index > end.index || end.index > start.type.length) return conflict('target-changed');
  const text = start.type;
  if (source.representation === 'plain_text') {
    if (ref.blockId !== null || text !== doc.getText('content')) return conflict('target-changed');
  } else {
    const owner = source.representation === 'tiptap_blocks' ? (() => {
      if (!ref.blockId) return conflict('target-changed');
      const tree = treeFor(doc); const projected = tree.project();
      if (projected.deleted.has(ref.blockId) || !projected.parents.has(ref.blockId)) return conflict('target-changed');
      return tree.content(ref.blockId);
    })() : doc.getXmlFragment('body');
    let parent: YTypes.AbstractType<unknown> | null = text.parent as YTypes.AbstractType<unknown> | null;
    while (parent && parent !== owner) parent = parent.parent as YTypes.AbstractType<unknown> | null;
    if (parent !== owner) return conflict('target-changed');
  }
  return { text, start: start.index, end: end.index };
}

function deltaIn(text: YTypes.Text, start: number, end: number): unknown[] {
  const output: unknown[] = []; let offset = 0;
  for (const part of text.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
    if (typeof part.insert !== 'string') return conflict('target-changed');
    const to = offset + part.insert.length;
    if (to > start && offset < end) output.push({ insert: part.insert.slice(Math.max(start - offset, 0), Math.min(end - offset, part.insert.length)), attributes: part.attributes ?? {} });
    offset = to;
  }
  return output;
}

type NodeTarget = { attrs: Record<string, unknown>; blockId: string | null;
  map: YTypes.Map<unknown> | null; element: YTypes.XmlElement | null; parent: YTypes.XmlFragment | null; index: number };

function nodeTarget(doc: YTypes.Doc, source: NativeLinkDocumentIdentity, ref: Extract<NativeLinkReference, { kind: 'node-attribute' }>): NodeTarget {
  if (source.representation === 'tiptap_blocks' && ref.ownerBlockId === ref.nodeId && ref.membershipAnchor === null) {
    const tree = treeFor(doc); const projection = tree.project();
    if (projection.deleted.has(ref.nodeId) || !projection.parents.has(ref.nodeId)) return conflict('target-changed');
    const record = tree.records.get(ref.nodeId); const attrs = record?.get('attributes');
    if (!(attrs instanceof Y.Map) || (record!.get('shape') as { type: string }).type !== 'image' || ref.attribute !== 'src') return conflict('target-changed');
    return { attrs: attrs.toJSON(), blockId: ref.nodeId, map: attrs, element: null, parent: null, index: 0 };
  }
  if (!ref.membershipAnchor) return conflict('target-changed');
  const membership = absolute(doc, ref.membershipAnchor);
  if (!(membership.type instanceof Y.XmlFragment)) return conflict('target-changed');
  const parent = membership.type;
  const element = parent.toArray()[membership.index];
  if (!(element instanceof Y.XmlElement) || element.getAttribute('id') !== ref.nodeId
    || element.nodeName !== (ref.attribute === 'src' ? 'image' : 'obsidianWikiLink')) return conflict('target-changed');
  const owner = source.representation === 'tiptap_blocks' && ref.ownerBlockId ? treeFor(doc).content(ref.ownerBlockId) : doc.getXmlFragment('body');
  let ancestor: YTypes.AbstractType<unknown> | null = parent as unknown as YTypes.AbstractType<unknown>;
  while (ancestor && ancestor !== owner) ancestor = ancestor.parent as YTypes.AbstractType<unknown> | null;
  if (ancestor !== owner) return conflict('target-changed');
  return { attrs: element.getAttributes(), blockId: null, map: null, element, parent, index: membership.index };
}

function referenceScope(doc: YTypes.Doc, source: NativeLinkDocumentIdentity, reference: NativeLinkReference): unknown {
  if (reference.kind === 'node-attribute') {
    const target = nodeTarget(doc, source, reference); return { nodeId: reference.nodeId, attrs: target.attrs };
  }
  const selected = range(doc, source, reference.kind === 'plain-target' ? reference.syntaxText : reference.text);
  return deltaIn(selected.text, selected.start, selected.end);
}

function inverseScope(doc: YTypes.Doc, inverse: NativeLinkInverseRecipe): unknown {
  const { command, source } = inverse;
  if (command.kind === 'rewrite-target') return referenceScope(doc, source, command.reference);
  if (command.kind === 'restore-mark' || command.kind === 'restore-plain-syntax') {
    const selected = range(doc, source, command.text); return deltaIn(selected.text, selected.start, selected.end);
  }
  if (command.kind === 'revert-block-delete') {
    const tree = treeFor(doc); const record = tree.records.get(command.blockId);
    return { attrs: (record?.get('attributes') as YTypes.Map<unknown> | undefined)?.toJSON(),
      operation: tree.operations.get(command.operation.id), deleted: tree.project().deleted.has(command.blockId) };
  }
  const membership = absolute(doc, command.parentAnchor);
  if (!(membership.type instanceof Y.XmlFragment)) return conflict('target-changed');
  if (command.text) {
    const selected = range(doc, source, command.text);
    if (selected.text.parent !== membership.type || membership.type.toArray()[membership.index] !== selected.text
      || selected.start !== 0 || selected.end !== selected.text.length) return conflict('target-changed');
    return { delta: deltaIn(selected.text, selected.start, selected.end), membership: command.parentAnchor };
  }
  return { membership: command.parentAnchor, index: membership.index };
}

function plainLabel(raw: string, embed: boolean): string {
  if (embed) return '';
  if (raw.startsWith('[[')) {
    const target = parseObsidianWikiTarget(raw.slice(2, -2)); return target ? getObsidianWikiDisplayLabel(target) : conflict('unsupported-unlink');
  }
  // The parser already certified this inline link. Keep the exact authored label
  // bytes (including its formatting and escaped brackets).
  let depth = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === '\\') { index++; continue; }
    if (raw[index] === '[') depth++;
    if (raw[index] === ']' && --depth === 0) return raw.slice(1, index);
  }
  return conflict('unsupported-unlink');
}

function applyForward(doc: YTypes.Doc, recipe: NativeLinkMutationRecipe, operationId: string, ordinal: number,
  embed: boolean): NativeInverseCommand {
  const ref = recipe.reference;
  if (ref.kind === 'link-mark') {
    const selected = range(doc, recipe.source, ref.text);
    if (recipe.action === 'unlink') {
      selected.text.format(selected.start, selected.end - selected.start, { link: null });
      return { kind: 'restore-mark', text: ref.text, attrs: structuredClone(ref.expected) };
    }
    selected.text.format(selected.start, selected.end - selected.start, { link: { ...ref.expected, href: recipe.nextValue } });
    return { kind: 'rewrite-target', reference: { ...ref, expected: { ...ref.expected, href: recipe.nextValue } }, nextValue: String(ref.expected.href) };
  }
  if (ref.kind === 'plain-target') {
    const selected = range(doc, recipe.source, recipe.action === 'unlink' ? ref.syntaxText : ref.text);
    const value = recipe.action === 'unlink' ? plainLabel(ref.raw, embed) : recipe.nextValue!;
    selected.text.delete(selected.start, selected.end - selected.start); selected.text.insert(selected.start, value);
    const inserted = textRef(selected.text, selected.start, selected.start + value.length, null);
    if (recipe.action === 'unlink') return { kind: 'restore-plain-syntax', text: inserted, value: ref.raw };
    // Plain target's outer syntax anchors survive its inner target replacement.
    return { kind: 'rewrite-target', reference: { ...ref, text: inserted, expected: value }, nextValue: ref.expected };
  }
  const target = nodeTarget(doc, recipe.source, ref);
  if (recipe.action === 'rewrite') {
    if (target.map) target.map.set(ref.attribute, recipe.nextValue); else target.element!.setAttribute(ref.attribute, recipe.nextValue!);
    return { kind: 'rewrite-target', reference: { ...ref, expected: recipe.nextValue! }, nextValue: ref.expected };
  }
  if (target.blockId) {
    const tree = treeFor(doc); const id = `${operationId}:link:${ordinal}`;
    if (tree.receipts.has(id) || tree.operations.has(id)) return conflict('target-changed');
    tree.delete(target.blockId, id, operationId);
    return { kind: 'revert-block-delete', blockId: target.blockId, operation: structuredClone(tree.operations.get(id)!) };
  }
  const label = ref.attribute === 'target' && !embed ? getObsidianWikiDisplayLabel(parseObsidianWikiTarget(ref.expected)!) : '';
  const element = target.element!; const parent = target.parent!;
  parent.delete(target.index, 1);
  let replacement: YTypes.XmlText | null = null;
  if (label) { replacement = new Y.XmlText(); replacement.insert(0, label); parent.insert(target.index, [replacement]); }
  return { kind: 'restore-inline-node', parentAnchor: encodeAt(parent, target.index),
    text: replacement ? textRef(replacement, 0, replacement.length, ref.ownerBlockId) : null,
    nodeType: element.nodeName, attrs: structuredClone(target.attrs) };
}

function proposedState(state: PersistedCollaborationState, doc: YTypes.Doc): PersistedCollaborationState {
  return { ...state, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
}

function hydrateCandidate(doc: YTypes.Doc, state: PersistedCollaborationState): void {
  // Encoded root types initially hydrate as AbstractType until the declared
  // root type is selected. Relative-position ownership requires that selection.
  if (state.representation === 'plain_text') doc.getText('content');
  else if (state.representation === 'tiptap_xml') doc.getXmlFragment('body');
  else treeFor(doc);
}

function assertIdentity(state: PersistedCollaborationState, source: NativeLinkDocumentIdentity): void {
  if (state.documentId !== source.documentId || state.workspaceId !== source.workspaceId || state.organizationId !== source.organizationId
    || state.path !== source.path || state.lifecycleGeneration !== source.lifecycleGeneration
    || state.representation !== source.representation || state.schemaVersion !== source.schemaVersion) conflict('source-changed');
}

/** Finite profile decoder shared by both mechanical persistence paths. A
 * contract-4 record cannot be relabelled as a historical contract-2 record. */
export function assertPreparedNativeLinkInspectionProfile(prepared: AnyPreparedNativeLinkUpdate): void {
  if (prepared.contractVersion === 2) {
    if (Object.hasOwn(prepared, 'parserVersion') || Object.hasOwn(prepared, 'htmlSourceProof')) return conflict('invalid-recipe');
    return;
  }
  if (prepared.contractVersion !== 4 || prepared.parserVersion !== 4
    || typeof prepared.htmlSourceProof !== 'string' || !/^[a-f0-9]{64}$/u.test(prepared.htmlSourceProof)
    || Object.keys(prepared).some(key => !['contractVersion', 'parserVersion', 'htmlSourceProof', 'operationId',
      'source', 'before', 'after', 'update', 'inverseRecipes'].includes(key))) return conflict('invalid-recipe');
}

function inspectNativeMutationStateV4(state: PersistedCollaborationState): {
  inventory: NativeDocumentLinkInventoryV4; htmlSourceProof: string;
} {
  const inventory = inspectPersistedDocumentLinksV4(state);
  for (const gap of inventory.coverage.gaps) {
    if (gap.code !== 'uninspected-html' || typeof gap.raw !== 'string'
      || !inspectWorkspaceStaticHtmlLinks(gap.raw).fullyInspected) return conflict('incomplete-coverage');
  }
  const html = inspectPersistedNativeCollaborationSnapshot(state, (_doc, snapshot) => snapshot.content.kind === 'plain_text'
    ? inspectWorkspaceMarkdownHtmlV4(snapshot.content.text, state.path).occurrences : []);
  if (html.some(occurrence => !occurrence.fullyInspected)) return conflict('incomplete-coverage');
  return { inventory, htmlSourceProof: nativeLinkJsonProof({ parserVersion: 4, occurrences: html.map(occurrence => ({
    raw: occurrence.raw, fullyInspected: occurrence.fullyInspected, explicitLocalTargets: occurrence.explicitLocalTargets,
  })) }) };
}

/** Re-inspects actual before/after binaries. Offset shifts caused by an ordinary
 * target rewrite are allowed; changing, hiding or introducing HTML is not.
 * This verifies the prepared mechanism only, never the operation's authority. */
export function verifyPreparedNativeLinkMutationV4(input: {
  before: PersistedCollaborationState; after: PersistedCollaborationState; prepared: PreparedNativeLinkUpdateV4;
}): void {
  const { before, after, prepared } = input;
  assertPreparedNativeLinkInspectionProfile(prepared);
  assertIdentity(before, prepared.source); assertIdentity(after, prepared.source);
  const original = inspectNativeMutationStateV4(before); const proposed = inspectNativeMutationStateV4(after);
  if (original.inventory.version.stateProof !== prepared.before.stateProof
    || original.inventory.version.stateVector !== prepared.before.stateVector
    || original.inventory.version.documentSequence !== prepared.before.documentSequence
    || proposed.inventory.version.stateProof !== prepared.after.stateProof
    || proposed.inventory.version.stateVector !== prepared.after.stateVector
    || original.htmlSourceProof !== prepared.htmlSourceProof
    || proposed.htmlSourceProof !== prepared.htmlSourceProof) return conflict('target-changed');
}

type ForwardMutationInput = { state: PersistedCollaborationState; recipes: readonly NativeLinkMutationRecipe[]; operationId: string };

/** Returns a proposed delta only. Admission/actor/Review binding, namespace graph
 * effect comparison and durable journal receipts belong to the operation service. */
export function prepareNativeLinkMutations(input: {
  state: PersistedCollaborationState; recipes: readonly NativeLinkMutationRecipe[]; operationId: string;
}): PreparedNativeLinkUpdate {
  return prepareNativeLinkMutationsForParser(input, 2);
}

/** Only the HTML-aware operation arm may select this explicit profile, after
 * assessing all HTML targets against the exact before/after namespace. */
export function prepareNativeLinkMutationsV4(input: ForwardMutationInput): PreparedNativeLinkUpdateV4 {
  return prepareNativeLinkMutationsForParser(input, 4);
}

function prepareNativeLinkMutationsForParser(input: ForwardMutationInput, parserVersion: 2): PreparedNativeLinkUpdate;
function prepareNativeLinkMutationsForParser(input: ForwardMutationInput, parserVersion: 4): PreparedNativeLinkUpdateV4;
function prepareNativeLinkMutationsForParser(input: ForwardMutationInput, parserVersion: 2 | 4): AnyPreparedNativeLinkUpdate {
  const { state, recipes, operationId } = input;
  if (!operationId || !recipes.length) return conflict('invalid-recipe');
  return inspectPersistedNativeCollaborationSnapshot(state, (verified, snapshot) => {
    const originalV4 = parserVersion === 4 ? inspectNativeMutationStateV4(state) : null;
    const inventory = originalV4?.inventory ?? inspectPersistedDocumentLinks(state);
    if (parserVersion === 2 && !inventory.coverage.complete) return conflict('incomplete-coverage');
    const ids = new Set<string>();
    for (const recipe of recipes) {
      assertIdentity(state, recipe.source);
      const current = inventory.links.filter((link) => link.id === recipe.linkId);
      if (recipe.cloneSelection !== null || recipe.sourceVersion.stateProof !== snapshot.version.stateProof
        || recipe.sourceVersion.stateVector !== snapshot.version.stateVector || recipe.sourceVersion.documentSequence !== snapshot.version.documentSequence) return conflict('source-changed');
      if (current.length !== 1 || nativeLinkJsonProof(current[0].ref) !== nativeLinkJsonProof(recipe.reference) || ids.has(recipe.linkId)) return conflict('target-changed');
      if (recipe.action !== 'unlink' && recipe.action !== 'rewrite' || recipe.action === 'rewrite' && typeof recipe.nextValue !== 'string'
        || recipe.action === 'unlink' && recipe.nextValue !== null) return conflict('invalid-recipe');
      if (recipe.action === 'unlink' && current[0].syntax.startsWith('reference-')) return conflict('unsupported-unlink');
      ids.add(recipe.linkId);
    }
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(verified));
      hydrateCandidate(candidate, state);
      const inverseRecipes: NativeLinkInverseRecipe[] = [];
      candidate.transact(() => {
        for (const [ordinal, recipe] of recipes.entries()) {
          const link = inventory.links.find((entry) => entry.id === recipe.linkId)!;
          const command = applyForward(candidate, recipe, operationId, ordinal, link.embed);
          inverseRecipes.push({ contractVersion: 2, originalLinkId: recipe.linkId, source: recipe.source, command,
            expectedScopeProof: '', authorizedForwardRecipeProof: nativeLinkJsonProof(recipe) });
        }
      }, operationId);
      const next = proposedState(state, candidate);
      const afterV4 = parserVersion === 4 ? inspectNativeMutationStateV4(next) : null;
      const afterInventory = afterV4?.inventory ?? inspectPersistedDocumentLinks(next);
      if (parserVersion === 2 && !afterInventory.coverage.complete
        || originalV4 && afterV4?.htmlSourceProof !== originalV4.htmlSourceProof) return conflict('incomplete-coverage');
      for (const inverse of inverseRecipes) inverse.expectedScopeProof = nativeLinkJsonProof(inverseScope(candidate, inverse));
      const common = { operationId, source: inventory.document,
        before: { stateProof: snapshot.version.stateProof, stateVector: snapshot.version.stateVector, documentSequence: snapshot.version.documentSequence },
        after: { stateProof: afterInventory.version.stateProof, stateVector: afterInventory.version.stateVector },
        update: Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(verified)), inverseRecipes };
      return originalV4 ? { contractVersion: 4, ...common, parserVersion: 4, htmlSourceProof: originalV4.htmlSourceProof }
        : { contractVersion: 2, ...common };
    } finally { candidate.destroy(); }
  });
}

function applyInverse(doc: YTypes.Doc, inverse: NativeLinkInverseRecipe, operationId: string): void {
  const { command, source } = inverse;
  if (command.kind === 'rewrite-target') {
    const ref = command.reference;
    if (ref.kind === 'node-attribute') {
      const target = nodeTarget(doc, source, ref);
      if (target.attrs[ref.attribute] !== ref.expected) return conflict('target-changed');
      if (target.map) target.map.set(ref.attribute, command.nextValue); else target.element!.setAttribute(ref.attribute, command.nextValue);
    } else {
      const selected = range(doc, source, ref.text);
      if (ref.kind === 'link-mark') selected.text.format(selected.start, selected.end - selected.start, { link: { ...ref.expected, href: command.nextValue } });
      else { if (selected.text.toString().slice(selected.start, selected.end) !== ref.expected) return conflict('target-changed');
        selected.text.delete(selected.start, selected.end - selected.start); selected.text.insert(selected.start, command.nextValue); }
    }
  } else if (command.kind === 'restore-mark') {
    const selected = range(doc, source, command.text); selected.text.format(selected.start, selected.end - selected.start, { link: command.attrs });
  } else if (command.kind === 'restore-plain-syntax') {
    const selected = range(doc, source, command.text); selected.text.delete(selected.start, selected.end - selected.start); selected.text.insert(selected.start, command.value);
  } else if (command.kind === 'revert-block-delete') treeFor(doc).revertPlacementOperations([command.operation], operationId);
  else {
    const membership = absolute(doc, command.parentAnchor); const parent = membership.type as YTypes.XmlFragment;
    const node = new Y.XmlElement(command.nodeType);
    for (const [name, value] of Object.entries(command.attrs)) node.setAttribute(name, value as string);
    if (command.text) parent.delete(membership.index, 1);
    parent.insert(membership.index, [node]);
  }
}

/** Target-only Undo preparation. The service must verify the stored forward
 * authorization and the current native namespace/graph effect BEFORE accepting
 * this proposal. This helper alone is not permission to rebase a reviewed plan. */
export function prepareNativeLinkInverse(input: {
  state: PersistedCollaborationState; inverseRecipes: readonly NativeLinkInverseRecipe[]; operationId: string;
}): Omit<PreparedNativeLinkUpdate, 'inverseRecipes'> {
  return prepareNativeLinkInverseForParser(input, 2);
}

type InverseMutationInput = { state: PersistedCollaborationState; inverseRecipes: readonly NativeLinkInverseRecipe[]; operationId: string };

/** Required for the forward adapter's inverse consistency proof. Exporting this
 * mechanical helper does not enable the disabled public file-action Undo. */
export function prepareNativeLinkInverseV4(input: InverseMutationInput): Omit<PreparedNativeLinkUpdateV4, 'inverseRecipes'> {
  return prepareNativeLinkInverseForParser(input, 4);
}

function prepareNativeLinkInverseForParser(input: InverseMutationInput, parserVersion: 2): Omit<PreparedNativeLinkUpdate, 'inverseRecipes'>;
function prepareNativeLinkInverseForParser(input: InverseMutationInput, parserVersion: 4): Omit<PreparedNativeLinkUpdateV4, 'inverseRecipes'>;
function prepareNativeLinkInverseForParser(input: InverseMutationInput, parserVersion: 2 | 4):
  Omit<PreparedNativeLinkUpdate, 'inverseRecipes'> | Omit<PreparedNativeLinkUpdateV4, 'inverseRecipes'> {
  const { state, inverseRecipes, operationId } = input;
  if (!operationId || !inverseRecipes.length) return conflict('invalid-recipe');
  return inspectPersistedNativeCollaborationSnapshot(state, (verified, snapshot) => {
    const originalV4 = parserVersion === 4 ? inspectNativeMutationStateV4(state) : null;
    const inventory = originalV4?.inventory ?? inspectPersistedDocumentLinks(state);
    if (parserVersion === 2 && !inventory.coverage.complete) return conflict('incomplete-coverage');
    for (const inverse of inverseRecipes) {
      assertIdentity(state, inverse.source);
      if (inverse.contractVersion !== 2 || !inverse.authorizedForwardRecipeProof
        || nativeLinkJsonProof(inverseScope(verified, inverse)) !== inverse.expectedScopeProof) return conflict('target-changed');
    }
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(verified));
      hydrateCandidate(candidate, state);
      candidate.transact(() => { for (const inverse of [...inverseRecipes].reverse()) applyInverse(candidate, inverse, operationId); }, operationId);
      const next = proposedState(state, candidate);
      const afterV4 = parserVersion === 4 ? inspectNativeMutationStateV4(next) : null;
      const after = afterV4?.inventory ?? inspectPersistedDocumentLinks(next);
      if (parserVersion === 2 && !after.coverage.complete
        || originalV4 && afterV4?.htmlSourceProof !== originalV4.htmlSourceProof) return conflict('incomplete-coverage');
      const common = { operationId, source: inventory.document,
        before: { stateProof: snapshot.version.stateProof, stateVector: snapshot.version.stateVector, documentSequence: snapshot.version.documentSequence },
        after: { stateProof: after.version.stateProof, stateVector: after.version.stateVector },
        update: Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(verified)) };
      return originalV4 ? { contractVersion: 4, ...common, parserVersion: 4, htmlSourceProof: originalV4.htmlSourceProof }
        : { contractVersion: 2, ...common };
    } finally { candidate.destroy(); }
  });
}
