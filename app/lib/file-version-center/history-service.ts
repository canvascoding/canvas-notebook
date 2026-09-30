import 'server-only';

import { createHash } from 'node:crypto';

import type { PersistedCollaborationState } from '@/app/lib/collaboration/persistence';
import { authoritativeCollaborationSnapshot } from '@/app/lib/collaboration/checkpoint';
import {
  ensureFileRevisionForCurrentContent,
  type FileActorType,
  type FileRevisionRecord,
} from '@/app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  createRuntimeFileVersionCenterDatabase,
  type FileVersionCenterDatabase,
} from './database';
import {
  fileVersionContentStore,
  type FileVersionContentBinding,
  type FileVersionContentSource,
  type FileVersionContentStore,
} from './version-content-store';
import {
  classifyFileVersionFileV1,
  FILE_VERSION_CENTER_LIMITS_V1,
  FILE_VERSION_CENTER_ROLLOUT_ENV_V1,
  resolveFileVersionRolloutV1,
} from './policy-v1';
import { createAgentTurnHistoryService } from './agent-turn-history';

export type FileVersionCaptureOutcome =
  | 'captured'
  | 'already_captured'
  | 'deferred_agent_turn'
  | 'deduplicated_checkpoint'
  | 'disabled'
  | 'unsupported';

export type FileVersionCaptureResult = {
  outcome: FileVersionCaptureOutcome;
  revision: FileRevisionRecord | null;
  binding: FileVersionContentBinding | null;
};

export type FileVersionCaptureInput = {
  workspace: WorkspaceContext;
  path: string;
  content: string | Uint8Array;
  source: FileVersionContentSource;
  actorUserId?: string | null;
  actorType?: FileActorType;
  sourceSessionId?: string | null;
  baseRevisionId?: string | null;
  stateVector?: string | Uint8Array | null;
  agentTurnId?: string | null;
  agentOperationId?: string | null;
  agentBaseDocumentSequence?: number | null;
  documentSequence?: number | null;
  lifecycleGeneration?: number | null;
  historicalLineageId?: string;
  agentCapturedAt?: number;
  agentRecovered?: boolean;
};

export type FileVersionHistoryLedger = {
  ensureRevision: (input: {
    workspace: WorkspaceContext;
    path: string;
    contentHash: string;
    sizeBytes: number;
    actorUserId?: string | null;
    actorType?: FileActorType;
    sourceSessionId?: string | null;
    baseRevisionId?: string | null;
    nowMs?: number;
  }) => Promise<FileRevisionRecord>;
};

type LatestCaptureRow = {
  revision_id: string;
  created_at: number | string;
};

function contentBytes(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

function stateVectorHash(stateVector: FileVersionCaptureInput['stateVector']): string | null {
  if (!stateVector) return null;
  const bytes = typeof stateVector === 'string'
    ? Buffer.from(stateVector, 'base64')
    : Buffer.from(stateVector);
  return createHash('sha256').update(bytes).digest('hex');
}

function captureFormat(path: string): 'markdown' | 'text' | null {
  const fileClass = classifyFileVersionFileV1(path);
  return fileClass === 'markdown' || fileClass === 'text' ? fileClass : null;
}

async function latestAutomaticCapture(
  database: FileVersionCenterDatabase,
  workspaceId: string,
  path: string,
): Promise<LatestCaptureRow | null> {
  return database.transaction(async (transaction) => {
    const result = await transaction.query<LatestCaptureRow>(`
      SELECT contents.revision_id, contents.created_at
      FROM file_collaboration_lineages lineage
      INNER JOIN file_revision_contents contents
        ON contents.workspace_id = lineage.workspace_id AND contents.lineage_id = lineage.id
      WHERE lineage.workspace_id = $1 AND lineage.path = $2 AND lineage.status = 'active'
        AND contents.source = 'automatic_checkpoint'
      ORDER BY contents.created_at DESC, contents.revision_id DESC
      LIMIT 1
    `, [workspaceId, path]);
    return result.rows[0] ?? null;
  });
}

export function createFileVersionHistoryService(options: {
  database?: FileVersionCenterDatabase;
  contentStore?: Pick<FileVersionContentStore, 'bindRevisionContent' | 'readRevisionContent'>;
  ledger?: FileVersionHistoryLedger;
  now?: () => number;
  captureEnabled?: () => boolean;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const contentStore = options.contentStore ?? fileVersionContentStore;
  const ledger = options.ledger ?? { ensureRevision: ensureFileRevisionForCurrentContent };
  const turns = createAgentTurnHistoryService({ database, now: options.now });
  const now = options.now ?? Date.now;
  const captureEnabled = options.captureEnabled ?? (() => resolveFileVersionRolloutV1(
    process.env[FILE_VERSION_CENTER_ROLLOUT_ENV_V1.mode],
  ).capture);

  const capture = async (input: FileVersionCaptureInput): Promise<FileVersionCaptureResult> => {
      if (!captureEnabled()) return { outcome: 'disabled', revision: null, binding: null };
      const format = captureFormat(input.path);
      if (!format) return { outcome: 'unsupported', revision: null, binding: null };

      const capturedAt = now();
      const content = contentBytes(input.content);
      const contentHash = createHash('sha256').update(content).digest('hex');
      const grouped = input.source === 'agent_apply' && Boolean(input.agentTurnId);
      if (!grouped && await turns.boundary({ workspaceId: input.workspace.workspaceId, path: input.path,
        ...(input.source === 'automatic_checkpoint' ? { automaticHash: contentHash } : {}) })) {
        return { outcome: 'deduplicated_checkpoint', revision: null, binding: null };
      }
      if (input.source === 'automatic_checkpoint') {
        const latest = await latestAutomaticCapture(database, input.workspace.workspaceId, input.path);
        if (latest && capturedAt - Number(latest.created_at)
          < FILE_VERSION_CENTER_LIMITS_V1.automaticCheckpointIntervalSeconds * 1_000) {
          return { outcome: 'deduplicated_checkpoint', revision: null, binding: null };
        }
      }

      // Agent history is created atomically with its pending slot. Only the
      // physical checkpoint writer may advance the current-file revision.
      const revision = grouped || input.historicalLineageId ? null : await ledger.ensureRevision({
        workspace: input.workspace,
        path: input.path,
        contentHash,
        sizeBytes: content.byteLength,
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorType ?? 'system',
        sourceSessionId: input.sourceSessionId ?? null,
        baseRevisionId: input.baseRevisionId ?? null,
        nowMs: capturedAt,
      });

      if (grouped) {
        if (!input.actorUserId || !input.sourceSessionId || input.actorType !== 'agent') {
          throw new Error('A grouped agent snapshot requires its trusted user and session.');
        }
        const lineageId = input.historicalLineageId ?? await database.transaction(async tx => {
          const result = await tx.query<{ id: string }>(`SELECT id FROM file_collaboration_lineages
            WHERE workspace_id=$1 AND path=$2 AND status='active'`, [input.workspace.workspaceId, input.path]);
          return result.rows[0]?.id;
        });
        if (!lineageId) throw new Error('A grouped agent snapshot requires an existing file lineage.');
        const staged = await turns.stage({
          identity: { turnId: input.agentTurnId!, workspaceId: input.workspace.workspaceId,
            userId: input.actorUserId, sessionId: input.sourceSessionId },
          workspace: input.workspace, path: input.path, revision, content, format,
          stateVectorHash: stateVectorHash(input.stateVector), operationId: input.agentOperationId,
          baseDocumentSequence: input.agentBaseDocumentSequence, documentSequence: input.documentSequence,
          lifecycleGeneration: input.lifecycleGeneration, historicalLineageId: lineageId,
          capturedAt: input.agentCapturedAt, recovered: input.agentRecovered,
        });
        return { outcome: 'deferred_agent_turn', revision: staged, binding: null };
      }
      if (!revision) throw new Error('Historical snapshots require an agent turn.');

      const existing = revision.lineageId
        ? await contentStore.readRevisionContent({
            revisionId: revision.id,
            workspaceId: input.workspace.workspaceId,
            lineageId: revision.lineageId,
          })
        : null;
      if (existing) {
        if (existing.binding.sha256 !== contentHash || !existing.content.equals(content)) {
          throw new Error('The immutable version binding does not match the revision ledger.');
        }
        return { outcome: 'already_captured', revision, binding: existing.binding };
      }
      if (!revision.lineageId) throw new Error('A captured version requires a stable file lineage.');

      const stored = await contentStore.bindRevisionContent({
        revisionId: revision.id,
        workspaceId: input.workspace.workspaceId,
        lineageId: revision.lineageId,
        content,
        format,
        source: input.source,
        stateVectorHash: stateVectorHash(input.stateVector),
      });
      return {
        outcome: stored.outcome === 'created' ? 'captured' : 'already_captured',
        revision,
        binding: stored.binding,
      };
  };

  return {
    capture,

    async capturePersistedCollaboration(input: {
      workspace: WorkspaceContext;
      state: PersistedCollaborationState;
      source: 'automatic_checkpoint' | 'agent_apply' | 'restore';
      actorUserId?: string | null;
      actorType?: FileActorType;
      sourceSessionId?: string | null;
      baseRevisionId?: string | null;
      agentTurnId?: string | null;
      agentOperationId?: string | null;
      agentBaseDocumentSequence?: number | null;
    }): Promise<FileVersionCaptureResult> {
      if (input.state.workspaceId !== input.workspace.workspaceId || input.state.status !== 'active') {
        throw new Error('The authoritative collaboration snapshot is outside the active workspace scope.');
      }
      const snapshot = authoritativeCollaborationSnapshot(input.state);
      return capture({
        workspace: input.workspace,
        path: input.state.path,
        content: snapshot.canonicalContent,
        source: input.source,
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorType ?? 'system',
        sourceSessionId: input.sourceSessionId ?? null,
        baseRevisionId: input.baseRevisionId ?? null,
        stateVector: input.state.stateVector,
        agentTurnId: input.agentTurnId,
        agentOperationId: input.agentOperationId,
        agentBaseDocumentSequence: input.agentBaseDocumentSequence,
        documentSequence: input.state.documentSequence,
        lifecycleGeneration: input.state.lifecycleGeneration,
      });
    },
  };
}

export const fileVersionHistoryService = createFileVersionHistoryService();
