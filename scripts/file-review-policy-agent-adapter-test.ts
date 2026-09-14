import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import type * as Adapter from '../app/lib/file-version-center/agent-review-policy-adapter';

const workspace = {
  workspaceId: 'workspace-one',
  status: 'active',
  permissions: { canRead: true, canWrite: true, canRunAgent: true },
};

const safePolicy = {
  contractVersion: 1 as const,
  requestedMode: 'safe_direct' as const,
  effectiveMode: 'safe_direct' as const,
  revision: 7,
  locked: false,
  reason: 'user_preference' as const,
};

async function harness() {
  const filename = path.resolve('app/lib/file-version-center/agent-review-policy-adapter.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const controls = {
    lineage: 'lineage-one' as string | null,
    decision: 'safe_direct' as 'safe_direct' | 'review_required',
    throwGrant: false,
  };
  class PolicyError extends Error {}
  const service = {
    readAuthorized: async (input: Record<string, unknown>) => {
      calls.push({ kind: 'read', input });
      return safePolicy;
    },
    resolveForOperation: async (input: Record<string, unknown>) => {
      calls.push({ kind: 'resolve', input });
      return controls.decision === 'safe_direct'
        ? { enforcementMode: 'safe_direct', grant: { id: 'grant-seven', expiresAt: 99_999 }, policy: safePolicy }
        : { enforcementMode: 'review_required', grant: null, policy: { ...safePolicy, effectiveMode: 'review_required' } };
    },
  };
  const adapterModule = {} as typeof Adapter;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db') return {
      openDb: async () => ({
        get: async (sql: string, params: unknown[]) => {
          calls.push({ kind: 'lineage', input: { sql, params } });
          return controls.lineage ? { lineage_id: controls.lineage } : undefined;
        },
        close: async () => {},
      }),
    };
    if (name === '@/app/lib/collaboration/agent-direct-edit-grants') return {
      setAgentDirectEditGrantForOperation: async (input: Record<string, unknown>) => {
        calls.push({ kind: String(input.action), input });
        if (controls.throwGrant && input.action === 'grant') throw new Error('grant unavailable');
        return input.action === 'grant'
          ? { id: 'grant-seven', expiresAt: 99_999, active: true, revokedAt: null }
          : { id: 'grant-seven', expiresAt: 99_999, active: false, revokedAt: 1 };
      },
    };
    if (name === './review-policy-service') return {
      fileReviewPolicyService: service,
      FileReviewPolicyServiceError: PolicyError,
    };
    return load(name);
  }, { exports: adapterModule }, adapterModule);
  return { module: adapterModule, calls, controls };
}

test('the snapshot is scoped to the current user, workspace and active document lineage', async () => {
  const h = await harness();
  const snapshot = await h.module.readAgentReviewPolicySnapshot({
    documentId: 'document-one', workspace: workspace as never, initiatedByUserId: 'user-one',
  });
  assert.equal(snapshot?.lineageId, 'lineage-one');
  assert.deepEqual((h.calls.find((call) => call.kind === 'lineage')?.input.params), [
    'document-one', 'workspace-one',
  ]);
  const access = h.calls.find((call) => call.kind === 'read')?.input.access as Record<string, unknown>;
  assert.deepEqual({
    userId: access.userId,
    authenticatedWorkspaceId: access.authenticatedWorkspaceId,
    requestedWorkspaceId: access.requestedWorkspaceId,
  }, {
    userId: 'user-one', authenticatedWorkspaceId: 'workspace-one', requestedWorkspaceId: 'workspace-one',
  });
  h.controls.lineage = null;
  assert.equal(await h.module.readAgentReviewPolicySnapshot({
    documentId: 'foreign-document', workspace: workspace as never, initiatedByUserId: 'user-one',
  }), null);
});

test('only the new operation receives a revision-bound grant before final policy resolution', async () => {
  const h = await harness();
  const snapshot = (await h.module.readAgentReviewPolicySnapshot({
    documentId: 'document-one', workspace: workspace as never, initiatedByUserId: 'user-one',
  }))!;
  const grantScope = {
    userId: 'user-one', workspaceId: 'workspace-one', agentId: 'agent-one',
    actorSessionId: 'session-one', documentId: 'document-one', lifecycleGeneration: 3,
  };
  const decision = await h.module.authorizeNewAgentDirectApply({
    operationId: 'operation-new', workspace: workspace as never, initiatedByUserId: 'user-one',
    snapshot, grantScope, hardSafetyRequiresReview: false, operationExplicitlyRequiresReview: false,
  });
  assert.deepEqual(decision, {
    enforcementMode: 'safe_direct', grant: { id: 'grant-seven', expiresAt: 99_999 },
  });
  const grant = h.calls.find((call) => call.kind === 'grant')?.input;
  assert.equal(grant?.operationId, 'operation-new');
  assert.equal(grant?.userId, 'user-one');
  assert.equal(grant?.idempotencyKey, 'policy-grant:operation-new:7');
  const operation = (h.calls.find((call) => call.kind === 'resolve')?.input.operation) as Record<string, unknown>;
  assert.equal(operation.operationId, 'operation-new');
  assert.equal(operation.observedPolicyRevision, 7);
  assert.deepEqual(operation.grantScope, grantScope);
});

test('replay, foreign scope, policy race and storage failures all revoke or avoid direct authority', async () => {
  const h = await harness();
  const snapshot = (await h.module.readAgentReviewPolicySnapshot({
    documentId: 'document-one', workspace: workspace as never, initiatedByUserId: 'user-one',
  }))!;
  const input = {
    operationId: 'operation-existing', workspace: workspace as never, initiatedByUserId: 'user-one', snapshot,
    grantScope: {
      userId: 'foreign-user', workspaceId: 'foreign-workspace', agentId: 'agent-one',
      actorSessionId: 'session-one', documentId: 'foreign-document', lifecycleGeneration: 3,
    },
    hardSafetyRequiresReview: false,
    operationExplicitlyRequiresReview: false,
  };
  h.controls.decision = 'review_required';
  assert.deepEqual(await h.module.authorizeNewAgentDirectApply(input), {
    enforcementMode: 'review_required', grant: null,
  });
  assert.equal(h.calls.filter((call) => call.kind === 'revoke').length, 1);

  const hardSafety = await harness();
  const hardSnapshot = (await hardSafety.module.readAgentReviewPolicySnapshot({
    documentId: 'document-one', workspace: workspace as never, initiatedByUserId: 'user-one',
  }))!;
  assert.deepEqual(await hardSafety.module.authorizeNewAgentDirectApply({
    ...input, snapshot: hardSnapshot, hardSafetyRequiresReview: true,
  }), { enforcementMode: 'review_required', grant: null });
  assert.equal(hardSafety.calls.some((call) => call.kind === 'grant'), false);

  const failure = await harness();
  failure.controls.throwGrant = true;
  const failedSnapshot = (await failure.module.readAgentReviewPolicySnapshot({
    documentId: 'document-one', workspace: workspace as never, initiatedByUserId: 'user-one',
  }))!;
  assert.deepEqual(await failure.module.authorizeNewAgentDirectApply({ ...input, snapshot: failedSnapshot }), {
    enforcementMode: 'review_required', grant: null,
  });
  assert.equal(failure.calls.filter((call) => call.kind === 'revoke').length, 1);
});
