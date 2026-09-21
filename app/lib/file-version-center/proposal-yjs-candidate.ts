import 'server-only';

import { createHash } from 'node:crypto';
import type * as YTypes from 'yjs';

import { Y } from '../collaboration/server-runtime';
import { BLOCK_TREE_KEY } from '../collaboration/block-tree';
import {
  applyAgentBlockTargets, applyAgentTextTargets, applyRichMarkdownPatchTargets, createAgentTextTarget,
  type AgentTextTarget,
} from '../collaboration/agent-operations';
import { readAgentBlockStructure, validateAgentBlockDocument } from '../collaboration/agent-block-structure';
import { blockTreeTextScopes, readRichDocumentJson } from '../collaboration/rich-document';
import { richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../collaboration/markdown-state';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes, PROPOSAL_GRAPH_LIMITS as Limits,
  ProposalGraphContractError, type ProposalCurrentProofV1, type ProposalGraphErrorCode,
} from './contracts/proposal-graph-v1';

export type ProposalYjsRepresentation = 'plain_text' | 'tiptap_xml' | 'tiptap_blocks';
type Interval = { client: number; clock: number; length: number };
type Anchor = { start: string; end: string; blockId?: string | null };
type BlockGap = { parentId: string | null; beforeId: string | null; afterId: string | null };
type AnchorMap = { version: 1; insertionGaps: Anchor[]; postEffect: Anchor[]; equivalentEffect: Anchor[]; blockInsertionGaps: BlockGap[] };
type Effect = { version: 1; introduced: Interval[]; deleted: Interval[] };
type Payload = {
  version: 1; representation: ProposalYjsRepresentation; sourceUpdateHash: string;
  candidateUpdateHash: string; deltaBase64: string; targets: AgentTextTarget[]; reverseTargets: AgentTextTarget[];
};

/** Bytes are persisted independently, with immutable storage references/hashes. */
export type ProposalYjsArtifacts = {
  incrementalPayload: Uint8Array;
  cumulativeCandidate: Uint8Array;
  effectPreconditions: Uint8Array;
  anchorMap: Uint8Array;
};

export type AuthoredProposalYjsCandidate = ProposalYjsArtifacts & {
  sourceUpdateHash: string;
  candidateUpdateHash: string;
  content: string;
};

export type ProposalYjsCompositionEntry = {
  proposalId: string;
  dependencyProposalId: string | null;
  mode: 'apply' | 'prerequisite';
  sourceUpdate: Uint8Array;
  artifacts: ProposalYjsArtifacts;
};

type CompositionSuccess = {
  status: 'clean' | 'clean_rebased' | 'satisfied_elsewhere' | 'empty_effect';
  candidateUpdate: Uint8Array;
  delta: Uint8Array;
  current: ProposalCurrentProofV1;
  candidate: ProposalCurrentProofV1;
  content: string;
  appliedProposalIds: string[];
  satisfiedProposalIds: string[];
};
export type ProposalYjsCompositionResult = CompositionSuccess | {
  status: 'conflicted' | 'prerequisite_lost' | 'unavailable';
  reasonCode: ProposalGraphErrorCode;
  proposalIds: string[];
};

const origin = { actorType: 'agent' as const, actorId: 'proposal-candidate', initiatedByUserId: 'proposal-candidate', operationId: 'proposal-candidate' };
const maxIntervals = 65_536;
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function fail(code: ProposalGraphErrorCode, message: string): never {
  throw new ProposalGraphContractError(code, message);
}
function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
}
function bytes(value: unknown): Uint8Array {
  const encoded = Buffer.from(json(value));
  bounded(encoded, Limits.payloadBytes);
  return encoded;
}
function bounded(value: Uint8Array, limit = Limits.candidateBytes): void {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > limit) {
    fail(Codes.limitExceeded, 'Proposal artifact exceeds its byte bound.');
  }
}
function parse<T>(value: Uint8Array): T {
  bounded(value, Limits.payloadBytes);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as T; }
  catch { return fail(Codes.sourceInvalid, 'Proposal artifact is not valid JSON.'); }
}
function materialize(doc: YTypes.Doc): void {
  if (doc.share.has(BLOCK_TREE_KEY)) doc.getMap(BLOCK_TREE_KEY);
  if (doc.share.has('content')) doc.getText('content');
  if (doc.share.has('body')) doc.getXmlFragment('body');
  for (const name of ['frontmatter', 'bodyFinalLineEnding']) if (doc.share.has(name)) doc.getText(name);
}
function validate(doc: YTypes.Doc, representation: ProposalYjsRepresentation): void {
  if (doc.store.pendingStructs || doc.store.pendingDs) fail(Codes.sourceInvalid, 'A full, causally complete Yjs update is required.');
  const allowed = representation === 'plain_text' ? ['content']
    : [representation === 'tiptap_blocks' ? BLOCK_TREE_KEY : 'body', 'frontmatter', 'bodyFinalLineEnding'];
  if ([...doc.share.keys()].some((key) => !allowed.includes(key))) fail(Codes.sourceInvalid, 'The Yjs representation does not match the document.');
  if (representation === 'plain_text') {
    const value = doc.getText('content').toString();
    if (invalidUnicode.test(value)) fail(Codes.sourceInvalid, 'Invalid Unicode in document.');
    if (Buffer.byteLength(value) > 5 * 1024 * 1024) fail(Codes.limitExceeded, 'Document is too large.');
  } else {
    const error = representation === 'tiptap_blocks' ? validateAgentBlockDocument(doc)
      : (validateRichMarkdownYDoc(doc).valid ? null : 'schema_invalid');
    if (error) fail(error === 'limit_exceeded' ? Codes.limitExceeded : Codes.sourceInvalid, 'The rich document is invalid.');
  }
  bounded(Y.encodeStateAsUpdate(doc));
}
function open(update: Uint8Array, representation: ProposalYjsRepresentation): YTypes.Doc {
  bounded(update);
  // Retain deleted structs in scratch docs: descendants can anchor to authored IDs.
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, update);
    materialize(doc);
    validate(doc, representation);
    return doc;
  } catch (error) { doc.destroy(); throw error; }
}
function content(doc: YTypes.Doc, representation: ProposalYjsRepresentation): string {
  return representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc);
}

/** Read-only rendering of an already validated, full proposal snapshot. */
export function proposalYjsSnapshotContent(input: { update: Uint8Array; representation: ProposalYjsRepresentation }): string {
  const document = open(input.update, input.representation);
  try { return content(document, input.representation); } finally { document.destroy(); }
}
function structure(doc: YTypes.Doc, representation: ProposalYjsRepresentation): unknown {
  return representation === 'plain_text' ? doc.getText('content').toDelta()
    : { body: readRichDocumentJson(doc), frontmatter: doc.getText('frontmatter').toDelta(), ending: doc.getText('bodyFinalLineEnding').toString() };
}
function semanticHash(doc: YTypes.Doc, representation: ProposalYjsRepresentation): string {
  return hash(json(structure(doc, representation)));
}
function preflightHash(doc: YTypes.Doc, representation: ProposalYjsRepresentation, source: YTypes.Doc, targets: AgentTextTarget[]): string {
  if (!targets.some((target) => target.kind === 'rich_markdown_patch')) return semanticHash(doc, representation);
  // The legacy Markdown adapter allocates stable IDs for new nodes on each
  // scratch run. Compare their structure, while retaining every existing ID.
  const existing = new Set<string>();
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'id' && typeof item === 'string' && !existing.has(item) ? '$new-node' : visit(item)]));
  };
  JSON.stringify(structure(source, representation), (key, value: unknown) => {
    if (key === 'id' && typeof value === 'string') existing.add(value);
    return value;
  });
  return hash(json(visit(structure(doc, representation))));
}
function proof(doc: YTypes.Doc, representation: ProposalYjsRepresentation, revisionId: string | null): ProposalCurrentProofV1 {
  const snapshot = Y.snapshot(doc);
  return {
    revisionId, contentHash: hash(content(doc, representation)), structureHash: semanticHash(doc, representation),
    stateVectorHash: hash(Y.encodeStateVector(doc)),
    deleteSetHash: hash(Y.encodeSnapshot(Y.createSnapshot(snapshot.ds, new Map()))),
    fullStateHash: hash(Y.encodeStateAsUpdate(doc)),
  };
}

/** A state vector alone misses deletions. This proof binds all current content and identities. */
export function proposalYjsCurrentProof(input: {
  update: Uint8Array; representation: ProposalYjsRepresentation; revisionId: string | null;
}): ProposalCurrentProofV1 {
  const doc = open(input.update, input.representation);
  try { return proof(doc, input.representation, input.revisionId); } finally { doc.destroy(); }
}

function position(doc: YTypes.Doc, encoded: string): YTypes.AbsolutePosition | null {
  try { return Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(encoded, 'base64')), doc); }
  catch { return null; }
}
function anchor(text: YTypes.Text, index: number, assoc: number): string {
  return Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc))).toString('base64');
}
function range(doc: YTypes.Doc, value: Anchor): { text: YTypes.Text; from: number; to: number } | null {
  const start = position(doc, value.start); const end = position(doc, value.end);
  if (!start || !end || start.type !== end.type || !(start.type instanceof Y.Text) || start.index > end.index) return null;
  if (doc.share.has(BLOCK_TREE_KEY) && blockTreeTextScopes(doc).get(start.type as YTypes.Text) !== value.blockId) return null;
  return { text: start.type as YTypes.Text, from: start.index, to: end.index };
}
function makeAnchors(source: YTypes.Doc, candidate: YTypes.Doc, targets: AgentTextTarget[], reverse: AgentTextTarget[]): AnchorMap {
  const insertionGaps: Anchor[] = [];
  const postEffect: Anchor[] = [];
  const equivalentEffect: Anchor[] = [];
  const blockInsertionGaps: BlockGap[] = [];
  if (targets.some((target) => target.kind === 'block_edit')) {
    const before = readAgentBlockStructure(source); const after = readAgentBlockStructure(candidate);
    const oldIds = new Set(before.map((entry) => entry.id));
    const afterById = new Map(after.map((entry) => [entry.id, entry]));
    for (const inserted of after.filter((entry) => !oldIds.has(entry.id) && (entry.parentId === null || oldIds.has(entry.parentId)))) {
      let beforeId = inserted.beforeId;
      while (beforeId !== null && !oldIds.has(beforeId)) beforeId = afterById.get(beforeId)?.beforeId ?? null;
      const gap = { parentId: inserted.parentId, beforeId,
        afterId: before.find((entry) => entry.parentId === inserted.parentId && entry.beforeId === beforeId)?.id ?? null };
      if (!blockInsertionGaps.some((existing) => json(existing) === json(gap))) blockInsertionGaps.push(gap);
    }
  }
  for (const target of targets.filter((entry) => !entry.kind || entry.kind === 'text_replace')) {
    const start = position(source, target.startAnchor); const end = position(source, target.endAnchor);
    if (!start || !end || start.type !== end.type || !(start.type instanceof Y.Text)) fail(Codes.sourceInvalid, 'Invalid authored anchor.');
    if (start.index === end.index) insertionGaps.push({ start: anchor(start.type as YTypes.Text, start.index, -1),
      end: anchor(start.type as YTypes.Text, start.index, 0), ...(target.blockId !== undefined ? { blockId: target.blockId } : {}) });
    equivalentEffect.push({ start: anchor(start.type as YTypes.Text, start.index, -1),
      end: anchor(start.type as YTypes.Text, end.index, 0), ...(target.blockId !== undefined ? { blockId: target.blockId } : {}) });
  }
  for (const target of reverse.filter((entry) => !entry.kind || entry.kind === 'text_replace')) {
    const start = position(candidate, target.startAnchor); const end = position(candidate, target.endAnchor);
    if (!start || !end || start.type !== end.type || !(start.type instanceof Y.Text)) fail(Codes.sourceInvalid, 'Invalid post-effect anchor.');
    // Deletion witnesses surround the gap. Otherwise a manual reinsertion could
    // satisfy the old tombstones while silently undoing the accepted deletion.
    postEffect.push({ start: start.index === end.index ? anchor(start.type as YTypes.Text, start.index, -1) : target.startAnchor,
      end: start.index === end.index ? anchor(start.type as YTypes.Text, start.index, 0) : target.endAnchor,
      ...(target.blockId !== undefined ? { blockId: target.blockId } : {}) });
  }
  return { version: 1, insertionGaps, postEffect, equivalentEffect, blockInsertionGaps };
}
function subtract(interval: Interval, removals: Array<{ clock: number; len: number }>): Interval[] {
  let start = interval.clock;
  const end = start + interval.length;
  const result: Interval[] = [];
  for (const removal of removals) {
    if (removal.clock >= end) break;
    if (removal.clock + removal.len <= start) continue;
    if (removal.clock > start) result.push({ client: interval.client, clock: start, length: removal.clock - start });
    start = Math.max(start, removal.clock + removal.len);
    if (start >= end) break;
  }
  if (start < end) result.push({ client: interval.client, clock: start, length: end - start });
  return result;
}
function effect(source: YTypes.Doc, candidate: YTypes.Doc): Effect {
  const before = Y.snapshot(source); const after = Y.snapshot(candidate);
  const introduced: Interval[] = []; const deleted: Interval[] = [];
  for (const [client, clock] of after.sv) {
    const previous = before.sv.get(client) ?? 0;
    if (clock > previous) introduced.push({ client, clock: previous, length: clock - previous });
  }
  for (const [client, ranges] of after.ds.clients) for (const value of ranges) {
    deleted.push(...subtract({ client, clock: value.clock, length: value.len }, before.ds.clients.get(client) ?? []));
  }
  if (introduced.length + deleted.length > maxIntervals) fail(Codes.limitExceeded, 'Too many authored identity intervals.');
  const order = (a: Interval, b: Interval) => a.client - b.client || a.clock - b.clock;
  return { version: 1, introduced: introduced.sort(order), deleted: deleted.sort(order) };
}
function boundTargets(targets: AgentTextTarget[]): void {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 32) fail(Codes.limitExceeded, 'Invalid target count.');
  let length = 0;
  for (const target of targets) {
    if (!target || typeof target !== 'object' || typeof target.replacement !== 'string') fail(Codes.sourceInvalid, 'Invalid authored target.');
    for (const value of [target.replacement, target.startAnchor, target.endAnchor, target.baseDocumentSnapshot,
      target.blockEdit?.updateBase64, target.blockEdit?.beforeText, target.blockEdit?.afterText]) {
      if (typeof value === 'string') length += value.length;
    }
    if (length > Limits.payloadBytes) fail(Codes.limitExceeded, 'Target text exceeds the payload bound.');
  }
}
function runTargets(doc: YTypes.Doc, targets: AgentTextTarget[], representation: ProposalYjsRepresentation): AgentTextTarget[] {
  boundTargets(targets);
  const validateClone = representation === 'tiptap_blocks' ? validateAgentBlockDocument
    : representation === 'tiptap_xml' ? (clone: YTypes.Doc) => validateRichMarkdownYDoc(clone).valid ? null : 'schema_invalid' as const : undefined;
  const result = targets.some((target) => target.kind === 'rich_markdown_patch')
    ? applyRichMarkdownPatchTargets({ doc, targets, origin })
    : targets.some((target) => target.kind === 'block_edit')
    ? applyAgentBlockTargets({ doc, targets, origin, validateClone })
    : applyAgentTextTargets({ doc, targets, origin, validateClone, independentGroups: false });
  if (result.status !== 'applied_to_ydoc' || result.appliedTargetIds.length !== targets.length) {
    fail(result.conflicts.some((entry) => entry.code === 'limit_exceeded') ? Codes.limitExceeded : Codes.batchConflict, 'Authored targets do not apply cleanly.');
  }
  validate(doc, representation);
  return result.reverseTargets;
}

/** Author once on an isolated source clone. Subsequent accepts MUST reuse its delta. */
export function authorProposalYjsCandidate(input: {
  representation: ProposalYjsRepresentation; sourceUpdate: Uint8Array; targets: AgentTextTarget[];
}): AuthoredProposalYjsCandidate {
  boundTargets(input.targets);
  const source = open(input.sourceUpdate, input.representation);
  const candidate = open(input.sourceUpdate, input.representation);
  const updates: Uint8Array[] = [];
  const capture = (update: Uint8Array) => updates.push(update);
  try {
    bytes(input.targets);
    candidate.on('update', capture);
    const reverseTargets = runTargets(candidate, input.targets, input.representation);
    candidate.off('update', capture);
    if (semanticHash(source, input.representation) === semanticHash(candidate, input.representation)) fail(Codes.noEffect, 'The proposal has no authored effect.');
    const cumulativeCandidate = Y.encodeStateAsUpdate(candidate);
    const sourceUpdateHash = hash(input.sourceUpdate); const candidateUpdateHash = hash(cumulativeCandidate);
    return {
      sourceUpdateHash, candidateUpdateHash, cumulativeCandidate, content: content(candidate, input.representation),
      incrementalPayload: bytes({ version: 1, representation: input.representation, sourceUpdateHash, candidateUpdateHash,
        // encodeStateAsUpdate(candidate, sourceVector) would include ALL source
        // tombstones, including unrelated manual deletions. Capture only the
        // actual authored transactions so descendant proofs cannot import them.
        targets: input.targets, reverseTargets, deltaBase64: Buffer.from(Y.mergeUpdates(updates)).toString('base64') } satisfies Payload),
      effectPreconditions: bytes(effect(source, candidate)),
      anchorMap: bytes(makeAnchors(source, candidate, input.targets, reverseTargets)),
    };
  } finally { candidate.off('update', capture); source.destroy(); candidate.destroy(); }
}

type Loaded = { entry: ProposalYjsCompositionEntry; payload: Payload; anchors: AnchorMap; effect: Effect; source: YTypes.Doc; candidate: YTypes.Doc };
function load(entry: ProposalYjsCompositionEntry, representation: ProposalYjsRepresentation): Loaded {
  bounded(entry.sourceUpdate); bounded(entry.artifacts.cumulativeCandidate);
  const payload = parse<Payload>(entry.artifacts.incrementalPayload);
  const anchors = parse<AnchorMap>(entry.artifacts.anchorMap);
  const effects = parse<Effect>(entry.artifacts.effectPreconditions);
  boundTargets(payload.targets); boundTargets(payload.reverseTargets);
  if (payload.version !== 1 || anchors.version !== 1 || effects.version !== 1 || payload.representation !== representation
    || payload.sourceUpdateHash !== hash(entry.sourceUpdate) || payload.candidateUpdateHash !== hash(entry.artifacts.cumulativeCandidate)) {
    fail(Codes.sourceInvalid, 'Authored artifact identity is inconsistent.');
  }
  const source = open(entry.sourceUpdate, representation);
  let candidate: YTypes.Doc | undefined;
  try {
    candidate = open(entry.artifacts.cumulativeCandidate, representation);
    if (json(effect(source, candidate)) !== json(effects)
      || json(makeAnchors(source, candidate, payload.targets, payload.reverseTargets)) !== json(anchors)) {
      fail(Codes.sourceInvalid, 'Authored effect or anchor proof is inconsistent.');
    }
    const delta = Buffer.from(payload.deltaBase64, 'base64'); bounded(delta);
    const actualDeleted = [...Y.decodeUpdate(delta).ds.clients].flatMap(([client, ranges]) => ranges.map((value) => ({ client, clock: value.clock, length: value.len })))
      .sort((a, b) => a.client - b.client || a.clock - b.clock);
    if (json(actualDeleted) !== json(effects.deleted)) fail(Codes.sourceInvalid, 'Authored delta includes source deletion state outside its effect.');
    const replay = open(entry.sourceUpdate, representation);
    const preflight = open(entry.sourceUpdate, representation);
    try {
      Y.applyUpdate(replay, delta); validate(replay, representation);
      runTargets(preflight, payload.targets, representation);
      if (hash(Y.encodeStateAsUpdate(replay)) !== hash(Y.encodeStateAsUpdate(candidate))
        || preflightHash(preflight, representation, source, payload.targets) !== preflightHash(candidate, representation, source, payload.targets)) fail(Codes.sourceInvalid, 'Stored delta disagrees with the authored target plan.');
    } finally { replay.destroy(); preflight.destroy(); }
    return { entry, payload, anchors, effect: effects, source, candidate };
  } catch (error) { source.destroy(); candidate?.destroy(); throw error; }
}
function deletedParts(snapshot: YTypes.Snapshot, interval: Interval): Array<[number, number]> {
  return (snapshot.ds.clients.get(interval.client) ?? []).flatMap((value): Array<[number, number]> => {
    const from = Math.max(value.clock, interval.clock); const to = Math.min(value.clock + value.len, interval.clock + interval.length);
    return from < to ? [[from, to]] : [];
  });
}
function visibleAnchorEffect(current: YTypes.Doc, expected: YTypes.Doc, value: Anchor): boolean {
  const target = range(expected, value); const actual = range(current, value);
  if (!target || !actual) {
    // A descendant may intentionally remove a containing block. Its structural
    // proof still has to verify absence; hidden text is never treated as live.
    return value.blockId != null && expected.share.has(BLOCK_TREE_KEY) && current.share.has(BLOCK_TREE_KEY)
      && !readAgentBlockStructure(expected).some((entry) => entry.id === value.blockId)
      && !readAgentBlockStructure(current).some((entry) => entry.id === value.blockId);
  }
  const planned = createAgentTextTarget({ text: target.text, from: target.from, to: target.to, replacement: '', targetId: 'effect', groupId: 'effect' });
  const present = createAgentTextTarget({ text: actual.text, from: actual.from, to: actual.to, replacement: '', targetId: 'effect', groupId: 'effect' });
  return planned.baseTargetHash === present.baseTargetHash && planned.baseFormatHash === present.baseFormatHash;
}
function blockEffect(current: YTypes.Doc, expected: YTypes.Doc, targets: AgentTextTarget[]): boolean {
  const postconditions = targets.flatMap((target) => target.blockEdit?.postconditions ?? []);
  if (!postconditions.length) return true;
  const now = new Map(readAgentBlockStructure(current).map((entry) => [entry.id, entry]));
  const net = new Map(readAgentBlockStructure(expected).map((entry) => [entry.id, entry]));
  return postconditions.every((condition) => {
    const actual = now.get(condition.id); const desired = net.get(condition.id);
    if (!desired || !actual) return !desired && !actual;
    if (actual.type !== desired.type) return false;
    if (condition.subtreeHash !== undefined && actual.subtreeHash !== desired.subtreeHash) return false;
    if (condition.parentId !== undefined && actual.parentId !== desired.parentId) return false;
    if (condition.beforeId !== undefined && actual.beforeId !== desired.beforeId) return false;
    if (condition.placementHash !== undefined && actual.placementHash !== desired.placementHash) return false;
    return !condition.attrs || Object.keys(condition.attrs).every((key) => json(actual.attrs[key]) === json(desired.attrs[key]));
  });
}
function hasEffect(current: YTypes.Doc, expected: YTypes.Doc, loaded: Loaded): boolean {
  const currentSnapshot = Y.snapshot(current); const expectedSnapshot = Y.snapshot(expected);
  const currentVector = currentSnapshot.sv;
  for (const interval of [...loaded.effect.introduced, ...loaded.effect.deleted]) {
    if ((currentVector.get(interval.client) ?? 0) < interval.clock + interval.length
      || json(deletedParts(currentSnapshot, interval)) !== json(deletedParts(expectedSnapshot, interval))) return false;
  }
  if (loaded.payload.targets.some((target) => target.kind === 'rich_markdown_patch')) {
    return semanticHash(current, loaded.payload.representation) === semanticHash(expected, loaded.payload.representation);
  }
  return loaded.anchors.postEffect.every((value) => visibleAnchorEffect(current, expected, value))
    && blockEffect(current, expected, loaded.payload.targets);
}
function hasEquivalentInlineEffect(current: YTypes.Doc, loaded: Loaded): boolean {
  return loaded.anchors.equivalentEffect.length === loaded.payload.targets.length
    && loaded.anchors.equivalentEffect.every((value) => visibleAnchorEffect(current, loaded.candidate, value));
}
function applyStored(candidate: YTypes.Doc, loaded: Loaded, representation: ProposalYjsRepresentation): void {
  for (const gap of loaded.anchors.insertionGaps) {
    const resolved = range(candidate, gap);
    if (!resolved || resolved.from !== resolved.to) fail(Codes.batchConflict, 'Another edit inserted into the same authored gap.');
  }
  if (loaded.anchors.blockInsertionGaps.length) {
    const now = readAgentBlockStructure(candidate);
    for (const gap of loaded.anchors.blockInsertionGaps) {
      const predecessor = now.find((entry) => entry.parentId === gap.parentId && entry.beforeId === gap.beforeId)?.id ?? null;
      if (predecessor !== gap.afterId) fail(Codes.batchConflict, 'Another edit changed the same block insertion gap.');
    }
  }
  const preflight = open(Y.encodeStateAsUpdate(candidate), representation);
  const currentIdentitySource = open(Y.encodeStateAsUpdate(candidate), representation);
  try {
    runTargets(preflight, loaded.payload.targets, representation);
    // Adapter preflight validates intent. Its newly generated text IDs must NOT
    // be applied: only this immutable authored delta can satisfy child anchors.
    Y.applyUpdate(candidate, Buffer.from(loaded.payload.deltaBase64, 'base64'));
    validate(candidate, representation);
    if (preflightHash(preflight, representation, currentIdentitySource, loaded.payload.targets) !== preflightHash(candidate, representation, currentIdentitySource, loaded.payload.targets)) {
      fail(Codes.batchConflict, 'Stored delta and current target preflight disagree.');
    }
  } finally { preflight.destroy(); currentIdentitySource.destroy(); }
}

/**
 * Pure composition only. The caller must authorize scope, validate the graph,
 * verify immutable storage-reference hashes/source provenance, and fence the
 * returned current proof before any authoritative mutation. Ordered entries
 * are exactly the graph model's dependency closure, NOT closing alternatives.
 */
export function composeProposalYjsCandidate(input: {
  representation: ProposalYjsRepresentation; currentUpdate: Uint8Array;
  revisionId: string | null; ordered: ProposalYjsCompositionEntry[];
}): ProposalYjsCompositionResult {
  const documents: YTypes.Doc[] = []; const loaded: Loaded[] = [];
  let activeId: string | null = null;
  try {
    if (!input.ordered.length || input.ordered.length > Limits.closureNodes) fail(Codes.limitExceeded, 'Invalid composition closure size.');
    bounded(input.currentUpdate);
    let totalBytes = input.currentUpdate.byteLength;
    const seen = new Map<string, ProposalYjsCompositionEntry>();
    for (const entry of input.ordered) {
      activeId = entry.proposalId;
      bounded(entry.sourceUpdate); bounded(entry.artifacts.cumulativeCandidate);
      for (const artifact of [entry.artifacts.incrementalPayload, entry.artifacts.effectPreconditions, entry.artifacts.anchorMap]) bounded(artifact, Limits.payloadBytes);
      if (!entry.proposalId || seen.has(entry.proposalId) || (entry.dependencyProposalId && !seen.has(entry.dependencyProposalId))
        || (entry.mode !== 'apply' && entry.mode !== 'prerequisite')
        || (entry.mode === 'prerequisite' && entry.dependencyProposalId && seen.get(entry.dependencyProposalId)?.mode === 'apply')) {
        fail(Codes.sourceInvalid, 'Composition requires a unique parent-before-child closure.');
      }
      seen.set(entry.proposalId, entry);
      totalBytes += entry.sourceUpdate.byteLength + entry.artifacts.cumulativeCandidate.byteLength + entry.artifacts.incrementalPayload.byteLength
        + entry.artifacts.effectPreconditions.byteLength + entry.artifacts.anchorMap.byteLength;
      if (totalBytes > Limits.artifactBytesPerGraph) fail(Codes.limitExceeded, 'Composition artifacts exceed the aggregate bound.');
      const next = load(entry, input.representation); loaded.push(next);
      documents.push(next.source, next.candidate);
    }
    const current = open(input.currentUpdate, input.representation); documents.push(current);
    const candidate = open(input.currentUpdate, input.representation); documents.push(candidate);
    const prerequisites = loaded.filter((entry) => entry.entry.mode === 'prerequisite');
    if (prerequisites.length) {
      const lost: string[] = [];
      for (const prerequisite of prerequisites) {
        activeId = prerequisite.entry.proposalId;
        const expected = open(prerequisite.entry.artifacts.cumulativeCandidate, input.representation);
        try {
          const descendants = new Set([activeId]);
          // Only explicit descendant EFFECTS may supersede an ancestor effect.
          // Full source/candidate unions from other branches can import manual
          // reverts and incorrectly bless a prerequisite that the user removed.
          for (const descendant of prerequisites) {
            if (!descendant.entry.dependencyProposalId || !descendants.has(descendant.entry.dependencyProposalId)) continue;
            descendants.add(descendant.entry.proposalId);
            Y.applyUpdate(expected, Buffer.from(descendant.payload.deltaBase64, 'base64'));
          }
          materialize(expected); validate(expected, input.representation);
          if (!hasEffect(current, expected, prerequisite)) {
            // Legacy full-document patches have no scoped structural effect
            // proof. Keep their existing exact fence; do not mislabel a mere
            // unrelated document difference as a proven lost prerequisite.
            if (prerequisite.payload.targets.some((target) => target.kind === 'rich_markdown_patch')) {
              return { status: 'unavailable', reasonCode: Codes.upgradeRequired, proposalIds: [activeId] };
            }
            lost.push(activeId);
          }
        } finally { expected.destroy(); }
      }
      if (lost.length) return { status: 'prerequisite_lost', reasonCode: Codes.prerequisiteLost, proposalIds: lost };
    }
    const appliedProposalIds: string[] = []; const satisfiedProposalIds: string[] = [];
    const withoutAuthoredIdentities = new Set<string>();
    let rebased = false;
    for (const entry of loaded.filter((value) => value.entry.mode === 'apply')) {
      activeId = entry.entry.proposalId;
      if (entry.entry.dependencyProposalId && withoutAuthoredIdentities.has(entry.entry.dependencyProposalId)) {
        return { status: 'prerequisite_lost', reasonCode: Codes.prerequisiteLost, proposalIds: [entry.entry.dependencyProposalId] };
      }
      if (hasEffect(candidate, entry.candidate, entry)) { satisfiedProposalIds.push(activeId); continue; }
      if (!entry.entry.dependencyProposalId && hasEquivalentInlineEffect(candidate, entry)) {
        satisfiedProposalIds.push(activeId); withoutAuthoredIdentities.add(activeId); continue;
      }
      if (hash(Y.encodeStateAsUpdate(candidate)) !== hash(Y.encodeStateAsUpdate(entry.source))) rebased = true;
      applyStored(candidate, entry, input.representation);
      appliedProposalIds.push(activeId);
    }
    const currentProof = proof(current, input.representation, input.revisionId);
    const candidateProof = proof(candidate, input.representation, null);
    const status = currentProof.structureHash === candidateProof.structureHash
      ? appliedProposalIds.length ? 'empty_effect' : 'satisfied_elsewhere'
      : rebased ? 'clean_rebased' : 'clean';
    return { status, current: currentProof, candidate: candidateProof, candidateUpdate: Y.encodeStateAsUpdate(candidate),
      delta: Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(current)), content: content(candidate, input.representation),
      appliedProposalIds, satisfiedProposalIds };
  } catch (error) {
    const code = error instanceof ProposalGraphContractError ? error.code : Codes.sourceInvalid;
    return { status: code === Codes.batchConflict ? 'conflicted' : 'unavailable', reasonCode: code, proposalIds: activeId ? [activeId] : [] };
  } finally { for (const doc of documents) doc.destroy(); }
}
