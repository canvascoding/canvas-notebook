export const SYSTEM_UPDATE_CONTRACT_VERSION = 1 as const;

export const SYSTEM_UPDATE_OPERATION_STATUSES = [
  'queued',
  'preflight',
  'running',
  'reconnecting',
  'verifying',
  'succeeded',
  'rolled_back',
  'failed',
  'indeterminate',
] as const;

export const SYSTEM_UPDATE_STAGES = [
  'request_validation',
  'operation_lock',
  'release_verification',
  'host_cli_capabilities',
  'config_preflight',
  'database_preflight',
  'backup',
  'image_pull',
  'container_recreate',
  'health_verification',
  'version_verification',
  'rollback',
  'completed',
] as const;

export const SYSTEM_UPDATE_STAGE_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;

export const SYSTEM_UPDATE_RELEASE_CHANNELS = ['stable', 'beta'] as const;
export const SYSTEM_UPDATE_ARCHITECTURES = ['amd64', 'arm64'] as const;
export const SYSTEM_UPDATE_SIGNATURE_ALGORITHMS = ['ed25519'] as const;

export const SYSTEM_UPDATE_ERROR_CODES = [
  'request_invalid',
  'operation_conflict',
  'release_unavailable',
  'release_manifest_invalid',
  'release_signature_invalid',
  'release_incompatible',
  'host_cli_failed',
  'database_preflight_failed',
  'backup_failed',
  'image_pull_failed',
  'container_recreate_failed',
  'health_verification_failed',
  'version_verification_failed',
  'rollback_failed',
  'deadline_exceeded',
  'operation_interrupted',
  'update_execution_failed',
] as const;

export type SystemUpdateOperationStatus = typeof SYSTEM_UPDATE_OPERATION_STATUSES[number];
export type SystemUpdateStage = typeof SYSTEM_UPDATE_STAGES[number];
export type SystemUpdateStageStatus = typeof SYSTEM_UPDATE_STAGE_STATUSES[number];
export type SystemUpdateReleaseChannel = typeof SYSTEM_UPDATE_RELEASE_CHANNELS[number];
export type SystemUpdateArchitecture = typeof SYSTEM_UPDATE_ARCHITECTURES[number];
export type SystemUpdateSignatureAlgorithm = typeof SYSTEM_UPDATE_SIGNATURE_ALGORITHMS[number];
export type SystemUpdateErrorCode = typeof SYSTEM_UPDATE_ERROR_CODES[number];

export interface SystemUpdateCliArtifact {
  architecture: SystemUpdateArchitecture;
  url: string;
  sha256: string;
}

export interface SystemUpdateReleaseManifest {
  contractVersion: typeof SYSTEM_UPDATE_CONTRACT_VERSION;
  releaseId: string;
  version: string;
  channel: SystemUpdateReleaseChannel;
  imageRef: string;
  imageDigest: string;
  cliVersion: string;
  cliArtifacts: SystemUpdateCliArtifact[];
  minimumVersion: string | null;
  backupRequired: boolean;
  releaseNotesUrl: string | null;
  publishedAt: string;
}

export interface SystemUpdateManifestSignature {
  algorithm: SystemUpdateSignatureAlgorithm;
  keyId: string;
  value: string;
}

export interface SystemUpdateSignedReleaseManifest {
  manifest: SystemUpdateReleaseManifest;
  signature: SystemUpdateManifestSignature;
}

export interface SystemUpdateEvent {
  contractVersion: typeof SYSTEM_UPDATE_CONTRACT_VERSION;
  eventId: string;
  sequence: number;
  operationId: string;
  stage: SystemUpdateStage;
  status: SystemUpdateStageStatus;
  message: string;
  occurredAt: string;
  errorCode?: SystemUpdateErrorCode;
}

export interface SystemUpdateOperation {
  contractVersion: typeof SYSTEM_UPDATE_CONTRACT_VERSION;
  operationId: string;
  status: SystemUpdateOperationStatus;
  stage: SystemUpdateStage;
  targetVersion: string;
  targetImageRef: string;
  currentVersion: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  rolledBack: boolean;
  errorCode: SystemUpdateErrorCode | null;
  error: string | null;
  lastSequence: number;
}

export type SystemUpdateValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PINNED_IMAGE_PATTERN = /@sha256:([a-f0-9]{64})$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;

const TERMINAL_OPERATION_STATUSES = new Set<SystemUpdateOperationStatus>([
  'succeeded',
  'rolled_back',
  'failed',
  'indeterminate',
]);

const OPERATION_TRANSITIONS: Record<SystemUpdateOperationStatus, readonly SystemUpdateOperationStatus[]> = {
  queued: ['preflight', 'running', 'failed', 'indeterminate'],
  preflight: ['running', 'failed', 'indeterminate'],
  running: ['reconnecting', 'verifying', 'rolled_back', 'failed', 'indeterminate'],
  reconnecting: ['running', 'verifying', 'rolled_back', 'failed', 'indeterminate'],
  verifying: ['succeeded', 'rolled_back', 'failed', 'indeterminate'],
  succeeded: [],
  rolled_back: [],
  failed: [],
  indeterminate: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\0\r\n]/u.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function parseCliArtifact(value: unknown): SystemUpdateCliArtifact | null {
  if (!isRecord(value)) return null;
  if (!isMember(SYSTEM_UPDATE_ARCHITECTURES, value.architecture)) return null;
  if (!isHttpsUrl(value.url)) return null;
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) return null;
  return {
    architecture: value.architecture,
    url: value.url,
    sha256: value.sha256,
  };
}

export function isTerminalSystemUpdateStatus(status: SystemUpdateOperationStatus): boolean {
  return TERMINAL_OPERATION_STATUSES.has(status);
}

export function canTransitionSystemUpdateStatus(
  from: SystemUpdateOperationStatus,
  to: SystemUpdateOperationStatus,
): boolean {
  return from === to || OPERATION_TRANSITIONS[from].includes(to);
}

export function validateSystemUpdateReleaseManifest(
  input: unknown,
): SystemUpdateValidationResult<SystemUpdateReleaseManifest> {
  if (!isRecord(input)) return { ok: false, error: 'Release manifest must be an object.' };
  if (input.contractVersion !== SYSTEM_UPDATE_CONTRACT_VERSION) {
    return { ok: false, error: 'Unsupported release manifest contract version.' };
  }
  if (!isBoundedString(input.releaseId, 128)) return { ok: false, error: 'Release ID is invalid.' };
  if (typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)) {
    return { ok: false, error: 'Release version is invalid.' };
  }
  if (!isMember(SYSTEM_UPDATE_RELEASE_CHANNELS, input.channel)) {
    return { ok: false, error: 'Release channel is invalid.' };
  }
  if (typeof input.imageDigest !== 'string' || !SHA256_PATTERN.test(input.imageDigest)) {
    return { ok: false, error: 'Release image digest is invalid.' };
  }
  if (!isBoundedString(input.imageRef, 512)) return { ok: false, error: 'Release image reference is invalid.' };
  const imageDigest = PINNED_IMAGE_PATTERN.exec(input.imageRef)?.[1];
  if (!imageDigest || imageDigest !== input.imageDigest) {
    return { ok: false, error: 'Release image reference must match its immutable digest.' };
  }
  if (typeof input.cliVersion !== 'string' || !VERSION_PATTERN.test(input.cliVersion)) {
    return { ok: false, error: 'Release CLI version is invalid.' };
  }
  if (!Array.isArray(input.cliArtifacts) || input.cliArtifacts.length < 1 || input.cliArtifacts.length > 4) {
    return { ok: false, error: 'Release CLI artifacts are invalid.' };
  }
  const cliArtifacts = input.cliArtifacts.map(parseCliArtifact);
  if (cliArtifacts.some((artifact) => artifact === null)) {
    return { ok: false, error: 'Release CLI artifact is invalid.' };
  }
  const architectures = new Set(cliArtifacts.map((artifact) => artifact!.architecture));
  if (architectures.size !== cliArtifacts.length) {
    return { ok: false, error: 'Release CLI artifact architectures must be unique.' };
  }
  if (input.minimumVersion !== null && (typeof input.minimumVersion !== 'string' || !VERSION_PATTERN.test(input.minimumVersion))) {
    return { ok: false, error: 'Release minimum version is invalid.' };
  }
  if (typeof input.backupRequired !== 'boolean') return { ok: false, error: 'Release backup policy is invalid.' };
  if (input.releaseNotesUrl !== null && !isHttpsUrl(input.releaseNotesUrl)) {
    return { ok: false, error: 'Release notes URL is invalid.' };
  }
  if (!isIsoTimestamp(input.publishedAt)) return { ok: false, error: 'Release publication timestamp is invalid.' };

  return {
    ok: true,
    value: {
      contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
      releaseId: input.releaseId,
      version: input.version,
      channel: input.channel,
      imageRef: input.imageRef,
      imageDigest: input.imageDigest,
      cliVersion: input.cliVersion,
      cliArtifacts: cliArtifacts as SystemUpdateCliArtifact[],
      minimumVersion: input.minimumVersion as string | null,
      backupRequired: input.backupRequired,
      releaseNotesUrl: input.releaseNotesUrl as string | null,
      publishedAt: input.publishedAt,
    },
  };
}

export function canonicalizeSystemUpdateReleaseManifest(manifest: SystemUpdateReleaseManifest): string {
  return JSON.stringify({
    contractVersion: manifest.contractVersion,
    releaseId: manifest.releaseId,
    version: manifest.version,
    channel: manifest.channel,
    imageRef: manifest.imageRef,
    imageDigest: manifest.imageDigest,
    cliVersion: manifest.cliVersion,
    cliArtifacts: [...manifest.cliArtifacts]
      .sort((left, right) => left.architecture.localeCompare(right.architecture))
      .map((artifact) => ({
        architecture: artifact.architecture,
        url: artifact.url,
        sha256: artifact.sha256,
      })),
    minimumVersion: manifest.minimumVersion,
    backupRequired: manifest.backupRequired,
    releaseNotesUrl: manifest.releaseNotesUrl,
    publishedAt: manifest.publishedAt,
  });
}

export function validateSystemUpdateSignedReleaseManifest(
  input: unknown,
): SystemUpdateValidationResult<SystemUpdateSignedReleaseManifest> {
  if (!isRecord(input)) return { ok: false, error: 'Signed release manifest must be an object.' };
  const manifest = validateSystemUpdateReleaseManifest(input.manifest);
  if (!manifest.ok) return manifest;
  if (!isRecord(input.signature)) return { ok: false, error: 'Release manifest signature is invalid.' };
  if (!isMember(SYSTEM_UPDATE_SIGNATURE_ALGORITHMS, input.signature.algorithm)) {
    return { ok: false, error: 'Release manifest signature algorithm is invalid.' };
  }
  if (!isBoundedString(input.signature.keyId, 128)) {
    return { ok: false, error: 'Release manifest signing key ID is invalid.' };
  }
  if (typeof input.signature.value !== 'string' || !ED25519_SIGNATURE_PATTERN.test(input.signature.value)) {
    return { ok: false, error: 'Release manifest signature value is invalid.' };
  }
  return {
    ok: true,
    value: {
      manifest: manifest.value,
      signature: {
        algorithm: input.signature.algorithm,
        keyId: input.signature.keyId,
        value: input.signature.value,
      },
    },
  };
}

export function validateSystemUpdateEvent(input: unknown): SystemUpdateValidationResult<SystemUpdateEvent> {
  if (!isRecord(input)) return { ok: false, error: 'Update event must be an object.' };
  if (input.contractVersion !== SYSTEM_UPDATE_CONTRACT_VERSION) {
    return { ok: false, error: 'Unsupported update event contract version.' };
  }
  if (typeof input.eventId !== 'string' || !UUID_PATTERN.test(input.eventId)) {
    return { ok: false, error: 'Update event ID is invalid.' };
  }
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 0) {
    return { ok: false, error: 'Update event sequence is invalid.' };
  }
  if (typeof input.operationId !== 'string' || !UUID_PATTERN.test(input.operationId)) {
    return { ok: false, error: 'Update operation ID is invalid.' };
  }
  if (!isMember(SYSTEM_UPDATE_STAGES, input.stage)) return { ok: false, error: 'Update event stage is invalid.' };
  if (!isMember(SYSTEM_UPDATE_STAGE_STATUSES, input.status)) return { ok: false, error: 'Update event status is invalid.' };
  if (!isBoundedString(input.message, 2048)) return { ok: false, error: 'Update event message is invalid.' };
  if (!isIsoTimestamp(input.occurredAt)) return { ok: false, error: 'Update event timestamp is invalid.' };
  if (input.errorCode !== undefined && !isMember(SYSTEM_UPDATE_ERROR_CODES, input.errorCode)) {
    return { ok: false, error: 'Update event error code is invalid.' };
  }

  return {
    ok: true,
    value: {
      contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
      eventId: input.eventId,
      sequence: Number(input.sequence),
      operationId: input.operationId,
      stage: input.stage,
      status: input.status,
      message: input.message,
      occurredAt: input.occurredAt,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    },
  };
}
