import 'server-only';

import { openDb } from '@/app/lib/db';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import { queryLegacyAiTablesExist } from '@/app/lib/db/legacy-ai-table-query';

export async function legacyAiTablesExist(): Promise<boolean> {
  const database = await openDb();
  try {
    return await queryLegacyAiTablesExist(database, getDatabaseProvider());
  } finally {
    await database.close();
  }
}
