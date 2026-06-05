import 'server-only';

import { openDb } from '@/app/lib/db';

export async function legacyAiTablesExist(): Promise<boolean> {
  const sqlite = await openDb();
  try {
    const rows = sqlite.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
      ['ai_sessions', 'ai_messages'],
    ) as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    return names.has('ai_sessions') && names.has('ai_messages');
  } finally {
    sqlite.close();
  }
}
