import 'server-only';

import { createHash } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { withBorrowedWriteTransaction } from '@/app/lib/db/borrowed-write-transaction';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';

export type WorkspaceOperationActor = { type: 'user' | 'agent' | 'system'; id: string };
export type WorkspaceOperationStatus = 'prepared' | 'running' | 'completed' | 'failed' | 'recovery_required';
export type WorkspaceOperationPhase = 'prepared' | 'path' | 'link' | 'completed';
export type WorkspaceOperationStepPhase = 'path' | 'link';
export type WorkspaceOperationRequest = {
  kind: 'rename' | 'move' | 'copy';
  selections: ReadonlyArray<{ sourcePath: string; destinationPath: string }>;
  /** Private original request data; never synthesize this for legacy rows. */
  origin?: WorkspaceOperationCopyOrigin;
};

export type WorkspaceOperationRecord = {
  operationId: string;
  planId: string;
  requestHash: string;
  requestJson: string;
  actor: WorkspaceOperationActor;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  expectedStepCount: number;
  status: WorkspaceOperationStatus;
  phase: WorkspaceOperationPhase;
  revision: number;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceOperationStepRecord = {
  operationId: string;
  stepKey: string;
  phase: WorkspaceOperationStepPhase;
  status: 'intent' | 'applied';
  beforeFence: string;
  afterFence: string;
  backupRef: string | null;
  receiptJson: string | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceOperationWithSteps = WorkspaceOperationRecord & { steps: WorkspaceOperationStepRecord[] };

export class WorkspaceOperationJournalConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceOperationJournalConflictError';
  }
}

export class WorkspaceOperationJournalUncertainCommitError extends Error {
  readonly status = 503;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'WorkspaceOperationJournalUncertainCommitError';
  }
}

type PrepareInput = {
  operationId: string;
  planId: string;
  request: WorkspaceOperationRequest;
  actor: WorkspaceOperationActor;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  expectedStepCount: number;
};

type BeginStepInput = {
  operationId: string;
  stepKey: string;
  phase: WorkspaceOperationStepPhase;
  beforeFence: string;
  afterFence: string;
  backupRef?: string | null;
};

type FinishStepInput = {
  operationId: string;
  stepKey: string;
  beforeFence: string;
  afterFence: string;
  receipt: unknown;
};

type FailureInput = {
  operationId: string;
  errorCode: string;
  recoveryRequired: boolean;
};

type OperationRow = Record<string, unknown>;
type StepRow = Record<string, unknown>;

function canonicalJson(value: unknown): string {
  const visit = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate && typeof candidate === 'object' && Object.getPrototypeOf(candidate) === Object.prototype) {
      return Object.fromEntries(Object.entries(candidate).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, visit(entry)]));
    }
    throw new Error('Operation journal values must be finite JSON data.');
  };
  const serialized = JSON.stringify(visit(value));
  if (typeof serialized !== 'string') throw new Error('Operation journal value must be JSON data.');
  return serialized;
}

function checkedText(value: string, label: string, maxLength: number, minLength = 1): string {
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    throw new Error(`${label} must be ${minLength}-${maxLength} characters.`);
  }
  return value;
}

function checkedRequest(request: WorkspaceOperationRequest): WorkspaceOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !['kind,selections', 'kind,origin,selections'].includes(Object.keys(request).sort().join(','))
    || !['rename', 'move', 'copy'].includes(request.kind)
    || !Array.isArray(request.selections) || request.selections.length < 1 || request.selections.length > 1000) {
    throw new Error('Operation request must contain only kind and one or more path selections.');
  }
  for (const selection of request.selections) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).sort().join(',') !== 'destinationPath,sourcePath') {
      throw new Error('Each operation selection must contain sourcePath and destinationPath.');
    }
    for (const [label, value] of [
      ['sourcePath', selection.sourcePath], ['destinationPath', selection.destinationPath],
    ] as const) {
      if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
      checkedText(value, label, 1024);
      if (value.startsWith('/') || value.includes('\\') || value.includes('\0')
        || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new Error(`${label} must be a canonical workspace-relative path.`);
      }
    }
  }
  if (Object.hasOwn(request, 'origin')) {
    if (request.kind !== 'copy') throw new Error('Only Copy requests may contain an original context.');
    const descriptor = Object.getOwnPropertyDescriptor(request, 'origin');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Copy origin must be data.');
    return { kind: request.kind, selections: request.selections,
      origin: decodeWorkspaceOperationCopyOrigin(descriptor.value) };
  }
  return request;
}

/** Same exact serialization for preparation and existing-request comparison. */
export function serializeWorkspaceOperationRequest(request: WorkspaceOperationRequest): Readonly<{
  requestJson: string; requestHash: string;
}> {
  const requestJson = canonicalJson(checkedRequest(request));
  checkedText(requestJson, 'request', 65536, 2);
  return { requestJson, requestHash: createHash('sha256').update(requestJson).digest('hex') };
}

function readOperation(row: OperationRow): WorkspaceOperationRecord {
  return {
    operationId: String(row.operation_id),
    planId: String(row.plan_id),
    requestHash: String(row.request_hash),
    requestJson: String(row.request_json),
    actor: { type: row.actor_type as WorkspaceOperationActor['type'], id: String(row.actor_id) },
    sourceWorkspaceId: String(row.source_workspace_id),
    destinationWorkspaceId: String(row.destination_workspace_id),
    expectedStepCount: Number(row.expected_step_count),
    status: row.status as WorkspaceOperationStatus,
    phase: row.phase as WorkspaceOperationPhase,
    revision: Number(row.revision),
    errorCode: row.error_code === null ? null : String(row.error_code),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function readStep(row: StepRow): WorkspaceOperationStepRecord {
  return {
    operationId: String(row.operation_id),
    stepKey: String(row.step_key),
    phase: row.phase as WorkspaceOperationStepPhase,
    status: row.status as WorkspaceOperationStepRecord['status'],
    beforeFence: String(row.before_fence),
    afterFence: String(row.after_fence),
    backupRef: row.backup_ref === null ? null : String(row.backup_ref),
    receiptJson: row.receipt_json === null ? null : String(row.receipt_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function operationRow(database: SqlConnection, operationId: string, forUpdate = false): Promise<WorkspaceOperationRecord | null> {
  const row = await database.get(
    `SELECT * FROM workspace_file_operations WHERE operation_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [operationId],
  ) as OperationRow | undefined;
  return row ? readOperation(row) : null;
}

async function stepRow(database: SqlConnection, operationId: string, stepKey: string, forUpdate = false): Promise<WorkspaceOperationStepRecord | null> {
  const row = await database.get(
    `SELECT * FROM workspace_file_operation_steps WHERE operation_id = $1 AND step_key = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [operationId, stepKey],
  ) as StepRow | undefined;
  return row ? readStep(row) : null;
}

function assertSameOperation(actual: WorkspaceOperationRecord | null, expected: {
  operationId: string;
  planId: string;
  requestHash: string;
  requestJson: string;
  actor: WorkspaceOperationActor;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  expectedStepCount: number;
}): WorkspaceOperationRecord {
  if (!actual || actual.planId !== expected.planId || actual.requestHash !== expected.requestHash
    || actual.requestJson !== expected.requestJson || actual.actor.type !== expected.actor.type
    || actual.actor.id !== expected.actor.id || actual.sourceWorkspaceId !== expected.sourceWorkspaceId
    || actual.destinationWorkspaceId !== expected.destinationWorkspaceId
    || actual.expectedStepCount !== expected.expectedStepCount) {
    throw new WorkspaceOperationJournalConflictError(`Operation ${expected.operationId} has a different durable request.`);
  }
  return actual;
}

function assertSameStep(actual: WorkspaceOperationStepRecord | null, expected: BeginStepInput): WorkspaceOperationStepRecord {
  if (!actual || actual.phase !== expected.phase || actual.beforeFence !== expected.beforeFence
    || actual.afterFence !== expected.afterFence || actual.backupRef !== (expected.backupRef ?? null)) {
    throw new WorkspaceOperationJournalConflictError(`Step ${expected.stepKey} has different durable fences.`);
  }
  return actual;
}

export type WorkspaceOperationPrepareInput = PrepareInput;
export type WorkspaceOperationBeginStepInput = BeginStepInput;
export type WorkspaceOperationFinishStepInput = FinishStepInput;
export type WorkspaceOperationFailureInput = FailureInput;
export type WorkspaceOperationResumeInput = { operationId: string; expectedRevision: number };
type CapturedPrepare = Readonly<Omit<PrepareInput, 'request'> & { requestJson: string; requestHash: string }>;
type CapturedFinish = Readonly<Omit<FinishStepInput, 'receipt'> & { receiptJson: string }>;

function capturePrepare(input: PrepareInput): CapturedPrepare {
  const { operationId, planId, actor, sourceWorkspaceId, destinationWorkspaceId, expectedStepCount } = input;
  const capturedActor = Object.freeze({ type: actor.type, id: actor.id });
  checkedText(operationId, 'operationId', 128, 16);
  if (!/^[a-f0-9]{64}$/u.test(planId)) throw new Error('planId must be a SHA-256 digest.');
  checkedText(capturedActor.id, 'actor.id', 256);
  if (!['user', 'agent', 'system'].includes(capturedActor.type)) throw new Error('Unknown operation actor type.');
  checkedText(sourceWorkspaceId, 'sourceWorkspaceId', 256);
  checkedText(destinationWorkspaceId, 'destinationWorkspaceId', 256);
  if (!Number.isInteger(expectedStepCount) || expectedStepCount < 1 || expectedStepCount > 10000) {
    throw new Error('expectedStepCount must be between 1 and 10000.');
  }
  const { requestJson, requestHash } = serializeWorkspaceOperationRequest(input.request);
  const original = (JSON.parse(requestJson) as WorkspaceOperationRequest).origin;
  if (original && (original.actor.userId !== capturedActor.id || original.actor.type !== capturedActor.type
    || original.sourceScope.workspaceId !== sourceWorkspaceId
    || original.destinationScope.workspaceId !== destinationWorkspaceId)) {
    throw new WorkspaceOperationJournalConflictError('Copy origin differs from the durable operation identity.');
  }
  return Object.freeze({ operationId, planId, requestJson, requestHash, actor: capturedActor,
    sourceWorkspaceId, destinationWorkspaceId, expectedStepCount });
}
function captureBeginStep(input: BeginStepInput): Readonly<BeginStepInput> {
  const { operationId, stepKey, phase, beforeFence, afterFence, backupRef } = input;
  checkedText(operationId, 'operationId', 128, 16);
  checkedText(stepKey, 'stepKey', 1024);
  checkedText(beforeFence, 'beforeFence', 4096);
  checkedText(afterFence, 'afterFence', 4096);
  if (backupRef !== undefined && backupRef !== null) checkedText(backupRef, 'backupRef', 2048);
  if (phase !== 'path' && phase !== 'link') throw new Error('Unknown step phase.');
  return Object.freeze({ operationId, stepKey, phase, beforeFence, afterFence, backupRef: backupRef ?? null });
}
function captureFinishStep(input: FinishStepInput): CapturedFinish {
  const { operationId, stepKey, beforeFence, afterFence, receipt } = input;
  checkedText(operationId, 'operationId', 128, 16);
  checkedText(stepKey, 'stepKey', 1024);
  checkedText(beforeFence, 'beforeFence', 4096);
  checkedText(afterFence, 'afterFence', 4096);
  const receiptJson = canonicalJson(receipt);
  checkedText(receiptJson, 'receipt', 16384, 2);
  return Object.freeze({ operationId, stepKey, beforeFence, afterFence, receiptJson });
}
function captureFailure(input: FailureInput): Readonly<FailureInput> {
  const { operationId, errorCode, recoveryRequired } = input;
  checkedText(operationId, 'operationId', 128, 16);
  checkedText(errorCode, 'errorCode', 128);
  return Object.freeze({ operationId, errorCode, recoveryRequired: Boolean(recoveryRequired) });
}
function captureResume(input: WorkspaceOperationResumeInput): Readonly<WorkspaceOperationResumeInput> {
  const { operationId, expectedRevision } = input;
  checkedText(operationId, 'operationId', 128, 16);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('expectedRevision must be a positive integer.');
  }
  return Object.freeze({ operationId, expectedRevision });
}

async function readCapturedJournalOnConnection(database: SqlConnection, operationId: string,
  forUpdate = false): Promise<WorkspaceOperationWithSteps | null> {
  const operation = await operationRow(database, operationId, forUpdate);
  if (!operation) return null;
  const rows = await database.all(forUpdate
    ? 'SELECT * FROM workspace_file_operation_steps WHERE operation_id = $1 ORDER BY created_at, step_key FOR UPDATE'
    : 'SELECT * FROM workspace_file_operation_steps WHERE operation_id = $1 ORDER BY created_at, step_key',
  [operationId]) as StepRow[];
  return { ...operation, steps: rows.map(readStep) };
}

async function prepareCapturedOnConnection(database: SqlConnection, expected: CapturedPrepare): Promise<WorkspaceOperationRecord> {
  const { requestJson, requestHash } = expected;
  const now = Date.now();
  await database.run(`
    INSERT INTO workspace_file_operations (
      operation_id, plan_id, request_hash, request_json, actor_type, actor_id,
      source_workspace_id, destination_workspace_id, expected_step_count,
      status, phase, revision, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared','prepared',1,$10,$10)
    ON CONFLICT (operation_id) DO NOTHING
  `, [expected.operationId, expected.planId, requestHash, requestJson, expected.actor.type, expected.actor.id,
    expected.sourceWorkspaceId, expected.destinationWorkspaceId, expected.expectedStepCount, now]);
  return assertSameOperation(await operationRow(database, expected.operationId, true), expected);
}

async function beginCapturedStepOnConnection(database: SqlConnection, input: Readonly<BeginStepInput>): Promise<WorkspaceOperationStepRecord> {
  const operation = await operationRow(database, input.operationId, true);
  if (!operation) throw new WorkspaceOperationJournalConflictError('Operation was not prepared.');
  const existing = await stepRow(database, input.operationId, input.stepKey, true);
  if (existing) return assertSameStep(existing, input);
  if (operation.status !== 'prepared' && operation.status !== 'running') {
    throw new WorkspaceOperationJournalConflictError('Operation is no longer writable.');
  }
  if (input.phase === 'path' && operation.phase === 'link') {
    throw new WorkspaceOperationJournalConflictError('Path steps cannot follow link steps.');
  }
  if (input.phase === 'link') {
    const progress = await database.get(`SELECT
      COUNT(*) FILTER (WHERE phase = 'path' AND status = 'applied')::integer AS applied,
      COUNT(*) FILTER (WHERE phase = 'path' AND status = 'intent')::integer AS pending
      FROM workspace_file_operation_steps WHERE operation_id = $1`, [input.operationId]) as { applied: number; pending: number };
    if (Number(progress.applied) < 1 || Number(progress.pending) !== 0) {
      throw new WorkspaceOperationJournalConflictError('Path mutation must have an applied receipt before link edits.');
    }
  }
  const counts = await database.get(
    'SELECT COUNT(*)::integer AS count FROM workspace_file_operation_steps WHERE operation_id = $1',
    [input.operationId],
  ) as { count: number };
  if (Number(counts.count) >= operation.expectedStepCount) {
    throw new WorkspaceOperationJournalConflictError('The prepared step count has been exceeded.');
  }
  const now = Date.now();
  await database.run(`INSERT INTO workspace_file_operation_steps (
    operation_id, step_key, phase, status, before_fence, after_fence,
    backup_ref, receipt_json, created_at, updated_at
  ) VALUES ($1,$2,$3,'intent',$4,$5,$6,NULL,$7,$7)`,
  [input.operationId, input.stepKey, input.phase, input.beforeFence, input.afterFence, input.backupRef ?? null, now]);
  await database.run(`UPDATE workspace_file_operations SET
    status = 'running', phase = $2, revision = revision + 1, updated_at = $3
    WHERE operation_id = $1`, [input.operationId, input.phase, now]);
  return (await stepRow(database, input.operationId, input.stepKey))!;
}

async function finishCapturedStepOnConnection(database: SqlConnection, input: CapturedFinish): Promise<WorkspaceOperationStepRecord> {
  const { receiptJson } = input;
  const operation = await operationRow(database, input.operationId, true);
  const step = await stepRow(database, input.operationId, input.stepKey, true);
  if (!operation || !step || step.beforeFence !== input.beforeFence || step.afterFence !== input.afterFence) {
    throw new WorkspaceOperationJournalConflictError('Step fences differ from the durable intent.');
  }
  if (step.status === 'applied') {
    if (step.receiptJson !== receiptJson) throw new WorkspaceOperationJournalConflictError('Step has a different durable receipt.');
    return step;
  }
  if (operation.status !== 'running') throw new WorkspaceOperationJournalConflictError('Operation is no longer running.');
  const now = Date.now();
  await database.run(`UPDATE workspace_file_operation_steps SET
    status = 'applied', receipt_json = $3, updated_at = $4
    WHERE operation_id = $1 AND step_key = $2 AND status = 'intent'`,
  [input.operationId, input.stepKey, receiptJson, now]);
  await database.run(`UPDATE workspace_file_operations SET revision = revision + 1, updated_at = $2
    WHERE operation_id = $1`, [input.operationId, now]);
  return (await stepRow(database, input.operationId, input.stepKey))!;
}

async function completeCapturedOnConnection(database: SqlConnection, operationId: string): Promise<WorkspaceOperationRecord> {
  const operation = await operationRow(database, operationId, true);
  if (!operation) throw new WorkspaceOperationJournalConflictError('Operation was not prepared.');
  if (operation.status === 'completed') return operation;
  if (operation.status !== 'running') throw new WorkspaceOperationJournalConflictError('Operation is not running.');
  const counts = await database.get(`SELECT
    COUNT(*)::integer AS total,
    COUNT(*) FILTER (WHERE status = 'applied')::integer AS applied
    FROM workspace_file_operation_steps WHERE operation_id = $1`, [operationId]) as { total: number; applied: number };
  if (Number(counts.total) !== operation.expectedStepCount || Number(counts.applied) !== operation.expectedStepCount) {
    throw new WorkspaceOperationJournalConflictError('All planned steps require applied receipts before completion.');
  }
  const now = Date.now();
  await database.run(`UPDATE workspace_file_operations SET
    status = 'completed', phase = 'completed', revision = revision + 1, updated_at = $2
    WHERE operation_id = $1`, [operationId, now]);
  return (await operationRow(database, operationId))!;
}

async function failCapturedOnConnection(database: SqlConnection, input: Readonly<FailureInput>): Promise<WorkspaceOperationRecord> {
  const status = input.recoveryRequired ? 'recovery_required' : 'failed';
  const operation = await operationRow(database, input.operationId, true);
  if (!operation || operation.status === 'completed') {
    throw new WorkspaceOperationJournalConflictError('Completed or absent operation cannot fail.');
  }
  if (operation.status === status && operation.errorCode === input.errorCode) return operation;
  if (operation.status === 'failed' || operation.status === 'recovery_required') {
    throw new WorkspaceOperationJournalConflictError('Operation has a different durable failure.');
  }
  const now = Date.now();
  await database.run(`UPDATE workspace_file_operations SET
    status = $2, error_code = $3, revision = revision + 1, updated_at = $4
    WHERE operation_id = $1`, [input.operationId, status, input.errorCode, now]);
  return (await operationRow(database, input.operationId))!;
}

async function resumeCapturedOnConnection(database: SqlConnection, input: Readonly<WorkspaceOperationResumeInput>): Promise<WorkspaceOperationRecord> {
  const operation = await operationRow(database, input.operationId, true);
  if (!operation || operation.status !== 'recovery_required' || operation.revision !== input.expectedRevision) {
    throw new WorkspaceOperationJournalConflictError('Recovery revision or operation status changed.');
  }
  const now = Date.now();
  await database.run(`UPDATE workspace_file_operations SET
    status = 'running', error_code = NULL, revision = revision + 1, updated_at = $2
    WHERE operation_id = $1`, [input.operationId, now]);
  return (await operationRow(database, input.operationId))!;
}

export class WorkspaceOperationJournalTransactionError extends Error {
  readonly status = 409;
  readonly code = 'JOURNAL_TRANSACTION_CHANGED';
  constructor() { super('The borrowed journal transaction could not be confirmed.'); this.name = 'WorkspaceOperationJournalTransactionError'; }
}
function withBorrowedJournalTransaction<T>(database: SqlConnection, operation: () => Promise<T>): Promise<T> {
  return withBorrowedWriteTransaction(database, operation, () => new WorkspaceOperationJournalTransactionError());
}

/** Mechanical journal operations on the caller's explicit stable RC/RW B.
 * No checkout, transaction control, close or SET LOCAL. The caller owns current
 * authority, exact original request/fences, rollback on ANY error and confirmed
 * COMMIT/recovery. Returned rows are uncommitted observations, never a grant.
 * The old class.get intentionally retains its nonlocking standalone semantics. */
export async function readWorkspaceOperationJournalOnConnection(database: SqlConnection, operationId: string,
  options: { forUpdate?: boolean } = {}): Promise<WorkspaceOperationWithSteps | null> {
  checkedText(operationId, 'operationId', 128, 16);
  const forUpdate = options.forUpdate ?? false;
  if (typeof forUpdate !== 'boolean') throw new Error('forUpdate must be a boolean.');
  return withBorrowedJournalTransaction(database, () => readCapturedJournalOnConnection(database, operationId, forUpdate));
}
export async function prepareWorkspaceOperationOnConnection(database: SqlConnection,
  input: WorkspaceOperationPrepareInput): Promise<WorkspaceOperationRecord> {
  const captured = capturePrepare(input);
  return withBorrowedJournalTransaction(database, () => prepareCapturedOnConnection(database, captured));
}
export async function beginWorkspaceOperationStepOnConnection(database: SqlConnection,
  input: WorkspaceOperationBeginStepInput): Promise<WorkspaceOperationStepRecord> {
  const captured = captureBeginStep(input);
  return withBorrowedJournalTransaction(database, () => beginCapturedStepOnConnection(database, captured));
}
export async function finishWorkspaceOperationStepOnConnection(database: SqlConnection,
  input: WorkspaceOperationFinishStepInput): Promise<WorkspaceOperationStepRecord> {
  const captured = captureFinishStep(input);
  return withBorrowedJournalTransaction(database, () => finishCapturedStepOnConnection(database, captured));
}
export async function completeWorkspaceOperationOnConnection(database: SqlConnection,
  operationId: string): Promise<WorkspaceOperationRecord> {
  checkedText(operationId, 'operationId', 128, 16);
  return withBorrowedJournalTransaction(database, () => completeCapturedOnConnection(database, operationId));
}
export async function failWorkspaceOperationOnConnection(database: SqlConnection,
  input: WorkspaceOperationFailureInput): Promise<WorkspaceOperationRecord> {
  const captured = captureFailure(input);
  return withBorrowedJournalTransaction(database, () => failCapturedOnConnection(database, captured));
}
export async function resumeWorkspaceOperationOnConnection(database: SqlConnection,
  input: WorkspaceOperationResumeInput): Promise<WorkspaceOperationRecord> {
  const captured = captureResume(input);
  return withBorrowedJournalTransaction(database, () => resumeCapturedOnConnection(database, captured));
}

/** The caller holds workspace locks and verifies each external before/after fence. */
export class WorkspaceOperationJournal {
  private readonly openConnection: () => Promise<SqlConnection>;

  constructor(options: { openConnection?: () => Promise<SqlConnection> } = {}) {
    this.openConnection = options.openConnection ?? openDb;
  }

  private async read<T>(operation: (database: SqlConnection) => Promise<T>): Promise<T> {
    const database = await this.openConnection();
    try { return await operation(database); }
    finally { await database.close(); }
  }

  private async mutate<T>(
    execute: (database: SqlConnection) => Promise<T>,
    recover: (value: T) => Promise<T | null>,
  ): Promise<T> {
    return executeLifecycleTransaction({
      openConnection: this.openConnection,
      execute,
      recoverCommitted: async (value, commitError) => {
        try {
          const proof = await recover(value);
          if (proof !== null) return proof;
        } catch (readError) {
          throw new WorkspaceOperationJournalUncertainCommitError('Operation journal COMMIT could not be proven.', new AggregateError([commitError, readError]));
        }
        throw new WorkspaceOperationJournalUncertainCommitError('Operation journal COMMIT has no durable receipt.', commitError);
      },
    });
  }

  async get(operationId: string): Promise<WorkspaceOperationWithSteps | null> {
    checkedText(operationId, 'operationId', 128, 16);
    return this.read(database => readCapturedJournalOnConnection(database, operationId));
  }

  async prepare(input: PrepareInput): Promise<WorkspaceOperationRecord> {
    const expected = capturePrepare(input);
    return this.mutate(database => prepareCapturedOnConnection(database, expected), async () => {
      const actual = await this.read((database) => operationRow(database, expected.operationId));
      return actual ? assertSameOperation(actual, expected) : null;
    });
  }

  async beginStep(input: BeginStepInput): Promise<WorkspaceOperationStepRecord> {
    const captured = captureBeginStep(input);
    return this.mutate(database => beginCapturedStepOnConnection(database, captured), async () => {
      const actual = await this.read((database) => stepRow(database, captured.operationId, captured.stepKey));
      return actual ? assertSameStep(actual, captured) : null;
    });
  }

  async finishStep(input: FinishStepInput): Promise<WorkspaceOperationStepRecord> {
    const captured = captureFinishStep(input);
    return this.mutate(database => finishCapturedStepOnConnection(database, captured), async () => {
      const actual = await this.read((database) => stepRow(database, captured.operationId, captured.stepKey));
      return actual?.status === 'applied' && actual.beforeFence === captured.beforeFence
        && actual.afterFence === captured.afterFence && actual.receiptJson === captured.receiptJson ? actual : null;
    });
  }

  async complete(operationId: string): Promise<WorkspaceOperationRecord> {
    checkedText(operationId, 'operationId', 128, 16);
    return this.mutate(database => completeCapturedOnConnection(database, operationId), async () => {
      const actual = await this.read((database) => operationRow(database, operationId));
      return actual?.status === 'completed' ? actual : null;
    });
  }

  async fail(input: FailureInput): Promise<WorkspaceOperationRecord> {
    const captured = captureFailure(input);
    const status = captured.recoveryRequired ? 'recovery_required' : 'failed';
    return this.mutate(database => failCapturedOnConnection(database, captured), async () => {
      const actual = await this.read((database) => operationRow(database, captured.operationId));
      return actual?.status === status && actual.errorCode === captured.errorCode ? actual : null;
    });
  }

  /** Reopen a recoverable operation only after the executor rechecks external fences. */
  async resume(input: WorkspaceOperationResumeInput): Promise<WorkspaceOperationRecord> {
    const captured = captureResume(input);
    return this.mutate(database => resumeCapturedOnConnection(database, captured), async () => {
      const actual = await this.read((database) => operationRow(database, captured.operationId));
      return actual?.status === 'running' && actual.revision === captured.expectedRevision + 1
        && actual.errorCode === null ? actual : null;
    });
  }
}
