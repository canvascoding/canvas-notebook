import 'server-only';

import crypto, { randomUUID } from 'node:crypto';
import type * as YTypes from 'yjs';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import {
  applyExactTextEdits,
  resolveExactTextEditMatchCount,
  type ExactTextEdit,
} from '@/app/lib/files/exact-text-patch';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  AgentDirectConnectionAuthorizationError,
  runCollaborationDirectConnection,
} from './direct-connection';
import { loadCollaborationState } from './persistence';
import {
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from './markdown-state';
import { Y } from './server-runtime';
import {
  getWorkspacePresenceSnapshot,
  removeDocumentPresenceEntry,
  upsertDocumentPresenceEntry,
} from './presence';

const MAX_AGENT_TARGETS = 32;
const MAX_AGENT_GROUPS = 16;
const MAX_AGENT_REPLACEMENT_BYTES = 256 * 1024;
const MAX_AGENT_PAYLOAD_BYTES = 512 * 1024;
const MAX_COLLABORATIVE_TEXT_BYTES = 5 * 1024 * 1024;
const AGENT_OPERATION_TTL_MS = 15 * 60_000;
const SEMANTIC_CHANGE_WINDOW_MS = 5 * 60_000;
const PERSISTENCE_CONFIRMATION_TIMEOUT_MS = 5_000;
const MAX_AGENT_TRIGGER_DEPTH = 4;
const MAX_PENDING_AGENT_APPLIES_PER_DOCUMENT = 16;
const AGENT_QUEUE_REVIEW_AFTER_MS = 1_000;

export type AgentBoundaryPolicy = 'exclude_external';
export type AgentOperationStatus =
  | 'preparing'
  | 'ready'
  | 'applying'
  | 'applied_to_ydoc'
  | 'persisted_yjs'
  | 'checkpointed_file'
  | 'partially_applied'
  | 'needs_review'
  | 'semantic_conflict'
  | 'cancel_requested'
  | 'cancelled'
  | 'expired'
  | 'superseded'
  | 'failed'
  | 'rejected'
  | 'reverted';

export interface AgentTextTarget {
  kind?: 'text_replace' | 'rich_markdown_patch';
  targetId: string;
  groupId: string;
  startAnchor: string;
  endAnchor: string;
  baseTargetHash: string;
  replacement: string;
  replacementAttributes?: Record<string, unknown>;
  patchEdits?: ExactTextEdit[];
  boundaryPolicy: AgentBoundaryPolicy;
}

export interface ActiveCompositionRange {
  textName: string;
  from: number;
  to: number;
}

export interface AgentApplyConflict {
  targetId: string;
  groupId: string;
  code:
    | 'anchor_invalid'
    | 'target_changed'
    | 'overlap'
    | 'unicode_boundary'
    | 'ime_composition'
    | 'limit_exceeded'
    | 'schema_invalid'
    | 'stable_id_missing'
    | 'stable_id_duplicate'
    | 'roundtrip_unstable'
    | 'target_scope_invalid'
    | 'backpressure'
    | 'feedback_loop'
    | 'authorization_revoked'
    | 'persistence_degraded'
    | 'lifecycle_stale'
    | 'cancelled'
    | 'restart_uncertain';
}

export interface AgentApplyResult {
  status: 'applied_to_ydoc' | 'partially_applied' | 'needs_review' | 'semantic_conflict';
  appliedTargetIds: string[];
  conflicts: AgentApplyConflict[];
  stateVector: string;
}

type AgentApplyExecutionResult = AgentApplyResult & { reverseTargets: AgentTextTarget[] };

export interface PersistedAgentApplyResult extends AgentApplyResult {
  operationId: string;
  durability: 'pending' | 'applied_to_ydoc' | 'persisted_yjs' | 'checkpointed_file' | 'needs_review';
  operationStatus: AgentOperationStatus;
  casVersion: number;
}

export interface AgentOperationView extends PersistedAgentApplyResult {
  documentId: string;
  workspaceId: string;
  initiatedByUserId: string;
  initiatedByDisplayName: string;
  initiatedByCurrentUser: boolean;
  actionsAllowed: boolean;
  actorId: string;
  operationType: 'apply' | 'revert';
  requestedMode: 'direct_apply' | 'review';
  runGeneration: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  reviewTargets?: Array<{
    targetId: string;
    groupId: string;
    proposedReplacement: string;
    currentText: string | null;
    currentTargetHash: string | null;
  }>;
  targetAnchors: Array<{
    targetId: string;
    groupId: string;
    startAnchor: string;
    endAnchor: string;
  }>;
}

type ResolvedTarget = AgentTextTarget & {
  from: number;
  to: number;
  currentText: string;
  text: YTypes.Text;
};

type AgentOperationRow = {
  operation_id: string;
  document_id: string;
  document_path: string | null;
  document_representation: 'plain_text' | 'tiptap_xml' | null;
  workspace_id: string;
  organization_id: string | null;
  document_lifecycle_generation: number;
  schema_version: number;
  initiated_by_user_id: string;
  initiated_by_display_name?: string | null;
  actor_id: string;
  agent_run_id: string | null;
  actor_session_id: string | null;
  supersedes_operation_id: string | null;
  idempotency_key: string;
  run_generation: number;
  payload_hash: string;
  operation_type: 'apply' | 'revert';
  requested_mode: 'direct_apply' | 'review';
  atomicity: 'all_or_nothing' | 'independent';
  operation_payload: string | null;
  reverse_payload: string | null;
  status: AgentOperationStatus;
  base_state_vector: Buffer | Uint8Array;
  base_document_sequence: number;
  resulting_state_vector_hash: string | null;
  checkpoint_revision_id: string | null;
  result_json: string | null;
  cas_version: number;
  cancel_requested_at: number | null;
  applied_at: number | null;
  persisted_at: number | null;
  checkpointed_at: number | null;
  expires_at: number | null;
  error_code: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  trigger_depth: number;
  expected_canonical_hash: string | null;
  applied_document_sequence: number | null;
  action_keys_json: string;
  created_at: number;
  updated_at: number;
};

class AgentOperationCancelledError extends Error {}

function hash(value: string | Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodePosition(position: YTypes.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

function decodePosition(value: string): YTypes.RelativePosition | null {
  try {
    return Y.decodeRelativePosition(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

function textValue(text: YTypes.Text): string {
  return text.toDelta().map((part: { insert?: unknown }) => typeof part.insert === 'string' ? part.insert : '').join('');
}

/**
 * Yjs initially restores top-level shared types as AbstractType placeholders
 * when an update is applied to a fresh document. Resolve the collaboration
 * schema before decoding RelativePositions so persisted anchors regain their
 * concrete Text/XmlFragment constructors.
 */
function materializeCollaborationTypes(doc: YTypes.Doc): void {
  if (doc.share.has('content')) doc.getText('content');
  if (doc.share.has('frontmatter')) doc.getText('frontmatter');
  if (doc.share.has('body')) doc.getXmlFragment('body');
}

function uniformTextAttributes(text: YTypes.Text, from: number, to: number): Record<string, unknown> | undefined {
  if (from === to) return undefined;
  let offset = 0;
  let signature: string | null = null;
  let attributes: Record<string, unknown> | undefined;
  for (const part of text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
    const length = typeof part.insert === 'string' ? part.insert.length : 0;
    const partFrom = offset;
    const partTo = offset + length;
    offset = partTo;
    if (partTo <= from || partFrom >= to) continue;
    const nextAttributes = part.attributes || {};
    const nextSignature = JSON.stringify(nextAttributes, Object.keys(nextAttributes).sort());
    if (signature !== null && signature !== nextSignature) return undefined;
    signature = nextSignature;
    attributes = Object.keys(nextAttributes).length > 0 ? nextAttributes : undefined;
  }
  return attributes;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function graphemeBoundaries(value: string): Set<number> {
  const boundaries = new Set<number>([0, value.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const segment of segmenter.segment(value)) boundaries.add(segment.index);
  return boundaries;
}

function payloadKey(): Buffer {
  const secret = process.env.CANVAS_COLLABORATION_TICKET_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error('Collaboration operation payload encryption requires a 32-character server secret.');
  return crypto.createHash('sha256').update(`canvas-collaboration-agent:${secret}`).digest();
}

function sealPayload(value: unknown): string {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  if (plaintext.byteLength > MAX_AGENT_PAYLOAD_BYTES) throw new Error('Agent operation payload exceeds the 512 KiB limit.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', payloadKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function openPayload<T>(value: string | null): T | null {
  if (!value) return null;
  const [version, ivValue, tagValue, encryptedValue, extra] = value.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue || extra) throw new Error('Invalid encrypted collaboration operation payload.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', payloadKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

function stateVectorHash(value: Uint8Array | string): string {
  return hash(typeof value === 'string' ? Buffer.from(value, 'base64') : value);
}

function stateVectorIncludes(current: Uint8Array, expectedBase64: string): boolean {
  const currentClocks = Y.decodeStateVector(current);
  const expectedClocks = Y.decodeStateVector(Buffer.from(expectedBase64, 'base64'));
  for (const [clientId, expectedClock] of expectedClocks) {
    if ((currentClocks.get(clientId) || 0) < expectedClock) return false;
  }
  return true;
}

export function createAgentTextTarget(input: {
  text: YTypes.Text;
  from: number;
  to: number;
  replacement: string;
  targetId?: string;
  groupId?: string;
  boundaryPolicy?: AgentBoundaryPolicy;
}): AgentTextTarget {
  const value = textValue(input.text);
  const boundaries = graphemeBoundaries(value);
  if (input.from < 0 || input.to < input.from || input.to > value.length || !boundaries.has(input.from) || !boundaries.has(input.to)) {
    throw new Error('Agent target must align with complete Unicode grapheme boundaries.');
  }
  if (hasUnpairedSurrogate(input.replacement)) throw new Error('Agent replacement contains an invalid Unicode surrogate.');
  const empty = input.from === input.to;
  return {
    kind: 'text_replace',
    targetId: input.targetId || randomUUID(),
    groupId: input.groupId || 'default',
    // Start follows the first target item, while end follows the last target
    // item. Concurrent insertions immediately outside the range stay outside.
    startAnchor: encodePosition(Y.createRelativePositionFromTypeIndex(input.text, input.from, 0)),
    endAnchor: encodePosition(Y.createRelativePositionFromTypeIndex(input.text, input.to, empty ? 0 : -1)),
    baseTargetHash: hash(value.slice(input.from, input.to)),
    replacement: input.replacement,
    replacementAttributes: uniformTextAttributes(input.text, input.from, input.to),
    boundaryPolicy: input.boundaryPolicy || 'exclude_external',
  };
}

function collectRichTextTypes(node: YTypes.AbstractType<unknown>, result: YTypes.Text[]): void {
  if (node instanceof Y.Text) {
    result.push(node as YTypes.Text);
    return;
  }
  const container = node as YTypes.AbstractType<unknown> & { toArray?: () => unknown[] };
  for (const child of container.toArray?.() || []) {
    if (child instanceof Y.AbstractType) collectRichTextTypes(child as YTypes.AbstractType<unknown>, result);
  }
}

/**
 * Creates stable RelativePosition targets inside a Tiptap Y.XmlFragment.
 * Text spanning structural node boundaries is intentionally refused so an
 * agent can never turn a whole Markdown snapshot into an implicit tree merge.
 */
export function createRichAgentTextTargets(input: {
  doc: YTypes.Doc;
  search: string;
  replacement: string;
  expectedOccurrences?: number;
  groupId?: string;
}): AgentTextTarget[] {
  if (!input.search) throw new Error('Rich collaboration agent targets require non-empty source text.');
  materializeCollaborationTypes(input.doc);
  const expected = input.expectedOccurrences ?? 1;
  if (!Number.isInteger(expected) || expected < 1 || expected > MAX_AGENT_TARGETS) {
    throw new Error(`Rich collaboration agent targets require 1-${MAX_AGENT_TARGETS} expected occurrences.`);
  }
  const textTypes: YTypes.Text[] = [];
  const frontmatter = input.doc.share.get('frontmatter');
  if (frontmatter instanceof Y.Text) textTypes.push(frontmatter as YTypes.Text);
  const body = input.doc.share.get('body');
  if (body instanceof Y.AbstractType) collectRichTextTypes(body as YTypes.AbstractType<unknown>, textTypes);

  const targets: AgentTextTarget[] = [];
  for (const text of textTypes) {
    const value = textValue(text);
    let offset = 0;
    while (targets.length < expected) {
      const from = value.indexOf(input.search, offset);
      if (from < 0) break;
      targets.push(createAgentTextTarget({
        text,
        from,
        to: from + input.search.length,
        replacement: input.replacement,
        groupId: input.groupId || 'edit_file',
      }));
      offset = from + input.search.length;
    }
    if (targets.length === expected) break;
  }
  if (targets.length !== expected) {
    throw new Error('Rich collaboration edit requires review because the exact text does not resolve inside stable Tiptap nodes.');
  }
  return targets;
}

export function createRichMarkdownReviewTarget(input: {
  currentMarkdown: string;
  proposedMarkdown: string;
  edits: ExactTextEdit[];
  targetId?: string;
  groupId?: string;
}): AgentTextTarget {
  const proposed = createRichMarkdownYDoc(input.proposedMarkdown);
  try {
    const validation = validateRichMarkdownYDoc(proposed);
    if (!validation.valid || validation.markdown !== input.proposedMarkdown) {
      throw new Error(`Rich collaboration review patch failed ${validation.code || 'roundtrip'} validation.`);
    }
  } finally {
    proposed.destroy();
  }
  return {
    kind: 'rich_markdown_patch',
    targetId: input.targetId || randomUUID(),
    groupId: input.groupId || 'markdown_patch',
    startAnchor: '',
    endAnchor: '',
    baseTargetHash: hash(input.currentMarkdown),
    // Structural reviews persist the bounded exact patch, not a second full
    // document snapshot. `proposedMarkdown` is used only for schema/roundtrip
    // validation before the operation is stored.
    replacement: '',
    patchEdits: input.edits.map((edit) => ({
      oldText: edit.oldText,
      newText: edit.newText,
      expectedOccurrences: edit.expectedOccurrences,
      replaceAll: edit.replaceAll,
    })),
    boundaryPolicy: 'exclude_external',
  };
}

function isRichMarkdownPatchTarget(target: AgentTextTarget): boolean {
  return target.kind === 'rich_markdown_patch';
}

function richPatchConflict(
  target: AgentTextTarget,
  code: AgentApplyConflict['code'],
): AgentApplyExecutionResult {
  return {
    status: 'needs_review',
    appliedTargetIds: [],
    conflicts: [{ targetId: target.targetId, groupId: target.groupId, code }],
    stateVector: '',
    reverseTargets: [],
  };
}

function replaceRichMarkdownDocument(
  doc: YTypes.Doc,
  markdown: string,
  origin: { actorType: 'agent'; actorId: string; initiatedByUserId: string; operationId: string },
): AgentApplyConflict['code'] | null {
  const fresh = createRichMarkdownYDoc(markdown);
  try {
    const validation = validateRichMarkdownYDoc(fresh);
    if (!validation.valid || validation.markdown !== markdown) {
      return validation.code || 'roundtrip_unstable';
    }
    replaceRichMarkdownInYDoc(doc, markdown, origin);
    return null;
  } finally {
    fresh.destroy();
  }
}

function applyRichMarkdownPatchTargets(input: {
  doc: YTypes.Doc;
  targets: AgentTextTarget[];
  origin: { actorType: 'agent'; actorId: string; initiatedByUserId: string; operationId: string };
}): AgentApplyExecutionResult {
  const target = input.targets.length === 1 ? input.targets[0] : null;
  if (!target || !isRichMarkdownPatchTarget(target)) {
    const fallback = input.targets[0];
    return fallback
      ? richPatchConflict(fallback, 'schema_invalid')
      : {
          status: 'needs_review',
          appliedTargetIds: [],
          conflicts: [],
          stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
          reverseTargets: [],
        };
  }

  const currentMarkdown = richMarkdownFromYDoc(input.doc);
  let nextMarkdown: string;
  try {
    nextMarkdown = target.patchEdits?.length
      ? applyExactTextEdits(currentMarkdown, target.patchEdits, 'collaborative Markdown review')
      : hash(currentMarkdown) === target.baseTargetHash
        ? target.replacement
        : (() => { throw new Error('The reviewed Markdown changed after the proposal was created.'); })();
  } catch {
    const result = richPatchConflict(target, 'target_changed');
    return {
      ...result,
      stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
    };
  }

  const validationDoc = createRichMarkdownYDoc(nextMarkdown);
  try {
    const validation = validateRichMarkdownYDoc(validationDoc);
    if (!validation.valid || validation.markdown !== nextMarkdown) {
      const result = richPatchConflict(target, validation.code || 'roundtrip_unstable');
      return {
        ...result,
        stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
      };
    }
  } finally {
    validationDoc.destroy();
  }

  const replaceConflict = replaceRichMarkdownDocument(input.doc, nextMarkdown, input.origin);
  if (replaceConflict) {
    const result = richPatchConflict(target, replaceConflict);
    return {
      ...result,
      stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
    };
  }
  return {
    status: 'applied_to_ydoc',
    appliedTargetIds: [target.targetId],
    conflicts: [],
    stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
    reverseTargets: [{
      kind: 'rich_markdown_patch',
      targetId: `revert:${target.targetId}`,
      groupId: target.groupId,
      startAnchor: '',
      endAnchor: '',
      baseTargetHash: hash(nextMarkdown),
      replacement: currentMarkdown,
      boundaryPolicy: target.boundaryPolicy,
    }],
  };
}

function targetOverlapsComposition(target: ResolvedTarget, ranges: ActiveCompositionRange[]): boolean {
  return ranges.some((range) => {
    const nestedRichText = Boolean(target.text.parent);
    if ((range.textName === 'body') !== nestedRichText) return false;
    // ProseMirror positions cannot be compared directly with nested Y.XmlText
    // offsets. Conservatively defer all rich agent groups while composition is
    // active; this is short-lived and prevents corrupting an IME transaction.
    if (nestedRichText) return true;
    if (target.from === target.to) return range.from <= target.from && target.from <= range.to;
    return target.from < range.to && range.from < target.to;
  });
}

function preflight(
  doc: YTypes.Doc,
  targets: AgentTextTarget[],
  independentGroups: boolean,
  compositionRanges: ActiveCompositionRange[] = [],
) {
  materializeCollaborationTypes(doc);
  const conflicts: AgentApplyConflict[] = [];
  const resolved: ResolvedTarget[] = [];
  for (const target of targets) {
    if (
      target.boundaryPolicy !== 'exclude_external'
      || Buffer.byteLength(target.replacement, 'utf8') > MAX_AGENT_REPLACEMENT_BYTES
      || hasUnpairedSurrogate(target.replacement)
    ) {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'limit_exceeded' });
      continue;
    }
    const start = decodePosition(target.startAnchor);
    const end = decodePosition(target.endAnchor);
    const absoluteStart = start ? Y.createAbsolutePositionFromRelativePosition(start, doc) : null;
    const absoluteEnd = end ? Y.createAbsolutePositionFromRelativePosition(end, doc) : null;
    if (
      !absoluteStart
      || !absoluteEnd
      || absoluteStart.type !== absoluteEnd.type
      || !(absoluteStart.type instanceof Y.Text)
      || absoluteEnd.index < absoluteStart.index
    ) {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'anchor_invalid' });
      continue;
    }
    const text = absoluteStart.type as YTypes.Text;
    const source = textValue(text);
    const boundaries = graphemeBoundaries(source);
    if (!boundaries.has(absoluteStart.index) || !boundaries.has(absoluteEnd.index)) {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'unicode_boundary' });
      continue;
    }
    const resolvedTarget: ResolvedTarget = {
      ...target,
      from: absoluteStart.index,
      to: absoluteEnd.index,
      currentText: source.slice(absoluteStart.index, absoluteEnd.index),
      text,
    };
    if (targetOverlapsComposition(resolvedTarget, compositionRanges)) {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'ime_composition' });
      continue;
    }
    if (hash(resolvedTarget.currentText) !== target.baseTargetHash) {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'target_changed' });
      continue;
    }
    resolved.push(resolvedTarget);
  }
  for (let leftIndex = 0; leftIndex < resolved.length; leftIndex += 1) {
    const left = resolved[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < resolved.length; rightIndex += 1) {
      const right = resolved[rightIndex];
      if (left.text !== right.text) continue;
      const overlaps = left.from < right.to && right.from < left.to;
      const sameInsertionPoint = left.from === left.to && right.from === right.to && left.from === right.from;
      if (!overlaps && !sameInsertionPoint) continue;
      conflicts.push({ targetId: left.targetId, groupId: left.groupId, code: 'overlap' });
      conflicts.push({ targetId: right.targetId, groupId: right.groupId, code: 'overlap' });
    }
  }
  const blockedGroups = new Set(conflicts.map((conflict) => conflict.groupId));
  if (!independentGroups && conflicts.length > 0) for (const target of targets) blockedGroups.add(target.groupId);
  return { conflicts, resolved: resolved.filter((target) => !blockedGroups.has(target.groupId)) };
}

function activeCompositionRanges(doc: YTypes.Doc): ActiveCompositionRange[] {
  const awareness = (doc as YTypes.Doc & {
    awareness?: { getStates: () => Map<number, Record<string, unknown>> };
  }).awareness;
  if (!awareness) return [];
  const ranges: ActiveCompositionRange[] = [];
  for (const state of awareness.getStates().values()) {
    const canvas = state.canvas as { composition?: Partial<ActiveCompositionRange> | null } | undefined;
    const composition = canvas?.composition;
    if (
      composition
      && typeof composition.textName === 'string'
      && Number.isInteger(composition.from)
      && Number.isInteger(composition.to)
      && Number(composition.from) >= 0
      && Number(composition.to) >= Number(composition.from)
    ) {
      ranges.push({ textName: composition.textName, from: Number(composition.from), to: Number(composition.to) });
    }
  }
  return ranges;
}

/** Applies complete target groups once, after clone validation and an authoritative preflight. */
export function applyAgentTextTargets(input: {
  doc: YTypes.Doc;
  targets: AgentTextTarget[];
  independentGroups?: boolean;
  compositionRanges?: ActiveCompositionRange[];
  validateClone?: (doc: YTypes.Doc) => AgentApplyConflict['code'] | null;
  origin: { actorType: 'agent'; actorId: string; initiatedByUserId: string; operationId: string };
}): AgentApplyExecutionResult {
  const groupCount = new Set(input.targets.map((target) => target.groupId)).size;
  if (input.targets.length === 0 || input.targets.length > MAX_AGENT_TARGETS) throw new Error(`Agent operation requires 1-${MAX_AGENT_TARGETS} targets.`);
  if (groupCount > MAX_AGENT_GROUPS) throw new Error(`Agent operation supports at most ${MAX_AGENT_GROUPS} groups.`);
  if (input.targets.some(isRichMarkdownPatchTarget)) {
    throw new Error('Structural Markdown review patches must use the rich collaboration review path.');
  }
  const independentGroups = Boolean(input.independentGroups);
  const clone = new Y.Doc({ gc: true });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(input.doc));
  const clonePreflight = preflight(clone, input.targets, independentGroups, input.compositionRanges);
  if (clonePreflight.resolved.length > 0) {
    clone.transact(() => {
      for (const target of [...clonePreflight.resolved].sort((a, b) => b.from - a.from)) {
        target.text.delete(target.from, target.to - target.from);
        if (target.replacement) target.text.insert(target.from, target.replacement, target.replacementAttributes);
      }
    }, input.origin);
  }
  const uniqueCloneTexts = [...new Set(clonePreflight.resolved.map((target) => target.text))];
  const invalidText = uniqueCloneTexts.some((text) => {
    const value = textValue(text);
    return Buffer.byteLength(value, 'utf8') > MAX_COLLABORATIVE_TEXT_BYTES || hasUnpairedSurrogate(value);
  });
  const cloneValidationCode = invalidText ? 'limit_exceeded' : input.validateClone?.(clone) || null;
  if (cloneValidationCode) {
    clone.destroy();
    return {
      status: 'needs_review',
      appliedTargetIds: [],
      conflicts: input.targets.map((target) => ({ targetId: target.targetId, groupId: target.groupId, code: cloneValidationCode })),
      stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
      reverseTargets: [],
    };
  }
  clone.destroy();

  const final = preflight(
    input.doc,
    input.targets,
    independentGroups,
    input.compositionRanges || activeCompositionRanges(input.doc),
  );
  const reverseTargets: AgentTextTarget[] = [];
  if (final.resolved.length > 0) {
    input.doc.transact(() => {
      for (const target of [...final.resolved].sort((a, b) => b.from - a.from)) {
        target.text.delete(target.from, target.to - target.from);
        if (target.replacement) target.text.insert(target.from, target.replacement, target.replacementAttributes);
        reverseTargets.push(createAgentTextTarget({
          text: target.text,
          from: target.from,
          to: target.from + target.replacement.length,
          replacement: target.currentText,
          targetId: `revert:${target.targetId}`,
          groupId: target.groupId,
          boundaryPolicy: target.boundaryPolicy,
        }));
      }
    }, input.origin);
  }
  const appliedTargetIds = final.resolved.map((target) => target.targetId);
  return {
    status: appliedTargetIds.length === 0 ? 'needs_review' : final.conflicts.length > 0 ? 'partially_applied' : 'applied_to_ydoc',
    appliedTargetIds,
    conflicts: final.conflicts,
    stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
    reverseTargets,
  };
}

const applyQueues = new Map<string, Promise<void>>();
const applyQueueDepth = new Map<string, number>();
const cancelRequests = new Set<string>();
const recentAgentChangeWindows = new Map<string, Map<string, {
  targets: AgentTextTarget[];
  appliedAt: number;
  appliedDocumentSequence: number | null;
  conflicts: AgentApplyConflict[];
}>>();

function registerAgentChangeWindow(
  documentId: string,
  operationId: string,
  targets: AgentTextTarget[],
  appliedDocumentSequence: number | null = null,
): void {
  const now = Date.now();
  const windows = recentAgentChangeWindows.get(documentId) ?? new Map();
  recentAgentChangeWindows.set(documentId, windows);
  for (const [id, window] of windows) {
    if (now - window.appliedAt > SEMANTIC_CHANGE_WINDOW_MS) windows.delete(id);
  }
  windows.set(operationId, { targets, appliedAt: now, appliedDocumentSequence, conflicts: [] });
}

function setAgentChangeWindowSequence(documentId: string, operationId: string, sequence: number): void {
  const window = recentAgentChangeWindows.get(documentId)?.get(operationId);
  if (window) window.appliedDocumentSequence = sequence;
}

async function serialized<T>(
  documentId: string,
  action: (queue: { depth: number; waitMs: number }) => Promise<T>,
): Promise<T> {
  const depth = (applyQueueDepth.get(documentId) || 0) + 1;
  if (depth > MAX_PENDING_AGENT_APPLIES_PER_DOCUMENT) {
    throw new Error(`Collaboration agent queue reached its ${MAX_PENDING_AGENT_APPLIES_PER_DOCUMENT}-operation backpressure limit.`);
  }
  applyQueueDepth.set(documentId, depth);
  const queuedAt = Date.now();
  const previous = applyQueues.get(documentId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const ready = previous.catch(() => undefined);
  const tail = ready.then(() => current);
  applyQueues.set(documentId, tail);
  await ready;
  try {
    return await action({ depth, waitMs: Date.now() - queuedAt });
  } finally {
    release();
    if (applyQueues.get(documentId) === tail) applyQueues.delete(documentId);
    const remaining = (applyQueueDepth.get(documentId) || 1) - 1;
    if (remaining > 0) applyQueueDepth.set(documentId, remaining);
    else applyQueueDepth.delete(documentId);
  }
}

function changes(value: unknown): number {
  return Number((value as { changes?: number } | undefined)?.changes || 0);
}

function parseResult(row: AgentOperationRow): PersistedAgentApplyResult {
  if (row.result_json) {
    const parsed = JSON.parse(row.result_json) as Partial<PersistedAgentApplyResult>;
    return {
      status: parsed.status || (row.status === 'semantic_conflict' ? 'semantic_conflict' : row.status === 'partially_applied' ? 'partially_applied' : row.status === 'needs_review' ? 'needs_review' : 'applied_to_ydoc'),
      appliedTargetIds: parsed.appliedTargetIds || [],
      conflicts: parsed.conflicts || [],
      stateVector: parsed.stateVector || Buffer.from(row.base_state_vector).toString('base64'),
      operationId: row.operation_id,
      durability: parsed.durability || (row.status === 'checkpointed_file' || row.status === 'partially_applied' || row.status === 'reverted' ? 'checkpointed_file' : row.status === 'needs_review' ? 'needs_review' : 'pending'),
      operationStatus: row.status,
      casVersion: Number(row.cas_version),
    };
  }
  return {
    status: row.status === 'semantic_conflict' ? 'semantic_conflict' : row.status === 'partially_applied' ? 'partially_applied' : row.status === 'needs_review' ? 'needs_review' : 'applied_to_ydoc',
    appliedTargetIds: [],
    conflicts: [],
    stateVector: Buffer.from(row.base_state_vector).toString('base64'),
    operationId: row.operation_id,
    durability: row.status === 'needs_review' ? 'needs_review' : 'pending',
    operationStatus: row.status,
    casVersion: Number(row.cas_version),
  };
}

async function readOperation(database: SqlConnection, operationId: string): Promise<AgentOperationRow | null> {
  return (await database.get(
    `SELECT operation.*, COALESCE(initiator.name, initiator.email, initiator.id) AS initiated_by_display_name
     FROM collaboration_agent_operations operation
     LEFT JOIN "user" initiator ON initiator.id = operation.initiated_by_user_id
     WHERE operation.operation_id = ? LIMIT 1`,
    [operationId],
  ) as AgentOperationRow | undefined) || null;
}

async function transitionOperation(input: {
  database: SqlConnection;
  row: AgentOperationRow;
  expectedStatuses: AgentOperationStatus[];
  status: AgentOperationStatus;
  fields?: Record<string, unknown>;
}): Promise<AgentOperationRow> {
  const fields = { ...(input.fields || {}), status: input.status, updated_at: Date.now() };
  const assignments = Object.keys(fields).map((field) => `${field} = ?`).join(', ');
  const statusPlaceholders = input.expectedStatuses.map(() => '?').join(', ');
  const params = [
    ...Object.values(fields),
    input.row.operation_id,
    input.row.cas_version,
    input.row.run_generation,
    ...input.expectedStatuses,
  ];
  const result = await input.database.run(
    `UPDATE collaboration_agent_operations
     SET ${assignments}, cas_version = cas_version + 1
     WHERE operation_id = ? AND cas_version = ? AND run_generation = ? AND status IN (${statusPlaceholders})`,
    params,
  );
  if (changes(result) !== 1) throw new Error('Agent operation state changed concurrently; reload its current status.');
  const updated = await readOperation(input.database, input.row.operation_id);
  if (!updated) throw new Error('Agent operation disappeared after its state transition.');
  return updated;
}

function operationPayloadHash(input: {
  targets: AgentTextTarget[];
  independentGroups: boolean;
  runGeneration: number;
  operationType: 'apply' | 'revert';
  expectedCanonicalHash?: string | null;
  documentPath?: string;
  documentRepresentation?: 'plain_text' | 'tiptap_xml';
  documentLifecycleGeneration?: number;
  documentSchemaVersion?: number;
  baseStateVector?: string;
  baseDocumentSequence?: number;
}): string {
  const authoritativeBase = input.documentPath
    || input.documentRepresentation
    || input.documentLifecycleGeneration !== undefined
    || input.documentSchemaVersion !== undefined
    || input.baseStateVector
    || input.baseDocumentSequence !== undefined
    ? {
        documentPath: input.documentPath || null,
        documentRepresentation: input.documentRepresentation || null,
        documentLifecycleGeneration: input.documentLifecycleGeneration ?? null,
        documentSchemaVersion: input.documentSchemaVersion ?? null,
        baseStateVector: input.baseStateVector || null,
        baseDocumentSequence: input.baseDocumentSequence ?? null,
      }
    : {};
  return hash(JSON.stringify({
    targets: input.targets,
    independentGroups: input.independentGroups,
    runGeneration: input.runGeneration,
    operationType: input.operationType,
    expectedCanonicalHash: input.expectedCanonicalHash || null,
    ...authoritativeBase,
  }));
}

async function createOrLoadOperation(input: {
  database: SqlConnection;
  documentId: string;
  workspace: WorkspaceContext;
  initiatedByUserId: string;
  actorId: string;
  idempotencyKey: string;
  runGeneration: number;
  targets: AgentTextTarget[];
  independentGroups: boolean;
  requestedMode: 'direct_apply' | 'review';
  operationType: 'apply' | 'revert';
  agentRunId?: string;
  actorSessionId?: string;
  supersedesOperationId?: string;
  correlationId?: string;
  causationId?: string;
  triggerDepth?: number;
  expectedCanonicalHash?: string | null;
  documentPath?: string;
  documentRepresentation?: 'plain_text' | 'tiptap_xml';
  documentLifecycleGeneration?: number;
  documentSchemaVersion?: number;
  baseStateVector?: string;
  baseDocumentSequence?: number;
}): Promise<{ row: AgentOperationRow; created: boolean }> {
  const triggerDepth = input.triggerDepth || 0;
  if (!Number.isInteger(triggerDepth) || triggerDepth < 0 || triggerDepth > MAX_AGENT_TRIGGER_DEPTH) {
    throw new Error(`Collaboration agent trigger depth exceeds the ${MAX_AGENT_TRIGGER_DEPTH}-hop feedback-loop limit.`);
  }
  if (input.expectedCanonicalHash && !/^[a-f0-9]{64}$/u.test(input.expectedCanonicalHash)) {
    throw new Error('Collaboration agent expected canonical hash is invalid.');
  }
  if (input.baseStateVector) {
    try {
      Y.decodeStateVector(Buffer.from(input.baseStateVector, 'base64'));
    } catch {
      throw new Error('Collaboration agent base state vector is invalid.');
    }
  }
  const payloadHash = operationPayloadHash(input);
  const existing = await input.database.get(
    'SELECT * FROM collaboration_agent_operations WHERE document_id = ? AND initiated_by_user_id = ? AND idempotency_key = ? LIMIT 1',
    [input.documentId, input.initiatedByUserId, input.idempotencyKey],
  ) as AgentOperationRow | undefined;
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new Error('Idempotency key was already used with a different agent payload.');
    return { row: existing, created: false };
  }
  if (input.correlationId && triggerDepth > 0) {
    const chainDuplicate = await input.database.get(
      `SELECT * FROM collaboration_agent_operations
       WHERE document_id = ? AND initiated_by_user_id = ? AND correlation_id = ?
         AND payload_hash = ? AND operation_type = ?
       ORDER BY created_at ASC LIMIT 1`,
      [input.documentId, input.initiatedByUserId, input.correlationId, payloadHash, input.operationType],
    ) as AgentOperationRow | undefined;
    if (chainDuplicate) return { row: chainDuplicate, created: false };
  }
  const state = await loadCollaborationState(input.documentId);
  if (
    !state
    || state.workspaceId !== input.workspace.workspaceId
    || state.status !== 'active'
    || (input.documentPath && state.path !== input.documentPath)
    || (input.documentRepresentation && state.representation !== input.documentRepresentation)
  ) {
    throw new Error('Collaboration document is unavailable or stale.');
  }
  const now = Date.now();
  const operationId = randomUUID();
  await input.database.run(
    `INSERT INTO collaboration_agent_operations (
      operation_id, document_id, document_path, document_representation, workspace_id,
      organization_id, document_lifecycle_generation,
      schema_version, initiated_by_user_id, actor_id, agent_run_id, actor_session_id,
      supersedes_operation_id, idempotency_key, run_generation, payload_hash, operation_type,
      requested_mode, atomicity, operation_payload, status, base_state_vector,
      base_document_sequence, result_json, cas_version, expires_at, correlation_id,
      causation_id, trigger_depth, expected_canonical_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?)`,
    [
      operationId,
      input.documentId,
      input.documentPath || null,
      input.documentRepresentation || null,
      input.workspace.workspaceId,
      state.organizationId,
      input.documentLifecycleGeneration ?? state.lifecycleGeneration,
      input.documentSchemaVersion ?? state.schemaVersion,
      input.initiatedByUserId,
      input.actorId,
      input.agentRunId || null,
      input.actorSessionId || null,
      input.supersedesOperationId || null,
      input.idempotencyKey,
      input.runGeneration,
      payloadHash,
      input.operationType,
      input.requestedMode,
      input.independentGroups ? 'independent' : 'all_or_nothing',
      sealPayload(input.targets),
      input.baseStateVector ? Buffer.from(input.baseStateVector, 'base64') : Buffer.from(state.stateVector),
      input.baseDocumentSequence ?? state.documentSequence,
      now + AGENT_OPERATION_TTL_MS,
      input.correlationId || operationId,
      input.causationId || null,
      input.triggerDepth || 0,
      input.expectedCanonicalHash || null,
      now,
      now,
    ],
  );
  const row = await readOperation(input.database, operationId);
  if (!row) throw new Error('Failed to create collaboration agent operation.');
  return { row, created: true };
}

function publicResult(row: AgentOperationRow, result: AgentApplyResult, durability: PersistedAgentApplyResult['durability']): PersistedAgentApplyResult {
  return {
    ...result,
    operationId: row.operation_id,
    durability,
    operationStatus: row.status,
    casVersion: Number(row.cas_version),
  };
}

async function waitForDurableState(input: {
  documentId: string;
  expectedStateVector: string;
  workspace: WorkspaceContext;
  documentPath: string | null;
}) {
  const deadline = Date.now() + PERSISTENCE_CONFIRMATION_TIMEOUT_MS;
  let diagnostics: Record<string, unknown> = { stateAvailable: false };
  do {
    const state = await loadCollaborationState(input.documentId);
    diagnostics = state
      ? {
          stateAvailable: true,
          degraded: state.degraded,
          stateVectorIncludesExpected: stateVectorIncludes(state.stateVector, input.expectedStateVector),
          documentSequence: state.documentSequence,
          checkpointSequence: state.checkpointSequence,
          projectionRequired: Boolean(input.documentPath),
        }
      : { stateAvailable: false };
    if (
      state
      && !state.degraded
      && stateVectorIncludes(state.stateVector, input.expectedStateVector)
      && state.checkpointSequence >= state.documentSequence
    ) {
      let checkpointRevisionId: string | null = null;
      if (input.documentPath) {
        const projection = getFileCollaborationState({
          workspace: input.workspace,
          path: input.documentPath,
          ensureDocument: false,
        });
        if (
          !projection.document
          || projection.document.id !== input.documentId
          || projection.document.stateVersion !== state.checkpointSequence
          || !projection.document.snapshotRevisionId
          || projection.latestRevision?.id !== projection.document.snapshotRevisionId
        ) {
          diagnostics = {
            ...diagnostics,
            projectionDocumentId: projection.document?.id || null,
            projectionStateVersion: projection.document?.stateVersion ?? null,
            projectionSnapshotRevisionId: projection.document?.snapshotRevisionId || null,
            projectionLatestRevisionId: projection.latestRevision?.id || null,
          };
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        checkpointRevisionId = projection.document.snapshotRevisionId;
      }
      return { state, checkpointRevisionId };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(
    `Agent update was not confirmed as a persisted Yjs state and file checkpoint in time (${JSON.stringify(diagnostics)}).`,
  );
}

function validateOperationClone(
  representation: 'plain_text' | 'tiptap_xml',
  expectedCanonicalHash: string | null,
  doc: YTypes.Doc,
): AgentApplyConflict['code'] | null {
  if (representation === 'plain_text') {
    const content = textValue(doc.getText('content'));
    if (Buffer.byteLength(content, 'utf8') > MAX_COLLABORATIVE_TEXT_BYTES || hasUnpairedSurrogate(content)) {
      return 'limit_exceeded';
    }
    return expectedCanonicalHash && hash(content) !== expectedCanonicalHash ? 'target_scope_invalid' : null;
  }

  const validation = validateRichMarkdownYDoc(doc);
  if (!validation.valid) return validation.code || 'schema_invalid';
  const markdown = validation.markdown || '';
  if (Buffer.byteLength(markdown, 'utf8') > MAX_COLLABORATIVE_TEXT_BYTES || hasUnpairedSurrogate(markdown)) {
    return 'limit_exceeded';
  }
  return expectedCanonicalHash && hash(markdown) !== expectedCanonicalHash ? 'target_scope_invalid' : null;
}

async function applyStoredOperation(input: {
  database: SqlConnection;
  row: AgentOperationRow;
  workspace: WorkspaceContext;
  actorDisplayName: string;
  allowReviewApply?: boolean;
}): Promise<PersistedAgentApplyResult> {
  let row = input.row;
  if (row.result_json && !['needs_review', 'partially_applied'].includes(row.status)) return parseResult(row);
  if (row.expires_at && Number(row.expires_at) <= Date.now()) {
    row = await transitionOperation({
      database: input.database,
      row,
      expectedStatuses: ['preparing', 'ready', 'needs_review', 'cancel_requested'],
      status: 'expired',
      fields: { error_code: 'operation_expired' },
    });
    return parseResult(row);
  }
  if (!input.workspace.permissions.canWrite || input.workspace.workspaceId !== row.workspace_id) {
    throw new Error('Current workspace write permission is required.');
  }
  const state = await loadCollaborationState(row.document_id);
  if (
    !state
    || state.status !== 'active'
    || state.workspaceId !== row.workspace_id
    || state.lifecycleGeneration !== Number(row.document_lifecycle_generation)
    || state.schemaVersion !== Number(row.schema_version)
    || (row.document_path !== null && state.path !== row.document_path)
    || (row.document_representation !== null && state.representation !== row.document_representation)
  ) {
    const targets = openPayload<AgentTextTarget[]>(row.operation_payload) || [];
    const terminal = publicResult(row, {
      status: 'needs_review',
      appliedTargetIds: [],
      conflicts: targets.map((target) => ({ targetId: target.targetId, groupId: target.groupId, code: 'lifecycle_stale' })),
      stateVector: state ? Buffer.from(state.stateVector).toString('base64') : Buffer.from(row.base_state_vector).toString('base64'),
    }, 'needs_review');
    row = await transitionOperation({
      database: input.database,
      row,
      expectedStatuses: [row.status],
      status: 'needs_review',
      fields: { result_json: JSON.stringify(terminal), error_code: 'lifecycle_stale' },
    });
    return { ...terminal, operationStatus: row.status, casVersion: Number(row.cas_version) };
  }
  if (state.degraded) {
    const targets = openPayload<AgentTextTarget[]>(row.operation_payload) || [];
    const terminal = publicResult(row, {
      status: 'needs_review',
      appliedTargetIds: [],
      conflicts: targets.map((target) => ({ targetId: target.targetId, groupId: target.groupId, code: 'persistence_degraded' })),
      stateVector: Buffer.from(state.stateVector).toString('base64'),
    }, 'needs_review');
    row = await transitionOperation({
      database: input.database,
      row,
      expectedStatuses: [row.status],
      status: 'needs_review',
      fields: { result_json: JSON.stringify(terminal), error_code: 'persistence_degraded' },
    });
    return { ...terminal, operationStatus: row.status, casVersion: Number(row.cas_version) };
  }
  if ((row.status === 'needs_review' || row.status === 'partially_applied') && !input.allowReviewApply) return parseResult(row);

  const allTargets = openPayload<AgentTextTarget[]>(row.operation_payload) || [];
  const priorResult = parseResult(row);
  const alreadyApplied = new Set(priorResult.appliedTargetIds);
  const targets = allTargets.filter((target) => !alreadyApplied.has(target.targetId));
  if (targets.length === 0) return priorResult;
  row = await transitionOperation({
    database: input.database,
    row,
    expectedStatuses: ['preparing', 'ready', 'needs_review', 'partially_applied'],
    status: 'applying',
    fields: { error_code: null },
  });

  const initiator = await input.database.get(
    'SELECT name, email FROM "user" WHERE id = ? LIMIT 1',
    [row.initiated_by_user_id],
  ) as { name?: string | null; email?: string | null } | undefined;
  const initiatorName = initiator?.name?.trim() || initiator?.email?.trim() || row.initiated_by_user_id;
  upsertDocumentPresenceEntry({
    workspaceId: state.workspaceId,
    documentId: state.documentId,
    path: state.path,
    userId: row.actor_id,
    sessionId: row.operation_id,
    actorType: 'agent',
    initiatedByUserId: row.initiated_by_user_id,
    displayName: `${input.actorDisplayName} on behalf of ${initiatorName}`,
    color: '#7c3aed',
    colorLight: '#ede9fe',
    activity: 'agent_editing',
    updatedAt: Date.now(),
  });

  let execution: AgentApplyExecutionResult;
  const appliedExecution = { value: null as AgentApplyExecutionResult | null };
  const combinedFor = (result: AgentApplyExecutionResult) => {
    const changeWindow = recentAgentChangeWindows.get(row.document_id)?.get(row.operation_id);
    const immediateSemanticConflicts = changeWindow?.conflicts || [];
    const combinedApplied = [...new Set([...priorResult.appliedTargetIds, ...result.appliedTargetIds])];
    const combinedReverse = [
      ...(openPayload<AgentTextTarget[]>(row.reverse_payload) || []),
      ...result.reverseTargets,
    ];
    const baseResult: AgentApplyResult = {
      status: immediateSemanticConflicts.length > 0 ? 'semantic_conflict' : result.status,
      appliedTargetIds: combinedApplied,
      conflicts: immediateSemanticConflicts.length > 0 ? immediateSemanticConflicts : result.conflicts,
      stateVector: result.stateVector,
    };
    return { immediateSemanticConflicts, combinedApplied, combinedReverse, baseResult };
  };
  try {
    execution = await runCollaborationDirectConnection({
      documentId: row.document_id,
      documentPath: row.document_path || state.path,
      documentRepresentation: row.document_representation || state.representation,
      documentLifecycleGeneration: Number(row.document_lifecycle_generation),
      documentSchemaVersion: Number(row.schema_version),
      requiresFileCheckpointIdentity: row.document_path !== null,
      workspace: input.workspace,
      actorId: row.actor_id,
      actorDisplayName: input.actorDisplayName,
      initiatedByUserId: row.initiated_by_user_id,
      operationId: row.operation_id,
      actorSessionId: row.actor_session_id || undefined,
    }, (doc) => {
      if (cancelRequests.has(row.operation_id)) throw new AgentOperationCancelledError('Agent operation was cancelled before apply.');
      const currentStateVector = Y.encodeStateVector(doc);
      const baseStateVector = Buffer.from(row.base_state_vector).toString('base64');
      if (!stateVectorIncludes(currentStateVector, baseStateVector)) {
        return {
          status: 'needs_review',
          appliedTargetIds: [],
          conflicts: targets.map((target) => ({
            targetId: target.targetId,
            groupId: target.groupId,
            code: 'lifecycle_stale' as const,
          })),
          stateVector: Buffer.from(currentStateVector).toString('base64'),
          reverseTargets: [],
        };
      }
      const origin = {
        actorType: 'agent' as const,
        actorId: row.actor_id,
        initiatedByUserId: row.initiated_by_user_id,
        operationId: row.operation_id,
      };
      const structuralPatch = targets.some(isRichMarkdownPatchTarget);
      const result = structuralPatch
        ? state.representation === 'tiptap_xml' && targets.every(isRichMarkdownPatchTarget)
          ? applyRichMarkdownPatchTargets({ doc, targets, origin })
          : {
              status: 'needs_review' as const,
              appliedTargetIds: [],
              conflicts: targets.map((target) => ({
                targetId: target.targetId,
                groupId: target.groupId,
                code: 'schema_invalid' as const,
              })),
              stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
              reverseTargets: [],
            }
        : applyAgentTextTargets({
            doc,
            targets,
            independentGroups: row.atomicity === 'independent',
            validateClone: (clone) => validateOperationClone(
              state.representation,
              row.expected_canonical_hash,
              clone,
            ),
            origin,
          });
      if (result.reverseTargets.length > 0) {
        registerAgentChangeWindow(row.document_id, row.operation_id, result.reverseTargets);
      }
      return result;
    }, async (result) => {
      appliedExecution.value = result;
      if (result.appliedTargetIds.length === 0) return;
      const combined = combinedFor(result);
      const appliedResult = publicResult(row, combined.baseResult, 'applied_to_ydoc');
      row = await transitionOperation({
        database: input.database,
        row,
        expectedStatuses: ['applying'],
        status: 'applied_to_ydoc',
        fields: {
          result_json: JSON.stringify(appliedResult),
          reverse_payload: sealPayload(combined.combinedReverse),
          resulting_state_vector_hash: stateVectorHash(result.stateVector),
          applied_at: Date.now(),
        },
      });
    });
  } catch (error) {
    const fresh = await readOperation(input.database, row.operation_id) || row;
    const authoritativeApplyStarted = Boolean(appliedExecution.value?.appliedTargetIds.length)
      || fresh.status === 'applied_to_ydoc'
      || fresh.status === 'persisted_yjs';
    if (
      !authoritativeApplyStarted
      && (error instanceof AgentOperationCancelledError || cancelRequests.has(row.operation_id) || fresh.status === 'cancel_requested')
    ) {
      const cancelledResult = publicResult(fresh, {
        status: 'needs_review',
        appliedTargetIds: priorResult.appliedTargetIds,
        conflicts: targets.map((target) => ({ targetId: target.targetId, groupId: target.groupId, code: 'cancelled' })),
        stateVector: Buffer.from(state.stateVector).toString('base64'),
      }, priorResult.appliedTargetIds.length > 0 ? priorResult.durability : 'pending');
      const cancelled = await transitionOperation({
        database: input.database,
        row: fresh,
        expectedStatuses: ['applying', 'cancel_requested'],
        status: 'cancelled',
        fields: { result_json: JSON.stringify(cancelledResult), error_code: 'cancelled' },
      });
      return { ...cancelledResult, operationStatus: cancelled.status, casVersion: Number(cancelled.cas_version) };
    }
    const combinedApplied = appliedExecution.value
      ? combinedFor(appliedExecution.value).combinedApplied
      : priorResult.appliedTargetIds;
    const conflictCode = error instanceof AgentDirectConnectionAuthorizationError
      ? 'authorization_revoked'
      : 'persistence_degraded';
    const degradedResult = publicResult(fresh, {
      status: combinedApplied.length > 0 ? 'partially_applied' : 'needs_review',
      appliedTargetIds: combinedApplied,
      conflicts: targets.map((target) => ({ targetId: target.targetId, groupId: target.groupId, code: conflictCode })),
      stateVector: appliedExecution.value?.stateVector || Buffer.from(state.stateVector).toString('base64'),
    }, combinedApplied.length > 0 ? 'applied_to_ydoc' : 'needs_review');
    const degraded = await transitionOperation({
      database: input.database,
      row: fresh,
      expectedStatuses: [fresh.status],
      status: combinedApplied.length > 0 ? 'partially_applied' : 'needs_review',
      fields: { result_json: JSON.stringify(degradedResult), error_code: conflictCode },
    });
    return { ...degradedResult, operationStatus: degraded.status, casVersion: Number(degraded.cas_version) };
  } finally {
    cancelRequests.delete(row.operation_id);
    removeDocumentPresenceEntry({
      workspaceId: state.workspaceId,
      documentId: state.documentId,
      userId: row.actor_id,
      actorType: 'agent',
    });
  }

  const { immediateSemanticConflicts, combinedApplied, baseResult } = combinedFor(execution);
  if (execution.appliedTargetIds.length === 0) {
    const reviewStatus = combinedApplied.length > 0 ? 'partially_applied' : 'needs_review';
    const reviewResult = publicResult(row, {
      ...baseResult,
      status: combinedApplied.length > 0 ? 'partially_applied' : 'needs_review',
    }, combinedApplied.length > 0 ? priorResult.durability : 'needs_review');
    const review = await transitionOperation({
      database: input.database,
      row,
      expectedStatuses: ['applying'],
      status: reviewStatus,
      fields: { result_json: JSON.stringify(reviewResult), error_code: 'target_revalidation_failed' },
    });
    return { ...reviewResult, operationStatus: review.status, casVersion: Number(review.cas_version) };
  }

  let durable: Awaited<ReturnType<typeof waitForDurableState>>;
  try {
    durable = await waitForDurableState({
      documentId: row.document_id,
      expectedStateVector: execution.stateVector,
      workspace: input.workspace,
      documentPath: row.document_path,
    });
  } catch {
    const persistenceConflicts = allTargets.map((target) => ({
      targetId: target.targetId,
      groupId: target.groupId,
      code: 'persistence_degraded' as const,
    }));
    const degradedResult = publicResult(row, {
      ...baseResult,
      status: 'partially_applied',
      conflicts: persistenceConflicts,
    }, 'applied_to_ydoc');
    row = await transitionOperation({
      database: input.database,
      row,
      expectedStatuses: ['applied_to_ydoc'],
      status: 'partially_applied',
      fields: {
        result_json: JSON.stringify(degradedResult),
        error_code: 'persistence_degraded',
      },
    });
    return { ...degradedResult, operationStatus: row.status, casVersion: Number(row.cas_version) };
  }
  const durableState = durable.state;
  const persistedResult = publicResult(row, baseResult, 'persisted_yjs');
  setAgentChangeWindowSequence(row.document_id, row.operation_id, durableState.documentSequence);
  const operationPersistedAt = Math.max(durableState.persistedAt, Number(row.applied_at || 0));
  row = await transitionOperation({
    database: input.database,
    row,
    expectedStatuses: ['applied_to_ydoc'],
    status: 'persisted_yjs',
    fields: {
      result_json: JSON.stringify(persistedResult),
      persisted_at: operationPersistedAt,
      applied_document_sequence: durableState.documentSequence,
      checkpoint_revision_id: durable.checkpointRevisionId,
    },
  });
  const terminalStatus: AgentOperationStatus = immediateSemanticConflicts.length > 0
    ? 'semantic_conflict'
    : execution.conflicts.length > 0
      ? 'partially_applied'
      : row.operation_type === 'revert'
        ? 'reverted'
        : 'checkpointed_file';
  const checkpointedResult = publicResult(row, {
    ...baseResult,
    status: immediateSemanticConflicts.length > 0
      ? 'semantic_conflict'
      : execution.conflicts.length > 0
        ? 'partially_applied'
        : 'applied_to_ydoc',
  }, 'checkpointed_file');
  const operationCheckpointedAt = Math.max(
    durableState.checkpointedAt || Date.now(),
    Number(row.persisted_at || operationPersistedAt),
  );
  row = await transitionOperation({
    database: input.database,
    row,
    expectedStatuses: ['persisted_yjs'],
    status: terminalStatus,
    fields: {
      result_json: JSON.stringify(checkpointedResult),
      checkpointed_at: operationCheckpointedAt,
      error_code: immediateSemanticConflicts.length > 0
        ? 'collaboration_semantic_conflict'
        : execution.conflicts.length > 0
          ? 'partial_review_required'
          : null,
    },
  });

  await recordAuditEvent({
    organizationId: input.workspace.organizationId,
    workspaceId: input.workspace.workspaceId,
    userId: row.initiated_by_user_id,
    source: 'agent',
    eventType: 'agent_action',
    entityType: 'collaboration_document',
    entityId: row.document_id,
    action: row.operation_type === 'revert' ? 'collaboration.agent.revert' : 'collaboration.agent.apply',
    status: execution.conflicts.length > 0 ? 'completed' : 'success',
    summary: `Agent ${row.operation_type} applied ${execution.appliedTargetIds.length} collaboration target(s).`,
    metadata: {
      operationId: row.operation_id,
      actorType: 'agent',
      actorId: row.actor_id,
      initiatedByUserId: row.initiated_by_user_id,
      resultStatus: checkpointedResult.status,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      triggerDepth: Number(row.trigger_depth),
    },
  });
  return { ...checkpointedResult, operationStatus: row.status, casVersion: Number(row.cas_version) };
}

export async function applyPersistedAgentTextOperation(input: {
  documentId: string;
  workspace: WorkspaceContext;
  initiatedByUserId: string;
  actorId: string;
  actorDisplayName: string;
  idempotencyKey: string;
  runGeneration: number;
  targets: AgentTextTarget[];
  independentGroups?: boolean;
  requestedMode?: 'direct_apply' | 'review';
  explicitUserRequest?: boolean;
  operationType?: 'apply' | 'revert';
  agentRunId?: string;
  actorSessionId?: string;
  supersedesOperationId?: string;
  correlationId?: string;
  causationId?: string;
  triggerDepth?: number;
  expectedCanonicalHash?: string | null;
  documentPath?: string;
  documentRepresentation?: 'plain_text' | 'tiptap_xml';
  documentLifecycleGeneration?: number;
  documentSchemaVersion?: number;
  baseStateVector?: string;
  baseDocumentSequence?: number;
}): Promise<PersistedAgentApplyResult> {
  if (!input.workspace.permissions.canWrite) throw new Error('Workspace write permission is required.');
  if (getDatabaseProvider() !== 'postgres') throw new Error('Agent collaboration operations require Postgres.');
  return serialized(input.documentId, async (queue) => {
    const database = await openDb();
    try {
      const requestedMode = input.requestedMode || 'direct_apply';
      const activeHuman = getWorkspacePresenceSnapshot(input.workspace.workspaceId).entries.some((entry) => (
        entry.documentId === input.documentId && entry.actorType === 'user'
      ));
      const backpressureReview = queue.waitMs >= AGENT_QUEUE_REVIEW_AFTER_MS || queue.depth > 4;
      const mustReview = requestedMode === 'review'
        || (activeHuman && !input.explicitUserRequest)
        || backpressureReview;
      const created = await createOrLoadOperation({
        database,
        documentId: input.documentId,
        workspace: input.workspace,
        initiatedByUserId: input.initiatedByUserId,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        runGeneration: input.runGeneration,
        targets: input.targets,
        independentGroups: Boolean(input.independentGroups),
        requestedMode: mustReview ? 'review' : requestedMode,
        operationType: input.operationType || 'apply',
        agentRunId: input.agentRunId,
        actorSessionId: input.actorSessionId,
        supersedesOperationId: input.supersedesOperationId,
        correlationId: input.correlationId,
        causationId: input.causationId,
        triggerDepth: input.triggerDepth,
        expectedCanonicalHash: input.expectedCanonicalHash,
        documentPath: input.documentPath,
        documentRepresentation: input.documentRepresentation,
        documentLifecycleGeneration: input.documentLifecycleGeneration,
        documentSchemaVersion: input.documentSchemaVersion,
        baseStateVector: input.baseStateVector,
        baseDocumentSequence: input.baseDocumentSequence,
      });
      if (!created.created) return parseResult(created.row);
      if (mustReview) {
        const state = await loadCollaborationState(input.documentId);
        const reviewResult = publicResult(created.row, {
          status: 'needs_review',
          appliedTargetIds: [],
          conflicts: [],
          stateVector: state ? Buffer.from(state.stateVector).toString('base64') : Buffer.from(created.row.base_state_vector).toString('base64'),
        }, 'needs_review');
        const review = await transitionOperation({
          database,
          row: created.row,
          expectedStatuses: ['preparing'],
          status: 'needs_review',
          fields: {
            result_json: JSON.stringify(reviewResult),
            error_code: activeHuman && !input.explicitUserRequest
              ? 'active_human_review_required'
              : backpressureReview
                ? 'backpressure_review_required'
                : null,
          },
        });
        return { ...reviewResult, operationStatus: review.status, casVersion: Number(review.cas_version) };
      }
      return applyStoredOperation({ database, row: created.row, workspace: input.workspace, actorDisplayName: input.actorDisplayName });
    } finally {
      await database.close();
    }
  });
}

function canManageOperation(row: AgentOperationRow, workspace: WorkspaceContext, userId: string): boolean {
  return row.workspace_id === workspace.workspaceId
    && workspace.permissions.canRead
    && (row.initiated_by_user_id === userId || workspace.permissions.canManageWorkspace);
}

function canViewOperation(row: AgentOperationRow, workspace: WorkspaceContext): boolean {
  return row.workspace_id === workspace.workspaceId && workspace.permissions.canRead;
}

function operationTargetAnchors(row: AgentOperationRow): AgentOperationView['targetAnchors'] {
  return (openPayload<AgentTextTarget[]>(row.operation_payload) || []).flatMap((target) => (
    target.startAnchor && target.endAnchor
      ? [{
          targetId: target.targetId,
          groupId: target.groupId,
          startAnchor: target.startAnchor,
          endAnchor: target.endAnchor,
        }]
      : []
  ));
}

async function reviewTargets(row: AgentOperationRow): Promise<AgentOperationView['reviewTargets']> {
  if (!['needs_review', 'partially_applied', 'semantic_conflict'].includes(row.status)) return undefined;
  const targets = openPayload<AgentTextTarget[]>(row.operation_payload) || [];
  const state = await loadCollaborationState(row.document_id);
  if (!state) return targets.flatMap((target) => (
    isRichMarkdownPatchTarget(target) && target.patchEdits?.length
      ? target.patchEdits.map((edit, index) => ({
          targetId: `${target.targetId}:${index}`,
          groupId: target.groupId,
          proposedReplacement: edit.newText,
          currentText: null,
          currentTargetHash: null,
        }))
      : [{
          targetId: target.targetId,
          groupId: target.groupId,
          proposedReplacement: target.replacement,
          currentText: null,
          currentTargetHash: null,
        }]
  ));
  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, state.yjsState);
    materializeCollaborationTypes(doc);
    const currentMarkdown = state.representation === 'tiptap_xml'
      ? richMarkdownFromYDoc(doc)
      : null;
    return targets.flatMap((target) => {
      if (isRichMarkdownPatchTarget(target)) {
        if (target.patchEdits?.length) {
          return target.patchEdits.map((edit, index) => {
            const exactStillResolves = currentMarkdown !== null && (() => {
              try {
                resolveExactTextEditMatchCount({
                  content: currentMarkdown,
                  edit,
                  label: 'live Markdown collaboration state',
                  editIndex: index,
                });
                return true;
              } catch {
                return false;
              }
            })();
            return {
              targetId: `${target.targetId}:${index}`,
              groupId: target.groupId,
              proposedReplacement: edit.newText,
              currentText: exactStillResolves ? edit.oldText : null,
              currentTargetHash: exactStillResolves ? hash(edit.oldText) : null,
            };
          });
        }
        return [{
          targetId: target.targetId,
          groupId: target.groupId,
          proposedReplacement: target.replacement,
          currentText: currentMarkdown,
          currentTargetHash: currentMarkdown === null ? null : hash(currentMarkdown),
        }];
      }
      const start = decodePosition(target.startAnchor);
      const end = decodePosition(target.endAnchor);
      const absoluteStart = start ? Y.createAbsolutePositionFromRelativePosition(start, doc) : null;
      const absoluteEnd = end ? Y.createAbsolutePositionFromRelativePosition(end, doc) : null;
      const currentText = absoluteStart
        && absoluteEnd
        && absoluteStart.type === absoluteEnd.type
        && absoluteStart.type instanceof Y.Text
        && absoluteEnd.index >= absoluteStart.index
        ? textValue(absoluteStart.type as YTypes.Text).slice(absoluteStart.index, absoluteEnd.index)
        : null;
      return [{
        targetId: target.targetId,
        groupId: target.groupId,
        proposedReplacement: target.replacement,
        currentText,
        currentTargetHash: currentText === null ? null : hash(currentText),
      }];
    });
  } finally {
    doc.destroy();
  }
}

function toOperationView(
  row: AgentOperationRow,
  review: AgentOperationView['reviewTargets'],
  currentUserId: string,
  actionsAllowed: boolean,
): AgentOperationView {
  return {
    ...parseResult(row),
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    initiatedByUserId: row.initiated_by_user_id,
    initiatedByDisplayName: row.initiated_by_display_name || row.initiated_by_user_id,
    initiatedByCurrentUser: row.initiated_by_user_id === currentUserId,
    actionsAllowed,
    actorId: row.actor_id,
    operationType: row.operation_type,
    requestedMode: row.requested_mode,
    runGeneration: Number(row.run_generation),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    reviewTargets: review,
    targetAnchors: operationTargetAnchors(row),
  };
}

export async function getAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<AgentOperationView | null> {
  if (getDatabaseProvider() !== 'postgres') return null;
  const database = await openDb();
  try {
    const row = await readOperation(database, input.operationId);
    if (!row || !canViewOperation(row, input.workspace)) return null;
    return toOperationView(
      row,
      await reviewTargets(row),
      input.userId,
      canManageOperation(row, input.workspace, input.userId),
    );
  } finally {
    await database.close();
  }
}

export async function listAgentOperations(input: {
  documentId: string;
  workspace: WorkspaceContext;
  userId: string;
  pendingOnly?: boolean;
}): Promise<AgentOperationView[]> {
  if (getDatabaseProvider() !== 'postgres' || !input.workspace.permissions.canRead) return [];
  const database = await openDb();
  try {
    const rows = await database.all(
      `SELECT operation.*, COALESCE(initiator.name, initiator.email, initiator.id) AS initiated_by_display_name
       FROM collaboration_agent_operations operation
       LEFT JOIN "user" initiator ON initiator.id = operation.initiated_by_user_id
       WHERE operation.document_id = ? AND operation.workspace_id = ?
         AND (? = 0 OR operation.status IN ('needs_review', 'partially_applied', 'semantic_conflict', 'cancel_requested'))
       ORDER BY operation.updated_at DESC LIMIT 50`,
      [
        input.documentId,
        input.workspace.workspaceId,
        input.pendingOnly ? 1 : 0,
      ],
    ) as AgentOperationRow[];
    return Promise.all(rows.map(async (row) => toOperationView(
      row,
      await reviewTargets(row),
      input.userId,
      canManageOperation(row, input.workspace, input.userId),
    )));
  } finally {
    await database.close();
  }
}

function actionWasHandled(row: AgentOperationRow, action: string, idempotencyKey: string): boolean {
  try {
    const keys = JSON.parse(row.action_keys_json || '{}') as Record<string, string>;
    return keys[action] === idempotencyKey;
  } catch {
    return false;
  }
}

async function rememberAction(database: SqlConnection, row: AgentOperationRow, action: string, idempotencyKey: string): Promise<AgentOperationRow> {
  let keys: Record<string, string> = {};
  try { keys = JSON.parse(row.action_keys_json || '{}') as Record<string, string>; } catch {}
  const existing = keys[action];
  if (existing && existing !== idempotencyKey) return row;
  keys[action] = idempotencyKey;
  const updated = await database.run(
    'UPDATE collaboration_agent_operations SET action_keys_json = ?, updated_at = ? WHERE operation_id = ? AND cas_version = ?',
    [JSON.stringify(keys), Date.now(), row.operation_id, row.cas_version],
  );
  if (changes(updated) !== 1) throw new Error('Agent operation action raced with another request; reload its status.');
  return (await readOperation(database, row.operation_id)) || row;
}

async function authorizedActionRow(database: SqlConnection, input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<AgentOperationRow> {
  const row = await readOperation(database, input.operationId);
  if (!row || !canManageOperation(row, input.workspace, input.userId)) throw new Error('Agent operation was not found.');
  if (!input.workspace.permissions.canWrite) throw new Error('Workspace write permission is required.');
  return row;
}

export async function acceptAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
  idempotencyKey: string;
  actorDisplayName?: string;
}): Promise<PersistedAgentApplyResult> {
  const lookup = await openDb();
  let documentId: string;
  try {
    const row = await authorizedActionRow(lookup, input);
    documentId = row.document_id;
  } finally {
    await lookup.close();
  }
  return serialized(documentId!, async () => {
    const database = await openDb();
    try {
      let row = await authorizedActionRow(database, input);
      if (actionWasHandled(row, 'accept', input.idempotencyKey)) return parseResult(row);
      if (!['needs_review', 'partially_applied'].includes(row.status)) return parseResult(row);
      row = await rememberAction(database, row, 'accept', input.idempotencyKey);
      return applyStoredOperation({
        database,
        row,
        workspace: input.workspace,
        actorDisplayName: input.actorDisplayName || `Agent ${row.actor_id}`,
        allowReviewApply: true,
      });
    } finally {
      await database.close();
    }
  });
}

export async function rejectAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
  idempotencyKey: string;
}): Promise<PersistedAgentApplyResult> {
  const database = await openDb();
  try {
    let row = await authorizedActionRow(database, input);
    if (actionWasHandled(row, 'reject', input.idempotencyKey)) return parseResult(row);
    if (row.status === 'rejected' || row.status === 'cancelled') return parseResult(row);
    if (!['needs_review', 'semantic_conflict'].includes(row.status)) return parseResult(row);
    row = await rememberAction(database, row, 'reject', input.idempotencyKey);
    const result = { ...parseResult(row), operationStatus: 'rejected' as const };
    row = await transitionOperation({
      database,
      row,
      expectedStatuses: ['needs_review', 'semantic_conflict'],
      status: 'rejected',
      fields: { result_json: JSON.stringify(result), error_code: null },
    });
    return { ...result, operationStatus: row.status, casVersion: Number(row.cas_version) };
  } finally {
    await database.close();
  }
}

export async function revertAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
  idempotencyKey: string;
  requestedMode?: 'direct_apply' | 'review';
}): Promise<PersistedAgentApplyResult> {
  const database = await openDb();
  let row: AgentOperationRow;
  try {
    row = await authorizedActionRow(database, input);
  } finally {
    await database.close();
  }
  const reverseTargets = openPayload<AgentTextTarget[]>(row!.reverse_payload) || [];
  if (reverseTargets.length === 0) throw new Error('This operation has no safely anchored applied changes to revert.');
  return applyPersistedAgentTextOperation({
    documentId: row!.document_id,
    workspace: input.workspace,
    initiatedByUserId: input.userId,
    actorId: row!.actor_id,
    actorDisplayName: `Agent ${row!.actor_id}`,
    idempotencyKey: `revert:${row!.operation_id}:${input.idempotencyKey}`,
    runGeneration: Number(row!.run_generation) + 1,
    targets: reverseTargets,
    independentGroups: row!.atomicity === 'independent',
    requestedMode: input.requestedMode || 'direct_apply',
    explicitUserRequest: true,
    operationType: 'revert',
    actorSessionId: row!.actor_session_id || undefined,
    supersedesOperationId: row!.operation_id,
    correlationId: row!.correlation_id || row!.operation_id,
    causationId: row!.operation_id,
    triggerDepth: Number(row!.trigger_depth) + 1,
  });
}

export async function cancelAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
  idempotencyKey: string;
}): Promise<PersistedAgentApplyResult> {
  cancelRequests.add(input.operationId);
  const database = await openDb();
  let row: AgentOperationRow;
  try {
    row = await authorizedActionRow(database, input);
    if (actionWasHandled(row, 'cancel', input.idempotencyKey)) return parseResult(row);
    row = await rememberAction(database, row, 'cancel', input.idempotencyKey);
    if (['applied_to_ydoc', 'persisted_yjs', 'checkpointed_file', 'partially_applied', 'semantic_conflict'].includes(row.status)) {
      cancelRequests.delete(input.operationId);
      return revertAgentOperation({
        operationId: row.operation_id,
        workspace: input.workspace,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        requestedMode: 'review',
      });
    }
    if (['cancelled', 'expired', 'failed', 'rejected', 'reverted'].includes(row.status)) return parseResult(row);
    const nextStatus: AgentOperationStatus = row.status === 'applying' ? 'cancel_requested' : 'cancelled';
    const result = { ...parseResult(row), operationStatus: nextStatus };
    row = await transitionOperation({
      database,
      row,
      expectedStatuses: [row.status],
      status: nextStatus,
      fields: { cancel_requested_at: Date.now(), result_json: JSON.stringify(result), error_code: 'cancelled' },
    });
    return { ...result, operationStatus: row.status, casVersion: Number(row.cas_version) };
  } finally {
    if (row! && row!.status !== 'applying' && row!.status !== 'cancel_requested') cancelRequests.delete(input.operationId);
    await database.close();
  }
}

/** Conservatively marks recently applied targets changed by a later user update. */
export async function detectLateAgentSemanticConflicts(input: {
  documentId: string;
  doc: YTypes.Doc;
  observedDocumentSequence?: number | null;
}): Promise<void> {
  if (getDatabaseProvider() !== 'postgres') return;
  const memoryWindows = recentAgentChangeWindows.get(input.documentId);
  if (!memoryWindows) return;

  const conflictedOperationIds: string[] = [];
  for (const [operationId, window] of memoryWindows) {
    if (Date.now() - window.appliedAt > SEMANTIC_CHANGE_WINDOW_MS) {
      memoryWindows.delete(operationId);
      continue;
    }
    if (
      input.observedDocumentSequence !== null
      && input.observedDocumentSequence !== undefined
      && window.appliedDocumentSequence !== null
      && input.observedDocumentSequence >= window.appliedDocumentSequence
    ) {
      // The connection acknowledged a checkpoint containing the agent edit;
      // a later intentional human revision is not an offline race.
      memoryWindows.delete(operationId);
      continue;
    }
    const structuralTargets = window.targets.filter(isRichMarkdownPatchTarget);
    if (structuralTargets.length > 0) {
      let currentMarkdown: string | null = null;
      try {
        currentMarkdown = richMarkdownFromYDoc(input.doc);
      } catch {}
      window.conflicts = structuralTargets
        .filter((target) => currentMarkdown === null || hash(currentMarkdown) !== target.baseTargetHash)
        .map((target) => ({ targetId: target.targetId, groupId: target.groupId, code: 'target_changed' as const }));
    } else {
      const inspection = preflight(input.doc, window.targets, true);
      window.conflicts = inspection.conflicts.filter((conflict) => (
        conflict.code === 'target_changed' || conflict.code === 'anchor_invalid' || conflict.code === 'unicode_boundary'
      ));
    }
    if (window.conflicts.length > 0) conflictedOperationIds.push(operationId);
  }
  if (memoryWindows.size === 0) recentAgentChangeWindows.delete(input.documentId);
  if (conflictedOperationIds.length === 0) return;

  const database = await openDb();
  try {
    for (const operationId of conflictedOperationIds) {
      const window = memoryWindows.get(operationId);
      if (!window || window.conflicts.length === 0) continue;
      const row = await readOperation(database, operationId);
      if (!row || !['applied_to_ydoc', 'persisted_yjs', 'checkpointed_file', 'partially_applied', 'reverted'].includes(row.status)) {
        continue;
      }
      const current = parseResult(row);
      const result: PersistedAgentApplyResult = {
        ...current,
        status: 'semantic_conflict',
        conflicts: window.conflicts,
        operationStatus: 'semantic_conflict',
      };
      await transitionOperation({
        database,
        row,
        expectedStatuses: [row.status],
        status: 'semantic_conflict',
        fields: { result_json: JSON.stringify(result), error_code: 'collaboration_semantic_conflict' },
      }).catch(() => undefined);
      memoryWindows.delete(operationId);
    }
    if (memoryWindows.size === 0) recentAgentChangeWindows.delete(input.documentId);
  } finally {
    await database.close();
  }
}

/** Safe restart recovery never replays an uncertain authoritative apply. */
export async function recoverCollaborationAgentOperations(now = Date.now()): Promise<void> {
  if (getDatabaseProvider() !== 'postgres') return;
  const database = await openDb();
  try {
    const rows = await database.all(
      `SELECT * FROM collaboration_agent_operations
       WHERE status IN ('preparing', 'ready', 'applying', 'cancel_requested', 'applied_to_ydoc', 'persisted_yjs')`,
    ) as AgentOperationRow[];
    for (const row of rows) {
      if (row.status === 'cancel_requested') {
        await transitionOperation({
          database,
          row,
          expectedStatuses: ['cancel_requested'],
          status: 'cancelled',
          fields: { error_code: 'cancelled_during_restart' },
        }).catch(() => undefined);
        continue;
      }
      const state = await loadCollaborationState(row.document_id);
      if (
        row.resulting_state_vector_hash
        && state
        && (
          stateVectorHash(state.stateVector) === row.resulting_state_vector_hash
          || stateVectorIncludes(state.stateVector, parseResult(row).stateVector)
        )
      ) {
        const status: AgentOperationStatus = state.checkpointSequence >= state.documentSequence ? 'checkpointed_file' : 'persisted_yjs';
        await transitionOperation({
          database,
          row,
          expectedStatuses: [row.status],
          status,
          fields: {
            persisted_at: Math.max(state.persistedAt, Number(row.applied_at || 0)),
            checkpointed_at: status === 'checkpointed_file'
              ? Math.max(state.checkpointedAt || 0, state.persistedAt, Number(row.applied_at || 0))
              : null,
            applied_document_sequence: state.documentSequence,
            error_code: null,
          },
        }).catch(() => undefined);
        continue;
      }
      const expired = row.expires_at !== null && Number(row.expires_at) <= now;
      await transitionOperation({
        database,
        row,
        expectedStatuses: [row.status],
        status: expired ? 'expired' : 'needs_review',
        fields: { error_code: row.status === 'applying' ? 'restart_uncertain' : expired ? 'operation_expired' : 'restart_review_required' },
      }).catch(() => undefined);
    }

    const recentRows = await database.all(
      `SELECT * FROM collaboration_agent_operations
       WHERE status IN ('applied_to_ydoc', 'persisted_yjs', 'checkpointed_file', 'partially_applied', 'reverted')
         AND applied_at IS NOT NULL AND applied_at >= ? AND reverse_payload IS NOT NULL`,
      [now - SEMANTIC_CHANGE_WINDOW_MS],
    ) as AgentOperationRow[];
    for (const row of recentRows) {
      const reverseTargets = openPayload<AgentTextTarget[]>(row.reverse_payload) || [];
      if (reverseTargets.length > 0) {
        registerAgentChangeWindow(
          row.document_id,
          row.operation_id,
          reverseTargets,
          row.applied_document_sequence === null ? null : Number(row.applied_document_sequence),
        );
      }
    }
  } finally {
    await database.close();
  }
}
