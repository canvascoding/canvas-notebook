import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import type * as YTypes from 'yjs';

import { previewAgentOperationContent } from '@/app/lib/collaboration/agent-operations';
import {
  runCollaborationDirectConnection,
  type AgentDirectConnectionInput,
} from '@/app/lib/collaboration/direct-connection';
import { replaceRichMarkdownInYDoc, richMarkdownFromYDoc } from '@/app/lib/collaboration/markdown-state';
import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { Y } from '@/app/lib/collaboration/server-runtime';
import { isRichTextCollaborationRepresentation } from '@/app/lib/collaboration/types';
import {
  writeWorkspaceFileContent,
  type WriteWorkspaceFileContentInput,
} from '@/app/lib/files/write-service';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  parseFileVersionRestoreRequestV1,
  parseFileVersionRestoreResponseV1,
  type FileVersionCurrentFenceV1,
  type FileVersionRestoreRequestV1,
  type FileVersionRestoreResponseV1,
} from './contracts/v1';
import {
  createRuntimeFileVersionCenterDatabase,
  type FileVersionCenterDatabase,
} from './database';
import { fileVersionHistoryService } from './history-service';
import {
  classifyFileVersionFileV1,
  FILE_VERSION_CENTER_ROLLOUT_ENV_V1,
  resolveFileVersionRolloutV1,
} from './policy-v1';
import {
  createFileVersionCenterQueryService,
  fileVersionCenterQueryService,
  type FileVersionCenterAccess,
  type ResolvedFileVersionTarget,
} from './query-service';
import {
  fileVersionFencesMatch,
  loadAuthoritativeFileVersionContent,
  type AuthoritativeFileVersionContent,
} from './authoritative-content';
import { fileVersionContentStore, type FileVersionContentStore } from './version-content-store';

type RestoreQueryService = Pick<ReturnType<typeof createFileVersionCenterQueryService>, 'resolve'>;
type RestoreHistoryService = Pick<typeof fileVersionHistoryService, 'capture'>;

export type FileVersionRestoreApplyInput = {
  target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext;
  userId: string;
  actorSessionId?: string | null;
  idempotencyKey: string;
  content: string;
  expectedCurrent: FileVersionCurrentFenceV1;
  priorRevisionId: string | null;
};

export type FileVersionRestoreApply = (
  input: FileVersionRestoreApplyInput,
) => Promise<AuthoritativeFileVersionContent>;

type RestoreReceiptRow = {
  workspace_id: string;
  lineage_id: string;
  target_revision_id: string;
  initiated_by_user_id: string;
  idempotency_key: string;
  request_hash: string;
  status: 'prepared' | 'completed';
  lease_token: string;
  lease_expires_at: number | string;
  prior_revision_id: string | null;
  restored_revision_id: string | null;
  result_json: string | null;
};

type RestoreClaim =
  | { kind: 'acquired'; row: RestoreReceiptRow; token: string }
  | { kind: 'prepared'; row: RestoreReceiptRow }
  | { kind: 'completed'; response: FileVersionRestoreResponseV1 };

const RESTORE_LEASE_MS = 30_000;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestHash(request: FileVersionRestoreRequestV1, lineageId: string): string {
  return sha256(JSON.stringify({ purpose: 'file-version-restore-v1', lineageId,
    revisionId: request.revisionId, expectedCurrent: request.expectedCurrent }));
}

function restoreReceiptMarker(workspaceId: string, userId: string, idempotencyKey: string): string {
  return `fvrc-restore-${sha256(`${workspaceId}:${userId}:${idempotencyKey}`).slice(0, 40)}`;
}

function canonicalDocumentContent(doc: YTypes.Doc, representation: string): string {
  return (representation === 'plain_text'
    ? doc.getText('content').toString()
    : richMarkdownFromYDoc(doc)).replace(/\r\n?/gu, '\n');
}

type RestoreDirectConnection = <T>(
  input: AgentDirectConnectionInput,
  apply: (doc: YTypes.Doc) => T,
) => Promise<T>;

export function createRuntimeFileVersionRestoreApply(options: {
  loadState?: typeof loadCollaborationState;
  directConnection?: RestoreDirectConnection;
  writeFileContent?: (input: WriteWorkspaceFileContentInput) => Promise<unknown>;
  current?: (target: ResolvedFileVersionTarget, workspace: WorkspaceContext) => Promise<AuthoritativeFileVersionContent>;
} = {}): FileVersionRestoreApply {
  const loadState = options.loadState ?? loadCollaborationState;
  const directConnection = options.directConnection ?? runCollaborationDirectConnection;
  const writeFileContent = options.writeFileContent ?? writeWorkspaceFileContent;
  const current = options.current ?? loadAuthoritativeFileVersionContent;
  return async (input) => {
    if (input.target.documentId) {
      const state = await loadState(input.target.documentId);
      if (!state || state.degraded || state.status !== 'active' || state.workspaceId !== input.target.workspaceId
        || state.path !== input.target.path) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
          'The authoritative collaboration state is unavailable.');
      }
      await directConnection({
        documentId: state.documentId,
        documentPath: state.path,
        documentRepresentation: state.representation,
        documentLifecycleGeneration: state.lifecycleGeneration,
        documentSchemaVersion: state.schemaVersion,
        requiresFileCheckpointIdentity: true,
        workspace: input.workspace,
        actorId: input.userId,
        actorDisplayName: input.workspace.actor?.email || input.userId,
        initiatedByUserId: input.userId,
        operationId: `fvrc-restore-${sha256(input.idempotencyKey).slice(0, 32)}`,
        actorType: 'user',
        actorSessionId: input.actorSessionId ?? undefined,
        versionSource: 'restore',
        versionBaseRevisionId: input.priorRevisionId,
        versionSourceSessionId: restoreReceiptMarker(input.target.workspaceId, input.userId, input.idempotencyKey),
      }, (doc) => {
        const liveContent = canonicalDocumentContent(doc, state.representation);
        const liveFence = {
          revisionId: input.expectedCurrent.revisionId,
          sha256: sha256(liveContent),
          stateVectorHash: sha256(Y.encodeStateVector(doc)),
        } satisfies FileVersionCurrentFenceV1;
        if (!fileVersionFencesMatch(liveFence, input.expectedCurrent)) {
          throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
            'The document changed while the restore was being prepared.');
        }
        if (isRichTextCollaborationRepresentation(state.representation)) {
          replaceRichMarkdownInYDoc(doc, input.content, 'file_version_restore');
        } else {
          doc.transact(() => {
            const text = doc.getText('content');
            if (text.length > 0) text.delete(0, text.length);
            if (input.content) text.insert(0, input.content);
          }, 'file_version_restore');
        }
      });
      return current(input.target, input.workspace);
    }

    await writeFileContent({
      workspace: input.workspace,
      fileOptions: workspaceFileOptions(input.workspace),
      actorUserId: input.userId,
      actorSessionId: restoreReceiptMarker(input.target.workspaceId, input.userId, input.idempotencyKey),
      actorType: 'user',
      idempotencyKey: `fvrc-restore-${sha256(input.idempotencyKey)}`,
      path: input.target.path,
      content: input.content,
      expectedSha256: input.expectedCurrent.sha256,
      requireExpectedRevision: true,
      baseRevisionId: input.priorRevisionId,
      ensureCollaborationDocument: false,
      versionSource: 'restore',
    });
    return current(input.target, input.workspace);
  };
}

const runtimeRestoreApply = createRuntimeFileVersionRestoreApply();

function completedResponse(row: RestoreReceiptRow): FileVersionRestoreResponseV1 {
  if (!row.result_json) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
      'The restore receipt is incomplete.');
  }
  const stored = parseFileVersionRestoreResponseV1(JSON.parse(row.result_json));
  return parseFileVersionRestoreResponseV1({ ...stored, outcome: 'already_restored' });
}

async function defaultRevalidateProposals(input: {
  database: FileVersionCenterDatabase;
  target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext;
  userId: string;
  current: FileVersionCurrentFenceV1;
  now: number;
  previewOperation: typeof previewAgentOperationContent;
}): Promise<number> {
  if (!input.target.documentId) return 0;
  const operations = await input.database.transaction((transaction) => transaction.query<{ operation_id: string }>(`
    SELECT operation_id FROM collaboration_agent_operations
    WHERE workspace_id = $1 AND document_id = $2
      AND status IN ('needs_review', 'partially_applied')
    ORDER BY updated_at DESC, operation_id DESC LIMIT 100
  `, [input.target.workspaceId, input.target.documentId]));
  const stale: string[] = [];
  for (const operation of operations.rows) {
    const preview = await input.previewOperation({ operationId: operation.operation_id,
      workspace: input.workspace, userId: input.userId });
    if (!preview || preview.stale || preview.baseSha256 !== input.current.sha256
      || preview.baseStateVectorHash !== input.current.stateVectorHash) stale.push(operation.operation_id);
  }
  if (stale.length === 0) return 0;
  const changed = await input.database.transaction((transaction) => transaction.query<{ operation_id: string }>(`
    UPDATE collaboration_agent_operations
    SET status = 'semantic_conflict', cas_version = cas_version + 1,
      error_code = 'file_version_restore_changed_base', updated_at = $1
    WHERE workspace_id = $2 AND document_id = $3
      AND operation_id = ANY($4) AND status IN ('needs_review', 'partially_applied')
    RETURNING operation_id
  `, [input.now, input.target.workspaceId, input.target.documentId, stale]));
  return changed.rows.length;
}

export function createFileVersionRestoreService(options: {
  database?: FileVersionCenterDatabase;
  query?: RestoreQueryService;
  contentStore?: Pick<FileVersionContentStore, 'readRevisionContent'>;
  history?: RestoreHistoryService;
  current?: (target: ResolvedFileVersionTarget, workspace: WorkspaceContext) => Promise<AuthoritativeFileVersionContent>;
  apply?: FileVersionRestoreApply;
  restoreEnabled?: () => boolean;
  now?: () => number;
  leaseToken?: () => string;
  revalidateProposals?: (input: {
    database: FileVersionCenterDatabase;
    target: ResolvedFileVersionTarget;
    workspace: WorkspaceContext;
    userId: string;
    current: FileVersionCurrentFenceV1;
    now: number;
  }) => Promise<number>;
  operationPreview?: typeof previewAgentOperationContent;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const query = options.query ?? fileVersionCenterQueryService;
  const contentStore = options.contentStore ?? fileVersionContentStore;
  const history = options.history ?? fileVersionHistoryService;
  const current = options.current ?? loadAuthoritativeFileVersionContent;
  const apply = options.apply ?? runtimeRestoreApply;
  const restoreEnabled = options.restoreEnabled ?? (() => resolveFileVersionRolloutV1(
    process.env[FILE_VERSION_CENTER_ROLLOUT_ENV_V1.mode],
  ).restore);
  const now = options.now ?? Date.now;
  const leaseToken = options.leaseToken ?? (() => `lease-${randomUUID()}`);
  const operationPreview = options.operationPreview ?? previewAgentOperationContent;
  const revalidateProposals = options.revalidateProposals ?? ((input) => defaultRevalidateProposals({
    ...input,
    previewOperation: operationPreview,
  }));

  const claim = async (input: {
    request: FileVersionRestoreRequestV1;
    target: ResolvedFileVersionTarget;
    userId: string;
    hash: string;
  }): Promise<RestoreClaim> => database.transaction(async (transaction) => {
    const token = leaseToken();
    const timestamp = now();
    const inserted = await transaction.query<RestoreReceiptRow>(`
      INSERT INTO file_version_restore_receipts (
        workspace_id, lineage_id, target_revision_id, initiated_by_user_id,
        idempotency_key, request_hash, status, lease_token, lease_expires_at,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'prepared', $7, $8, $9, $9)
      ON CONFLICT (workspace_id, initiated_by_user_id, idempotency_key) DO NOTHING
      RETURNING *
    `, [input.target.workspaceId, input.target.lineageId, input.request.revisionId, input.userId,
      input.request.idempotencyKey, input.hash, token, timestamp + RESTORE_LEASE_MS, timestamp]);
    if (inserted.rows[0]) return { kind: 'acquired', row: inserted.rows[0], token };
    const existing = (await transaction.query<RestoreReceiptRow>(`
      SELECT * FROM file_version_restore_receipts
      WHERE workspace_id = $1 AND initiated_by_user_id = $2 AND idempotency_key = $3
      FOR UPDATE
    `, [input.target.workspaceId, input.userId, input.request.idempotencyKey])).rows[0];
    if (!existing || existing.lineage_id !== input.target.lineageId
      || existing.target_revision_id !== input.request.revisionId || existing.request_hash !== input.hash) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.conflict,
        'This restore idempotency key belongs to another request.');
    }
    return existing.status === 'completed'
      ? { kind: 'completed', response: completedResponse(existing) }
      : { kind: 'prepared', row: existing };
  });

  const acquirePrepared = async (input: {
    row: RestoreReceiptRow;
    userId: string;
  }): Promise<{ row: RestoreReceiptRow; token: string }> => {
    const timestamp = now();
    if (Number(input.row.lease_expires_at) > timestamp) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
        'This restore is still being committed. Retry with the same idempotency key.');
    }
    const token = leaseToken();
    const result = await database.transaction((transaction) => transaction.query<RestoreReceiptRow>(`
      UPDATE file_version_restore_receipts
      SET lease_token = $1, lease_expires_at = $2, updated_at = $3
      WHERE workspace_id = $4 AND initiated_by_user_id = $5 AND idempotency_key = $6
        AND status = 'prepared' AND lease_expires_at <= $3
      RETURNING *
    `, [token, timestamp + RESTORE_LEASE_MS, timestamp, input.row.workspace_id,
      input.userId, input.row.idempotency_key]));
    const acquired = result.rows[0];
    if (!acquired) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
        'This restore is still being committed. Retry with the same idempotency key.');
    }
    return { row: acquired, token };
  };

  const rememberPriorRevision = async (input: {
    row: RestoreReceiptRow;
    token: string;
    priorRevisionId: string | null;
  }): Promise<void> => {
    const saved = await database.transaction((transaction) => transaction.query<{ idempotency_key: string }>(`
      UPDATE file_version_restore_receipts SET prior_revision_id = $1, updated_at = $2
      WHERE workspace_id = $3 AND initiated_by_user_id = $4 AND idempotency_key = $5
        AND status = 'prepared' AND lease_token = $6
      RETURNING idempotency_key
    `, [input.priorRevisionId, now(), input.row.workspace_id, input.row.initiated_by_user_id,
      input.row.idempotency_key, input.token]));
    if (!saved.rows[0]) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
        'The restore lease was lost before the current version was secured.');
    }
  };

  const abandon = async (input: { row: RestoreReceiptRow; token: string }): Promise<void> => {
    await database.transaction((transaction) => transaction.query(`
      DELETE FROM file_version_restore_receipts
      WHERE workspace_id = $1 AND initiated_by_user_id = $2 AND idempotency_key = $3
        AND status = 'prepared' AND lease_token = $4 AND prior_revision_id IS NULL
    `, [input.row.workspace_id, input.row.initiated_by_user_id, input.row.idempotency_key, input.token]));
  };

  const complete = async (input: {
    row: RestoreReceiptRow;
    response: FileVersionRestoreResponseV1;
  }): Promise<FileVersionRestoreResponseV1> => {
    const result = await database.transaction((transaction) => transaction.query<RestoreReceiptRow>(`
      UPDATE file_version_restore_receipts
      SET status = 'completed', restored_revision_id = $1, result_json = $2, updated_at = $3
      WHERE workspace_id = $4 AND initiated_by_user_id = $5 AND idempotency_key = $6
        AND request_hash = $7 AND status = 'prepared'
      RETURNING *
    `, [input.response.restoredRevisionId, JSON.stringify(input.response), now(), input.row.workspace_id,
      input.row.initiated_by_user_id, input.row.idempotency_key, input.row.request_hash]));
    if (result.rows[0]) return input.response;
    const existing = await database.transaction((transaction) => transaction.query<RestoreReceiptRow>(`
      SELECT * FROM file_version_restore_receipts
      WHERE workspace_id = $1 AND initiated_by_user_id = $2 AND idempotency_key = $3
    `, [input.row.workspace_id, input.row.initiated_by_user_id, input.row.idempotency_key]));
    if (existing.rows[0]?.status === 'completed') return completedResponse(existing.rows[0]);
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
      'The restore receipt could not be finalized.');
  };

  const captureRestored = async (input: {
    target: ResolvedFileVersionTarget;
    workspace: WorkspaceContext;
    userId: string;
    content: string;
    idempotencyKey: string;
    priorRevisionId: string | null;
  }) => {
    const captured = await history.capture({ workspace: input.workspace, path: input.target.path,
      content: input.content, source: 'restore', actorUserId: input.userId, actorType: 'user',
      sourceSessionId: restoreReceiptMarker(input.target.workspaceId, input.userId, input.idempotencyKey),
      baseRevisionId: input.priorRevisionId });
    if (!captured.revision || !captured.binding || captured.binding.source !== 'restore'
      || captured.binding.sha256 !== sha256(input.content)) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
        'The restored content has no durable restore revision.');
    }
    return captured.revision;
  };

  return {
    async restore(input: {
      request: FileVersionRestoreRequestV1;
      access: FileVersionCenterAccess;
      workspace: WorkspaceContext;
      actorSessionId?: string | null;
    }): Promise<FileVersionRestoreResponseV1> {
      const request = parseFileVersionRestoreRequestV1(input.request);
      const target = await query.resolve({ target: request.target, access: input.access });
      if (!restoreEnabled()) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.capabilityUnavailable,
          'Restore is unavailable in the current rollout mode.');
      }
      if (!input.access.canWrite || !input.workspace.permissions.canWrite
        || target.workspaceId !== input.workspace.workspaceId) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
          'Write access to the active workspace is required for restore.');
      }
      const fileClass = classifyFileVersionFileV1(target.path);
      if (fileClass !== 'markdown' && fileClass !== 'text') {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.capabilityUnavailable,
          'Restore is not supported for this file type.');
      }
      const selected = await contentStore.readRevisionContent({ revisionId: request.revisionId,
        workspaceId: target.workspaceId, lineageId: target.lineageId });
      if (!selected) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.contentUnavailable,
          'The selected immutable revision content is unavailable.');
      }
      const content = selected.content.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(selected.content)
        || selected.binding.format !== fileClass
        || (target.documentId !== null && content !== content.replace(/\r\n?/gu, '\n'))) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.contentUnavailable,
          'The selected revision cannot be represented safely by this document.');
      }
      const observed = await current(target, input.workspace);
      const hash = requestHash(request, target.lineageId);
      let claimResult = await claim({ request, target, userId: input.access.userId, hash });
      if (claimResult.kind === 'completed') return claimResult.response;

      if (claimResult.kind === 'prepared' && claimResult.row.prior_revision_id !== null
        && observed.fence.sha256 === selected.binding.sha256) {
        const restored = await captureRestored({ target, workspace: input.workspace, userId: input.access.userId,
          content: observed.content, idempotencyKey: request.idempotencyKey,
          priorRevisionId: claimResult.row.prior_revision_id });
        const recoveredFence = { ...observed.fence, revisionId: restored.id };
        await revalidateProposals({ database, target, workspace: input.workspace, userId: input.access.userId,
          current: recoveredFence, now: now() });
        const recovered = parseFileVersionRestoreResponseV1({ contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
          outcome: 'restored', priorRevisionId: claimResult.row.prior_revision_id,
          restoredRevisionId: restored.id, current: recoveredFence });
        return { ...await complete({ row: claimResult.row, response: recovered }), outcome: 'already_restored' };
      }

      if (claimResult.kind === 'acquired' && observed.fence.sha256 === selected.binding.sha256) {
        const noOpClaim = claimResult;
        await abandon(noOpClaim);
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.conflict,
          'The selected revision is already the current document content.');
      }

      if (claimResult.kind === 'prepared') {
        const acquired = await acquirePrepared({ row: claimResult.row, userId: input.access.userId });
        claimResult = { kind: 'acquired', row: acquired.row, token: acquired.token };
      }
      if (claimResult.kind !== 'acquired') {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.internal,
          'The restore receipt could not be acquired.');
      }
      if (!fileVersionFencesMatch(observed.fence, request.expectedCurrent)) {
        await abandon(claimResult);
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
          'The current document changed. Reload its timeline before restoring.');
      }

      const priorCapture = await history.capture({ workspace: input.workspace, path: target.path,
        content: observed.content, source: 'manual', actorUserId: input.access.userId, actorType: 'user',
        sourceSessionId: input.actorSessionId ?? null, baseRevisionId: observed.fence.revisionId });
      if (!priorCapture.revision || !priorCapture.binding) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
          'The current document could not be secured before restore.');
      }
      await rememberPriorRevision({ row: claimResult.row, token: claimResult.token,
        priorRevisionId: priorCapture.revision.id });
      const applied = await apply({ target, workspace: input.workspace, userId: input.access.userId,
        actorSessionId: input.actorSessionId, idempotencyKey: request.idempotencyKey, content,
        expectedCurrent: request.expectedCurrent, priorRevisionId: priorCapture.revision.id });
      if (applied.fence.sha256 !== selected.binding.sha256) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
          'The authoritative document does not match the selected revision after restore.');
      }
      const restored = await captureRestored({ target, workspace: input.workspace, userId: input.access.userId,
        content: applied.content, idempotencyKey: request.idempotencyKey,
        priorRevisionId: priorCapture.revision.id });
      const restoredFence = { ...applied.fence, revisionId: restored.id };
      await revalidateProposals({ database, target, workspace: input.workspace, userId: input.access.userId,
        current: restoredFence, now: now() });
      const response = parseFileVersionRestoreResponseV1({ contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        outcome: 'restored', priorRevisionId: priorCapture.revision.id,
        restoredRevisionId: restored.id, current: restoredFence });
      return complete({ row: claimResult.row, response });
    },
  };
}

export const fileVersionRestoreService = createFileVersionRestoreService();
