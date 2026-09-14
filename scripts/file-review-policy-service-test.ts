import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { AuditEventInput } from '../app/lib/audit/audit-service';
import type { AgentDirectEditGrantScope } from '../app/lib/collaboration/agent-direct-edit-grants';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import {
  createFileReviewPolicyService,
  FileReviewPolicyServiceError,
  type FileReviewPolicyEvaluation,
} from '../app/lib/file-version-center/review-policy-service';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

function database(postgres: PGlite): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
    })),
  };
}

const ownerAccess = {
  userId: 'owner',
  authenticatedWorkspaceId: 'workspace-a',
  requestedWorkspaceId: 'workspace-a',
  membership: 'active' as const,
  permissionsResolved: true,
  canRead: true,
  canWrite: true,
  canRunAgent: true,
};

const allowChoice: FileReviewPolicyEvaluation = {
  hardSafetyRequiresReview: false,
  workspacePolicy: 'allow_user_choice',
  operationExplicitlyRequiresReview: false,
};

const grantScope: AgentDirectEditGrantScope = {
  userId: 'owner',
  workspaceId: 'workspace-a',
  agentId: 'main',
  actorSessionId: 'session-a',
  documentId: 'document-a',
  lifecycleGeneration: 1,
};

function policyConflict(error: unknown): boolean {
  return error instanceof FileReviewPolicyServiceError && error.code === 'policy_conflict';
}

async function setup(postgres: PGlite): Promise<void> {
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES
      ('owner', 'Owner', 'owner@policy.test', 1, 1, 1),
      ('other', 'Other', 'other@policy.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('org', 'owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES
      ('workspace-a', 'org', 'personal', 'owner', 'workspaces/a', 'A', 'user-round', 'active', 1, 1, 1),
      ('workspace-b', 'org', 'personal', 'other', 'workspaces/b', 'B', 'user-round', 'active', 1, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, workspace_id, workspace_type, path, status, created_at
    ) VALUES
      ('lineage-a', 'workspace-a', 'personal', 'notes.md', 'active', 1),
      ('lineage-b', 'workspace-b', 'personal', 'other.md', 'active', 1);
    INSERT INTO collaboration_documents (
      id, workspace_id, workspace_type, path, lineage_id, provider,
      state_version, status, created_at, updated_at
    ) VALUES ('document-a', 'workspace-a', 'personal', 'notes.md', 'lineage-a', 'yjs', 0, 'active', 1, 1);
    INSERT INTO collaboration_agent_operations (
      operation_id, document_id, workspace_id, initiated_by_user_id, actor_id,
      actor_session_id, idempotency_key, payload_hash, operation_type, status,
      base_state_vector, document_lifecycle_generation, created_at, updated_at
    ) VALUES
      ('operation-a', 'document-a', 'workspace-a', 'owner', 'main', 'session-a', 'op-a',
        repeat('a', 64), 'apply', 'queued', '\\x00', 1, 3001, 3001),
      ('operation-existing', 'document-a', 'workspace-a', 'owner', 'main', 'session-a', 'op-existing',
        repeat('b', 64), 'apply', 'needs_review', '\\x00', 1, 3000, 3000),
      ('operation-foreign', 'document-a', 'workspace-a', 'other', 'main', 'session-a', 'op-foreign',
        repeat('c', 64), 'apply', 'queued', '\\x00', 1, 3002, 3002);
  `);
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await setup(postgres);
    const audits: AuditEventInput[] = [];
    let clock = 1_000;
    let grantState: 'active' | 'expired' | 'revoked' | 'lifecycle_changed' = 'active';
    let grantLookups = 0;
    const service = createFileReviewPolicyService({
      database: database(postgres),
      now: () => clock,
      audit: async (event) => { audits.push(event); },
      resolveDirectEditGrant: async () => {
        grantLookups += 1;
        return grantState === 'active' ? { id: 'grant-a', expiresAt: 99_999 } : null;
      },
    });

    const missing = await service.readAuthorized({ access: ownerAccess, lineageId: 'lineage-a', evaluation: allowChoice });
    assert.deepEqual(
      [missing.requestedMode, missing.effectiveMode, missing.revision, missing.locked, missing.reason],
      ['review_required', 'review_required', 0, false, 'default_review_required'],
    );

    const created = await service.writeAuthorized({
      access: ownerAccess,
      lineageId: 'lineage-a',
      requestedMode: 'safe_direct',
      expectedRevision: 0,
      workspacePolicy: 'allow_user_choice',
    });
    assert.deepEqual(
      [created.requestedMode, created.effectiveMode, created.revision, created.reason],
      ['safe_direct', 'safe_direct', 1, 'user_preference'],
    );
    await assert.rejects(service.writeAuthorized({
      access: ownerAccess,
      lineageId: 'lineage-a',
      requestedMode: 'review_required',
      expectedRevision: 0,
      workspacePolicy: 'allow_user_choice',
    }), policyConflict);

    clock = 2_000;
    const parallel = await Promise.allSettled([
      service.writeAuthorized({ access: ownerAccess, lineageId: 'lineage-a', requestedMode: 'review_required',
        expectedRevision: 1, workspacePolicy: 'allow_user_choice' }),
      service.writeAuthorized({ access: ownerAccess, lineageId: 'lineage-a', requestedMode: 'safe_direct',
        expectedRevision: 1, workspacePolicy: 'allow_user_choice' }),
    ]);
    assert.equal(parallel.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(parallel.filter((result) => result.status === 'rejected' && policyConflict(result.reason)).length, 1);
    const afterParallel = await service.readAuthorized({ access: ownerAccess, lineageId: 'lineage-a', evaluation: allowChoice });
    assert.equal(afterParallel.revision, 2);

    clock = 3_000;
    const safe = await service.writeAuthorized({ access: ownerAccess, lineageId: 'lineage-a', requestedMode: 'safe_direct',
      expectedRevision: 2, workspacePolicy: 'allow_user_choice' });
    assert.equal(safe.revision, 3);
    assert.equal((await service.readAuthorized({ access: ownerAccess, lineageId: 'lineage-a', evaluation: {
      ...allowChoice, workspacePolicy: 'force_review',
    } })).reason, 'workspace_policy');
    assert.equal((await service.readAuthorized({ access: ownerAccess, lineageId: 'lineage-a', evaluation: {
      ...allowChoice, operationExplicitlyRequiresReview: true,
    } })).reason, 'explicit_review');
    assert.equal((await service.readAuthorized({ access: ownerAccess, lineageId: 'lineage-a', evaluation: {
      ...allowChoice, hardSafetyRequiresReview: true,
    } })).reason, 'hard_safety');

    const operation = {
      operationId: 'operation-a',
      observedPolicyRevision: 3,
      grantScope,
    };
    const direct = await service.resolveForOperation({
      access: ownerAccess, lineageId: 'lineage-a', evaluation: allowChoice, operation,
    });
    assert.equal(direct.enforcementMode, 'safe_direct');
    assert.equal(direct.grant?.id, 'grant-a');

    for (const [name, unsafeOperation] of [
      ['existing operation', { ...operation, operationId: 'operation-existing' }],
      ['foreign operation', { ...operation, operationId: 'operation-foreign' }],
      ['stale policy snapshot', { ...operation, observedPolicyRevision: 2 }],
      ['wrong workspace scope', { ...operation, grantScope: { ...grantScope, workspaceId: 'workspace-b' } }],
      ['wrong document', { ...operation, grantScope: { ...grantScope, documentId: 'document-missing' } }],
    ] as const) {
      const before = grantLookups;
      const decision = await service.resolveForOperation({
        access: ownerAccess, lineageId: 'lineage-a', evaluation: allowChoice, operation: unsafeOperation,
      });
      assert.equal(decision.enforcementMode, 'review_required', name);
      assert.equal(decision.policy.reason, 'hard_safety', name);
      assert.equal(grantLookups, before, `${name} must not reach the grant resolver`);
    }

    for (const unavailable of ['expired', 'revoked', 'lifecycle_changed'] as const) {
      grantState = unavailable;
      const decision = await service.resolveForOperation({
        access: ownerAccess, lineageId: 'lineage-a', evaluation: allowChoice, operation,
      });
      assert.equal(decision.policy.effectiveMode, 'safe_direct', unavailable);
      assert.equal(decision.enforcementMode, 'review_required', unavailable);
      assert.equal(decision.grant, null, unavailable);
    }

    const accessLoss = await service.resolveForOperation({
      access: { ...ownerAccess, canWrite: false },
      lineageId: 'lineage-a',
      evaluation: allowChoice,
      operation,
    });
    assert.equal(accessLoss.enforcementMode, 'review_required');
    assert.equal(accessLoss.policy.reason, 'persistence_unavailable');

    const grantFailure = createFileReviewPolicyService({
      database: database(postgres),
      resolveDirectEditGrant: async () => { throw new Error('grant storage unavailable'); },
    });
    const failedGrantDecision = await grantFailure.resolveForOperation({
      access: ownerAccess, lineageId: 'lineage-a', evaluation: allowChoice, operation,
    });
    assert.equal(failedGrantDecision.enforcementMode, 'review_required');
    assert.equal(failedGrantDecision.policy.locked, true);

    const failedDatabase = createFileReviewPolicyService({
      database: { transaction: async () => { throw new Error('policy storage unavailable'); } },
    });
    const failedReadDecision = await failedDatabase.resolveForOperation({
      access: ownerAccess, lineageId: 'lineage-a', evaluation: allowChoice, operation,
    });
    assert.equal(failedReadDecision.enforcementMode, 'review_required');
    assert.equal(failedReadDecision.policy.reason, 'persistence_unavailable');

    await assert.rejects(service.readAuthorized({
      access: { ...ownerAccess, authenticatedWorkspaceId: 'workspace-b', requestedWorkspaceId: 'workspace-b' },
      lineageId: 'lineage-a',
      evaluation: allowChoice,
    }));
    assert.equal(audits.length, 3, 'only successful CAS writes emit audit records');
    const auditJson = JSON.stringify(audits);
    assert.ok(!auditJson.includes('notes.md'));
    assert.ok(!/(documentContent|content|pathHint|absolutePath)/u.test(auditJson));
    console.log('file-review-policy-service-test: ok');
  } finally {
    await postgres.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
