import assert from 'node:assert/strict';

import {
  DEFAULT_MEMORY_PROMPT_MAX_TOKENS,
  MEMORY_MAX_ENTRY_CHARS,
  MEMORY_PENDING_ARCHIVE_AFTER_MS,
  MEMORY_RECOMMENDED_ENTRY_CHARS,
  MEMORY_REVIEW_IDLE_FLUSH_MS,
  MEMORY_REVIEW_USER_TURN_INTERVAL,
  MEMORY_PROMPT_HARD_MAX_TOKENS,
  assertCompleteMemoryScopeIdentity,
  canPublishMemorySensitivity,
  canTransitionMemoryReviewJob,
  initialMemoryEntryStatus,
  resolveMemoryPromptTokenBudget,
  resolveMemoryScopePermissions,
} from '../app/lib/memory/contract';

function main() {
  assert.equal(MEMORY_REVIEW_USER_TURN_INTERVAL, 10);
  assert.equal(MEMORY_REVIEW_IDLE_FLUSH_MS, 15 * 60 * 1000);
  assert.equal(MEMORY_PENDING_ARCHIVE_AFTER_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(MEMORY_RECOMMENDED_ENTRY_CHARS, 400);
  assert.equal(MEMORY_MAX_ENTRY_CHARS, 800);
  assert.equal(DEFAULT_MEMORY_PROMPT_MAX_TOKENS, 2_000);

  assert.equal(initialMemoryEntryStatus('user'), 'published');
  assert.equal(initialMemoryEntryStatus('agent'), 'published');
  assert.equal(initialMemoryEntryStatus('workspace'), 'pending');
  assert.equal(initialMemoryEntryStatus('organization'), 'pending');

  assert.deepEqual(resolveMemoryScopePermissions({ scopeType: 'user' }), {
    canReadPublished: true,
    canSuggest: true,
    canPublish: true,
    canUpdatePublished: true,
    canArchive: true,
  });
  assert.deepEqual(resolveMemoryScopePermissions({
    scopeType: 'workspace',
    workspace: { canRead: true, canWrite: true, canManage: false },
  }), {
    canReadPublished: true,
    canSuggest: true,
    canPublish: false,
    canUpdatePublished: false,
    canArchive: false,
  });
  assert.deepEqual(resolveMemoryScopePermissions({
    scopeType: 'workspace',
    workspace: { canRead: true, canWrite: true, canManage: true },
  }), {
    canReadPublished: true,
    canSuggest: true,
    canPublish: true,
    canUpdatePublished: true,
    canArchive: true,
  });
  assert.deepEqual(resolveMemoryScopePermissions({
    scopeType: 'organization',
    organization: { isActiveInternalMember: false, isOwnerOrAdmin: true, canManageOrganizationMemory: true },
  }), {
    canReadPublished: false,
    canSuggest: false,
    canPublish: false,
    canUpdatePublished: false,
    canArchive: false,
  });
  assert.deepEqual(resolveMemoryScopePermissions({
    scopeType: 'organization',
    organization: { isActiveInternalMember: true, isOwnerOrAdmin: false, canManageOrganizationMemory: true },
  }), {
    canReadPublished: true,
    canSuggest: true,
    canPublish: true,
    canUpdatePublished: true,
    canArchive: true,
  });

  assert.equal(resolveMemoryPromptTokenBudget({}), 2_000);
  assert.equal(resolveMemoryPromptTokenBudget({ configuredTokens: 8_000, usableContextTokens: 100_000 }), MEMORY_PROMPT_HARD_MAX_TOKENS);
  assert.equal(resolveMemoryPromptTokenBudget({ configuredTokens: 2_000, usableContextTokens: 10_000 }), 1_000);
  assert.equal(resolveMemoryPromptTokenBudget({ configuredTokens: 2_000, usableContextTokens: 1_000 }), 100);

  assert.equal(canTransitionMemoryReviewJob('scheduled', 'awaiting_model_configuration'), true);
  assert.equal(canTransitionMemoryReviewJob('running', 'retry_wait'), true);
  assert.equal(canTransitionMemoryReviewJob('completed', 'queued'), false);

  assert.equal(canPublishMemorySensitivity({ sensitivity: 'standard', sensitiveMemoryEnabled: false, explicitlyConfirmed: false }), true);
  assert.equal(canPublishMemorySensitivity({ sensitivity: 'sensitive', sensitiveMemoryEnabled: false, explicitlyConfirmed: true }), false);
  assert.equal(canPublishMemorySensitivity({ sensitivity: 'sensitive', sensitiveMemoryEnabled: true, explicitlyConfirmed: false }), false);
  assert.equal(canPublishMemorySensitivity({ sensitivity: 'sensitive', sensitiveMemoryEnabled: true, explicitlyConfirmed: true }), true);

  assert.doesNotThrow(() => assertCompleteMemoryScopeIdentity({
    scopeType: 'organization', userId: 'user_1', organizationId: 'org_1',
  }));
  assert.throws(() => assertCompleteMemoryScopeIdentity({ scopeType: 'workspace', userId: 'user_1' }), /workspace ID/);
  assert.throws(() => assertCompleteMemoryScopeIdentity({ scopeType: 'agent', userId: 'user_1' }), /agent ID/);
  assert.throws(() => assertCompleteMemoryScopeIdentity({ scopeType: 'user' }), /user ID/);

  console.log('memory-contract-test: ok');
}

main();
