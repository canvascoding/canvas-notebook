import type {
  SystemUpdateEvent,
  SystemUpdateOperation,
  SystemUpdateReleaseChannel,
  SystemUpdateStage,
} from '@/cli/src/core/systemUpdateContract';
import { validateSystemUpdateOperation } from '@/cli/src/core/systemUpdateContract';

export type SystemUpdateMode = 'standalone' | 'managed' | 'manual';
export type SystemUpdatePlatform = 'canvas-installer' | 'docker-compose' | 'coolify' | 'unknown';

export interface SystemUpdateReleaseSummary {
  releaseId: string;
  version: string;
  publishedAt: string;
  backupRequired: boolean;
  releaseNotesUrl: string | null;
}

export interface SystemUpdateAvailability {
  contractVersion: 1;
  mode: SystemUpdateMode;
  platform: SystemUpdatePlatform;
  channel: SystemUpdateReleaseChannel;
  currentVersion: string | null;
  updateAvailable: boolean | null;
  ready: boolean;
  reasons: string[];
  release: SystemUpdateReleaseSummary | null;
  instructions: string[];
}

export type SystemUpdateOperationView = Omit<SystemUpdateOperation, 'targetImageRef'>;

export interface SystemUpdateOperationSnapshot {
  operation: SystemUpdateOperationView;
  events: SystemUpdateEvent[];
}

export interface SystemUpdateStatusAccess {
  path: string;
  ticket: string;
  expiresAt: string;
}

export interface StartSystemUpdateInput {
  channel: SystemUpdateReleaseChannel;
  expectedReleaseId?: string;
}

export interface SystemUpdateBackend {
  readonly mode: SystemUpdateMode;
  getAvailability(channel: SystemUpdateReleaseChannel): Promise<SystemUpdateAvailability>;
  startUpdate(input: StartSystemUpdateInput): Promise<SystemUpdateOperationView>;
  getOperation(operationId: string): Promise<SystemUpdateOperationView>;
  getEvents(operationId: string, afterSequence: number): Promise<SystemUpdateOperationSnapshot>;
  createStatusAccess(operationId: string): Promise<SystemUpdateStatusAccess | null>;
}

export class SystemUpdateBackendError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SystemUpdateBackendError';
  }
}

export function withoutSensitiveOperationFields(operation: SystemUpdateOperation): SystemUpdateOperationView {
  const { targetImageRef: _targetImageRef, ...safeOperation } = operation;
  return safeOperation;
}

export function validateSystemUpdateOperationView(value: unknown): SystemUpdateOperationView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || 'targetImageRef' in value) return null;
  const validation = validateSystemUpdateOperation({
    ...value,
    targetImageRef: `ghcr.io/canvascoding/contract-redacted@sha256:${'0'.repeat(64)}`,
  });
  return validation.ok ? withoutSensitiveOperationFields(validation.value) : null;
}

export const SYSTEM_UPDATE_STAGE_ORDER: readonly SystemUpdateStage[] = [
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
];
