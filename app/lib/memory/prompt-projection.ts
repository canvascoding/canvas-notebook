import 'server-only';

import { openDb } from '@/app/lib/db';
import { resolveMemoryPromptTokenBudget } from './contract';
import { resolveMemoryScopeAccess } from './service';
import { buildBudgetedMemoryBlock, type MemoryPromptCandidate } from './prompt-budget';

/** Builds a budgeted per-turn snapshot from private memory and readable shared scopes. */
export async function buildMemoryPromptProjection(input: {
  userId: string;
  agentId: string;
  workspaceId?: string | null;
  organizationId?: string | null;
  usableContextTokens?: number | null;
  /** Status-only projections must not mark memories as used by an agent. */
  recordUsage?: boolean;
}): Promise<string> {
  const connection = await openDb();
  try {
    const settings = await connection.get(`
      SELECT memory_prompt_max_tokens FROM memory_user_settings WHERE user_id = $1
    `, [input.userId]) as { memory_prompt_max_tokens?: number } | undefined;
    const budget = resolveMemoryPromptTokenBudget({
      configuredTokens: settings?.memory_prompt_max_tokens,
      usableContextTokens: input.usableContextTokens,
    });
    if (budget <= 0) return '';
    const scopes = [
      `(collection.scope_type = 'user' AND collection.user_id = $1 AND collection.agent_id IS NULL)`,
      `(collection.scope_type = 'agent' AND collection.user_id = $2 AND collection.agent_id = $3)`,
    ];
    const params: unknown[] = [input.userId, input.userId, input.agentId];
    if (input.workspaceId) {
      const workspacePermissions = await resolveMemoryScopeAccess({
        target: 'workspace', userId: input.userId, workspaceId: input.workspaceId,
      });
      if (workspacePermissions.canReadPublished) {
        scopes.push(`(collection.scope_type = 'workspace' AND collection.workspace_id = $${params.length + 1})`);
        params.push(input.workspaceId);
      }
    }
    if (input.organizationId) {
      const organizationPermissions = await resolveMemoryScopeAccess({
        target: 'organization', userId: input.userId, organizationId: input.organizationId,
      });
      if (organizationPermissions.canReadPublished) {
        scopes.push(`(collection.scope_type = 'organization' AND collection.organization_id = $${params.length + 1})`);
        params.push(input.organizationId);
      }
    }
    const rows = await connection.all(`
      SELECT entry.id, entry.content, collection.scope_type
      FROM memory_entries entry
      INNER JOIN memory_collections collection ON collection.id = entry.collection_id
      WHERE entry.status = 'published' AND collection.status = 'active'
        AND (${scopes.join(' OR ')})
      ORDER BY entry.pinned DESC, entry.priority DESC, entry.last_confirmed_at DESC, entry.updated_at DESC, entry.id ASC
    `, params) as Array<Record<string, unknown>>;
    const candidates: MemoryPromptCandidate[] = rows.map((row) => ({
      id: String(row.id),
      content: String(row.content ?? ''),
      scopeType: row.scope_type === 'agent'
        ? 'agent'
        : row.scope_type === 'workspace'
          ? 'workspace'
          : row.scope_type === 'organization'
            ? 'organization'
            : 'user',
    }));
    const { block, selectedIds } = buildBudgetedMemoryBlock(candidates, budget);
    if (selectedIds.length === 0) return '';
    if (input.recordUsage !== false) {
      await connection.run(
        `UPDATE memory_entries SET last_used_at = $1 WHERE id IN (${selectedIds.map((_, index) => `$${index + 2}`).join(', ')})`,
        [Date.now(), ...selectedIds],
      );
    }
    return block;
  } finally {
    await connection.close();
  }
}
