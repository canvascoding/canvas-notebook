import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

export const FILE_VERSION_CENTER_CONTRACT_VERSION = 1 as const;

/** Hard transport envelopes. Product retention and storage limits live in policy-v1. */
export const FILE_VERSION_CENTER_CONTRACT_LIMITS = Object.freeze({
  opaqueIdCharacters: 128,
  pathHintCharacters: 1_024,
  cursorCharacters: 512,
  idempotencyKeyCharacters: 128,
  timelineEntriesPerPage: 50,
  changeGroupEntries: 100,
  diffHunksPerPage: 64,
  diffLinesPerHunk: 500,
  diffLineCharacters: 16_384,
  deepLinkCharacters: 4_096,
  payloadBytes: 512 * 1_024,
} as const);

export const FILE_VERSION_CENTER_ERROR_CODES = Object.freeze({
  invalidRequest: 'FVRC_INVALID_REQUEST',
  unsupportedVersion: 'FVRC_UNSUPPORTED_VERSION',
  invalidTarget: 'FVRC_INVALID_TARGET',
  payloadTooLarge: 'FVRC_PAYLOAD_TOO_LARGE',
  accessDenied: 'FVRC_ACCESS_DENIED',
  notFound: 'FVRC_NOT_FOUND',
  capabilityUnavailable: 'FVRC_CAPABILITY_UNAVAILABLE',
  contentUnavailable: 'FVRC_CONTENT_UNAVAILABLE',
  staleCurrent: 'FVRC_STALE_CURRENT',
  staleSelection: 'FVRC_STALE_SELECTION',
  conflict: 'FVRC_CONFLICT',
  policyConflict: 'FVRC_POLICY_CONFLICT',
  rateLimited: 'FVRC_RATE_LIMITED',
  persistenceUnavailable: 'FVRC_PERSISTENCE_UNAVAILABLE',
  internal: 'FVRC_INTERNAL',
} as const);

export type FileVersionCenterErrorCode =
  (typeof FILE_VERSION_CENTER_ERROR_CODES)[keyof typeof FILE_VERSION_CENTER_ERROR_CODES];

export class FileVersionCenterContractError extends Error {
  constructor(
    readonly code: FileVersionCenterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileVersionCenterContractError';
  }
}

const opaqueIdPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const cursorPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$';
const sha256Pattern = '^[a-f0-9]{64}$';
const stateVectorHashPattern = '^[A-Za-z0-9_-]{16,256}$';

const ContractVersionSchema = Type.Literal(FILE_VERSION_CENTER_CONTRACT_VERSION);
const OpaqueIdSchema = Type.String({
  minLength: 1,
  maxLength: FILE_VERSION_CENTER_CONTRACT_LIMITS.opaqueIdCharacters,
  pattern: opaqueIdPattern,
});
const PathHintSchema = Type.String({
  minLength: 1,
  maxLength: FILE_VERSION_CENTER_CONTRACT_LIMITS.pathHintCharacters,
});
const CursorSchema = Type.String({
  minLength: 1,
  maxLength: FILE_VERSION_CENTER_CONTRACT_LIMITS.cursorCharacters,
  pattern: cursorPattern,
});
const Sha256Schema = Type.String({ pattern: sha256Pattern });
const IsoTimestampSchema = Type.String({ minLength: 20, maxLength: 64 });
const NullableOpaqueIdSchema = Type.Union([OpaqueIdSchema, Type.Null()]);

export const FileVersionCenterTargetSchemaV1 = Type.Union([
  Type.Object({
    kind: Type.Literal('lineage'),
    workspaceId: OpaqueIdSchema,
    lineageId: OpaqueIdSchema,
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('document'),
    workspaceId: OpaqueIdSchema,
    documentId: OpaqueIdSchema,
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('change_group'),
    workspaceId: OpaqueIdSchema,
    changeGroupId: OpaqueIdSchema,
    entryId: Type.Optional(OpaqueIdSchema),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('path'),
    workspaceId: OpaqueIdSchema,
    pathHint: PathHintSchema,
  }, { additionalProperties: false }),
]);

export type FileVersionCenterTargetV1 = Static<typeof FileVersionCenterTargetSchemaV1>;

export const FileVersionCenterSelectionSchemaV1 = Type.Union([
  Type.Object({ kind: Type.Literal('agent_operation'), id: OpaqueIdSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('revision'), id: OpaqueIdSchema }, { additionalProperties: false }),
]);

export type FileVersionCenterSelectionV1 = Static<typeof FileVersionCenterSelectionSchemaV1>;

export const FileVersionCenterRequestSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  target: FileVersionCenterTargetSchemaV1,
  selectedEntry: Type.Optional(FileVersionCenterSelectionSchemaV1),
  initialView: Type.Union([Type.Literal('reviews'), Type.Literal('history')]),
  source: Type.Union([
    Type.Literal('editor'),
    Type.Literal('file_browser'),
    Type.Literal('chat'),
    Type.Literal('notification'),
    Type.Literal('deep_link'),
  ]),
}, { additionalProperties: false });

export type FileVersionCenterRequestV1 = Static<typeof FileVersionCenterRequestSchemaV1>;

export const FileVersionCapabilitiesSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  history: Type.Boolean(),
  compare: Type.Boolean(),
  restore: Type.Boolean(),
  agentReviewPolicy: Type.Boolean(),
  preview: Type.Union([
    Type.Literal('markdown'),
    Type.Literal('text'),
    Type.Literal('structured'),
    Type.Literal('metadata'),
  ]),
  reason: Type.Optional(Type.Union([
    Type.Literal('unsupported_type'),
    Type.Literal('read_only'),
    Type.Literal('missing'),
    Type.Literal('policy_forced'),
    Type.Literal('rollout_disabled'),
    Type.Literal('read_only_rollout'),
    Type.Literal('limit_exceeded'),
    Type.Literal('storage_unavailable'),
  ])),
}, { additionalProperties: false });

export type FileVersionCapabilitiesV1 = Static<typeof FileVersionCapabilitiesSchemaV1>;

export const FileReviewPolicySchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  requestedMode: Type.Union([Type.Literal('review_required'), Type.Literal('safe_direct')]),
  effectiveMode: Type.Union([Type.Literal('review_required'), Type.Literal('safe_direct')]),
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  locked: Type.Boolean(),
  reason: Type.Union([
    Type.Literal('user_preference'),
    Type.Literal('default_review_required'),
    Type.Literal('default_safe_direct'),
    Type.Literal('explicit_review'),
    Type.Literal('hard_safety'),
    Type.Literal('workspace_policy'),
    Type.Literal('persistence_unavailable'),
  ]),
}, { additionalProperties: false });

export type FileReviewPolicyV1 = Static<typeof FileReviewPolicySchemaV1>;

export const FileReviewPolicyUpdateRequestSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  target: Type.Object({
    kind: Type.Literal('lineage'),
    workspaceId: OpaqueIdSchema,
    lineageId: OpaqueIdSchema,
  }, { additionalProperties: false }),
  requestedMode: Type.Union([Type.Literal('review_required'), Type.Literal('safe_direct')]),
  expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });

export type FileReviewPolicyUpdateRequestV1 = Static<typeof FileReviewPolicyUpdateRequestSchemaV1>;

const TimelineActorSchemaV1 = Type.Object({
  type: Type.Union([
    Type.Literal('user'),
    Type.Literal('agent'),
    Type.Literal('automation'),
    Type.Literal('system'),
  ]),
  id: Type.Optional(OpaqueIdSchema),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
}, { additionalProperties: false });

const RevisionSourceSchemaV1 = Type.Union([
  Type.Literal('initial'),
  Type.Literal('automatic_checkpoint'),
  Type.Literal('manual'),
  Type.Literal('agent_apply'),
  Type.Literal('restore'),
  Type.Literal('external_import'),
  Type.Literal('legacy_guest'),
]);

const RevisionContentSchemaV1 = Type.Object({
  availability: Type.Union([
    Type.Literal('available'),
    Type.Literal('metadata_only'),
    Type.Literal('corrupt'),
  ]),
  format: Type.Union([
    Type.Literal('markdown'),
    Type.Literal('text'),
    Type.Literal('structured'),
    Type.Literal('binary'),
  ]),
  sha256: Sha256Schema,
  sizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });

export const FileVersionTimelineEntrySchemaV1 = Type.Union([
  Type.Object({
    kind: Type.Literal('agent_operation'),
    id: OpaqueIdSchema,
    operationId: OpaqueIdSchema,
    createdAt: IsoTimestampSchema,
    actor: TimelineActorSchemaV1,
    status: Type.Union([
      Type.Literal('preparing'),
      Type.Literal('ready'),
      Type.Literal('applying'),
      Type.Literal('needs_review'),
      Type.Literal('partially_applied'),
      Type.Literal('semantic_conflict'),
      Type.Literal('applied_to_ydoc'),
      Type.Literal('persisted_yjs'),
      Type.Literal('checkpointed_file'),
      Type.Literal('rejected'),
      Type.Literal('reverted'),
      Type.Literal('cancelled'),
      Type.Literal('expired'),
      Type.Literal('failed'),
    ]),
    proposalVersion: Type.Optional(NullableOpaqueIdSchema),
    additions: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    deletions: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    actionsAllowed: Type.Boolean(),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('current'),
    id: Type.Literal('current'),
    observedAt: IsoTimestampSchema,
    revisionId: NullableOpaqueIdSchema,
    stateVectorHash: Type.Optional(Type.String({ pattern: stateVectorHashPattern })),
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('revision'),
    id: OpaqueIdSchema,
    revisionId: OpaqueIdSchema,
    revisionNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    createdAt: IsoTimestampSchema,
    source: RevisionSourceSchemaV1,
    actor: TimelineActorSchemaV1,
    content: RevisionContentSchemaV1,
    restorable: Type.Boolean(),
  }, { additionalProperties: false }),
]);

export type FileVersionTimelineEntryV1 = Static<typeof FileVersionTimelineEntrySchemaV1>;

const PageSchemaV1 = Type.Object({
  hasMore: Type.Boolean(),
  nextCursor: Type.Union([CursorSchema, Type.Null()]),
}, { additionalProperties: false });

export const FileVersionTimelineRequestSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  target: FileVersionCenterTargetSchemaV1,
  cursor: Type.Optional(CursorSchema),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: FILE_VERSION_CENTER_CONTRACT_LIMITS.timelineEntriesPerPage,
  })),
}, { additionalProperties: false });

export type FileVersionTimelineRequestV1 = Static<typeof FileVersionTimelineRequestSchemaV1>;

export const FileVersionTimelineResponseSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  document: Type.Object({
    workspaceId: OpaqueIdSchema,
    lineageId: OpaqueIdSchema,
    documentId: Type.Optional(NullableOpaqueIdSchema),
    path: PathHintSchema,
  }, { additionalProperties: false }),
  capabilities: FileVersionCapabilitiesSchemaV1,
  policy: Type.Optional(FileReviewPolicySchemaV1),
  entries: Type.Array(FileVersionTimelineEntrySchemaV1, {
    maxItems: FILE_VERSION_CENTER_CONTRACT_LIMITS.timelineEntriesPerPage,
  }),
  page: PageSchemaV1,
}, { additionalProperties: false });

export type FileVersionTimelineResponseV1 = Static<typeof FileVersionTimelineResponseSchemaV1>;

export const FileVersionCurrentFenceSchemaV1 = Type.Object({
  revisionId: NullableOpaqueIdSchema,
  sha256: Sha256Schema,
  stateVectorHash: Type.Optional(Type.String({ pattern: stateVectorHashPattern })),
}, { additionalProperties: false });

export type FileVersionCurrentFenceV1 = Static<typeof FileVersionCurrentFenceSchemaV1>;

export const FileVersionCompareRequestSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  target: FileVersionCenterTargetSchemaV1,
  candidate: FileVersionCenterSelectionSchemaV1,
  expectedCurrent: FileVersionCurrentFenceSchemaV1,
  cursor: Type.Optional(CursorSchema),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: FILE_VERSION_CENTER_CONTRACT_LIMITS.diffHunksPerPage,
  })),
}, { additionalProperties: false });

export type FileVersionCompareRequestV1 = Static<typeof FileVersionCompareRequestSchemaV1>;

const DiffLineSchemaV1 = Type.Object({
  kind: Type.Union([Type.Literal('context'), Type.Literal('addition'), Type.Literal('deletion')]),
  oldLineNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  newLineNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  text: Type.String({ maxLength: FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters }),
}, { additionalProperties: false });

export const FileVersionDiffHunkSchemaV1 = Type.Object({
  id: OpaqueIdSchema,
  oldStart: Type.Integer({ minimum: 1 }),
  oldLines: Type.Integer({ minimum: 0 }),
  newStart: Type.Integer({ minimum: 1 }),
  newLines: Type.Integer({ minimum: 0 }),
  lines: Type.Array(DiffLineSchemaV1, {
    maxItems: FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLinesPerHunk,
  }),
}, { additionalProperties: false });

export type FileVersionDiffHunkV1 = Static<typeof FileVersionDiffHunkSchemaV1>;

export const FileVersionCompareResponseSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  current: Type.Object({
    fence: FileVersionCurrentFenceSchemaV1,
    observedAt: IsoTimestampSchema,
  }, { additionalProperties: false }),
  candidate: Type.Object({
    selection: FileVersionCenterSelectionSchemaV1,
    stale: Type.Boolean(),
    contentAvailable: Type.Boolean(),
  }, { additionalProperties: false }),
  summary: Type.Object({
    additions: Type.Integer({ minimum: 0 }),
    deletions: Type.Integer({ minimum: 0 }),
    unchanged: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  hunks: Type.Array(FileVersionDiffHunkSchemaV1, {
    maxItems: FILE_VERSION_CENTER_CONTRACT_LIMITS.diffHunksPerPage,
  }),
  page: PageSchemaV1,
  truncated: Type.Boolean(),
}, { additionalProperties: false });

export type FileVersionCompareResponseV1 = Static<typeof FileVersionCompareResponseSchemaV1>;

export const FileVersionRestoreRequestSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  target: FileVersionCenterTargetSchemaV1,
  revisionId: OpaqueIdSchema,
  expectedCurrent: FileVersionCurrentFenceSchemaV1,
  idempotencyKey: Type.String({
    minLength: 16,
    maxLength: FILE_VERSION_CENTER_CONTRACT_LIMITS.idempotencyKeyCharacters,
    pattern: opaqueIdPattern,
  }),
}, { additionalProperties: false });

export type FileVersionRestoreRequestV1 = Static<typeof FileVersionRestoreRequestSchemaV1>;

export const FileVersionRestoreResponseSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  outcome: Type.Union([Type.Literal('restored'), Type.Literal('already_restored')]),
  priorRevisionId: NullableOpaqueIdSchema,
  restoredRevisionId: OpaqueIdSchema,
  current: FileVersionCurrentFenceSchemaV1,
}, { additionalProperties: false });

export type FileVersionRestoreResponseV1 = Static<typeof FileVersionRestoreResponseSchemaV1>;

export const FileChangeGroupEntrySchemaV1 = Type.Object({
  id: OpaqueIdSchema,
  ordinal: Type.Integer({ minimum: 0, maximum: FILE_VERSION_CENTER_CONTRACT_LIMITS.changeGroupEntries - 1 }),
  lineageId: Type.Optional(NullableOpaqueIdSchema),
  documentId: Type.Optional(NullableOpaqueIdSchema),
  operationId: Type.Optional(NullableOpaqueIdSchema),
  revisionId: Type.Optional(NullableOpaqueIdSchema),
  pathHint: PathHintSchema,
  outcome: Type.Union([
    Type.Literal('applied'),
    Type.Literal('review_required'),
    Type.Literal('conflict'),
    Type.Literal('failed'),
  ]),
  additions: Type.Optional(Type.Integer({ minimum: 0 })),
  deletions: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export type FileChangeGroupEntryV1 = Static<typeof FileChangeGroupEntrySchemaV1>;

export const FileChangeGroupSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  id: OpaqueIdSchema,
  workspaceId: OpaqueIdSchema,
  sourceSessionId: OpaqueIdSchema,
  toolCallId: OpaqueIdSchema,
  operation: Type.Union([
    Type.Literal('write'),
    Type.Literal('edit_file'),
    Type.Literal('apply_patch'),
  ]),
  status: Type.Union([
    Type.Literal('applied'),
    Type.Literal('review_required'),
    Type.Literal('conflict'),
    Type.Literal('failed'),
    Type.Literal('mixed'),
  ]),
  createdAt: IsoTimestampSchema,
  entries: Type.Array(FileChangeGroupEntrySchemaV1, {
    minItems: 1,
    maxItems: FILE_VERSION_CENTER_CONTRACT_LIMITS.changeGroupEntries,
  }),
}, { additionalProperties: false });

export type FileChangeGroupV1 = Static<typeof FileChangeGroupSchemaV1>;

export const FileVersionCenterErrorResponseSchemaV1 = Type.Object({
  contractVersion: ContractVersionSchema,
  success: Type.Literal(false),
  error: Type.Object({
    code: Type.Union(Object.values(FILE_VERSION_CENTER_ERROR_CODES).map((code) => Type.Literal(code))),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    retryable: Type.Boolean(),
    requestId: Type.Optional(OpaqueIdSchema),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type FileVersionCenterErrorResponseV1 = Static<typeof FileVersionCenterErrorResponseSchemaV1>;

export const FILE_VERSION_CENTER_API_V1 = Object.freeze({
  resolve: '/api/files/version-center/v1/resolve',
  timeline: '/api/files/version-center/v1/timeline',
  compare: '/api/files/version-center/v1/compare',
  restore: '/api/files/version-center/v1/restore',
  policy: '/api/files/version-center/v1/policy',
  changeGroup: '/api/files/version-center/v1/change-groups',
} as const);

const forbiddenReferenceKeys = new Set([
  'absolutePath',
  'afterContent',
  'authorization',
  'beforeContent',
  'content',
  'directEditGrant',
  'grant',
  'grantId',
  'serverPath',
  'token',
]);

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
      'The file version center payload must be JSON serializable.',
    );
  }
}

function assertNoForbiddenReferenceFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenReferenceFields(item);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenReferenceKeys.has(key)) {
      throw new FileVersionCenterContractError(
        FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
        `Field ${key} is not allowed in a serializable file version center reference.`,
      );
    }
    assertNoForbiddenReferenceFields(child);
  }
}

export function isSafeFileVersionPathHint(pathHint: string): boolean {
  if (!pathHint || pathHint.length > FILE_VERSION_CENTER_CONTRACT_LIMITS.pathHintCharacters) return false;
  if (/^[\\/]/u.test(pathHint) || /^[A-Za-z]:[\\/]/u.test(pathHint) || /^[a-z][a-z0-9+.-]*:/iu.test(pathHint)) return false;
  if (/[\\\u0000-\u001f\u007f]/u.test(pathHint)) return false;
  const segments = pathHint.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function assertFileVersionCenterContractV1<T extends TSchema>(
  schema: T,
  value: unknown,
): asserts value is Static<T> {
  const bytes = jsonBytes(value);
  if (bytes > FILE_VERSION_CENTER_CONTRACT_LIMITS.payloadBytes) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.payloadTooLarge,
      'The file version center payload exceeds the contract limit.',
    );
  }
  if (!Value.Check(schema, value)) {
    const version = value && typeof value === 'object'
      ? (value as { contractVersion?: unknown }).contractVersion
      : undefined;
    throw new FileVersionCenterContractError(
      version !== undefined && version !== FILE_VERSION_CENTER_CONTRACT_VERSION
        ? FILE_VERSION_CENTER_ERROR_CODES.unsupportedVersion
        : FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
      'The file version center payload does not match contract version 1.',
    );
  }
  const target = value && typeof value === 'object'
    ? (value as { target?: { kind?: unknown; pathHint?: unknown } }).target
    : undefined;
  if (target?.kind === 'path' && (typeof target.pathHint !== 'string' || !isSafeFileVersionPathHint(target.pathHint))) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
      'The file version center path hint must be workspace-relative and normalized.',
    );
  }
}

export function parseFileVersionCenterRequestV1(value: unknown): FileVersionCenterRequestV1 {
  assertNoForbiddenReferenceFields(value);
  assertFileVersionCenterContractV1(FileVersionCenterRequestSchemaV1, value);
  return value;
}

export function parseFileVersionTimelineRequestV1(value: unknown): FileVersionTimelineRequestV1 {
  assertNoForbiddenReferenceFields(value);
  assertFileVersionCenterContractV1(FileVersionTimelineRequestSchemaV1, value);
  return value;
}

export function parseFileVersionCompareRequestV1(value: unknown): FileVersionCompareRequestV1 {
  assertNoForbiddenReferenceFields(value);
  assertFileVersionCenterContractV1(FileVersionCompareRequestSchemaV1, value);
  return value;
}

export function parseFileVersionRestoreRequestV1(value: unknown): FileVersionRestoreRequestV1 {
  assertNoForbiddenReferenceFields(value);
  assertFileVersionCenterContractV1(FileVersionRestoreRequestSchemaV1, value);
  return value;
}

export function parseFileReviewPolicyUpdateRequestV1(value: unknown): FileReviewPolicyUpdateRequestV1 {
  assertNoForbiddenReferenceFields(value);
  assertFileVersionCenterContractV1(FileReviewPolicyUpdateRequestSchemaV1, value);
  return value;
}

export function parseFileChangeGroupV1(value: unknown): FileChangeGroupV1 {
  assertNoForbiddenReferenceFields(value);
  assertFileVersionCenterContractV1(FileChangeGroupSchemaV1, value);
  if (value.entries.some((entry) => !isSafeFileVersionPathHint(entry.pathHint))) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
      'Change group path hints must be workspace-relative and normalized.',
    );
  }
  const ordinals = value.entries.map((entry) => entry.ordinal);
  if (ordinals.some((ordinal, index) => ordinal !== index)) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
      'Change group entry ordinals must be contiguous and start at zero.',
    );
  }
  return value;
}

export function parseFileVersionTimelineResponseV1(value: unknown): FileVersionTimelineResponseV1 {
  assertFileVersionCenterContractV1(FileVersionTimelineResponseSchemaV1, value);
  if (!isSafeFileVersionPathHint(value.document.path)) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
      'Timeline document paths must be workspace-relative and normalized.',
    );
  }
  return value;
}

export function parseFileVersionCompareResponseV1(value: unknown): FileVersionCompareResponseV1 {
  assertFileVersionCenterContractV1(FileVersionCompareResponseSchemaV1, value);
  return value;
}

export function parseFileVersionRestoreResponseV1(value: unknown): FileVersionRestoreResponseV1 {
  assertFileVersionCenterContractV1(FileVersionRestoreResponseSchemaV1, value);
  return value;
}

export function parseFileVersionCapabilitiesV1(value: unknown): FileVersionCapabilitiesV1 {
  assertFileVersionCenterContractV1(FileVersionCapabilitiesSchemaV1, value);
  return value;
}

export function parseFileReviewPolicyV1(value: unknown): FileReviewPolicyV1 {
  assertFileVersionCenterContractV1(FileReviewPolicySchemaV1, value);
  return value;
}

export function parseFileVersionCenterErrorResponseV1(value: unknown): FileVersionCenterErrorResponseV1 {
  assertFileVersionCenterContractV1(FileVersionCenterErrorResponseSchemaV1, value);
  return value;
}
