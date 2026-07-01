import 'server-only';

import { openDb } from '@/app/lib/db';
import { getDatabaseProvider } from '@/app/lib/db/provider';

export async function legacyAiTablesExist(): Promise<boolean> {
  const database = await openDb();
  try {
    const rows = getDatabaseProvider() === 'postgres'
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
  } finally {
    await database.close();
  }
}
