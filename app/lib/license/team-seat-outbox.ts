import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import type { SqlConnection } from '@/app/lib/db';
import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';
import {
  createTeamSeatSnapshotRequest,
  parseTeamSeatSnapshotResponse,
  TEAM_SEAT_PROTOCOL_VERSION,
  type TeamSeatChangeType,
  type TeamSeatSnapshotRequest,
} from '@/app/lib/license/team-seat-contract';
import { getCurrentAppVersion } from '@/app/lib/migration/app-version';
import { signalTeamMembershipSnapshotSync } from './team-membership-sync-signal';
import { signalTeamSeatOutboxWorker } from './team-seat-outbox-worker-signal';

export const TEAM_SEAT_OUTBOX_OPERATION_KINDS = [
  'membership_snapshot',
  'seat_prepare',
  'seat_execute',
  'license_refresh',
] as const;

export type TeamSeatOutboxOperationKind = typeof TEAM_SEAT_OUTBOX_OPERATION_KINDS[number];

export const TEAM_SEAT_OUTBOX_STATUSES = [
  'pending',
  'processing',
  'retry_wait',
  'succeeded',
  'failed',
  'canceled',
] as const;

export type TeamSeatOutboxStatus = typeof TEAM_SEAT_OUTBOX_STATUSES[number];

export type TeamSeatOutboxOperation = {
  id: string;
  operationId: string;
  dedupeKey: string;
  organizationId: string;
  membershipId: string | null;
  membershipRevision: number | null;
  operationKind: TeamSeatOutboxOperationKind;
  operationType: TeamSeatChangeType | null;
  status: TeamSeatOutboxStatus;
  requestJson: string;
  requestHash: string;
  responseJson: string | null;
  controlPlaneOperationId: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type TeamMembershipSyncState = {
  organizationId: string;
  currentRevision: number;
  currentObservedQuantity: number;
  latestSnapshotHash: string | null;
  latestSnapshotGeneratedAt: number | null;
  lastLocalChangeAt: number | null;
  acknowledgedRevision: number;
  acknowledgedSnapshotId: string | null;
  acknowledgedSnapshotHash: string | null;
  acknowledgedAt: number | null;
  controlPlaneProtocolVersion: string | null;
  controlPlaneObservedQuantity: number | null;
  approvedQuantity: number | null;
  billedQuantity: number | null;
  licensedQuantity: number | null;
  expectedLicensedQuantity: number | null;
  entitlementsVersion: number | null;
  billingStatus: string | null;
  driftStatus: string | null;
  reconciliationStatus: string | null;
  reconciliationAction: string | null;
  reconciliationReason: string | null;
  reconciliationSeatLimit: number | null;
  reconciliationSupportRequired: boolean;
  reconciledAt: number | null;
  nextReportAt: number | null;
  lastSyncErrorCode: string | null;
  lastSyncError: string | null;
  lastSyncAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type TeamSeatSyncDiagnostics = {
  state: TeamMembershipSyncState | null;
  outbox: {
    pending: number;
    processing: number;
    retryWait: number;
    failed: number;
    oldestPendingAt: number | null;
  };
};

type OutboxRow = {
  id: string;
  operation_id: string;
  dedupe_key: string;
  organization_id: string;
  membership_id: string | null;
  membership_revision: number | null;
  operation_kind: string;
  operation_type: string | null;
  status: string;
  request_json: string;
  request_hash: string;
  response_json: string | null;
  control_plane_operation_id: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  last_error_code: string | null;
  last_error: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type SyncStateRow = {
  organization_id: string;
  current_revision: number;
  current_observed_quantity: number;
  latest_snapshot_hash: string | null;
  latest_snapshot_generated_at: number | null;
  last_local_change_at: number | null;
  acknowledged_revision: number;
  acknowledged_snapshot_id: string | null;
  acknowledged_snapshot_hash: string | null;
  acknowledged_at: number | null;
  control_plane_protocol_version: string | null;
  control_plane_observed_quantity: number | null;
  approved_quantity: number | null;
  billed_quantity: number | null;
  licensed_quantity: number | null;
  expected_licensed_quantity: number | null;
  entitlements_version: number | null;
  billing_status: string | null;
  drift_status: string | null;
  reconciliation_status: string | null;
  reconciliation_action: string | null;
  reconciliation_reason: string | null;
  reconciliation_seat_limit: number | null;
  reconciliation_support_required: number | boolean | string;
  reconciled_at: number | null;
  next_report_at: number | null;
  last_sync_error_code: string | null;
  last_sync_error: string | null;
  last_sync_at: number | null;
  created_at: number;
  updated_at: number;
};

type ActiveProjection = {
  observedQuantity: number;
  roleSummary: Record<string, number>;
  members: Array<{
    membershipId: string;
  }>;
};

const OUTBOX_SELECT = `
  SELECT
    id,
    operation_id,
    dedupe_key,
    organization_id,
    membership_id,
    membership_revision,
    operation_kind,
    operation_type,
    status,
    request_json,
    request_hash,
    response_json,
    control_plane_operation_id,
    attempt_count,
    max_attempts,
    next_attempt_at,
    last_attempt_at,
    last_error_code,
    last_error,
    completed_at,
    created_at,
    updated_at
  FROM team_seat_outbox
`;

const SYNC_STATE_SELECT = `
  SELECT
    organization_id,
    current_revision,
    current_observed_quantity,
    latest_snapshot_hash,
    latest_snapshot_generated_at,
    last_local_change_at,
    acknowledged_revision,
    acknowledged_snapshot_id,
    acknowledged_snapshot_hash,
    acknowledged_at,
    control_plane_protocol_version,
    control_plane_observed_quantity,
    approved_quantity,
    billed_quantity,
    licensed_quantity,
    expected_licensed_quantity,
    entitlements_version,
    billing_status,
    drift_status,
    reconciliation_status,
    reconciliation_action,
    reconciliation_reason,
    reconciliation_seat_limit,
    reconciliation_support_required,
    reconciled_at,
    next_report_at,
    last_sync_error_code,
    last_sync_error,
    last_sync_at,
    created_at,
    updated_at
  FROM team_membership_sync_state
`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class TeamSeatOutboxError extends Error {
  constructor(
    public readonly code:
      | 'TEAM_SEAT_OUTBOX_NOT_FOUND'
      | 'TEAM_SEAT_OUTBOX_CONFLICT'
      | 'TEAM_SEAT_OUTBOX_TERMINAL'
      | 'TEAM_SEAT_SNAPSHOT_CONFLICT',
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'TeamSeatOutboxError';
  }
}

function isOutboxOperationKind(value: string): value is TeamSeatOutboxOperationKind {
  return (TEAM_SEAT_OUTBOX_OPERATION_KINDS as readonly string[]).includes(value);
}

function isOutboxStatus(value: string): value is TeamSeatOutboxStatus {
  return (TEAM_SEAT_OUTBOX_STATUSES as readonly string[]).includes(value);
}

function isTeamSeatChangeType(value: string): value is TeamSeatChangeType {
  return [
    'team_upgrade',
    'member_create',
    'invitation_accept',
    'member_remove',
    'reconcile',
  ].includes(value);
}

function mapOutbox(row: OutboxRow): TeamSeatOutboxOperation {
  if (
    !isOutboxOperationKind(row.operation_kind)
    || !isOutboxStatus(row.status)
    || (row.operation_type !== null && !isTeamSeatChangeType(row.operation_type))
  ) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      `Outbox operation ${row.operation_id} contains an unsupported lifecycle value.`,
    );
  }
  return {
    id: row.id,
    operationId: row.operation_id,
    dedupeKey: row.dedupe_key,
    organizationId: row.organization_id,
    membershipId: row.membership_id,
    membershipRevision: row.membership_revision,
    operationKind: row.operation_kind,
    operationType: row.operation_type,
    status: row.status,
    requestJson: row.request_json,
    requestHash: row.request_hash,
    responseJson: row.response_json,
    controlPlaneOperationId: row.control_plane_operation_id,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSyncState(row: SyncStateRow): TeamMembershipSyncState {
  return {
    organizationId: row.organization_id,
    currentRevision: row.current_revision,
    currentObservedQuantity: row.current_observed_quantity,
    latestSnapshotHash: row.latest_snapshot_hash,
    latestSnapshotGeneratedAt: row.latest_snapshot_generated_at,
    lastLocalChangeAt: row.last_local_change_at,
    acknowledgedRevision: row.acknowledged_revision,
    acknowledgedSnapshotId: row.acknowledged_snapshot_id,
    acknowledgedSnapshotHash: row.acknowledged_snapshot_hash,
    acknowledgedAt: row.acknowledged_at,
    controlPlaneProtocolVersion: row.control_plane_protocol_version,
    controlPlaneObservedQuantity: row.control_plane_observed_quantity,
    approvedQuantity: row.approved_quantity,
    billedQuantity: row.billed_quantity,
    licensedQuantity: row.licensed_quantity,
    expectedLicensedQuantity: row.expected_licensed_quantity,
    entitlementsVersion: row.entitlements_version,
    billingStatus: row.billing_status,
    driftStatus: row.drift_status,
    reconciliationStatus: row.reconciliation_status,
    reconciliationAction: row.reconciliation_action,
    reconciliationReason: row.reconciliation_reason,
    reconciliationSeatLimit: row.reconciliation_seat_limit,
    reconciliationSupportRequired: row.reconciliation_support_required === true
      || row.reconciliation_support_required === 1
      || row.reconciliation_support_required === '1',
    reconciledAt: row.reconciled_at,
    nextReportAt: row.next_report_at,
    lastSyncErrorCode: row.last_sync_error_code,
    lastSyncError: row.last_sync_error,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return String(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function changesFromRunResult(result: unknown): number {
  if (result && typeof result === 'object' && 'changes' in result) {
    return Number((result as { changes?: unknown }).changes || 0);
  }
  return 0;
}

function optionalText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.trim() || null;
  return normalized ? normalized.slice(0, maxLength) : null;
}

function serializeResponse(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= 32_768
    ? serialized
    : JSON.stringify({ truncated: true, originalLength: serialized.length });
}

async function rollbackQuietly(database: Pick<SqlConnection, 'run'>): Promise<void> {
  try {
    await database.run('ROLLBACK');
  } catch {
    // Preserve the original transaction error.
  }
}

async function withTransaction<T>(
  database: Pick<SqlConnection, 'run'>,
  provider: DatabaseProvider,
  operation: () => Promise<T>,
): Promise<T> {
  await database.run(provider === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = await operation();
    await database.run('COMMIT');
    return result;
  } catch (error) {
    await rollbackQuietly(database);
    throw error;
  }
}

export function teamSeatMemberHash(organizationId: string, membershipId: string): string {
  return sha256(`${organizationId}\0${membershipId}`);
}

export function teamSeatSnapshotHash(
  input: Omit<TeamSeatSnapshotRequest, 'snapshotHash'>,
): string {
  const roleSummary = Object.fromEntries(
    Object.entries(input.roleSummary).sort(([left], [right]) => left.localeCompare(right)),
  );
  return sha256(JSON.stringify({
    protocolVersion: input.protocolVersion,
    observedQuantity: input.observedQuantity,
    roleSummary,
    memberHashes: [...input.memberHashes].sort(),
  }));
}

export async function getTeamSeatOutboxOperation(
  database: Pick<SqlConnection, 'get'>,
  operationId: string,
): Promise<TeamSeatOutboxOperation | null> {
  const row = await database.get(
    `${OUTBOX_SELECT} WHERE operation_id = ? LIMIT 1`,
    [operationId],
  ) as OutboxRow | undefined;
  return row ? mapOutbox(row) : null;
}

export async function enqueueTeamSeatOutboxOperation(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    organizationId: string;
    dedupeKey: string;
    operationKind: TeamSeatOutboxOperationKind;
    request: unknown;
    operationId?: string;
    membershipId?: string | null;
    membershipRevision?: number | null;
    operationType?: TeamSeatChangeType | null;
    maxAttempts?: number;
    nextAttemptAt?: number | null;
    now?: number;
  },
): Promise<{ operation: TeamSeatOutboxOperation; replayed: boolean }> {
  const operationId = input.operationId ?? randomUUID();
  if (!UUID_PATTERN.test(operationId)) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      'Team Seat operation IDs must be UUIDs.',
      400,
    );
  }
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey || dedupeKey.length > 500) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      'A stable Team Seat outbox dedupe key is required.',
      400,
    );
  }
  const now = input.now ?? Date.now();
  const requestJson = canonicalJson(input.request);
  const requestHash = sha256(requestJson);
  const maxAttempts = Math.max(1, Math.min(100, input.maxAttempts ?? 10));
  const result = await database.run(`
    INSERT INTO team_seat_outbox (
      id,
      operation_id,
      dedupe_key,
      organization_id,
      membership_id,
      membership_revision,
      operation_kind,
      operation_type,
      status,
      request_json,
      request_hash,
      attempt_count,
      max_attempts,
      next_attempt_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `, [
    `team-seat-outbox-${randomUUID()}`,
    operationId,
    dedupeKey,
    input.organizationId,
    input.membershipId ?? null,
    input.membershipRevision ?? null,
    input.operationKind,
    input.operationType ?? null,
    requestJson,
    requestHash,
    maxAttempts,
    input.nextAttemptAt === undefined ? now : input.nextAttemptAt,
    now,
    now,
  ]);

  const replayed = changesFromRunResult(result) === 0;
  const row = await database.get(
    `${OUTBOX_SELECT} WHERE dedupe_key = ? LIMIT 1`,
    [dedupeKey],
  ) as OutboxRow | undefined;
  if (!row) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      'Team Seat outbox operation was not persisted.',
    );
  }
  const operation = mapOutbox(row);
  if (operation.requestHash !== requestHash) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      'The Team Seat dedupe key was reused with a different request.',
    );
  }
  signalTeamSeatOutboxWorker();
  return { operation, replayed };
}

export async function recordTeamMembershipProjectionChange(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    organizationId: string;
    membershipId: string;
    operationType: TeamSeatChangeType;
    projection: ActiveProjection;
    now?: number;
    notebookVersion?: string | null;
  },
): Promise<{
  revision: number;
  snapshot: TeamSeatSnapshotRequest;
  outboxOperation: TeamSeatOutboxOperation;
}> {
  const now = input.now ?? Date.now();
  await database.run(`
    INSERT INTO team_membership_sync_state (
      organization_id,
      current_revision,
      current_observed_quantity,
      last_local_change_at,
      created_at,
      updated_at
    ) VALUES (?, 1, ?, ?, ?, ?)
    ON CONFLICT(organization_id) DO UPDATE SET
      current_revision = team_membership_sync_state.current_revision + 1,
      current_observed_quantity = excluded.current_observed_quantity,
      last_local_change_at = excluded.last_local_change_at,
      updated_at = excluded.updated_at
  `, [
    input.organizationId,
    input.projection.observedQuantity,
    now,
    now,
    now,
  ]);

  const state = await database.get(`
    SELECT current_revision
    FROM team_membership_sync_state
    WHERE organization_id = ?
    LIMIT 1
  `, [input.organizationId]) as { current_revision: number } | undefined;
  if (!state || !Number.isSafeInteger(state.current_revision) || state.current_revision < 1) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_SNAPSHOT_CONFLICT',
      'Failed to allocate a monotone Team membership revision.',
    );
  }

  const generatedAt = new Date(now).toISOString();
  const snapshotWithoutHash: Omit<TeamSeatSnapshotRequest, 'snapshotHash'> = {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    revision: state.current_revision,
    observedQuantity: input.projection.observedQuantity,
    roleSummary: input.projection.roleSummary,
    memberHashes: input.projection.members
      .map((member) => teamSeatMemberHash(input.organizationId, member.membershipId))
      .sort(),
    generatedAt,
    notebookVersion: input.notebookVersion === undefined
      ? getCurrentAppVersion()
      : input.notebookVersion,
  };
  const snapshot = createTeamSeatSnapshotRequest({
    ...snapshotWithoutHash,
    snapshotHash: teamSeatSnapshotHash(snapshotWithoutHash),
  });

  await database.run(`
    UPDATE team_membership_sync_state
    SET
      latest_snapshot_hash = ?,
      latest_snapshot_generated_at = ?,
      updated_at = ?
    WHERE organization_id = ?
      AND current_revision = ?
  `, [
    snapshot.snapshotHash,
    now,
    now,
    input.organizationId,
    snapshot.revision,
  ]);

  const outbox = await enqueueTeamSeatOutboxOperation(database, {
    organizationId: input.organizationId,
    dedupeKey: `membership-snapshot:${input.organizationId}:${snapshot.revision}`,
    operationKind: 'membership_snapshot',
    operationType: input.operationType,
    membershipId: input.membershipId,
    membershipRevision: snapshot.revision,
    request: snapshot,
    nextAttemptAt: now,
    now,
  });
  if (outbox.replayed) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_SNAPSHOT_CONFLICT',
      `Membership revision ${snapshot.revision} already has an outbox operation.`,
    );
  }
  signalTeamMembershipSnapshotSync();

  return {
    revision: snapshot.revision,
    snapshot,
    outboxOperation: outbox.operation,
  };
}

export async function getLatestTeamMembershipSnapshotOperation(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
): Promise<TeamSeatOutboxOperation | null> {
  const row = await database.get(`
    ${OUTBOX_SELECT}
    WHERE organization_id = ?
      AND operation_kind = 'membership_snapshot'
    ORDER BY membership_revision DESC, created_at DESC, id DESC
    LIMIT 1
  `, [organizationId]) as OutboxRow | undefined;
  return row ? mapOutbox(row) : null;
}

export async function requeueTeamMembershipSnapshotOperation(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    operationId: string;
    now?: number;
  },
): Promise<TeamSeatOutboxOperation> {
  const now = input.now ?? Date.now();
  const result = await database.run(`
    UPDATE team_seat_outbox
    SET
      status = 'pending',
      response_json = NULL,
      attempt_count = 0,
      next_attempt_at = ?,
      last_attempt_at = NULL,
      last_error_code = NULL,
      last_error = NULL,
      completed_at = NULL,
      updated_at = ?
    WHERE operation_id = ?
      AND operation_kind = 'membership_snapshot'
      AND status IN ('succeeded', 'failed')
  `, [now, now, input.operationId]);
  if (changesFromRunResult(result) !== 1) {
    const existing = await getTeamSeatOutboxOperation(database, input.operationId);
    if (
      existing
      && existing.operationKind === 'membership_snapshot'
      && ['pending', 'processing', 'retry_wait'].includes(existing.status)
    ) {
      return existing;
    }
    throw new TeamSeatOutboxError(
      existing ? 'TEAM_SEAT_OUTBOX_TERMINAL' : 'TEAM_SEAT_OUTBOX_NOT_FOUND',
      existing
        ? `Snapshot outbox operation cannot be requeued from status ${existing.status}.`
        : 'Snapshot outbox operation not found.',
      existing ? 409 : 404,
    );
  }
  const operation = await getTeamSeatOutboxOperation(database, input.operationId);
  if (!operation) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_NOT_FOUND',
      'Snapshot outbox operation not found.',
      404,
    );
  }
  return operation;
}

export async function claimDueTeamMembershipSnapshotOperations(
  database: Pick<SqlConnection, 'all' | 'get' | 'run'>,
  input: {
    now?: number;
    leaseMs?: number;
    limit?: number;
  } = {},
): Promise<TeamSeatOutboxOperation[]> {
  const now = input.now ?? Date.now();
  const leaseMs = Math.max(1_000, input.leaseMs ?? 60_000);
  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const candidates = await database.all(`
    ${OUTBOX_SELECT}
    WHERE operation_kind = 'membership_snapshot'
      AND (
        (
          status IN ('pending', 'retry_wait')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        )
        OR (
          status = 'processing'
          AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
        )
      )
    ORDER BY membership_revision ASC, created_at ASC, id ASC
    LIMIT ?
  `, [now, now - leaseMs, limit]) as OutboxRow[];
  const claimed: TeamSeatOutboxOperation[] = [];
  for (const candidate of candidates) {
    const result = await database.run(`
      UPDATE team_seat_outbox
      SET
        status = 'processing',
        last_attempt_at = ?,
        updated_at = ?
      WHERE operation_id = ?
        AND operation_kind = 'membership_snapshot'
        AND (
          (
            status IN ('pending', 'retry_wait')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          )
          OR (
            status = 'processing'
            AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
          )
        )
    `, [
      now,
      now,
      candidate.operation_id,
      now,
      now - leaseMs,
    ]);
    if (changesFromRunResult(result) !== 1) continue;
    const operation = await getTeamSeatOutboxOperation(database, candidate.operation_id);
    if (operation) claimed.push(operation);
  }
  return claimed;
}

export async function claimTeamSeatOutboxOperation(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    operationId: string;
    allowPending: boolean;
    allowFailed?: boolean;
    now?: number;
    leaseMs?: number;
  },
): Promise<{ operation: TeamSeatOutboxOperation; claimed: boolean }> {
  const now = input.now ?? Date.now();
  const leaseMs = Math.max(1_000, input.leaseMs ?? 60_000);
  const result = await database.run(`
    UPDATE team_seat_outbox
    SET
      status = 'processing',
      response_json = CASE WHEN status = 'failed' THEN NULL ELSE response_json END,
      attempt_count = CASE WHEN status = 'failed' THEN 0 ELSE attempt_count END,
      next_attempt_at = NULL,
      last_attempt_at = ?,
      last_error_code = CASE WHEN status = 'failed' THEN NULL ELSE last_error_code END,
      last_error = CASE WHEN status = 'failed' THEN NULL ELSE last_error END,
      completed_at = NULL,
      updated_at = ?
    WHERE operation_id = ?
      AND (
        (status = 'pending' AND ? = 1)
        OR (status = 'failed' AND ? = 1)
        OR (
          status = 'retry_wait'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        )
        OR (
          status = 'processing'
          AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
        )
      )
  `, [
    now,
    now,
    input.operationId,
    input.allowPending ? 1 : 0,
    input.allowFailed ? 1 : 0,
    now,
    now - leaseMs,
  ]);
  const operation = await getTeamSeatOutboxOperation(database, input.operationId);
  if (!operation) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_NOT_FOUND',
      'Team Seat outbox operation not found.',
      404,
    );
  }
  return {
    operation,
    claimed: changesFromRunResult(result) === 1,
  };
}

export async function claimDueTeamSeatWorkOperations(
  database: Pick<SqlConnection, 'all' | 'get' | 'run'>,
  input: {
    now?: number;
    leaseMs?: number;
    limit?: number;
    pendingDelayMs?: number;
  } = {},
): Promise<TeamSeatOutboxOperation[]> {
  const now = input.now ?? Date.now();
  const leaseMs = Math.max(1_000, input.leaseMs ?? 60_000);
  const pendingDelayMs = Math.max(0, input.pendingDelayMs ?? 1_000);
  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const candidates = await database.all(`
    ${OUTBOX_SELECT}
    WHERE operation_kind IN ('seat_prepare', 'seat_execute', 'license_refresh')
      AND (
        (
          status = 'pending'
          AND operation_kind IN ('seat_prepare', 'license_refresh')
          AND created_at <= ?
        )
        OR (
          status = 'retry_wait'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        )
        OR (
          status = 'processing'
          AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
        )
      )
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `, [now - pendingDelayMs, now, now - leaseMs, limit]) as OutboxRow[];
  const claimed: TeamSeatOutboxOperation[] = [];
  for (const candidate of candidates) {
    const result = await database.run(`
      UPDATE team_seat_outbox
      SET
        status = 'processing',
        last_attempt_at = ?,
        updated_at = ?
      WHERE operation_id = ?
        AND operation_kind IN ('seat_prepare', 'seat_execute', 'license_refresh')
        AND (
          (
            status = 'pending'
            AND operation_kind IN ('seat_prepare', 'license_refresh')
            AND created_at <= ?
          )
          OR (
            status = 'retry_wait'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          )
          OR (
            status = 'processing'
            AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
          )
        )
    `, [
      now,
      now,
      candidate.operation_id,
      now - pendingDelayMs,
      now,
      now - leaseMs,
    ]);
    if (changesFromRunResult(result) !== 1) continue;
    const operation = await getTeamSeatOutboxOperation(database, candidate.operation_id);
    if (operation) claimed.push(operation);
  }
  return claimed;
}

export async function scheduleTeamSeatOutboxRetry(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    operationId: string;
    errorCode: string;
    error: string;
    retryAt: number;
    now?: number;
  },
): Promise<TeamSeatOutboxOperation> {
  const now = input.now ?? Date.now();
  const result = await database.run(`
    UPDATE team_seat_outbox
    SET
      attempt_count = attempt_count + 1,
      status = CASE
        WHEN attempt_count + 1 >= max_attempts THEN 'failed'
        ELSE 'retry_wait'
      END,
      next_attempt_at = CASE
        WHEN attempt_count + 1 >= max_attempts THEN NULL
        ELSE ?
      END,
      last_attempt_at = ?,
      last_error_code = ?,
      last_error = ?,
      completed_at = CASE
        WHEN attempt_count + 1 >= max_attempts THEN ?
        ELSE NULL
      END,
      updated_at = ?
    WHERE operation_id = ?
      AND status NOT IN ('succeeded', 'failed', 'canceled')
      AND attempt_count < max_attempts
  `, [
    input.retryAt,
    now,
    optionalText(input.errorCode, 120),
    optionalText(input.error, 2000),
    now,
    now,
    input.operationId,
  ]);
  if (changesFromRunResult(result) !== 1) {
    const existing = await getTeamSeatOutboxOperation(database, input.operationId);
    throw new TeamSeatOutboxError(
      existing ? 'TEAM_SEAT_OUTBOX_TERMINAL' : 'TEAM_SEAT_OUTBOX_NOT_FOUND',
      existing
        ? `Team Seat outbox operation is already ${existing.status}.`
        : 'Team Seat outbox operation not found.',
      existing ? 409 : 404,
    );
  }
  const operation = await getTeamSeatOutboxOperation(database, input.operationId);
  if (!operation) {
    throw new TeamSeatOutboxError('TEAM_SEAT_OUTBOX_NOT_FOUND', 'Team Seat outbox operation not found.', 404);
  }
  return operation;
}

export async function recordTeamSeatOutboxOperationFailure(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    operationId: string;
    errorCode: string;
    error: string;
    response?: unknown;
    controlPlaneOperationId?: string | null;
    now?: number;
  },
): Promise<TeamSeatOutboxOperation> {
  const now = input.now ?? Date.now();
  const responseJson = input.response === undefined
    ? null
    : serializeResponse(input.response);
  const result = await database.run(`
    UPDATE team_seat_outbox
    SET
      status = 'failed',
      response_json = COALESCE(?, response_json),
      control_plane_operation_id = COALESCE(?, control_plane_operation_id),
      attempt_count = CASE
        WHEN attempt_count < max_attempts THEN attempt_count + 1
        ELSE attempt_count
      END,
      next_attempt_at = NULL,
      last_attempt_at = ?,
      last_error_code = ?,
      last_error = ?,
      completed_at = ?,
      updated_at = ?
    WHERE operation_id = ?
      AND status NOT IN ('succeeded', 'failed', 'canceled')
  `, [
    responseJson,
    optionalText(input.controlPlaneOperationId, 500),
    now,
    optionalText(input.errorCode, 120),
    optionalText(input.error, 2000),
    now,
    now,
    input.operationId,
  ]);
  const operation = await getTeamSeatOutboxOperation(database, input.operationId);
  if (!operation) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_NOT_FOUND',
      'Team Seat outbox operation not found.',
      404,
    );
  }
  if (changesFromRunResult(result) !== 1 && operation.status !== 'failed') {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_TERMINAL',
      `Team Seat outbox operation is already ${operation.status}.`,
    );
  }
  return operation;
}

export async function recordTeamSeatOutboxOperationPending(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    operationId: string;
    response: unknown;
    controlPlaneOperationId?: string | null;
    errorCode: string;
    error: string;
    retryAt: number;
    now?: number;
  },
): Promise<TeamSeatOutboxOperation> {
  const now = input.now ?? Date.now();
  const operation = await getTeamSeatOutboxOperation(database, input.operationId);
  if (!operation) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_NOT_FOUND',
      'Team Seat outbox operation not found.',
      404,
    );
  }
  if (operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'canceled') {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_TERMINAL',
      `Team Seat outbox operation is already ${operation.status}.`,
    );
  }
  const result = await database.run(`
    UPDATE team_seat_outbox
    SET
      status = CASE
        WHEN attempt_count + 1 >= max_attempts THEN 'failed'
        ELSE 'retry_wait'
      END,
      response_json = ?,
      control_plane_operation_id = ?,
      attempt_count = attempt_count + 1,
      next_attempt_at = CASE
        WHEN attempt_count + 1 >= max_attempts THEN NULL
        ELSE ?
      END,
      last_attempt_at = ?,
      last_error_code = ?,
      last_error = ?,
      completed_at = CASE
        WHEN attempt_count + 1 >= max_attempts THEN ?
        ELSE NULL
      END,
      updated_at = ?
    WHERE operation_id = ?
      AND status NOT IN ('succeeded', 'failed', 'canceled')
      AND attempt_count < max_attempts
  `, [
    serializeResponse(input.response),
    optionalText(input.controlPlaneOperationId, 500),
    input.retryAt,
    now,
    optionalText(input.errorCode, 120),
    optionalText(input.error, 2000),
    now,
    now,
    input.operationId,
  ]);
  if (changesFromRunResult(result) !== 1) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      'The Team Seat outbox operation changed concurrently.',
    );
  }
  const pending = await getTeamSeatOutboxOperation(database, input.operationId);
  if (!pending) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_NOT_FOUND',
      'Team Seat outbox operation not found.',
      404,
    );
  }
  return pending;
}

export async function recordTeamSeatOutboxOperationSuccess(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    operationId: string;
    response: unknown;
    controlPlaneOperationId?: string | null;
    now?: number;
  },
): Promise<TeamSeatOutboxOperation> {
  const now = input.now ?? Date.now();
  const operation = await getTeamSeatOutboxOperation(database, input.operationId);
  if (!operation) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_NOT_FOUND',
      'Team Seat outbox operation not found.',
      404,
    );
  }

  const responseJson = serializeResponse(input.response);
  const controlPlaneOperationId = optionalText(input.controlPlaneOperationId, 500);
  if (operation.status === 'succeeded') {
    if (
      operation.responseJson !== responseJson
      || operation.controlPlaneOperationId !== controlPlaneOperationId
    ) {
      throw new TeamSeatOutboxError(
        'TEAM_SEAT_OUTBOX_CONFLICT',
        'The completed Team Seat operation cannot be replaced with a different response.',
      );
    }
    return operation;
  }
  if (operation.status === 'failed' || operation.status === 'canceled') {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_TERMINAL',
      `Team Seat outbox operation is already ${operation.status}.`,
    );
  }

  const result = await database.run(`
    UPDATE team_seat_outbox
    SET
      status = 'succeeded',
      response_json = ?,
      control_plane_operation_id = ?,
      attempt_count = CASE WHEN attempt_count = 0 THEN 1 ELSE attempt_count END,
      next_attempt_at = NULL,
      last_attempt_at = ?,
      last_error_code = NULL,
      last_error = NULL,
      completed_at = ?,
      updated_at = ?
    WHERE operation_id = ?
      AND status NOT IN ('succeeded', 'failed', 'canceled')
  `, [
    responseJson,
    controlPlaneOperationId,
    now,
    now,
    now,
    input.operationId,
  ]);
  if (changesFromRunResult(result) !== 1) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      'The Team Seat outbox operation changed concurrently.',
    );
  }
  const completed = await getTeamSeatOutboxOperation(database, input.operationId);
  if (!completed) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_NOT_FOUND',
      'Team Seat outbox operation not found.',
      404,
    );
  }
  return completed;
}

export async function getTeamMembershipSyncState(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
): Promise<TeamMembershipSyncState | null> {
  const row = await database.get(
    `${SYNC_STATE_SELECT} WHERE organization_id = ? LIMIT 1`,
    [organizationId],
  ) as SyncStateRow | undefined;
  return row ? mapSyncState(row) : null;
}

export async function recordTeamSeatSnapshotAcknowledgement(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    organizationId: string;
    operationId: string;
    response: unknown;
    entitlementsVersion?: number | null;
    now?: number;
    databaseProvider?: DatabaseProvider;
  },
): Promise<TeamMembershipSyncState> {
  const response = parseTeamSeatSnapshotResponse(input.response);
  const now = input.now ?? Date.now();

  return withTransaction(database, input.databaseProvider ?? getDatabaseProvider(), async () => {
    const operation = await getTeamSeatOutboxOperation(database, input.operationId);
    if (!operation || operation.organizationId !== input.organizationId) {
      throw new TeamSeatOutboxError('TEAM_SEAT_OUTBOX_NOT_FOUND', 'Snapshot outbox operation not found.', 404);
    }
    if (
      operation.operationKind !== 'membership_snapshot'
      || operation.membershipRevision !== response.snapshot.revision
    ) {
      throw new TeamSeatOutboxError(
        'TEAM_SEAT_SNAPSHOT_CONFLICT',
        'Control Plane acknowledgement does not match the local snapshot operation.',
      );
    }
    const request = JSON.parse(operation.requestJson) as TeamSeatSnapshotRequest;
    if (
      request.snapshotHash !== response.snapshot.snapshotHash
      || request.revision !== response.snapshot.revision
      || request.protocolVersion !== response.snapshot.protocolVersion
      || request.observedQuantity !== response.snapshot.observedQuantity
      || canonicalJson(request.roleSummary) !== canonicalJson(response.snapshot.roleSummary)
      || canonicalJson([...request.memberHashes].sort())
        !== canonicalJson([...response.snapshot.memberHashes].sort())
      || request.generatedAt !== response.snapshot.generatedAt
      || (request.notebookVersion ?? null) !== (response.snapshot.notebookVersion ?? null)
    ) {
      throw new TeamSeatOutboxError(
        'TEAM_SEAT_SNAPSHOT_CONFLICT',
        'Control Plane acknowledgement does not match the persisted snapshot payload.',
      );
    }

    const completed = await database.run(`
      UPDATE team_seat_outbox
      SET
        status = 'succeeded',
        response_json = ?,
        attempt_count = CASE WHEN attempt_count = 0 THEN 1 ELSE attempt_count END,
        next_attempt_at = NULL,
        last_attempt_at = ?,
        last_error_code = NULL,
        last_error = NULL,
        completed_at = ?,
        updated_at = ?
      WHERE operation_id = ?
        AND status NOT IN ('failed', 'canceled')
    `, [
      serializeResponse(response),
      now,
      now,
      now,
      input.operationId,
    ]);
    if (changesFromRunResult(completed) !== 1) {
      throw new TeamSeatOutboxError(
        'TEAM_SEAT_OUTBOX_TERMINAL',
        'Snapshot outbox operation can no longer be acknowledged.',
      );
    }

    await database.run(`
      UPDATE team_membership_sync_state
      SET
        acknowledged_revision = ?,
        acknowledged_snapshot_id = ?,
        acknowledged_snapshot_hash = ?,
        acknowledged_at = ?,
        control_plane_protocol_version = ?,
        control_plane_observed_quantity = ?,
        approved_quantity = ?,
        billed_quantity = ?,
        licensed_quantity = ?,
        expected_licensed_quantity = ?,
        entitlements_version = COALESCE(?, entitlements_version),
        billing_status = ?,
        drift_status = ?,
        next_report_at = ?,
        last_sync_error_code = NULL,
        last_sync_error = NULL,
        last_sync_at = ?,
        updated_at = ?
      WHERE organization_id = ?
        AND acknowledged_revision <= ?
        AND current_revision >= ?
    `, [
      response.snapshot.revision,
      response.snapshot.snapshotId,
      response.snapshot.snapshotHash,
      now,
      response.snapshot.protocolVersion,
      response.observedQuantity,
      response.approvedQuantity,
      response.billedQuantity,
      response.licensedQuantity,
      response.expectedLicensedQuantity,
      input.entitlementsVersion ?? null,
      response.billingStatus,
      response.snapshot.driftStatus,
      Date.parse(response.nextReportAt),
      now,
      now,
      input.organizationId,
      response.snapshot.revision,
      response.snapshot.revision,
    ]);

    const state = await getTeamMembershipSyncState(database, input.organizationId);
    if (!state) {
      throw new TeamSeatOutboxError(
        'TEAM_SEAT_SNAPSHOT_CONFLICT',
        'Team membership sync state not found.',
      );
    }
    return state;
  });
}

export async function readTeamSeatSyncDiagnostics(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
): Promise<TeamSeatSyncDiagnostics> {
  const [state, counts] = await Promise.all([
    getTeamMembershipSyncState(database, organizationId),
    database.get(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END) AS retry_wait,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        MIN(CASE WHEN status IN ('pending', 'processing', 'retry_wait') THEN created_at END) AS oldest_pending_at
      FROM team_seat_outbox
      WHERE organization_id = ?
    `, [organizationId]) as Promise<{
      pending: number | null;
      processing: number | null;
      retry_wait: number | null;
      failed: number | null;
      oldest_pending_at: number | null;
    } | undefined>,
  ]);

  return {
    state,
    outbox: {
      pending: Number(counts?.pending || 0),
      processing: Number(counts?.processing || 0),
      retryWait: Number(counts?.retry_wait || 0),
      failed: Number(counts?.failed || 0),
      oldestPendingAt: counts?.oldest_pending_at ?? null,
    },
  };
}
