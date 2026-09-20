import 'server-only';

import { createHash } from 'node:crypto';

import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { authoritativeCollaborationSnapshot } from '@/app/lib/collaboration/checkpoint';
import { readFile } from '@/app/lib/filesystem/workspace-files';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  isSafeFileVersionPathHint,
  parseFileVersionTimelineResponseV1,
  type FileVersionCenterTargetV1,
  type FileVersionCenterSelectionV1,
  type FileVersionCapabilitiesV1,
  type FileVersionCurrentFenceV1,
  type FileVersionTimelineEntryV1,
  type FileVersionTimelineResponseV1,
} from './contracts/v1';
import {
  assertFileVersionScopeV1,
  classifyFileVersionFileV1,
  resolveFileVersionCapabilitiesV1,
  resolveFileVersionRolloutModeV1,
  FILE_VERSION_CENTER_ROLLOUT_ENV_V1,
  type FileVersionBackendReadinessV1,
  type FileVersionRolloutModeV1,
} from './policy-v1';
import {
  createRuntimeFileVersionCenterDatabase,
  type FileVersionCenterDatabase,
  type FileVersionCenterTransaction,
} from './database';
import {
  fileReviewPolicyService,
  type FileReviewPolicyAccess,
  type FileReviewPolicyEvaluation,
} from './review-policy-service';

export type FileVersionCenterAccess = FileReviewPolicyAccess & {
  canManageWorkspace?: boolean;
};

export type ResolvedFileVersionTarget = {
  workspaceId: string;
  lineageId: string;
  documentId: string | null;
  path: string;
  latestRevisionId: string | null;
  latestRevisionHash: string | null;
  latestRevisionSize: number;
};

export type AuthoritativeFileVersionCurrent = {
  fence: FileVersionCurrentFenceV1;
  sizeBytes: number;
  observedAt: number;
};

type ResolvedRow = {
  workspace_id: string;
  lineage_id: string;
  document_id: string | null;
  path: string;
  status: string;
  latest_revision_id: string | null;
  latest_revision_hash: string | null;
  latest_revision_size: number | string | null;
};

type AgentRow = {
  operation_id: string;
  status: Extract<FileVersionTimelineEntryV1, { kind: 'agent_operation' }>['status'];
  actor_id: string;
  actor_name: string | null;
  created_at: number | string;
  updated_at: number | string;
  initiated_by_user_id: string;
};

type RevisionRow = {
  revision_id: string;
  revision_number: number | string;
  created_at: number | string;
  content_hash: string;
  size_bytes: number | string;
  created_by_actor_type: 'user' | 'agent' | 'automation' | 'system';
  created_by_user_id: string | null;
  actor_name: string | null;
  source: 'initial' | 'automatic_checkpoint' | 'manual' | 'agent_apply' | 'restore' | 'external_import' | 'legacy_guest' | null;
  content_format: 'markdown' | 'text' | 'structured' | 'binary' | null;
  content_sha256: string | null;
  raw_size_bytes: number | string | null;
};

type TimelineCursor =
  | { version: 1; phase: 'reviews'; updatedAt: number; id: string; selectedOperationId?: string }
  | { version: 1; phase: 'current' }
  | { version: 1; phase: 'revisions'; createdAt: number; revisionNumber: number; id: string };

const DEFAULT_BACKENDS: FileVersionBackendReadinessV1 = {
  storageReady: true,
  compareReady: true,
  restoreReady: true,
  policyReady: true,
};

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function checkedInteger(value: number | string | null | undefined): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.internal, 'Stored timeline metadata is invalid.');
  }
  return number;
}

function safeDisplayName(value: string | null, fallback: string): string {
  const normalized = (value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 160);
  return normalized || fallback.slice(0, 160);
}

function encodeCursor(cursor: TimelineCursor): string {
  return `v1.${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

function decodeCursor(value: string | undefined): TimelineCursor | null {
  if (!value) return null;
  if (value.length > FILE_VERSION_CENTER_CONTRACT_LIMITS.cursorCharacters || !/^v1\.[A-Za-z0-9_-]+$/u.test(value)) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The timeline cursor is invalid.');
  }
  try {
    const cursor = JSON.parse(Buffer.from(value.slice(3), 'base64url').toString('utf8')) as Partial<TimelineCursor>;
    if (cursor.version !== 1 || !['reviews', 'current', 'revisions'].includes(cursor.phase ?? '')) throw new Error();
    if (cursor.phase === 'reviews' && (
      !validId(cursor.id ?? '')
      || !Number.isSafeInteger(cursor.updatedAt)
      || cursor.updatedAt! < 0
      || (cursor.selectedOperationId !== undefined && !validId(cursor.selectedOperationId))
    )) throw new Error();
    if (cursor.phase === 'revisions' && (!validId(cursor.id ?? '') || !Number.isSafeInteger(cursor.createdAt)
      || cursor.createdAt! < 0 || !Number.isSafeInteger(cursor.revisionNumber) || cursor.revisionNumber! < 1)) throw new Error();
    return cursor as TimelineCursor;
  } catch {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The timeline cursor is invalid.');
  }
}

function assertAccessEnvelope(access: FileVersionCenterAccess, requestedWorkspaceId: string): void {
  assertFileVersionScopeV1({
    authenticatedWorkspaceId: access.authenticatedWorkspaceId,
    requestedWorkspaceId,
    resolvedWorkspaceId: requestedWorkspaceId,
    membership: access.membership,
    permissionsResolved: access.permissionsResolved,
    canRead: access.canRead,
  });
  if (!validId(access.userId)) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied, 'File version target is not available in the active workspace.');
  }
}

function resolvedTarget(row: ResolvedRow | undefined): ResolvedFileVersionTarget {
  if (!row) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.notFound,
      'The document version target was not found. It may have been deleted or replaced.',
    );
  }
  if (row.status === 'archived') {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.notFound,
      'This document is archived. Restore it from the workspace trash to reopen its version history.',
    );
  }
  if (row.status !== 'active' || !validId(row.workspace_id) || !validId(row.lineage_id)
    || (row.document_id !== null && !validId(row.document_id)) || !isSafeFileVersionPathHint(row.path)) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.notFound,
      'The active document version target is unavailable.',
    );
  }
  return {
    workspaceId: row.workspace_id,
    lineageId: row.lineage_id,
    documentId: row.document_id,
    path: row.path,
    latestRevisionId: row.latest_revision_id,
    latestRevisionHash: row.latest_revision_hash,
    latestRevisionSize: checkedInteger(row.latest_revision_size),
  };
}

const TARGET_PROJECTION_SQL = `
  SELECT lineage.workspace_id, lineage.id AS lineage_id, lineage.path, lineage.status,
    document.id AS document_id,
    revision.id AS latest_revision_id,
    revision.content_hash AS latest_revision_hash,
    revision.size_bytes AS latest_revision_size
  FROM file_collaboration_lineages lineage
  LEFT JOIN collaboration_documents document
    ON document.workspace_id = lineage.workspace_id AND document.lineage_id = lineage.id
    AND document.status = 'active' AND document.provider = 'yjs'
  LEFT JOIN LATERAL (
    SELECT item.id, item.content_hash, item.size_bytes
    FROM file_revisions item WHERE item.lineage_id = lineage.id
    ORDER BY item.revision_number DESC, item.id DESC LIMIT 1
  ) revision ON TRUE
`;

async function resolveTargetRow(
  transaction: FileVersionCenterTransaction,
  input: { target: FileVersionCenterTargetV1; userId: string },
): Promise<ResolvedRow | undefined> {
  const { target } = input;
  if (target.kind === 'lineage') {
    return (await transaction.query<ResolvedRow>(`${TARGET_PROJECTION_SQL}
      WHERE lineage.workspace_id = $1 AND lineage.id = $2`, [target.workspaceId, target.lineageId])).rows[0];
  }
  if (target.kind === 'document') {
    return (await transaction.query<ResolvedRow>(`${TARGET_PROJECTION_SQL}
      WHERE lineage.workspace_id = $1 AND document.id = $2`, [target.workspaceId, target.documentId])).rows[0];
  }
  if (target.kind === 'path') {
    if (!isSafeFileVersionPathHint(target.pathHint)) return undefined;
    return (await transaction.query<ResolvedRow>(`${TARGET_PROJECTION_SQL}
      WHERE lineage.workspace_id = $1 AND lineage.path = $2 AND lineage.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM file_collaboration_lineages historical_lineage
          WHERE historical_lineage.workspace_id = lineage.workspace_id
            AND historical_lineage.path = $2
            AND historical_lineage.id <> lineage.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM file_revisions historical_revision
          WHERE historical_revision.workspace_id = lineage.workspace_id
            AND historical_revision.path = $2
            AND historical_revision.lineage_id IS DISTINCT FROM lineage.id
        )`,
    [target.workspaceId, target.pathHint])).rows[0];
  }
  const entryFilter = target.entryId ? 'AND entry.entry_id = $4' : '';
  const params = target.entryId
    ? [target.workspaceId, target.changeGroupId, input.userId, target.entryId]
    : [target.workspaceId, target.changeGroupId, input.userId];
  return (await transaction.query<ResolvedRow>(`${TARGET_PROJECTION_SQL}
    INNER JOIN file_change_group_entries entry
      ON entry.workspace_id = lineage.workspace_id AND entry.lineage_id = lineage.id
    INNER JOIN file_change_groups change_group
      ON change_group.workspace_id = entry.workspace_id AND change_group.group_id = entry.change_group_id
    WHERE change_group.workspace_id = $1 AND change_group.group_id = $2 AND change_group.user_id = $3
      ${entryFilter}
    ORDER BY entry.ordinal ASC LIMIT 1`, params)).rows[0];
}

async function runtimeCurrent(
  target: ResolvedFileVersionTarget,
  workspace: WorkspaceContext,
): Promise<AuthoritativeFileVersionCurrent> {
  if (target.documentId) {
    const state = await loadCollaborationState(target.documentId);
    if (state && (state.workspaceId !== target.workspaceId || state.path !== target.path || state.status !== 'active')) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable, 'The authoritative collaboration state is unavailable.');
    }
    if (state) {
      const snapshot = authoritativeCollaborationSnapshot(state);
      const sha256 = createHash('sha256').update(snapshot.canonicalContent, 'utf8').digest('hex');
      return {
        fence: {
          revisionId: target.latestRevisionHash === sha256 ? target.latestRevisionId : null,
          sha256,
          stateVectorHash: createHash('sha256').update(state.stateVector).digest('hex'),
        },
        sizeBytes: Buffer.byteLength(snapshot.canonicalContent, 'utf8'),
        observedAt: Date.now(),
      };
    }
  }
  const content = await readFile(target.path, workspaceFileOptions(workspace));
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    fence: { revisionId: target.latestRevisionHash === sha256 ? target.latestRevisionId : null, sha256 },
    sizeBytes: content.byteLength,
    observedAt: Date.now(),
  };
}

function agentEntry(row: AgentRow, access: FileVersionCenterAccess): FileVersionTimelineEntryV1 {
  const actionable = row.status === 'needs_review'
    || row.status === 'partially_applied'
    || row.status === 'semantic_conflict';
  return {
    kind: 'agent_operation',
    id: row.operation_id,
    operationId: row.operation_id,
    createdAt: new Date(checkedInteger(row.created_at)).toISOString(),
    actor: {
      type: 'agent',
      id: row.actor_id,
      displayName: safeDisplayName(row.actor_name, row.actor_id),
    },
    status: row.status as Extract<FileVersionTimelineEntryV1, { kind: 'agent_operation' }>['status'],
    actionsAllowed: Boolean(actionable && access.canWrite
      && (row.initiated_by_user_id === access.userId || access.canManageWorkspace)),
  };
}

function revisionEntry(
  row: RevisionRow,
  path: string,
  capabilities: FileVersionCapabilitiesV1,
): FileVersionTimelineEntryV1 {
  const format = row.content_format ?? (classifyFileVersionFileV1(path) === 'markdown' ? 'markdown' : 'text');
  const available = row.content_sha256 === row.content_hash && Number(row.raw_size_bytes) === Number(row.size_bytes);
  return {
    kind: 'revision',
    id: row.revision_id,
    revisionId: row.revision_id,
    revisionNumber: checkedInteger(row.revision_number),
    createdAt: new Date(checkedInteger(row.created_at)).toISOString(),
    source: row.source ?? (checkedInteger(row.revision_number) === 1 ? 'initial' : 'manual'),
    actor: {
      type: row.created_by_actor_type,
      ...(row.created_by_user_id ? { id: row.created_by_user_id } : {}),
      ...(row.created_by_user_id ? { displayName: safeDisplayName(row.actor_name, row.created_by_user_id) } : {}),
    },
    content: {
      availability: available ? 'available' : 'metadata_only',
      format,
      sha256: row.content_hash,
      sizeBytes: checkedInteger(row.size_bytes),
    },
    restorable: available && capabilities.restore,
  };
}

export function createFileVersionCenterQueryService(options: {
  database?: FileVersionCenterDatabase;
  current?: (target: ResolvedFileVersionTarget, workspace: WorkspaceContext) => Promise<AuthoritativeFileVersionCurrent>;
  rolloutMode?: () => FileVersionRolloutModeV1;
  backends?: () => FileVersionBackendReadinessV1;
  readPolicy?: typeof fileReviewPolicyService.readAuthorized;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const current = options.current ?? runtimeCurrent;
  const rolloutMode = options.rolloutMode ?? (() => resolveFileVersionRolloutModeV1(
    process.env[FILE_VERSION_CENTER_ROLLOUT_ENV_V1.mode],
  ));
  const backends = options.backends ?? (() => DEFAULT_BACKENDS);
  const readPolicy = options.readPolicy ?? fileReviewPolicyService.readAuthorized;

  const resolve = async (input: {
    target: FileVersionCenterTargetV1;
    access: FileVersionCenterAccess;
  }): Promise<ResolvedFileVersionTarget> => {
    assertAccessEnvelope(input.access, input.target.workspaceId);
    const row = await database.transaction((transaction) => resolveTargetRow(transaction, {
      target: input.target,
      userId: input.access.userId,
    }));
    const resolved = resolvedTarget(row);
    assertFileVersionScopeV1({
      authenticatedWorkspaceId: input.access.authenticatedWorkspaceId,
      requestedWorkspaceId: input.target.workspaceId,
      resolvedWorkspaceId: resolved.workspaceId,
      membership: input.access.membership,
      permissionsResolved: input.access.permissionsResolved,
      canRead: input.access.canRead,
    });
    return resolved;
  };

  return {
    resolve,

    async resolveOperation(input: {
      operationId: string;
      workspaceId: string;
      access: FileVersionCenterAccess;
    }): Promise<ResolvedFileVersionTarget> {
      assertAccessEnvelope(input.access, input.workspaceId);
      if (!validId(input.operationId)) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.notFound, 'The active document version target was not found.');
      }
      const row = await database.transaction(async (transaction) => (
        await transaction.query<ResolvedRow>(`${TARGET_PROJECTION_SQL}
          INNER JOIN collaboration_agent_operations operation
            ON operation.workspace_id = lineage.workspace_id AND operation.document_id = document.id
          WHERE operation.workspace_id = $1 AND operation.operation_id = $2`,
        [input.workspaceId, input.operationId])
      ).rows[0]);
      const resolved = resolvedTarget(row);
      assertFileVersionScopeV1({
        authenticatedWorkspaceId: input.access.authenticatedWorkspaceId,
        requestedWorkspaceId: input.workspaceId,
        resolvedWorkspaceId: resolved.workspaceId,
        membership: input.access.membership,
        permissionsResolved: input.access.permissionsResolved,
        canRead: input.access.canRead,
      });
      return resolved;
    },

    async timeline(input: {
      target: FileVersionCenterTargetV1;
      access: FileVersionCenterAccess;
      workspace: WorkspaceContext;
      cursor?: string;
      limit?: number;
      selectedEntry?: FileVersionCenterSelectionV1;
      policyEvaluation?: FileReviewPolicyEvaluation;
    }): Promise<FileVersionTimelineResponseV1> {
      const target = await resolve({ target: input.target, access: input.access });
      if (input.workspace.workspaceId !== target.workspaceId) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied, 'File version target is not available in the active workspace.');
      }
      const limit = input.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > FILE_VERSION_CENTER_CONTRACT_LIMITS.timelineEntriesPerPage) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The timeline page size is invalid.');
      }
      const cursor = decodeCursor(input.cursor);
      const observed = await current(target, input.workspace);
      const capabilities = resolveFileVersionCapabilitiesV1({
        pathHint: target.path,
        sizeBytes: observed.sizeBytes,
        lineageAvailable: true,
        canRead: input.access.canRead,
        canWrite: Boolean(input.access.canWrite),
        rolloutMode: rolloutMode(),
        backends: backends(),
      });
      if (!capabilities.history) {
        return parseFileVersionTimelineResponseV1({
          contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
          document: {
            workspaceId: target.workspaceId,
            lineageId: target.lineageId,
            documentId: target.documentId,
            path: target.path,
          },
          capabilities,
          entries: [],
          page: { hasMore: false, nextCursor: null },
        });
      }
      const policy = capabilities.agentReviewPolicy
        ? await readPolicy({
            access: input.access,
            lineageId: target.lineageId,
            evaluation: input.policyEvaluation ?? {
              hardSafetyRequiresReview: false,
              workspacePolicy: 'allow_user_choice',
              operationExplicitlyRequiresReview: false,
            },
          })
        : undefined;

      const entries: FileVersionTimelineEntryV1[] = [];
      let phase: TimelineCursor['phase'] = cursor?.phase ?? 'reviews';
      let hasMore = false;
      let nextCursor: string | null = null;

      if (phase === 'reviews') {
        const reviewCursor = cursor?.phase === 'reviews' ? cursor : null;
        const selectedOperationId = !cursor && input.selectedEntry?.kind === 'agent_operation'
          ? input.selectedEntry.id
          : null;
        if (selectedOperationId) {
          const selected = await database.transaction((transaction) => transaction.query<AgentRow>(`
            SELECT operation.operation_id, operation.status, operation.actor_id,
              COALESCE(agent.name, agent.email) AS actor_name,
              operation.created_at, operation.updated_at, operation.initiated_by_user_id
            FROM collaboration_agent_operations operation
            INNER JOIN collaboration_documents document
              ON document.id = operation.document_id AND document.workspace_id = operation.workspace_id
            LEFT JOIN "user" agent ON agent.id = operation.actor_id
            WHERE operation.workspace_id = $1 AND document.lineage_id = $2
              AND document.status = 'active'
              AND operation.operation_id = $3
              AND (operation.initiated_by_user_id = $4 OR $5::boolean)
              AND (
                operation.status IN ('needs_review', 'semantic_conflict')
                OR (
                  operation.status = 'partially_applied'
                  AND COALESCE(operation.error_code, '') <> 'persistence_degraded'
                )
                OR (operation.status = 'failed' AND operation.requested_mode = 'direct_apply')
              )
              AND NOT EXISTS (
                SELECT 1
                FROM collaboration_agent_operations superseder
                WHERE superseder.workspace_id = operation.workspace_id
                  AND superseder.document_id = operation.document_id
                  AND superseder.supersedes_operation_id = operation.operation_id
                  AND superseder.operation_type = 'revert'
                  AND superseder.status IN ('persisted_yjs', 'checkpointed_file')
              )
            LIMIT 1
          `, [target.workspaceId, target.lineageId, selectedOperationId,
            input.access.userId, Boolean(input.access.canManageWorkspace)]));
          const selectedRow = selected.rows[0];
          if (!selectedRow) {
            throw new FileVersionCenterContractError(
              FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
              'The selected agent change is no longer available for review.',
            );
          }
          entries.push(agentEntry(selectedRow, input.access));
        }

        const excludedSelectedOperationId = selectedOperationId ?? reviewCursor?.selectedOperationId ?? null;
        const remainingReviews = limit - entries.length;
        if (remainingReviews === 0) {
          hasMore = true;
          nextCursor = encodeCursor({
            version: 1,
            phase: 'reviews',
            updatedAt: Number.MAX_SAFE_INTEGER,
            id: 'z',
            ...(excludedSelectedOperationId ? { selectedOperationId: excludedSelectedOperationId } : {}),
          });
        }
        const reviews = remainingReviews > 0
          ? await database.transaction((transaction) => transaction.query<AgentRow>(`
          SELECT operation.operation_id, operation.status, operation.actor_id,
            COALESCE(agent.name, agent.email) AS actor_name,
            operation.created_at, operation.updated_at, operation.initiated_by_user_id
          FROM collaboration_agent_operations operation
          INNER JOIN collaboration_documents document
            ON document.id = operation.document_id AND document.workspace_id = operation.workspace_id
          LEFT JOIN "user" agent ON agent.id = operation.actor_id
          WHERE operation.workspace_id = $1 AND document.lineage_id = $2
            AND operation.status IN ('needs_review', 'partially_applied', 'semantic_conflict')
            AND ($3::bigint IS NULL OR (operation.updated_at, operation.operation_id) < ($3, $4))
            AND ($5::text IS NULL OR operation.operation_id <> $5)
          ORDER BY operation.updated_at DESC, operation.operation_id DESC
          LIMIT $6
        `, [target.workspaceId, target.lineageId, reviewCursor?.updatedAt ?? null,
          reviewCursor?.id ?? null, excludedSelectedOperationId, remainingReviews + 1]))
          : { rows: [] as AgentRow[] };
        entries.push(...reviews.rows.slice(0, remainingReviews).map((row) => agentEntry(row, input.access)));
        if (reviews.rows.length > remainingReviews) {
          const last = reviews.rows[remainingReviews - 1]!;
          hasMore = true;
          nextCursor = encodeCursor({ version: 1, phase: 'reviews', updatedAt: checkedInteger(last.updated_at), id: last.operation_id,
            ...(excludedSelectedOperationId ? { selectedOperationId: excludedSelectedOperationId } : {}) });
        } else if (!hasMore && entries.length === limit) {
          hasMore = true;
          const last = reviews.rows.at(-1)!;
          nextCursor = encodeCursor({ version: 1, phase: 'reviews', updatedAt: checkedInteger(last.updated_at), id: last.operation_id,
            ...(excludedSelectedOperationId ? { selectedOperationId: excludedSelectedOperationId } : {}) });
        } else if (!hasMore) {
          phase = 'current';
        }
      }

      if (!hasMore && phase === 'current' && entries.length < limit) {
        entries.push({
          kind: 'current',
          id: 'current',
          observedAt: new Date(observed.observedAt).toISOString(),
          revisionId: observed.fence.revisionId,
          ...(observed.fence.stateVectorHash ? { stateVectorHash: observed.fence.stateVectorHash } : {}),
          sha256: observed.fence.sha256,
          sizeBytes: observed.sizeBytes,
        });
        phase = 'revisions';
        if (entries.length === limit) {
          hasMore = true;
          nextCursor = encodeCursor({ version: 1, phase: 'current' });
        }
      } else if (cursor?.phase === 'current') {
        phase = 'revisions';
      }

      if (!hasMore && phase === 'revisions' && entries.length < limit) {
        const revisionCursor = cursor?.phase === 'revisions' ? cursor : null;
        const remaining = limit - entries.length;
        const revisions = await database.transaction((transaction) => transaction.query<RevisionRow>(`
          SELECT revision.id AS revision_id, revision.revision_number, revision.created_at,
            revision.content_hash, revision.size_bytes, revision.created_by_actor_type,
            revision.created_by_user_id, COALESCE(actor.name, actor.email) AS actor_name,
            contents.source, contents.content_format, blob.content_sha256, blob.raw_size_bytes
          FROM file_revisions revision
          LEFT JOIN file_revision_contents contents
            ON contents.revision_id = revision.id AND contents.workspace_id = revision.workspace_id
              AND contents.lineage_id = revision.lineage_id
          LEFT JOIN file_version_blobs blob
            ON blob.blob_id = contents.blob_id AND blob.workspace_id = contents.workspace_id
          LEFT JOIN "user" actor ON actor.id = revision.created_by_user_id
          WHERE revision.workspace_id = $1 AND revision.lineage_id = $2
            AND ($3::bigint IS NULL OR (revision.created_at, revision.revision_number, revision.id) < ($3, $4, $5))
          ORDER BY revision.created_at DESC, revision.revision_number DESC, revision.id DESC
          LIMIT $6
        `, [target.workspaceId, target.lineageId, revisionCursor?.createdAt ?? null,
          revisionCursor?.revisionNumber ?? null, revisionCursor?.id ?? null, remaining + 1]));
        entries.push(...revisions.rows.slice(0, remaining).map((row) => revisionEntry(row, target.path, capabilities)));
        if (revisions.rows.length > remaining) {
          const last = revisions.rows[remaining - 1]!;
          hasMore = true;
          nextCursor = encodeCursor({ version: 1, phase: 'revisions', createdAt: checkedInteger(last.created_at),
            revisionNumber: checkedInteger(last.revision_number), id: last.revision_id });
        }
      }

      return parseFileVersionTimelineResponseV1({
        contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        document: {
          workspaceId: target.workspaceId,
          lineageId: target.lineageId,
          documentId: target.documentId,
          path: target.path,
        },
        capabilities,
        ...(policy ? { policy } : {}),
        entries,
        page: { hasMore, nextCursor },
      });
    },
  };
}

export const fileVersionCenterQueryService = createFileVersionCenterQueryService();
