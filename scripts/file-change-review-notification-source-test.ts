import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { createFileChangeReviewNotificationSource } from '../app/lib/file-version-center/notification-source';
import { parseFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

const initialNow = Date.UTC(2026, 8, 15, 12, 0, 0);

function database(postgres: PGlite): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
    })),
  };
}

function workspace(input: {
  id?: string;
  canRead?: boolean;
  canWrite?: boolean;
  canManage?: boolean;
  status?: WorkspaceContext['status'];
} = {}): WorkspaceContext {
  return {
    workspaceId: input.id ?? 'workspace-a',
    workspaceType: 'team',
    organizationId: 'org',
    rootPath: '/private/workspace-root',
    displayName: 'Workspace A',
    status: input.status ?? 'active',
    permissions: {
      canRead: input.canRead ?? true,
      canWrite: input.canWrite ?? true,
      canDelete: false,
      canCreatePublicLinks: false,
      canManageWorkspace: input.canManage ?? false,
      canRunAgent: true,
    },
    legacy: false,
  };
}

async function setup(postgres: PGlite): Promise<void> {
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  const oldReview = initialNow - 30 * 24 * 60 * 60 * 1_000;
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES
      ('owner', 'Owner', 'owner@notification.test', 1, 1, 1),
      ('manager', 'Manager', 'manager@notification.test', 1, 1, 1),
      ('other', 'Other', 'other@notification.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('org', 'owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES
      ('workspace-a', 'org', 'team', 'owner', 'workspaces/secret-a', 'A', 'users', 'active', 0, 1, 1),
      ('workspace-b', 'org', 'team', 'other', 'workspaces/secret-b', 'B', 'users', 'active', 0, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, organization_id, workspace_id, workspace_type, path, status, created_at, archived_at
    ) VALUES
      ('lineage-a', 'org', 'workspace-a', 'team', 'private/strategy.md', 'active', 1, NULL),
      ('lineage-archived', 'org', 'workspace-a', 'team', 'private/archived.md', 'archived', 1, 2),
      ('lineage-b', 'org', 'workspace-b', 'team', 'foreign/secret.md', 'active', 1, NULL);
    INSERT INTO collaboration_documents (
      id, organization_id, workspace_id, workspace_type, path, lineage_id,
      provider, state_version, status, created_at, updated_at
    ) VALUES
      ('document-a', 'org', 'workspace-a', 'team', 'private/strategy.md', 'lineage-a', 'yjs', 1, 'active', 1, 1),
      ('document-archived', 'org', 'workspace-a', 'team', 'private/archived.md', 'lineage-archived', 'yjs', 1, 'archived', 1, 2),
      ('document-b', 'org', 'workspace-b', 'team', 'foreign/secret.md', 'lineage-b', 'yjs', 1, 'active', 1, 1);
  `);
  const operations = [
    ['operation-review', 'document-a', 'workspace-a', 'owner', null, 'apply', 'review', 'needs_review', null, oldReview],
    ['operation-conflict', 'document-a', 'workspace-a', 'owner', null, 'apply', 'review', 'semantic_conflict', null, initialNow - 9_000],
    ['operation-partial', 'document-a', 'workspace-a', 'owner', null, 'apply', 'direct_apply', 'partially_applied', null, initialNow - 8_000],
    ['operation-direct-failed', 'document-a', 'workspace-a', 'owner', null, 'apply', 'direct_apply', 'failed', 'apply_failed', initialNow - 7_000],
    ['operation-review-failed', 'document-a', 'workspace-a', 'owner', null, 'apply', 'review', 'failed', 'review_failed', initialNow - 6_000],
    ['operation-revert-failed', 'document-a', 'workspace-a', 'owner', null, 'revert', 'direct_apply', 'failed', 'revert_failed', initialNow - 5_000],
    ['operation-persistence-degraded', 'document-a', 'workspace-a', 'owner', null, 'apply', 'direct_apply', 'partially_applied', 'persistence_degraded', initialNow - 4_000],
    ['operation-success', 'document-a', 'workspace-a', 'owner', null, 'apply', 'direct_apply', 'checkpointed_file', null, initialNow - 3_000],
    ['operation-superseded-original', 'document-a', 'workspace-a', 'owner', null, 'apply', 'direct_apply', 'partially_applied', null, initialNow - 2_000],
    ['operation-superseder', 'document-a', 'workspace-a', 'owner', 'operation-superseded-original', 'revert', 'direct_apply', 'checkpointed_file', null, initialNow - 1_000],
    ['operation-other', 'document-a', 'workspace-a', 'other', null, 'apply', 'review', 'needs_review', null, initialNow - 500],
    ['operation-archived', 'document-archived', 'workspace-a', 'owner', null, 'apply', 'review', 'needs_review', null, initialNow - 400],
    ['operation-foreign', 'document-b', 'workspace-b', 'other', null, 'apply', 'review', 'needs_review', null, initialNow - 300],
  ] as const;
  for (const [operationId, documentId, workspaceId, initiator, supersedes, operationType, requestedMode, status, errorCode, updatedAt] of operations) {
    await postgres.query(`
      INSERT INTO collaboration_agent_operations (
        operation_id, document_id, workspace_id, organization_id,
        initiated_by_user_id, actor_id, supersedes_operation_id, idempotency_key,
        payload_hash, operation_type, requested_mode, status, error_code,
        base_state_vector, created_at, updated_at
      ) VALUES ($1, $2, $3, 'org', $4, 'main', $5, $1 || '-key',
        repeat('a', 64), $6, $7, $8, $9, '\\x00', $10, $10)
    `, [operationId, documentId, workspaceId, initiator, supersedes, operationType,
      requestedMode, status, errorCode, updatedAt]);
  }
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  let clock = initialNow;
  try {
    await setup(postgres);
    const source = createFileChangeReviewNotificationSource({
      database: database(postgres),
      now: () => new Date(clock),
      notificationsEnabled: () => true,
    });
    const ownerWorkspace = workspace();
    const disabledSource = createFileChangeReviewNotificationSource({
      database: database(postgres),
      now: () => new Date(clock),
      notificationsEnabled: () => false,
    });
    assert.deepEqual(await disabledSource.list({ userId: 'owner', workspace: ownerWorkspace }), []);
    assert.equal(await disabledSource.countUnread({ userId: 'owner', workspace: ownerWorkspace }), 0);
    assert.equal((await disabledSource.setItemState({
      userId: 'owner', workspace: ownerWorkspace,
      itemId: 'file-change:operation-review', read: true,
    })).found, false);
    assert.equal((await disabledSource.markAllRead({ userId: 'owner', workspace: ownerWorkspace })).updated, 0);
    const initial = await source.list({ userId: 'owner', workspace: ownerWorkspace });
    assert.deepEqual(initial.map((item) => item.id), [
      'file-change:operation-direct-failed',
      'file-change:operation-partial',
      'file-change:operation-conflict',
      'file-change:operation-review',
    ]);
    assert.equal(initial.every((item) => item.unread), true);
    assert.equal(await source.countUnread({ userId: 'owner', workspace: ownerWorkspace }), 4);
    assert.equal(new Set(initial.map((item) => item.target.operationId)).size, initial.length);
    assert.equal(initial[0]?.type, 'file.change_review_required');
    assert.equal(initial[0]?.fileChangeReason, 'direct_apply_failed');
    assert.deepEqual(Object.keys(initial[0]!.target).sort(), ['kind', 'lineageId', 'operationId', 'workspaceId']);
    const deepLink = new URL(initial[0]!.deepLink, 'https://canvas.test');
    const deepLinkRequest = parseFileVersionCenterDeepLinkV1(deepLink.searchParams);
    assert.deepEqual(deepLinkRequest, {
      contractVersion: 1,
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-direct-failed' },
      initialView: 'reviews',
      source: 'deep_link',
    });
    assert.equal(deepLink.searchParams.get('workspaceId'), 'workspace-a');
    assert.equal(deepLink.searchParams.get('fvrcSource'), null);
    const serialized = JSON.stringify(initial);
    assert.doesNotMatch(serialized, /strategy\.md|archived\.md|secret\.md|workspace-root|documentContent|pathHint|grant|token/u);

    assert.deepEqual(await source.list({ userId: 'owner', workspace: workspace({ canWrite: false }) }), []);
    assert.deepEqual(await source.list({ userId: 'owner', workspace: workspace({ status: 'archived' }) }), []);
    assert.deepEqual(await source.list({ userId: 'owner', workspace: workspace({ id: 'workspace-b' }) }), []);
    const managerItems = await source.list({ userId: 'manager', workspace: workspace({ canManage: true }) });
    assert.equal(managerItems.some((item) => item.target.operationId === 'operation-other'), true);
    assert.equal((await source.setItemState({
      userId: 'owner', workspace: workspace({ id: 'workspace-b' }),
      itemId: 'file-change:operation-review', read: true,
    })).found, false);

    const reviewId = 'file-change:operation-review';
    assert.equal((await source.setItemState({ userId: 'owner', workspace: ownerWorkspace, itemId: reviewId, read: true })).found, true);
    assert.equal((await source.list({ userId: 'owner', workspace: ownerWorkspace })).find((item) => item.id === reviewId)?.unread, false);
    await source.setItemState({ userId: 'owner', workspace: ownerWorkspace, itemId: reviewId, read: false });
    assert.equal((await source.list({ userId: 'owner', workspace: ownerWorkspace })).find((item) => item.id === reviewId)?.unread, true);
    await source.setItemState({ userId: 'owner', workspace: ownerWorkspace, itemId: reviewId, read: true, dismiss: true });
    assert.equal((await source.list({ userId: 'owner', workspace: ownerWorkspace })).some((item) => item.id === reviewId), false);

    clock += 1_000;
    await postgres.query('UPDATE collaboration_agent_operations SET updated_at = $1 WHERE operation_id = $2', [clock, 'operation-review']);
    const reactivated = (await source.list({ userId: 'owner', workspace: ownerWorkspace })).find((item) => item.id === reviewId);
    assert.equal(reactivated?.unread, true);

    const partialId = 'file-change:operation-partial';
    await source.setItemState({
      userId: 'owner', workspace: ownerWorkspace, itemId: partialId, read: true, dismiss: true,
    });
    const markedAll = await source.markAllRead({ userId: 'owner', workspace: ownerWorkspace });
    assert.equal(markedAll.updated, 3);
    assert.equal(
      (await source.list({ userId: 'owner', workspace: ownerWorkspace })).some((item) => item.id === partialId),
      false,
      'mark-all must not revive a currently dismissed review',
    );
    assert.equal(await source.countUnread({ userId: 'owner', workspace: ownerWorkspace }), 0);
    clock += 1_000;
    await postgres.query('UPDATE collaboration_agent_operations SET updated_at = $1 WHERE operation_id = $2', [clock, 'operation-conflict']);
    assert.equal(await source.countUnread({ userId: 'owner', workspace: ownerWorkspace }), 1);

    await postgres.query("UPDATE collaboration_agent_operations SET status = 'rejected', updated_at = $1 WHERE operation_id = 'operation-conflict'", [clock + 1]);
    assert.equal((await source.list({ userId: 'owner', workspace: ownerWorkspace })).some((item) => item.id === 'file-change:operation-conflict'), false);
    assert.equal((await source.setItemState({
      userId: 'owner', workspace: ownerWorkspace,
      itemId: 'file-change:operation-conflict', read: true,
    })).found, false);
    console.log('file-change-review-notification-source-test: ok');
  } finally {
    await postgres.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
