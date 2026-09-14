import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import {
  createFileVersionHistoryService,
  type FileVersionHistoryLedger,
} from '../app/lib/file-version-center/history-service';
import { createFileVersionContentStore } from '../app/lib/file-version-center/version-content-store';
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
    assert.deepEqual(counts.rows[0], { revisions: '3', bindings: '3', blobs: '3' });
    console.log('file-version-history-service-test: ok');
  } finally {
    await postgres.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
