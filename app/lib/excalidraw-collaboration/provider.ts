import 'server-only';

import { getDatabaseInitializationError, openDb } from '@/app/lib/db';

export class ExcalidrawProviderUnavailableError extends Error {
  readonly code = 'EXCALIDRAW_PROVIDER_UNAVAILABLE';
  readonly status = 503;
  constructor() {
    super('Excalidraw scene operations require an available PostgreSQL collaboration provider.');
    this.name = 'ExcalidrawProviderUnavailableError';
  }
}

export async function assertExcalidrawProviderAvailable(): Promise<void> {
  try {
    if (getDatabaseInitializationError()) throw new Error('PostgreSQL initialization is unavailable.');
    const database = await openDb();
    try { await database.get('SELECT 1'); } finally { await database.close(); }
  } catch { throw new ExcalidrawProviderUnavailableError(); }
}
