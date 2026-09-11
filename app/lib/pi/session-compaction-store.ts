import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { fromDatabaseTimestamp, toDatabaseTimestamp } from '@/app/lib/db/timestamps';
import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import type { PiSessionSummaryState } from './history-budget';

export type PiCompactionTrigger = 'automatic' | 'manual' | 'automation';
export type PiCompactionAttemptState =
  | 'running'
  | 'succeeded'
  | 'no_op'
  | 'deferred'
  | 'failed'
  | 'aborted'
  | 'stale'
  | 'timed_out';

export type PiCompactionReasonCode =
  | 'soft_threshold_not_reached'
  | 'nothing_eligible'
  | 'latest_unit_too_large'
  | 'fixed_context_too_large'
  | 'retained_context_too_large'
  | 'active_tool_chain'
  | 'history_not_durable'
  | 'summary_provider_error'
  | 'summary_not_smaller'
  | 'summary_timeout'
  | 'summary_idle_timeout'
  | 'summary_total_timeout'
  | 'aborted'
  | 'stale_snapshot'
  | 'persistence_conflict'
  | 'cooldown_active'
  | 'breaker_active'
  | 'provider_context_overflow'
  | 'payload_bytes_exceeded';

export type PiCompactionAttemptMetrics = Readonly<{
  beforeEstimatedTokens?: number | null;
  afterEstimatedTokens?: number | null;
  beforeEstimatedBytes?: number | null;
  afterEstimatedBytes?: number | null;
  protectedUnitCount?: number | null;
  summarizedUnitCount?: number | null;
  omittedUnitCount?: number | null;
  triggerTokens?: number | null;
  targetTokens?: number | null;
  beforePressureBasisPoints?: number | null;
  afterPressureBasisPoints?: number | null;
  headUnitCount?: number | null;
  middleUnitCount?: number | null;
  tailUnitCount?: number | null;
  anchorCount?: number | null;
  summaryProvider?: string | null;
  summaryModel?: string | null;
  durationMs?: number | null;
  progressEventCount?: number | null;
}>;

export type PiCompactionAttemptTelemetry = Readonly<{
  triggerTokens: number | null;
  targetTokens: number | null;
  beforePressureBasisPoints: number | null;
  afterPressureBasisPoints: number | null;
  headUnitCount: number | null;
  middleUnitCount: number | null;
  tailUnitCount: number | null;
  anchorCount: number | null;
  summaryProvider: string | null;
  summaryModel: string | null;
  errorClass: PiCompactionReasonCode | null;
}>;

export type PiCompactionScope = Readonly<{
  sessionId: string;
  userId: string;
  agentId: string;
  workspaceId: string | null;
}>;

export type PiCompactionAttemptRecord = Readonly<{
  attemptId: string;
  piSessionDbId: number | string;
  attemptOrdinal: number;
  trigger: PiCompactionTrigger;
  state: PiCompactionAttemptState;
  reasonCode: PiCompactionReasonCode | null;
  baseSummaryRevision: number;
  committedSummaryRevision: number | null;
  baseThroughSequence: number | null;
  committedThroughSequence: number | null;
  messageSequenceCheckpoint: number;
  contractFingerprint: string | null;
  provider: string;
  model: string;
  startedAt: Date;
  deadlineAt: Date;
  completedAt: Date | null;
  retryAt: Date | null;
  idleDeadlineAt: Date | null;
  lastProgressAt: Date | null;
  progressEventCount: number;
  durationMs: number | null;
  telemetry: PiCompactionAttemptTelemetry;
}>;

export type PiMessageSequenceAudit = Readonly<{
  messageCount: number;
  distinctSequenceCount: number;
  minimumSequence: number | null;
  maximumSequence: number | null;
  nullSequenceCount: number;
  valid: boolean;
}>;

type ScopedSessionRow = {
  id: number | string;
  summary_revision: number | string;
  summary_through_sequence: number | string | null;
  workspace_id: string | null;
};

type AttemptRow = {
  id: string;
  pi_session_db_id: number | string;
  attempt_ordinal: number | string;
  trigger: PiCompactionTrigger;
  state: PiCompactionAttemptState;
  reason_code: PiCompactionReasonCode | null;
  base_summary_revision: number | string;
  committed_summary_revision: number | string | null;
  base_through_sequence: number | string | null;
  committed_through_sequence: number | string | null;
  message_sequence_checkpoint: number | string;
  contract_fingerprint: string | null;
  provider: string;
  model: string;
  started_at: number | string;
  deadline_at: number | string;
  completed_at: number | string | null;
  retry_at: number | string | null;
  idle_deadline_at: number | string | null;
  last_progress_at: number | string | null;
  progress_event_count: number | string;
  duration_ms: number | string | null;
  telemetry_json: string | null;
};

const TERMINAL_ATTEMPT_STATES = new Set<PiCompactionAttemptState>([
  'succeeded',
  'no_op',
  'deferred',
  'failed',
  'aborted',
  'stale',
  'timed_out',
]);
const MAX_COMPACTION_SUMMARY_CHARACTERS = 200_000;
const ATTEMPT_SELECT_COLUMNS = `id, pi_session_db_id, attempt_ordinal, trigger, state, reason_code,
  base_summary_revision, committed_summary_revision,
  base_through_sequence, committed_through_sequence,
  message_sequence_checkpoint, contract_fingerprint, provider, model,
  started_at, deadline_at, completed_at, retry_at,
  idle_deadline_at, last_progress_at, progress_event_count, duration_ms, telemetry_json`;

export class PiCompactionScopeError extends Error {
  constructor() {
    super('The compaction session is unavailable in the requested scope.');
    this.name = 'PiCompactionScopeError';
  }
}

export class PiCompactionHistoryIntegrityError extends Error {
  readonly audit: PiMessageSequenceAudit;

  constructor(audit: PiMessageSequenceAudit) {
    super('The persisted session history does not have a durable contiguous sequence.');
    this.name = 'PiCompactionHistoryIntegrityError';
    this.audit = audit;
  }
}

export class PiCompactionPersistenceConflictError extends Error {
  constructor(message = 'The compaction persistence fence no longer matches the session state.') {
    super(message);
    this.name = 'PiCompactionPersistenceConflictError';
  }
}

function integer(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function databaseDate(value: unknown): Date | null {
  const timestamp = nullableInteger(value);
  return timestamp === null ? null : fromDatabaseTimestamp(timestamp);
}

function changes(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const value = (result as { changes?: unknown }).changes;
  return integer(value);
}

function nonNegativeMetric(value: number | null | undefined, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return Math.floor(value);
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function parseTelemetry(value: string | null): PiCompactionAttemptTelemetry {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = value ? JSON.parse(value) as Record<string, unknown> : {};
  } catch {
    parsed = {};
  }
  return Object.freeze({
    triggerTokens: nullableInteger(parsed.triggerTokens),
    targetTokens: nullableInteger(parsed.targetTokens),
    beforePressureBasisPoints: nullableInteger(parsed.beforePressureBasisPoints),
    afterPressureBasisPoints: nullableInteger(parsed.afterPressureBasisPoints),
    headUnitCount: nullableInteger(parsed.headUnitCount),
    middleUnitCount: nullableInteger(parsed.middleUnitCount),
    tailUnitCount: nullableInteger(parsed.tailUnitCount),
    anchorCount: nullableInteger(parsed.anchorCount),
    summaryProvider: nullableText(typeof parsed.summaryProvider === 'string' ? parsed.summaryProvider : null),
    summaryModel: nullableText(typeof parsed.summaryModel === 'string' ? parsed.summaryModel : null),
    errorClass: typeof parsed.errorClass === 'string'
      ? parsed.errorClass as PiCompactionReasonCode
      : null,
  });
}

function mergeTelemetry(
  previous: string | null,
  metrics: PiCompactionAttemptMetrics,
  errorClass: PiCompactionReasonCode | null,
): string {
  const prior = parseTelemetry(previous);
  return JSON.stringify({
    triggerTokens: nonNegativeMetric(metrics.triggerTokens, 'triggerTokens') ?? prior.triggerTokens,
    targetTokens: nonNegativeMetric(metrics.targetTokens, 'targetTokens') ?? prior.targetTokens,
    beforePressureBasisPoints: nonNegativeMetric(
      metrics.beforePressureBasisPoints,
      'beforePressureBasisPoints',
    ) ?? prior.beforePressureBasisPoints,
    afterPressureBasisPoints: nonNegativeMetric(
      metrics.afterPressureBasisPoints,
      'afterPressureBasisPoints',
    ) ?? prior.afterPressureBasisPoints,
    headUnitCount: nonNegativeMetric(metrics.headUnitCount, 'headUnitCount') ?? prior.headUnitCount,
    middleUnitCount: nonNegativeMetric(metrics.middleUnitCount, 'middleUnitCount') ?? prior.middleUnitCount,
    tailUnitCount: nonNegativeMetric(metrics.tailUnitCount, 'tailUnitCount') ?? prior.tailUnitCount,
    anchorCount: nonNegativeMetric(metrics.anchorCount, 'anchorCount') ?? prior.anchorCount,
    summaryProvider: nullableText(metrics.summaryProvider) ?? prior.summaryProvider,
    summaryModel: nullableText(metrics.summaryModel) ?? prior.summaryModel,
    errorClass,
  } satisfies PiCompactionAttemptTelemetry);
}

function validateScope(scope: PiCompactionScope): PiCompactionScope {
  const sessionId = scope.sessionId.trim();
  const userId = scope.userId.trim();
  const agentId = scope.agentId.trim() || DEFAULT_AGENT_ID;
  const workspaceId = scope.workspaceId?.trim() || null;
  if (!sessionId || !userId || !agentId) throw new PiCompactionScopeError();
  return { sessionId, userId, agentId, workspaceId };
}

function mapAttempt(row: AttemptRow): PiCompactionAttemptRecord {
  const telemetry = parseTelemetry(row.telemetry_json);
  return Object.freeze({
    attemptId: row.id,
    piSessionDbId: row.pi_session_db_id,
    attemptOrdinal: integer(row.attempt_ordinal),
    trigger: row.trigger,
    state: row.state,
    reasonCode: row.reason_code,
    baseSummaryRevision: integer(row.base_summary_revision),
    committedSummaryRevision: nullableInteger(row.committed_summary_revision),
    baseThroughSequence: nullableInteger(row.base_through_sequence),
    committedThroughSequence: nullableInteger(row.committed_through_sequence),
    messageSequenceCheckpoint: integer(row.message_sequence_checkpoint),
    contractFingerprint: row.contract_fingerprint,
    provider: row.provider,
    model: row.model,
    startedAt: databaseDate(row.started_at)!,
    deadlineAt: databaseDate(row.deadline_at)!,
    completedAt: databaseDate(row.completed_at),
    retryAt: databaseDate(row.retry_at),
    idleDeadlineAt: databaseDate(row.idle_deadline_at),
    lastProgressAt: databaseDate(row.last_progress_at),
    progressEventCount: integer(row.progress_event_count),
    durationMs: nullableInteger(row.duration_ms),
    telemetry: telemetry.errorClass || !row.reason_code
      ? telemetry
      : Object.freeze({ ...telemetry, errorClass: row.reason_code }),
  });
}

async function withTransaction<T>(
  connection: SqlConnection,
  operation: () => Promise<T>,
): Promise<T> {
  let started = false;
  try {
    await connection.run('BEGIN');
    started = true;
    const result = await operation();
    await connection.run('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
    }
    throw error;
  }
}

async function getScopedSessionForUpdate(
  connection: SqlConnection,
  scope: PiCompactionScope,
): Promise<ScopedSessionRow> {
  const rows = await connection.all(
    `SELECT id, summary_revision, summary_through_sequence, workspace_id
     FROM pi_sessions
     WHERE session_id = $1 AND user_id = $2 AND agent_id = $3
     ORDER BY id ASC
     LIMIT 2 FOR UPDATE`,
    [scope.sessionId, scope.userId, scope.agentId],
  ) as ScopedSessionRow[];
  if (rows.length !== 1 || (rows[0].workspace_id ?? null) !== scope.workspaceId) {
    throw new PiCompactionScopeError();
  }
  return rows[0];
}

async function getAttemptForSession(
  connection: SqlConnection,
  attemptId: string,
  piSessionDbId: number | string,
  forUpdate: boolean,
): Promise<AttemptRow | null> {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  return await connection.get(
    `SELECT ${ATTEMPT_SELECT_COLUMNS}
     FROM pi_session_compaction_attempts
     WHERE id = $1 AND pi_session_db_id = $2
     LIMIT 1${lock}`,
    [attemptId, piSessionDbId],
  ) as AttemptRow | undefined ?? null;
}

export async function auditPiMessageSequenceIntegrityOnConnection(
  connection: SqlConnection,
  piSessionDbId: number | string,
): Promise<PiMessageSequenceAudit> {
  const row = await connection.get(
    `SELECT
       COUNT(*) AS message_count,
       COUNT(DISTINCT sequence) AS distinct_sequence_count,
       MIN(sequence) AS minimum_sequence,
       MAX(sequence) AS maximum_sequence,
       SUM(CASE WHEN sequence IS NULL THEN 1 ELSE 0 END) AS null_sequence_count
     FROM pi_messages
     WHERE pi_session_db_id = $1`,
    [piSessionDbId],
  ) as Record<string, unknown> | undefined;
  const messageCount = integer(row?.message_count);
  const distinctSequenceCount = integer(row?.distinct_sequence_count);
  const minimumSequence = nullableInteger(row?.minimum_sequence);
  const maximumSequence = nullableInteger(row?.maximum_sequence);
  const nullSequenceCount = integer(row?.null_sequence_count);
  const valid = messageCount === 0 || (
    nullSequenceCount === 0
    && distinctSequenceCount === messageCount
    && minimumSequence === 1
    && maximumSequence === messageCount
  );
  return Object.freeze({
    messageCount,
    distinctSequenceCount,
    minimumSequence,
    maximumSequence,
    nullSequenceCount,
    valid,
  });
}

export type StartPiCompactionAttemptInput = PiCompactionScope & Readonly<{
  attemptId: string;
  trigger: PiCompactionTrigger;
  /** Allows one internal exact-budget retry through an automatic cooldown. */
  bypassCooldown?: boolean;
  expectedSummaryRevision: number;
  expectedThroughSequence: number | null;
  deadlineAt: Date;
  idleDeadlineAt?: Date | null;
  provider: string;
  model: string;
  contractFingerprint?: string | null;
  metrics?: PiCompactionAttemptMetrics;
  expiredAttemptRetryAt?: Date | null;
  now?: Date;
}>;

export type StartPiCompactionAttemptResult =
  | Readonly<{ status: 'started'; attempt: PiCompactionAttemptRecord }>
  | Readonly<{ status: 'already_running'; attempt: PiCompactionAttemptRecord }>
  | Readonly<{ status: 'cooldown_active'; attempt: PiCompactionAttemptRecord }>
  | Readonly<{ status: 'breaker_active'; attempt: PiCompactionAttemptRecord }>
  | Readonly<{ status: 'stale'; currentSummaryRevision: number; currentThroughSequence: number | null }>;

export async function startPiSessionCompactionAttemptOnConnection(
  connection: SqlConnection,
  input: StartPiCompactionAttemptInput,
): Promise<StartPiCompactionAttemptResult> {
  const scope = validateScope(input);
  const attemptId = input.attemptId.trim();
  const runtimeProvider = input.provider.trim();
  const model = input.model.trim();
  const now = input.now ?? new Date();
  if (!attemptId || !runtimeProvider || !model) throw new Error('Compaction attempt identity is incomplete.');
  if (!Number.isSafeInteger(input.expectedSummaryRevision) || input.expectedSummaryRevision < 0) {
    throw new Error('expectedSummaryRevision must be a non-negative integer.');
  }
  if (
    input.expectedThroughSequence !== null
    && (!Number.isSafeInteger(input.expectedThroughSequence) || input.expectedThroughSequence <= 0)
  ) {
    throw new Error('expectedThroughSequence must be null or a positive integer.');
  }
  if (input.expiredAttemptRetryAt && input.expiredAttemptRetryAt.getTime() <= now.getTime()) {
    throw new Error('expiredAttemptRetryAt must be in the future.');
  }
  if (input.deadlineAt.getTime() <= now.getTime()) throw new Error('Compaction deadline must be in the future.');
  if (input.idleDeadlineAt && input.idleDeadlineAt.getTime() <= now.getTime()) {
    throw new Error('Compaction idle deadline must be in the future.');
  }
  const metrics = input.metrics ?? {};

  return withTransaction(connection, async () => {
    const session = await getScopedSessionForUpdate(connection, scope);
    const nowTimestamp = toDatabaseTimestamp(now);
    await connection.run(
      `UPDATE pi_session_compaction_attempts
       SET state = 'timed_out',
           reason_code = CASE
             WHEN idle_deadline_at IS NOT NULL AND idle_deadline_at <= $1 AND deadline_at > $2
               THEN 'summary_idle_timeout'
             ELSE 'summary_total_timeout'
           END,
           completed_at = $3, retry_at = COALESCE(retry_at, $4), updated_at = $5,
           duration_ms = CASE WHEN $6 > started_at THEN ($7 - started_at) * 1000 ELSE 0 END
       WHERE pi_session_db_id = $8 AND state = 'running'
         AND (deadline_at <= $9 OR (idle_deadline_at IS NOT NULL AND idle_deadline_at <= $10))`,
      [
        nowTimestamp,
        nowTimestamp,
        nowTimestamp,
        input.expiredAttemptRetryAt ? toDatabaseTimestamp(input.expiredAttemptRetryAt) : null,
        nowTimestamp,
        nowTimestamp,
        nowTimestamp,
        session.id,
        nowTimestamp,
        nowTimestamp,
      ],
    );
    const existing = await connection.get(
      `SELECT ${ATTEMPT_SELECT_COLUMNS}
       FROM pi_session_compaction_attempts
       WHERE pi_session_db_id = $1 AND state = 'running'
       ORDER BY attempt_ordinal DESC
       LIMIT 1`,
      [session.id],
    ) as AttemptRow | undefined;
    if (existing) return { status: 'already_running', attempt: mapAttempt(existing) };

    const latestTerminal = await connection.get(
      `SELECT ${ATTEMPT_SELECT_COLUMNS}
       FROM pi_session_compaction_attempts
       WHERE pi_session_db_id = $1 AND state <> 'running'
       ORDER BY attempt_ordinal DESC
       LIMIT 1`,
      [session.id],
    ) as AttemptRow | undefined;
    if (latestTerminal?.state !== 'succeeded') {
      const cooldownAttempt = await connection.get(
        `SELECT ${ATTEMPT_SELECT_COLUMNS}
         FROM pi_session_compaction_attempts
         WHERE pi_session_db_id = $1 AND retry_at > $2
         ORDER BY attempt_ordinal DESC
         LIMIT 1`,
        [session.id, nowTimestamp],
      ) as AttemptRow | undefined;
      if (cooldownAttempt) {
        const cooldownIsExactBudgetRetry = cooldownAttempt.contract_fingerprint?.startsWith('exact-budget-retry:') ?? false;
        let bypassAvailable = (
          input.trigger === 'manual'
          && cooldownAttempt.trigger !== 'manual'
        ) || (
          input.bypassCooldown === true
          && cooldownAttempt.trigger !== 'manual'
          && !cooldownIsExactBudgetRetry
        );
        if (bypassAvailable && input.trigger === 'manual') {
          const previousManualBypass = await connection.get(
            `SELECT id FROM pi_session_compaction_attempts
             WHERE pi_session_db_id = $1 AND trigger = 'manual' AND attempt_ordinal > $2
             LIMIT 1`,
            [session.id, cooldownAttempt.attempt_ordinal],
          ) as { id?: string } | undefined;
          bypassAvailable = previousManualBypass?.id === undefined;
        }
        if (!bypassAvailable) {
          const breakerActive = cooldownAttempt.state === 'no_op'
            && (cooldownAttempt.reason_code === 'nothing_eligible'
              || cooldownAttempt.reason_code === 'summary_not_smaller');
          return {
            status: breakerActive ? 'breaker_active' : 'cooldown_active',
            attempt: mapAttempt(cooldownAttempt),
          };
        }
      }
    }

    const currentRevision = integer(session.summary_revision);
    const currentThroughSequence = nullableInteger(session.summary_through_sequence);
    if (
      currentRevision !== input.expectedSummaryRevision
      || currentThroughSequence !== input.expectedThroughSequence
    ) {
      return {
        status: 'stale',
        currentSummaryRevision: currentRevision,
        currentThroughSequence,
      };
    }
    const audit = await auditPiMessageSequenceIntegrityOnConnection(connection, session.id);
    if (!audit.valid) throw new PiCompactionHistoryIntegrityError(audit);
    const checkpoint = audit.maximumSequence ?? 0;
    const ordinalRow = await connection.get(
      `SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS next_ordinal
       FROM pi_session_compaction_attempts WHERE pi_session_db_id = $1`,
      [session.id],
    ) as { next_ordinal?: number | string } | undefined;
    const attemptOrdinal = integer(ordinalRow?.next_ordinal, 1);
    const deadlineTimestamp = toDatabaseTimestamp(input.deadlineAt);
    const idleDeadlineTimestamp = input.idleDeadlineAt
      ? toDatabaseTimestamp(input.idleDeadlineAt)
      : null;
    const telemetryJson = mergeTelemetry(null, metrics, null);
    await connection.run(
      `INSERT INTO pi_session_compaction_attempts (
         id, pi_session_db_id, attempt_ordinal, trigger, state, reason_code,
         base_summary_revision, committed_summary_revision,
         base_through_sequence, committed_through_sequence, message_sequence_checkpoint,
         contract_fingerprint, provider, model,
         before_estimated_tokens, after_estimated_tokens,
         before_estimated_bytes, after_estimated_bytes,
         protected_unit_count, summarized_unit_count, omitted_unit_count,
         started_at, deadline_at, completed_at, retry_at, created_at, updated_at,
         idle_deadline_at, last_progress_at, progress_event_count, duration_ms, telemetry_json
       ) VALUES ($1, $2, $3, $4, 'running', NULL, $5, NULL, $6, NULL, $7, $8, $9, $10, $11, NULL, $12, NULL, $13, NULL, NULL, $14, $15, NULL, NULL, $16, $17, $18, $19, 0, NULL, $20)`,
      [
        attemptId,
        session.id,
        attemptOrdinal,
        input.trigger,
        currentRevision,
        currentThroughSequence,
        checkpoint,
        input.contractFingerprint?.trim() || null,
        runtimeProvider,
        model,
        nonNegativeMetric(metrics.beforeEstimatedTokens, 'beforeEstimatedTokens'),
        nonNegativeMetric(metrics.beforeEstimatedBytes, 'beforeEstimatedBytes'),
        nonNegativeMetric(metrics.protectedUnitCount, 'protectedUnitCount'),
        nowTimestamp,
        deadlineTimestamp,
        nowTimestamp,
        nowTimestamp,
        idleDeadlineTimestamp,
        nowTimestamp,
        telemetryJson,
      ],
    );
    const inserted = await getAttemptForSession(connection, attemptId, session.id, false);
    if (!inserted) throw new PiCompactionPersistenceConflictError('Compaction attempt was not persisted.');
    return { status: 'started', attempt: mapAttempt(inserted) };
  });
}

export async function countPiSessionCompactionRetryFailuresOnConnection(
  connection: SqlConnection,
  scopeInput: PiCompactionScope,
): Promise<number> {
  const scope = validateScope(scopeInput);
  return withTransaction(connection, async () => {
    const session = await getScopedSessionForUpdate(connection, scope);
    const row = await connection.get(
      `SELECT COUNT(*) AS failure_count
       FROM pi_session_compaction_attempts
       WHERE pi_session_db_id = $1 AND retry_at IS NOT NULL
         AND attempt_ordinal > COALESCE((
           SELECT MAX(attempt_ordinal)
           FROM pi_session_compaction_attempts
           WHERE pi_session_db_id = $2 AND state = 'succeeded'
         ), 0)`,
      [session.id, session.id],
    ) as { failure_count?: number | string } | undefined;
    return integer(row?.failure_count);
  });
}

export async function countPiSessionCompactionIneffectiveAttemptsOnConnection(
  connection: SqlConnection,
  scopeInput: PiCompactionScope,
): Promise<number> {
  const scope = validateScope(scopeInput);
  return withTransaction(connection, async () => {
    const session = await getScopedSessionForUpdate(connection, scope);
    const row = await connection.get(
      `SELECT COUNT(*) AS ineffective_count
       FROM pi_session_compaction_attempts
       WHERE pi_session_db_id = $1
         AND trigger IN ('automatic', 'automation')
         AND state = 'no_op' AND reason_code IN ('nothing_eligible', 'summary_not_smaller')
         AND attempt_ordinal > COALESCE((
           SELECT MAX(attempt_ordinal)
           FROM pi_session_compaction_attempts
           WHERE pi_session_db_id = $2 AND state = 'succeeded'
         ), 0)`,
      [session.id, session.id],
    ) as { ineffective_count?: number | string } | undefined;
    return integer(row?.ineffective_count);
  });
}

export type RecordPiCompactionProgressInput = PiCompactionScope & Readonly<{
  attemptId: string;
  idleDeadlineAt: Date;
  now?: Date;
}>;

export async function recordPiSessionCompactionProgressOnConnection(
  connection: SqlConnection,
  input: RecordPiCompactionProgressInput,
): Promise<boolean> {
  const scope = validateScope(input);
  const now = input.now ?? new Date();
  if (input.idleDeadlineAt.getTime() <= now.getTime()) {
    throw new Error('Compaction progress must extend the idle deadline.');
  }
  return withTransaction(connection, async () => {
    const session = await getScopedSessionForUpdate(connection, scope);
    const timestamp = toDatabaseTimestamp(now);
    const updated = await connection.run(
      `UPDATE pi_session_compaction_attempts
       SET last_progress_at = $1, idle_deadline_at = $2,
           progress_event_count = progress_event_count + 1, updated_at = $3
       WHERE id = $4 AND pi_session_db_id = $5 AND state = 'running'`,
      [
        timestamp,
        toDatabaseTimestamp(input.idleDeadlineAt),
        timestamp,
        input.attemptId.trim(),
        session.id,
      ],
    );
    return changes(updated) === 1;
  });
}

export type FinishPiCompactionAttemptInput = PiCompactionScope & Readonly<{
  attemptId: string;
  state: Exclude<PiCompactionAttemptState, 'running' | 'succeeded'>;
  reasonCode: PiCompactionReasonCode;
  retryAt?: Date | null;
  metrics?: PiCompactionAttemptMetrics;
  now?: Date;
}>;

export async function finishPiSessionCompactionAttemptOnConnection(
  connection: SqlConnection,
  input: FinishPiCompactionAttemptInput,
): Promise<Readonly<{ changed: boolean; attempt: PiCompactionAttemptRecord }>> {
  if (!TERMINAL_ATTEMPT_STATES.has(input.state)) {
    throw new Error('Invalid non-success compaction terminal state.');
  }
  const scope = validateScope(input);
  const now = input.now ?? new Date();
  const metrics = input.metrics ?? {};
  return withTransaction(connection, async () => {
    const session = await getScopedSessionForUpdate(connection, scope);
    const attempt = await getAttemptForSession(connection, input.attemptId.trim(), session.id, true);
    if (!attempt) throw new PiCompactionScopeError();
    if (attempt.state !== 'running') return { changed: false, attempt: mapAttempt(attempt) };
    const timestamp = toDatabaseTimestamp(now);
    const durationMs = nonNegativeMetric(
      metrics.durationMs ?? Math.max(0, now.getTime() - databaseDate(attempt.started_at)!.getTime()),
      'durationMs',
    );
    const progressEventCount = nonNegativeMetric(metrics.progressEventCount, 'progressEventCount');
    const telemetryJson = mergeTelemetry(attempt.telemetry_json, metrics, input.reasonCode);
    const result = await connection.run(
      `UPDATE pi_session_compaction_attempts
       SET state = $1, reason_code = $2, completed_at = $3, retry_at = $4, updated_at = $5,
           after_estimated_tokens = $6, after_estimated_bytes = $7,
           protected_unit_count = COALESCE($8, protected_unit_count),
           summarized_unit_count = $9, omitted_unit_count = $10,
           duration_ms = $11, progress_event_count = COALESCE($12, progress_event_count),
           telemetry_json = $13
       WHERE id = $14 AND pi_session_db_id = $15 AND state = 'running'`,
      [
        input.state,
        input.reasonCode,
        timestamp,
        input.retryAt ? toDatabaseTimestamp(input.retryAt) : null,
        timestamp,
        nonNegativeMetric(metrics.afterEstimatedTokens, 'afterEstimatedTokens'),
        nonNegativeMetric(metrics.afterEstimatedBytes, 'afterEstimatedBytes'),
        nonNegativeMetric(metrics.protectedUnitCount, 'protectedUnitCount'),
        nonNegativeMetric(metrics.summarizedUnitCount, 'summarizedUnitCount'),
        nonNegativeMetric(metrics.omittedUnitCount, 'omittedUnitCount'),
        durationMs,
        progressEventCount,
        telemetryJson,
        attempt.id,
        session.id,
      ],
    );
    if (changes(result) !== 1) throw new PiCompactionPersistenceConflictError();
    const updated = await getAttemptForSession(connection, attempt.id, session.id, false);
    if (!updated) throw new PiCompactionPersistenceConflictError();
    return { changed: true, attempt: mapAttempt(updated) };
  });
}

export type CommitPiCompactionSummaryInput = PiCompactionScope & Readonly<{
  attemptId: string;
  expectedSummaryRevision: number;
  expectedThroughSequence: number | null;
  summaryText: string;
  throughSequence: number;
  metrics?: PiCompactionAttemptMetrics;
  now?: Date;
}>;

export type CommitPiCompactionSummaryResult =
  | Readonly<{ status: 'committed'; summary: PiSessionSummaryState; attempt: PiCompactionAttemptRecord }>
  | Readonly<{ status: 'stale'; attempt: PiCompactionAttemptRecord }>
  | Readonly<{ status: 'already_finished'; attempt: PiCompactionAttemptRecord }>;

export async function commitPiSessionCompactionSummaryOnConnection(
  connection: SqlConnection,
  input: CommitPiCompactionSummaryInput,
): Promise<CommitPiCompactionSummaryResult> {
  const scope = validateScope(input);
  const summaryText = input.summaryText.trim();
  if (!summaryText) throw new Error('A successful compaction requires non-empty summary text.');
  if (summaryText.length > MAX_COMPACTION_SUMMARY_CHARACTERS) {
    throw new Error('Compaction summary exceeds the persistence limit.');
  }
  if (!Number.isSafeInteger(input.expectedSummaryRevision) || input.expectedSummaryRevision < 0) {
    throw new Error('expectedSummaryRevision must be a non-negative integer.');
  }
  if (
    input.expectedThroughSequence !== null
    && (!Number.isSafeInteger(input.expectedThroughSequence) || input.expectedThroughSequence <= 0)
  ) {
    throw new Error('expectedThroughSequence must be null or a positive integer.');
  }
  if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence <= 0) {
    throw new Error('throughSequence must be a positive integer.');
  }
  const now = input.now ?? new Date();
  const metrics = input.metrics ?? {};
  return withTransaction(connection, async () => {
    const session = await getScopedSessionForUpdate(connection, scope);
    const attempt = await getAttemptForSession(connection, input.attemptId.trim(), session.id, true);
    if (!attempt) throw new PiCompactionScopeError();
    if (attempt.state !== 'running') {
      return { status: 'already_finished', attempt: mapAttempt(attempt) };
    }
    const currentRevision = integer(session.summary_revision);
    const currentThroughSequence = nullableInteger(session.summary_through_sequence);
    const baseRevision = integer(attempt.base_summary_revision);
    const baseThroughSequence = nullableInteger(attempt.base_through_sequence);
    const stale = currentRevision !== input.expectedSummaryRevision
      || currentThroughSequence !== input.expectedThroughSequence
      || baseRevision !== input.expectedSummaryRevision
      || baseThroughSequence !== input.expectedThroughSequence
      || input.throughSequence > integer(attempt.message_sequence_checkpoint)
      || (currentThroughSequence !== null && input.throughSequence < currentThroughSequence);
    if (stale) {
      const timestamp = toDatabaseTimestamp(now);
      const durationMs = nonNegativeMetric(
        metrics.durationMs ?? Math.max(0, now.getTime() - databaseDate(attempt.started_at)!.getTime()),
        'durationMs',
      );
      const progressEventCount = nonNegativeMetric(metrics.progressEventCount, 'progressEventCount');
      const telemetryJson = mergeTelemetry(attempt.telemetry_json, metrics, 'stale_snapshot');
      await connection.run(
        `UPDATE pi_session_compaction_attempts
         SET state = 'stale', reason_code = 'stale_snapshot', completed_at = $1, updated_at = $2,
             duration_ms = $3, progress_event_count = COALESCE($4, progress_event_count),
             telemetry_json = $5
         WHERE id = $6 AND pi_session_db_id = $7 AND state = 'running'`,
        [timestamp, timestamp, durationMs, progressEventCount, telemetryJson, attempt.id, session.id],
      );
      const updated = await getAttemptForSession(connection, attempt.id, session.id, false);
      if (!updated) throw new PiCompactionPersistenceConflictError();
      return { status: 'stale', attempt: mapAttempt(updated) };
    }
    const boundaryMessage = await connection.get(
      `SELECT timestamp FROM pi_messages
       WHERE pi_session_db_id = $1 AND sequence = $2
       LIMIT 1`,
      [session.id, input.throughSequence],
    ) as { timestamp?: number | string } | undefined;
    if (boundaryMessage?.timestamp === undefined) {
      throw new PiCompactionHistoryIntegrityError(
        await auditPiMessageSequenceIntegrityOnConnection(connection, session.id),
      );
    }
    const summaryUpdatedAt = toDatabaseTimestamp(now);
    const summaryThroughTimestamp = integer(boundaryMessage.timestamp);
    const nextRevision = currentRevision + 1;
    const durationMs = nonNegativeMetric(
      metrics.durationMs ?? Math.max(0, now.getTime() - databaseDate(attempt.started_at)!.getTime()),
      'durationMs',
    );
    const progressEventCount = nonNegativeMetric(metrics.progressEventCount, 'progressEventCount');
    const telemetryJson = mergeTelemetry(attempt.telemetry_json, metrics, null);
    const sessionUpdate = await connection.run(
      `UPDATE pi_sessions
       SET summary_text = $1, summary_updated_at = $2, summary_through_timestamp = $3,
           summary_through_sequence = $4, summary_revision = $5, updated_at = $6
       WHERE id = $7 AND summary_revision = $8
         AND COALESCE(summary_through_sequence, -1) = COALESCE($9, -1)`,
      [
        summaryText,
        summaryUpdatedAt,
        summaryThroughTimestamp,
        input.throughSequence,
        nextRevision,
        summaryUpdatedAt,
        session.id,
        currentRevision,
        currentThroughSequence,
      ],
    );
    if (changes(sessionUpdate) !== 1) throw new PiCompactionPersistenceConflictError();
    const attemptUpdate = await connection.run(
      `UPDATE pi_session_compaction_attempts
       SET state = 'succeeded', reason_code = NULL, committed_summary_revision = $1,
           committed_through_sequence = $2, completed_at = $3, updated_at = $4,
           after_estimated_tokens = $5, after_estimated_bytes = $6,
           protected_unit_count = COALESCE($7, protected_unit_count),
           summarized_unit_count = $8, omitted_unit_count = $9,
           duration_ms = $10, progress_event_count = COALESCE($11, progress_event_count),
           telemetry_json = $12
       WHERE id = $13 AND pi_session_db_id = $14 AND state = 'running'`,
      [
        nextRevision,
        input.throughSequence,
        summaryUpdatedAt,
        summaryUpdatedAt,
        nonNegativeMetric(metrics.afterEstimatedTokens, 'afterEstimatedTokens'),
        nonNegativeMetric(metrics.afterEstimatedBytes, 'afterEstimatedBytes'),
        nonNegativeMetric(metrics.protectedUnitCount, 'protectedUnitCount'),
        nonNegativeMetric(metrics.summarizedUnitCount, 'summarizedUnitCount'),
        nonNegativeMetric(metrics.omittedUnitCount, 'omittedUnitCount'),
        durationMs,
        progressEventCount,
        telemetryJson,
        attempt.id,
        session.id,
      ],
    );
    if (changes(attemptUpdate) !== 1) throw new PiCompactionPersistenceConflictError();
    const updatedAttempt = await getAttemptForSession(connection, attempt.id, session.id, false);
    if (!updatedAttempt) throw new PiCompactionPersistenceConflictError();
    return {
      status: 'committed',
      summary: {
        summaryText,
        summaryUpdatedAt: databaseDate(summaryUpdatedAt),
        summaryThroughTimestamp,
        summaryThroughSequence: input.throughSequence,
        summaryRevision: nextRevision,
      },
      attempt: mapAttempt(updatedAttempt),
    };
  });
}

async function withCompactionConnection<T>(
  scope: PiCompactionScope,
  operation: (connection: SqlConnection) => Promise<T>,
): Promise<T> {
  const validatedScope = validateScope(scope);
  return withKeyedOperationLock(
    'pi-session-compaction-store',
    JSON.stringify([validatedScope.userId, validatedScope.sessionId, validatedScope.agentId]),
    async () => {
      const connection = await openDb();
      try {
        return await operation(connection);
      } finally {
        await connection.close();
      }
    },
  );
}

export function startPiSessionCompactionAttempt(
  input: StartPiCompactionAttemptInput,
): Promise<StartPiCompactionAttemptResult> {
  return withCompactionConnection(input, (connection) => (
    startPiSessionCompactionAttemptOnConnection(connection, input)
  ));
}

export function finishPiSessionCompactionAttempt(
  input: FinishPiCompactionAttemptInput,
): Promise<Readonly<{ changed: boolean; attempt: PiCompactionAttemptRecord }>> {
  return withCompactionConnection(input, (connection) => (
    finishPiSessionCompactionAttemptOnConnection(connection, input)
  ));
}

export function countPiSessionCompactionRetryFailures(
  input: PiCompactionScope,
): Promise<number> {
  return withCompactionConnection(input, (connection) => (
    countPiSessionCompactionRetryFailuresOnConnection(connection, input)
  ));
}

export function countPiSessionCompactionIneffectiveAttempts(
  input: PiCompactionScope,
): Promise<number> {
  return withCompactionConnection(input, (connection) => (
    countPiSessionCompactionIneffectiveAttemptsOnConnection(connection, input)
  ));
}

export function recordPiSessionCompactionProgress(
  input: RecordPiCompactionProgressInput,
): Promise<boolean> {
  return withCompactionConnection(input, (connection) => (
    recordPiSessionCompactionProgressOnConnection(connection, input)
  ));
}

export function commitPiSessionCompactionSummary(
  input: CommitPiCompactionSummaryInput,
): Promise<CommitPiCompactionSummaryResult> {
  return withCompactionConnection(input, (connection) => (
    commitPiSessionCompactionSummaryOnConnection(connection, input)
  ));
}
