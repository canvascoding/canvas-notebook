/**
 * Stable V1 product contract for persisted agent memory.
 *
 * This module intentionally has no database or runtime dependencies. Later
 * services import these rules so scope, publishing and review behavior remain
 * consistent across direct tool calls, automatic reviews and UI actions.
 */

export const MEMORY_SCOPE_TYPES = ['user', 'agent', 'workspace', 'organization'] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export const MEMORY_ENTRY_STATUSES = ['pending', 'published', 'archived'] as const;
export type MemoryEntryStatus = (typeof MEMORY_ENTRY_STATUSES)[number];

export const MEMORY_COLLECTION_STATUSES = ['active', 'archived'] as const;
export type MemoryCollectionStatus = (typeof MEMORY_COLLECTION_STATUSES)[number];

export const MEMORY_SENSITIVITIES = ['standard', 'sensitive'] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

export const MEMORY_REVIEW_TRIGGER_TYPES = ['turn_interval', 'idle', 'session_close', 'maintenance'] as const;
export type MemoryReviewTriggerType = (typeof MEMORY_REVIEW_TRIGGER_TYPES)[number];

export const MEMORY_REVIEW_JOB_STATUSES = [
  'scheduled',
  'awaiting_model_configuration',
  'queued',
  'running',
  'retry_wait',
  'completed',
  'failed',
] as const;
export type MemoryReviewJobStatus = (typeof MEMORY_REVIEW_JOB_STATUSES)[number];

export const MEMORY_REVIEW_JOB_TRANSITIONS: Readonly<Record<MemoryReviewJobStatus, readonly MemoryReviewJobStatus[]>> = {
  scheduled: ['queued', 'awaiting_model_configuration'],
  awaiting_model_configuration: ['queued', 'scheduled'],
  queued: ['running', 'awaiting_model_configuration'],
  running: ['completed', 'retry_wait', 'failed'],
  retry_wait: ['queued', 'awaiting_model_configuration', 'failed'],
  completed: [],
  failed: ['queued'],
};

export const MEMORY_REVIEW_USER_TURN_INTERVAL = 10;
export const MEMORY_REVIEW_IDLE_FLUSH_MS = 15 * 60 * 1000;
export const MEMORY_PENDING_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const MEMORY_RECOMMENDED_ENTRY_CHARS = 400;
export const MEMORY_MAX_ENTRY_CHARS = 800;
export const DEFAULT_MEMORY_PROMPT_MAX_TOKENS = 2_000;
export const MEMORY_PROMPT_MAX_CONTEXT_SHARE = 0.1;
export const MEMORY_PROMPT_HARD_MAX_TOKENS = 4_000;

export type MemoryScopeIdentity = {
  scopeType: MemoryScopeType;
  userId?: string | null;
  agentId?: string | null;
  workspaceId?: string | null;
  organizationId?: string | null;
};

export type MemoryScopePermissions = {
  canReadPublished: boolean;
  canSuggest: boolean;
  canPublish: boolean;
  canUpdatePublished: boolean;
  canArchive: boolean;
};

export type ResolveMemoryScopePermissionsInput = {
  scopeType: MemoryScopeType;
  workspace?: {
    canRead: boolean;
    canWrite: boolean;
    canManage: boolean;
  };
  organization?: {
    isActiveInternalMember: boolean;
    isOwnerOrAdmin: boolean;
    canManageOrganizationMemory: boolean;
  };
};

const NO_MEMORY_SCOPE_PERMISSIONS: MemoryScopePermissions = {
  canReadPublished: false,
  canSuggest: false,
  canPublish: false,
  canUpdatePublished: false,
  canArchive: false,
};

const PRIVATE_MEMORY_SCOPE_PERMISSIONS: MemoryScopePermissions = {
  canReadPublished: true,
  canSuggest: true,
  canPublish: true,
  canUpdatePublished: true,
  canArchive: true,
};

/** Resolves the V1 capability matrix; the service still verifies ownership. */
export function resolveMemoryScopePermissions(
  input: ResolveMemoryScopePermissionsInput,
): MemoryScopePermissions {
  if (input.scopeType === 'user' || input.scopeType === 'agent') {
    return PRIVATE_MEMORY_SCOPE_PERMISSIONS;
  }

  if (input.scopeType === 'workspace') {
    const workspace = input.workspace;
    if (!workspace) return NO_MEMORY_SCOPE_PERMISSIONS;
    return {
      canReadPublished: workspace.canRead,
      canSuggest: workspace.canWrite,
      canPublish: workspace.canManage,
      canUpdatePublished: workspace.canManage,
      canArchive: workspace.canManage,
    };
  }

  const organization = input.organization;
  if (!organization?.isActiveInternalMember) return NO_MEMORY_SCOPE_PERMISSIONS;
  const canManage = organization.isOwnerOrAdmin || organization.canManageOrganizationMemory;
  return {
    canReadPublished: true,
    canSuggest: true,
    canPublish: canManage,
    canUpdatePublished: canManage,
    canArchive: canManage,
  };
}

/** Private memory publishes immediately; shared memory is always a proposal in V1. */
export function initialMemoryEntryStatus(scopeType: MemoryScopeType): MemoryEntryStatus {
  return scopeType === 'workspace' || scopeType === 'organization' ? 'pending' : 'published';
}

export function canTransitionMemoryReviewJob(
  from: MemoryReviewJobStatus,
  to: MemoryReviewJobStatus,
): boolean {
  return MEMORY_REVIEW_JOB_TRANSITIONS[from].includes(to);
}

/**
 * The effective budget may never exceed the configured limit, 10% of usable
 * context, or the absolute V1 ceiling. A missing context limit leaves only the
 * configured and absolute limits in force.
 */
export function resolveMemoryPromptTokenBudget(params: {
  configuredTokens?: number | null;
  usableContextTokens?: number | null;
}): number {
  const configured = Number.isFinite(params.configuredTokens)
    ? Math.max(0, Math.floor(params.configuredTokens as number))
    : DEFAULT_MEMORY_PROMPT_MAX_TOKENS;
  const contextCap = Number.isFinite(params.usableContextTokens)
    ? Math.max(0, Math.floor((params.usableContextTokens as number) * MEMORY_PROMPT_MAX_CONTEXT_SHARE))
    : MEMORY_PROMPT_HARD_MAX_TOKENS;
  return Math.min(configured, contextCap, MEMORY_PROMPT_HARD_MAX_TOKENS);
}

/** Validates server-derived scope IDs before any persistence operation. */
export function assertCompleteMemoryScopeIdentity(identity: MemoryScopeIdentity): void {
  if (!identity.userId?.trim()) {
    throw new Error('Memory scope requires a user ID from the execution context.');
  }
  if (identity.scopeType === 'agent' && !identity.agentId?.trim()) {
    throw new Error('Agent memory scope requires an agent ID from the execution context.');
  }
  if (identity.scopeType === 'workspace' && !identity.workspaceId?.trim()) {
    throw new Error('Workspace memory scope requires a workspace ID from the execution context.');
  }
  if (identity.scopeType === 'organization' && !identity.organizationId?.trim()) {
    throw new Error('Organization memory scope requires an organization ID from the execution context.');
  }
}

/** Sensitive entries need the owner's global opt-in and confirmation to publish. */
export function canPublishMemorySensitivity(params: {
  sensitivity: MemorySensitivity;
  sensitiveMemoryEnabled: boolean;
  explicitlyConfirmed: boolean;
}): boolean {
  return params.sensitivity === 'standard'
    || (params.sensitiveMemoryEnabled && params.explicitlyConfirmed);
}
