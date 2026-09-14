import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import {
  createFileVersionContentStore,
  decodeFileVersionContent,
  FileVersionContentStoreError,
  prepareFileVersionContent,
  type FileVersionContentDatabase,
  type FileVersionContentStoreLimits,
} from '../app/lib/file-version-center/version-content-store';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

const TEST_LIMITS: FileVersionContentStoreLimits = {
  maxRawVersionBytes: 128,
  maxStoredBlobBytes: 160,
  maxCompressedBytesPerLineage: 60,
  maxCompressedBytesPerWorkspace: 100,
  maxVersionsPerLineage: 3,
};

function database(postgres: PGlite, failBinding = false): FileVersionContentDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: async <Row>(sql: string, params?: unknown[]) => {
        if (failBinding && /^\s*INSERT INTO file_revision_contents/u.test(sql)) {
          throw new Error('simulated binding crash');
        }
        return transaction.query<Row>(sql, params);
      },
    })),
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function setup(postgres: PGlite): Promise<void> {
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@content.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('org', 'owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES ('workspace', 'org', 'personal', 'owner', 'workspaces/a', 'A', 'user-round', 'active', 1, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, workspace_id, workspace_type, path, status, created_at
    ) VALUES
      ('lineage', 'workspace', 'personal', 'notes.md', 'active', 1),
      ('lineage-2', 'workspace', 'personal', 'copy.md', 'active', 1);
  `);
}

async function insertRevision(
  postgres: PGlite,
  id: string,
  lineageId: string,
  content: string,
  number: number,
): Promise<void> {
  await postgres.query(`
    INSERT INTO file_revisions (
      id, workspace_id, workspace_type, path, content_hash, size_bytes,
      created_by_actor_type, lineage_id, revision_number, created_at
    ) VALUES ($1, 'workspace', 'personal', 'notes.md', $2, $3, 'user', $4, $5, $5)
  `, [id, sha256(content), Buffer.byteLength(content), lineageId, number]);
}

function code(expected: string) {
  return (error: unknown) => error instanceof FileVersionContentStoreError && error.code === expected;
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await setup(postgres);
    const store = createFileVersionContentStore({
      database: database(postgres),
      limits: TEST_LIMITS,
      now: () => 10,
      id: (() => { let value = 0; return () => `blob-${++value}`; })(),
    });
    const content = '# Hello\n';
    await insertRevision(postgres, 'revision-1', 'lineage', content, 1);
    await insertRevision(postgres, 'revision-2', 'lineage', content, 2);
    await insertRevision(postgres, 'revision-3', 'lineage-2', content, 1);

    const [first, second] = await Promise.all([
      store.bindRevisionContent({ revisionId: 'revision-1', workspaceId: 'workspace', lineageId: 'lineage',
        content, format: 'markdown', source: 'initial' }),
      store.bindRevisionContent({ revisionId: 'revision-2', workspaceId: 'workspace', lineageId: 'lineage',
        content, format: 'markdown', source: 'initial' }),
    ]);
    assert.equal(first.outcome, 'created');
    assert.equal(second.outcome, 'created');
    assert.equal(first.binding.blobId, second.binding.blobId);
    assert.equal((await postgres.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM file_version_blobs')).rows[0]?.count, '1');
    assert.deepEqual((await store.readRevisionContent({ revisionId: 'revision-1', workspaceId: 'workspace', lineageId: 'lineage' }))?.content, Buffer.from(content));
    assert.equal((await store.bindRevisionContent({ revisionId: 'revision-1', workspaceId: 'workspace', lineageId: 'lineage',
      content, format: 'markdown', source: 'initial' })).outcome, 'already_bound');

    const crossLineage = await store.bindRevisionContent({ revisionId: 'revision-3', workspaceId: 'workspace', lineageId: 'lineage-2',
      content, format: 'markdown', source: 'initial' });
    assert.equal(crossLineage.deduplicated, true);
    assert.equal(crossLineage.binding.blobId, first.binding.blobId);
    const usage = await store.getStorageUsage({ workspaceId: 'workspace', lineageId: 'lineage' });
    assert.equal(usage.lineageVersionCount, 2);
    assert.equal(usage.lineageStoredBytes, first.binding.storedSizeBytes);
    assert.equal(usage.workspaceStoredBytes, first.binding.storedSizeBytes);

    await assert.rejects(
      store.bindRevisionContent({ revisionId: 'revision-1', workspaceId: 'workspace', lineageId: 'lineage',
        content, format: 'text', source: 'initial' }),
      code('revision_already_bound'),
    );
    await assert.rejects(
      async () => prepareFileVersionContent('x'.repeat(129), TEST_LIMITS),
      code('raw_version_too_large'),
    );

    const crashContent = 'crash unique';
    await insertRevision(postgres, 'revision-crash', 'lineage', crashContent, 3);
    const crashing = createFileVersionContentStore({
      database: database(postgres, true), limits: TEST_LIMITS, id: () => 'blob-crash', now: () => 11,
    });
    await assert.rejects(crashing.bindRevisionContent({ revisionId: 'revision-crash', workspaceId: 'workspace', lineageId: 'lineage',
      content: crashContent, format: 'markdown', source: 'manual' }), /simulated binding crash/u);
    assert.equal((await postgres.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM file_version_blobs WHERE blob_id = 'blob-crash'`,
    )).rows[0]?.count, '0');

    const wrongContent = 'wrong hash';
    await insertRevision(postgres, 'revision-wrong', 'lineage', wrongContent, 4);
    await assert.rejects(store.bindRevisionContent({ revisionId: 'revision-wrong', workspaceId: 'workspace', lineageId: 'lineage',
      content: 'not the ledger content', format: 'markdown', source: 'manual' }), code('revision_content_mismatch'));

    const prepared = prepareFileVersionContent('integrity', TEST_LIMITS);
    assert.deepEqual(decodeFileVersionContent({ codec: prepared.codec, content_sha256: prepared.sha256,
      raw_size_bytes: prepared.rawSizeBytes, stored_size_bytes: prepared.storedSizeBytes,
      compressed_content: prepared.compressedContent }, TEST_LIMITS), Buffer.from('integrity'));
    assert.throws(() => decodeFileVersionContent({ codec: 'brotli', content_sha256: prepared.sha256,
      raw_size_bytes: prepared.rawSizeBytes, stored_size_bytes: prepared.storedSizeBytes,
      compressed_content: prepared.compressedContent }, TEST_LIMITS), code('content_corrupt'));
    assert.throws(() => decodeFileVersionContent({ codec: prepared.codec, content_sha256: '0'.repeat(64),
      raw_size_bytes: prepared.rawSizeBytes, stored_size_bytes: prepared.storedSizeBytes,
      compressed_content: prepared.compressedContent }, TEST_LIMITS), code('content_corrupt'));
    assert.throws(() => decodeFileVersionContent({ codec: prepared.codec, content_sha256: prepared.sha256,
      raw_size_bytes: prepared.rawSizeBytes, stored_size_bytes: prepared.storedSizeBytes,
      compressed_content: Buffer.alloc(prepared.storedSizeBytes) }, TEST_LIMITS), code('content_corrupt'));

    const quotaContent = 'quota unique content that compresses';
    await insertRevision(postgres, 'revision-quota', 'lineage-2', quotaContent, 2);
    const tightStore = createFileVersionContentStore({ database: database(postgres),
      limits: { ...TEST_LIMITS, maxCompressedBytesPerWorkspace: usage.workspaceStoredBytes },
    });
    await assert.rejects(tightStore.bindRevisionContent({ revisionId: 'revision-quota', workspaceId: 'workspace', lineageId: 'lineage-2',
      content: quotaContent, format: 'markdown', source: 'manual' }), code('workspace_quota_exceeded'));

    const lineageQuotaStore = createFileVersionContentStore({ database: database(postgres),
      limits: { ...TEST_LIMITS, maxCompressedBytesPerLineage: first.binding.storedSizeBytes },
    });
    await assert.rejects(lineageQuotaStore.bindRevisionContent({ revisionId: 'revision-quota', workspaceId: 'workspace', lineageId: 'lineage-2',
      content: quotaContent, format: 'markdown', source: 'manual' }), code('lineage_quota_exceeded'));

    const thirdSameContent = '# Hello\n';
    await insertRevision(postgres, 'revision-same-3', 'lineage', thirdSameContent, 5);
    await store.bindRevisionContent({ revisionId: 'revision-same-3', workspaceId: 'workspace', lineageId: 'lineage',
      content: thirdSameContent, format: 'markdown', source: 'automatic_checkpoint' });
    await insertRevision(postgres, 'revision-same-4', 'lineage', thirdSameContent, 6);
    await assert.rejects(store.bindRevisionContent({ revisionId: 'revision-same-4', workspaceId: 'workspace', lineageId: 'lineage',
      content: thirdSameContent, format: 'markdown', source: 'automatic_checkpoint' }), code('version_count_exceeded'));
    const retained = await store.pruneAutomaticCheckpointContents({ workspaceId: 'workspace', lineageId: 'lineage',
      revisionIds: ['revision-1', 'revision-same-3'] });
    assert.deepEqual(retained.deletedRevisionIds, ['revision-same-3']);
    assert.equal((await store.readRevisionContent({ revisionId: 'revision-1', workspaceId: 'workspace', lineageId: 'lineage' }))?.binding.source, 'initial');

    await postgres.exec(`INSERT INTO file_version_blobs (
      blob_id, workspace_id, content_sha256, codec, raw_size_bytes, stored_size_bytes, compressed_content, created_at
    ) VALUES ('orphan', 'workspace', '${'f'.repeat(64)}', 'gzip', 1, 1, '\\x00', 1)`);
    assert.equal(await store.deleteUnreferencedBlobs({ workspaceId: 'workspace' }), 1);
    console.log('file-version-content-store-test: ok');
  } finally {
    await postgres.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
