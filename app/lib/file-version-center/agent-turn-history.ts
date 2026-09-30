import 'server-only';

import { randomUUID } from 'node:crypto';
import type { FileRevisionRecord } from '@/app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase,
  type FileVersionCenterTransaction } from './database';
import { createFileVersionContentStore, decodeFileVersionContent, prepareFileVersionContent } from './version-content-store';
import { FILE_VERSION_CENTER_LIMITS_V1 } from './policy-v1';

export const AGENT_TURN_HISTORY_LEASE_MS = 90_000;
export type AgentTurnIdentity = { turnId: string; workspaceId: string; userId: string; sessionId: string };
export type AgentTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'recovered';
type TurnRow = { turn_id: string; workspace_id: string; user_id: string; source_session_id: string;
  outcome: AgentTurnOutcome | null; lease_expires_at: number | string };
type SegmentRow = {
  segment_id: string; turn_id: string; workspace_id: string; lineage_id: string; revision_id: string;
  content_format: 'markdown' | 'text'; content_sha256: string; raw_size_bytes: number | string;
  stored_size_bytes: number | string; pending_content: Buffer | Uint8Array | null;
  state_vector_hash: string | null; document_sequence: number | string | null;
  lifecycle_generation: number | string | null; finalized_at: number | string | null;
};

function assertIdentity(identity: AgentTurnIdentity) {
  if (!Object.values(identity).every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))) {
    throw new Error('Invalid agent turn identity.');
  }
}

async function lockWorkspace(tx: FileVersionCenterTransaction, workspaceId: string) {
  // Every turn mutation takes this lock before content-store admission locks.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-turn-history:${workspaceId}`]);
}

async function ensureTurn(tx: FileVersionCenterTransaction, identity: AgentTurnIdentity, now: number) {
  assertIdentity(identity);
  await tx.query(`INSERT INTO file_agent_turns
    (turn_id, workspace_id, user_id, source_session_id, lease_expires_at, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (turn_id) DO NOTHING`,
  [identity.turnId, identity.workspaceId, identity.userId, identity.sessionId, now + AGENT_TURN_HISTORY_LEASE_MS, now]);
  const row = (await tx.query<TurnRow>('SELECT * FROM file_agent_turns WHERE turn_id=$1 FOR UPDATE', [identity.turnId])).rows[0];
  if (!row || row.workspace_id !== identity.workspaceId || row.user_id !== identity.userId
    || row.source_session_id !== identity.sessionId) throw new Error('Agent turn scope mismatch.');
  return row;
}

function scopedStore(tx: FileVersionCenterTransaction) {
  return createFileVersionContentStore({ database: { transaction: action => action(tx) } });
}

async function finalizeSegment(tx: FileVersionCenterTransaction, row: SegmentRow, now: number) {
  if (row.finalized_at !== null) return;
  if (!row.pending_content) throw new Error('Agent turn snapshot is missing.');
  const content = decodeFileVersionContent({ codec: 'gzip', content_sha256: row.content_sha256,
    raw_size_bytes: row.raw_size_bytes, stored_size_bytes: row.stored_size_bytes,
    compressed_content: row.pending_content });
  // Prefer the matching physical receipt when serialization is byte-identical.
  // This keeps the saved version and Current card on the same revision identity.
  // CRLF/BOM or recovered snapshots keep their separate canonical history row.
  const physical = (await tx.query<{ id: string }>(`SELECT revision.id FROM file_agent_turn_checkpoints checkpoint
    INNER JOIN file_revisions revision ON revision.id=checkpoint.revision_id
    WHERE checkpoint.segment_id=$1 AND revision.history_only=false
      AND revision.content_hash=$2 AND revision.size_bytes=$3
    ORDER BY revision.revision_number DESC,revision.created_at DESC,revision.id DESC LIMIT 1`,
  [row.segment_id,row.content_sha256,Number(row.raw_size_bytes)])).rows[0];
  const revisionId = physical?.id ?? row.revision_id;
  const store = scopedStore(tx);
  const existing = await store.readRevisionContent({ revisionId,
    workspaceId: row.workspace_id, lineageId: row.lineage_id });
  if (existing) {
    if (existing.binding.sha256 !== row.content_sha256 || !existing.content.equals(content)) {
      throw new Error('Agent turn snapshot does not match its immutable version.');
    }
  } else {
    await store.bindRevisionContent({ revisionId, workspaceId: row.workspace_id,
      lineageId: row.lineage_id, content, format: row.content_format, source: 'agent_apply',
      stateVectorHash: row.state_vector_hash });
  }
  await tx.query(`UPDATE file_agent_turn_segments SET revision_id=$3, pending_content=NULL, finalized_at=$2, updated_at=$2
    WHERE segment_id=$1 AND finalized_at IS NULL`, [row.segment_id, now, revisionId]);
}

export function createAgentTurnHistoryService(options: { database?: FileVersionCenterDatabase; now?: () => number } = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const now = options.now ?? Date.now;
  const finish = async (identity: AgentTurnIdentity, outcome: AgentTurnOutcome, onlyExpired = false) => database.transaction(async tx => {
    await lockWorkspace(tx, identity.workspaceId);
    const timestamp = now();
    const turn = await ensureTurn(tx, identity, timestamp);
    if (onlyExpired && Number(turn.lease_expires_at) > timestamp) return;
    const segments = await tx.query<SegmentRow>(`SELECT * FROM file_agent_turn_segments
      WHERE turn_id=$1 AND workspace_id=$2 AND finalized_at IS NULL FOR UPDATE`, [identity.turnId, identity.workspaceId]);
    for (const segment of segments.rows) await finalizeSegment(tx, segment, timestamp);
    await tx.query(`UPDATE file_agent_turns SET outcome=COALESCE(outcome,$2), updated_at=$3 WHERE turn_id=$1`,
      [identity.turnId, outcome, timestamp]);
  });
  return {
    async begin(identity: AgentTurnIdentity) {
      await database.transaction(async tx => {
        await lockWorkspace(tx, identity.workspaceId);
        const row = await ensureTurn(tx, identity, now());
        if (row.outcome) throw new Error('A completed agent turn cannot be reopened.');
      });
    },
    async touch(identity: AgentTurnIdentity) {
      assertIdentity(identity);
      await database.transaction(tx => tx.query(`UPDATE file_agent_turns SET lease_expires_at=$5, updated_at=$6
        WHERE turn_id=$1 AND workspace_id=$2 AND user_id=$3 AND source_session_id=$4 AND outcome IS NULL`,
      [identity.turnId, identity.workspaceId, identity.userId, identity.sessionId, now() + AGENT_TURN_HISTORY_LEASE_MS, now()]));
    },
    finish,
    async hasOperation(input: { operationId: string; turnId: string; workspaceId: string }) {
      return database.transaction(async tx => Boolean((await tx.query(`SELECT 1 FROM file_agent_turn_checkpoints checkpoint
        INNER JOIN file_agent_turn_segments segment ON segment.segment_id=checkpoint.segment_id
        WHERE checkpoint.operation_id=$1 AND segment.turn_id=$2 AND checkpoint.workspace_id=$3`,
      [input.operationId, input.turnId, input.workspaceId])).rows.length));
    },

    /** Replace only the one mutable pending snapshot. Ledger revisions remain immutable. */
    async stage(input: { identity: AgentTurnIdentity; workspace: WorkspaceContext; path: string;
      revision: FileRevisionRecord | null; historicalLineageId?: string; content: string | Uint8Array;
      format: 'markdown' | 'text'; stateVectorHash?: string | null; operationId?: string | null;
      baseDocumentSequence?: number | null; documentSequence?: number | null;
      lifecycleGeneration?: number | null; capturedAt?: number; recovered?: boolean }) {
      const prepared = prepareFileVersionContent(input.content);
      return database.transaction(async tx => {
        await lockWorkspace(tx, input.identity.workspaceId);
        const timestamp = now();
        const turn = await ensureTurn(tx, input.identity, timestamp);
        if (input.workspace.workspaceId !== input.identity.workspaceId) throw new Error('Agent snapshot scope mismatch.');
        if (input.operationId && (await tx.query(`SELECT 1 FROM file_agent_turn_checkpoints checkpoint
          INNER JOIN file_agent_turn_segments segment ON segment.segment_id=checkpoint.segment_id
          WHERE checkpoint.operation_id=$1 AND segment.turn_id=$2 AND checkpoint.workspace_id=$3`,
        [input.operationId, input.identity.turnId, input.identity.workspaceId])).rows.length) return input.revision;
        if (turn.outcome && !input.recovered) throw new Error('An agent turn ended before its snapshot was recorded.');
        let revision = input.revision;
        const lineageId = revision?.lineageId ?? input.historicalLineageId;
        if (!lineageId) throw new Error('An agent snapshot requires a file lineage.');
        // Compatible with FK key-share locks taken by immutable content inserts.
        await tx.query('SELECT id FROM file_collaboration_lineages WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE',
          [lineageId, input.identity.workspaceId]);
        if (!revision) {
          const revisionId = `file-rev-${randomUUID()}`;
          const createdAt = input.capturedAt ?? timestamp;
          await tx.query(`INSERT INTO file_revisions (id,organization_id,customer_id,project_id,workspace_id,workspace_type,
            path,content_hash,size_bytes,created_by_user_id,created_by_actor_type,source_session_id,lineage_id,
            revision_number,created_at,history_only)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'agent',$11,$12,
              (SELECT COALESCE(MAX(revision_number),0)+1 FROM file_revisions WHERE lineage_id=$12),$13,true)`,
          [revisionId,input.workspace.organizationId??null,input.workspace.customerId??null,input.workspace.projectId??null,
            input.identity.workspaceId,input.workspace.workspaceType,input.path,prepared.sha256,prepared.rawSizeBytes,
            input.identity.userId,input.identity.sessionId,lineageId,createdAt]);
          revision = { id: revisionId, lineageId, organizationId: input.workspace.organizationId ?? null,
            customerId: input.workspace.customerId ?? null, projectId: input.workspace.projectId ?? null,
            workspaceId: input.identity.workspaceId, workspaceType: input.workspace.workspaceType,
            path: input.path, contentHash: prepared.sha256, sizeBytes: prepared.rawSizeBytes,
            createdByUserId: input.identity.userId, createdByActorType: 'agent',
            sourceSessionId: input.identity.sessionId, baseRevisionId: null, createdAt };
        }
        if (revision.workspaceId !== input.identity.workspaceId || revision.contentHash !== prepared.sha256
          || revision.sizeBytes !== prepared.rawSizeBytes) throw new Error('Agent snapshot does not match its revision.');
        // Never hide or relabel an existing human, review, restore or legacy binding.
        const store = scopedStore(tx);
        if (await store.readRevisionContent({ revisionId: revision.id, workspaceId: revision.workspaceId, lineageId })) return revision;
        const mapped = (await tx.query(`SELECT 1 FROM file_agent_turn_checkpoints WHERE revision_id=$1`, [revision.id])).rows.length;
        if (mapped) return revision;
        let segment: SegmentRow | undefined = (await tx.query<SegmentRow>(`SELECT * FROM file_agent_turn_segments
          WHERE workspace_id=$1 AND lineage_id=$2 AND finalized_at IS NULL FOR UPDATE`,
        [revision.workspaceId,lineageId])).rows[0];
        if (segment && (segment.turn_id !== input.identity.turnId || input.recovered
          || (input.lifecycleGeneration != null && segment.lifecycle_generation !== null && Number(segment.lifecycle_generation) !== input.lifecycleGeneration)
          || (input.baseDocumentSequence != null && segment.document_sequence !== null && Number(segment.document_sequence) !== input.baseDocumentSequence))) {
          await finalizeSegment(tx, segment, timestamp);
          segment = undefined;
        }
        const usage = await store.getStorageUsage({ workspaceId: revision.workspaceId, lineageId });
        const pending = (await tx.query<{ workspace_bytes: string; lineage_bytes: string; lineage_count: string }>(`
          SELECT COALESCE(SUM(stored_size_bytes),0) AS workspace_bytes,
            COALESCE(SUM(CASE WHEN lineage_id=$2 THEN stored_size_bytes ELSE 0 END),0) AS lineage_bytes,
            COUNT(*) FILTER (WHERE lineage_id=$2) AS lineage_count
          FROM file_agent_turn_segments WHERE workspace_id=$1 AND pending_content IS NOT NULL
            AND ($3::text IS NULL OR segment_id<>$3)`, [revision.workspaceId,lineageId,segment?.segment_id??null])).rows[0]!;
        if (usage.workspaceStoredBytes + Number(pending.workspace_bytes) + prepared.storedSizeBytes > FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerWorkspace
          || usage.lineageStoredBytes + Number(pending.lineage_bytes) + prepared.storedSizeBytes > FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerLineage
          || usage.lineageVersionCount + Number(pending.lineage_count) + 1 > FILE_VERSION_CENTER_LIMITS_V1.maxVersionsPerLineage) {
          throw new Error('The agent snapshot exceeds the version storage quota.');
        }
        const segmentId = segment?.segment_id ?? `agent-segment-${randomUUID()}`;
        await tx.query(`INSERT INTO file_agent_turn_segments
          (segment_id,turn_id,workspace_id,lineage_id,revision_id,path_hint,content_format,content_sha256,
            raw_size_bytes,stored_size_bytes,pending_content,state_vector_hash,document_sequence,lifecycle_generation,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
          ON CONFLICT (segment_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,path_hint=EXCLUDED.path_hint,
            content_sha256=EXCLUDED.content_sha256,raw_size_bytes=EXCLUDED.raw_size_bytes,stored_size_bytes=EXCLUDED.stored_size_bytes,
            pending_content=EXCLUDED.pending_content,state_vector_hash=EXCLUDED.state_vector_hash,
            document_sequence=EXCLUDED.document_sequence,lifecycle_generation=EXCLUDED.lifecycle_generation,updated_at=EXCLUDED.updated_at`,
        [segmentId,input.identity.turnId,revision.workspaceId,lineageId,revision.id,input.path,input.format,
          prepared.sha256,prepared.rawSizeBytes,prepared.storedSizeBytes,prepared.compressedContent,
          input.stateVectorHash??null,input.documentSequence??null,input.lifecycleGeneration??null,timestamp]);
        await tx.query(`INSERT INTO file_agent_turn_checkpoints (revision_id,workspace_id,lineage_id,segment_id,operation_id)
          VALUES ($1,$2,$3,$4,$5)`, [revision.id,revision.workspaceId,lineageId,segmentId,input.operationId??null]);
        // A non-collaborative tool has already written and registered its file.
        // Absorb that physical receipt as well as the canonical history row.
        if (!input.operationId && !input.recovered) {
          await tx.query(`INSERT INTO file_agent_turn_checkpoints (revision_id,workspace_id,lineage_id,segment_id)
            SELECT physical.id,physical.workspace_id,physical.lineage_id,$4 FROM file_revisions physical
            WHERE physical.id=(SELECT id FROM file_revisions WHERE lineage_id=$2 AND history_only=false
              ORDER BY revision_number DESC,created_at DESC,id DESC LIMIT 1)
              AND physical.workspace_id=$1 AND physical.content_hash=$3
              AND NOT EXISTS (SELECT 1 FROM file_revision_contents contents WHERE contents.revision_id=physical.id)
            ON CONFLICT (revision_id) DO NOTHING`, [revision.workspaceId,lineageId,prepared.sha256,segmentId]);
        }
        if (turn.outcome || input.recovered) {
          const row = (await tx.query<SegmentRow>('SELECT * FROM file_agent_turn_segments WHERE segment_id=$1', [segmentId])).rows[0]!;
          await finalizeSegment(tx,row,timestamp);
        }
        return revision;
      });
    },

    /** Human writes and review acceptance end the preceding agent segment. */
    async boundary(input: { workspaceId: string; path: string; automaticHash?: string }) {
      return database.transaction(async tx => {
        await lockWorkspace(tx,input.workspaceId);
        const rows = await tx.query<SegmentRow>(`SELECT segment.* FROM file_agent_turn_segments segment
          INNER JOIN file_collaboration_lineages lineage ON lineage.id=segment.lineage_id AND lineage.workspace_id=segment.workspace_id
          WHERE segment.workspace_id=$1 AND lineage.path=$2 AND segment.finalized_at IS NULL FOR UPDATE OF segment`,
        [input.workspaceId,input.path]);
        if (input.automaticHash && rows.rows.some(row => row.content_sha256 === input.automaticHash)) return true;
        for (const row of rows.rows) await finalizeSegment(tx,row,now());
        return false;
      });
    },

    async linkCheckpoint(input: { turnId: string; workspaceId: string; operationId: string; revisionId: string;
      documentSequence: number; lifecycleGeneration: number }) {
      await database.transaction(async tx => {
        await lockWorkspace(tx,input.workspaceId);
        await tx.query(`INSERT INTO file_agent_turn_checkpoints (revision_id,workspace_id,lineage_id,segment_id)
          SELECT revision.id,revision.workspace_id,revision.lineage_id,segment.segment_id
          FROM file_agent_turn_checkpoints operation_checkpoint
          INNER JOIN file_agent_turn_segments segment ON segment.segment_id=operation_checkpoint.segment_id
          INNER JOIN file_revisions revision ON revision.id=$4 AND revision.workspace_id=segment.workspace_id
            AND revision.lineage_id=segment.lineage_id
          WHERE operation_checkpoint.operation_id=$3 AND segment.turn_id=$1 AND segment.workspace_id=$2
            AND segment.document_sequence=$5 AND segment.lifecycle_generation=$6
            AND NOT EXISTS (SELECT 1 FROM file_revision_contents contents WHERE contents.revision_id=revision.id)
          ON CONFLICT (revision_id) DO NOTHING`, [input.turnId,input.workspaceId,input.operationId,input.revisionId,
            input.documentSequence,input.lifecycleGeneration]);
      });
    },

    async recoverExpired() {
      const rows = await database.transaction(tx => tx.query<TurnRow>(`SELECT * FROM file_agent_turns
        WHERE outcome IS NULL AND lease_expires_at <= $1 ORDER BY lease_expires_at LIMIT 100`, [now()]));
      const failures: unknown[] = [];
      for (const row of rows.rows) {
        try {
          await finish({ turnId:row.turn_id, workspaceId:row.workspace_id,userId:row.user_id,sessionId:row.source_session_id }, 'recovered', true);
        } catch (error) {
          failures.push(error);
          // Retry damaged or quota-blocked turns later, so they cannot fill
          // every page of the recovery queue indefinitely.
          await this.touch({ turnId:row.turn_id, workspaceId:row.workspace_id,
            userId:row.user_id,sessionId:row.source_session_id }).catch(retryError => failures.push(retryError));
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Some agent turn histories could not be recovered.');
    },
  };
}

export const agentTurnHistoryService = createAgentTurnHistoryService();
