export const COLLABORATION_CHECKPOINT_ERROR_CODES = {
  schemaInvalid: 'COLLABORATION_SCHEMA_INVALID',
  stableIdMissing: 'COLLABORATION_STABLE_ID_MISSING',
  stableIdDuplicate: 'COLLABORATION_STABLE_ID_DUPLICATE',
  roundtripUnstable: 'COLLABORATION_ROUNDTRIP_UNSTABLE',
  superseded: 'COLLABORATION_CHECKPOINT_SUPERSEDED',
  failed: 'COLLABORATION_CHECKPOINT_FAILED',
} as const;

export type RichMarkdownCheckpointValidationCode =
  | 'schema_invalid'
  | 'stable_id_missing'
  | 'stable_id_duplicate'
  | 'roundtrip_unstable';

export type CollaborationCheckpointErrorCode =
  typeof COLLABORATION_CHECKPOINT_ERROR_CODES[keyof typeof COLLABORATION_CHECKPOINT_ERROR_CODES];

const VALIDATION_ERROR_CODES: Record<
  RichMarkdownCheckpointValidationCode,
  CollaborationCheckpointErrorCode
> = {
  schema_invalid: COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid,
  stable_id_missing: COLLABORATION_CHECKPOINT_ERROR_CODES.stableIdMissing,
  stable_id_duplicate: COLLABORATION_CHECKPOINT_ERROR_CODES.stableIdDuplicate,
  roundtrip_unstable: COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable,
};

const VALIDATION_ERROR_CODE_SET = new Set<CollaborationCheckpointErrorCode>(
  Object.values(VALIDATION_ERROR_CODES),
);

export class CollaborationCheckpointValidationError extends Error {
  readonly code: CollaborationCheckpointErrorCode;

  constructor(readonly validationCode: RichMarkdownCheckpointValidationCode) {
    super(`Rich collaboration checkpoint validation failed (${validationCode}).`);
    this.name = 'CollaborationCheckpointValidationError';
    this.code = VALIDATION_ERROR_CODES[validationCode];
  }
}

export class CollaborationCheckpointRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CollaborationCheckpointRequestError';
  }
}

export function isCollaborationCheckpointValidationErrorCode(
  code: string,
): code is CollaborationCheckpointErrorCode {
  return VALIDATION_ERROR_CODE_SET.has(code as CollaborationCheckpointErrorCode);
}

export function collaborationCheckpointValidationFailure(error: unknown): {
  status: 422;
  code: CollaborationCheckpointErrorCode;
  validationCode: RichMarkdownCheckpointValidationCode;
  message: string;
} | null {
  if (!(error instanceof CollaborationCheckpointValidationError)) return null;
  return {
    status: 422,
    code: error.code,
    validationCode: error.validationCode,
    message: 'The rich-text document could not be safely synchronized.',
  };
}
