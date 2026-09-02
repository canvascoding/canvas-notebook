import type { SqlConnection } from '@/app/lib/db';
import type { DatabaseProvider } from '@/app/lib/db/provider';

export async function queryLegacyAiTablesExist(
  database: Pick<SqlConnection, 'all'>,
  provider: DatabaseProvider,
): Promise<boolean> {
  const rows = provider === 'postgres'
    ? await database.all(
        "SELECT relname AS name FROM pg_class WHERE relkind = 'r' AND relname IN (?, ?)",
        ['ai_sessions', 'ai_messages'],
      ) as Array<{ name: string }>
    : await database.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        ['ai_sessions', 'ai_messages'],
      ) as Array<{ name: string }>;
  const names = new Set(rows.map((row) => row.name));
  return names.has('ai_sessions') && names.has('ai_messages');
}
