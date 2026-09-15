import { FILE_VERSION_CENTER_LIMITS_V1 } from './policy-v1';

export const FILE_VERSION_CENTER_SHADOW_P95_LIMIT_MS = 1_000;

export type FileVersionCenterShadowStorageSnapshot = {
  workspaceCount: number;
  lineageCount: number;
  capturedVersionCount: number;
  uniqueBlobCount: number;
  totalRawBytes: number;
  totalStoredBytes: number;
  maxRawVersionBytes: number;
  maxStoredBlobBytes: number;
  maxLineageStoredBytes: number;
  maxWorkspaceStoredBytes: number;
  maxLineageVersionCount: number;
};

export type FileVersionCenterShadowCaptureSample = {
  capturedBindingsDelta: number;
  uniqueBlobDelta: number;
  storedBytesDelta: number;
  durationsMs: number[];
  documentAccessVerified: boolean;
  uiHiddenVerified: boolean;
};

export type FileVersionCenterReadObservation = {
  operation: 'resolve' | 'timeline' | 'compare';
  outcome: 'success' | 'truncated';
  durationMs: number;
};

export type FileVersionCenterShadowReportInput = {
  mode: string | null | undefined;
  storage: FileVersionCenterShadowStorageSnapshot;
  captures: FileVersionCenterShadowCaptureSample[];
  reads: FileVersionCenterReadObservation[];
  latencyLimitMs?: number;
};

export type FileVersionCenterShadowReport = {
  contractVersion: 1;
  mode: 'shadow' | 'invalid';
  sample: {
    captureRuns: number;
    capturedBindings: number;
    uniqueBlobs: number;
    storedBytes: number;
    captureP95Ms: number | null;
    readRequests: number;
    readP95Ms: number | null;
    deduplicationPercent: number;
  };
  storage: FileVersionCenterShadowStorageSnapshot;
  utilizationPercent: {
    largestRawVersion: number;
    largestStoredBlob: number;
    largestLineageStorage: number;
    largestWorkspaceStorage: number;
    largestLineageVersionCount: number;
  };
  gates: {
    shadowMode: boolean;
    nonEmptyCaptureSample: boolean;
    documentAccess: boolean;
    uiHidden: boolean;
    rawVersionLimit: boolean;
    storedBlobLimit: boolean;
    lineageStorageLimit: boolean;
    workspaceStorageLimit: boolean;
    lineageVersionLimit: boolean;
    captureLatency: boolean;
    readLatency: boolean;
  };
  latencyLimitMs: number;
  passing: boolean;
};

function boundedInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
}

function percent(value: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.round((value / limit) * 10_000) / 100;
}

function percentile95(values: number[]): number | null {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  return Math.round(valid[Math.max(0, Math.ceil(valid.length * 0.95) - 1)]!);
}

export function evaluateFileVersionCenterShadowReport(
  input: FileVersionCenterShadowReportInput,
): FileVersionCenterShadowReport {
  const storage = Object.fromEntries(Object.entries(input.storage).map(([key, value]) => [
    key,
    boundedInteger(value),
  ])) as FileVersionCenterShadowStorageSnapshot;
  const latencyLimitMs = Number.isSafeInteger(input.latencyLimitMs) && Number(input.latencyLimitMs) > 0
    ? Number(input.latencyLimitMs)
    : FILE_VERSION_CENTER_SHADOW_P95_LIMIT_MS;
  const captureDurations = input.captures.flatMap((sample) => sample.durationsMs);
  const readDurations = input.reads.map((sample) => sample.durationMs);
  const capturedBindings = input.captures.reduce(
    (total, sample) => total + boundedInteger(sample.capturedBindingsDelta),
    0,
  );
  const uniqueBlobs = input.captures.reduce(
    (total, sample) => total + boundedInteger(sample.uniqueBlobDelta),
    0,
  );
  const storedBytes = input.captures.reduce(
    (total, sample) => total + boundedInteger(sample.storedBytesDelta),
    0,
  );
  const captureP95Ms = percentile95(captureDurations);
  const readP95Ms = percentile95(readDurations);
  const gates = {
    shadowMode: input.mode === 'shadow',
    nonEmptyCaptureSample: input.captures.length > 0 && capturedBindings > 0,
    documentAccess: input.captures.length > 0
      && input.captures.every((sample) => sample.documentAccessVerified),
    uiHidden: input.captures.length > 0
      && input.captures.every((sample) => sample.uiHiddenVerified),
    rawVersionLimit: storage.maxRawVersionBytes <= FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes,
    storedBlobLimit: storage.maxStoredBlobBytes <= FILE_VERSION_CENTER_LIMITS_V1.maxStoredBlobBytes,
    lineageStorageLimit: storage.maxLineageStoredBytes
      <= FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerLineage,
    workspaceStorageLimit: storage.maxWorkspaceStoredBytes
      <= FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerWorkspace,
    lineageVersionLimit: storage.maxLineageVersionCount
      <= FILE_VERSION_CENTER_LIMITS_V1.maxVersionsPerLineage,
    captureLatency: captureP95Ms !== null && captureP95Ms <= latencyLimitMs,
    readLatency: readP95Ms !== null && readP95Ms <= latencyLimitMs,
  };
  return {
    contractVersion: 1,
    mode: input.mode === 'shadow' ? 'shadow' : 'invalid',
    sample: {
      captureRuns: input.captures.length,
      capturedBindings,
      uniqueBlobs,
      storedBytes,
      captureP95Ms,
      readRequests: input.reads.length,
      readP95Ms,
      deduplicationPercent: capturedBindings === 0
        ? 0
        : Math.round(Math.max(0, 1 - (uniqueBlobs / capturedBindings)) * 10_000) / 100,
    },
    storage,
    utilizationPercent: {
      largestRawVersion: percent(storage.maxRawVersionBytes, FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes),
      largestStoredBlob: percent(storage.maxStoredBlobBytes, FILE_VERSION_CENTER_LIMITS_V1.maxStoredBlobBytes),
      largestLineageStorage: percent(storage.maxLineageStoredBytes, FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerLineage),
      largestWorkspaceStorage: percent(storage.maxWorkspaceStoredBytes, FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerWorkspace),
      largestLineageVersionCount: percent(storage.maxLineageVersionCount, FILE_VERSION_CENTER_LIMITS_V1.maxVersionsPerLineage),
    },
    gates,
    latencyLimitMs,
    passing: Object.values(gates).every(Boolean),
  };
}
