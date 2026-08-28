import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { openDb } from '@/app/lib/db';
import {
  MEMORY_MAX_ENTRY_CHARS,
  type MemoryEntryStatus,
  type MemoryScopeType,
  assertCompleteMemoryScopeIdentity,
  initialMemoryEntryStatus,
} from './contract';

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
};

export type MemoryReadResult = {
  target: MemoryTarget;
  entries: MemoryEntry[];
};

export type MemoryMutationResult = MemoryReadResult & {
  changed: boolean;
  entry?: MemoryEntry;
  archivedEntry?: MemoryEntry;
};

export type MemoryServiceScope = {
  target: MemoryTarget;
  userId: string;
  agentId?: string | null;
  workspaceId?: string | null;
  organizationId?: string | null;
};

const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|secret|token|password|passwd|credential)s?\b\s*[:=]/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
];

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

function scopeWhere(scope: MemoryServiceScope): { sql: string; params: unknown[] } {
  if (scope.target === 'user') return { sql: 'scope_type = ? AND user_id = ? AND agent_id IS NULL', params: ['user', scope.userId] };
  if (scope.target === 'agent') return { sql: 'scope_type = ? AND user_id = ? AND agent_id = ?', params: ['agent', scope.userId, scope.agentId] };
  if (scope.target === 'workspace') return { sql: 'scope_type = ? AND workspace_id = ?', params: ['workspace', scope.workspaceId] };
  return { sql: 'scope_type = ? AND organization_id = ?', params: ['organization', scope.organizationId] };
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

async function findCollectionId(scope: MemoryServiceScope, create: boolean, category?: string): Promise<string | null> {
  assertCompleteMemoryScopeIdentity(scopeIdentity(scope));
  const connection = await openDb();
  try {
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

    const id = randomUUID();
    const now = Date.now();
    await connection.run(`
      INSERT INTO memory_collections (
        id, scope_type, user_id, agent_id, organization_id, workspace_id,
        category, title, sensitivity, status, revision, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'standard', 'active', 1, ?, ?, ?)
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
  } finally {
    await connection.close();
  }
}

export async function readMemory(scope: MemoryServiceScope): Promise<MemoryReadResult> {
  const collectionId = await findCollectionId(scope, false);
  if (!collectionId) return { target: scope.target, entries: [] };
  const connection = await openDb();
  try {
    const rows = await connection.all(`
      SELECT id, content, status, priority, pinned, collection_id, semantic_key
      FROM memory_entries
      WHERE collection_id = ? AND status != 'archived'
      ORDER BY pinned DESC, priority DESC, updated_at DESC, id ASC
    `, [collectionId]) as Record<string, unknown>[];
    return { target: scope.target, entries: rows.map(toEntry) };
  } finally {
    await connection.close();
  }
}

export async function addMemory(scope: MemoryServiceScope & { content: string }): Promise<MemoryMutationResult> {
  const content = assertMemoryContent(scope.content);
  const collectionId = await findCollectionId(scope, true);
  if (!collectionId) throw new Error('Could not resolve a memory collection.');
  const connection = await openDb();
  try {
    const hash = contentHash(content);
    const existing = await connection.get(`
      SELECT id, content, status, priority, pinned, collection_id, semantic_key
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
      pinned: false, collectionId,
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

export async function updateMemory(scope: MemoryServiceScope & { id: string; content: string }): Promise<MemoryMutationResult> {
  const id = scope.id.trim();
  const content = assertMemoryContent(scope.content);
  const collectionId = await findCollectionId(scope, false);
  if (!collectionId) throw new Error(`Memory entry "${id}" was not found.`);
  const connection = await openDb();
  try {
    const existing = await connection.get(`SELECT id, pinned FROM memory_entries WHERE id = ? AND collection_id = ? AND status != 'archived'`, [id, collectionId]) as { id?: string; pinned?: number | boolean } | undefined;
    if (!existing?.id) throw new Error(`Memory entry "${id}" was not found.`);
    if (existing.pinned) throw new Error('Pinned memory entries cannot be changed automatically.');
    const now = Date.now();
    await connection.run(`UPDATE memory_entries SET content = ?, normalized_content_hash = ?, estimated_tokens = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, [content, contentHash(content), Math.max(1, Math.ceil(content.length / 4)), now, id]);
    await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at) VALUES (?, ?, 'update', 'assistant', ?, 'explicit_memory_tool', ?)`, [randomUUID(), id, scope.userId, now]);
    const result = await readMemory(scope);
    return { ...result, changed: true, entry: result.entries.find((entry) => entry.id === id) };
  } finally { await connection.close(); }
}

export async function deleteMemory(scope: MemoryServiceScope & { id: string }): Promise<MemoryMutationResult> {
  const id = scope.id.trim();
  const collectionId = await findCollectionId(scope, false);
  if (!collectionId) throw new Error(`Memory entry "${id}" was not found.`);
  const connection = await openDb();
  try {
    const existing = await connection.get(`SELECT id, content, status, priority, pinned, collection_id, semantic_key FROM memory_entries WHERE id = ? AND collection_id = ? AND status != 'archived'`, [id, collectionId]) as Record<string, unknown> | undefined;
    if (!existing) throw new Error(`Memory entry "${id}" was not found.`);
    const entry = toEntry(existing);
    const now = Date.now();
    await connection.run(`UPDATE memory_entries SET status = 'archived', revision = revision + 1, updated_at = ? WHERE id = ?`, [now, id]);
    await connection.run(`INSERT INTO memory_events (id, entry_id, action, actor_type, actor_user_id, decision_code, created_at) VALUES (?, ?, 'archive', 'assistant', ?, 'explicit_memory_tool', ?)`, [randomUUID(), id, scope.userId, now]);
    const result = await readMemory(scope);
    return { ...result, changed: true, archivedEntry: entry };
  } finally { await connection.close(); }
}

export type MemoryReviewScheduleResult = {
  scheduled: boolean;
  triggerType: 'turn_interval' | 'idle';
  fromMessageSequence: number;
  throughMessageSequence: number;
};

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
      await connection.run(`
        UPDATE memory_review_jobs
        SET through_message_sequence = ?, trigger_type = ?, scheduled_for = ?, status = 'scheduled', lease_until = NULL, error_code = NULL
        WHERE id = ?
      `, [throughMessageSequence, triggerType, scheduledFor, existing.id]);
    } else {
      await connection.run(`
        INSERT INTO memory_review_jobs (
          id, user_id, session_id, from_message_sequence, through_message_sequence,
          trigger_type, scheduled_for, status, attempts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?)
      `, [randomUUID(), params.userId, params.sessionId, fromMessageSequence, throughMessageSequence, triggerType, scheduledFor, now]);
    }
    return { scheduled: true, triggerType, fromMessageSequence, throughMessageSequence };
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
      WHERE job.status IN ('scheduled', 'retry_wait', 'awaiting_model_configuration')
        AND (scheduled_for IS NULL OR scheduled_for <= ?)
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
      WHERE id = ? AND status IN ('scheduled', 'retry_wait', 'awaiting_model_configuration')
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
  target: Extract<MemoryTarget, 'user' | 'agent'>;
};

export async function readMemoryReviewContext(params: {
  userId: string;
  sourceAgentId: string;
}): Promise<MemoryReviewContextEntry[]> {
  const [userMemory, agentMemory] = await Promise.all([
    readMemory({ target: 'user', userId: params.userId }),
    readMemory({ target: 'agent', userId: params.userId, agentId: params.sourceAgentId }),
  ]);
  return [
    ...userMemory.entries.map((entry) => ({ ...entry, target: 'user' as const })),
    ...agentMemory.entries.map((entry) => ({ ...entry, target: 'agent' as const })),
  ].slice(0, 80);
}

export type MemoryReviewCandidate = {
  action: 'add' | 'update' | 'archive';
  target: Extract<MemoryTarget, 'user' | 'agent'>;
  category?: string;
  semanticKey?: string;
  entryId?: string;
  content?: string;
  priority?: number;
  sensitivity?: 'standard' | 'sensitive';
  confidence?: number;
  sourceMessageSequence?: number;
};

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
}): Promise<{ added: number; updated: number; archived: number; skipped: number }> {
  const result = { added: 0, updated: 0, archived: 0, skipped: 0 };
  const connection = await openDb();
  try {
    const settings = await connection.get(`
      SELECT sensitive_memory_enabled FROM memory_user_settings WHERE user_id = ?
    `, [params.claim.userId]) as { sensitive_memory_enabled?: number | boolean } | undefined;
    const sensitiveAllowed = settings?.sensitive_memory_enabled === true || settings?.sensitive_memory_enabled === 1;
    for (const candidate of params.candidates.slice(0, 20)) {
      const scope: MemoryServiceScope = candidate.target === 'agent'
        ? { target: 'agent', userId: params.claim.userId, agentId: params.claim.sourceAgentId }
        : { target: 'user', userId: params.claim.userId };
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
