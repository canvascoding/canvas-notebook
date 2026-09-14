import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { FileVersionCenterContractError } from '../app/lib/file-version-center/contracts/v1';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { createFileVersionCenterQueryService } from '../app/lib/file-version-center/query-service';
import {
  setFileCollaborationConnectionFactoryForTests,
} from '../app/lib/files/collaboration-repository';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function database(postgres: PGlite): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
    })),
  };
}

function connectionFor(postgres: PGlite): SqlConnection {
  return {
    get: async (sql, params = []) => (await postgres.query(sql, params)).rows[0],
    run: async (sql, params = []) => {
      const result = await postgres.query(sql, params);
      return { changes: result.affectedRows ?? 0 };
    },
    all: async (sql, params = []) => (await postgres.query(sql, params)).rows,
    close: () => undefined,
  };
}

function workspace(workspaceId: string, ownerUserId: string): WorkspaceContext {
  return {
    workspaceId,
    workspaceType: 'personal',
    organizationId: 'lifecycle-org',
    customerId: null,
    projectId: null,
    ownerUserId,
    rootPath: `/tmp/${workspaceId}`,
    displayName: workspaceId,
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
}

function access(workspaceId: string, userId: string) {
  return {
    userId,
    authenticatedWorkspaceId: workspaceId,
    requestedWorkspaceId: workspaceId,
    membership: 'active' as const,
    permissionsResolved: true,
    canRead: true,
    canWrite: true,
    canRunAgent: true,
    canManageWorkspace: true,
  };
}

async function seedWorkspaceRows(postgres: PGlite): Promise<void> {
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES
      ('owner-a', 'Owner A', 'owner-a@lifecycle.test', 1, 1, 1),
      ('owner-b', 'Owner B', 'owner-b@lifecycle.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('lifecycle-org', 'owner-a', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES
      ('workspace-a', 'lifecycle-org', 'personal', 'owner-a', 'workspaces/a', 'A', 'user-round', 'active', 1, 1, 1),
      ('workspace-b', 'lifecycle-org', 'personal', 'owner-b', 'workspaces/b', 'B', 'user-round', 'active', 0, 1, 1);
  `);
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  const workspaceA = workspace('workspace-a', 'owner-a');
  const workspaceB = workspace('workspace-b', 'owner-b');
  try {
    await runPostgresMigrations(postgres as unknown as PgQueryable);
    await seedWorkspaceRows(postgres);
    setFileCollaborationConnectionFactoryForTests(async () => connectionFor(postgres));
    const {
      archiveFileCollaborationPaths,
      ensureFileRevisionForCurrentContent,
      getFileCollaborationState,
      moveFileCollaborationPath,
      restoreFileCollaborationPath,
    } = await import('../app/lib/files/collaboration-policy');

    const originalRevision = await ensureFileRevisionForCurrentContent({
      workspace: workspaceA,
      path: 'notes.md',
      contentHash: sha256('# Original\n'),
      sizeBytes: 11,
      actorUserId: 'owner-a',
      actorType: 'user',
      nowMs: 10,
    });
    await getFileCollaborationState({ workspace: workspaceA, path: 'notes.md', ensureDocument: true, nowMs: 11 });
    assert.ok(originalRevision.lineageId);

    const service = () => createFileVersionCenterQueryService({ database: database(postgres) });
    assert.equal((await service().resolve({
      target: { kind: 'path', workspaceId: 'workspace-a', pathHint: 'notes.md' },
      access: access('workspace-a', 'owner-a'),
    })).lineageId, originalRevision.lineageId);

    await moveFileCollaborationPath({
      workspace: workspaceA,
      oldPath: 'notes.md',
      newPath: 'Archive/notes.md',
      nowMs: 20,
    });
    assert.equal((await service().resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: originalRevision.lineageId! },
      access: access('workspace-a', 'owner-a'),
    })).path, 'Archive/notes.md', 'a lineage entry follows rename and move to the current path');

    const replacementRevision = await ensureFileRevisionForCurrentContent({
      workspace: workspaceA,
      path: 'notes.md',
      contentHash: sha256('# Replacement\n'),
      sizeBytes: 14,
      actorUserId: 'owner-a',
      actorType: 'user',
      nowMs: 30,
    });
    assert.notEqual(replacementRevision.lineageId, originalRevision.lineageId);
    await assert.rejects(service().resolve({
      target: { kind: 'path', workspaceId: 'workspace-a', pathHint: 'notes.md' },
      access: access('workspace-a', 'owner-a'),
    }), (error: unknown) => error instanceof FileVersionCenterContractError
      && error.code === 'FVRC_NOT_FOUND'
      && /replaced/u.test(error.message),
    'a legacy path entry must not adopt replacement history');

    await archiveFileCollaborationPaths({
      workspace: workspaceA,
      paths: [{ path: 'Archive/notes.md', trashEntryId: 'trash-original' }],
      nowMs: 40,
    });
    await assert.rejects(service().resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: originalRevision.lineageId! },
      access: access('workspace-a', 'owner-a'),
    }), (error: unknown) => error instanceof FileVersionCenterContractError
      && error.code === 'FVRC_NOT_FOUND'
      && /archived/u.test(error.message),
    'trash keeps the identity but reports its archived state');

    await restoreFileCollaborationPath({
      workspace: workspaceA,
      path: 'Archive/notes.md',
      trashEntryId: 'trash-original',
      nowMs: 50,
    });
    assert.equal((await service().resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: originalRevision.lineageId! },
      access: access('workspace-a', 'owner-a'),
    })).path, 'Archive/notes.md');

    const afterRestart = service();
    assert.equal((await afterRestart.resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: originalRevision.lineageId! },
      access: access('workspace-a', 'owner-a'),
    })).path, 'Archive/notes.md', 'a fresh service instance resolves the persisted lineage after restart');

    const otherWorkspaceRevision = await ensureFileRevisionForCurrentContent({
      workspace: workspaceB,
      path: 'Archive/notes.md',
      contentHash: sha256('# Other workspace\n'),
      sizeBytes: 18,
      actorUserId: 'owner-b',
      actorType: 'user',
      nowMs: 60,
    });
    await assert.rejects(afterRestart.resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-b', lineageId: otherWorkspaceRevision.lineageId! },
      access: access('workspace-a', 'owner-a'),
    }), (error: unknown) => error instanceof FileVersionCenterContractError
      && error.code === 'FVRC_ACCESS_DENIED',
    'workspace switches cannot reuse a target from another workspace');
  } finally {
    setFileCollaborationConnectionFactoryForTests(null);
    await postgres.close();
  }

  console.log('file-version-target-lifecycle-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
