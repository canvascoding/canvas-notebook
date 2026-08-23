import 'server-only';

import { randomUUID } from 'node:crypto';

import { getDatabaseProvider, openDb } from '@/app/lib/db';
import type {
  AiModelReference,
  AiRuntimeSelection,
  AiRuntimeExecutionMode,
  AiRuntimeSelectionSource,
  AiSessionRuntimeSnapshot,
  AiUserWorkspaceProviderGrant,
  AiUserModelPreference,
  AiWorkspaceModelPolicy,
} from '@/app/lib/agent-runtime-policy/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

const THINKING_LEVELS = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SELECTION_SOURCES = new Set<AiRuntimeSelectionSource>([
  'session',
  'user_preference',
  'agent_default',
  'workspace_default',
  'app_default',
]);
const EXECUTION_MODES = new Set<AiRuntimeExecutionMode>([
  'interactive',
  'external_channel',
  'delegation',
  'personal_automation',
  'organization_automation',
]);

type WorkspacePolicyRow = {
  organization_id: string;
  workspace_id: string;
  allowed_models_json: string | null;
  default_provider_installation_id: string | null;
  default_provider_id: string | null;
  default_model_id: string | null;
  default_thinking_level: string | null;
  allow_user_credentials: number | string | boolean;
  revision: number | string;
  updated_by_user_id: string | null;
  updated_at: number | string;
};

type UserPreferenceRow = {
  organization_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  provider_installation_id: string;
  provider_id: string;
  model_id: string;
  thinking_level: string;
  revision: number | string;
  updated_at: number | string;
};

type UserWorkspaceProviderGrantRow = {
  id: string;
  organization_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  provider_installation_id: string;
  allowed_execution_modes_json: string;
  status: string;
  revision: number | string;
  granted_at: number | string;
  revoked_at: number | string | null;
  updated_at: number | string;
};

type SessionRuntimeRow = {
  id: number | string;
  provider: string;
  model: string;
  thinking_level: string | null;
  runtime_provider_installation_id: string | null;
  runtime_catalog_revision: number | string | null;
  runtime_policy_revision: number | string | null;
  runtime_selection_source: string | null;
};

export class RuntimeRevisionConflictError extends Error {
  readonly code = 'RUNTIME_REVISION_CONFLICT';
  readonly status = 409;

  constructor(
    public readonly entity: 'workspace_policy' | 'user_preference' | 'user_provider_grant',
    public readonly currentRevision: number,
  ) {
    super(`${entity} revision conflict. Current revision is ${currentRevision}.`);
    this.name = 'RuntimeRevisionConflictError';
  }
}

export class RuntimeContextRevisionConflictError extends Error {
  readonly code = 'RUNTIME_CONTEXT_REVISION_CONFLICT';
  readonly status = 409;

  constructor(
    public readonly currentCatalogRevision: number,
    public readonly currentPolicyRevision: number,
  ) {
    super('The app catalog or workspace policy changed. Reload the available models and try again.');
    this.name = 'RuntimeContextRevisionConflictError';
  }
}

export class SessionRuntimeSnapshotConflictError extends Error {
  readonly code = 'SESSION_RUNTIME_SNAPSHOT_EXISTS';
  readonly status = 409;

  constructor(message = 'The session runtime changed concurrently. Reload it and try again.') {
    super(message);
    this.name = 'SessionRuntimeSnapshotConflictError';
  }
}

export class SessionRuntimeContextRevisionConflictError extends Error {
  readonly code = 'RUNTIME_CONTEXT_REVISION_CONFLICT';
  readonly status = 409;

  constructor(
    public readonly currentCatalogRevision: number,
    public readonly currentPolicyRevision: number,
  ) {
    super('The app catalog or workspace policy changed. Reload the available models and try again.');
    this.name = 'SessionRuntimeContextRevisionConflictError';
  }
}

export class RuntimeStoredDataError extends Error {
  readonly status = 409;

  constructor(
    public readonly code: 'RUNTIME_POLICY_CORRUPT' | 'RUNTIME_PREFERENCE_CORRUPT' | 'SESSION_RUNTIME_SNAPSHOT_CORRUPT',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeStoredDataError';
  }
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function changedRows(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const result = value as { changes?: unknown; rowCount?: unknown };
  return numberValue(result.changes ?? result.rowCount, 0);
}

type RuntimeStoreConnection = Awaited<ReturnType<typeof openDb>>;

/**
 * Locks the durable workspace context before reading catalog/policy revisions.
 * The workspace row prevents a missing policy row from becoming a Postgres
 * phantom insert; the catalog row serializes against catalog replacements.
 * SQLite obtains the equivalent database write lock with BEGIN IMMEDIATE.
 */
async function lockWorkspaceRuntimeContext(
  connection: RuntimeStoreConnection,
  input: {
    organizationId: string;
    workspaceId: string;
  },
): Promise<void> {
  const forUpdate = getDatabaseProvider() === 'postgres' ? ' FOR UPDATE' : '';
  const workspace = await connection.get(
    `SELECT id
     FROM canvas_workspaces
     WHERE organization_id = ? AND id = ?
     LIMIT 1${forUpdate}`,
    [input.organizationId, input.workspaceId],
  ) as { id?: string } | undefined;
  if (!workspace?.id) {
    throw new Error('Workspace runtime context not found.');
  }
}

async function lockAndReadRuntimeContext(
  connection: RuntimeStoreConnection,
  input: {
    organizationId: string;
    workspaceId: string;
  },
): Promise<{ catalogRevision: number; policyRevision: number }> {
  const forUpdate = getDatabaseProvider() === 'postgres' ? ' FOR UPDATE' : '';
  await lockWorkspaceRuntimeContext(connection, input);

  const catalogRow = await connection.get(
    `SELECT catalog_revision AS revision
     FROM ai_runtime_defaults
     WHERE organization_id = ?
     LIMIT 1${forUpdate}`,
    [input.organizationId],
  ) as { revision?: number | string | null } | undefined;
  const policyRow = await connection.get(
    `SELECT revision
     FROM ai_workspace_model_policies
     WHERE organization_id = ? AND workspace_id = ?
     LIMIT 1${forUpdate}`,
    [input.organizationId, input.workspaceId],
  ) as { revision?: number | string | null } | undefined;
  return {
    catalogRevision: numberValue(catalogRow?.revision, 0),
    policyRevision: numberValue(policyRow?.revision, 0),
  };
}

function assertRuntimeContextRevisions(
  current: { catalogRevision: number; policyRevision: number },
  expected: { expectedCatalogRevision: number; expectedPolicyRevision: number },
): void {
  if (
    current.catalogRevision !== expected.expectedCatalogRevision
    || current.policyRevision !== expected.expectedPolicyRevision
  ) {
    throw new RuntimeContextRevisionConflictError(
      current.catalogRevision,
      current.policyRevision,
    );
  }
}

function isoTimestamp(value: unknown): string {
  return new Date(numberValue(value, Date.now())).toISOString();
}

function parseGrantModes(value: string): AiRuntimeExecutionMode[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('invalid modes');
    const modes = Array.from(new Set(parsed.filter((mode): mode is AiRuntimeExecutionMode => (
      typeof mode === 'string' && EXECUTION_MODES.has(mode as AiRuntimeExecutionMode)
    ))));
    if (modes.length !== parsed.length || modes.includes('organization_automation')) {
      throw new Error('invalid modes');
    }
    return modes;
  } catch {
    throw new RuntimeStoredDataError(
      'RUNTIME_PREFERENCE_CORRUPT',
      'Stored user provider credential grant is invalid.',
    );
  }
}

function grantFromRow(row: UserWorkspaceProviderGrantRow): AiUserWorkspaceProviderGrant {
  if (row.status !== 'active' && row.status !== 'revoked') {
    throw new RuntimeStoredDataError('RUNTIME_PREFERENCE_CORRUPT', 'Stored user provider grant status is invalid.');
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    providerInstallationId: row.provider_installation_id,
    allowedExecutionModes: parseGrantModes(row.allowed_execution_modes_json),
    status: row.status,
    revision: numberValue(row.revision, 0),
    grantedAt: isoTimestamp(row.granted_at),
    revokedAt: row.revoked_at === null ? null : isoTimestamp(row.revoked_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function storedThinkingLevel(
  value: unknown,
  code: RuntimeStoredDataError['code'],
): PiThinkingLevel {
  if (typeof value === 'string' && THINKING_LEVELS.has(value as PiThinkingLevel)) {
    return value as PiThinkingLevel;
  }
  throw new RuntimeStoredDataError(code, 'Stored AI runtime intelligence value is invalid.');
}

function selectionFromParts(parts: {
  providerInstallationId: string | null;
  providerId: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
}): AiRuntimeSelection | null {
  const values = [parts.providerInstallationId, parts.providerId, parts.modelId, parts.thinkingLevel];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) {
    throw new RuntimeStoredDataError('RUNTIME_POLICY_CORRUPT', 'Stored workspace default is incomplete.');
  }
  return {
    providerInstallationId: parts.providerInstallationId!,
    providerId: parts.providerId!,
    modelId: parts.modelId!,
    thinkingLevel: storedThinkingLevel(parts.thinkingLevel, 'RUNTIME_POLICY_CORRUPT'),
  };
}

function parseAllowedModels(value: string | null): AiModelReference[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || (parsed as { version?: unknown }).version !== 1
      || !Array.isArray((parsed as { models?: unknown }).models)
    ) {
      throw new RuntimeStoredDataError('RUNTIME_POLICY_CORRUPT', 'Stored workspace model allowlist is invalid.');
    }
    const references: AiModelReference[] = [];
    const seen = new Set<string>();
    for (const item of (parsed as { models: unknown[] }).models) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new RuntimeStoredDataError('RUNTIME_POLICY_CORRUPT', 'Stored workspace model reference is invalid.');
      }
      const record = item as Record<string, unknown>;
      const providerInstallationId = typeof record.providerInstallationId === 'string'
        ? record.providerInstallationId.trim()
        : '';
      const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
      const key = `${providerInstallationId}\0${modelId}`;
      if (!providerInstallationId || !modelId) {
        throw new RuntimeStoredDataError('RUNTIME_POLICY_CORRUPT', 'Stored workspace model reference is incomplete.');
      }
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ providerInstallationId, modelId });
    }
    return references;
  } catch (error) {
    if (error instanceof RuntimeStoredDataError) throw error;
    throw new RuntimeStoredDataError('RUNTIME_POLICY_CORRUPT', 'Stored workspace model allowlist is invalid.');
  }
}

function serializeAllowedModels(value: AiModelReference[] | null): string | null {
  if (value === null) return null;
  const models = Array.from(new Map(value.map((reference) => ([
    `${reference.providerInstallationId}\0${reference.modelId}`,
    reference,
  ]))).values()).sort((left, right) => (
    left.providerInstallationId.localeCompare(right.providerInstallationId)
    || left.modelId.localeCompare(right.modelId)
  ));
  return JSON.stringify({ version: 1, models });
}

function policyFromRow(row: WorkspacePolicyRow): AiWorkspaceModelPolicy {
  return {
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    allowedModels: parseAllowedModels(row.allowed_models_json),
    defaultSelection: selectionFromParts({
      providerInstallationId: row.default_provider_installation_id,
      providerId: row.default_provider_id,
      modelId: row.default_model_id,
      thinkingLevel: row.default_thinking_level,
    }),
    allowUserCredentials: booleanValue(row.allow_user_credentials),
    revision: numberValue(row.revision, 0),
    updatedByUserId: row.updated_by_user_id,
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function preferenceFromRow(row: UserPreferenceRow): AiUserModelPreference {
  if (
    !row.provider_installation_id.trim()
    || !row.provider_id.trim()
    || !row.model_id.trim()
    || !row.agent_id.trim()
  ) {
    throw new RuntimeStoredDataError('RUNTIME_PREFERENCE_CORRUPT', 'Stored user runtime preference is incomplete.');
  }
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    selection: {
      providerInstallationId: row.provider_installation_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      thinkingLevel: storedThinkingLevel(row.thinking_level, 'RUNTIME_PREFERENCE_CORRUPT'),
    },
    revision: numberValue(row.revision, 0),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function sameRuntimeSelection(left: AiRuntimeSelection, right: AiRuntimeSelection): boolean {
  return left.providerInstallationId === right.providerInstallationId
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.thinkingLevel === right.thinkingLevel;
}

export async function readWorkspaceModelPolicy(
  organizationId: string,
  workspaceId: string,
): Promise<AiWorkspaceModelPolicy | null> {
  const connection = await openDb();
  try {
    const row = await connection.get(
      `SELECT organization_id, workspace_id, allowed_models_json,
              default_provider_installation_id, default_provider_id, default_model_id,
              default_thinking_level, allow_user_credentials, revision,
              updated_by_user_id, updated_at
       FROM ai_workspace_model_policies
       WHERE organization_id = ? AND workspace_id = ?
       LIMIT 1`,
      [organizationId, workspaceId],
    ) as WorkspacePolicyRow | undefined;
    return row ? policyFromRow(row) : null;
  } finally {
    await connection.close?.();
  }
}

export async function writeWorkspaceModelPolicyStore(input: {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
  expectedRevision: number;
  expectedCatalogRevision: number;
  allowedModels: AiModelReference[] | null;
  defaultSelection: AiRuntimeSelection | null;
  allowUserCredentials: boolean;
}): Promise<AiWorkspaceModelPolicy> {
  const connection = await openDb();
  let transactionStarted = false;
  let insertAttempted = false;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;
    const context = await lockAndReadRuntimeContext(connection, input);
    assertRuntimeContextRevisions(context, {
      expectedCatalogRevision: input.expectedCatalogRevision,
      expectedPolicyRevision: input.expectedRevision,
    });
    const current = await connection.get(
      `SELECT revision
       FROM ai_workspace_model_policies
       WHERE organization_id = ? AND workspace_id = ?
       LIMIT 1`,
      [input.organizationId, input.workspaceId],
    ) as { revision?: number | string | null } | undefined;
    const currentRevision = numberValue(current?.revision, 0);
    if (currentRevision !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError('workspace_policy', currentRevision);
    }

    const now = Date.now();
    const nextRevision = currentRevision + 1;
    const values = [
      serializeAllowedModels(input.allowedModels),
      input.defaultSelection?.providerInstallationId ?? null,
      input.defaultSelection?.providerId ?? null,
      input.defaultSelection?.modelId ?? null,
      input.defaultSelection?.thinkingLevel ?? null,
      input.allowUserCredentials ? 1 : 0,
      nextRevision,
      input.actorUserId,
      now,
    ];
    if (current) {
      const result = await connection.run(
        `UPDATE ai_workspace_model_policies
         SET allowed_models_json = ?, default_provider_installation_id = ?,
             default_provider_id = ?, default_model_id = ?, default_thinking_level = ?,
             allow_user_credentials = ?, revision = ?, updated_by_user_id = ?, updated_at = ?
         WHERE organization_id = ? AND workspace_id = ? AND revision = ?`,
        [...values, input.organizationId, input.workspaceId, currentRevision],
      );
      if (changedRows(result) !== 1) {
        throw new RuntimeRevisionConflictError('workspace_policy', currentRevision + 1);
      }
    } else {
      insertAttempted = true;
      await connection.run(
        `INSERT INTO ai_workspace_model_policies (
          organization_id, workspace_id, allowed_models_json,
          default_provider_installation_id, default_provider_id, default_model_id,
          default_thinking_level, allow_user_credentials, revision,
          updated_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.organizationId, input.workspaceId, ...values.slice(0, 8), now, now],
      );
    }
    await connection.run('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original policy error.
      }
    }
    if (insertAttempted && !(error instanceof RuntimeRevisionConflictError)) {
      const concurrent = await connection.get(
        `SELECT revision FROM ai_workspace_model_policies
         WHERE organization_id = ? AND workspace_id = ? LIMIT 1`,
        [input.organizationId, input.workspaceId],
      ) as { revision?: number | string | null } | undefined;
      if (concurrent) {
        throw new RuntimeRevisionConflictError('workspace_policy', numberValue(concurrent.revision, 1));
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }

  const policy = await readWorkspaceModelPolicy(input.organizationId, input.workspaceId);
  if (!policy) throw new Error('Workspace model policy could not be loaded after update.');
  return policy;
}

export async function deleteWorkspaceModelPolicyStore(input: {
  organizationId: string;
  workspaceId: string;
  expectedRevision?: number;
}): Promise<boolean> {
  const connection = await openDb();
  let transactionStarted = false;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;
    await lockWorkspaceRuntimeContext(connection, input);
    const current = await connection.get(
      `SELECT revision
       FROM ai_workspace_model_policies
       WHERE organization_id = ? AND workspace_id = ?
       LIMIT 1`,
      [input.organizationId, input.workspaceId],
    ) as { revision?: number | string | null } | undefined;
    const currentRevision = numberValue(current?.revision, 0);
    if (input.expectedRevision !== undefined && currentRevision !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError('workspace_policy', currentRevision);
    }
    if (!current) {
      await connection.run('COMMIT');
      transactionStarted = false;
      return false;
    }
    const result = await connection.run(
      `DELETE FROM ai_workspace_model_policies
       WHERE organization_id = ? AND workspace_id = ? AND revision = ?`,
      [input.organizationId, input.workspaceId, currentRevision],
    );
    if (changedRows(result) !== 1) {
      throw new RuntimeRevisionConflictError('workspace_policy', currentRevision + 1);
    }
    await connection.run('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original policy error.
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }
}

export async function readUserModelPreference(input: {
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
}): Promise<AiUserModelPreference | null> {
  const connection = await openDb();
  try {
    const row = await connection.get(
      `SELECT organization_id, user_id, workspace_id, agent_id,
              provider_installation_id, provider_id, model_id, thinking_level,
              revision, updated_at
       FROM ai_user_model_preferences
       WHERE organization_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
       LIMIT 1`,
      [input.organizationId, input.userId, input.workspaceId, input.agentId],
    ) as UserPreferenceRow | undefined;
    return row ? preferenceFromRow(row) : null;
  } finally {
    await connection.close?.();
  }
}

export async function readUserWorkspaceProviderGrant(input: {
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  providerInstallationId: string;
}): Promise<AiUserWorkspaceProviderGrant | null> {
  const connection = await openDb();
  try {
    const row = await connection.get(
      `SELECT id, organization_id, user_id, workspace_id, agent_id,
              provider_installation_id, allowed_execution_modes_json, status,
              revision, granted_at, revoked_at, updated_at
       FROM ai_user_workspace_provider_grants
       WHERE organization_id = ? AND user_id = ? AND workspace_id = ?
         AND agent_id = ? AND provider_installation_id = ?
       LIMIT 1`,
      [
        input.organizationId,
        input.userId,
        input.workspaceId,
        input.agentId,
        input.providerInstallationId,
      ],
    ) as UserWorkspaceProviderGrantRow | undefined;
    return row ? grantFromRow(row) : null;
  } finally {
    await connection.close?.();
  }
}

export async function writeUserWorkspaceProviderGrant(input: {
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  providerInstallationId: string;
  allowedExecutionModes: AiRuntimeExecutionMode[];
  expectedRevision: number;
}): Promise<AiUserWorkspaceProviderGrant> {
  const modes = Array.from(new Set(input.allowedExecutionModes));
  if (modes.length === 0 || modes.some((mode) => !EXECUTION_MODES.has(mode) || mode === 'organization_automation')) {
    throw new Error('Invalid user provider credential grant modes.');
  }
  const connection = await openDb();
  let transactionStarted = false;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;
    await lockWorkspaceRuntimeContext(connection, input);
    const current = await connection.get(
      `SELECT id, organization_id, user_id, workspace_id, agent_id,
              provider_installation_id, allowed_execution_modes_json, status,
              revision, granted_at, revoked_at, updated_at
       FROM ai_user_workspace_provider_grants
       WHERE organization_id = ? AND user_id = ? AND workspace_id = ?
         AND agent_id = ? AND provider_installation_id = ?
       LIMIT 1`,
      [
        input.organizationId,
        input.userId,
        input.workspaceId,
        input.agentId,
        input.providerInstallationId,
      ],
    ) as UserWorkspaceProviderGrantRow | undefined;
    const currentRevision = current ? numberValue(current.revision, 0) : 0;
    if (currentRevision !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError('user_provider_grant', currentRevision);
    }
    const now = Date.now();
    const nextRevision = currentRevision + 1;
    const modesJson = JSON.stringify(modes);
    if (current) {
      const result = await connection.run(
        `UPDATE ai_user_workspace_provider_grants
         SET allowed_execution_modes_json = ?, status = 'active', revision = ?,
             granted_at = ?, revoked_at = NULL, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [modesJson, nextRevision, now, now, current.id, currentRevision],
      );
      if (changedRows(result) !== 1) {
        throw new RuntimeRevisionConflictError('user_provider_grant', currentRevision + 1);
      }
    } else {
      await connection.run(
        `INSERT INTO ai_user_workspace_provider_grants (
          id, organization_id, user_id, workspace_id, agent_id,
          provider_installation_id, allowed_execution_modes_json, status,
          revision, granted_at, revoked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`,
        [
          randomUUID(),
          input.organizationId,
          input.userId,
          input.workspaceId,
          input.agentId,
          input.providerInstallationId,
          modesJson,
          nextRevision,
          now,
          now,
          now,
        ],
      );
    }
    await connection.run('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original grant error.
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }

  const grant = await readUserWorkspaceProviderGrant(input);
  if (!grant) throw new Error('User provider credential grant could not be loaded after update.');
  return grant;
}

export async function revokeUserWorkspaceProviderGrant(input: {
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  providerInstallationId: string;
  expectedRevision?: number;
}): Promise<AiUserWorkspaceProviderGrant | null> {
  const connection = await openDb();
  let transactionStarted = false;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;
    await lockWorkspaceRuntimeContext(connection, input);
    const current = await connection.get(
      `SELECT id, organization_id, user_id, workspace_id, agent_id,
              provider_installation_id, allowed_execution_modes_json, status,
              revision, granted_at, revoked_at, updated_at
       FROM ai_user_workspace_provider_grants
       WHERE organization_id = ? AND user_id = ? AND workspace_id = ?
         AND agent_id = ? AND provider_installation_id = ?
       LIMIT 1`,
      [
        input.organizationId,
        input.userId,
        input.workspaceId,
        input.agentId,
        input.providerInstallationId,
      ],
    ) as UserWorkspaceProviderGrantRow | undefined;
    if (!current) {
      await connection.run('COMMIT');
      transactionStarted = false;
      return null;
    }
    const currentRevision = numberValue(current.revision, 0);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw new RuntimeRevisionConflictError('user_provider_grant', currentRevision);
    }
    if (current.status === 'active') {
      const now = Date.now();
      const result = await connection.run(
        `UPDATE ai_user_workspace_provider_grants
         SET status = 'revoked', revision = ?, revoked_at = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [currentRevision + 1, now, now, current.id, currentRevision],
      );
      if (changedRows(result) !== 1) {
        throw new RuntimeRevisionConflictError('user_provider_grant', currentRevision + 1);
      }
    }
    await connection.run('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original grant error.
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }
  return readUserWorkspaceProviderGrant(input);
}

export async function writeUserModelPreferenceStore(input: {
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  expectedRevision: number;
  expectedCatalogRevision: number;
  expectedPolicyRevision: number;
  selection: AiRuntimeSelection;
}): Promise<AiUserModelPreference> {
  const connection = await openDb();
  let transactionStarted = false;
  let insertAttempted = false;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;
    const context = await lockAndReadRuntimeContext(connection, input);
    assertRuntimeContextRevisions(context, input);
    const current = await connection.get(
      `SELECT organization_id, user_id, workspace_id, agent_id,
              provider_installation_id, provider_id, model_id, thinking_level,
              revision, updated_at
       FROM ai_user_model_preferences
       WHERE organization_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
       LIMIT 1`,
      [input.organizationId, input.userId, input.workspaceId, input.agentId],
    ) as UserPreferenceRow | undefined;
    const currentRevision = numberValue(current?.revision, 0);
    if (currentRevision !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError('user_preference', currentRevision);
    }

    if (current && sameRuntimeSelection(preferenceFromRow(current).selection, input.selection)) {
      await connection.run('COMMIT');
      transactionStarted = false;
    } else {

      const now = Date.now();
      const nextRevision = currentRevision + 1;
      if (current) {
        const result = await connection.run(
          `UPDATE ai_user_model_preferences
           SET provider_installation_id = ?, provider_id = ?, model_id = ?,
               thinking_level = ?, revision = ?, updated_at = ?
           WHERE organization_id = ? AND user_id = ? AND workspace_id = ?
             AND agent_id = ? AND revision = ?`,
          [
            input.selection.providerInstallationId,
            input.selection.providerId,
            input.selection.modelId,
            input.selection.thinkingLevel,
            nextRevision,
            now,
            input.organizationId,
            input.userId,
            input.workspaceId,
            input.agentId,
            currentRevision,
          ],
        );
        if (changedRows(result) !== 1) {
          throw new RuntimeRevisionConflictError('user_preference', currentRevision + 1);
        }
      } else {
        insertAttempted = true;
        await connection.run(
          `INSERT INTO ai_user_model_preferences (
            organization_id, user_id, workspace_id, agent_id,
            provider_installation_id, provider_id, model_id, thinking_level,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.organizationId,
            input.userId,
            input.workspaceId,
            input.agentId,
            input.selection.providerInstallationId,
            input.selection.providerId,
            input.selection.modelId,
            input.selection.thinkingLevel,
            nextRevision,
            now,
            now,
          ],
        );
      }
      await connection.run('COMMIT');
      transactionStarted = false;
    }
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original preference error.
      }
    }
    if (insertAttempted && !(error instanceof RuntimeRevisionConflictError)) {
      const concurrent = await connection.get(
        `SELECT revision FROM ai_user_model_preferences
         WHERE organization_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? LIMIT 1`,
        [input.organizationId, input.userId, input.workspaceId, input.agentId],
      ) as { revision?: number | string | null } | undefined;
      if (concurrent) {
        throw new RuntimeRevisionConflictError('user_preference', numberValue(concurrent.revision, 1));
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }

  const preference = await readUserModelPreference(input);
  if (!preference) throw new Error('User model preference could not be loaded after update.');
  return preference;
}

export async function deleteUserModelPreferenceStore(input: {
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  expectedRevision?: number;
}): Promise<boolean> {
  const connection = await openDb();
  let transactionStarted = false;
  try {
    await connection.run('BEGIN');
    transactionStarted = true;
    const current = await connection.get(
      `SELECT revision
       FROM ai_user_model_preferences
       WHERE organization_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
       LIMIT 1`,
      [input.organizationId, input.userId, input.workspaceId, input.agentId],
    ) as { revision?: number | string | null } | undefined;
    const currentRevision = numberValue(current?.revision, 0);
    if (input.expectedRevision !== undefined && currentRevision !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError('user_preference', currentRevision);
    }
    if (!current) {
      await connection.run('COMMIT');
      transactionStarted = false;
      return false;
    }
    const result = await connection.run(
      `DELETE FROM ai_user_model_preferences
       WHERE organization_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? AND revision = ?`,
      [input.organizationId, input.userId, input.workspaceId, input.agentId, currentRevision],
    );
    if (changedRows(result) !== 1) {
      throw new RuntimeRevisionConflictError('user_preference', currentRevision + 1);
    }
    await connection.run('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original preference error.
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }
}

export async function readPiSessionRuntimeSnapshot(input: {
  sessionId: string;
  userId: string;
  agentId: string;
}): Promise<AiSessionRuntimeSnapshot | null> {
  const connection = await openDb();
  try {
    const row = await connection.get(
      `SELECT id, provider, model, thinking_level,
              runtime_provider_installation_id, runtime_catalog_revision,
              runtime_policy_revision, runtime_selection_source
       FROM pi_sessions
       WHERE session_id = ? AND user_id = ? AND agent_id = ?
       LIMIT 1`,
      [input.sessionId, input.userId, input.agentId],
    ) as SessionRuntimeRow | undefined;
    return snapshotFromSessionRow(row);
  } finally {
    await connection.close?.();
  }
}

function snapshotFromSessionRow(row: SessionRuntimeRow | undefined): AiSessionRuntimeSnapshot | null {
  if (!row?.runtime_provider_installation_id) return null;
  if (!row.provider.trim() || !row.model.trim()) {
    throw new RuntimeStoredDataError('SESSION_RUNTIME_SNAPSHOT_CORRUPT', 'Stored session runtime selection is incomplete.');
  }
  if (!SELECTION_SOURCES.has(row.runtime_selection_source as AiRuntimeSelectionSource)) {
    throw new RuntimeStoredDataError('SESSION_RUNTIME_SNAPSHOT_CORRUPT', 'Stored session runtime source is invalid.');
  }
  const selectionSource = row.runtime_selection_source as AiRuntimeSelectionSource;
  return {
    selection: {
      providerInstallationId: row.runtime_provider_installation_id,
      providerId: row.provider,
      modelId: row.model,
      thinkingLevel: storedThinkingLevel(row.thinking_level, 'SESSION_RUNTIME_SNAPSHOT_CORRUPT'),
    },
    catalogRevision: numberValue(row.runtime_catalog_revision, 0),
    policyRevision: numberValue(row.runtime_policy_revision, 0),
    selectionSource,
  };
}

function sameSnapshot(left: AiSessionRuntimeSnapshot, right: AiSessionRuntimeSnapshot): boolean {
  return left.selection.providerInstallationId === right.selection.providerInstallationId
    && left.selection.providerId === right.selection.providerId
    && left.selection.modelId === right.selection.modelId
    && left.selection.thinkingLevel === right.selection.thinkingLevel
    && left.catalogRevision === right.catalogRevision
    && left.policyRevision === right.policyRevision
    && left.selectionSource === right.selectionSource;
}

export function piSessionRuntimeSnapshotDbFields(snapshot: AiSessionRuntimeSnapshot) {
  return {
    provider: snapshot.selection.providerId,
    model: snapshot.selection.modelId,
    thinkingLevel: snapshot.selection.thinkingLevel,
    runtimeProviderInstallationId: snapshot.selection.providerInstallationId,
    runtimeCatalogRevision: snapshot.catalogRevision,
    runtimePolicyRevision: snapshot.policyRevision,
    runtimeSelectionSource: snapshot.selectionSource,
  };
}

export async function writePiSessionRuntimeSnapshot(input: {
  sessionId: string;
  userId: string;
  agentId: string;
  snapshot: AiSessionRuntimeSnapshot;
  allowReplace?: boolean;
  expectedSnapshot?: AiSessionRuntimeSnapshot | null;
  contextRevision?: {
    organizationId: string;
    workspaceId: string;
    expectedCatalogRevision: number;
    expectedPolicyRevision: number;
  };
}): Promise<void> {
  const connection = await openDb();
  let transactionStarted = false;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;

    if (input.contextRevision) {
      const catalogRow = await connection.get(
        `SELECT catalog_revision AS revision
         FROM ai_runtime_defaults
         WHERE organization_id = ?
         LIMIT 1`,
        [input.contextRevision.organizationId],
      ) as { revision?: number | string | null } | undefined;
      const policyRow = await connection.get(
        `SELECT revision
         FROM ai_workspace_model_policies
         WHERE organization_id = ? AND workspace_id = ?
         LIMIT 1`,
        [input.contextRevision.organizationId, input.contextRevision.workspaceId],
      ) as { revision?: number | string | null } | undefined;
      const currentCatalogRevision = numberValue(catalogRow?.revision, 0);
      const currentPolicyRevision = numberValue(policyRow?.revision, 0);
      if (
        currentCatalogRevision !== input.contextRevision.expectedCatalogRevision
        || currentPolicyRevision !== input.contextRevision.expectedPolicyRevision
      ) {
        throw new SessionRuntimeContextRevisionConflictError(
          currentCatalogRevision,
          currentPolicyRevision,
        );
      }
    }

    const row = await connection.get(
      `SELECT id, provider, model, thinking_level,
              runtime_provider_installation_id, runtime_catalog_revision,
              runtime_policy_revision, runtime_selection_source
       FROM pi_sessions
       WHERE session_id = ? AND user_id = ? AND agent_id = ?
       LIMIT 1`,
      [input.sessionId, input.userId, input.agentId],
    ) as SessionRuntimeRow | undefined;
    if (!row) throw new Error('Session not found.');
    const existing = snapshotFromSessionRow(row);
    const hasExpectedSnapshot = Object.prototype.hasOwnProperty.call(input, 'expectedSnapshot');
    const expectedSnapshot = hasExpectedSnapshot ? input.expectedSnapshot ?? null : undefined;
    if (
      hasExpectedSnapshot
      && ((existing === null) !== (expectedSnapshot === null)
        || (existing !== null && expectedSnapshot && !sameSnapshot(existing, expectedSnapshot)))
    ) {
      throw new SessionRuntimeSnapshotConflictError();
    }
    if (existing && sameSnapshot(existing, input.snapshot) && !input.contextRevision) {
      await connection.run('COMMIT');
      transactionStarted = false;
      return;
    }
    if (existing && !input.allowReplace) throw new SessionRuntimeSnapshotConflictError();

    const compareSnapshot = hasExpectedSnapshot ? expectedSnapshot ?? null : existing;
    const snapshotCasSql = compareSnapshot
      ? `AND runtime_provider_installation_id = ?
         AND provider = ? AND model = ? AND thinking_level = ?
         AND runtime_catalog_revision = ? AND runtime_policy_revision = ?
         AND runtime_selection_source = ?`
      : 'AND runtime_provider_installation_id IS NULL';
    const snapshotCasParams = compareSnapshot
      ? [
          compareSnapshot.selection.providerInstallationId,
          compareSnapshot.selection.providerId,
          compareSnapshot.selection.modelId,
          compareSnapshot.selection.thinkingLevel,
          compareSnapshot.catalogRevision,
          compareSnapshot.policyRevision,
          compareSnapshot.selectionSource,
        ]
      : [];
    const contextCasSql = input.contextRevision
      ? `AND COALESCE((
           SELECT catalog_revision
           FROM ai_runtime_defaults
           WHERE organization_id = ?
           LIMIT 1
         ), 0) = ?
         AND COALESCE((
           SELECT revision
           FROM ai_workspace_model_policies
           WHERE organization_id = ? AND workspace_id = ?
           LIMIT 1
         ), 0) = ?`
      : '';
    const contextCasParams = input.contextRevision
      ? [
          input.contextRevision.organizationId,
          input.contextRevision.expectedCatalogRevision,
          input.contextRevision.organizationId,
          input.contextRevision.workspaceId,
          input.contextRevision.expectedPolicyRevision,
        ]
      : [];
    const result = await connection.run(
      `UPDATE pi_sessions
       SET provider = ?, model = ?, thinking_level = ?,
           runtime_provider_installation_id = ?, runtime_catalog_revision = ?,
           runtime_policy_revision = ?, runtime_selection_source = ?, updated_at = ?
       WHERE session_id = ? AND user_id = ? AND agent_id = ?
       ${snapshotCasSql}
       ${contextCasSql}`,
      [
        input.snapshot.selection.providerId,
        input.snapshot.selection.modelId,
        input.snapshot.selection.thinkingLevel,
        input.snapshot.selection.providerInstallationId,
        input.snapshot.catalogRevision,
        input.snapshot.policyRevision,
        input.snapshot.selectionSource,
        Date.now(),
        input.sessionId,
        input.userId,
        input.agentId,
        ...snapshotCasParams,
        ...contextCasParams,
      ],
    ) as { changes?: number; rowCount?: number } | undefined;
    const changed = numberValue(result?.changes ?? result?.rowCount, 0);
    if (changed === 0) {
      if (input.contextRevision) {
        const catalogRow = await connection.get(
          `SELECT catalog_revision AS revision
           FROM ai_runtime_defaults
           WHERE organization_id = ?
           LIMIT 1`,
          [input.contextRevision.organizationId],
        ) as { revision?: number | string | null } | undefined;
        const policyRow = await connection.get(
          `SELECT revision
           FROM ai_workspace_model_policies
           WHERE organization_id = ? AND workspace_id = ?
           LIMIT 1`,
          [input.contextRevision.organizationId, input.contextRevision.workspaceId],
        ) as { revision?: number | string | null } | undefined;
        const currentCatalogRevision = numberValue(catalogRow?.revision, 0);
        const currentPolicyRevision = numberValue(policyRow?.revision, 0);
        if (
          currentCatalogRevision !== input.contextRevision.expectedCatalogRevision
          || currentPolicyRevision !== input.contextRevision.expectedPolicyRevision
        ) {
          throw new SessionRuntimeContextRevisionConflictError(
            currentCatalogRevision,
            currentPolicyRevision,
          );
        }
      }
      throw new SessionRuntimeSnapshotConflictError();
    }
    await connection.run('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original session runtime error.
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }
}
