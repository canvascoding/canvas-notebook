import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import {
  MEMORY_MAX_ENTRY_CHARS,
  MEMORY_PENDING_ARCHIVE_AFTER_MS,
  type MemoryEntryStatus,
  type MemoryScopePermissions,
  type MemoryScopeType,
  assertCompleteMemoryScopeIdentity,
  initialMemoryEntryStatus,
  resolveMemoryScopePermissions,
} from './contract';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { getAgentAccess } from '@/app/lib/agents/access';
import { getAgentProfile } from '@/app/lib/agents/registry';

export type MemoryTarget = MemoryScopeType;
export type MemoryAction = 'read' | 'add' | 'update' | 'delete';

export type MemoryEntry = {
  id: string;
  content: string;
  status: MemoryEntryStatus;
  priority: number;
  pinned: boolean;
  collectionId: string;
  semanticKey?: string | null;
  updatedAt: number;
  lastUsedAt?: number | null;
};

export type MemoryReadResult = {
  target: MemoryTarget;
  entries: MemoryEntry[];
};

export type MemoryCollectionSummary = {
  id: string;
  category: string;
  title: string;
  status: 'active' | 'archived';
  updatedAt: number;
  entryCount: number;
  pendingCount: number;
};

export type MemoryMutationResult = MemoryReadResult & {
  changed: boolean;
  entry?: MemoryEntry;
  archivedEntry?: MemoryEntry;
};

export type MemoryEvent = {
  id: string;
  action: string;
  actorType: string;
  decisionCode: string | null;
  createdAt: number;
};

export type MemoryServiceScope = {
  target: MemoryTarget;
  userId: string;
  agentId?: string | null;
  workspaceId?: string | null;
  organizationId?: string | null;
};

export const ONBOARDING_MEMORY_CATEGORIES = [
  'profile',
  'preferences',
  'communication',
  'interests',
  'tech-stack',
  'recent-work',
  'area',
] as const;

export type OnboardingMemoryCategory = (typeof ONBOARDING_MEMORY_CATEGORIES)[number];

export type OnboardingMemoryInput = {
  category: OnboardingMemoryCategory;
  semanticKey: string;
  content: string;
  priority?: number;
};

export type OnboardingMemorySaveResult = {
  added: number;
  updated: number;
  unchanged: number;
  entries: MemoryEntry[];
};

export type AgentMemoryOwnerStats = {
  agentId: string;
  agentExists: boolean;
  collectionCount: number;
  archivedCollectionCount: number;
  entryCount: number;
  updatedAt: number;
};

export type AgentMemoryExport = {
  format: 'canvas-agent-memory-v1';
  exportedAt: number;
  agentId: string;
  ownerStatus: 'active' | 'deleted';
  collections: Array<{
    id: string;
    category: string;
    title: string;
    status: 'active' | 'archived';
    entries: Array<MemoryEntry & { sensitivity: 'standard' | 'sensitive' }>;
  }>;
};

type MemoryScopeAccessAction = 'read' | 'suggest' | 'publish' | 'update' | 'archive';

const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|secret|token|password|passwd|credential)s?\b\s*[:=]/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
];

/**
 * Proves that an agent-memory owner is either currently usable by the user or
 * is a deleted-agent tombstone backed by retained collections owned by them.
 */
export async function resolveAgentMemoryOwnerForUser(input: {
  userId: string;
  agentId: string;
  allowDeleted: boolean;
}): Promise<{ agentId: string; status: 'active' | 'deleted' }> {
  const profile = await getAgentProfile(input.agentId);
  if (profile) {
    const access = await getAgentAccess(input.userId, profile.agentId);
    if (!access.canUse) throw new Error(`Agent "${profile.agentId}" is not available to this user.`);
    return { agentId: profile.agentId, status: 'active' };
  }
  if (input.allowDeleted) {
    const connection = await openDb();
    try {
      const retained = await connection.get(`
        SELECT id FROM memory_collections
        WHERE scope_type = 'agent' AND user_id = ? AND agent_id = ?
        LIMIT 1
      `, [input.userId, input.agentId]) as { id?: string } | undefined;
      if (retained?.id) return { agentId: input.agentId, status: 'deleted' };
    } finally {
      await connection.close();
    }
  }
  throw new Error(`Agent "${input.agentId}" was not found.`);
}

/** Returns counts for active and retained deleted-agent memory owners. */
export async function readAgentMemoryOwnerStats(userId: string): Promise<AgentMemoryOwnerStats[]> {
  const connection = await openDb();
  try {
    const rows = await connection.all(`
      SELECT collection.agent_id,
        MAX(CASE WHEN agent.agent_id IS NULL THEN 0 ELSE 1 END) AS agent_exists,
        COUNT(DISTINCT collection.id) AS collection_count,
        COUNT(DISTINCT CASE WHEN collection.status = 'archived' THEN collection.id ELSE NULL END) AS archived_collection_count,
        COUNT(entry.id) AS entry_count,
        MAX(collection.updated_at) AS updated_at
      FROM memory_collections collection
      LEFT JOIN agents agent ON agent.agent_id = collection.agent_id
      LEFT JOIN memory_entries entry ON entry.collection_id = collection.id
      WHERE collection.scope_type = 'agent' AND collection.user_id = ? AND collection.agent_id IS NOT NULL
      GROUP BY collection.agent_id
      ORDER BY MAX(collection.updated_at) DESC, collection.agent_id ASC
    `, [userId]) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      agentId: String(row.agent_id),
      agentExists: Number(row.agent_exists ?? 0) > 0,
      collectionCount: Number(row.collection_count ?? 0),
      archivedCollectionCount: Number(row.archived_collection_count ?? 0),
      entryCount: Number(row.entry_count ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));
  } finally {
    await connection.close();
  }
}

export async function exportAgentMemory(userId: string, agentId: string): Promise<AgentMemoryExport> {
  const owner = await resolveAgentMemoryOwnerForUser({ userId, agentId, allowDeleted: true });
  const connection = await openDb();
  try {
    const collections = await connection.all(`
      SELECT id, category, title, status FROM memory_collections
      WHERE scope_type = 'agent' AND user_id = ? AND agent_id = ?
      ORDER BY updated_at DESC, id ASC
    `, [userId, owner.agentId]) as Array<Record<string, unknown>>;
    const result: AgentMemoryExport['collections'] = [];
    for (const collection of collections) {
      const rows = await connection.all(`
        SELECT id, content, status, priority, pinned, collection_id, semantic_key,
          sensitivity, updated_at, last_used_at
        FROM memory_entries WHERE collection_id = ?
        ORDER BY pinned DESC, priority DESC, updated_at DESC, id ASC
      `, [collection.id]) as Array<Record<string, unknown>>;
      result.push({
        id: String(collection.id),
        category: String(collection.category),
        title: String(collection.title),
        status: collection.status === 'archived' ? 'archived' : 'active',
        entries: rows.map((row) => ({
          ...toEntry(row),
          sensitivity: row.sensitivity === 'sensitive' ? 'sensitive' : 'standard',
        })),
      });
    }
    return {
      format: 'canvas-agent-memory-v1',
      exportedAt: Date.now(),
      agentId: owner.agentId,
      ownerStatus: owner.status,
      collections: result,
    };
  } finally {
    await connection.close();
  }
}

export async function setAgentMemoryArchived(input: {
  userId: string;
  agentId: string;
  archived: boolean;
}): Promise<{ collections: number; archived: boolean }> {
  const owner = await resolveAgentMemoryOwnerForUser({ ...input, allowDeleted: true });
  const connection = await openDb();
  try {
    const result = await connection.run(`
      UPDATE memory_collections SET status = ?, revision = revision + 1, updated_at = ?
      WHERE scope_type = 'agent' AND user_id = ? AND agent_id = ? AND status != ?
    `, [input.archived ? 'archived' : 'active', Date.now(), input.userId, owner.agentId, input.archived ? 'archived' : 'active']) as { changes?: number };
    return { collections: Number(result.changes ?? 0), archived: input.archived };
  } finally {
    await connection.close();
  }
}

export async function transferAgentMemory(input: {
  userId: string;
  sourceAgentId: string;
  targetAgentId: string;
}): Promise<{ collections: number; entries: number }> {
  const source = await resolveAgentMemoryOwnerForUser({ userId: input.userId, agentId: input.sourceAgentId, allowDeleted: true });
  const target = await resolveAgentMemoryOwnerForUser({ userId: input.userId, agentId: input.targetAgentId, allowDeleted: false });
  if (source.agentId === target.agentId) throw new Error('Choose a different target agent for the transfer.');
  const connection = await openDb();
  try {
    const counts = await connection.get(`
      SELECT COUNT(DISTINCT collection.id) AS collections, COUNT(entry.id) AS entries
      FROM memory_collections collection
      LEFT JOIN memory_entries entry ON entry.collection_id = collection.id
      WHERE collection.scope_type = 'agent' AND collection.user_id = ? AND collection.agent_id = ?
    `, [input.userId, source.agentId]) as Record<string, unknown> | undefined;
    await connection.run(`
      UPDATE memory_collections SET agent_id = ?, revision = revision + 1, updated_at = ?
      WHERE scope_type = 'agent' AND user_id = ? AND agent_id = ?
    `, [target.agentId, Date.now(), input.userId, source.agentId]);
    return { collections: Number(counts?.collections ?? 0), entries: Number(counts?.entries ?? 0) };
  } finally {
    await connection.close();
  }
}

export async function deleteAgentMemory(userId: string, agentId: string): Promise<{ collections: number; entries: number }> {
  const owner = await resolveAgentMemoryOwnerForUser({ userId, agentId, allowDeleted: true });
  const connection = await openDb();
  try {
    const counts = await connection.get(`
      SELECT COUNT(DISTINCT collection.id) AS collections, COUNT(entry.id) AS entries
      FROM memory_collections collection
      LEFT JOIN memory_entries entry ON entry.collection_id = collection.id
      WHERE collection.scope_type = 'agent' AND collection.user_id = ? AND collection.agent_id = ?
    `, [userId, owner.agentId]) as Record<string, unknown> | undefined;
    await connection.run(`
      DELETE FROM memory_collections
      WHERE scope_type = 'agent' AND user_id = ? AND agent_id = ?
    `, [userId, owner.agentId]);
    return { collections: Number(counts?.collections ?? 0), entries: Number(counts?.entries ?? 0) };
  } finally {
    await connection.close();
  }
}

function normalizedContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function contentHash(content: string): string {
  return createHash('sha256').update(normalizedContent(content).toLowerCase()).digest('hex');
}

function assertMemoryContent(content: string): string {
  const normalized = normalizedContent(content);
  if (!normalized) throw new Error('Memory content must not be empty.');
  if (normalized.length > MEMORY_MAX_ENTRY_CHARS) {
    throw new Error(`Memory content must be ${MEMORY_MAX_ENTRY_CHARS} characters or less.`);
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error('Memory content appears to contain a secret or credential.');
  }
  return normalized;
}

function scopeIdentity(scope: MemoryServiceScope) {
  return {
    scopeType: scope.target,
    userId: scope.userId,
    agentId: scope.agentId,
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  } as const;
}

/** Resolves shared-memory access from the server-owned workspace and organization state. */
export async function resolveMemoryScopeAccess(scope: MemoryServiceScope): Promise<MemoryScopePermissions> {
  assertCompleteMemoryScopeIdentity(scopeIdentity(scope));
  if (scope.target === 'user' || scope.target === 'agent') {
    return resolveMemoryScopePermissions({ scopeType: scope.target });
  }

  if (scope.target === 'workspace') {
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    });
    if (workspace.workspaceId !== scope.workspaceId) {
      throw new Error('Workspace memory scope does not match the effective workspace context.');
    }
    return resolveMemoryScopePermissions({
      scopeType: 'workspace',
      workspace: {
        canRead: workspace.permissions.canRead,
        canWrite: workspace.permissions.canWrite,
        canManage: workspace.permissions.canManageWorkspace,
      },
    });
  }

  const organization = await readOrganizationPermissionForUser(scope.userId);
  const permission = organization.permission;
  return resolveMemoryScopePermissions({
    scopeType: 'organization',
    organization: {
      isActiveInternalMember: organization.organizationId === scope.organizationId
        && permission?.status === 'active'
        && permission.role !== 'external',
      isOwnerOrAdmin: permission?.role === 'owner' || permission?.role === 'admin',
      canManageOrganizationMemory: permission?.canManageOrganizationMemory === true,
    },
  });
}

async function assertMemoryScopeAccess(
  scope: MemoryServiceScope,
  action: MemoryScopeAccessAction,
): Promise<MemoryScopePermissions> {
  const permissions = await resolveMemoryScopeAccess(scope);
  const allowed = action === 'read'
    ? permissions.canReadPublished
    : action === 'suggest'
      ? permissions.canSuggest
      : action === 'publish'
        ? permissions.canPublish
        : action === 'update'
          ? permissions.canUpdatePublished
          : permissions.canArchive;
  if (!allowed) {
    throw new Error(`You do not have permission to ${action} ${scope.target} memory.`);
  }
  return permissions;
}

function scopeWhere(scope: MemoryServiceScope): { sql: string; params: unknown[] } {
  if (scope.target === 'user') return { sql: 'scope_type = ? AND user_id = ? AND agent_id IS NULL', params: ['user', scope.userId] };
  if (scope.target === 'agent') return { sql: 'scope_type = ? AND user_id = ? AND agent_id = ?', params: ['agent', scope.userId, scope.agentId] };
  if (scope.target === 'workspace') return { sql: 'scope_type = ? AND workspace_id = ?', params: ['workspace', scope.workspaceId] };
  return { sql: 'scope_type = ? AND organization_id = ?', params: ['organization', scope.organizationId] };
}

function collectionScopeWhere(scope: MemoryServiceScope): { sql: string; params: unknown[] } {
  const where = scopeWhere(scope);
  return { sql: where.sql.replaceAll('scope_', 'collection.scope_').replaceAll('user_id', 'collection.user_id').replaceAll('agent_id', 'collection.agent_id').replaceAll('workspace_id', 'collection.workspace_id').replaceAll('organization_id', 'collection.organization_id'), params: where.params };
}

function toEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: String(row.id),
    content: String(row.content),
    status: row.status as MemoryEntryStatus,
    priority: Number(row.priority),
    pinned: row.pinned === true || row.pinned === 1,
    collectionId: String(row.collection_id),
    semanticKey: typeof row.semantic_key === 'string' ? row.semantic_key : null,
    updatedAt: Number(row.updated_at ?? 0),
    lastUsedAt: typeof row.last_used_at === 'number' ? row.last_used_at : null,
  };
}

function normalizedCategory(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'context';
  return /^[a-z][a-z0-9-]{0,63}$/u.test(normalized) ? normalized : 'context';
}

function normalizedSemanticKey(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return /^[a-z][a-z0-9._-]{0,119}$/u.test(normalized) ? normalized : null;
}

function stableMemoryId(namespace: string, parts: readonly string[]): string {
  const digest = createHash('sha256')
    .update([namespace, ...parts].join('\u0000'), 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function findCollectionIdWithConnection(
  connection: SqlConnection,
  scope: MemoryServiceScope,
  create: boolean,
  category?: string,
): Promise<string | null> {
  assertCompleteMemoryScopeIdentity(scopeIdentity(scope));
  const where = scopeWhere(scope);
  const resolvedCategory = category
    ? normalizedCategory(category)
    : (scope.target === 'agent' ? 'agent-context' : 'context');
  const existing = await connection.get(`
    SELECT id FROM memory_collections
    WHERE ${where.sql} AND status = 'active' AND category = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `, [...where.params, resolvedCategory]) as { id?: string } | undefined;
  if (existing?.id || !create) return existing?.id ?? null;

  const id = stableMemoryId('memory-collection-v1', [
    scope.target,
    scope.userId,
    scope.agentId ?? '',
    scope.organizationId ?? '',
    scope.workspaceId ?? '',
    resolvedCategory,
  ]);
  const now = Date.now();
  await connection.run(`
    INSERT INTO memory_collections (
      id, scope_type, user_id, agent_id, organization_id, workspace_id,
      category, title, sensitivity, status, revision, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'standard', 'active', 1, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `, [
    id, scope.target, scope.userId,
    scope.target === 'agent' ? scope.agentId ?? null : null,
    scope.target === 'organization' ? scope.organizationId ?? null : null,
    scope.target === 'workspace' ? scope.workspaceId ?? null : null,
    resolvedCategory,
    scope.target === 'agent' ? 'Agent memory' : `${scope.target[0].toUpperCase()}${scope.target.slice(1)} memory`,
    scope.userId, now, now,
  ]);
  return id;
}

async function findCollectionId(scope: MemoryServiceScope, create: boolean, category?: string): Promise<string | null> {
  const connection = await openDb();
  try {
    return await findCollectionIdWithConnection(connection, scope, create, category);
  } finally {
    await connection.close();
  }
}

export async function readMemory(scope: MemoryServiceScope): Promise<MemoryReadResult> {
  const permissions = await assertMemoryScopeAccess(scope, 'read');
  const connection = await openDb();
  try {
    const where = collectionScopeWhere(scope);
    const rows = await connection.all(`
      SELECT entry.id, entry.content, entry.status, entry.priority, entry.pinned, entry.collection_id, entry.semantic_key, entry.updated_at, entry.last_used_at
      FROM memory_entries entry
      INNER JOIN memory_collections collection ON collection.id = entry.collection_id
      WHERE ${where.sql} AND collection.status = 'active' AND entry.status != 'archived'
        AND (? = 1 OR entry.status = 'published')
      ORDER BY entry.pinned DESC, entry.priority DESC, entry.updated_at DESC, entry.id ASC
    `, [...where.params, permissions.canPublish ? 1 : 0]) as Record<string, unknown>[];
    return { target: scope.target, entries: rows.map(toEntry) };
  } finally {
    await connection.close();
  }
}

/** Lists all collections in one authorized scope for the settings manager. */
export async function listMemoryCollections(scope: MemoryServiceScope): Promise<MemoryCollectionSummary[]> {
  const permissions = await assertMemoryScopeAccess(scope, 'read');
  const connection = await openDb();
  try {
    const where = scopeWhere(scope);
    const rows = await connection.all(`
      SELECT collection.id, collection.category, collection.title, collection.status, collection.updated_at,
        COUNT(entry.id) AS entry_count,
        COALESCE(SUM(CASE WHEN entry.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count
      FROM memory_collections collection
      LEFT JOIN memory_entries entry ON entry.collection_id = collection.id
        AND entry.status != 'archived'
        AND (? = 1 OR entry.status = 'published')
      WHERE ${where.sql}
      GROUP BY collection.id
      ORDER BY collection.updated_at DESC, collection.id ASC
    `, [permissions.canPublish ? 1 : 0, ...where.params]) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      category: String(row.category),
      title: String(row.title),
      status: row.status === 'archived' ? 'archived' : 'active',
      updatedAt: Number(row.updated_at),
      entryCount: Number(row.entry_count),
      pendingCount: Number(row.pending_count),
    }));
  } finally { await connection.close(); }
}

/** Reads one collection after proving that it belongs to the requested scope. */
export async function readMemoryCollection(
  scope: MemoryServiceScope & { collectionId: string; includeArchived?: boolean },
): Promise<MemoryReadResult> {
  const permissions = await assertMemoryScopeAccess(scope, 'read');
  const includeArchived = scope.includeArchived === true && permissions.canArchive;
  const connection = await openDb();
  try {
    const where = collectionScopeWhere(scope);
    const rows = await connection.all(`
      SELECT entry.id, entry.content, entry.status, entry.priority, entry.pinned, entry.collection_id, entry.semantic_key, entry.updated_at, entry.last_used_at
      FROM memory_entries entry
      INNER JOIN memory_collections collection ON collection.id = entry.collection_id
      WHERE entry.collection_id = ? AND ${where.sql}
        AND (? = 1 OR entry.status != 'archived')
        AND (? = 1 OR entry.status = 'published')
      ORDER BY entry.pinned DESC, entry.priority DESC, entry.updated_at DESC, entry.id ASC
    `, [scope.collectionId, ...where.params, includeArchived ? 1 : 0, permissions.canPublish ? 1 : 0]) as Record<string, unknown>[];
    return { target: scope.target, entries: rows.map(toEntry) };
  } finally { await connection.close(); }
}

async function findEntryInScope(
  connection: Awaited<ReturnType<typeof openDb>>,
  scope: MemoryServiceScope,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const where = collectionScopeWhere(scope);
  return connection.get(`
    SELECT entry.id, entry.content, entry.status, entry.priority, entry.pinned, entry.collection_id, entry.semantic_key, entry.updated_at, entry.last_used_at
    FROM memory_entries entry
    INNER JOIN memory_collections collection ON collection.id = entry.collection_id
    WHERE entry.id = ? AND ${where.sql} AND entry.status != 'archived'
    LIMIT 1
  `, [id, ...where.params]) as Promise<Record<string, unknown> | undefined>;
}

/** Returns the compact audit trail for one entry after verifying its scope. */
export async function readMemoryEntryHistory(
  scope: MemoryServiceScope & { id: string },
): Promise<MemoryEvent[]> {
  const permissions = await assertMemoryScopeAccess(scope, 'read');
  const connection = await openDb();
  try {
    const where = collectionScopeWhere(scope);
    const entry = await connection.get(`
      SELECT entry.id, entry.status
      FROM memory_entries entry
      INNER JOIN memory_collections collection ON collection.id = entry.collection_id
      WHERE entry.id = ? AND ${where.sql}
      LIMIT 1
    `, [scope.id.trim(), ...where.params]) as { id?: string; status?: MemoryEntryStatus } | undefined;
    if (!entry?.id || (!permissions.canPublish && entry.status !== 'published')) {
      throw new Error(`Memory entry "${scope.id}" was not found.`);
    }
    const rows = await connection.all(`
      SELECT id, action, actor_type, decision_code, created_at
      FROM memory_events
      WHERE entry_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `, [entry.id]) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      actorType: String(row.actor_type),
      decisionCode: typeof row.decision_code === 'string' ? row.decision_code : null,
      createdAt: Number(row.created_at),
    }));
  } finally { await connection.close(); }
}

/**
 * Persists the explicit, user-confirmed facts collected by Bradley during the
 * profile onboarding. The operation is idempotent across retries and uses the
 * same SQL surface for SQLite and PostgreSQL.
 */
export async function saveOnboardingUserMemories(params: {
  userId: string;
  agentId: string;
  sessionId: string;
  memories: OnboardingMemoryInput[];
}): Promise<OnboardingMemorySaveResult> {
  const userId = params.userId.trim();
  const agentId = params.agentId.trim().toLowerCase();
  const sessionId = params.sessionId.trim();
  if (!userId || !agentId || !sessionId) {
    throw new Error('Onboarding memory requires user, agent, and session context.');
  }
  if (!Array.isArray(params.memories) || params.memories.length === 0) {
    throw new Error('Onboarding must save at least one durable user memory.');
  }
  if (params.memories.length > 20) {
    throw new Error('Onboarding can save at most 20 user memories.');
  }

  const allowedCategories = new Set<string>(ONBOARDING_MEMORY_CATEGORIES);
  const seenSemanticKeys = new Set<string>();
  const memories = params.memories.map((memory) => {
    if (!allowedCategories.has(memory.category)) {
      throw new Error(`Unsupported onboarding memory category "${memory.category}".`);
    }
    const semanticKey = normalizedSemanticKey(memory.semanticKey);
    if (!semanticKey) {
      throw new Error('Every onboarding memory requires a valid semantic key.');
    }
    if (seenSemanticKeys.has(semanticKey)) {
      throw new Error(`Onboarding memory semantic key "${semanticKey}" is duplicated.`);
    }
    seenSemanticKeys.add(semanticKey);
    const priority = memory.priority ?? 70;
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new Error('Onboarding memory priority must be an integer from 0 to 100.');
    }
    return {
      category: memory.category,
      semanticKey,
      content: assertMemoryContent(memory.content),
      priority,
    };
  });

  const scope: MemoryServiceScope = { target: 'user', userId };
  await assertMemoryScopeAccess(scope, 'suggest');
  const connection = await openDb();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  try {
    await connection.run('BEGIN');
    for (const memory of memories) {
      const collectionId = await findCollectionIdWithConnection(connection, scope, true, memory.category);
      if (!collectionId) throw new Error('Could not resolve an onboarding memory collection.');
      const hash = contentHash(memory.content);
      const existing = await connection.get(`
        SELECT id, content, normalized_content_hash, semantic_key, priority, pinned
        FROM memory_entries
        WHERE collection_id = ? AND status != 'archived'
          AND (semantic_key = ? OR normalized_content_hash = ?)
        ORDER BY CASE WHEN semantic_key = ? THEN 0 ELSE 1 END, updated_at DESC, id DESC
        LIMIT 1
      `, [collectionId, memory.semanticKey, hash, memory.semanticKey]) as Record<string, unknown> | undefined;
      const now = Date.now();
      let entryId: string;
      let action: 'add' | 'update' | null;

      if (existing?.id) {
        entryId = String(existing.id);
        const contentMatches = String(existing.normalized_content_hash) === hash;
        const keyMatches = existing.semantic_key === memory.semanticKey;
        if ((existing.pinned === true || existing.pinned === 1) || (contentMatches && keyMatches)) {
          unchanged += 1;
          action = null;
        } else {
          await connection.run(`
            UPDATE memory_entries
            SET semantic_key = ?, content = ?, normalized_content_hash = ?, status = 'published',
              priority = ?, sensitivity = 'standard', estimated_tokens = ?, source_session_id = ?,
              source_agent_id = ?, last_confirmed_at = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?
          `, [
            memory.semanticKey,
            memory.content,
            hash,
            Math.max(Number(existing.priority ?? 0), memory.priority),
            Math.max(1, Math.ceil(memory.content.length / 4)),
            sessionId,
            agentId,
            now,
            now,
            entryId,
          ]);
          updated += 1;
          action = 'update';
        }
      } else {
        entryId = stableMemoryId('onboarding-memory-entry-v1', [userId, memory.category, memory.semanticKey]);
        await connection.run(`
          INSERT INTO memory_entries (
            id, collection_id, semantic_key, content, normalized_content_hash, status, priority, pinned,
            sensitivity, estimated_tokens, source_session_id, source_agent_id, created_by_actor_type,
            created_by_user_id, last_confirmed_at, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'published', ?, 0, 'standard', ?, ?, ?, 'assistant', ?, ?, 1, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            semantic_key = excluded.semantic_key,
            content = excluded.content,
            normalized_content_hash = excluded.normalized_content_hash,
            status = 'published',
            priority = excluded.priority,
            sensitivity = 'standard',
            estimated_tokens = excluded.estimated_tokens,
            source_session_id = excluded.source_session_id,
            source_agent_id = excluded.source_agent_id,
            last_confirmed_at = excluded.last_confirmed_at,
            revision = memory_entries.revision + 1,
            updated_at = excluded.updated_at
        `, [
          entryId,
          collectionId,
          memory.semanticKey,
          memory.content,
          hash,
          memory.priority,
          Math.max(1, Math.ceil(memory.content.length / 4)),
          sessionId,
          agentId,
          userId,
          now,
          now,
          now,
        ]);
        added += 1;
        action = 'add';
      }

      if (action) {
        const eventId = stableMemoryId('onboarding-memory-event-v1', [entryId, action, hash, sessionId]);
        await connection.run(`
          INSERT INTO memory_events (
            id, entry_id, action, actor_type, actor_user_id, session_id, decision_code, created_at
          ) VALUES (?, ?, ?, 'assistant', ?, ?, 'onboarding_profile', ?)
          ON CONFLICT (id) DO NOTHING
        `, [eventId, entryId, action, userId, sessionId, now]);
      }
    }
    await connection.run('COMMIT');
  } catch (error) {
    try { await connection.run('ROLLBACK'); } catch { /* best effort */ }
    throw error;
  } finally {
    await connection.close();
  }

  const result = await readMemory(scope);
  const savedKeys = new Set(memories.map((memory) => memory.semanticKey));
  return {
    added,
    updated,
    unchanged,
    entries: result.entries.filter((entry) => entry.semanticKey && savedKeys.has(entry.semanticKey)),
  };
}

export async function addMemory(scope: MemoryServiceScope & { content: string }): Promise<MemoryMutationResult> {
  await assertMemoryScopeAccess(scope, 'suggest');
  const content = assertMemoryContent(scope.content);
  const collectionId = await findCollectionId(scope, true);
  if (!collectionId) throw new Error('Could not resolve a memory collection.');
  const connection = await openDb();
  try {
    const hash = contentHash(content);
    const existing = await connection.get(`
      SELECT id, content, status, priority, pinned, collection_id, semantic_key, updated_at, last_used_at
      FROM memory_entries
      WHERE collection_id = ? AND normalized_content_hash = ? AND status != 'archived'
      LIMIT 1
    `, [collectionId, hash]) as Record<string, unknown> | undefined;
    if (existing) {
      const result = await readMemory(scope);
      return { ...result, changed: false, entry: toEntry(existing) };
    }
    const now = Date.now();
    const entry: MemoryEntry = {
      id: randomUUID(), content, status: initialMemoryEntryStatus(scope.target), priority: 50,
      pinned: false, collectionId, updatedAt: now, lastUsedAt: null,
    };
    await connection.run(`
      INSERT INTO memory_entries (
        id, collection_id, content, normalized_content_hash, status, priority, pinned, sensitivity,
        estimated_tokens, created_by_actor_type, created_by_user_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'standard', ?, 'assistant', ?, 1, ?, ?)
    `, [entry.id, collectionId, content, hash, entry.status, entry.priority, Math.max(1, Math.ceil(content.length / 4)), scope.userId, now, now]);
    await connection.run(`
      INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at)
      VALUES (?, ?, 'add', 'assistant', ?, 'explicit_memory_tool', ?)
    `, [randomUUID(), entry.id, scope.userId, now]);
    const result = await readMemory(scope);
    return { ...result, changed: true, entry };
  } finally {
    await connection.close();
  }
}

/**
 * Imports explicit, user-owned facts from a Canvas memory export. Shared scopes
 * deliberately cannot be imported here because they require a reviewer to
 * evaluate each proposal in context.
 */
export async function importPersonalMemory(params: {
  userId: string;
  contents: string[];
}): Promise<{ added: number; skipped: number }> {
  const uniqueContents = [...new Set(params.contents.map(normalizedContent).filter(Boolean))];
  if (uniqueContents.length === 0) throw new Error('The import does not contain any memory entries.');
  if (uniqueContents.length > 100) throw new Error('Import at most 100 memory entries at a time.');

  const scope: MemoryServiceScope = { target: 'user', userId: params.userId };
  await assertMemoryScopeAccess(scope, 'suggest');
  const collectionId = await findCollectionId(scope, true);
  if (!collectionId) throw new Error('Could not resolve a personal memory collection.');

  const connection = await openDb();
  try {
    let added = 0;
    let skipped = 0;
    const now = Date.now();
    for (const candidate of uniqueContents) {
      const content = assertMemoryContent(candidate);
      const hash = contentHash(content);
      const existing = await connection.get(`
        SELECT id FROM memory_entries
        WHERE collection_id = ? AND normalized_content_hash = ? AND status != 'archived'
        LIMIT 1
      `, [collectionId, hash]) as { id?: string } | undefined;
      if (existing?.id) {
        skipped += 1;
        continue;
      }
      const id = randomUUID();
      await connection.run(`
        INSERT INTO memory_entries (
          id, collection_id, content, normalized_content_hash, status, priority, pinned, sensitivity,
          estimated_tokens, created_by_actor_type, created_by_user_id, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'published', 50, 0, 'standard', ?, 'user', ?, 1, ?, ?)
      `, [id, collectionId, content, hash, Math.max(1, Math.ceil(content.length / 4)), params.userId, now, now]);
      await connection.run(`
        INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at)
        VALUES (?, ?, 'import', 'user', ?, 'manual_memory_import', ?)
      `, [randomUUID(), id, params.userId, now]);
      added += 1;
    }
    return { added, skipped };
  } finally { await connection.close(); }
}

/** Permanently removes only the requesting user's personal and private-agent memory. */
export async function deletePersonalMemory(userId: string): Promise<{ collections: number; entries: number }> {
  const scope: MemoryServiceScope = { target: 'user', userId };
  await assertMemoryScopeAccess(scope, 'archive');
  const connection = await openDb();
  try {
    const totals = await connection.get(`
      SELECT COUNT(DISTINCT collection.id) AS collections, COUNT(entry.id) AS entries
      FROM memory_collections collection
      LEFT JOIN memory_entries entry ON entry.collection_id = collection.id
      WHERE collection.user_id = ? AND collection.scope_type IN ('user', 'agent')
    `, [userId]) as { collections?: number; entries?: number } | undefined;
    await connection.run(`
      DELETE FROM memory_collections
      WHERE user_id = ? AND scope_type IN ('user', 'agent')
    `, [userId]);
    return { collections: Number(totals?.collections ?? 0), entries: Number(totals?.entries ?? 0) };
  } finally { await connection.close(); }
}

export async function updateMemory(scope: MemoryServiceScope & { id: string; content: string }): Promise<MemoryMutationResult> {
  await assertMemoryScopeAccess(scope, 'update');
  const id = scope.id.trim();
  const content = assertMemoryContent(scope.content);
  const connection = await openDb();
  try {
    const existing = await findEntryInScope(connection, scope, id);
    if (!existing?.id) throw new Error(`Memory entry "${id}" was not found.`);
    if (existing.pinned === true || existing.pinned === 1) throw new Error('Pinned memory entries cannot be changed automatically.');
    const now = Date.now();
    await connection.run(`UPDATE memory_entries SET content = ?, normalized_content_hash = ?, estimated_tokens = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, [content, contentHash(content), Math.max(1, Math.ceil(content.length / 4)), now, id]);
    await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at) VALUES (?, ?, 'update', 'assistant', ?, 'explicit_memory_tool', ?)`, [randomUUID(), id, scope.userId, now]);
    const result = await readMemory(scope);
    return { ...result, changed: true, entry: result.entries.find((entry) => entry.id === id) };
  } finally { await connection.close(); }
}

export async function deleteMemory(scope: MemoryServiceScope & { id: string }): Promise<MemoryMutationResult> {
  await assertMemoryScopeAccess(scope, 'archive');
  const id = scope.id.trim();
  const connection = await openDb();
  try {
    const existing = await findEntryInScope(connection, scope, id);
    if (!existing) throw new Error(`Memory entry "${id}" was not found.`);
    const entry = toEntry(existing);
    const now = Date.now();
    await connection.run(`UPDATE memory_entries SET status = 'archived', revision = revision + 1, updated_at = ? WHERE id = ?`, [now, id]);
    await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at) VALUES (?, ?, 'archive', 'assistant', ?, 'explicit_memory_tool', ?)`, [randomUUID(), id, scope.userId, now]);
    const result = await readMemory(scope);
    return { ...result, changed: true, archivedEntry: entry };
  } finally { await connection.close(); }
}

/** Restores an archived entry without changing its original scope or content. */
export async function restoreMemory(scope: MemoryServiceScope & { id: string }): Promise<MemoryMutationResult> {
  await assertMemoryScopeAccess(scope, 'archive');
  const id = scope.id.trim();
  const connection = await openDb();
  try {
    const where = collectionScopeWhere(scope);
    const existing = await connection.get(`
      SELECT entry.id, entry.content, entry.status, entry.priority, entry.pinned, entry.collection_id, entry.semantic_key, entry.updated_at, entry.last_used_at
      FROM memory_entries entry
      INNER JOIN memory_collections collection ON collection.id = entry.collection_id
      WHERE entry.id = ? AND ${where.sql} AND entry.status = 'archived'
      LIMIT 1
    `, [id, ...where.params]) as Record<string, unknown> | undefined;
    if (!existing) throw new Error(`Archived memory entry "${id}" was not found.`);
    const now = Date.now();
    await connection.run(`UPDATE memory_entries SET status = 'published', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'archived'`, [now, id]);
    await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at) VALUES (?, ?, 'restore', 'user', ?, 'explicit_memory_restore', ?)`, [randomUUID(), id, scope.userId, now]);
    const result = await readMemory(scope);
    return { ...result, changed: true, entry: result.entries.find((entry) => entry.id === id) };
  } finally { await connection.close(); }
}

/** Publishes a shared proposal after its workspace or organization manager reviews it. */
export async function publishMemory(scope: MemoryServiceScope & { id: string }): Promise<MemoryMutationResult> {
  await assertMemoryScopeAccess(scope, 'publish');
  const id = scope.id.trim();
  const connection = await openDb();
  try {
    const existing = await findEntryInScope(connection, scope, id);
    if (!existing) throw new Error(`Memory entry "${id}" was not found.`);
    const entry = toEntry(existing);
    if (entry.status === 'published') {
      const result = await readMemory(scope);
      return { ...result, changed: false, entry };
    }
    const now = Date.now();
    await connection.run(`UPDATE memory_entries SET status = 'published', revision = revision + 1, updated_at = ? WHERE id = ?`, [now, id]);
    await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at) VALUES (?, ?, 'publish', 'user', ?, 'shared_memory_manager', ?)`, [randomUUID(), id, scope.userId, now]);
    const result = await readMemory(scope);
    return { ...result, changed: true, entry: result.entries.find((candidate) => candidate.id === id) };
  } finally { await connection.close(); }
}

export type MemoryReviewScheduleResult = {
  scheduled: boolean;
  triggerType: 'turn_interval' | 'idle';
  fromMessageSequence: number;
  throughMessageSequence: number;
};

export type MemoryReviewSettingsUpdate = {
  automaticMemoryEnabled: boolean;
  providerInstallationId: string | null;
  modelId: string | null;
  memoryPromptMaxTokens: number;
  sensitiveMemoryEnabled: boolean;
};

/**
 * Persists the reviewer configuration and reconciles parked jobs in the same
 * database transaction. A newly valid configuration makes every parked review
 * immediately due; disabling it parks all unclaimed work without losing it.
 */
export async function updateMemoryReviewSettings(
  userId: string,
  settings: MemoryReviewSettingsUpdate,
  now = Date.now(),
): Promise<{ reactivatedJobs: number; parkedJobs: number }> {
  const connection = await openDb();
  try {
    await connection.run('BEGIN');
    try {
      await connection.run(`
        INSERT INTO memory_user_settings (
          user_id, automatic_memory_enabled, provider_installation_id, model_id,
          memory_prompt_max_tokens, sensitive_memory_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          automatic_memory_enabled = excluded.automatic_memory_enabled,
          provider_installation_id = excluded.provider_installation_id,
          model_id = excluded.model_id,
          memory_prompt_max_tokens = excluded.memory_prompt_max_tokens,
          sensitive_memory_enabled = excluded.sensitive_memory_enabled,
          updated_at = excluded.updated_at
      `, [
        userId,
        settings.automaticMemoryEnabled ? 1 : 0,
        settings.providerInstallationId,
        settings.modelId,
        settings.memoryPromptMaxTokens,
        settings.sensitiveMemoryEnabled ? 1 : 0,
        now,
        now,
      ]);

      let reactivatedJobs = 0;
      let parkedJobs = 0;
      if (settings.automaticMemoryEnabled && settings.providerInstallationId && settings.modelId) {
        const result = await connection.run(`
          UPDATE memory_review_jobs
          SET status = 'scheduled', scheduled_for = ?, lease_until = NULL, error_code = NULL
          WHERE user_id = ? AND status = 'awaiting_model_configuration'
        `, [now, userId]) as { changes?: number };
        reactivatedJobs = Number(result.changes ?? 0);
      } else {
        const errorCode = settings.automaticMemoryEnabled ? 'model_not_configured' : 'automatic_memory_disabled';
        const result = await connection.run(`
          UPDATE memory_review_jobs
          SET status = 'awaiting_model_configuration', scheduled_for = NULL, lease_until = NULL, error_code = ?
          WHERE user_id = ? AND status IN ('scheduled', 'queued', 'retry_wait', 'awaiting_model_configuration')
        `, [errorCode, userId]) as { changes?: number };
        parkedJobs = Number(result.changes ?? 0);
      }
      await connection.run('COMMIT');
      return { reactivatedJobs, parkedJobs };
    } catch (error) {
      await connection.run('ROLLBACK');
      throw error;
    }
  } finally {
    await connection.close();
  }
}

/**
 * Creates or moves the single unstarted review range for a session. The worker
 * later claims this durable snapshot; the active chat never awaits model work.
 */
export async function scheduleMemoryReviewForSession(params: {
  userId: string;
  sessionId: string;
  now?: number;
}): Promise<MemoryReviewScheduleResult | null> {
  const connection = await openDb();
  try {
    const session = await connection.get(`SELECT id FROM pi_sessions WHERE user_id = ? AND session_id = ? LIMIT 1`, [params.userId, params.sessionId]) as { id?: number } | undefined;
    if (!session?.id) return null;
    const reviewSettings = await connection.get(`
      SELECT automatic_memory_enabled
      FROM memory_user_settings
      WHERE user_id = ?
      LIMIT 1
    `, [params.userId]) as { automatic_memory_enabled?: number | boolean } | undefined;
    const automaticMemoryDisabled = reviewSettings?.automatic_memory_enabled === false || reviewSettings?.automatic_memory_enabled === 0;
    const completed = await connection.get(`
      SELECT COALESCE(MAX(through_message_sequence), 0) AS sequence
      FROM memory_review_jobs
      WHERE user_id = ? AND session_id = ? AND status = 'completed'
    `, [params.userId, params.sessionId]) as { sequence?: number } | undefined;
    const fromMessageSequence = Number(completed?.sequence ?? 0) + 1;
    const delta = await connection.get(`
      SELECT COUNT(*) AS user_turn_count, MAX(sequence) AS through_message_sequence
      FROM pi_messages
      WHERE pi_session_db_id = ? AND sequence >= ?
    `, [session.id, fromMessageSequence]) as { user_turn_count?: number; through_message_sequence?: number } | undefined;
    const userTurns = await connection.get(`
      SELECT COUNT(*) AS count
      FROM pi_messages
      WHERE pi_session_db_id = ? AND sequence >= ? AND role = 'user'
    `, [session.id, fromMessageSequence]) as { count?: number } | undefined;
    const throughMessageSequence = Number(delta?.through_message_sequence ?? 0);
    if (!throughMessageSequence || Number(userTurns?.count ?? 0) === 0) return null;
    const now = params.now ?? Date.now();
    const triggerType = Number(userTurns?.count ?? 0) >= 10 ? 'turn_interval' : 'idle';
    const scheduledFor = triggerType === 'turn_interval' ? now : now + 15 * 60 * 1000;
    const running = await connection.get(`
      SELECT id, from_message_sequence, through_message_sequence, trigger_type
      FROM memory_review_jobs
      WHERE user_id = ? AND session_id = ? AND status = 'running'
      ORDER BY created_at ASC LIMIT 1
    `, [params.userId, params.sessionId]) as {
      id?: string;
      from_message_sequence?: number;
      through_message_sequence?: number;
      trigger_type?: 'turn_interval' | 'idle';
    } | undefined;
    if (running?.id) {
      // A claimed snapshot is immutable. The successor range is created only
      // after it completes, which prevents concurrent reviews from overlapping.
      return {
        scheduled: false,
        triggerType: running.trigger_type ?? triggerType,
        fromMessageSequence: Number(running.from_message_sequence),
        throughMessageSequence: Number(running.through_message_sequence),
      };
    }
    const existing = await connection.get(`
      SELECT id FROM memory_review_jobs
      WHERE user_id = ? AND session_id = ? AND from_message_sequence = ?
        AND status IN ('scheduled', 'awaiting_model_configuration', 'queued', 'retry_wait')
      ORDER BY created_at ASC LIMIT 1
    `, [params.userId, params.sessionId, fromMessageSequence]) as { id?: string } | undefined;
    if (existing?.id) {
      if (automaticMemoryDisabled) {
        await connection.run(`
          UPDATE memory_review_jobs
          SET through_message_sequence = ?, trigger_type = ?, scheduled_for = NULL,
              status = 'awaiting_model_configuration', lease_until = NULL, error_code = 'automatic_memory_disabled'
          WHERE id = ?
        `, [throughMessageSequence, triggerType, existing.id]);
      } else {
        await connection.run(`
          UPDATE memory_review_jobs
          SET through_message_sequence = ?, trigger_type = ?, scheduled_for = ?, status = 'scheduled', lease_until = NULL, error_code = NULL
          WHERE id = ?
        `, [throughMessageSequence, triggerType, scheduledFor, existing.id]);
      }
    } else {
      await connection.run(`
        INSERT INTO memory_review_jobs (
          id, user_id, session_id, from_message_sequence, through_message_sequence,
          trigger_type, scheduled_for, status, attempts, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `, [
        randomUUID(),
        params.userId,
        params.sessionId,
        fromMessageSequence,
        throughMessageSequence,
        triggerType,
        automaticMemoryDisabled ? null : scheduledFor,
        automaticMemoryDisabled ? 'awaiting_model_configuration' : 'scheduled',
        automaticMemoryDisabled ? 'automatic_memory_disabled' : null,
        now,
      ]);
    }
    return { scheduled: !automaticMemoryDisabled, triggerType, fromMessageSequence, throughMessageSequence };
  } finally { await connection.close(); }
}

export type MemoryReviewJobClaim = {
  id: string;
  userId: string;
  sessionId: string;
  sourceAgentId: string;
  fromMessageSequence: number;
  throughMessageSequence: number;
  providerInstallationId: string;
  modelId: string;
};

/** Claims one due job. A configured model is required; there is no chat-model fallback. */
export async function claimDueMemoryReviewJob(now = Date.now()): Promise<MemoryReviewJobClaim | null> {
  const connection = await openDb();
  try {
    await connection.run(`
      UPDATE memory_review_jobs
      SET status = 'retry_wait', scheduled_for = ?, lease_until = NULL, error_code = 'lease_expired'
      WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
    `, [now, now]);
    const candidate = await connection.get(`
      SELECT job.id, job.user_id, job.session_id, job.from_message_sequence, job.through_message_sequence,
        session.agent_id
      FROM memory_review_jobs job
      INNER JOIN pi_sessions session ON session.user_id = job.user_id AND session.session_id = job.session_id
      WHERE job.status IN ('scheduled', 'retry_wait')
        AND scheduled_for <= ?
      ORDER BY job.scheduled_for ASC, job.created_at ASC
      LIMIT 1
    `, [now]) as Record<string, unknown> | undefined;
    if (!candidate) return null;
    const configured = await connection.get(`
      SELECT automatic_memory_enabled, provider_installation_id, model_id
      FROM memory_user_settings
      WHERE user_id = ?
    `, [candidate.user_id]) as {
      automatic_memory_enabled?: number | boolean;
      provider_installation_id?: string | null;
      model_id?: string | null;
    } | undefined;
    if (configured?.automatic_memory_enabled === false || configured?.automatic_memory_enabled === 0) {
      await connection.run(`UPDATE memory_review_jobs SET status = 'awaiting_model_configuration', scheduled_for = NULL, error_code = 'automatic_memory_disabled' WHERE id = ?`, [candidate.id]);
      return null;
    }
    if (!configured?.provider_installation_id || !configured.model_id) {
      await connection.run(`UPDATE memory_review_jobs SET status = 'awaiting_model_configuration', scheduled_for = NULL, error_code = 'model_not_configured' WHERE id = ?`, [candidate.id]);
      return null;
    }
    const changes = await connection.run(`
      UPDATE memory_review_jobs
      SET status = 'running', attempts = attempts + 1, started_at = ?, lease_until = ?
      WHERE id = ? AND status IN ('scheduled', 'retry_wait')
    `, [now, now + 5 * 60 * 1000, candidate.id]) as { changes?: number };
    if (!changes.changes) return null;
    return {
      id: String(candidate.id), userId: String(candidate.user_id), sessionId: String(candidate.session_id),
      sourceAgentId: String(candidate.agent_id),
      fromMessageSequence: Number(candidate.from_message_sequence), throughMessageSequence: Number(candidate.through_message_sequence),
      providerInstallationId: configured.provider_installation_id,
      modelId: configured.model_id,
    };
  } finally { await connection.close(); }
}

export type MemoryReviewSourceMessage = {
  id: number;
  sequence: number;
  role: string;
  content: string;
};

export async function loadMemoryReviewSourceMessages(claim: MemoryReviewJobClaim): Promise<MemoryReviewSourceMessage[]> {
  const connection = await openDb();
  try {
    const session = await connection.get(`
      SELECT id, agent_id FROM pi_sessions WHERE user_id = ? AND session_id = ? LIMIT 1
    `, [claim.userId, claim.sessionId]) as { id?: number; agent_id?: string } | undefined;
    if (!session?.id || session.agent_id !== claim.sourceAgentId) {
      throw new Error('The source session is no longer available for this memory review.');
    }
    const rows = await connection.all(`
      SELECT id, sequence, role, content FROM pi_messages
      WHERE pi_session_db_id = ? AND sequence >= ? AND sequence <= ?
      ORDER BY sequence ASC, id ASC
    `, [session.id, claim.fromMessageSequence, claim.throughMessageSequence]) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id), sequence: Number(row.sequence), role: String(row.role), content: String(row.content),
    }));
  } finally { await connection.close(); }
}

export type MemoryReviewContextEntry = Pick<MemoryEntry, 'id' | 'content' | 'priority' | 'pinned' | 'semanticKey'> & {
  target: MemoryTarget;
};

export async function readMemoryReviewContext(params: {
  userId: string;
  sourceAgentId: string;
  workspaceId?: string | null;
  organizationId?: string | null;
}): Promise<MemoryReviewContextEntry[]> {
  const reads: Array<{ target: MemoryTarget; memory: Promise<MemoryReadResult> }> = [
    { target: 'user', memory: readMemory({ target: 'user', userId: params.userId }) },
    { target: 'agent', memory: readMemory({ target: 'agent', userId: params.userId, agentId: params.sourceAgentId }) },
  ];
  if (params.workspaceId) reads.push({ target: 'workspace', memory: readMemory({ target: 'workspace', userId: params.userId, workspaceId: params.workspaceId }) });
  if (params.organizationId) reads.push({ target: 'organization', memory: readMemory({ target: 'organization', userId: params.userId, organizationId: params.organizationId }) });
  const resolved = await Promise.all(reads.map(async ({ target, memory }) => {
    try { return { target, result: await memory }; }
    catch { return null; }
  }));
  return resolved.flatMap((item) => item ? item.result.entries.map((entry) => ({ ...entry, target: item.target })) : []).slice(0, 80);
}

export type MemoryReviewCandidate = {
  action: 'add' | 'update' | 'archive';
  target: MemoryTarget;
  category?: string;
  semanticKey?: string;
  entryId?: string;
  content?: string;
  priority?: number;
  sensitivity?: 'standard' | 'sensitive';
  confidence?: number;
  sourceMessageSequence?: number;
};

export type MemoryReviewScopeContext = {
  workspaceId?: string | null;
  organizationId?: string | null;
};

/** Server-derived scopes that an automatic reviewer may propose into. */
export async function resolveMemoryReviewTargets(params: {
  userId: string;
  workspaceId?: string | null;
  organizationId?: string | null;
}): Promise<MemoryTarget[]> {
  const targets: MemoryTarget[] = ['user', 'agent'];
  if (params.workspaceId) {
    const access = await resolveMemoryScopeAccess({ target: 'workspace', userId: params.userId, workspaceId: params.workspaceId });
    if (access.canSuggest) targets.push('workspace');
  }
  if (params.organizationId) {
    const access = await resolveMemoryScopeAccess({ target: 'organization', userId: params.userId, organizationId: params.organizationId });
    if (access.canSuggest) targets.push('organization');
  }
  return targets;
}

function scopeForReviewCandidate(claim: MemoryReviewJobClaim, target: MemoryTarget, context: MemoryReviewScopeContext): MemoryServiceScope | null {
  if (target === 'user') return { target, userId: claim.userId };
  if (target === 'agent') return { target, userId: claim.userId, agentId: claim.sourceAgentId };
  if (target === 'workspace' && context.workspaceId) return { target, userId: claim.userId, workspaceId: context.workspaceId };
  if (target === 'organization' && context.organizationId) return { target, userId: claim.userId, organizationId: context.organizationId };
  return null;
}

function reviewedPriority(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value as number)));
}

function reviewedConfidence(value: number | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value as number));
}

async function sourceMessageIdForReview(
  connection: Awaited<ReturnType<typeof openDb>>,
  claim: Pick<MemoryReviewJobClaim, 'userId' | 'sessionId' | 'sourceAgentId'>,
  sequence: number | undefined,
): Promise<number | null> {
  if (!Number.isInteger(sequence) || (sequence as number) < 1) return null;
  const row = await connection.get(`
    SELECT message.id FROM pi_messages message
    INNER JOIN pi_sessions session ON session.id = message.pi_session_db_id
    WHERE session.user_id = ? AND session.session_id = ? AND session.agent_id = ? AND message.sequence = ?
    LIMIT 1
  `, [claim.userId, claim.sessionId, claim.sourceAgentId, sequence]) as { id?: number } | undefined;
  return row?.id ?? null;
}

/** Applies validated, compact candidates. Scope identifiers always come from the claimed session. */
export async function applyMemoryReviewCandidates(params: {
  claim: MemoryReviewJobClaim;
  candidates: MemoryReviewCandidate[];
  scopeContext?: MemoryReviewScopeContext;
}): Promise<{ added: number; updated: number; archived: number; skipped: number }> {
  const result = { added: 0, updated: 0, archived: 0, skipped: 0 };
  const connection = await openDb();
  try {
    const settings = await connection.get(`
      SELECT sensitive_memory_enabled FROM memory_user_settings WHERE user_id = ?
    `, [params.claim.userId]) as { sensitive_memory_enabled?: number | boolean } | undefined;
    const sensitiveAllowed = settings?.sensitive_memory_enabled === true || settings?.sensitive_memory_enabled === 1;
    for (const candidate of params.candidates.slice(0, 20)) {
      const scope = scopeForReviewCandidate(params.claim, candidate.target, params.scopeContext ?? {});
      if (!scope || !(await resolveMemoryScopeAccess(scope)).canSuggest) {
        result.skipped += 1;
        continue;
      }
      // Shared reviews can only create proposals. They never silently mutate
      // context that is visible to other members.
      if ((scope.target === 'workspace' || scope.target === 'organization') && candidate.action !== 'add') {
        result.skipped += 1;
        continue;
      }
      const semanticKey = normalizedSemanticKey(candidate.semanticKey);
      const category = normalizedCategory(candidate.category);
      const collectionId = await findCollectionId(scope, candidate.action !== 'archive', category);
      if (!collectionId) {
        result.skipped += 1;
        continue;
      }
      const existing = await connection.get(`
        SELECT id, pinned, status, semantic_key FROM memory_entries
        WHERE collection_id = ? AND status != 'archived'
          AND (? IS NOT NULL AND semantic_key = ? OR ? IS NOT NULL AND id = ?)
        ORDER BY updated_at DESC LIMIT 1
      `, [collectionId, semanticKey, semanticKey, candidate.entryId ?? null, candidate.entryId ?? null]) as {
        id?: string; pinned?: number | boolean; status?: string; semantic_key?: string | null;
      } | undefined;
      if (candidate.action === 'archive') {
        if (!existing?.id || existing.pinned) {
          result.skipped += 1;
          continue;
        }
        const now = Date.now();
        await connection.run(`UPDATE memory_entries SET status = 'archived', revision = revision + 1, updated_at = ? WHERE id = ?`, [now, existing.id]);
        await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, session_id, decision_code, created_at) VALUES (?, ?, 'archive', 'memory_manager', ?, ?, 'automatic_review', ?)`, [randomUUID(), existing.id, params.claim.userId, params.claim.sessionId, now]);
        result.archived += 1;
        continue;
      }
      if (candidate.sensitivity === 'sensitive' && !sensitiveAllowed) {
        result.skipped += 1;
        continue;
      }
      let content: string;
      try {
        content = assertMemoryContent(candidate.content ?? '');
      } catch {
        result.skipped += 1;
        continue;
      }
      if (existing?.id && existing.pinned) {
        result.skipped += 1;
        continue;
      }
      const now = Date.now();
      const sourceMessageId = await sourceMessageIdForReview(connection, params.claim, candidate.sourceMessageSequence);
      if (existing?.id && candidate.action === 'update') {
        await connection.run(`
          UPDATE memory_entries
          SET content = ?, normalized_content_hash = ?, priority = ?, sensitivity = ?, confidence = ?,
            last_confirmed_at = ?, revision = revision + 1, updated_at = ?
          WHERE id = ?
        `, [content, contentHash(content), reviewedPriority(candidate.priority), candidate.sensitivity ?? 'standard', reviewedConfidence(candidate.confidence), now, now, existing.id]);
        await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, session_id, source_message_id, decision_code, created_at) VALUES (?, ?, 'update', 'memory_manager', ?, ?, ?, 'automatic_review', ?)`, [randomUUID(), existing.id, params.claim.userId, params.claim.sessionId, sourceMessageId, now]);
        result.updated += 1;
        continue;
      }
      const duplicate = await connection.get(`
        SELECT id FROM memory_entries WHERE collection_id = ? AND normalized_content_hash = ? AND status != 'archived' LIMIT 1
      `, [collectionId, contentHash(content)]) as { id?: string } | undefined;
      if (duplicate?.id) {
        result.skipped += 1;
        continue;
      }
      const entryId = randomUUID();
      await connection.run(`
        INSERT INTO memory_entries (
          id, collection_id, semantic_key, content, normalized_content_hash, status, priority, pinned, sensitivity,
          confidence, estimated_tokens, source_session_id, source_message_id, source_agent_id,
          created_by_actor_type, created_by_user_id, last_confirmed_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'memory_manager', ?, ?, 1, ?, ?)
      `, [
        entryId, collectionId, semanticKey, content, contentHash(content), initialMemoryEntryStatus(scope.target),
        reviewedPriority(candidate.priority), candidate.sensitivity ?? 'standard', reviewedConfidence(candidate.confidence),
        Math.max(1, Math.ceil(content.length / 4)), params.claim.sessionId, sourceMessageId, params.claim.sourceAgentId,
        params.claim.userId, now, now, now,
      ]);
      await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, session_id, source_message_id, decision_code, created_at) VALUES (?, ?, 'add', 'memory_manager', ?, ?, ?, 'automatic_review', ?)`, [randomUUID(), entryId, params.claim.userId, params.claim.sessionId, sourceMessageId, now]);
      result.added += 1;
    }
    return result;
  } finally { await connection.close(); }
}

export async function completeMemoryReviewJob(id: string, now = Date.now()): Promise<void> {
  const connection = await openDb();
  try {
    await connection.run(`UPDATE memory_review_jobs SET status = 'completed', completed_at = ?, lease_until = NULL, error_code = NULL WHERE id = ? AND status = 'running'`, [now, id]);
  } finally { await connection.close(); }
}

export async function retryMemoryReviewJob(id: string, errorCode: string, now = Date.now()): Promise<void> {
  const connection = await openDb();
  try {
    const row = await connection.get(`SELECT attempts FROM memory_review_jobs WHERE id = ? AND status = 'running'`, [id]) as { attempts?: number } | undefined;
    if (!row) return;
    const attempts = Number(row.attempts ?? 1);
    const delay = Math.min(15 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempts - 1)));
    await connection.run(`UPDATE memory_review_jobs SET status = 'retry_wait', scheduled_for = ?, lease_until = NULL, error_code = ? WHERE id = ? AND status = 'running'`, [now + delay, errorCode.slice(0, 80), id]);
  } finally { await connection.close(); }
}

export async function nextMemoryReviewDueAt(): Promise<number | null> {
  const connection = await openDb();
  try {
    const row = await connection.get(`
      SELECT MIN(scheduled_for) AS scheduled_for FROM memory_review_jobs
      WHERE status IN ('scheduled', 'retry_wait') AND scheduled_for IS NOT NULL
    `) as { scheduled_for?: number | null } | undefined;
    return typeof row?.scheduled_for === 'number' ? row.scheduled_for : null;
  } finally { await connection.close(); }
}

/**
 * Conservative periodic hygiene: it archives only old, low-priority unpinned
 * private facts and expired unpinned shared proposals. Published shared memory
 * and all pinned entries remain untouched.
 */
export async function runMemoryMaintenanceCycle(now = Date.now()): Promise<{ archived: number }> {
  const staleBefore = now - 90 * 24 * 60 * 60 * 1000;
  const pendingBefore = now - MEMORY_PENDING_ARCHIVE_AFTER_MS;
  const connection = await openDb();
  try {
    const rows = await connection.all(`
      SELECT entry.id, collection.user_id
      FROM memory_entries entry
      INNER JOIN memory_collections collection ON collection.id = entry.collection_id
      WHERE collection.scope_type IN ('user', 'agent')
        AND entry.status = 'published' AND entry.pinned = 0 AND entry.priority <= 20
        AND entry.updated_at <= ?
      LIMIT 100
    `, [staleBefore]) as Array<{ id: string; user_id: string }>;
    let archived = 0;
    for (const row of rows) {
      await connection.run(`UPDATE memory_entries SET status = 'archived', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'published' AND pinned = 0`, [now, row.id]);
      await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at) VALUES (?, ?, 'archive', 'memory_manager', ?, 'automatic_maintenance_stale', ?)`, [randomUUID(), row.id, row.user_id, now]);
      archived += 1;
    }
    const expired = await connection.all(`
      SELECT entry.id, collection.user_id
      FROM memory_entries entry
      INNER JOIN memory_collections collection ON collection.id = entry.collection_id
      WHERE collection.scope_type IN ('workspace', 'organization')
        AND entry.status = 'pending' AND entry.pinned = 0 AND entry.created_at <= ?
      LIMIT 100
    `, [pendingBefore]) as Array<{ id: string; user_id: string }>;
    for (const row of expired) {
      await connection.run(`UPDATE memory_entries SET status = 'archived', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND pinned = 0`, [now, row.id]);
      await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at) VALUES (?, ?, 'archive', 'memory_manager', ?, 'automatic_maintenance_pending_expired', ?)`, [randomUUID(), row.id, row.user_id, now]);
      archived += 1;
    }
    return { archived };
  } finally { await connection.close(); }
}
