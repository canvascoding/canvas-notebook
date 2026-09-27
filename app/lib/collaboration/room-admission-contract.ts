import { createHash } from 'node:crypto';
import type { CollaborationRoomOwnerScope } from './room-owner';

export type CollaborationAdmissionScope = Readonly<{
  workspaceId: string;
  organizationId: string | null;
  path: string;
  kind: 'exact' | 'subtree';
}>;
export type CollaborationAdmissionDocument = CollaborationRoomOwnerScope & Readonly<{ status: 'active' | 'archived' }>;
export type CollaborationAdmissionRequest = Readonly<{
  requestId: string;
  actorId: string;
  action: 'rename' | 'move' | 'archive' | 'restore' | 'copy_replace' | 'representation_change' | 'compact';
  actionDigest: string;
  actionPayloadText?: string;
  scopes: readonly CollaborationAdmissionScope[];
  expectedDocuments: readonly CollaborationAdmissionDocument[];
}>;
export type CollaborationAdmissionStatus = 'reserved' | 'draining' | 'recovery_required' | 'committed' | 'cancelled';

export class CollaborationAdmissionError extends Error {
  constructor(readonly code: 'ADMISSION_INVALID_REQUEST' | 'ADMISSION_CONFLICT' | 'ADMISSION_SCOPE_CHANGED'
    | 'ADMISSION_REQUEST_CHANGED' | 'ADMISSION_RECOVERY_REQUIRED' | 'ADMISSION_STATE_CHANGED') {
    super(code);
    this.name = 'CollaborationAdmissionError';
  }
}

const invalid = () => { throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST'); };
const validId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ADMISSION_ACTION_DOMAIN = 'canvas.admission-action.v1\0';
const MAX_ACTION_PAYLOAD_BYTES = 64 * 1024;
const MAX_ACTION_PAYLOAD_DEPTH = 16;
const MAX_ACTION_PAYLOAD_NODES = 4096;

function canonicalAdmissionActionPayload(text: string): string {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_ACTION_PAYLOAD_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();

  let nodes = 0;
  const canonicalize = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_ACTION_PAYLOAD_NODES || depth > MAX_ACTION_PAYLOAD_DEPTH) invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const objectValue = value as Record<string, unknown>;
    for (const key of Object.keys(objectValue).sort(compareText)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid();
      output[key] = canonicalize(objectValue[key], depth + 1);
    }
    return output;
  };

  const canonical = canonicalize(parsed, 1);
  return JSON.stringify(canonical);
}

export function collaborationAdmissionActionDigest(
  action: CollaborationAdmissionRequest['action'], actionPayloadText: string,
): string {
  const canonicalPayload = canonicalAdmissionActionPayload(actionPayloadText);
  return createHash('sha256').update(ADMISSION_ACTION_DOMAIN).update(action).update('\0')
    .update(canonicalPayload).digest('hex');
}

export function isCanonicalAdmissionPath(value: unknown, allowRoot = false): value is string {
  return typeof value === 'string' && value.length <= 4096
    && (value === '' ? allowRoot : !/[\\\u0000-\u001f\u007f]/u.test(value)
      && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));
}

/** Captures a new writer's exact identity; this is not mutation authority. */
export function captureCollaborationAdmissionWriterScope(
  input: Pick<CollaborationRoomOwnerScope, 'documentId' | 'workspaceId' | 'path'>,
): Readonly<Pick<CollaborationRoomOwnerScope, 'documentId' | 'workspaceId' | 'path'>> {
  if (!input || !validId(input.documentId) || !validId(input.workspaceId)
    || !isCanonicalAdmissionPath(input.path)) return invalid();
  return Object.freeze({ documentId: input.documentId, workspaceId: input.workspaceId, path: input.path });
}

export function admissionScopeContains(scope: CollaborationAdmissionScope, workspaceId: string, path: string): boolean {
  return scope.workspaceId === workspaceId && (scope.path === path || (scope.kind === 'subtree'
    && (scope.path === '' || path.startsWith(`${scope.path}/`))));
}

export function admissionScopesOverlap(a: CollaborationAdmissionScope, b: CollaborationAdmissionScope): boolean {
  // Organization drift must not bypass a reservation for a unique workspace ID.
  return admissionScopeContains(a, b.workspaceId, b.path) || admissionScopeContains(b, a.workspaceId, a.path);
}

export function collaborationAdmissionLockKey(workspaceId: string): string {
  if (!validId(workspaceId)) invalid();
  const hex = createHash('sha256').update(`canvas.collaboration.admission.v1\0${workspaceId}`).digest('hex').slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

/** Capture and canonicalize before any asynchronous work; never retain caller arrays. */
export function captureCollaborationAdmissionRequest(input: CollaborationAdmissionRequest) {
  if (!input || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(input.requestId)
    || !validId(input.actorId) || !/^[0-9a-f]{64}$/u.test(input.actionDigest)
    || !['rename', 'move', 'archive', 'restore', 'copy_replace', 'representation_change', 'compact'].includes(input.action)
    || !Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.length > 64
    || !Array.isArray(input.expectedDocuments) || input.expectedDocuments.length > 1024) invalid();
  let actionPayloadText: string | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'actionPayloadText')) {
    if (typeof input.actionPayloadText !== 'string') invalid();
    actionPayloadText = canonicalAdmissionActionPayload(input.actionPayloadText as string);
    if (input.actionDigest !== collaborationAdmissionActionDigest(input.action, actionPayloadText)) invalid();
  }
  const scopes = input.scopes.map((scope) => {
    if (!scope || !validId(scope.workspaceId) || (scope.organizationId !== null && !validId(scope.organizationId))
      || !['exact', 'subtree'].includes(scope.kind) || !isCanonicalAdmissionPath(scope.path, scope.kind === 'subtree')) invalid();
    return Object.freeze({ workspaceId: scope.workspaceId, organizationId: scope.organizationId, path: scope.path, kind: scope.kind });
  }).sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  const workspaceIds = [...new Set(scopes.map((scope) => scope.workspaceId))].sort(compareText);
  if (workspaceIds.length > 16 || scopes.some((scope, index) => scopes.slice(0, index)
    .some((previous) => previous.workspaceId === scope.workspaceId && previous.organizationId !== scope.organizationId))) invalid();
  const canonicalScopes = scopes.filter((scope, index) => index === 0 || JSON.stringify(scope) !== JSON.stringify(scopes[index - 1]));
  const documents = input.expectedDocuments.map((doc) => {
    if (!doc || !validId(doc.documentId) || !validId(doc.workspaceId)
      || (doc.organizationId !== null && !validId(doc.organizationId)) || !isCanonicalAdmissionPath(doc.path)
      || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(doc.representation)
      || !['active', 'archived'].includes(doc.status)
      || !Number.isSafeInteger(doc.lifecycleGeneration) || doc.lifecycleGeneration < 1
      || !Number.isSafeInteger(doc.schemaVersion) || doc.schemaVersion < 1
      || !canonicalScopes.some((scope) => scope.organizationId === doc.organizationId
        && admissionScopeContains(scope, doc.workspaceId, doc.path))) invalid();
    return Object.freeze({ documentId: doc.documentId, workspaceId: doc.workspaceId, organizationId: doc.organizationId,
      path: doc.path, representation: doc.representation, lifecycleGeneration: doc.lifecycleGeneration,
      schemaVersion: doc.schemaVersion, status: doc.status });
  }).sort((a, b) => compareText(a.documentId, b.documentId));
  if (documents.some((doc, index) => index > 0 && doc.documentId === documents[index - 1].documentId)) invalid();
  const request = Object.freeze({ requestId: input.requestId, actorId: input.actorId, action: input.action,
    actionDigest: input.actionDigest,
    scopes: Object.freeze(canonicalScopes), expectedDocuments: Object.freeze(documents),
    ...(actionPayloadText === undefined ? {} : { actionPayloadText }) });
  const intentText = JSON.stringify(request);
  const requestDigest = createHash('sha256').update(`canvas.collaboration.admission-request.v1\0${intentText}`).digest('hex');
  return Object.freeze({ request, intentText, requestDigest, workspaceIds: Object.freeze(workspaceIds) });
}
