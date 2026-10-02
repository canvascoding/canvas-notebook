import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import { createIsolatedFileVersionTestDatabase, type IsolatedFileVersionTestDatabase } from './helpers/isolated-file-version-test-database';
import { createFileVersionContentStore } from '../app/lib/file-version-center/version-content-store';
import { createFileVersionCenterQueryService } from '../app/lib/file-version-center/query-service';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { FileVersionCenterContractError } from '../app/lib/file-version-center/contracts/v1';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function database(postgres: IsolatedFileVersionTestDatabase): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
    })),
  };
}

function workspace(id = 'workspace-a', canWrite = true): WorkspaceContext {
  return {
    workspaceId: id,
    workspaceType: 'personal',
    organizationId: 'org',
    customerId: null,
    projectId: null,
    rootPath: `/tmp/${id}`,
    displayName: id,
    status: 'active',
    permissions: {
      canRead: true,
      canWrite,
      canDelete: canWrite,
      canCreatePublicLinks: canWrite,
      canManageWorkspace: canWrite,
      canRunAgent: canWrite,
    },
    legacy: false,
  };
}

const access = (workspaceId = 'workspace-a', canWrite = true) => ({
  userId: 'owner',
  authenticatedWorkspaceId: workspaceId,
  requestedWorkspaceId: workspaceId,
  membership: 'active' as const,
  permissionsResolved: true,
  canRead: true,
  canWrite,
  canRunAgent: canWrite,
  canManageWorkspace: canWrite,
});

async function setup(postgres: IsolatedFileVersionTestDatabase): Promise<void> {
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES
      ('owner', 'Owner', 'owner@query.test', 1, 1, 1),
      ('other', 'Other', 'other@query.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('org', 'owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES
      ('workspace-a', 'org', 'personal', 'owner', 'workspaces/a', 'A', 'user-round', 'active', 1, 1, 1),
      ('workspace-b', 'org', 'personal', 'other', 'workspaces/b', 'B', 'user-round', 'active', 0, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, organization_id, workspace_id, workspace_type, path, status, created_at, archived_at
    ) VALUES
      ('lineage-a', 'org', 'workspace-a', 'personal', 'renamed.md', 'active', 1, NULL),
      ('lineage-reused', 'org', 'workspace-a', 'personal', 'old.md', 'active', 60, NULL),
      ('lineage-archived', 'org', 'workspace-a', 'personal', 'old.md', 'archived', 1, 50),
      ('lineage-b', 'org', 'workspace-b', 'personal', 'renamed.md', 'active', 1, NULL);
    INSERT INTO collaboration_documents (
      id, organization_id, workspace_id, workspace_type, path, lineage_id,
      provider, state_version, status, created_at, updated_at
    ) VALUES
      ('document-a', 'org', 'workspace-a', 'personal', 'renamed.md', 'lineage-a', 'yjs', 3, 'active', 1, 30),
      ('document-b', 'org', 'workspace-b', 'personal', 'renamed.md', 'lineage-b', 'yjs', 1, 'active', 1, 10);
    INSERT INTO file_revisions (
      id, organization_id, workspace_id, workspace_type, path, content_hash,
      size_bytes, created_by_user_id, created_by_actor_type, lineage_id,
      revision_number, created_at
    ) VALUES
      ('revision-1', 'org', 'workspace-a', 'personal', 'renamed.md', '${sha256('# One\n')}', 6, 'owner', 'user', 'lineage-a', 1, 10),
      ('revision-2', 'org', 'workspace-a', 'personal', 'renamed.md', '${sha256('# Two\n')}', 6, 'owner', 'agent', 'lineage-a', 2, 20),
      ('revision-3', 'org', 'workspace-a', 'personal', 'renamed.md', '${sha256('# Three\n')}', 8, 'owner', 'user', 'lineage-a', 3, 30);
    INSERT INTO collaboration_agent_operations (
      operation_id, document_id, document_path, document_representation,
      workspace_id, organization_id, document_lifecycle_generation, schema_version,
      initiated_by_user_id, actor_id, idempotency_key, payload_hash, status,
      base_state_vector, operation_type, requested_mode, error_code, created_at, updated_at
    ) VALUES
      ('operation-new', 'document-a', 'renamed.md', 'plain_text', 'workspace-a', 'org', 1, 1,
       'owner', 'agent-new', 'operation-new-key', repeat('a', 64), 'needs_review', '\\x00', 'apply', 'review', NULL, 40, 50),
      ('operation-old', 'document-a', 'renamed.md', 'plain_text', 'workspace-a', 'org', 1, 1,
       'owner', 'agent-old', 'operation-old-key', repeat('b', 64), 'semantic_conflict', '\\x00', 'apply', 'review', NULL, 35, 40),
      ('operation-direct-failed', 'document-a', 'renamed.md', 'plain_text', 'workspace-a', 'org', 1, 1,
       'owner', 'agent-failed', 'operation-direct-failed-key', repeat('c', 64), 'failed', '\\x00', 'apply', 'direct_apply', 'apply_failed', 25, 30);
    INSERT INTO pi_sessions (
      session_id, user_id, agent_id, provider, model, workspace_id,
      workspace_type, created_at, updated_at
    ) VALUES ('session-a', 'owner', 'main', 'test', 'test', 'workspace-a', 'personal', 1, 1);
  `);
  const store = createFileVersionContentStore({ database: database(postgres) });
  await store.bindRevisionContent({ revisionId: 'revision-1', workspaceId: 'workspace-a', lineageId: 'lineage-a',
    content: '# One\n', format: 'markdown', source: 'initial' });
  await store.bindRevisionContent({ revisionId: 'revision-2', workspaceId: 'workspace-a', lineageId: 'lineage-a',
    content: '# Two\n', format: 'markdown', source: 'agent_apply' });
  await store.bindRevisionContent({ revisionId: 'revision-3', workspaceId: 'workspace-a', lineageId: 'lineage-a',
    content: '# Three\n', format: 'markdown', source: 'manual' });
  const session = (await postgres.query<{ id: number }>(`SELECT id FROM pi_sessions WHERE session_id = 'session-a'`)).rows[0]!.id;
  await postgres.query(`
    INSERT INTO file_change_groups (
      group_id, workspace_id, user_id, source_session_id, pi_session_db_id,
      tool_call_id, payload_hash, operation, status, created_at, updated_at
    ) VALUES ('group-a', 'workspace-a', 'owner', 'session-a', $1,
      'tool-call-a', repeat('c', 64), 'edit_file', 'review_required', 40, 40)
  `, [session]);
  await postgres.exec(`
    INSERT INTO file_change_group_entries (
      entry_id, change_group_id, workspace_id, ordinal, lineage_id,
      document_id, operation_id, path_hint, outcome, created_at
    ) VALUES ('entry-a', 'group-a', 'workspace-a', 0, 'lineage-a',
      'document-a', 'operation-new', 'renamed.md', 'review_required', 40)
  `);
}

async function main(): Promise<void> {
  const postgres = await createIsolatedFileVersionTestDatabase();
  try {
    await setup(postgres);
    const service = createFileVersionCenterQueryService({
      database: database(postgres),
      rolloutMode: () => 'full',
      current: async (target) => ({
        fence: {
          revisionId: target.latestRevisionId,
          sha256: target.latestRevisionHash!,
          stateVectorHash: sha256('state-vector'),
        },
        sizeBytes: target.latestRevisionSize,
        observedAt: 60,
      }),
      readPolicy: async () => ({
        contractVersion: 1,
        requestedMode: 'safe_direct',
        effectiveMode: 'safe_direct',
        revision: 0,
        locked: false,
        reason: 'default_safe_direct',
      }),
    });

    assert.equal((await service.resolve({
      target: { kind: 'document', workspaceId: 'workspace-a', documentId: 'document-a' },
      access: access(),
    })).lineageId, 'lineage-a');
    assert.equal((await service.resolve({
      target: { kind: 'change_group', workspaceId: 'workspace-a', changeGroupId: 'group-a', entryId: 'entry-a' },
      access: access(),
    })).documentId, 'document-a');
    assert.equal((await service.resolveOperation({
      operationId: 'operation-new', workspaceId: 'workspace-a', access: access(),
    })).lineageId, 'lineage-a');
    assert.equal((await service.resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
    })).path, 'renamed.md');
    await assert.rejects(service.resolve({
      target: { kind: 'path', workspaceId: 'workspace-a', pathHint: 'old.md' },
      access: access(),
    }), (error: unknown) => error instanceof FileVersionCenterContractError
      && error.code === 'FVRC_NOT_FOUND'
      && /deleted or replaced/u.test(error.message));
    await assert.rejects(service.resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-archived' },
      access: access(),
    }), (error: unknown) => error instanceof FileVersionCenterContractError
      && error.code === 'FVRC_NOT_FOUND'
      && /archived/u.test(error.message));
    await assert.rejects(service.resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-b', lineageId: 'lineage-b' },
      access: access(),
    }), (error: unknown) => error instanceof FileVersionCenterContractError && error.code === 'FVRC_ACCESS_DENIED');

    const first = await service.timeline({
      target: { kind: 'path', workspaceId: 'workspace-a', pathHint: 'renamed.md' },
      access: access(),
      workspace: workspace(),
      limit: 2,
    });
    assert.deepEqual(first.entries.map((entry) => entry.kind === 'agent_operation' ? entry.operationId : entry.kind),
      ['operation-new', 'current'], 'current remains visible before loading additional review pages');
    assert.equal(first.page.hasMore, true);

    const second = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
      workspace: workspace(),
      cursor: first.page.nextCursor!,
      limit: 2,
    });
    assert.deepEqual(second.entries.map((entry) => entry.kind === 'revision' ? entry.revisionId : entry.kind),
      ['agent_operation', 'revision-3']);
    assert.equal(second.entries[0]?.id, 'operation-old');
    assert.equal(second.page.hasMore, true);

    const pinned = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-old' },
      access: access(),
      workspace: workspace(),
      limit: 1,
    });
    assert.deepEqual(pinned.entries.map((entry) => entry.kind === 'agent_operation' ? entry.operationId : entry.kind),
      ['operation-old'], 'the exact requested review is pinned even when the page has no spare slot');

    await postgres.exec("UPDATE collaboration_agent_operations SET operation_type = 'revert' WHERE operation_id = 'operation-old'");
    const pinnedRevertConflict = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-old' },
      access: access(),
      workspace: workspace(),
      limit: 1,
    });
    assert.equal(pinnedRevertConflict.entries[0]?.id, 'operation-old',
      'an overlapping revert conflict remains inspectable instead of becoming a stale selection');
    await postgres.exec("UPDATE collaboration_agent_operations SET operation_type = 'apply' WHERE operation_id = 'operation-old'");

    const afterPinned = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
      workspace: workspace(),
      cursor: pinned.page.nextCursor!,
      limit: 2,
    });
    assert.equal(afterPinned.entries.some((entry) => entry.kind === 'agent_operation' && entry.operationId === 'operation-old'), false,
      'the pinned review is not duplicated on later pages');
    const singleEntryIds = pinned.entries.map((entry) => entry.id);
    let singleCursor = pinned.page.nextCursor;
    while (singleCursor) {
      const page = await service.timeline({
        target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
        access: access(), workspace: workspace(), cursor: singleCursor, limit: 1,
      });
      assert.ok(page.entries.length <= 1);
      singleEntryIds.push(...page.entries.map((entry) => entry.id));
      assert.ok(singleEntryIds.length <= 6, 'one-entry pagination must advance beyond current');
      singleCursor = page.page.hasMore ? page.page.nextCursor : null;
    }
    assert.deepEqual(singleEntryIds, ['operation-old', 'operation-new', 'current', 'revision-3', 'revision-2', 'revision-1']);

    const directApplyFailure = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-direct-failed' },
      access: access(),
      workspace: workspace(),
      limit: 2,
    });
    assert.equal(directApplyFailure.entries[0]?.kind, 'agent_operation');
    assert.equal(directApplyFailure.entries[0]?.id, 'operation-direct-failed');
    assert.equal(directApplyFailure.entries[0]?.kind === 'agent_operation'
      ? directApplyFailure.entries[0].actionsAllowed : true, false,
    'a failed direct application is inspectable but cannot call review mutations');
    await postgres.exec("UPDATE collaboration_agent_operations SET status = 'checkpointed_file' WHERE operation_id = 'operation-direct-failed'");
    await assert.rejects(service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-direct-failed' },
      access: access(),
      workspace: workspace(),
      limit: 2,
    }), (error: unknown) => error instanceof FileVersionCenterContractError
      && error.code === 'FVRC_STALE_SELECTION');

    const exactSelection = async (overrides: {
      lineageId?: string;
      operationId?: string;
      access?: ReturnType<typeof access>;
    } = {}) => service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: overrides.lineageId ?? 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: overrides.operationId ?? 'operation-old' },
      access: overrides.access ?? access(),
      workspace: workspace(),
      limit: 2,
    });
    const staleExactSelection = (promise: Promise<unknown>) => assert.rejects(
      promise,
      (error: unknown) => error instanceof FileVersionCenterContractError
        && error.code === 'FVRC_STALE_SELECTION',
    );
    await staleExactSelection(exactSelection({
      access: { ...access(), userId: 'other', canManageWorkspace: false },
    }));
    await staleExactSelection(exactSelection({ lineageId: 'lineage-reused' }));
    await postgres.exec("UPDATE collaboration_agent_operations SET status = 'partially_applied', error_code = 'persistence_degraded' WHERE operation_id = 'operation-old'");
    await staleExactSelection(exactSelection());
    await postgres.exec("UPDATE collaboration_agent_operations SET status = 'semantic_conflict', error_code = NULL WHERE operation_id = 'operation-old'");
    await postgres.exec("UPDATE collaboration_agent_operations SET operation_type = 'revert', status = 'checkpointed_file', supersedes_operation_id = 'operation-old' WHERE operation_id = 'operation-direct-failed'");
    await staleExactSelection(exactSelection());
    await postgres.exec("UPDATE collaboration_agent_operations SET operation_type = 'apply', requested_mode = 'direct_apply', status = 'failed', error_code = 'apply_failed', supersedes_operation_id = NULL WHERE operation_id = 'operation-direct-failed'");
    await postgres.exec("UPDATE collaboration_documents SET status = 'archived' WHERE id = 'document-a'");
    await staleExactSelection(exactSelection());
    await postgres.exec("UPDATE collaboration_documents SET status = 'active' WHERE id = 'document-a'");

    for (let index = 0; index < 30; index += 1) {
      const id = `operation-page-${String(index).padStart(2, '0')}`;
      await postgres.query(`
        INSERT INTO collaboration_agent_operations (
          operation_id, document_id, document_path, document_representation,
          workspace_id, organization_id, document_lifecycle_generation, schema_version,
          initiated_by_user_id, actor_id, idempotency_key, payload_hash, status,
          base_state_vector, operation_type, requested_mode, created_at, updated_at
        ) VALUES ($1, 'document-a', 'renamed.md', 'plain_text', 'workspace-a', 'org', 1, 1,
          'owner', 'agent-page', $1 || '-key', repeat('d', 64), 'needs_review',
          '\\x00', 'apply', 'review', $2, $2)
      `, [id, 1_000 - index]);
    }
    const pagedOperationIds: string[] = [];
    let currentEntries = 0;
    let pageCursor: string | undefined;
    let pageNumber = 0;
    do {
      const page = await service.timeline({
        target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
        ...(pageNumber === 0 ? { selectedEntry: { kind: 'agent_operation' as const, id: 'operation-old' } } : {}),
        access: access(),
        workspace: workspace(),
        ...(pageCursor ? { cursor: pageCursor } : {}),
        limit: 25,
      });
      assert.ok(page.entries.length <= 25, 'pinning current must not exceed the page envelope');
      const pageCurrent = page.entries.filter((entry) => entry.kind === 'current');
      currentEntries += pageCurrent.length;
      if (pageNumber === 0) assert.equal(pageCurrent.length, 1, 'many pending reviews cannot hide current on another page');
      pagedOperationIds.push(...page.entries.flatMap((entry) => (
        entry.kind === 'agent_operation' ? [entry.operationId] : []
      )));
      pageCursor = page.page.nextCursor ?? undefined;
      pageNumber += 1;
      if (!page.page.hasMore) break;
      assert.ok(pageCursor);
      assert.ok(pageNumber < 10, 'timeline pagination terminates');
    } while (pageCursor);
    assert.deepEqual(pagedOperationIds, [
      'operation-old',
      ...Array.from({ length: 30 }, (_, index) => `operation-page-${String(index).padStart(2, '0')}`),
      'operation-new',
    ], 'pinning an old exact review preserves ordering without loss or duplication across pages');
    assert.equal(new Set(pagedOperationIds).size, pagedOperationIds.length);
    assert.equal(currentEntries, 1, 'the pinned current anchor is not duplicated on continuation pages');

    await postgres.exec(`
      INSERT INTO file_revisions (
        id, organization_id, workspace_id, workspace_type, path, content_hash,
        size_bytes, created_by_actor_type, lineage_id, revision_number, created_at
      ) VALUES ('revision-newer', 'org', 'workspace-a', 'personal', 'renamed.md', repeat('d', 64),
        9, 'user', 'lineage-a', 4, 100)
    `);
    const third = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
      workspace: workspace(),
      cursor: second.page.nextCursor!,
      limit: 2,
    });
    assert.deepEqual(third.entries.map((entry) => entry.kind === 'revision' ? entry.revisionId : entry.kind),
      ['revision-2', 'revision-1']);
    assert.equal(third.page.hasMore, false);

    const readOnly = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access('workspace-a', false),
      workspace: workspace('workspace-a', false),
      limit: 5,
    });
    assert.equal(readOnly.capabilities.history, true);
    assert.equal(readOnly.capabilities.restore, false);
    assert.equal(readOnly.capabilities.reason, 'read_only');
    assert.equal(readOnly.entries.filter((entry) => entry.kind === 'agent_operation')
      .every((entry) => !entry.actionsAllowed), true);
    const foreignReviewer = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: { ...access(), userId: 'other', canManageWorkspace: false },
      workspace: workspace(), limit: 25,
    });
    assert.equal(foreignReviewer.entries.some((entry) => entry.kind === 'agent_operation'), false,
      'a timeline cannot include proposals that its owner-scoped review summary is forbidden to read');
    assert.equal(foreignReviewer.entries.some((entry) => entry.kind === 'current'), true,
      'proposal-level restrictions do not revoke authorized document history');

    const disabledService = createFileVersionCenterQueryService({
      database: database(postgres),
      rolloutMode: () => 'off',
      current: async (target) => ({
        fence: { revisionId: target.latestRevisionId, sha256: target.latestRevisionHash! },
        sizeBytes: target.latestRevisionSize,
        observedAt: 60,
      }),
    });
    const disabled = await disabledService.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-old' },
      access: access(),
      workspace: workspace(),
      limit: 5,
    });
    assert.equal(disabled.capabilities.reason, 'rollout_disabled');
    assert.deepEqual(disabled.entries, [],
      'disabled modes never reveal reviews or revisions through a direct timeline request');
    assert.deepEqual(disabled.page, { hasMore: false, nextCursor: null });

    await assert.rejects(service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
      workspace: workspace(),
      cursor: 'v1.not-json',
    }), (error: unknown) => error instanceof FileVersionCenterContractError && error.code === 'FVRC_INVALID_REQUEST');
    const tamperedCursor = `v1.${Buffer.from(JSON.stringify({
      version: 1, phase: 'reviews', updatedAt: 1, id: 'operation-new', selectedOperationId: '../forged',
    })).toString('base64url')}`;
    await assert.rejects(service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
      workspace: workspace(),
      cursor: tamperedCursor,
    }), (error: unknown) => error instanceof FileVersionCenterContractError && error.code === 'FVRC_INVALID_REQUEST');
    const malformedPinnedCurrent = `v1.${Buffer.from(JSON.stringify({
      version: 1, phase: 'reviews', updatedAt: 1, id: 'operation-new', currentIncluded: 'true',
    })).toString('base64url')}`;
    await assert.rejects(service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(), workspace: workspace(), cursor: malformedPinnedCurrent,
    }), (error: unknown) => error instanceof FileVersionCenterContractError && error.code === 'FVRC_INVALID_REQUEST');
    // Graph completion is authoritative even when the immutable source operation still says needs_review.
    const graphScope = { workspaceId: 'workspace-a', lineageId: 'lineage-a', documentId: 'document-a', lifecycleGeneration: 1, schemaVersion: 1 };
    await postgres.exec(`INSERT INTO file_proposal_graphs (graph_id,workspace_id,lineage_id,document_id,lifecycle_generation,schema_version,created_at,updated_at)
      VALUES ('graph-a','workspace-a','lineage-a','document-a',1,1,1,1)`);
    await postgres.query(`INSERT INTO file_change_proposals (proposal_id,graph_id,operation_id,cas_version,lifecycle,node_json,created_at,updated_at)
      VALUES ('proposal-new','graph-a','operation-new',1,'applied',$1::jsonb,1,1)`, [JSON.stringify({ contractVersion: 1,
      proposalId: 'proposal-new', operationId: 'operation-new', lifecycle: 'applied', casVersion: 1,
      scope: graphScope, source: { scope: graphScope }, relationships: {} })]);
    const completedTimeline = await service.timeline({ target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(), workspace: workspace(), limit: 50 });
    assert.equal(completedTimeline.entries.some(entry => entry.kind === 'agent_operation' && entry.operationId === 'operation-new'), false);
    const completedSelected = await service.timeline({ target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-new' }, access: access(), workspace: workspace(), limit: 1 });
    assert.equal(completedSelected.entries[0]?.id, 'operation-new',
      'an exact historical link remains inspectable after the graph closes');
    assert.equal(completedSelected.entries[0]?.kind === 'agent_operation' ? completedSelected.entries[0].actionsAllowed : true, false,
      'a closed graph proposal is read-only even when the original operation still says needs_review');
    const managerSelected = await service.timeline({ target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-new' },
      access: { ...access(), userId: 'other', canManageWorkspace: true }, workspace: workspace(), limit: 1 });
    assert.equal(managerSelected.entries[0]?.id, 'operation-new');
    assert.equal(managerSelected.entries[0]?.kind === 'agent_operation' ? managerSelected.entries[0].actionsAllowed : true, false);
    const afterCompletedSelected = await service.timeline({ target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(), workspace: workspace(), cursor: completedSelected.page.nextCursor!, limit: 50 });
    assert.equal(afterCompletedSelected.entries.some(entry => entry.kind === 'agent_operation' && entry.operationId === 'operation-new'), false,
      'an explicitly selected closed proposal is not duplicated in active-review pagination');
    await staleExactSelection(exactSelection({ operationId: 'operation-new', access: { ...access(), userId: 'other', canManageWorkspace: false } }));
    await staleExactSelection(exactSelection({ operationId: 'operation-new', lineageId: 'lineage-reused' }));
    await postgres.exec("UPDATE collaboration_agent_operations SET status = 'checkpointed_file' WHERE operation_id = 'operation-new'");
    const terminalSelected = await service.timeline({ target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-new' }, access: access(), workspace: workspace(), limit: 1 });
    assert.equal(terminalSelected.entries[0]?.id, 'operation-new',
      'a closed graph historical link survives a later terminal legacy operation status');
    assert.equal(terminalSelected.entries[0]?.kind === 'agent_operation' ? terminalSelected.entries[0].actionsAllowed : true, false);

    // Display history is proven by checkpoint ownership; it never replaces the
    // physical revision used by compare/restore CAS, even for identical bytes.
    for (const kind of ['standalone', 'turn'] as const) {
      const lineageId = `display-${kind}`;
      const documentId = `document-${kind}`;
      const physicalId = `physical-${kind}`;
      const versionId = `history-${kind}`;
      const content = '# Agent\n';
      const contentHash = sha256(content);
      const vectorHash = sha256(`vector-${kind}`);
      await postgres.query(`INSERT INTO file_collaboration_lineages
        (id,organization_id,workspace_id,workspace_type,path,status,created_at)
        VALUES ($1,'org','workspace-a','personal',$2,'active',1)`, [lineageId, `${kind}.md`]);
      await postgres.query(`INSERT INTO collaboration_documents
        (id,organization_id,workspace_id,workspace_type,path,lineage_id,provider,state_version,status,created_at,updated_at)
        VALUES ($1,'org','workspace-a','personal',$2,$3,'yjs',7,'active',1,60)`,
      [documentId, `${kind}.md`, lineageId]);
      await postgres.query(`INSERT INTO collaboration_yjs_states
        (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
          yjs_state,state_vector,document_sequence,checkpoint_sequence,persisted_at,checkpointed_at,status)
        VALUES ($1,'workspace-a','org',$2,'plain_text',1,1,'\\x00',$3,7,7,60,60,'active')`,
      [documentId, `${kind}.md`, Buffer.from(`vector-${kind}`)]);
      for (const [id, number, historyOnly, createdAt] of [[physicalId, 18, false, 60], [versionId, 19, true, 50]] as const) {
        await postgres.query(`INSERT INTO file_revisions
          (id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,created_by_user_id,
            created_by_actor_type,source_session_id,lineage_id,revision_number,created_at,history_only)
          VALUES ($1,'org','workspace-a','personal',$2,$3,$4,'owner','agent','session-a',$5,$6,$7,$8)`,
        [id, `${kind}.md`, contentHash, Buffer.byteLength(content), lineageId, number, createdAt, historyOnly]);
      }
      await createFileVersionContentStore({ database: database(postgres) }).bindRevisionContent({
        revisionId: versionId, workspaceId: 'workspace-a', lineageId, content,
        format: 'markdown', source: 'agent_apply', stateVectorHash: vectorHash,
      });
      if (kind === 'standalone') {
        await postgres.query(`INSERT INTO collaboration_agent_operations
          (operation_id,document_id,document_path,document_representation,workspace_id,organization_id,
            document_lifecycle_generation,schema_version,initiated_by_user_id,actor_id,actor_session_id,
            idempotency_key,payload_hash,status,base_state_vector,operation_type,requested_mode,
            applied_document_sequence,applied_at,checkpoint_revision_id,version_revision_id,created_at,updated_at)
          VALUES ('display-operation',$1,$2,'plain_text','workspace-a','org',1,1,'owner','agent','session-a',
            'display-operation-key',repeat('a',64),'persisted_yjs','\\x00','apply','direct_apply',7,50,$3,$4,1,60)`,
        [documentId, `${kind}.md`, physicalId, versionId]);
      } else {
        await postgres.exec(`INSERT INTO file_agent_turns
          (turn_id,workspace_id,user_id,source_session_id,outcome,lease_expires_at,created_at,updated_at)
          VALUES ('display-turn','workspace-a','owner','session-a','completed',100,1,60)`);
        await postgres.query(`INSERT INTO file_agent_turn_segments
          (segment_id,turn_id,workspace_id,lineage_id,revision_id,path_hint,content_format,content_sha256,
            raw_size_bytes,stored_size_bytes,pending_content,state_vector_hash,document_sequence,lifecycle_generation,
            finalized_at,created_at,updated_at)
          VALUES ('display-segment','display-turn','workspace-a',$1,$2,$3,'markdown',$4,$5,1,NULL,$6,7,1,60,1,60)`,
        [lineageId, versionId, `${kind}.md`, contentHash, Buffer.byteLength(content), vectorHash]);
        await postgres.query(`INSERT INTO file_agent_turn_checkpoints (revision_id,workspace_id,lineage_id,segment_id)
          VALUES ($1,'workspace-a',$2,'display-segment')`, [physicalId, lineageId]);
      }
      let observedVector = vectorHash;
      let fenceOverride: { revisionId: string | null; sha256: string; sizeBytes: number } | null = null;
      let createHumanDuringRead = false;
      let resolvedBeforeRace: string | null = null;
      const displayService = createFileVersionCenterQueryService({ database: database(postgres),
        rolloutMode: () => 'full',
        readPolicy: async () => ({ contractVersion: 1, requestedMode: 'safe_direct', effectiveMode: 'safe_direct',
          revision: 0, locked: false, reason: 'default_safe_direct' }),
        current: async (target) => {
          if (createHumanDuringRead) {
            createHumanDuringRead = false;
            resolvedBeforeRace = target.latestRevisionId;
            await postgres.query(`INSERT INTO file_revisions
              (id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,created_by_user_id,
                created_by_actor_type,lineage_id,revision_number,created_at)
              VALUES ($1,'org','workspace-a','personal',$2,$3,$4,'owner','user',$5,20,80)`,
            [`human-${kind}`, `${kind}.md`, contentHash, Buffer.byteLength(content), lineageId]);
            fenceOverride = { revisionId: `human-${kind}`, sha256: contentHash, sizeBytes: Buffer.byteLength(content) };
          }
          return { fence: { revisionId: fenceOverride ? fenceOverride.revisionId : target.latestRevisionId,
            sha256: fenceOverride?.sha256 ?? target.latestRevisionHash!, stateVectorHash: observedVector },
          sizeBytes: fenceOverride?.sizeBytes ?? target.latestRevisionSize, observedAt: 70 };
        } });
      const readDisplay = (includeHistoryProvenance = true) => displayService.timeline({
        ...(includeHistoryProvenance ? { includeHistoryProvenance: true } : {}),
        target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId }, access: access(), workspace: workspace() });
      const legacyCurrent = (await readDisplay(false)).entries.find(entry => entry.kind === 'current')!;
      assert.deepEqual(Object.keys(legacyCurrent).sort(), ['id', 'kind', 'observedAt', 'revisionId', 'sha256', 'sizeBytes', 'stateVectorHash'],
        'unnegotiated requests retain the complete old strict-v1 current shape');
      const initial = await readDisplay();
      const current = initial.entries.find(entry => entry.kind === 'current')!;
      assert.equal(current.kind === 'current' ? current.revisionId : null, physicalId);
      assert.equal('displayRevisionId' in current ? current.displayRevisionId : null, versionId,
        `${kind}: exact history owns the displayed version while physical CAS stays unchanged`);
      assert.equal(initial.entries.some(entry => entry.kind === 'revision' && entry.revisionId === physicalId), false);
      fenceOverride = { revisionId: null, sha256: contentHash, sizeBytes: Buffer.byteLength(content) };
      const nullFence = (await readDisplay()).entries.find(entry => entry.kind === 'current')!;
      assert.equal('displayRevisionId' in nullFence ? nullFence.displayRevisionId : null, null,
        'the target projection cannot substitute for a missing authoritative physical fence');
      fenceOverride = { revisionId: `later-unlinked-${kind}`, sha256: contentHash, sizeBytes: Buffer.byteLength(content) };
      const racedFence = (await readDisplay()).entries.find(entry => entry.kind === 'current')!;
      assert.equal(racedFence.kind === 'current' ? racedFence.revisionId : null, `later-unlinked-${kind}`);
      assert.equal('displayRevisionId' in racedFence ? racedFence.displayRevisionId : null, null,
        'an older target projection must not label a later authoritative physical fence with identical bytes');
      fenceOverride = null;
      observedVector = sha256('later-yjs-state');
      const changedState = (await readDisplay()).entries.find(entry => entry.kind === 'current')!;
      assert.equal('displayRevisionId' in changedState ? changedState.displayRevisionId : null, null,
        'identical content with a different Yjs state cannot inherit the agent display identity');
      observedVector = vectorHash;
      if (kind === 'standalone') {
        await postgres.exec("UPDATE collaboration_agent_operations SET checkpoint_revision_id=NULL WHERE operation_id='display-operation'");
      } else {
        await postgres.exec("DELETE FROM file_agent_turn_checkpoints WHERE segment_id='display-segment'");
      }
      const unlinked = (await readDisplay()).entries.find(entry => entry.kind === 'current')!;
      assert.equal('displayRevisionId' in unlinked ? unlinked.displayRevisionId : null, null,
        'equal hash/size without the exact checkpoint relation is insufficient');
      if (kind === 'standalone') {
        await postgres.query("UPDATE collaboration_agent_operations SET checkpoint_revision_id=$1 WHERE operation_id='display-operation'", [physicalId]);
      } else {
        await postgres.query(`INSERT INTO file_agent_turn_checkpoints (revision_id,workspace_id,lineage_id,segment_id)
          VALUES ($1,'workspace-a',$2,'display-segment')`, [physicalId, lineageId]);
      }
      createHumanDuringRead = true;
      const human = (await readDisplay()).entries.find(entry => entry.kind === 'current')!;
      assert.equal(resolvedBeforeRace, physicalId, 'target resolution precedes the actual later human physical receipt');
      assert.equal(human.kind === 'current' ? human.revisionId : null, `human-${kind}`);
      assert.equal('displayRevisionId' in human ? human.displayRevisionId : null, null,
        'a later human physical receipt with the same bytes must not inherit the old agent label');
      assert.deepEqual((await postgres.query<{ id: string; revision_number: number | string }>(
        'SELECT id,revision_number FROM file_revisions WHERE lineage_id=$1 ORDER BY revision_number', [lineageId])).rows
        .map(row => [row.id, Number(row.revision_number)]), [[physicalId, 18], [versionId, 19], [`human-${kind}`, 20]],
      'timeline reads never delete or renumber physical/history receipts');
    }
    console.log('file-version-center-query-test: ok');
  } finally {
    await postgres.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
