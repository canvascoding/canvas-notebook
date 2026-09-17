import 'server-only';

import { createHash } from 'node:crypto';

import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  isSafeFileVersionPathHint,
  parseFileChangeGroupV1,
  type FileChangeGroupEntryV1,
  type FileChangeGroupV1,
} from './contracts/v1';
import {
  createRuntimeFileVersionCenterDatabase,
  type FileVersionCenterDatabase,
  type FileVersionCenterTransaction,
} from './database';

export type FileChangeGroupOperation = FileChangeGroupV1['operation'];
export type FileChangeGroupOutcome = FileChangeGroupEntryV1['outcome'];

export type FileChangeGroupEntryInput = {
  lineageId?: string | null;
  documentId?: string | null;
  operationId?: string | null;
  revisionId?: string | null;
  pathHint: string;
  outcome: FileChangeGroupOutcome;
  additions?: number;
  deletions?: number;
};

export type FileChangeGroupAccess = {
  userId: string;
  authenticatedWorkspaceId: string;
  requestedWorkspaceId: string;
  membership: 'active' | 'revoked' | 'unknown';
  permissionsResolved: boolean;
  canRead: boolean;
  canWrite?: boolean;
  canRunAgent?: boolean;
};

export class FileChangeGroupServiceError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'access_denied' | 'conflict' | 'session_archived' | 'target_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'FileChangeGroupServiceError';
  }
}

type GroupRow = {
  group_id: string;
  workspace_id: string;
  user_id: string;
  source_session_id: string;
  pi_session_db_id: number | string | null;
  tool_call_id: string;
  payload_hash: string;
  operation: FileChangeGroupOperation;
  status: FileChangeGroupV1['status'];
  created_at: number | string;
};

type EntryRow = {
  entry_id: string;
  ordinal: number | string;
  lineage_id: string | null;
  document_id: string | null;
  operation_id: string | null;
  revision_id: string | null;
  path_hint: string;
  outcome: FileChangeGroupOutcome;
  additions: number | string | null;
  deletions: number | string | null;
};

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function assertAccess(access: FileChangeGroupAccess, mutation: boolean): void {
  if (
    !validId(access.userId)
    || !validId(access.authenticatedWorkspaceId)
    || !validId(access.requestedWorkspaceId)
    || access.authenticatedWorkspaceId !== access.requestedWorkspaceId
    || access.membership !== 'active'
    || !access.permissionsResolved
    || !access.canRead
    || (mutation && (!access.canWrite || !access.canRunAgent))
  ) {
    throw new FileChangeGroupServiceError('access_denied', 'The change group is not available in the active workspace.');
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stableGroupId(input: {
  userId: string;
  workspaceId: string;
  sourceSessionId: string;
  toolCallId: string;
}): string {
  return `fvcg-${stableHash(input)}`;
}

function stableEntryId(groupId: string, ordinal: number): string {
  return `fvcge-${stableHash({ groupId, ordinal })}`;
}

function groupStatus(entries: FileChangeGroupEntryInput[]): FileChangeGroupV1['status'] {
  const outcomes = new Set(entries.map((entry) => entry.outcome));
  return outcomes.size === 1 ? entries[0]!.outcome : 'mixed';
}

function normalizedEntry(entry: FileChangeGroupEntryInput) {
  return {
    lineageId: entry.lineageId ?? null,
    documentId: entry.documentId ?? null,
    operationId: entry.operationId ?? null,
    revisionId: entry.revisionId ?? null,
    pathHint: entry.pathHint,
    outcome: entry.outcome,
    additions: entry.additions ?? null,
    deletions: entry.deletions ?? null,
  };
}

function assertCreateInput(input: {
  sourceSessionId: string;
  toolCallId: string;
  operation: FileChangeGroupOperation;
  entries: FileChangeGroupEntryInput[];
}): void {
  if (!validId(input.sourceSessionId) || !validId(input.toolCallId)) {
    throw new FileChangeGroupServiceError('invalid_input', 'Session and tool-call IDs are invalid.');
  }
  if (!['write', 'edit_file', 'apply_patch'].includes(input.operation)) {
    throw new FileChangeGroupServiceError('invalid_input', 'The file operation is not supported.');
  }
  if (input.entries.length < 1 || input.entries.length > FILE_VERSION_CENTER_CONTRACT_LIMITS.changeGroupEntries) {
    throw new FileChangeGroupServiceError('invalid_input', 'A change group requires between 1 and 100 entries.');
  }
  for (const entry of input.entries) {
    const ids = [entry.lineageId, entry.documentId, entry.operationId, entry.revisionId]
      .filter((value): value is string => value !== null && value !== undefined);
    if (
      !ids.every(validId)
      || !isSafeFileVersionPathHint(entry.pathHint)
      || !['applied', 'review_required', 'conflict', 'failed'].includes(entry.outcome)
      || [entry.additions, entry.deletions].some((value) => value !== undefined
        && (!Number.isSafeInteger(value) || value < 0))
      || (entry.revisionId && !entry.lineageId)
    ) {
      throw new FileChangeGroupServiceError('invalid_input', 'A change-group entry is invalid.');
    }
  }
}

function advisoryLockId(groupId: string): string {
  return createHash('sha256').update(groupId).digest().readBigInt64BE().toString();
}

async function readGroup(
  transaction: FileVersionCenterTransaction,
  filter: { groupId: string; workspaceId: string; userId: string },
): Promise<FileChangeGroupV1 | null> {
  const groups = await transaction.query<GroupRow>(`
    SELECT * FROM file_change_groups
    WHERE group_id = $1 AND workspace_id = $2 AND user_id = $3
  `, [filter.groupId, filter.workspaceId, filter.userId]);
  const group = groups.rows[0];
  if (!group) return null;
  const entryResult = await transaction.query<EntryRow>(`
    SELECT * FROM file_change_group_entries
    WHERE change_group_id = $1 AND workspace_id = $2
    ORDER BY ordinal ASC
  `, [filter.groupId, filter.workspaceId]);
  const entries = entryResult.rows.map((entry, ordinal): FileChangeGroupEntryV1 => {
    const storedOrdinal = Number(entry.ordinal);
    if (storedOrdinal !== ordinal) {
      throw new FileChangeGroupServiceError('conflict', 'Stored change-group ordering is incomplete.');
    }
    return {
      id: entry.entry_id,
      ordinal,
      ...(entry.lineage_id ? { lineageId: entry.lineage_id } : {}),
      ...(entry.document_id ? { documentId: entry.document_id } : {}),
      ...(entry.operation_id ? { operationId: entry.operation_id } : {}),
      ...(entry.revision_id ? { revisionId: entry.revision_id } : {}),
      pathHint: entry.path_hint,
      outcome: entry.outcome,
      ...(entry.additions !== null ? { additions: Number(entry.additions) } : {}),
      ...(entry.deletions !== null ? { deletions: Number(entry.deletions) } : {}),
    };
  });
  const result: FileChangeGroupV1 = {
    contractVersion: 1,
    id: group.group_id,
    workspaceId: group.workspace_id,
    sourceSessionId: group.source_session_id,
    toolCallId: group.tool_call_id,
    operation: group.operation,
    status: group.status,
    createdAt: new Date(Number(group.created_at)).toISOString(),
    entries,
  };
  return parseFileChangeGroupV1(result);
}

async function assertEntryTargets(
  transaction: FileVersionCenterTransaction,
  input: { workspaceId: string; userId: string; entry: FileChangeGroupEntryInput },
): Promise<void> {
  const entry = normalizedEntry(input.entry);
  const result = await transaction.query<{
    lineage_ok: boolean;
    document_ok: boolean;
    operation_ok: boolean;
    revision_ok: boolean;
  }>(`
    SELECT
      ($3::text IS NULL OR EXISTS (
        SELECT 1 FROM file_collaboration_lineages lineage
        WHERE lineage.id = $3 AND lineage.workspace_id = $1 AND lineage.status = 'active'
      )) AS lineage_ok,
      ($4::text IS NULL OR EXISTS (
        SELECT 1 FROM collaboration_documents document
        WHERE document.id = $4 AND document.workspace_id = $1 AND document.status = 'active'
          AND ($3::text IS NULL OR document.lineage_id = $3)
      )) AS document_ok,
      ($5::text IS NULL OR EXISTS (
        SELECT 1 FROM collaboration_agent_operations operation
        WHERE operation.operation_id = $5 AND operation.workspace_id = $1
          AND operation.initiated_by_user_id = $2
          AND ($4::text IS NULL OR operation.document_id = $4)
      )) AS operation_ok,
      ($6::text IS NULL OR EXISTS (
        SELECT 1 FROM file_revisions revision
        WHERE revision.id = $6 AND revision.workspace_id = $1
          AND revision.lineage_id = $3
      )) AS revision_ok
  `, [input.workspaceId, input.userId, entry.lineageId, entry.documentId, entry.operationId, entry.revisionId]);
  const target = result.rows[0];
  if (!target || !target.lineage_ok || !target.document_ok || !target.operation_ok || !target.revision_ok) {
    throw new FileChangeGroupServiceError('target_invalid', 'A change-group target is not active in this workspace.');
  }
}

export function createFileChangeGroupService(options: {
  database?: FileVersionCenterDatabase;
  now?: () => number;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const now = options.now ?? Date.now;

  return {
    async create(input: {
      access: FileChangeGroupAccess;
      sourceSessionId: string;
      toolCallId: string;
      operation: FileChangeGroupOperation;
      entries: FileChangeGroupEntryInput[];
    }): Promise<FileChangeGroupV1> {
      assertAccess(input.access, true);
      assertCreateInput(input);
      const workspaceId = input.access.requestedWorkspaceId;
      const payloadHash = stableHash({
        operation: input.operation,
        entries: input.entries.map(normalizedEntry),
      });
      const groupId = stableGroupId({ userId: input.access.userId, workspaceId,
        sourceSessionId: input.sourceSessionId, toolCallId: input.toolCallId });
      return database.transaction(async (transaction) => {
        await transaction.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockId(groupId)]);
        const existingRows = await transaction.query<GroupRow>(`
          SELECT * FROM file_change_groups
          WHERE group_id = $1 AND workspace_id = $2 AND user_id = $3
        `, [groupId, workspaceId, input.access.userId]);
        const existing = existingRows.rows[0];
        if (existing) {
          if (existing.payload_hash !== payloadHash || existing.operation !== input.operation) {
            throw new FileChangeGroupServiceError('conflict', 'This tool call already has a different change group.');
          }
          const stored = await readGroup(transaction, { groupId, workspaceId, userId: input.access.userId });
          if (!stored) throw new FileChangeGroupServiceError('conflict', 'The stored change group is incomplete.');
          return stored;
        }

        const sessions = await transaction.query<{ id: number | string; archived_at: number | string | null }>(`
          SELECT id, archived_at FROM pi_sessions
          WHERE user_id = $1 AND workspace_id = $2 AND session_id = $3
        `, [input.access.userId, workspaceId, input.sourceSessionId]);
        const session = sessions.rows[0];
        if (!session) throw new FileChangeGroupServiceError('access_denied', 'The source session is outside this workspace.');
        if (session.archived_at !== null) {
          throw new FileChangeGroupServiceError('session_archived', 'An archived session cannot create a new change group.');
        }
        for (const entry of input.entries) {
          await assertEntryTargets(transaction, { workspaceId, userId: input.access.userId, entry });
        }
        const createdAt = now();
        await transaction.query(`
          INSERT INTO file_change_groups (
            group_id, workspace_id, user_id, source_session_id, pi_session_db_id,
            tool_call_id, payload_hash, operation, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
        `, [groupId, workspaceId, input.access.userId, input.sourceSessionId, session.id,
          input.toolCallId, payloadHash, input.operation, groupStatus(input.entries), createdAt]);
        for (const [ordinal, entryInput] of input.entries.entries()) {
          const entry = normalizedEntry(entryInput);
          await transaction.query(`
            INSERT INTO file_change_group_entries (
              entry_id, change_group_id, workspace_id, ordinal, lineage_id,
              document_id, operation_id, revision_id, path_hint, outcome,
              additions, deletions, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `, [stableEntryId(groupId, ordinal), groupId, workspaceId, ordinal,
            entry.lineageId, entry.documentId, entry.operationId, entry.revisionId,
            entry.pathHint, entry.outcome, entry.additions, entry.deletions, createdAt]);
        }
        const created = await readGroup(transaction, { groupId, workspaceId, userId: input.access.userId });
        if (!created || created.entries.length !== input.entries.length) {
          throw new FileChangeGroupServiceError('conflict', 'The change group was not stored completely.');
        }
        return created;
      });
    },

    async readAuthorized(input: {
      access: FileChangeGroupAccess;
      groupId: string;
    }): Promise<FileChangeGroupV1> {
      assertAccess(input.access, false);
      if (!validId(input.groupId)) {
        throw new FileChangeGroupServiceError('access_denied', 'The change group is not available in the active workspace.');
      }
      const group = await database.transaction((transaction) => readGroup(transaction, {
        groupId: input.groupId,
        workspaceId: input.access.requestedWorkspaceId,
        userId: input.access.userId,
      }));
      if (!group) {
        throw new FileVersionCenterContractError(
          FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
          'The change group is not available in the active workspace.',
        );
      }
      return group;
    },
  };
}

export const fileChangeGroupService = createFileChangeGroupService();
