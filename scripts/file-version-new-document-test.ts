import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { loadAuthoritativeFileVersionContent } from '../app/lib/file-version-center/authoritative-content';
import { createFileVersionCompareService } from '../app/lib/file-version-center/compare-service';
import { FILE_VERSION_CENTER_CONTRACT_VERSION, FileVersionCenterContractError } from '../app/lib/file-version-center/contracts/v1';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { createFileVersionCenterQueryService, type ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import { createFileVersionContentStore } from '../app/lib/file-version-center/version-content-store';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function database(postgres: PGlite): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
    })),
  };
}

const workspace: WorkspaceContext = {
  workspaceId: 'workspace-a',
  workspaceType: 'personal',
  organizationId: 'org',
  customerId: null,
  projectId: null,
  rootPath: '/tmp/file-version-new-document-test',
  displayName: 'Test',
  status: 'active',
  permissions: {
    canRead: true, canWrite: true, canDelete: true,
    canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true,
  },
  legacy: false,
};

const target: ResolvedFileVersionTarget = {
  workspaceId: workspace.workspaceId,
  lineageId: 'lineage-new',
  documentId: 'document-new',
  path: 'new.md',
  latestRevisionId: 'revision-initial',
  latestRevisionHash: sha256(''),
  latestRevisionSize: 0,
};

async function lifecycle(postgres: PGlite): Promise<string> {
  return (await postgres.query<{ yjs_state_lifecycle: string }>(
    'SELECT yjs_state_lifecycle FROM collaboration_documents WHERE id = $1',
    [target.documentId],
  )).rows[0]!.yjs_state_lifecycle;
}

async function run(): Promise<void> {
  const postgres = new PGlite();
  try {
    await runPostgresMigrations(postgres as unknown as PgQueryable);
    await postgres.exec(`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('owner', 'Owner', 'owner@new-document.test', 1, 1, 1);
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES ('org', 'owner', 'team', 1, 1, 1);
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path,
        display_name, workspace_icon, status, is_default, created_at, updated_at
      ) VALUES ('workspace-a', 'org', 'personal', 'owner', 'workspaces/new', 'New', 'user-round', 'active', 1, 1, 1);
      INSERT INTO file_collaboration_lineages (
        id, organization_id, workspace_id, workspace_type, path, status, created_at
      ) VALUES ('lineage-new', 'org', 'workspace-a', 'personal', 'new.md', 'active', 1);
    `);
    await postgres.query(`
      INSERT INTO collaboration_documents (
        id, workspace_id, workspace_type, path, lineage_id, provider, created_at, updated_at
      ) VALUES ($1, $2, 'personal', $3, $4, 'yjs', 1, 1)
    `, [target.documentId, workspace.workspaceId, target.path, target.lineageId]);
    await postgres.query(`
      INSERT INTO file_revisions (
        id, organization_id, workspace_id, workspace_type, path, content_hash,
        size_bytes, created_by_user_id, created_by_actor_type, lineage_id, revision_number, created_at
      ) VALUES ($1, 'org', $2, 'personal', $3, $4, 0, 'owner', 'user', $5, 1, 1)
    `, [target.latestRevisionId, workspace.workspaceId, target.path, target.latestRevisionHash, target.lineageId]);
    const contentStore = createFileVersionContentStore({ database: database(postgres) });
    await contentStore.bindRevisionContent({
      revisionId: target.latestRevisionId!, workspaceId: workspace.workspaceId,
      lineageId: target.lineageId, content: '', format: 'markdown', source: 'initial',
    });
    assert.equal(await lifecycle(postgres), 'never_initialized');

    let fileReads = 0;
    const options = {
      database: database(postgres),
      loadState: async () => null,
      readWorkspaceFile: async () => {
        fileReads += 1;
        return Buffer.from('');
      },
    };
    const current = await loadAuthoritativeFileVersionContent(target, workspace, options);
    assert.equal(current.content, '');
    assert.deepEqual(current.fence, { revisionId: 'revision-initial', sha256: sha256('') });
    assert.equal(fileReads, 1, 'a never-initialized document can be read before any editor session');

    const access = {
      userId: 'owner', authenticatedWorkspaceId: workspace.workspaceId,
      requestedWorkspaceId: workspace.workspaceId, membership: 'active' as const,
      permissionsResolved: true, canRead: true, canWrite: true,
      canRunAgent: true, canManageWorkspace: true,
    };
    const readCurrent = async (resolved: ResolvedFileVersionTarget, context: WorkspaceContext) =>
      loadAuthoritativeFileVersionContent(resolved, context, options);
    const query = createFileVersionCenterQueryService({
      database: database(postgres), rolloutMode: () => 'full',
      current: async (resolved, context) => {
        const observed = await readCurrent(resolved, context);
        return { fence: observed.fence, sizeBytes: Buffer.byteLength(observed.content), observedAt: observed.observedAt };
      },
      readPolicy: async () => ({
        contractVersion: 1, requestedMode: 'safe_direct', effectiveMode: 'safe_direct',
        revision: 0, locked: false, reason: 'default_safe_direct',
      }),
    });
    const selection = { kind: 'lineage' as const, workspaceId: workspace.workspaceId, lineageId: target.lineageId };
    const timeline = await query.timeline({ target: selection, access, workspace });
    const currentEntry = timeline.entries.find((entry) => entry.kind === 'current');
    assert.equal(currentEntry?.kind, 'current');
    if (currentEntry?.kind !== 'current') throw new Error('Missing current timeline entry.');
    assert.equal(currentEntry.revisionId, target.latestRevisionId);
    const comparison = await createFileVersionCompareService({
      query, contentStore, current: readCurrent, compareEnabled: () => true,
    }).compare({
      request: {
        contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        target: selection,
        candidate: { kind: 'revision', id: target.latestRevisionId! },
        expectedCurrent: { revisionId: currentEntry.revisionId, sha256: currentEntry.sha256 },
      },
      access, workspace,
    });
    assert.equal(comparison.candidate.contentAvailable, true,
      'the initial version compares successfully without opening the editor');
    assert.equal(comparison.summary.additions, 0);
    assert.equal(comparison.summary.deletions, 0);

    const teamWorkspace: WorkspaceContext = {
      ...workspace,
      workspaceId: 'workspace-team',
      workspaceType: 'team',
    };
    const teamTarget: ResolvedFileVersionTarget = {
      ...target,
      workspaceId: teamWorkspace.workspaceId,
      documentId: 'document-team',
      path: 'team.md',
    };
    await postgres.query(`
      INSERT INTO collaboration_documents (
        id, workspace_id, workspace_type, path, provider, created_at, updated_at
      ) VALUES ($1, $2, 'team', $3, 'yjs', 1, 1)
    `, [teamTarget.documentId, teamWorkspace.workspaceId, teamTarget.path]);
    assert.equal((await loadAuthoritativeFileVersionContent(teamTarget, teamWorkspace, options)).content, '',
      'team documents use the same verified pre-editor fallback');
    await assert.rejects(loadAuthoritativeFileVersionContent(teamTarget, workspace, options),
      (error: unknown) => error instanceof FileVersionCenterContractError
        && error.code === 'FVRC_ACCESS_DENIED',
      'a document in another workspace must not be read by path coincidence');
    assert.equal(fileReads, 4);

    await postgres.query(`
      INSERT INTO collaboration_yjs_states (
        document_id, workspace_id, path, representation, yjs_state, state_vector, persisted_at
      ) VALUES ($1, $2, $3, 'plain_text', $4, $4, 1)
    `, [target.documentId, workspace.workspaceId, target.path, Buffer.from([0])]);
    assert.equal(await lifecycle(postgres), 'initialized', 'the first Yjs insert advances the marker');
    const ydoc = createPlainTextYDoc('# After opening\n');
    try {
      const persistedState = {
        documentId: target.documentId!, workspaceId: workspace.workspaceId,
        organizationId: 'org', path: target.path, representation: 'plain_text' as const,
        lifecycleGeneration: 1, schemaVersion: 1,
        yjsState: Y.encodeStateAsUpdate(ydoc), stateVector: Y.encodeStateVector(ydoc),
        documentSequence: 0, persistedAt: 1, checkpointedAt: 1,
        checkpointSequence: 0, canonicalHash: null, serializedHash: null,
        newlineStyle: 'lf' as const, hasBom: false, degraded: false, status: 'active' as const,
      };
      let loadAttempts = 0;
      const afterConcurrentOpen = await loadAuthoritativeFileVersionContent(target, workspace, {
        ...options,
        loadState: async () => (++loadAttempts === 1 ? null : persistedState),
      });
      assert.equal(afterConcurrentOpen.content, '# After opening\n');
      assert.equal(loadAttempts, 2, 'a first-editor race retries the newly persisted state');
      assert.equal(fileReads, 4, 'a first-editor race never reads stale filesystem bytes');
    } finally {
      ydoc.destroy();
    }
    await postgres.query('DELETE FROM collaboration_yjs_states WHERE document_id = $1', [target.documentId]);
    await assert.rejects(loadAuthoritativeFileVersionContent(target, workspace, options),
      (error: unknown) => error instanceof FileVersionCenterContractError
        && error.code === 'FVRC_PERSISTENCE_UNAVAILABLE');
    assert.equal(fileReads, 4, 'lost authoritative state must not silently fall back to disk');

    await postgres.query("UPDATE collaboration_documents SET yjs_state_lifecycle = 'legacy_unknown' WHERE id = $1",
      [target.documentId]);
    await assert.rejects(loadAuthoritativeFileVersionContent(target, workspace, options),
      (error: unknown) => error instanceof FileVersionCenterContractError
        && error.code === 'FVRC_PERSISTENCE_UNAVAILABLE');
    assert.equal(fileReads, 4, 'ambiguous pre-migration documents fail closed');

    // Simulate an existing installation whose table predates the lifecycle
    // column. Its missing state must be classified as unknown, not new.
    await postgres.exec('ALTER TABLE collaboration_documents DROP COLUMN yjs_state_lifecycle CASCADE');
    await runPostgresMigrations(postgres as unknown as PgQueryable);
    assert.equal(await lifecycle(postgres), 'legacy_unknown');
    await postgres.query(`
      INSERT INTO collaboration_documents (
        id, workspace_id, workspace_type, path, provider, created_at, updated_at
      ) VALUES ('document-after-migration', $1, 'personal', 'after.md', 'yjs', 1, 1)
    `, [workspace.workspaceId]);
    assert.equal((await postgres.query<{ yjs_state_lifecycle: string }>(
      "SELECT yjs_state_lifecycle FROM collaboration_documents WHERE id = 'document-after-migration'",
    )).rows[0]?.yjs_state_lifecycle, 'never_initialized');
  } finally {
    await postgres.close();
  }
}

run().then(() => console.log('file-version-new-document-test: ok')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
