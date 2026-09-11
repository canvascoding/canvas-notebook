import 'server-only';

import crypto, { randomUUID } from 'node:crypto';
import type * as YTypes from 'yjs';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { isAgentDatabaseCapacityError } from './agent-database-capacity';
import {
  applyExactTextEdits,
  type ExactTextEdit,
} from '@/app/lib/files/exact-text-patch';
import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  AgentDirectConnectionAuthorizationError,
  runCollaborationDirectConnection,
} from './direct-connection';
import { loadCollaborationState, type PersistedCollaborationState } from './persistence';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from './agent-durability';
import { logCollaborationDiagnostic } from './diagnostics';
import { readCurrentCollaborationDocument } from './document-access';
import { resolveAgentDirectEditGrant, withAgentDirectEditGrant, AgentDirectEditGrantUnavailableError,
  type AgentDirectEditGrantScope } from './agent-direct-edit-grants';
import { AgentBlockEditError, applyAgentBlockEdit, previewAgentBlockEdit, type PreparedAgentBlockEdit } from './agent-block-edits';
import type { AgentProposalPreviewMetadata } from './agent-proposal-preview';
import { validateAgentBlockDocument } from './agent-block-structure';
import {
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from './markdown-state';
import { Y } from './server-runtime';
import { isRichTextCollaborationRepresentation, type TextCollaborationRepresentation } from './types';
import { BLOCK_TREE_KEY } from './block-tree';
import { blockTreeTextScopes, richDocumentFormat } from './rich-document';
import {
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
const USER_REVERT_AUTHORITY = Symbol('trusted-user-selective-revert');

/** Only independent operation-store statements may borrow a client per query. */
function assertAgentOperationQuery(sql: string): void {
  const code = sql.replace(/'(?:[^']|'')*'/gu, "''").replace(/"user"/gu, 'user').trim();
  const calls = [...code.matchAll(/\b([a-z_][a-z_0-9]*)\s*\(/giu)].map((match) => match[1].toUpperCase());
  if (!/^(?:SELECT\b|INSERT\s+INTO\b|UPDATE\b|DELETE\s+FROM\b)/iu.test(code)
    || /;|--|\/\*|\*\/|"|\$(?!\d+\b)/u.test(code)
    || /\b(?:FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|CURRENT_USER|SESSION_USER|CURRENT_ROLE|CURRENT_SCHEMA)\b/iu.test(code)
    || (/^SELECT\b/iu.test(code) && /\bINTO\b/iu.test(code))
    || calls.some((name) => !['COALESCE', 'IN', 'VALUES', 'AND', 'OR', 'NOT', 'COLLABORATION_AGENT_OPERATIONS'].includes(name))) {
    throw new Error('Agent operation queries must be standalone statements without transaction or session state.');
  }
}

/** CAS statements commit separately; no pool client survives a room/grant/durability wait. */
function createAgentOperationDatabase(): SqlConnection {
  const execute = async <T>(method: 'get' | 'run' | 'all', sql: string, params?: unknown[]): Promise<T> => {
    assertAgentOperationQuery(sql);
    const connection = await openDb();
    try { return await connection[method](sql, params) as T; }
    finally { await connection.close(); }
  };
  return {
    get: (sql, params) => execute('get', sql, params),
    run: (sql, params) => execute('run', sql, params),
    all: (sql, params) => execute<unknown[]>('all', sql, params),
    close() { /* Each statement has already released its own client. */ },
  };
}

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
  kind?: 'text_replace' | 'rich_markdown_patch' | 'block_edit';
  targetId: string;
  groupId: string;
  startAnchor: string;
  endAnchor: string;
  blockId?: string | null;
  baseTargetHash: string;
  /** Formatting of the anchored range, excluding unrelated boundary text. */
  baseFormatHash?: string;
  replacement: string;
  replacementAttributes?: Record<string, unknown>;
  /** Server-prepared selective inverse; public tools never accept raw Yjs runs. */
  replacementDelta?: Array<{ insert: string; attributes: Record<string, unknown> }>;
  patchEdits?: ExactTextEdit[];
  /** Legacy unanchored patches require the exact original Yjs identity, including deletions. */
  baseDocumentSnapshot?: string;
  blockEdit?: PreparedAgentBlockEdit;
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

export type AgentFileEditRequestReceipt = {
  fingerprint: string;
  beforeSha256: string;
  proposedSha256: string;
};

export interface PersistedAgentApplyResult extends AgentApplyResult {
  operationId: string;
  durability: 'pending' | 'applied_to_ydoc' | 'persisted_yjs' | 'checkpointed_file' | 'needs_review';
  operationStatus: AgentOperationStatus;
  casVersion: number;
  /** Internal file-tool replay hint; never persisted as the operation result. */
  fileEditRequestReused?: true;
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
  /** Exact server-issued proposal revision displayed by the approving user. */
  proposalVersion?: string | null;
  reviewTargets?: Array<AgentProposalPreviewMetadata & {
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
    blockId?: string | null;
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
  document_representation: TextCollaborationRepresentation | null;
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
  direct_edit_grant_id: string | null;
  atomicity: 'all_or_nothing' | 'independent';
  operation_payload: string | null;
  reverse_payload: string | null;
  status: AgentOperationStatus;
  base_state_vector: Buffer | Uint8Array;
  base_document_sequence: number;
  resulting_state_vector_hash: string | null;
  resulting_state_snapshot: Buffer | Uint8Array | null;
  file_edit_request_json: string | null;
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

export class AgentProposalChangedError extends Error {
  readonly code = 'AGENT_PROPOSAL_CHANGED';
  constructor() {
    super('This proposal has changed or can no longer be applied. Reload it before approving.');
    this.name = 'AgentProposalChangedError';
  }
}

type AgentOperationReview = {
  targets: AgentOperationView['reviewTargets'];
  proposalVersion: string | null;
};

/** A historical receipt is available, but cannot describe this document lifecycle. */
export class AgentFileEditOperationScopeError extends Error {
  constructor(readonly operation: PersistedAgentApplyResult) {
    super('The previous agent operation belongs to a changed document lifecycle; inspect its operation ID.');
    this.name = 'AgentFileEditOperationScopeError';
  }
}

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
  if (doc.share.has(BLOCK_TREE_KEY)) doc.getMap(BLOCK_TREE_KEY);
  if (doc.share.has('content')) doc.getText('content');
  if (doc.share.has('frontmatter')) doc.getText('frontmatter');
  if (doc.share.has('body')) doc.getXmlFragment('body');
}

function uniformTextAttributes(text: YTypes.Text, from: number, to: number): Record<string, unknown> | undefined {
  const delta = clippedTextDelta(text, from, to);
  return delta.length === 1 && Object.keys(delta[0].attributes).length ? delta[0].attributes : undefined;
}

type AgentTextDelta = NonNullable<AgentTextTarget['replacementDelta']>;

function canonicalFormatValue(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error('Invalid text format nesting.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && !hasUnpairedSurrogate(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalFormatValue(entry, depth + 1));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (hasUnpairedSurrogate(key)) throw new Error('Invalid text format key.');
      return [key, canonicalFormatValue((value as Record<string, unknown>)[key], depth + 1)];
    }));
  }
  throw new Error('Invalid text format value.');
}

function canonicalTextAttributes(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid text attributes.');
  return canonicalFormatValue(value) as Record<string, unknown>;
}

function appendTextDelta(delta: AgentTextDelta, insert: string, attributes: Record<string, unknown>): void {
  if (!insert) return;
  const previous = delta.at(-1);
  if (previous && JSON.stringify(previous.attributes) === JSON.stringify(attributes)) previous.insert += insert;
  else delta.push({ insert, attributes });
}

function clippedTextDelta(text: YTypes.Text, from: number, to: number): AgentTextDelta {
  const result: AgentTextDelta = []; let offset = 0;
  for (const part of text.toDelta() as Array<{ insert?: unknown; attributes?: unknown }>) {
    if (typeof part.insert !== 'string') throw new Error('Unsupported embedded agent text.');
    const start = Math.max(from, offset); const end = Math.min(to, offset + part.insert.length);
    if (start < end) appendTextDelta(result, part.insert.slice(start - offset, end - offset), canonicalTextAttributes(part.attributes ?? {}));
    offset += part.insert.length;
  }
  return result;
}

function textFormatHash(text: YTypes.Text, from: number, to: number): string {
  return hash(JSON.stringify(clippedTextDelta(text, from, to).map((part) => ({ length: part.insert.length, attributes: part.attributes }))));
}

function replacementTextDelta(target: AgentTextTarget): AgentTextDelta {
  // Explicitly empty attributes prevent Yjs from inheriting newer formatting
  // from text immediately outside the approved range after its deletion.
  const attributes = canonicalTextAttributes(target.replacementAttributes ?? {});
  if (target.replacementDelta === undefined) return target.replacement ? [{ insert: target.replacement, attributes }] : [];
  if (!Array.isArray(target.replacementDelta)
    || Buffer.byteLength(JSON.stringify(target.replacementDelta), 'utf8') > MAX_AGENT_PAYLOAD_BYTES) throw new Error('Invalid text replacement delta.');
  const result: AgentTextDelta = [];
  for (const part of target.replacementDelta) {
    if (!part || typeof part !== 'object' || Array.isArray(part)
      || Object.keys(part).some((key) => key !== 'insert' && key !== 'attributes')
      || typeof part.insert !== 'string' || !part.insert || hasUnpairedSurrogate(part.insert)) throw new Error('Invalid text replacement run.');
    appendTextDelta(result, part.insert, canonicalTextAttributes(part.attributes));
  }
  if (result.map((part) => part.insert).join('') !== target.replacement) throw new Error('Text replacement delta does not match its replacement.');
  return result;
}

function replaceResolvedText(target: ResolvedTarget): AgentTextDelta {
  const before = clippedTextDelta(target.text, target.from, target.to);
  const replacement = replacementTextDelta(target);
  target.text.delete(target.from, target.to - target.from);
  let offset = target.from;
  for (const part of replacement) {
    target.text.insert(offset, part.insert, part.attributes);
    offset += part.insert.length;
  }
  return before;
}

function reverseTextTarget(target: ResolvedTarget, original: AgentTextDelta): AgentTextTarget {
  return { ...createAgentTextTarget({ text: target.text, from: target.from, to: target.from + target.replacement.length,
    replacement: target.currentText, targetId: `revert:${target.targetId}`, groupId: target.groupId, boundaryPolicy: target.boundaryPolicy }),
  replacementAttributes: original.length === 1 ? original[0].attributes : {}, replacementDelta: original };
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
  let blockId: string | null | undefined;
  if (input.text.doc && richDocumentFormat(input.text.doc) === 'tiptap_blocks') {
    blockId = blockTreeTextScopes(input.text.doc).get(input.text);
    if (blockId === undefined) throw new Error('Agent target no longer belongs to a visible block.');
  }
  return {
    kind: 'text_replace',
    targetId: input.targetId || randomUUID(),
    groupId: input.groupId || 'default',
    // Start follows the first target item, while end follows the last target
    // item. Concurrent insertions immediately outside the range stay outside.
    startAnchor: encodePosition(Y.createRelativePositionFromTypeIndex(input.text, input.from, 0)),
    endAnchor: encodePosition(Y.createRelativePositionFromTypeIndex(input.text, input.to, empty ? 0 : -1)),
    baseTargetHash: hash(value.slice(input.from, input.to)),
    baseFormatHash: textFormatHash(input.text, input.from, input.to),
    replacement: input.replacement,
    replacementAttributes: uniformTextAttributes(input.text, input.from, input.to) ?? {},
    boundaryPolicy: input.boundaryPolicy || 'exclude_external',
    ...(blockId !== undefined ? { blockId } : {}),
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
 * Creates stable RelativePosition targets inside visible rich document text.
 * Text spanning structural node boundaries is intentionally refused so an
 * agent can never turn a whole Markdown snapshot into an implicit tree merge.
 */
export function createRichAgentTextTargets(input: {
  doc: YTypes.Doc;
  search: string;
  replacement: string;
  expectedOccurrences?: number;
  groupId?: string;
  blockId?: string;
}): AgentTextTarget[] {
  if (!input.search) throw new Error('Rich collaboration agent targets require non-empty source text.');
  materializeCollaborationTypes(input.doc);
  const expected = input.expectedOccurrences ?? 1;
  if (!Number.isInteger(expected) || expected < 1 || expected > MAX_AGENT_TARGETS) {
    throw new Error(`Rich collaboration agent targets require 1-${MAX_AGENT_TARGETS} expected occurrences.`);
  }
  const textTypes: YTypes.Text[] = [];
  if (richDocumentFormat(input.doc) === 'tiptap_blocks') {
    for (const [text, blockId] of blockTreeTextScopes(input.doc)) {
      if (input.blockId === undefined || input.blockId === blockId) textTypes.push(text);
    }
  } else {
    if (input.blockId !== undefined) throw new Error('Block-scoped text edits require a block collaboration document.');
    const frontmatter = input.doc.share.get('frontmatter');
    if (frontmatter instanceof Y.Text) textTypes.push(frontmatter as YTypes.Text);
    const body = input.doc.share.get('body');
    if (body instanceof Y.AbstractType) collectRichTextTypes(body as YTypes.AbstractType<unknown>, textTypes);
  }

  const targets: AgentTextTarget[] = [];
  for (const text of textTypes) {
    const value = textValue(text);
    let offset = 0;
    while (targets.length <= expected) {
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
    if (targets.length > expected) break;
  }
  if (targets.length !== expected) {
    throw new Error('Rich collaboration edit requires review because the exact text does not resolve inside stable Tiptap nodes.');
  }
  return targets;
}

export function createRichMarkdownReviewTarget(input: {
  doc?: YTypes.Doc;
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
    ...(input.doc ? { baseDocumentSnapshot: agentDocumentSnapshot(input.doc) ?? undefined } : {}),
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

function agentDocumentSnapshot(doc: YTypes.Doc): string | null {
  const snapshot = captureAgentStateSnapshot(doc, Y);
  return snapshot ? Buffer.from(snapshot).toString('base64') : null;
}

function legacyMarkdownTargetStillMatches(doc: YTypes.Doc, target: AgentTextTarget): boolean {
  // Old proposals without an identity receipt cannot safely relocate an unanchored patch.
  return Boolean(target.baseDocumentSnapshot)
    && target.baseDocumentSnapshot === agentDocumentSnapshot(doc)
    && hash(richMarkdownFromYDoc(doc)) === target.baseTargetHash;
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
    if (!legacyMarkdownTargetStillMatches(input.doc, target)) throw new AgentProposalChangedError();
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
      baseDocumentSnapshot: agentDocumentSnapshot(input.doc) ?? undefined,
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
  let scopes: ReturnType<typeof blockTreeTextScopes> | undefined;
  try {
    if (richDocumentFormat(doc) === 'tiptap_blocks') scopes = blockTreeTextScopes(doc);
  } catch {
    return { resolved, conflicts: targets.map((target): AgentApplyConflict => ({
      targetId: target.targetId, groupId: target.groupId, code: 'schema_invalid',
    })) };
  }
  for (const target of targets) {
    if (
      target.boundaryPolicy !== 'exclude_external'
      || Buffer.byteLength(target.replacement, 'utf8') > MAX_AGENT_REPLACEMENT_BYTES
      || hasUnpairedSurrogate(target.replacement)
    ) {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'limit_exceeded' });
      continue;
    }
    try { replacementTextDelta(target); }
    catch {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'schema_invalid' });
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
    if (scopes && (target.blockId === undefined || !scopes.has(text) || scopes.get(text) !== target.blockId)) {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'target_changed' });
      continue;
    }
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
    try {
      // Legacy rich ranges lack a formatting receipt; text equality cannot
      // prove that accepting them would preserve a later human mark change.
      if ((target.baseFormatHash === undefined && Boolean(text.parent))
        || (target.baseFormatHash !== undefined && (!/^[a-f0-9]{64}$/u.test(target.baseFormatHash)
          || target.baseFormatHash !== textFormatHash(text, resolvedTarget.from, resolvedTarget.to)))) {
        conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'target_changed' });
        continue;
      }
    } catch {
      conflicts.push({ targetId: target.targetId, groupId: target.groupId, code: 'schema_invalid' });
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
  if (input.targets.some((target) => target.kind && target.kind !== 'text_replace')) {
    throw new Error('Structural edits must use the structured collaboration application path.');
  }
  const independentGroups = Boolean(input.independentGroups);
  const clone = new Y.Doc({ gc: true });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(input.doc));
  const clonePreflight = preflight(clone, input.targets, independentGroups, input.compositionRanges);
  let inverseValidationCode: AgentApplyConflict['code'] | null = null;
  try {
    const inverse: AgentTextTarget[] = [];
    clone.transact(() => {
      for (const target of [...clonePreflight.resolved].sort((a, b) => b.from - a.from)) {
        inverse.push(reverseTextTarget(target, replaceResolvedText(target)));
      }
    }, input.origin);
    if (Buffer.byteLength(JSON.stringify(inverse), 'utf8') > MAX_AGENT_PAYLOAD_BYTES) inverseValidationCode = 'limit_exceeded';
  } catch (error) {
    inverseValidationCode = error instanceof Error && error.message.includes('Unicode grapheme') ? 'unicode_boundary' : 'schema_invalid';
  }
  const uniqueCloneTexts = [...new Set(clonePreflight.resolved.map((target) => target.text))];
  const invalidText = uniqueCloneTexts.some((text) => {
    const value = textValue(text);
    return Buffer.byteLength(value, 'utf8') > MAX_COLLABORATIVE_TEXT_BYTES || hasUnpairedSurrogate(value);
  });
  const cloneValidationCode = inverseValidationCode || (invalidText ? 'limit_exceeded' : input.validateClone?.(clone) || null);
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
        reverseTargets.push(reverseTextTarget(target, replaceResolvedText(target)));
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

/** Structured groups share the operation lifecycle, but never enter the text-anchor writer. */
export function applyAgentBlockTargets(input: {
  doc: YTypes.Doc;
  targets: AgentTextTarget[];
  validateClone?: (doc: YTypes.Doc) => AgentApplyConflict['code'] | null;
  origin: { actorType: 'agent'; actorId: string; initiatedByUserId: string; operationId: string };
}): AgentApplyExecutionResult {
  const conflict = (code: AgentApplyConflict['code']): AgentApplyExecutionResult => ({
    status: 'needs_review', appliedTargetIds: [], reverseTargets: [],
    conflicts: input.targets.map((target) => ({ targetId: target.targetId, groupId: target.groupId, code })),
    stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
  });
  const target = input.targets.length === 1 ? input.targets[0] : undefined;
  if (!target || target.kind !== 'block_edit' || !target.blockEdit || target.boundaryPolicy !== 'exclude_external'
    || richDocumentFormat(input.doc) !== 'tiptap_blocks') return conflict('schema_invalid');
  if (Buffer.byteLength(JSON.stringify(target), 'utf8') > MAX_AGENT_PAYLOAD_BYTES) return conflict('limit_exceeded');
  if (activeCompositionRanges(input.doc).length > 0) return conflict('ime_composition');
  const clone = new Y.Doc({ gc: true });
  let reverse: PreparedAgentBlockEdit | null;
  try {
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(input.doc));
    const candidate = applyAgentBlockEdit(clone, target.blockEdit, input.origin);
    // The reverse receipt must be persistable before touching the shared room.
    if (candidate.reverse && Buffer.byteLength(JSON.stringify(candidate.reverse), 'utf8')
      + Buffer.byteLength(candidate.reverse.afterText, 'utf8') + 2048 > MAX_AGENT_PAYLOAD_BYTES) return conflict('limit_exceeded');
    const invalid = input.validateClone?.(clone);
    if (invalid) return conflict(invalid);
    // No await is permitted from this final local preflight through mutation.
    reverse = applyAgentBlockEdit(input.doc, target.blockEdit, input.origin).reverse;
  } catch (error) {
    if (error instanceof AgentBlockEditError) return conflict(error.code);
    throw error;
  } finally { clone.destroy(); }
  return {
    status: 'applied_to_ydoc', appliedTargetIds: [target.targetId], conflicts: [],
    stateVector: Buffer.from(Y.encodeStateVector(input.doc)).toString('base64'),
    reverseTargets: reverse ? [{ kind: 'block_edit', targetId: `revert:${target.targetId}`, groupId: target.groupId,
      startAnchor: '', endAnchor: '', baseTargetHash: hash(JSON.stringify(reverse)),
      replacement: reverse.afterText, blockEdit: reverse, boundaryPolicy: 'exclude_external' }] : [],
  };
}

async function assertStoredBlockRevert(database: SqlConnection, row: AgentOperationRow, targets: AgentTextTarget[], workspace: WorkspaceContext) {
  if (!targets.some((target) => target.kind === 'block_edit' && target.blockEdit?.kind === 'reverse')) return;
  const original = row.supersedes_operation_id ? await readOperation(database, row.supersedes_operation_id) : null;
  const recorded = original ? openPayload<AgentTextTarget[]>(original.reverse_payload) : null;
  if (row.operation_type !== 'revert' || !original || !recorded || !canManageOperation(original, workspace, row.initiated_by_user_id)
    || original.document_id !== row.document_id || original.actor_id !== row.actor_id
    || Number(original.document_lifecycle_generation) !== Number(row.document_lifecycle_generation)
    || Number(original.schema_version) !== Number(row.schema_version)
    || targets.some((target) => !recorded.some((entry) => entry.targetId === target.targetId && JSON.stringify(entry) === JSON.stringify(target)))) {
    throw new Error('Structured reverts must exactly match the authorized original operation receipt.');
  }
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
      durability: parsed.durability || (row.status === 'checkpointed_file' ? 'checkpointed_file'
        : row.status === 'persisted_yjs' ? 'persisted_yjs' : row.status === 'needs_review' ? 'needs_review' : 'pending'),
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
    durability: row.status === 'checkpointed_file' ? 'checkpointed_file'
      : row.status === 'persisted_yjs' ? 'persisted_yjs' : row.status === 'needs_review' ? 'needs_review' : 'pending',
    operationStatus: row.status,
    casVersion: Number(row.cas_version),
  };
}

async function readOperation(database: SqlConnection, operationId: string): Promise<AgentOperationRow | null> {
  return (await database.get(
    `SELECT operation.*, COALESCE(initiator.name, initiator.email, initiator.id) AS initiated_by_display_name
     FROM collaboration_agent_operations operation
     LEFT JOIN "user" initiator ON initiator.id = operation.initiated_by_user_id
     WHERE operation.operation_id = $1 LIMIT 1`,
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
  const assignments = Object.keys(fields).map((field, index) => `${field} = $${index + 1}`).join(', ');
  const statusPlaceholders = input.expectedStatuses.map((_, index) => `$${index + Object.keys(fields).length + 4}`).join(', ');
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
     WHERE operation_id = $${Object.keys(fields).length + 1} AND cas_version = $${Object.keys(fields).length + 2} AND run_generation = $${Object.keys(fields).length + 3} AND status IN (${statusPlaceholders})`,
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
  documentRepresentation?: TextCollaborationRepresentation;
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

async function assertMatchingAgentFileRequest(row: AgentOperationRow, input: Parameters<typeof createOrLoadOperation>[0]): Promise<void> {
  const receipt = row.file_edit_request_json ? JSON.parse(row.file_edit_request_json) as AgentFileEditRequestReceipt : null;
  if (!receipt || !input.fileEditRequest || receipt.fingerprint !== input.fileEditRequest.fingerprint
    || ![receipt.fingerprint, receipt.beforeSha256, receipt.proposedSha256]
      .every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))
    || row.document_id !== input.documentId || row.workspace_id !== input.workspace.workspaceId
    || row.organization_id !== (input.workspace.organizationId ?? null)
    || row.initiated_by_user_id !== input.initiatedByUserId || row.actor_id !== input.actorId
    || (row.actor_session_id ?? null) !== (input.actorSessionId || null)
    || row.document_path !== input.documentPath || row.document_representation !== input.documentRepresentation
    || Number(row.document_lifecycle_generation) !== input.documentLifecycleGeneration
    || Number(row.schema_version) !== input.documentSchemaVersion
    || Number(row.run_generation) !== input.runGeneration || row.operation_type !== input.operationType
    || row.atomicity !== (input.independentGroups ? 'independent' : 'all_or_nothing')
    || (row.supersedes_operation_id ?? null) !== (input.supersedesOperationId || null)
    || (row.expected_canonical_hash ?? null) !== (input.expectedCanonicalHash || null)) {
    throw new Error('Idempotency key was already used with a different or unverifiable agent file request.');
  }
  const state = await loadCollaborationState(row.document_id);
  if (!state || state.status !== 'active' || state.workspaceId !== row.workspace_id || state.organizationId !== row.organization_id
    || state.path !== row.document_path || state.representation !== row.document_representation
    || state.lifecycleGeneration !== Number(row.document_lifecycle_generation) || state.schemaVersion !== Number(row.schema_version)) {
    throw new AgentFileEditOperationScopeError(parseResult(row));
  }
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
  documentRepresentation?: TextCollaborationRepresentation;
  documentLifecycleGeneration?: number;
  documentSchemaVersion?: number;
  baseStateVector?: string;
  baseDocumentSequence?: number;
  fileEditRequest?: AgentFileEditRequestReceipt;
  directEditGrantId?: string | null;
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
  if (input.fileEditRequest && ![input.fileEditRequest.fingerprint, input.fileEditRequest.beforeSha256,
    input.fileEditRequest.proposedSha256].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) {
    throw new Error('Agent file edit request receipt is invalid.');
  }
  const fileEditRequestJson = input.fileEditRequest ? JSON.stringify({
    fingerprint: input.fileEditRequest.fingerprint, beforeSha256: input.fileEditRequest.beforeSha256,
    proposedSha256: input.fileEditRequest.proposedSha256,
  }) : null;
  const payloadHash = operationPayloadHash(input);
  const existing = await input.database.get(
    'SELECT * FROM collaboration_agent_operations WHERE document_id = $1 AND initiated_by_user_id = $2 AND idempotency_key = $3 LIMIT 1',
    [input.documentId, input.initiatedByUserId, input.idempotencyKey],
  ) as AgentOperationRow | undefined;
  if (existing) {
    if (input.fileEditRequest) {
      // Parallel first deliveries can prepare different anchors, block IDs and
      // snapshots. The trusted original request, rather than those derived bytes,
      // identifies their single already-recorded operation.
      await assertMatchingAgentFileRequest(existing, input);
    } else if (existing.payload_hash !== payloadHash || (existing.file_edit_request_json ?? null) !== fileEditRequestJson) {
      throw new Error('Idempotency key was already used with a different agent payload.');
    }
    return { row: existing, created: false };
  }
  if (input.correlationId && triggerDepth > 0) {
    const chainDuplicate = await input.database.get(
      `SELECT * FROM collaboration_agent_operations
       WHERE document_id = $1 AND initiated_by_user_id = $2 AND correlation_id = $3
         AND payload_hash = $4 AND operation_type = $5
       ORDER BY created_at ASC LIMIT 1`,
      [input.documentId, input.initiatedByUserId, input.correlationId, payloadHash, input.operationType],
    ) as AgentOperationRow | undefined;
    if (chainDuplicate) {
      if (input.fileEditRequest) await assertMatchingAgentFileRequest(chainDuplicate, input);
      return { row: chainDuplicate, created: false };
    }
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
      causation_id, trigger_depth, expected_canonical_hash, created_at, updated_at, file_edit_request_json, direct_edit_grant_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'preparing', $21, $22, NULL, 0, $23, $24, $25, $26, $27, $28, $29, $30, $31)`,
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
      input.requestedMode === 'review' ? null : now + AGENT_OPERATION_TTL_MS,
      input.correlationId || operationId,
      input.causationId || null,
      input.triggerDepth || 0,
      input.expectedCanonicalHash || null,
      now,
      now,
      fileEditRequestJson,
      input.directEditGrantId ?? null,
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

function stateConfirmsAgentOperation(row: AgentOperationRow, state: PersistedCollaborationState | null): state is PersistedCollaborationState {
  return Boolean(state && !state.degraded && state.status === 'active'
    && state.documentId === row.document_id && state.workspaceId === row.workspace_id
    && state.organizationId === row.organization_id
    && state.lifecycleGeneration === Number(row.document_lifecycle_generation)
    && state.schemaVersion === Number(row.schema_version)
    && (row.document_path === null || state.path === row.document_path)
    && (row.document_representation === null || state.representation === row.document_representation)
    && row.resulting_state_snapshot
    && persistedUpdateIncludesAgentSnapshot(state.yjsState, row.resulting_state_snapshot, Y));
}

/** Optional compatibility detail. File projection never gates binary success. */
async function confirmedAgentFileRevision(row: AgentOperationRow, state: PersistedCollaborationState, workspace: WorkspaceContext) {
  if (state.checkpointSequence < state.documentSequence) return { checkpointed: false, revisionId: null };
  if (!row.document_path) return { checkpointed: true, revisionId: null };
  try {
    const projection = await readFileCollaborationState({ workspace, path: row.document_path });
    const document = projection.document;
    if (document?.id === row.document_id && document.stateVersion === state.checkpointSequence
      && document.snapshotRevisionId && projection.latestRevision?.id === document.snapshotRevisionId) {
      return { checkpointed: true, revisionId: document.snapshotRevisionId };
    }
  } catch { /* The already confirmed live document does not depend on file reads. */ }
  return { checkpointed: false, revisionId: null };
}

async function waitForDurableState(input: { row: AgentOperationRow; workspace: WorkspaceContext }) {
  const deadline = Date.now() + PERSISTENCE_CONFIRMATION_TIMEOUT_MS;
  do {
    const state = await loadCollaborationState(input.row.document_id);
    if (stateConfirmsAgentOperation(input.row, state)) {
      return { state, ...await confirmedAgentFileRevision(input.row, state, input.workspace) };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error('Agent update has no confirmed durable Yjs receipt yet; query its operation ID before retrying.');
}

async function confirmDurableAgentOperation(input: {
  database: SqlConnection;
  row: AgentOperationRow;
  state: PersistedCollaborationState;
  checkpointed?: boolean;
  revisionId?: string | null;
}): Promise<AgentOperationRow> {
  const { row, state } = input;
  const previous = parseResult(row);
  const conflicts = previous.conflicts.filter((conflict) => !['persistence_degraded', 'restart_uncertain'].includes(conflict.code));
  const semanticConflict = previous.status === 'semantic_conflict';
  const durability = input.checkpointed ? 'checkpointed_file' : 'persisted_yjs';
  const status: AgentOperationStatus = semanticConflict ? 'semantic_conflict'
    : conflicts.length > 0 ? 'partially_applied'
      : row.operation_type === 'revert' ? 'reverted' : durability;
  const result: PersistedAgentApplyResult = {
    ...previous, conflicts, durability, operationStatus: status,
    status: semanticConflict ? 'semantic_conflict' : conflicts.length > 0 ? 'partially_applied' : 'applied_to_ydoc',
  };
  setAgentChangeWindowSequence(row.document_id, row.operation_id, state.documentSequence);
  const confirmed = await transitionOperation({ database: input.database, row, expectedStatuses: [row.status], status,
    fields: {
      result_json: JSON.stringify(result),
      persisted_at: Math.max(state.persistedAt, Number(row.applied_at || 0)),
      applied_document_sequence: state.documentSequence,
      checkpoint_revision_id: input.revisionId ?? null,
      checkpointed_at: input.checkpointed ? Math.max(state.checkpointedAt || 0, state.persistedAt, Number(row.applied_at || 0)) : null,
      error_code: semanticConflict ? 'collaboration_semantic_conflict' : conflicts.length > 0 ? 'partial_review_required' : null,
    },
  });
  logCollaborationDiagnostic('debug', { event: 'agent_durable', operationId: row.operation_id,
    documentId: row.document_id, workspaceId: row.workspace_id, generation: state.lifecycleGeneration,
    documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence });
  return confirmed;
}

/** A delayed binary commit is resolved by status lookup, never by replay. */
async function reconcileAgentOperationDurability(database: SqlConnection, row: AgentOperationRow, workspace?: WorkspaceContext): Promise<AgentOperationRow> {
  if (!row.resulting_state_snapshot || !row.result_json
    || !(row.status === 'applied_to_ydoc' || (row.status === 'partially_applied' && row.error_code === 'persistence_degraded'))) return row;
  const state = await loadCollaborationState(row.document_id);
  if (!stateConfirmsAgentOperation(row, state)) return row;
  const projection = workspace ? await confirmedAgentFileRevision(row, state, workspace) : { checkpointed: false, revisionId: null };
  try { return await confirmDurableAgentOperation({ database, row, state, ...projection }); }
  catch { return await readOperation(database, row.operation_id) || row; }
}

function validateOperationClone(
  representation: TextCollaborationRepresentation,
  expectedCanonicalHash: string | null,
  doc: YTypes.Doc,
): AgentApplyConflict['code'] | null {
  if (representation === 'tiptap_blocks') {
    const invalid = validateAgentBlockDocument(doc);
    if (invalid) return invalid;
    // An explicit canonical-output contract still requires that exact output.
    // Ordinary live edits do not depend on Markdown's roundtrip/export health.
    if (!expectedCanonicalHash) return null;
    try { return hash(richMarkdownFromYDoc(doc)) === expectedCanonicalHash ? null : 'target_scope_invalid'; }
    catch { return 'target_scope_invalid'; }
  }
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
  approval?: { row: AgentOperationRow; userId: string; proposalVersion: string; actionKeysJson: string };
  directGrant?: { id: string; expiresAt: number };
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
  if ((row.status === 'needs_review' || row.status === 'partially_applied') && !input.approval) return parseResult(row);

  const allTargets = openPayload<AgentTextTarget[]>(row.operation_payload) || [];
  const priorResult = parseResult(row);
  const alreadyApplied = new Set(priorResult.appliedTargetIds);
  const targets = allTargets.filter((target) => !alreadyApplied.has(target.targetId));
  if (targets.length === 0) return priorResult;
  await assertStoredBlockRevert(input.database, row, targets, input.workspace);
  row = await transitionOperation({
    database: input.database,
    row,
    expectedStatuses: ['preparing', 'ready', 'needs_review', 'partially_applied'],
    status: 'applying',
    // A prior partial apply cannot certify this new attempt after a crash.
    fields: { error_code: null, resulting_state_snapshot: null, resulting_state_vector_hash: null,
      ...(input.approval ? { action_keys_json: input.approval.actionKeysJson } : {}),
      result_json: JSON.stringify({ ...priorResult, operationStatus: 'applying',
        durability: priorResult.appliedTargetIds.length > 0 ? 'applied_to_ydoc' : 'pending' }) },
  });

  const initiator = await input.database.get(
    'SELECT name, email FROM "user" WHERE id = $1 LIMIT 1',
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
  let resultingSnapshot: Uint8Array | null = null;
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
      if (input.directGrant && (input.directGrant.id !== row.direct_edit_grant_id || input.directGrant.expiresAt <= Date.now())) {
        throw new AgentDirectConnectionAuthorizationError('The direct editing permission has expired.');
      }
      // The row claim and the direct-connection authorization can await I/O.
      // Recheck the exact displayed proposal in this room, then mutate without yielding.
      if (input.approval && !matchesProposalVersion(
        input.approval.proposalVersion,
        reviewTargetsInDocument(input.approval.row, doc, input.approval.userId).proposalVersion,
      )) {
        logCollaborationDiagnostic('info', { event: 'agent_target_conflict', operationId: row.operation_id,
          documentId: row.document_id, workspaceId: row.workspace_id, code: 'AGENT_PROPOSAL_CHANGED' });
        return { status: 'needs_review' as const, appliedTargetIds: [], reverseTargets: [],
          conflicts: targets.map((target) => ({ targetId: target.targetId, groupId: target.groupId, code: 'target_changed' as const })),
          stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64') };
      }
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
      const result = targets.some((target) => target.kind === 'block_edit')
        ? applyAgentBlockTargets({ doc, targets, origin,
            validateClone: (clone) => validateOperationClone(state.representation, row.expected_canonical_hash, clone) })
        : structuralPatch
        ? isRichTextCollaborationRepresentation(state.representation) && targets.every(isRichMarkdownPatchTarget)
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
            independentGroups: !input.approval && row.atomicity === 'independent',
            validateClone: (clone) => validateOperationClone(
              state.representation,
              row.expected_canonical_hash,
              clone,
            ),
            origin,
          });
      if (result.appliedTargetIds.length > 0) resultingSnapshot = captureAgentStateSnapshot(doc, Y);
      if (result.conflicts.length > 0) logCollaborationDiagnostic('info', { event: 'agent_target_conflict',
        operationId: row.operation_id, documentId: row.document_id, workspaceId: row.workspace_id,
        generation: state.lifecycleGeneration, code: result.conflicts[0].code });
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
          resulting_state_snapshot: resultingSnapshot ? Buffer.from(resultingSnapshot) : null,
          applied_at: Date.now(),
        },
      });
      logCollaborationDiagnostic('debug', { event: 'agent_applied', operationId: row.operation_id,
        documentId: row.document_id, workspaceId: row.workspace_id, generation: state.lifecycleGeneration });
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
    const conflictCode: AgentApplyConflict['code'] = error instanceof AgentDirectConnectionAuthorizationError
      ? 'authorization_revoked'
      : 'persistence_degraded';
    const degradedResult = publicResult(fresh, {
      status: combinedApplied.length > 0 ? 'partially_applied' : 'needs_review',
      appliedTargetIds: combinedApplied,
      conflicts: [
        ...(appliedExecution.value ? combinedFor(appliedExecution.value).baseResult.conflicts : parseResult(fresh).conflicts),
        ...targets.map((target) => ({ targetId: target.targetId, groupId: target.groupId, code: conflictCode })),
      ],
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

  const { combinedApplied, baseResult } = combinedFor(execution);
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
    durable = await waitForDurableState({ row, workspace: input.workspace });
  } catch {
    logCollaborationDiagnostic('warn', { event: 'agent_durability_unconfirmed', operationId: row.operation_id,
      documentId: row.document_id, workspaceId: row.workspace_id, generation: state.lifecycleGeneration,
      code: 'AGENT_DURABILITY_UNCONFIRMED' });
    const persistenceConflicts = allTargets.map((target) => ({
      targetId: target.targetId,
      groupId: target.groupId,
      code: 'persistence_degraded' as const,
    }));
    const degradedResult = publicResult(row, {
      ...baseResult,
      status: 'partially_applied',
      conflicts: [...baseResult.conflicts, ...persistenceConflicts],
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
  // Re-read so a late semantic conflict is retained when durability completes.
  row = await readOperation(input.database, row.operation_id) || row;
  row = await confirmDurableAgentOperation({ database: input.database, row, ...durable });
  const durableResult = parseResult(row);

  try {
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
        resultStatus: durableResult.status,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        triggerDepth: Number(row.trigger_depth),
      },
    });
  } catch {
    logCollaborationDiagnostic('warn', { event: 'agent_audit_failed', operationId: row.operation_id,
      documentId: row.document_id, workspaceId: row.workspace_id, code: 'AGENT_AUDIT_FAILED' });
  }

  return durableResult;
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
  /** Deprecated compatibility input. It never grants editing authority. */
  explicitUserRequest?: boolean;
  [USER_REVERT_AUTHORITY]?: true;
  operationType?: 'apply' | 'revert';
  agentRunId?: string;
  actorSessionId?: string;
  supersedesOperationId?: string;
  correlationId?: string;
  causationId?: string;
  triggerDepth?: number;
  expectedCanonicalHash?: string | null;
  documentPath?: string;
  documentRepresentation?: TextCollaborationRepresentation;
  documentLifecycleGeneration?: number;
  documentSchemaVersion?: number;
  baseStateVector?: string;
  baseDocumentSequence?: number;
  fileEditRequest?: AgentFileEditRequestReceipt;
}): Promise<PersistedAgentApplyResult> {
  if (!input.workspace.permissions.canWrite) throw new Error('Workspace write permission is required.');
  const trustedRevert = input.operationType === 'revert' && input[USER_REVERT_AUTHORITY] === true;
  let directScope: AgentDirectEditGrantScope | null = null;
  let grant: { id: string; expiresAt: number } | null = null;
  // Capture permission before queueing. A later grant must not authorize an old queued edit.
  if (!trustedRevert && input.requestedMode !== 'review' && input.actorSessionId) {
    try {
      const generation = input.documentLifecycleGeneration ?? (await loadCollaborationState(input.documentId))?.lifecycleGeneration;
      if (generation !== undefined) {
        directScope = { userId: input.initiatedByUserId, workspaceId: input.workspace.workspaceId,
          agentId: input.actorId, actorSessionId: input.actorSessionId, documentId: input.documentId, lifecycleGeneration: generation };
        grant = await resolveAgentDirectEditGrant(directScope);
      }
    } catch {
      logCollaborationDiagnostic('warn', { event: 'agent_target_conflict', documentId: input.documentId,
        workspaceId: input.workspace.workspaceId, code: 'AGENT_DIRECT_PERMISSION_UNAVAILABLE' });
    }
  }
  return serialized(input.documentId, async (queue) => {
    const database = createAgentOperationDatabase();
    try {
      const requestedMode = input.requestedMode ?? 'direct_apply';
      const backpressureReview = queue.waitMs >= AGENT_QUEUE_REVIEW_AFTER_MS || queue.depth > 4;
      const mustReview = requestedMode === 'review' || (!trustedRevert && !grant) || backpressureReview;
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
        fileEditRequest: input.fileEditRequest,
        directEditGrantId: !mustReview ? grant?.id : null,
      });
      if (!created.created) return {
        ...parseResult(await reconcileAgentOperationDurability(database, created.row, input.workspace)),
        ...(input.fileEditRequest ? { fileEditRequestReused: true as const } : {}),
      };
      if (mustReview) return placeAgentOperationInReview(database, created.row,
        backpressureReview ? 'backpressure_review_required' : 'user_review_required');
      if (trustedRevert) return applyStoredOperation({ database, row: created.row,
        workspace: input.workspace, actorDisplayName: input.actorDisplayName });
      let appliedResult: PersistedAgentApplyResult | undefined;
      try {
        return await withAgentDirectEditGrant({ grantId: grant!.id, scope: directScope! }, async (currentGrant) => {
          appliedResult = await applyStoredOperation({ database, row: created.row, workspace: input.workspace,
            actorDisplayName: input.actorDisplayName, directGrant: currentGrant });
          return appliedResult;
        });
      } catch (error) {
        // The grant transaction only holds authority stable; it does not own the
        // already-written operation/Yjs receipt. A COMMIT response loss must not
        // turn that completed apply into another execution attempt.
        if (appliedResult) {
          logCollaborationDiagnostic('warn', { event: 'agent_audit_failed', operationId: created.row.operation_id,
            documentId: input.documentId, workspaceId: input.workspace.workspaceId, code: 'AGENT_GRANT_LOCK_RELEASE_UNCONFIRMED' });
          return appliedResult;
        }
        if (isAgentDatabaseCapacityError(error)) {
          return placeAgentOperationInReview(database, created.row, 'backpressure_review_required');
        }
        if (!(error instanceof AgentDirectEditGrantUnavailableError)) throw error;
        return placeAgentOperationInReview(database, created.row, 'authorization_revoked');
      }
    } finally {
      await database.close();
    }
  });
}

async function placeAgentOperationInReview(database: SqlConnection, row: AgentOperationRow, code: string) {
  const result = publicResult(row, { status: 'needs_review', appliedTargetIds: [], conflicts: [],
    stateVector: Buffer.from(row.base_state_vector).toString('base64') }, 'needs_review');
  const review = await transitionOperation({ database, row, expectedStatuses: ['preparing'], status: 'needs_review',
    fields: { requested_mode: 'review', expires_at: null, result_json: JSON.stringify(result), error_code: code } });
  return { ...result, operationStatus: review.status, casVersion: Number(review.cas_version) };
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
          ...(target.blockId !== undefined ? { blockId: target.blockId } : {}),
        }]
      : []
  ));
}

/** Reads only the pending part of a proposal, synchronously from the shared room. */
function reviewTargetsInDocument(row: AgentOperationRow, doc: YTypes.Doc, userId: string): AgentOperationReview {
  const alreadyApplied = new Set(parseResult(row).appliedTargetIds);
  const targets = (openPayload<AgentTextTarget[]>(row.operation_payload) || [])
    .filter((target) => !alreadyApplied.has(target.targetId));
  materializeCollaborationTypes(doc);
  const scopes = richDocumentFormat(doc) === 'tiptap_blocks' ? blockTreeTextScopes(doc) : undefined;
  const currentMarkdown = targets.some(isRichMarkdownPatchTarget) ? richMarkdownFromYDoc(doc) : null;
  const review = targets.flatMap<NonNullable<AgentOperationView['reviewTargets']>[number]>((target) => {
    if (target.kind === 'block_edit') {
      try {
        if (!target.blockEdit) throw new Error('Missing block edit.');
        const preview = previewAgentBlockEdit(doc, target.blockEdit, { includeLocations: true });
        return [{ targetId: target.targetId, groupId: target.groupId, proposedReplacement: preview.afterText,
          currentText: preview.beforeText, currentTargetHash: preview.footprintHash,
          previewFormat: 'blocks' as const, blockLocations: preview.locations }];
      } catch {
        return [{ targetId: target.targetId, groupId: target.groupId, proposedReplacement: target.replacement,
          currentText: null, currentTargetHash: null, previewFormat: 'blocks' as const }];
      }
    }
    if (isRichMarkdownPatchTarget(target)) {
      try {
        if (!legacyMarkdownTargetStillMatches(doc, target)) throw new AgentProposalChangedError();
        if (currentMarkdown === null) throw new Error('Missing rich document.');
        const proposed = target.patchEdits?.length
          ? applyExactTextEdits(currentMarkdown, target.patchEdits, 'collaborative Markdown review')
          : hash(currentMarkdown) === target.baseTargetHash ? target.replacement : null;
        return [{ targetId: target.targetId, groupId: target.groupId,
          proposedReplacement: proposed ?? target.replacement, currentText: currentMarkdown,
          currentTargetHash: proposed === null ? null : hash(currentMarkdown), previewFormat: 'markdown' as const }];
      } catch {
        return [{ targetId: target.targetId, groupId: target.groupId, proposedReplacement: target.replacement,
          currentText: null, currentTargetHash: null, previewFormat: 'markdown' as const }];
      }
    }
    const start = decodePosition(target.startAnchor);
    const end = decodePosition(target.endAnchor);
    const absoluteStart = start ? Y.createAbsolutePositionFromRelativePosition(start, doc) : null;
    const absoluteEnd = end ? Y.createAbsolutePositionFromRelativePosition(end, doc) : null;
    const currentText = absoluteStart
      && absoluteEnd
      && absoluteStart.type === absoluteEnd.type
      && absoluteStart.type instanceof Y.Text
      && (!scopes || (target.blockId !== undefined && scopes.has(absoluteStart.type as YTypes.Text)
        && scopes.get(absoluteStart.type as YTypes.Text) === target.blockId))
      && absoluteEnd.index >= absoluteStart.index
      ? textValue(absoluteStart.type as YTypes.Text).slice(absoluteStart.index, absoluteEnd.index)
      : null;
    return [{
      targetId: target.targetId,
      groupId: target.groupId,
      proposedReplacement: target.replacement,
      currentText,
      currentTargetHash: currentText === null ? null : hash(currentText),
      previewFormat: 'text' as const,
    }];
  });
  const textTargets = targets.filter((target) => !target.kind || target.kind === 'text_replace');
  const applicable = targets.length > 0 && (row.expires_at === null || Number(row.expires_at) > Date.now())
    && review.every((target) => target.currentTargetHash !== null)
    && preflight(doc, textTargets, false).conflicts.length === 0;
  const proposalVersion = applicable ? proposalVersionForReview(row, targets, review, userId) : null;
  return { targets: review, proposalVersion };
}

function proposalVersionForReview(
  row: AgentOperationRow,
  targets: AgentTextTarget[],
  review: NonNullable<AgentOperationView['reviewTargets']>,
  userId: string,
): string {
  // A move's surrounding text is context, not content that will be replaced.
  // Its footprint binds the exact placement operation and structural guards.
  const footprint = review.map((target, index) => ({
    targetId: target.targetId, groupId: target.groupId, currentTargetHash: target.currentTargetHash,
    proposedReplacement: targets[index]?.kind === 'block_edit' ? null : target.proposedReplacement,
  }));
  const binding = { purpose: 'agent-proposal-approval-v1', operationId: row.operation_id,
    userId, workspaceId: row.workspace_id, organizationId: row.organization_id,
    documentId: row.document_id, generation: Number(row.document_lifecycle_generation),
    schema: Number(row.schema_version), payloadHash: row.payload_hash,
    casVersion: Number(row.cas_version), runGeneration: Number(row.run_generation),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at), footprint };
  return `v1.${crypto.createHmac('sha256', payloadKey()).update(JSON.stringify(binding)).digest('hex')}`;
}

function matchesProposalVersion(supplied: unknown, current: string | null): boolean {
  return typeof supplied === 'string' && /^v1\.[a-f0-9]{64}$/.test(supplied)
    && current !== null && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(current));
}

function approvalReceipt(row: AgentOperationRow, input: { idempotencyKey: string; proposalVersion: string; userId: string }) {
  const key = `approval:${hash(input.idempotencyKey)}`;
  const value = hash(JSON.stringify({ userId: input.userId, proposalVersion: input.proposalVersion }));
  const keys = JSON.parse(row.action_keys_json || '{}') as Record<string, string>;
  const existing = keys[key];
  if (existing && existing !== value) throw new AgentProposalChangedError();
  if (!existing && Object.keys(keys).filter((entry) => entry.startsWith('approval:')).length >= 64) {
    throw new Error('This proposal has too many approval attempts. Request a new proposal.');
  }
  return { handled: existing === value, actionKeysJson: JSON.stringify({ ...keys, [key]: value }) };
}

async function reviewTargets(row: AgentOperationRow, userId: string): Promise<AgentOperationReview> {
  const unavailable: AgentOperationReview = { targets: undefined, proposalVersion: null };
  if (!['needs_review', 'partially_applied', 'semantic_conflict'].includes(row.status)) return unavailable;
  const targets = openPayload<AgentTextTarget[]>(row.operation_payload) || [];
  unavailable.targets = targets.filter((target) => !parseResult(row).appliedTargetIds.includes(target.targetId))
    .map((target) => ({ targetId: target.targetId, groupId: target.groupId,
      proposedReplacement: target.replacement, currentText: null, currentTargetHash: null }));
  const state = await loadCollaborationState(row.document_id);
  if (!state || state.status !== 'active' || state.degraded || state.workspaceId !== row.workspace_id
    || state.organizationId !== row.organization_id || state.lifecycleGeneration !== Number(row.document_lifecycle_generation)
    || state.schemaVersion !== Number(row.schema_version) || (row.document_path !== null && row.document_path !== state.path)
    || (row.document_representation !== null && row.document_representation !== state.representation)
    || (row.expires_at !== null && Number(row.expires_at) <= Date.now())) return unavailable;
  try {
    const review = await readCurrentCollaborationDocument({ documentId: row.document_id, workspaceId: row.workspace_id,
      read: (doc) => reviewTargetsInDocument(row, doc, userId) });
    // Late semantic conflicts describe already-applied work; they are not a new permission to replay it.
    if (row.status === 'semantic_conflict') review.proposalVersion = null;
    return review;
  } catch {
    return unavailable;
  }
}

function toOperationView(
  row: AgentOperationRow,
  review: AgentOperationReview,
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
    reviewTargets: review.targets,
    proposalVersion: actionsAllowed ? review.proposalVersion : null,
    targetAnchors: operationTargetAnchors(row),
  };
}

export async function getAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<AgentOperationView | null> {
  const database = createAgentOperationDatabase();
  try {
    let row = await readOperation(database, input.operationId);
    if (!row || !canViewOperation(row, input.workspace)) return null;
    row = await reconcileAgentOperationDurability(database, row, input.workspace);
    return toOperationView(
      row,
      await reviewTargets(row, input.userId),
      input.userId,
      canManageOperation(row, input.workspace, input.userId),
    );
  } finally {
    await database.close();
  }
}

/** Resolve a delivery retry before its oldText is matched against changed content. */
export async function findAgentFileEditOperation(input: {
  documentId: string;
  workspace: WorkspaceContext;
  userId: string;
  actorId: string;
  actorSessionId?: string;
  idempotencyKey: string;
  fingerprint: string;
}): Promise<{ operation: AgentOperationView; request: AgentFileEditRequestReceipt;
  identity: { path: string; representation: TextCollaborationRepresentation; lifecycleGeneration: number; schemaVersion: number };
} | null> {
  if (!input.workspace.permissions.canRead || !input.workspace.permissions.canWrite) {
    throw new Error('Current workspace read and write permission is required.');
  }
  const database = createAgentOperationDatabase();
  try {
    let row = await database.get(`SELECT * FROM collaboration_agent_operations
      WHERE document_id=$1 AND workspace_id=$2 AND initiated_by_user_id=$3 AND idempotency_key=$4`,
    [input.documentId, input.workspace.workspaceId, input.userId, input.idempotencyKey]) as AgentOperationRow | undefined;
    if (!row) return null;
    if (row.actor_id !== input.actorId || (row.actor_session_id ?? null) !== (input.actorSessionId ?? null)) {
      throw new Error('Idempotency key belongs to a different agent execution context.');
    }
    const request = row.file_edit_request_json ? JSON.parse(row.file_edit_request_json) as AgentFileEditRequestReceipt : null;
    if (!request || request.fingerprint !== input.fingerprint) {
      throw new Error('Idempotency key was already used with a different or unverifiable file edit request.');
    }
    const state = await loadCollaborationState(row.document_id);
    if (!state || state.status !== 'active' || state.workspaceId !== row.workspace_id || state.organizationId !== row.organization_id
      || state.lifecycleGeneration !== Number(row.document_lifecycle_generation) || state.schemaVersion !== Number(row.schema_version)
      || (row.document_path !== null && row.document_path !== state.path)
      || (row.document_representation !== null && row.document_representation !== state.representation)) {
      throw new AgentFileEditOperationScopeError(parseResult(row));
    }
    row = await reconcileAgentOperationDurability(database, row, input.workspace);
    return { operation: toOperationView(row, await reviewTargets(row, input.userId), input.userId, canManageOperation(row, input.workspace, input.userId)), request,
      identity: { path: row.document_path ?? state.path, representation: row.document_representation ?? state.representation,
        lifecycleGeneration: Number(row.document_lifecycle_generation), schemaVersion: Number(row.schema_version) } };
  } finally { await database.close(); }
}

export async function listAgentOperations(input: {
  documentId: string;
  workspace: WorkspaceContext;
  userId: string;
  pendingOnly?: boolean;
}): Promise<AgentOperationView[]> {
  if (!input.workspace.permissions.canRead) return [];
  const database = createAgentOperationDatabase();
  try {
    const rows = await database.all(
      `SELECT operation.*, COALESCE(initiator.name, initiator.email, initiator.id) AS initiated_by_display_name
       FROM collaboration_agent_operations operation
       LEFT JOIN "user" initiator ON initiator.id = operation.initiated_by_user_id
       WHERE operation.document_id = $1 AND operation.workspace_id = $2
         AND ($3 = 0 OR operation.status IN ('needs_review', 'partially_applied', 'semantic_conflict', 'cancel_requested'))
       ORDER BY operation.updated_at DESC LIMIT 50`,
      [
        input.documentId,
        input.workspace.workspaceId,
        input.pendingOnly ? 1 : 0,
      ],
    ) as AgentOperationRow[];
    return Promise.all(rows.map(async (stored) => {
      const row = await reconcileAgentOperationDurability(database, stored, input.workspace);
      return toOperationView(row, await reviewTargets(row, input.userId), input.userId, canManageOperation(row, input.workspace, input.userId));
    }));
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
    'UPDATE collaboration_agent_operations SET action_keys_json = $1, updated_at = $2 WHERE operation_id = $3 AND cas_version = $4',
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
  proposalVersion: string;
  actorDisplayName?: string;
}): Promise<PersistedAgentApplyResult> {
  const lookup = createAgentOperationDatabase();
  let documentId: string;
  try {
    const row = await authorizedActionRow(lookup, input);
    documentId = row.document_id;
  } finally {
    await lookup.close();
  }
  return serialized(documentId!, async () => {
    const database = createAgentOperationDatabase();
    try {
      const row = await authorizedActionRow(database, input);
      if (typeof input.proposalVersion !== 'string' || !/^v1\.[a-f0-9]{64}$/.test(input.proposalVersion)) {
        throw new AgentProposalChangedError();
      }
      const receipt = approvalReceipt(row, input);
      if (receipt.handled) return parseResult(await reconcileAgentOperationDurability(database, row, input.workspace));
      if (!['needs_review', 'partially_applied'].includes(row.status)) return parseResult(row);
      const review = await reviewTargets(row, input.userId);
      if (!matchesProposalVersion(input.proposalVersion, review.proposalVersion)) throw new AgentProposalChangedError();
      return applyStoredOperation({
        database,
        row,
        workspace: input.workspace,
        actorDisplayName: input.actorDisplayName || `Agent ${row.actor_id}`,
        approval: { row, userId: input.userId, proposalVersion: input.proposalVersion, actionKeysJson: receipt.actionKeysJson },
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
  const database = createAgentOperationDatabase();
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
  const database = createAgentOperationDatabase();
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
    [USER_REVERT_AUTHORITY]: true,
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
  const database = createAgentOperationDatabase();
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
    const blockTargets = window.targets.filter((target) => target.kind === 'block_edit');
    if (blockTargets.length > 0) {
      window.conflicts = blockTargets.flatMap((target): AgentApplyConflict[] => {
        try {
          if (!target.blockEdit) throw new Error('Missing block receipt.');
          previewAgentBlockEdit(input.doc, target.blockEdit);
          return [];
        } catch {
          return [{ targetId: target.targetId, groupId: target.groupId, code: 'target_changed' }];
        }
      });
    } else if (structuralTargets.length > 0) {
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

  const database = createAgentOperationDatabase();
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
  const database = createAgentOperationDatabase();
  try {
    const rows = await database.all(
      `SELECT * FROM collaboration_agent_operations
       WHERE status IN ('preparing', 'ready', 'applying', 'cancel_requested', 'applied_to_ydoc')
         OR (status = 'partially_applied' AND error_code = 'persistence_degraded')`,
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
      if (row.result_json && stateConfirmsAgentOperation(row, state)) {
        await confirmDurableAgentOperation({ database, row, state }).catch(() => undefined);
        continue;
      }
      // A legacy vector cannot certify a deletion. Uncertain applies remain
      // reviewable with their existing operation ID; recovery never replays.
      const expired = row.expires_at !== null && Number(row.expires_at) <= now;
      const uncertainResult = parseResult(row);
      await transitionOperation({
        database,
        row,
        expectedStatuses: [row.status],
        status: expired ? 'expired' : 'needs_review',
        fields: {
          result_json: JSON.stringify({ ...uncertainResult, operationStatus: expired ? 'expired' : 'needs_review',
            status: 'needs_review', durability: uncertainResult.appliedTargetIds.length > 0 ? 'applied_to_ydoc' : 'pending' }),
          error_code: ['applying', 'applied_to_ydoc', 'partially_applied'].includes(row.status) ? 'restart_uncertain' : expired ? 'operation_expired' : 'restart_review_required',
        },
      }).catch(() => undefined);
    }

    const recentRows = await database.all(
      `SELECT * FROM collaboration_agent_operations
       WHERE status IN ('applied_to_ydoc', 'persisted_yjs', 'checkpointed_file', 'partially_applied', 'reverted')
         AND applied_at IS NOT NULL AND applied_at >= $1 AND reverse_payload IS NOT NULL`,
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
