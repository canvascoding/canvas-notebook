import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import { createAgentTurnHistoryService, AGENT_TURN_HISTORY_LEASE_MS } from '../app/lib/file-version-center/agent-turn-history';
import { createFileVersionHistoryService, type FileVersionHistoryLedger } from '../app/lib/file-version-center/history-service';
import { createFileVersionCenterQueryService } from '../app/lib/file-version-center/query-service';
import { createFileVersionContentStore, prepareFileVersionContent } from '../app/lib/file-version-center/version-content-store';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { getLatestFileRevisionForLineage } from '../app/lib/files/collaboration-repository/lineage-revision-repository';
import type { FileRevisionRecord } from '../app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { SqlConnection } from '../app/lib/db';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];
type RevisionRow = {
  id: string; lineage_id: string; path: string; content_hash: string; size_bytes: number | string;
  created_by_user_id: string | null; created_by_actor_type: FileRevisionRecord['createdByActorType'];
  source_session_id: string | null; base_revision_id: string | null; created_at: number | string;
};
type PendingRow = { segment_id: string; revision_id: string; content_sha256: string;
  pending_content: Uint8Array | null; finalized_at: number | string | null };

const workspace: WorkspaceContext = {
  workspaceId: 'workspace', workspaceType: 'personal', organizationId: 'org', customerId: null,
  projectId: null, rootPath: '/tmp/agent-turn-history', displayName: 'Agent Turn History',
  status: 'active', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
    canManageWorkspace: true, canRunAgent: true },
};

const access = {
  userId: 'owner', authenticatedWorkspaceId: 'workspace', requestedWorkspaceId: 'workspace',
  membership: 'active' as const, permissionsResolved: true, canRead: true, canWrite: true,
  canRunAgent: true, canManageWorkspace: true,
};

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function database(postgres: PGlite): FileVersionCenterDatabase {
  return { transaction: action => postgres.transaction(async transaction => action({
    query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
  })) };
}

function mapRevision(row: RevisionRow): FileRevisionRecord {
  return {
    id: row.id, lineageId: row.lineage_id, organizationId: 'org', customerId: null,
    projectId: null, workspaceId: 'workspace', workspaceType: 'personal', path: row.path,
    contentHash: row.content_hash, sizeBytes: Number(row.size_bytes),
    createdByUserId: row.created_by_user_id, createdByActorType: row.created_by_actor_type,
    sourceSessionId: row.source_session_id, baseRevisionId: row.base_revision_id,
    createdAt: Number(row.created_at),
  };
}

function ledger(postgres: PGlite): FileVersionHistoryLedger {
  let nextId = 0;
  return {
    async ensureRevision(input) {
      const lineage = (await postgres.query<{ id: string }>(
        `SELECT id FROM file_collaboration_lineages WHERE workspace_id=$1 AND path=$2 AND status='active'`,
        [input.workspace.workspaceId, input.path],
      )).rows[0];
      if (!lineage) throw new Error(`Missing fixture lineage: ${input.path}`);
      const latest = (await postgres.query<RevisionRow>(`SELECT * FROM file_revisions
        WHERE lineage_id=$1 AND history_only=false ORDER BY revision_number DESC LIMIT 1`, [lineage.id])).rows[0];
      if (latest && latest.content_hash === input.contentHash && Number(latest.size_bytes) === input.sizeBytes) {
        return mapRevision(latest);
      }
      const created = (await postgres.query<RevisionRow>(`INSERT INTO file_revisions
        (id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,created_by_user_id,
          created_by_actor_type,source_session_id,base_revision_id,lineage_id,revision_number,created_at)
        VALUES ($1,'org','workspace','personal',$2,$3,$4,$5,$6,$7,$8,$9,
          (SELECT COALESCE(MAX(revision_number),0)+1 FROM file_revisions WHERE lineage_id=$9),$10)
        RETURNING *`, [`revision-${++nextId}`, input.path, input.contentHash, input.sizeBytes,
        input.actorUserId ?? null, input.actorType ?? 'system', input.sourceSessionId ?? null,
        input.baseRevisionId ?? latest?.id ?? null, lineage.id, input.nowMs ?? Date.now()])).rows[0]!;
      return mapRevision(created);
    },
  };
}

async function setup(postgres: PGlite): Promise<void> {
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  await postgres.exec(`
    INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ('owner','Owner','owner@turn.test',1,1,1);
    INSERT INTO canvas_organization_settings
      (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES ('org','owner','team',1,1,1);
    INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,root_relative_path,display_name,workspace_icon,
        status,is_default,created_at,updated_at)
      VALUES ('workspace','org','personal','owner','workspaces/turn-history','Turn History',
        'user-round','active',1,1,1);
  `);
  for (const name of ['notes', 'boundary', 'automatic', 'other', 'recovery', 'corrupt', 'quota', 'legacy', 'checkpoint']) {
    await postgres.query(`INSERT INTO file_collaboration_lineages
      (id,organization_id,workspace_id,workspace_type,path,status,created_at)
      VALUES ($1,'org','workspace','personal',$2,'active',1)`, [`lineage-${name}`, `${name}.md`]);
  }
}

async function count(postgres: PGlite, table: string, condition = ''): Promise<number> {
  const result = await postgres.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table} ${condition}`);
  return Number(result.rows[0]!.count);
}

async function pending(postgres: PGlite, lineage: string): Promise<PendingRow[]> {
  return (await postgres.query<PendingRow>(`SELECT segment_id,revision_id,content_sha256,pending_content,finalized_at
    FROM file_agent_turn_segments WHERE lineage_id=$1 ORDER BY created_at,segment_id`, [`lineage-${lineage}`])).rows;
}

async function latestPhysical(postgres: PGlite, lineage: string): Promise<string | null> {
  const connection = { get: async (sql: string, params: unknown[]) =>
    (await postgres.query(sql, params)).rows[0] } as unknown as SqlConnection;
  return (await getLatestFileRevisionForLineage(connection, `lineage-${lineage}`))?.id ?? null;
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await setup(postgres);
    const db = database(postgres);
    const store = createFileVersionContentStore({ database: db });
    let now = 100_000;
    const turns = createAgentTurnHistoryService({ database: db, now: () => now });
    const history = createFileVersionHistoryService({ database: db, contentStore: store,
      ledger: ledger(postgres), now: () => now, captureEnabled: () => true });
    const identity = (turnId: string, sessionId = 'session-1') =>
      ({ turnId, workspaceId: 'workspace', userId: 'owner', sessionId });
    const agent = (turnId: string, path: string, content: string, base: number, sequence: number,
      extra: Record<string, unknown> = {}) => history.capture({
        workspace, path, content, source: 'agent_apply', actorUserId: 'owner', actorType: 'agent',
        sourceSessionId: 'session-1', agentTurnId: turnId, agentBaseDocumentSequence: base,
        documentSequence: sequence, lifecycleGeneration: 1, ...extra,
      });

    // Three technical revisions, one mutable snapshot and one visible immutable version.
    const initial = await history.capture({ workspace, path: 'notes.md', content: 'line 1\n',
      source: 'initial', actorUserId: 'owner', actorType: 'user' });
    assert.equal(initial.outcome, 'captured');
    await turns.begin(identity('turn-one'));
    const edits = [];
    for (const [content, base, sequence] of [
      ['line 10\n', 0, 1], ['line 10\nline 40\n', 1, 2], ['line 10\nline 40\nline 60\n', 2, 3],
    ] as const) {
      const result = await agent('turn-one', 'notes.md', content, base, sequence);
      assert.equal(result.outcome, 'deferred_agent_turn');
      assert.equal(result.binding, null);
      edits.push(result.revision!.id);
    }
    assert.equal(new Set(edits).size, 3);
    assert.equal((await pending(postgres, 'notes')).length, 1);
    assert.equal((await pending(postgres, 'notes'))[0]!.content_sha256, hash('line 10\nline 40\nline 60\n'));
    assert.equal(await count(postgres, 'file_agent_turn_checkpoints', "WHERE lineage_id='lineage-notes'"), 3);
    assert.equal(await count(postgres, 'file_revision_contents', "WHERE lineage_id='lineage-notes'"), 1);
    assert.equal(await count(postgres, 'file_version_blobs'), 1, 'intermediate contents must not allocate blobs');
    await turns.finish(identity('turn-one'), 'completed');
    await turns.finish(identity('turn-one'), 'completed');
    assert.equal(await count(postgres, 'file_revision_contents', "WHERE lineage_id='lineage-notes'"), 2);
    assert.equal(await count(postgres, 'file_version_blobs'), 2);
    assert.equal((await pending(postgres, 'notes'))[0]!.pending_content, null);
    const final = await store.readRevisionContent({ revisionId: edits[2]!, workspaceId: 'workspace',
      lineageId: 'lineage-notes' });
    assert.equal(final?.content.toString(), 'line 10\nline 40\nline 60\n');
    const query = createFileVersionCenterQueryService({ database: db, rolloutMode: () => 'full',
      current: async target => ({ fence: { revisionId: target.latestRevisionId,
        sha256: target.latestRevisionHash! }, sizeBytes: target.latestRevisionSize, observedAt: now }),
      readPolicy: async () => ({ contractVersion: 1, requestedMode: 'safe_direct',
        effectiveMode: 'safe_direct', revision: 0, locked: false, reason: 'default_safe_direct' }),
    });
    const timeline = await query.timeline({ target: { kind: 'lineage', workspaceId: 'workspace',
      lineageId: 'lineage-notes' }, access, workspace });
    const visible = timeline.entries.filter(entry => entry.kind === 'revision');
    assert.deepEqual(visible.map(entry => entry.revisionId), [edits[2], initial.revision!.id]);

    // A second user prompt in the same chat gets a second version.
    await turns.begin(identity('turn-two'));
    const second = await agent('turn-two', 'notes.md', 'second turn\n', 3, 4);
    await turns.finish(identity('turn-two'), 'completed');
    assert.notEqual(second.revision?.id, edits[2]);
    assert.equal(await count(postgres, 'file_revision_contents', "WHERE lineage_id='lineage-notes'"), 3);

    // Human content closes the first segment before the same agent turn continues.
    await turns.begin(identity('turn-boundary'));
    const beforeHuman = await agent('turn-boundary', 'boundary.md', 'agent before human\n', 0, 1);
    const human = await history.capture({ workspace, path: 'boundary.md', content: 'human edit\n',
      source: 'manual', actorUserId: 'owner', actorType: 'user' });
    assert.equal(human.outcome, 'captured');
    const afterHuman = await agent('turn-boundary', 'boundary.md', 'agent after human\n', 2, 3);
    await turns.finish(identity('turn-boundary'), 'completed');
    assert.equal((await pending(postgres, 'boundary')).length, 2);
    assert.equal((await store.readRevisionContent({ revisionId: beforeHuman.revision!.id,
      workspaceId: 'workspace', lineageId: 'lineage-boundary' }))?.content.toString(), 'agent before human\n');
    assert.equal((await store.readRevisionContent({ revisionId: afterHuman.revision!.id,
      workspaceId: 'workspace', lineageId: 'lineage-boundary' }))?.content.toString(), 'agent after human\n');
    assert.equal(await count(postgres, 'file_revision_contents', "WHERE lineage_id='lineage-boundary'"), 3);

    // A physical checkpoint of identical content is absorbed without a second content version.
    await turns.begin(identity('turn-auto'));
    await agent('turn-auto', 'automatic.md', 'same content\n', 0, 1);
    assert.equal((await history.capture({ workspace, path: 'automatic.md', content: 'same content\n',
      source: 'automatic_checkpoint' })).outcome, 'deduplicated_checkpoint');
    await turns.finish(identity('turn-auto'), 'completed');
    assert.equal(await count(postgres, 'file_revision_contents', "WHERE lineage_id='lineage-automatic'"), 1);

    // One turn touching two files produces one content version in each lineage.
    await turns.begin(identity('turn-multi'));
    await agent('turn-multi', 'other.md', 'file B\n', 0, 1);
    await agent('turn-multi', 'notes.md', 'file A\n', 4, 5);
    await turns.finish(identity('turn-multi'), 'completed');
    assert.equal(await count(postgres, 'file_revision_contents', "WHERE lineage_id='lineage-other'"), 1);
    assert.equal(await count(postgres, 'file_revision_contents', "WHERE lineage_id='lineage-notes'"), 4);

    // A physical checkpoint for the exact agent Yjs sequence is hidden under
    // its turn version. A later human sequence remains an independent revision.
    await postgres.exec(`INSERT INTO collaboration_documents
      (id,organization_id,workspace_id,workspace_type,path,lineage_id,provider,
        state_version,status,created_at,updated_at)
      VALUES ('document-checkpoint','org','workspace','personal','checkpoint.md',
        'lineage-checkpoint','yjs',0,'active',1,1);
      INSERT INTO collaboration_agent_operations
      (operation_id,document_id,document_path,document_representation,workspace_id,
        organization_id,document_lifecycle_generation,schema_version,initiated_by_user_id,
        actor_id,idempotency_key,payload_hash,status,base_state_vector,operation_type,
        requested_mode,created_at,updated_at)
      VALUES ('operation-link','document-checkpoint','checkpoint.md','plain_text',
        'workspace','org',1,1,'owner','agent','operation-link-key',repeat('a',64),
        'persisted_yjs','\\x00','apply','direct_apply',1,1);`);
    await turns.begin(identity('turn-checkpoint'));
    const checkpointAgent = await agent('turn-checkpoint', 'checkpoint.md', 'agent line\n', 0, 1,
      { agentOperationId: 'operation-link' });
    assert.equal(await turns.hasOperation({ operationId: 'operation-link', turnId: 'turn-checkpoint',
      workspaceId: 'workspace' }), true);
    const physicalContent = 'agent line\r\n';
    await postgres.query(`INSERT INTO file_revisions
      (id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,
        created_by_actor_type,lineage_id,revision_number,created_at)
      VALUES ('checkpoint-physical','org','workspace','personal','checkpoint.md',$1,$2,
        'system','lineage-checkpoint',2,2)`, [hash(physicalContent), Buffer.byteLength(physicalContent)]);
    await turns.linkCheckpoint({ turnId: 'turn-checkpoint', workspaceId: 'workspace',
      operationId: 'operation-link', revisionId: 'checkpoint-physical', documentSequence: 1,
      lifecycleGeneration: 1 });
    assert.equal(await count(postgres, 'file_agent_turn_checkpoints',
      "WHERE revision_id='checkpoint-physical'"), 1);
    await postgres.query(`INSERT INTO file_revisions
      (id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,
        created_by_actor_type,lineage_id,revision_number,created_at)
      VALUES ('checkpoint-human','org','workspace','personal','checkpoint.md',$1,$2,
        'user','lineage-checkpoint',3,3)`, [hash('later human\n'), Buffer.byteLength('later human\n')]);
    await turns.linkCheckpoint({ turnId: 'turn-checkpoint', workspaceId: 'workspace',
      operationId: 'operation-link', revisionId: 'checkpoint-human', documentSequence: 2,
      lifecycleGeneration: 1 });
    assert.equal(await count(postgres, 'file_agent_turn_checkpoints',
      "WHERE revision_id='checkpoint-human'"), 0);
    await turns.finish(identity('turn-checkpoint'), 'completed');
    const checkpointTimeline = await query.timeline({ target: { kind: 'lineage', workspaceId: 'workspace',
      lineageId: 'lineage-checkpoint' }, access, workspace });
    assert.deepEqual(new Set(checkpointTimeline.entries.filter(entry => entry.kind === 'revision')
      .map(entry => entry.revisionId)), new Set(['checkpoint-human', checkpointAgent.revision!.id]));

    // Turn identity is scoped, and a finished turn cannot silently reopen.
    await assert.rejects(turns.begin(identity('turn-one', 'other-session')), /scope mismatch/u);
    await assert.rejects(turns.begin(identity('turn-one')), /cannot be reopened/u);
    await turns.begin(identity('turn-scope'));
    await assert.rejects(turns.stage({ identity: identity('turn-scope'),
      workspace: { ...workspace, workspaceId: 'different-workspace' }, path: 'notes.md',
      revision: initial.revision, content: 'line 1\n', format: 'markdown' }), /scope mismatch/u);
    assert.equal(await count(postgres, 'file_agent_turn_checkpoints', "WHERE lineage_id='lineage-notes'"), 5);

    // A legacy immutable binding remains visible and is never remapped.
    const legacy = await history.capture({ workspace, path: 'legacy.md', content: 'legacy\n',
      source: 'initial', actorUserId: 'owner', actorType: 'user' });
    const attemptedLegacy = await agent('turn-legacy', 'legacy.md', 'legacy\n', 0, 1);
    assert.notEqual(attemptedLegacy.revision?.id, legacy.revision?.id);
    assert.equal(await count(postgres, 'file_agent_turn_checkpoints', "WHERE lineage_id='lineage-legacy'"), 1);
    await turns.finish(identity('turn-legacy'), 'completed');
    assert.equal((await store.readRevisionContent({ revisionId: legacy.revision!.id,
      workspaceId: 'workspace', lineageId: 'lineage-legacy' }))?.binding.source, 'initial');
    const legacyTimeline = await query.timeline({ target: { kind: 'lineage', workspaceId: 'workspace',
      lineageId: 'lineage-legacy' }, access, workspace });
    assert.deepEqual(legacyTimeline.entries.filter(entry => entry.kind === 'revision')
      .map(entry => entry.revisionId), [attemptedLegacy.revision!.id, legacy.revision!.id]);

    // A late recovered agent snapshot is history-only and cannot become the file fence.
    const physical = await history.capture({ workspace, path: 'recovery.md', content: 'current file\n',
      source: 'manual', actorUserId: 'owner', actorType: 'user' });
    const beforeRecoveryFence = await latestPhysical(postgres, 'recovery');
    await turns.begin(identity('turn-recovery'));
    await turns.finish(identity('turn-recovery'), 'interrupted');
    const recovered = await agent('turn-recovery', 'recovery.md', 'older agent state\n', 0, 1,
      { historicalLineageId: 'lineage-recovery', agentRecovered: true, agentCapturedAt: now - 100 });
    assert.equal(recovered.outcome, 'deferred_agent_turn');
    assert.equal((await postgres.query<{ history_only: boolean }>(
      'SELECT history_only FROM file_revisions WHERE id=$1', [recovered.revision!.id])).rows[0]!.history_only, true);
    assert.equal(await latestPhysical(postgres, 'recovery'), beforeRecoveryFence);
    assert.equal(beforeRecoveryFence, physical.revision?.id);
    assert.equal((await query.resolve({ target: { kind: 'lineage', workspaceId: 'workspace',
      lineageId: 'lineage-recovery' }, access })).latestRevisionId, beforeRecoveryFence);
    assert.equal((await store.readRevisionContent({ revisionId: recovered.revision!.id,
      workspaceId: 'workspace', lineageId: 'lineage-recovery' }))?.content.toString(), 'older agent state\n');

    // Heartbeats extend the lease; expiry finalizes only after the last heartbeat.
    await turns.begin(identity('turn-expiry'));
    await agent('turn-expiry', 'corrupt.md', 'lease content\n', 0, 1);
    now += AGENT_TURN_HISTORY_LEASE_MS - 1;
    await turns.touch(identity('turn-expiry'));
    now += 2;
    await turns.recoverExpired();
    assert.equal((await postgres.query<{ outcome: string | null }>(
      "SELECT outcome FROM file_agent_turns WHERE turn_id='turn-expiry'")).rows[0]!.outcome, null);
    now += AGENT_TURN_HISTORY_LEASE_MS;
    await turns.recoverExpired();
    assert.equal((await postgres.query<{ outcome: string | null }>(
      "SELECT outcome FROM file_agent_turns WHERE turn_id='turn-expiry'")).rows[0]!.outcome, 'recovered');
    assert.equal((await pending(postgres, 'corrupt'))[0]!.pending_content, null);

    // Corrupt gzip must roll back finalization, retaining the pending snapshot and turn.
    await turns.begin(identity('turn-corrupt'));
    const corrupt = await agent('turn-corrupt', 'corrupt.md', 'must survive failure\n', 1, 2);
    const rawPending = (await pending(postgres, 'corrupt')).find(row => row.revision_id === corrupt.revision!.id)!;
    const originalBytes = Buffer.from(rawPending.pending_content!);
    await postgres.query('UPDATE file_agent_turn_segments SET pending_content=set_byte(pending_content,0,0) WHERE segment_id=$1',
      [rawPending.segment_id]);
    await assert.rejects(turns.finish(identity('turn-corrupt'), 'completed'), /corrupt|decompress|gzip|version/u);
    assert.equal((await pending(postgres, 'corrupt')).find(row => row.segment_id === rawPending.segment_id)!.finalized_at, null);
    assert.equal((await store.readRevisionContent({ revisionId: corrupt.revision!.id,
      workspaceId: 'workspace', lineageId: 'lineage-corrupt' })), null);
    await postgres.query('UPDATE file_agent_turn_segments SET pending_content=$2 WHERE segment_id=$1',
      [rawPending.segment_id, originalBytes]);
    await turns.finish(identity('turn-corrupt'), 'completed');

    // Admission failure during finalization must keep the turn and pending bytes intact.
    await turns.begin(identity('turn-quota'));
    const quota = await agent('turn-quota', 'quota.md', 'pending quota version\n', 0, 1);
    const filler = prepareFileVersionContent('quota filler content');
    await postgres.query(`INSERT INTO file_version_blobs
      (blob_id,workspace_id,content_sha256,codec,raw_size_bytes,stored_size_bytes,compressed_content,created_at)
      VALUES ('quota-blob','workspace',$1,'gzip',$2,$3,$4,1)`,
    [filler.sha256, filler.rawSizeBytes, filler.storedSizeBytes, filler.compressedContent]);
    await postgres.exec(`INSERT INTO file_revisions
      (id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,
        created_by_actor_type,lineage_id,revision_number,created_at)
      SELECT 'quota-filler-' || n,'org','workspace','personal','quota.md',
        '${filler.sha256}',${filler.rawSizeBytes},'system','lineage-quota',n+1,1
      FROM generate_series(1,500) AS n;
      INSERT INTO file_revision_contents
      (revision_id,workspace_id,lineage_id,blob_id,content_format,source,created_at)
      SELECT 'quota-filler-' || n,'workspace','lineage-quota','quota-blob',
        'markdown','automatic_checkpoint',1 FROM generate_series(1,500) AS n;`);
    await assert.rejects(turns.finish(identity('turn-quota'), 'completed'), /version-count quota|version_count_exceeded|quota/u);
    assert.equal((await pending(postgres, 'quota'))[0]!.finalized_at, null);
    assert.equal((await pending(postgres, 'quota'))[0]!.pending_content !== null, true);
    assert.equal((await store.readRevisionContent({ revisionId: quota.revision!.id,
      workspaceId: 'workspace', lineageId: 'lineage-quota' })), null);
    await postgres.exec(`DELETE FROM file_revision_contents WHERE revision_id='quota-filler-500';
      DELETE FROM file_revisions WHERE id='quota-filler-500';`);
    await turns.finish(identity('turn-quota'), 'completed');
    assert.equal((await pending(postgres, 'quota'))[0]!.pending_content, null);

    // Admission is atomic with history-only revision creation: a full quota
    // must not leave a new raw-latest fence or an unbound timeline ghost.
    const quotaFence = await latestPhysical(postgres, 'quota');
    const quotaRevisions = await count(postgres, 'file_revisions', "WHERE lineage_id='lineage-quota'");
    await turns.begin(identity('turn-stage-quota'));
    await assert.rejects(agent('turn-stage-quota', 'quota.md', 'another version over quota\n', 1, 2),
      /version storage quota|version-count quota|version_count_exceeded|quota/u);
    assert.equal(await latestPhysical(postgres, 'quota'), quotaFence);
    assert.equal(await count(postgres, 'file_revisions', "WHERE lineage_id='lineage-quota'"), quotaRevisions);
    assert.equal(await count(postgres, 'file_agent_turn_segments',
      "WHERE lineage_id='lineage-quota' AND finalized_at IS NULL"), 0);

    // One corrupt expired turn must not starve later turns in the recovery scan.
    await turns.begin(identity('turn-isolation-bad'));
    const bad = await agent('turn-isolation-bad', 'other.md', 'bad recovery snapshot\n', 1, 2);
    const badPending = (await pending(postgres, 'other')).find(row => row.revision_id === bad.revision!.id)!;
    await postgres.query('UPDATE file_agent_turn_segments SET pending_content=set_byte(pending_content,0,0) WHERE segment_id=$1',
      [badPending.segment_id]);
    now += 1;
    await turns.begin(identity('turn-isolation-good'));
    await agent('turn-isolation-good', 'legacy.md', 'good recovery snapshot\n', 0, 1);
    now += AGENT_TURN_HISTORY_LEASE_MS + 1;
    await assert.rejects(turns.recoverExpired(), /Some agent turn histories could not be recovered/u);
    const outcomes = (await postgres.query<{ turn_id: string; outcome: string | null }>(`
      SELECT turn_id,outcome FROM file_agent_turns
      WHERE turn_id IN ('turn-isolation-bad','turn-isolation-good') ORDER BY turn_id`)).rows;
    assert.deepEqual(outcomes, [
      { turn_id: 'turn-isolation-bad', outcome: null },
      { turn_id: 'turn-isolation-good', outcome: 'recovered' },
    ]);

    console.log('agent-turn-history-test: ok');
  } finally {
    await postgres.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
