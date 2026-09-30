import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import {
  createFileVersionHistoryService,
  type FileVersionHistoryLedger,
} from '../app/lib/file-version-center/history-service';
import { createFileVersionContentStore } from '../app/lib/file-version-center/version-content-store';
import { createFileVersionCenterQueryService } from '../app/lib/file-version-center/query-service';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import type { FileRevisionRecord } from '../app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

const workspace: WorkspaceContext = {
  workspaceId: 'workspace',
  workspaceType: 'personal',
  organizationId: 'org',
  customerId: null,
  projectId: null,
  rootPath: '/tmp/fvrc-history-workspace',
  displayName: 'History',
  status: 'active',
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: true,
    canRunAgent: true,
  },
  legacy: false,
};

function database(postgres: PGlite): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
    })),
  };
}

function checkpointLink(database: FileVersionCenterDatabase) {
  const source = ts.createSourceFile('agent-operations.ts',
    readFileSync('app/lib/collaboration/agent-operations.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'linkStandaloneAgentCheckpoint');
  assert.ok(declaration);
  const javascript = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function('exports', 'createRuntimeFileVersionCenterDatabase',
    `${javascript}\nreturn linkStandaloneAgentCheckpoint;`)({}, () => database) as (input: {
      operationId: string; documentId: string; workspace: WorkspaceContext;
      userId: string; actorSessionId: string; checkpoint: { revisionId: string;
        contentHash: string; sizeBytes: number; documentSequence: number; lifecycleGeneration: number };
    }) => Promise<boolean>;
}

function mapRevision(row: {
  id: string;
  lineage_id: string;
  revision_number: number | string;
  path: string;
  content_hash: string;
  size_bytes: number | string;
  created_by_user_id: string | null;
  created_by_actor_type: FileRevisionRecord['createdByActorType'];
  source_session_id: string | null;
  base_revision_id: string | null;
  created_at: number | string;
}): FileRevisionRecord {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    organizationId: 'org',
    customerId: null,
    projectId: null,
    workspaceId: 'workspace',
    workspaceType: 'personal',
    path: row.path,
    contentHash: row.content_hash,
    sizeBytes: Number(row.size_bytes),
    createdByUserId: row.created_by_user_id,
    createdByActorType: row.created_by_actor_type,
    sourceSessionId: row.source_session_id,
    baseRevisionId: row.base_revision_id,
    createdAt: Number(row.created_at),
  };
}

function ledger(postgres: PGlite): FileVersionHistoryLedger {
  let sequence = 0;
  let queue = Promise.resolve();
  return {
    ensureRevision: (input) => {
      const operation = queue.then(async () => {
        const existing = await postgres.query<Parameters<typeof mapRevision>[0]>(`
          SELECT * FROM file_revisions
          WHERE workspace_id = $1 AND lineage_id = 'lineage'
          ORDER BY revision_number DESC LIMIT 1
        `, [input.workspace.workspaceId]);
        const latest = existing.rows[0];
        if (latest && latest.content_hash === input.contentHash && Number(latest.size_bytes) === input.sizeBytes) {
          return mapRevision(latest);
        }
        const id = `revision-${++sequence}`;
        const inserted = await postgres.query<Parameters<typeof mapRevision>[0]>(`
          INSERT INTO file_revisions (
            id, organization_id, workspace_id, workspace_type, path, content_hash,
            size_bytes, created_by_user_id, created_by_actor_type, source_session_id,
            base_revision_id, lineage_id, revision_number, created_at
          ) VALUES ($1, 'org', 'workspace', 'personal', $2, $3, $4, $5, $6, $7, $8,
            'lineage', COALESCE((SELECT MAX(revision_number) + 1 FROM file_revisions WHERE lineage_id = 'lineage'), 1), $9)
          RETURNING *
        `, [id, input.path, input.contentHash, input.sizeBytes, input.actorUserId ?? null,
          input.actorType ?? 'system', input.sourceSessionId ?? null, input.baseRevisionId ?? null,
          input.nowMs ?? Date.now()]);
        return mapRevision(inserted.rows[0]!);
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

async function setup(postgres: PGlite): Promise<void> {
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@history.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('org', 'owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES ('workspace', 'org', 'personal', 'owner', 'workspaces/history', 'History', 'user-round', 'active', 1, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, organization_id, workspace_id, workspace_type, path, status, created_at
    ) VALUES ('lineage', 'org', 'workspace', 'personal', 'notes.md', 'active', 1);
    INSERT INTO collaboration_documents (
      id, organization_id, workspace_id, workspace_type, path, lineage_id,
      provider, state_version, status, created_at, updated_at
    ) VALUES ('document', 'org', 'workspace', 'personal', 'notes.md', 'lineage', 'yjs', 0, 'active', 1, 1);
  `);
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await setup(postgres);
    const db = database(postgres);
    let now = 100_000;
    const service = createFileVersionHistoryService({
      database: db,
      contentStore: createFileVersionContentStore({ database: db }),
      ledger: ledger(postgres),
      now: () => now,
      captureEnabled: () => true,
    });

    const initial = await service.capture({
      workspace,
      path: 'notes.md',
      content: '',
      source: 'initial',
      actorUserId: 'owner',
      actorType: 'user',
    });
    assert.equal(initial.outcome, 'captured');
    assert.equal(initial.binding?.rawSizeBytes, 0);
    assert.equal(initial.binding?.source, 'initial');
    assert.equal((await service.capture({
      workspace,
      path: 'notes.md',
      content: '',
      source: 'initial',
      actorUserId: 'owner',
      actorType: 'user',
    })).outcome, 'already_captured', 'retrying the initial capture must not create another version');

    const first = await service.capture({
      workspace,
      path: 'notes.md',
      content: '# One\n',
      source: 'automatic_checkpoint',
      stateVector: Buffer.from('vector-one'),
    });
    assert.equal(first.outcome, 'captured');
    assert.equal(first.binding?.source, 'automatic_checkpoint');
    assert.equal(first.binding?.stateVectorHash, createHash('sha256').update('vector-one').digest('hex'));

    now += 1_000;
    const grouped = await service.capture({
      workspace,
      path: 'notes.md',
      content: '# Two\n',
      source: 'automatic_checkpoint',
      stateVector: Buffer.from('vector-two'),
    });
    assert.equal(grouped.outcome, 'deduplicated_checkpoint');

    const [agentOne, agentRetry] = await Promise.all([
      service.capture({
        workspace,
        path: 'notes.md',
        content: '# Agent\n',
        source: 'agent_apply',
        actorUserId: 'owner',
        actorType: 'agent',
        sourceSessionId: 'chat-1',
        stateVector: Buffer.from('agent-vector'),
      }),
      service.capture({
        workspace,
        path: 'notes.md',
        content: '# Agent\n',
        source: 'agent_apply',
        actorUserId: 'owner',
        actorType: 'agent',
        sourceSessionId: 'chat-1',
        stateVector: Buffer.from('agent-vector'),
      }),
    ]);
    assert.deepEqual(new Set([agentOne.outcome, agentRetry.outcome]), new Set(['captured', 'already_captured']));
    assert.equal(agentOne.revision?.id, agentRetry.revision?.id);

    const ydoc = createPlainTextYDoc('# Durable Yjs\n');
    const persisted = await service.capturePersistedCollaboration({
      workspace,
      state: {
        documentId: 'document',
        workspaceId: 'workspace',
        organizationId: 'org',
        path: 'notes.md',
        representation: 'plain_text',
        lifecycleGeneration: 1,
        schemaVersion: 1,
        yjsState: Y.encodeStateAsUpdate(ydoc),
        stateVector: Y.encodeStateVector(ydoc),
        documentSequence: 5,
        persistedAt: now,
        checkpointedAt: null,
        checkpointSequence: 0,
        canonicalHash: null,
        serializedHash: null,
        newlineStyle: 'lf',
        hasBom: false,
        degraded: false,
        status: 'active',
      },
      source: 'agent_apply',
      actorUserId: 'owner',
      actorType: 'agent',
      sourceSessionId: 'chat-2',
    });
    ydoc.destroy();
    assert.equal(persisted.outcome, 'captured');
    assert.deepEqual((await service.capture({
      workspace,
      path: 'image.png',
      content: Buffer.from([1, 2, 3]),
      source: 'external_import',
    })).outcome, 'unsupported');

    const counts = await postgres.query<{ revisions: string; bindings: string; blobs: string }>(`
      SELECT
        (SELECT COUNT(*)::text FROM file_revisions) AS revisions,
        (SELECT COUNT(*)::text FROM file_revision_contents) AS bindings,
        (SELECT COUNT(*)::text FROM file_version_blobs) AS blobs
    `);
    assert.deepEqual(counts.rows[0], { revisions: '4', bindings: '4', blobs: '4' });

    // An MCP operation can be captured after a human has already advanced the
    // physical file. Its exact receipt remains visible without replacing that fence.
    const human = await service.capture({ workspace, path: 'notes.md',
      content: '# Human after MCP\n', source: 'manual', actorUserId: 'owner', actorType: 'user' });
    assert.ok(human.revision?.id);
    const operationInput = { workspace, path: 'notes.md', content: '# Exact MCP operation\n',
      source: 'agent_apply' as const, actorUserId: 'owner', actorType: 'agent' as const,
      sourceSessionId: 'mcp-session', agentOperationId: 'mcp-operation-1',
      historicalLineageId: 'lineage', agentCapturedAt: now - 1 };
    const operation = await service.capture(operationInput);
    assert.equal(operation.outcome, 'captured');
    assert.notEqual(operation.revision?.id, human.revision.id);
    assert.equal((await service.capture(operationInput)).revision?.id, operation.revision?.id);
    assert.equal((await postgres.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM file_revision_contents WHERE revision_id=$1 AND source=$2',
      [operation.revision!.id, 'agent_apply'])).rows[0]?.count, '1');
    assert.equal((await postgres.query<{ history_only: boolean }>(
      'SELECT history_only FROM file_revisions WHERE id=$1', [operation.revision!.id])).rows[0]?.history_only, true);
    assert.equal((await postgres.query<{ id: string }>(`SELECT id FROM file_revisions
      WHERE lineage_id='lineage' AND history_only=false ORDER BY revision_number DESC LIMIT 1`)).rows[0]?.id,
    human.revision.id);
    assert.equal((await createFileVersionContentStore({ database: db }).readRevisionContent({
      revisionId: operation.revision!.id, workspaceId: 'workspace', lineageId: 'lineage',
    }))?.content.toString(), '# Exact MCP operation\n');
    await assert.rejects(service.capture({ ...operationInput, content: '# Changed retry\n' }),
      /belongs to another snapshot/u);

    const operationHash = createHash('sha256').update('# Exact MCP operation\n').digest('hex');
    const humanRawHash = createHash('sha256').update('# Later human checkpoint\n').digest('hex');
    await postgres.query(`INSERT INTO file_revisions
      (id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,
        created_by_actor_type,lineage_id,revision_number,created_at)
      VALUES ('mcp-physical','org','workspace','personal','notes.md',$1,$2,'system','lineage',
        (SELECT MAX(revision_number)+1 FROM file_revisions WHERE lineage_id='lineage'),$3)`,
    [operationHash, Buffer.byteLength('# Exact MCP operation\n'), now + 1]);
    await postgres.query(`INSERT INTO file_revisions
      (id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,
        created_by_actor_type,lineage_id,revision_number,created_at)
      VALUES ('later-human-physical','org','workspace','personal','notes.md',$1,$2,'user','lineage',
        (SELECT MAX(revision_number)+1 FROM file_revisions WHERE lineage_id='lineage'),$3)`,
    [humanRawHash, Buffer.byteLength('# Later human checkpoint\n'), now + 2]);
    await postgres.query(`INSERT INTO collaboration_agent_operations
      (operation_id,document_id,document_path,workspace_id,organization_id,
        initiated_by_user_id,actor_id,actor_session_id,idempotency_key,payload_hash,
        status,base_state_vector,checkpoint_revision_id,version_revision_id,
        applied_at,applied_document_sequence,created_at,updated_at)
      VALUES ('mcp-operation-1','document','notes.md','workspace','org',
        'owner','mcp-actor','mcp-session','mcp-key','mcp-hash',
        'checkpointed_file',$1,'later-human-physical',$2,$3,5,$3,$3)`,
    [Buffer.alloc(0), operation.revision!.id, now]);
    const query = createFileVersionCenterQueryService({ database: db, rolloutMode: () => 'full',
      current: async target => ({ fence: { revisionId: target.latestRevisionId,
        sha256: target.latestRevisionHash! }, sizeBytes: target.latestRevisionSize, observedAt: now }),
      readPolicy: async () => ({ contractVersion: 1, requestedMode: 'safe_direct',
        effectiveMode: 'safe_direct', revision: 0, locked: false, reason: 'default_safe_direct' }),
    });
    const timelineIds = async () => (await query.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace', lineageId: 'lineage' },
      access: { userId: 'owner', authenticatedWorkspaceId: 'workspace', requestedWorkspaceId: 'workspace',
        membership: 'active', permissionsResolved: true, canRead: true, canWrite: true,
        canRunAgent: true, canManageWorkspace: true }, workspace,
    })).entries.filter(entry => entry.kind === 'revision').map(entry => entry.revisionId);
    assert.ok((await timelineIds()).includes('later-human-physical'),
      'a later human checkpoint with another hash must remain visible');
    await postgres.query(`UPDATE collaboration_agent_operations
      SET checkpoint_revision_id=NULL WHERE operation_id='mcp-operation-1'`);
    const link = checkpointLink(db);
    const linkInput = { operationId: 'mcp-operation-1', documentId: 'document', workspace,
      userId: 'owner', actorSessionId: 'mcp-session', checkpoint: {
        revisionId: 'mcp-physical', contentHash: operationHash,
        sizeBytes: Buffer.byteLength('# Exact MCP operation\n'), documentSequence: 5,
        lifecycleGeneration: 1 } };
    assert.equal(await link({ ...linkInput, checkpoint: { ...linkInput.checkpoint,
      revisionId: 'later-human-physical', contentHash: humanRawHash,
      sizeBytes: Buffer.byteLength('# Later human checkpoint\n') } }), false);
    assert.equal(await link(linkInput), true);
    assert.equal(await link(linkInput), true, 'repeating the exact checkpoint link is idempotent');
    assert.equal((await postgres.query<{ checkpoint_revision_id: string }>(
      "SELECT checkpoint_revision_id FROM collaboration_agent_operations WHERE operation_id='mcp-operation-1'"
    )).rows[0]?.checkpoint_revision_id, 'mcp-physical');
    const visibleAfterLink = await timelineIds();
    assert.equal(visibleAfterLink.includes('mcp-physical'), false,
      'the exact unbound MCP physical checkpoint must not duplicate the content version');
    assert.ok(visibleAfterLink.includes('later-human-physical'));
    assert.ok(visibleAfterLink.includes(operation.revision!.id));
    console.log('file-version-history-service-test: ok');
  } finally {
    await postgres.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
