import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { openDb } from '@/app/lib/db';
import { DEFAULT_MANAGED_AGENT_ID, readLegacyManagedAgentFileContents, type AgentStorageScope } from '@/app/lib/agents/storage';
import { addMemory } from './service';

type LegacyMemoryFileName = 'USER.md' | 'MEMORY.md';

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Retains list items and paragraphs as independent, bounded imported facts. */
export function splitLegacyMemoryContent(content: string): string[] {
  const candidates = content
    .replace(/\r/g, '')
    .split(/\n\s*\n|\n(?=-\s+)/)
    .map((part) => part.replace(/^#{1,6}\s+.*$/gm, '').replace(/^-\s+(?:\[[^\]]+]\s+)?/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return candidates.flatMap((candidate) => {
    const chunks: string[] = [];
    let current = '';
    for (const word of candidate.split(' ')) {
      if (word.length > 800) continue;
      const next = current ? `${current} ${word}` : word;
      if (next.length > 800) {
        if (current) chunks.push(current);
        current = word;
      } else current = next;
    }
    if (current) chunks.push(current);
    return chunks;
  });
}

async function importFile(input: {
  userId: string;
  agentId: string;
  fileName: LegacyMemoryFileName;
  content: string;
}): Promise<void> {
  const content = input.content.trim();
  if (!content) return;
  const contentHash = hash(content);
  const connection = await openDb();
  try {
    const existing = await connection.get(`SELECT id FROM memory_legacy_imports WHERE user_id = ? AND agent_id = ? AND file_name = ? AND content_hash = ? LIMIT 1`, [input.userId, input.agentId, input.fileName, contentHash]) as { id?: string } | undefined;
    if (existing?.id) return;
  } finally { await connection.close(); }

  let entriesImported = 0;
  let entriesSkipped = 0;
  for (const fact of splitLegacyMemoryContent(content)) {
    try {
      const result = await addMemory(input.fileName === 'USER.md'
        ? { target: 'user', userId: input.userId, content: fact }
        : { target: 'agent', userId: input.userId, agentId: input.agentId, content: fact });
      if (result.changed) entriesImported += 1;
      else entriesSkipped += 1;
    } catch { entriesSkipped += 1; }
  }
  const now = Date.now();
  const resultDb = await openDb();
  try {
    await resultDb.run(`INSERT OR IGNORE INTO memory_legacy_imports (id, user_id, agent_id, file_name, content_hash, entries_imported, entries_skipped, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), input.userId, input.agentId, input.fileName, contentHash, entriesImported, entriesSkipped, now]);
  } finally { await resultDb.close(); }
}

/**
 * Shared legacy files have no owner metadata. Importing them is safe only for
 * an explicitly single-user installation; otherwise the source remains
 * available for an explicit administrator-led migration.
 */
async function canImportSharedLegacyMemory(): Promise<boolean> {
  const connection = await openDb();
  try {
    const row = await connection.get('SELECT COUNT(*) AS count FROM user') as { count?: number } | undefined;
    if (Number(row?.count ?? 0) !== 1) return false;
    const settings = await connection.get(`
      SELECT deployment_mode AS deploymentMode, team_features_enabled AS teamFeaturesEnabled
      FROM canvas_organization_settings
      LIMIT 1
    `) as { deploymentMode?: string; teamFeaturesEnabled?: number } | undefined;
    if (settings) {
      return settings.deploymentMode === 'single_user' && Number(settings.teamFeaturesEnabled ?? 0) === 0;
    }
    return true;
  } finally { await connection.close(); }
}

/**
 * Imports the legacy files once per source hash before prompt construction.
 * The source files are deliberately retained as a one-time export format.
 */
export async function ensureLegacyMemoryMigrated(agentId: string, scope?: AgentStorageScope | null): Promise<void> {
  const userId = scope?.userId?.trim();
  if (!userId) return;
  if (!await canImportSharedLegacyMemory()) return;
  const normalizedAgentId = agentId.trim().toLowerCase() || DEFAULT_MANAGED_AGENT_ID;
  const [userContents, agentContents] = await Promise.all([
    readLegacyManagedAgentFileContents('USER.md', DEFAULT_MANAGED_AGENT_ID),
    readLegacyManagedAgentFileContents('MEMORY.md', normalizedAgentId),
  ]);
  await Promise.all([
    ...userContents.map((content) => importFile({ userId, agentId: DEFAULT_MANAGED_AGENT_ID, fileName: 'USER.md', content })),
    ...agentContents.map((content) => importFile({ userId, agentId: normalizedAgentId, fileName: 'MEMORY.md', content })),
  ]);
}
