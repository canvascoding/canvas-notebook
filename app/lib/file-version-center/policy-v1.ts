import {
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  type FileReviewPolicyV1,
  type FileVersionCapabilitiesV1,
} from './contracts/v1';

export const FILE_VERSION_CENTER_ROLLOUT_ENV_V1 = Object.freeze({
  mode: 'FILE_VERSION_CENTER_MODE',
} as const);

export const FILE_VERSION_CENTER_LIMITS_V1 = Object.freeze({
  maxRawVersionBytes: 1 * 1024 * 1024,
  maxStoredBlobBytes: (1 * 1024 * 1024) + (64 * 1024),
  maxCompressedBytesPerLineage: 128 * 1024 * 1024,
  maxCompressedBytesPerWorkspace: 4 * 1024 * 1024 * 1024,
  maxVersionsPerLineage: 500,
  minNewestVersionsPerLineage: 100,
  automaticCheckpointIntervalSeconds: 60,
  automaticCheckpointRetentionDays: 90,
  archivedLineageGraceDays: 30,
  auditMetadataRetentionDays: 365,
  maxCompareBytesPerSide: 1 * 1024 * 1024,
  maxCompareCombinedBytes: 2 * 1024 * 1024,
  maxCompareLinesPerSide: 20_000,
  maxDiffHunks: 2_000,
} as const);

export const FILE_VERSION_CENTER_RATE_LIMITS_V1 = Object.freeze({
  resolve: Object.freeze({ perUserPerMinute: 120, perIpPerMinute: 600 }),
  timeline: Object.freeze({ perUserPerMinute: 120, perIpPerMinute: 600 }),
  compare: Object.freeze({ perUserPerMinute: 30, perIpPerMinute: 120 }),
  restore: Object.freeze({ perUserPerMinute: 10, perIpPerMinute: 60 }),
  policyMutation: Object.freeze({ perUserPerMinute: 30, perIpPerMinute: 120 }),
  reviewMutation: Object.freeze({ perUserPerMinute: 30, perIpPerMinute: 120 }),
  toolAppRefresh: Object.freeze({ perUserPerMinute: 60, perIpPerMinute: 240 }),
} as const);

export const FILE_VERSION_CENTER_PROTECTED_SOURCES_V1 = Object.freeze([
  'initial',
  'manual',
  'agent_apply',
  'restore',
  'external_import',
  'legacy_guest',
] as const);

export type FileVersionProtectedSourceV1 =
  (typeof FILE_VERSION_CENTER_PROTECTED_SOURCES_V1)[number];

export type FileVersionRolloutModeV1 = 'off' | 'shadow' | 'read_only' | 'full';

export type FileVersionRolloutDecisionV1 = {
  mode: FileVersionRolloutModeV1;
  capture: boolean;
  visibleUi: boolean;
  history: boolean;
  compare: boolean;
  restore: boolean;
  policyMutation: boolean;
  notifications: boolean;
};

export function resolveFileVersionRolloutModeV1(
  value: string | null | undefined,
): FileVersionRolloutModeV1 {
  if (value === 'shadow' || value === 'read_only' || value === 'full') return value;
  return 'off';
}

export function resolveFileVersionRolloutV1(
  value: string | null | undefined,
): FileVersionRolloutDecisionV1 {
  const mode = resolveFileVersionRolloutModeV1(value);
  return {
    mode,
    capture: mode === 'shadow' || mode === 'read_only' || mode === 'full',
    visibleUi: mode === 'read_only' || mode === 'full',
    history: mode === 'read_only' || mode === 'full',
    compare: mode === 'read_only' || mode === 'full',
    restore: mode === 'full',
    policyMutation: mode === 'full',
    notifications: mode === 'full',
  };
}

export type FileVersionFileClassV1 =
  | 'markdown'
  | 'text'
  | 'code'
  | 'office'
  | 'binary';

const MARKDOWN_EXTENSIONS_V1 = new Set(['md', 'markdown']);
const TEXT_EXTENSIONS_V1 = new Set(['txt']);
const CODE_EXTENSIONS_V1 = new Set([
  'css', 'go', 'graphql', 'html', 'java', 'js', 'json', 'jsx', 'mdx', 'py',
  'rb', 'rs', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx', 'xml', 'yaml', 'yml',
]);
const OFFICE_EXTENSIONS_V1 = new Set([
  'csv', 'doc', 'docx', 'odp', 'ods', 'odt', 'ppt', 'pptx', 'xls', 'xlsx',
]);

function normalizedExtensionV1(pathHint: string): string {
  const filename = pathHint.split('/').at(-1) ?? '';
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : '';
}

export function classifyFileVersionFileV1(pathHint: string): FileVersionFileClassV1 {
  const extension = normalizedExtensionV1(pathHint);
  if (MARKDOWN_EXTENSIONS_V1.has(extension)) return 'markdown';
  if (TEXT_EXTENSIONS_V1.has(extension)) return 'text';
  if (CODE_EXTENSIONS_V1.has(extension)) return 'code';
  if (OFFICE_EXTENSIONS_V1.has(extension)) return 'office';
  return 'binary';
}

export type FileVersionScopeInputV1 = {
  authenticatedWorkspaceId: string;
  requestedWorkspaceId: string;
  resolvedWorkspaceId: string | null;
  membership: 'active' | 'revoked' | 'unknown';
  permissionsResolved: boolean;
  canRead: boolean;
};

/**
 * Must run before revealing whether a target, lineage, revision, or operation exists.
 */
export function assertFileVersionScopeV1(input: FileVersionScopeInputV1): void {
  const sameWorkspace = input.requestedWorkspaceId === input.authenticatedWorkspaceId
    && input.resolvedWorkspaceId === input.authenticatedWorkspaceId;
  if (
    !sameWorkspace
    || input.membership !== 'active'
    || !input.permissionsResolved
    || !input.canRead
  ) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
      'File version target is not available in the active workspace.',
    );
  }
}

export type FileVersionBackendReadinessV1 = {
  storageReady: boolean;
  compareReady: boolean;
  restoreReady: boolean;
  policyReady: boolean;
};

export type ResolveFileVersionCapabilitiesInputV1 = {
  pathHint: string;
  sizeBytes: number;
  lineageAvailable: boolean;
  canRead: boolean;
  canWrite: boolean;
  rolloutMode: FileVersionRolloutModeV1;
  backends: FileVersionBackendReadinessV1;
};

function unavailableCapabilitiesV1(
  preview: FileVersionCapabilitiesV1['preview'],
  reason: NonNullable<FileVersionCapabilitiesV1['reason']>,
): FileVersionCapabilitiesV1 {
  return {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    history: false,
    compare: false,
    restore: false,
    agentReviewPolicy: false,
    preview,
    reason,
  };
}

export function resolveFileVersionCapabilitiesV1(
  input: ResolveFileVersionCapabilitiesInputV1,
): FileVersionCapabilitiesV1 {
  const fileClass = classifyFileVersionFileV1(input.pathHint);
  const preview = fileClass === 'markdown' ? 'markdown'
    : fileClass === 'text' ? 'text'
      : 'metadata';

  if (fileClass !== 'markdown' && fileClass !== 'text') {
    return unavailableCapabilitiesV1(preview, 'unsupported_type');
  }
  if (!input.canRead || !input.lineageAvailable) {
    return unavailableCapabilitiesV1(preview, input.canRead ? 'missing' : 'read_only');
  }
  if (input.sizeBytes < 0 || input.sizeBytes > FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes) {
    return unavailableCapabilitiesV1(preview, 'limit_exceeded');
  }
  if (input.rolloutMode === 'off' || input.rolloutMode === 'shadow') {
    return unavailableCapabilitiesV1(preview, 'rollout_disabled');
  }
  if (!input.backends.storageReady) {
    return unavailableCapabilitiesV1(preview, 'storage_unavailable');
  }

  const isFull = input.rolloutMode === 'full';
  const canMutate = isFull && input.canWrite;
  const compare = input.backends.compareReady;
  const restore = canMutate && input.backends.restoreReady;
  const agentReviewPolicy = canMutate && input.backends.policyReady;
  const reason = !input.canWrite ? 'read_only'
    : input.rolloutMode === 'read_only' ? 'read_only_rollout'
      : !compare || !input.backends.restoreReady || !input.backends.policyReady
        ? 'storage_unavailable'
        : undefined;

  return {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    history: true,
    compare,
    restore,
    agentReviewPolicy,
    preview,
    ...(reason ? { reason } : {}),
  };
}

export type ResolveFileReviewPolicyInputV1 = {
  requestedMode: FileReviewPolicyV1['requestedMode'] | null;
  policyRevision: number | null;
  preferenceState: 'loaded' | 'missing' | 'error';
  persistenceState: 'ready' | 'unavailable' | 'unknown';
  hardSafetyRequiresReview: boolean;
  workspacePolicy: 'allow_user_choice' | 'force_review' | 'unknown';
  operationExplicitlyRequiresReview: boolean;
};

export function resolveEffectiveFileReviewPolicyV1(
  input: ResolveFileReviewPolicyInputV1,
): FileReviewPolicyV1 {
  const requestedMode = input.requestedMode ?? 'review_required';
  const revision = input.policyRevision ?? 0;

  if (input.hardSafetyRequiresReview) {
    return {
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      requestedMode,
      effectiveMode: 'review_required',
      revision,
      locked: true,
      reason: 'hard_safety',
    };
  }
  if (
    input.persistenceState !== 'ready'
    || input.preferenceState === 'error'
    || input.workspacePolicy === 'unknown'
  ) {
    return {
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      requestedMode,
      effectiveMode: 'review_required',
      revision,
      locked: true,
      reason: 'persistence_unavailable',
    };
  }
  if (input.workspacePolicy === 'force_review') {
    return {
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      requestedMode,
      effectiveMode: 'review_required',
      revision,
      locked: true,
      reason: 'workspace_policy',
    };
  }
  if (input.operationExplicitlyRequiresReview) {
    return {
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      requestedMode,
      effectiveMode: 'review_required',
      revision,
      locked: true,
      reason: 'explicit_review',
    };
  }
  if (input.preferenceState === 'loaded' && input.requestedMode) {
    return {
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      requestedMode,
      effectiveMode: requestedMode,
      revision,
      locked: false,
      reason: 'user_preference',
    };
  }
  return {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    requestedMode: 'review_required',
    effectiveMode: 'review_required',
    revision,
    locked: false,
    reason: 'default_review_required',
  };
}

export type FileVersionRetentionInputV1 = {
  source: 'initial' | 'automatic_checkpoint' | FileVersionProtectedSourceV1;
  ageDays: number;
  newestRank: number;
  lineageArchivedAgeDays: number | null;
  referencedByPendingReview: boolean;
};

export type FileVersionRetentionDecisionV1 = {
  retain: boolean;
  reason:
    | 'protected_source'
    | 'pending_review'
    | 'newest_floor'
    | 'active_retention_window'
    | 'archive_grace'
    | 'invalid_measurement'
    | 'eligible_for_pruning';
};

export function evaluateFileVersionRetentionV1(
  input: FileVersionRetentionInputV1,
): FileVersionRetentionDecisionV1 {
  if (
    !Number.isFinite(input.ageDays)
    || input.ageDays < 0
    || !Number.isSafeInteger(input.newestRank)
    || input.newestRank < 1
    || (
      input.lineageArchivedAgeDays !== null
      && (!Number.isFinite(input.lineageArchivedAgeDays) || input.lineageArchivedAgeDays < 0)
    )
  ) {
    return { retain: true, reason: 'invalid_measurement' };
  }
  if (input.source !== 'automatic_checkpoint') {
    return { retain: true, reason: 'protected_source' };
  }
  if (input.referencedByPendingReview) {
    return { retain: true, reason: 'pending_review' };
  }
  if (input.newestRank <= FILE_VERSION_CENTER_LIMITS_V1.minNewestVersionsPerLineage) {
    return { retain: true, reason: 'newest_floor' };
  }
  if (input.ageDays <= FILE_VERSION_CENTER_LIMITS_V1.automaticCheckpointRetentionDays) {
    return { retain: true, reason: 'active_retention_window' };
  }
  if (
    input.lineageArchivedAgeDays !== null
    && input.lineageArchivedAgeDays <= FILE_VERSION_CENTER_LIMITS_V1.archivedLineageGraceDays
  ) {
    return { retain: true, reason: 'archive_grace' };
  }
  return { retain: false, reason: 'eligible_for_pruning' };
}

export type FileVersionCaptureAdmissionInputV1 = {
  incomingRawBytes: number;
  incomingStoredBytes: number;
  lineageStoredBytes: number;
  workspaceStoredBytes: number;
  lineageVersionCount: number;
  safelyReclaimableLineageBytes: number;
  safelyReclaimableWorkspaceBytes: number;
  safelyReclaimableVersionCount: number;
};

export type FileVersionCaptureAdmissionDecisionV1 = {
  accepted: boolean;
  reason:
    | 'accepted'
    | 'invalid_measurement'
    | 'raw_version_too_large'
    | 'stored_blob_too_large'
    | 'lineage_quota_exceeded'
    | 'workspace_quota_exceeded'
    | 'version_count_exceeded';
};

export function evaluateFileVersionCaptureAdmissionV1(
  input: FileVersionCaptureAdmissionInputV1,
): FileVersionCaptureAdmissionDecisionV1 {
  if (
    Object.values(input).some((value) => !Number.isSafeInteger(value) || value < 0)
    || input.safelyReclaimableLineageBytes > input.lineageStoredBytes
    || input.safelyReclaimableWorkspaceBytes > input.workspaceStoredBytes
    || input.safelyReclaimableVersionCount > input.lineageVersionCount
  ) {
    return { accepted: false, reason: 'invalid_measurement' };
  }
  if (input.incomingRawBytes > FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes) {
    return { accepted: false, reason: 'raw_version_too_large' };
  }
  if (input.incomingStoredBytes > FILE_VERSION_CENTER_LIMITS_V1.maxStoredBlobBytes) {
    return { accepted: false, reason: 'stored_blob_too_large' };
  }

  const projectedLineageBytes = Math.max(
    0,
    input.lineageStoredBytes - input.safelyReclaimableLineageBytes,
  ) + input.incomingStoredBytes;
  if (projectedLineageBytes > FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerLineage) {
    return { accepted: false, reason: 'lineage_quota_exceeded' };
  }

  const projectedWorkspaceBytes = Math.max(
    0,
    input.workspaceStoredBytes - input.safelyReclaimableWorkspaceBytes,
  ) + input.incomingStoredBytes;
  if (projectedWorkspaceBytes > FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerWorkspace) {
    return { accepted: false, reason: 'workspace_quota_exceeded' };
  }

  const projectedVersionCount = Math.max(
    0,
    input.lineageVersionCount - input.safelyReclaimableVersionCount,
  ) + 1;
  if (projectedVersionCount > FILE_VERSION_CENTER_LIMITS_V1.maxVersionsPerLineage) {
    return { accepted: false, reason: 'version_count_exceeded' };
  }
  return { accepted: true, reason: 'accepted' };
}

export type FileVersionCompareAdmissionInputV1 = {
  currentBytes: number;
  selectedBytes: number;
  currentLines: number;
  selectedLines: number;
};

export function isFileVersionCompareAdmittedV1(input: FileVersionCompareAdmissionInputV1): boolean {
  if (Object.values(input).some((value) => !Number.isSafeInteger(value) || value < 0)) return false;
  return input.currentBytes <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareBytesPerSide
    && input.selectedBytes <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareBytesPerSide
    && input.currentBytes + input.selectedBytes <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareCombinedBytes
    && input.currentLines <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareLinesPerSide
    && input.selectedLines <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareLinesPerSide;
}

export const FILE_VERSION_CENTER_PREVIEW_POLICY_V1 = Object.freeze({
  markdown: Object.freeze({
    rawHtml: false,
    scripts: false,
    iframes: false,
    remoteResources: false,
    activeLinks: false,
  }),
  text: Object.freeze({
    interpretedMarkup: false,
    executableContent: false,
  }),
} as const);

export const FILE_REVIEW_PRODUCT_COPY_V1 = Object.freeze({
  label: 'Agenten-Änderungen prüfen',
  reviewRequired: 'Prüfung erforderlich',
  safeDirect: 'Direkt bearbeiten, wenn sicher',
  description:
    'Gilt für neue Agentenänderungen an diesem Dokument. Konflikte und unsichere Änderungen werden weiterhin zur Prüfung vorgelegt.',
  unavailable:
    'Prüfung ist vorübergehend erforderlich. Die Einstellung konnte nicht sicher geladen werden.',
} as const);
